import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrismaClient } from '@localehub/database';
import { generateToken } from '@localehub/domain';
import { ensureApi, ensureRemoteMcp, type ApiHandle } from './api-harness';

/**
 * The termbase from the agent's side, and what happens to the project after it.
 *
 * Two claims are what this suite exists for, and neither is visible from a unit test:
 *
 *   1. An agent may **propose** terms and nothing more. Writing one is allowed; approving one is
 *      not, and an approved term is not the agent's to rewrite — that is the difference between a
 *      vocabulary the platform learned and a rule the company decided.
 *   2. Writing a term **does something**. The terms a project is held to are read by QA, so a new
 *      term has to reach the translations that already exist — which means a queued run, a real
 *      worker, and an issue that appears for a sentence that was fine a moment ago. Without this
 *      the termbase is a document that only affects the next translation somebody types.
 *
 * The worker is started as a real child process, for the same reason the API is: the enqueue is
 * the part under test, and calling the rules in-process would prove the rules rather than the path.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const MCP_PORT = 3036;
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
/** A token whose owner is a translator: proposing is theirs, approving is not. */
let translatorToken = '';
let mcp: ApiHandle | null = null;
let client: Client | null = null;
/** The MCP token this suite uses, kept so a test can call the REST API with it directly. */
let mcpToken = '';
let worker: { stop(): Promise<void> } | null = null;
const session = { email: '', password: '', token: '' };
let translatorUserId = '';
let organizationId = '';

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; requestId?: string };
}

async function call<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope<T>) : { success: false } };
}

/** The MCP result payload, unwrapped from the content block. */
function payload<T>(result: unknown): T {
  const blocks = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const block = blocks[0];
  return JSON.parse(block && block.type === 'text' && block.text ? block.text : '{}') as T;
}

function transport(token: string) {
  return new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
}

/**
 * Start the worker, and wait until it says it is consuming.
 *
 * It has no health endpoint, so the log line the process prints after its queues are attached is
 * the readiness signal. Without waiting for it a test can enqueue before any consumer exists and
 * then fail on a timeout that looks like a broken job.
 */
async function startWorker(): Promise<{ stop(): Promise<void> }> {
  const entry = resolve(ROOT, 'apps/worker/dist/main.js');
  if (!existsSync(entry)) {
    throw new Error(`the worker is not built: ${entry} is missing. Run \`pnpm -r build\` first.`);
  }
  const child = spawn('node', [entry], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const deadline = Date.now() + 30_000;
    const timer = setInterval(() => {
      if (output.includes('[worker] started')) {
        clearInterval(timer);
        resolveReady();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        rejectReady(new Error(`the worker never started:\n${output}`));
      }
    }, 250);
    timer.unref();
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const escalate = setTimeout(() => child.kill('SIGKILL'), 5_000);
    escalate.unref();
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    clearTimeout(escalate);
  };

  try {
    await ready;
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}

/** Poll until a probe answers, so the suite waits on the worker instead of on a guessed delay. */
async function until<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let seen: unknown = null;
  while (Date.now() < deadline) {
    seen = await probe();
    if (seen) return seen as T;
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(seen)}`);
}

interface Issue {
  id: string;
  ruleCode: string;
  severity: string;
  message: string;
  translationKey: string;
  localeCode: string;
}

interface ReleaseCheck {
  ok: boolean;
  counts: { glossaryProblems: number };
  issues: { code: string; severity: string; key: string; locale: string; message: string }[];
}

const releaseCheck = async (projectId: string): Promise<ReleaseCheck> => {
  const response = await call<ReleaseCheck>(`/projects/${projectId}/sync/validate`, { method: 'POST', token: session.token });
  expect(response.status, JSON.stringify(response.body.error)).toBe(201);
  return response.body.data!;
};

const openIssues = async (projectId: string): Promise<Issue[]> => {
  const response = await call<Issue[]>(`/projects/${projectId}/qa/issues`, { token: session.token });
  return (response.body.data ?? []).filter((issue) => issue.ruleCode.startsWith('GLOSSARY'));
};

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session.email = `glossary-${runId}@localehub.dev`;
  session.password = 'glossary-password-123';
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Glossary Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Glossary Org ${runId}`, slug: `glossary-${runId}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
      // A second person, whose only role is TRANSLATOR. Testing "an agent may propose but not
      // approve" needs somebody who is not allowed to approve, and the owner is allowed to do
      // everything.
      const translator = await tx.user.create({
        data: { email: `glossary-translator-${runId}@localehub.dev`, name: 'Glossary Translator', passwordHash, isPlatformAdmin: false },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: translator.id, role: 'TRANSLATOR' } });
      translatorUserId = translator.id;
      organizationId = organization.id;
    });
  } finally {
    await prisma.$disconnect();
  }

  const login = await call<{ token: string }>('/auth/login', {
    method: 'POST',
    body: { email: session.email, password: session.password },
  });
  expect(login.status, JSON.stringify(login.body.error)).toBe(201);
  session.token = login.body.data!.token;

  const issued = await call<{ token: string }>('/mcp-tokens', {
    method: 'POST',
    token: session.token,
    body: {
      name: 'glossary-suite',
      scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read', 'glossary.read', 'glossary.write'],
      projectIds: [],
      expiresInDays: 1,
    },
  });
  expect(issued.status, JSON.stringify(issued.body.error)).toBe(201);

  mcpToken = issued.body.data!.token;

  /**
   * The translator's token is seeded rather than issued, and that is a fact about the product rather
   * than a shortcut: `POST /mcp-tokens` requires PROJECT_MANAGER, so a translator cannot obtain one
   * at all. What this token really represents is a manager's token whose owner was later demoted —
   * the one way an under-privileged actor reaches the tools — and the role is checked per call, not
   * at issue time, so that is exactly the case worth pinning.
   */
  const seeded = generateToken('mcp');
  translatorToken = seeded.token;
  const prismaForToken = new PrismaClient();
  try {
    await prismaForToken.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.mcpClient.create({
        data: {
          organizationId,
          userId: translatorUserId,
          kind: 'MCP',
          name: 'glossary-translator',
          tokenHash: seeded.tokenHash,
          tokenPrefix: seeded.tokenPrefix,
          scopes: ['project.read', 'glossary.read', 'glossary.write'],
          projectIds: [],
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    });
  } finally {
    await prismaForToken.$disconnect();
  }

  mcp = await ensureRemoteMcp(MCP_PORT, { root: ROOT });
  client = new Client({ name: 'glossary-suite', version: '0.0.0' });
  await client.connect(transport(issued.body.data!.token));
  worker = await startWorker();
}, 240_000);

afterAll(async () => {
  await client?.close();
  await worker?.stop();
  await mcp?.stop();
  await api?.stop();
});

describe('proposing terms over MCP', () => {
  let projectId = '';

  beforeAll(async () => {
    const created = await client!.callTool({
      name: 'create_project',
      arguments: { name: `Termbase ${runId}`, source_locale: 'en-US', locales: ['ja-JP'], platforms: ['web'] },
    });
    projectId = payload<{ project: { id: string } }>(created).project.id;

    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        await tx.projectMember.create({ data: { organizationId, projectId, userId: translatorUserId, role: 'TRANSLATOR' } });
      });
    } finally {
      await prisma.$disconnect();
    }

    const imported = await client!.callTool({
      name: 'import_translations',
      arguments: {
        project_id: projectId,
        confirm: true,
        files: [
          {
            path: 'web/en-US.json',
            locale: 'en-US',
            platform: 'web',
            entries: [
              { key: 'home.title', value: 'Course list' },
              // Already says コース, so approving `Course → コース` must leave it alone. A rule that
              // fires on a translation that already complies is a rule people turn off.
              { key: 'home.cta', value: 'Start the course' },
              // A run of keys that agree on one word, which is what the extraction counts.
              { key: 'course.enroll', value: 'Course enrol' },
              { key: 'course.cancel', value: 'Course cancel' },
            ],
          },
          {
            path: 'web/ja-JP.json',
            locale: 'ja-JP',
            platform: 'web',
            entries: [
              { key: 'home.title', value: 'モジュール一覧' },
              { key: 'home.cta', value: 'コースを始める' },
              { key: 'course.enroll', value: 'コース登録' },
              { key: 'course.cancel', value: 'コース取消' },
            ],
          },
        ],
      },
    });
    expect(imported.isError, JSON.stringify(imported.content)).toBeFalsy();
  }, 120_000);

  it('records that a token was used', async () => {
    // `mcp_clients` is behind row level security, so the "touch lastUsedAt" write has to run inside
    // the same scope bypass the token lookup needs. It did not, the update matched no row, and
    // because the rejection was caught the only symptom was log noise — every token in the database
    // claimed it had never been used, which is precisely the question that page exists to answer.
    const used = await call('/projects', { token: mcpToken });
    expect(used.status, JSON.stringify(used.body.error)).toBe(200);

    const prisma = new PrismaClient();
    try {
      const row = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        return tx.mcpClient.findFirstOrThrow({ where: { name: 'glossary-suite' }, orderBy: { createdAt: 'desc' } });
      });
      expect(row.lastUsedAt).not.toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  it('needs the scope that allows writing a term', async () => {
    const issued = await call<{ token: string }>('/mcp-tokens', {
      method: 'POST',
      token: session.token,
      body: { name: 'glossary-reader', scopes: ['project.read', 'glossary.read'], projectIds: [], expiresInDays: 1 },
    });
    const reader = new Client({ name: 'glossary-reader', version: '0.0.0' });
    await reader.connect(transport(issued.body.data!.token));
    try {
      const refused = await reader.callTool({
        name: 'upsert_glossary_terms',
        arguments: { project_id: projectId, terms: [{ term: 'Cart' }] },
      });
      expect(refused.isError).toBe(true);
      // Named, not just refused: a caller that cannot tell which grant it is missing cannot ask for it.
      expect(JSON.stringify(refused.content)).toContain('glossary.write');
    } finally {
      await reader.close();
    }
  }, 60_000);

  it('reads the translation a project already uses out of its own translations', async () => {
    const extracted = await call<{
      candidates: { term: string; keyCount: number; suggestions: { locale: string; value: string; support: number; total: number; example: { source: string; target: string } }[] }[];
      locales: string[];
    }>(`/projects/${projectId}/glossary/extract`, { method: 'POST', token: session.token, body: { minKeys: 2, limit: 20 } });
    expect(extracted.status, JSON.stringify(extracted.body.error)).toBe(201);

    const course = extracted.body.data!.candidates.find((entry) => entry.term.toLowerCase() === 'course');
    expect(course, JSON.stringify(extracted.body.data!.candidates.map((entry) => entry.term))).toBeTruthy();

    const japanese = course!.suggestions.find((item) => item.locale === 'ja-JP');
    // Three of the four keys containing `Course` say `コース`; the fourth says `モジュール`. The count
    // is the whole point — it is what lets somebody accept this in one glance, and it is also what
    // tells them it is not unanimous.
    expect(japanese).toMatchObject({ value: 'コース', support: 3, total: 4 });
    // The example is one occurrence, whole. Which one is not fixed — the term matches its source
    // case-insensitively, so a key that says `the course` is as much an occurrence as one that says
    // `Course` — but it does have to be an occurrence, and the value has to be in it.
    expect(japanese!.example.source.toLowerCase()).toContain('course');
    expect(japanese!.example.target).toContain('コース');
    // The source language is not a language to translate into, and asking what a word is in the
    // language it is already in is the one answer that is always right.
    expect(extracted.body.data!.locales).toEqual(['ja-JP']);
  }, 120_000);

  it('extracts the same vocabulary over MCP', async () => {
    // The same question the back office's button asks, answered by the same function — an agent that
    // is about to propose terms should first find out what the project already decided.
    const extracted = await client!.callTool({
      name: 'extract_glossary_candidates',
      arguments: { project_id: projectId, min_keys: 2, limit: 20 },
    });
    expect(extracted.isError, JSON.stringify(extracted.content)).toBeFalsy();

    const data = payload<{
      candidates: { term: string; keyCount: number; suggestions: { locale: string; value: string; support: number; total: number }[] }[];
      scannedKeys: number;
      locales: string[];
    }>(extracted);

    const course = data.candidates.find((entry) => entry.term.toLowerCase() === 'course');
    expect(course, JSON.stringify(data.candidates.map((entry) => entry.term))).toBeTruthy();
    expect(course!.suggestions).toMatchObject([{ locale: 'ja-JP', value: 'コース', support: 3, total: 4 }]);
    // The denominator travels with the answer, or `3/4` is indistinguishable from `3/3`.
    expect(data.scannedKeys).toBeGreaterThan(0);
    expect(data.locales).toEqual(['ja-JP']);
  }, 120_000);

  it('lands a proposed term as a draft, and re-reads the project against it', async () => {
    const proposed = await client!.callTool({
      name: 'upsert_glossary_terms',
      arguments: {
        project_id: projectId,
        terms: [{ term: 'Course', translations: { 'ja-JP': 'コース' }, note: '课程' }],
      },
    });
    const result = payload<{ created: string[]; updated: string[]; untouched: unknown[]; recheck: { queued: boolean } }>(proposed);
    expect(result.created).toEqual(['Course']);
    expect(result.untouched).toEqual([]);
    // The enqueue is the whole difference between a termbase and a list of words.
    expect(result.recheck.queued).toBe(true);

    const glossary = await call<{ terms: { term: string; status: string; scope: string }[] }>(`/projects/${projectId}/glossary`, {
      token: session.token,
    });
    expect(glossary.body.data!.terms).toMatchObject([{ term: 'Course', status: 'DRAFT', scope: 'project' }]);

    // A candidate is a suggestion: the sentence that ignores it is reported, but only as a warning.
    const issue = await until('the recheck to report the missing term', async () => {
      const issues = await openIssues(projectId);
      return issues.find((row) => row.translationKey === 'home.title') ?? null;
    });
    expect(issue.severity).toBe('WARNING');
    expect(issue.message).toContain('Course');

    // ...and the entry that already says it is left alone.
    expect((await openIssues(projectId)).map((row) => row.translationKey)).toEqual(['home.title']);

    // The release check asks the termbase the same question, and a *candidate* is not a rule: it
    // shows up in the report, and the report still passes.
    const draftCheck = await releaseCheck(projectId);
    expect(draftCheck.issues.some((issue) => issue.code === 'GLOSSARY_TERM_MISSING')).toBe(true);
    expect(draftCheck.ok).toBe(true);
  }, 120_000);

  it('records why the run happened', async () => {
    const prisma = new PrismaClient();
    try {
      const run = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        return tx.qaRun.findFirstOrThrow({ where: { projectId }, orderBy: { startedAt: 'desc' } });
      });
      // A run that appears from nowhere is a run nobody can explain; the cause travels with it.
      expect(run.scope).toMatchObject({ reason: 'glossary.terms_proposed', terms: ['Course'] });
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  it('turns a proposed term into a rule only when a person approves it', async () => {
    const terms = await call<{ terms: { id: string; term: string }[] }>(`/projects/${projectId}/glossary`, { token: session.token });
    const termId = terms.body.data!.terms.find((term) => term.term === 'Course')!.id;

    const approved = await call<{ recheck: { queued: boolean } }>(`/projects/${projectId}/glossary/${termId}`, {
      method: 'PATCH',
      token: session.token,
      body: { status: 'APPROVED' },
    });
    expect(approved.status, JSON.stringify(approved.body.error)).toBe(200);
    expect(approved.body.data!.recheck.queued).toBe(true);

    // Same sentence, same term, louder: approved is what puts it in front of a release.
    const escalated = await until('the violation to become an error', async () => {
      const issues = await openIssues(projectId);
      const issue = issues.find((row) => row.translationKey === 'home.title');
      return issue && issue.severity === 'ERROR' ? issue : null;
    });
    expect(escalated.severity).toBe('ERROR');

    // And the gate is real, not a colour on a page: the pre-release check now refuses. This is the
    // claim the design made from the start and the code did not keep — `validateForRelease`
    // recomputed four checks of its own and never read the termbase.
    const check = await releaseCheck(projectId);
    expect(check.ok).toBe(false);
    expect(check.counts.glossaryProblems).toBeGreaterThan(0);
    const blocker = check.issues.find((issue) => issue.code === 'GLOSSARY_TERM_MISSING');
    expect(blocker).toMatchObject({ severity: 'ERROR', key: 'home.title', locale: 'ja-JP' });
  }, 120_000);

  it('will not let an agent rewrite a term somebody approved', async () => {
    const attempt = await client!.callTool({
      name: 'upsert_glossary_terms',
      arguments: { project_id: projectId, terms: [{ term: 'course', translations: { 'ja-JP': '講座' }, status: 'APPROVED' }] },
    });
    const result = payload<{ created: string[]; updated: string[]; untouched: { term: string; status: string }[] }>(attempt);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.untouched).toMatchObject([{ term: 'Course', status: 'APPROVED' }]);

    // And the row really is untouched — the tool did not quietly apply the translation it was given.
    const glossary = await call<{ terms: { term: string; translations: Record<string, string>; status: string }[] }>(
      `/projects/${projectId}/glossary`,
      { token: session.token },
    );
    expect(glossary.body.data!.terms[0]).toMatchObject({ term: 'Course', status: 'APPROVED', translations: { 'ja-JP': 'コース' } });
  }, 60_000);

  it('takes a whole termbase in, once, and does not leave two of anything', async () => {
    const first = await client!.callTool({
      name: 'import_glossary_terms',
      arguments: {
        project_id: projectId,
        terms: [
          { term: 'Checkout', translations: { 'ja-JP': 'お会計' }, note: '结算' },
          { term: 'Cart', translations: { 'ja-JP': 'カート' } },
        ],
      },
    });
    const created = payload<{ created: string[]; updated: string[]; status: string }>(first);
    expect(created.created.sort()).toEqual(['Cart', 'Checkout']);
    // Nothing said, so nothing is settled: a termbase arrival is a proposal until somebody says so.
    expect(created.status).toBe('DRAFT');

    const second = await client!.callTool({
      name: 'import_glossary_terms',
      arguments: { project_id: projectId, terms: [{ term: 'checkout', translations: { 'ja-JP': 'お勘定' } }] },
    });
    const again = payload<{ created: string[]; updated: string[] }>(second);
    // The corrected spreadsheet case, which is the one that actually happens: a second import must
    // update the row, not add a second `checkout` beside `Checkout`.
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual(['Checkout']);

    const glossary = await call<{ terms: { term: string; translations: Record<string, string> }[] }>(
      `/projects/${projectId}/glossary`,
      { token: session.token },
    );
    const matches = glossary.body.data!.terms.filter((term) => term.term.toLowerCase() === 'checkout');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.translations['ja-JP']).toBe('お勘定');
  }, 120_000);

  it('will not let a draft import rewrite a term somebody approved', async () => {
    const terms = await call<{ terms: { id: string; term: string }[] }>(`/projects/${projectId}/glossary`, { token: session.token });
    const cart = terms.body.data!.terms.find((term) => term.term === 'Cart')!;
    await call(`/projects/${projectId}/glossary/${cart.id}`, { method: 'PATCH', token: session.token, body: { status: 'APPROVED' } });

    const imported = await client!.callTool({
      name: 'import_glossary_terms',
      arguments: { project_id: projectId, terms: [{ term: 'Cart', translations: { 'ja-JP': '買い物かご' } }] },
    });
    const result = payload<{ updated: string[]; untouched: { term: string; status: string }[] }>(imported);

    expect(result.updated).toEqual([]);
    expect(result.untouched).toMatchObject([{ term: 'Cart', status: 'APPROVED' }]);
    const after = await call<{ terms: { term: string; translations: Record<string, string> }[] }>(`/projects/${projectId}/glossary`, {
      token: session.token,
    });
    expect(after.body.data!.terms.find((term) => term.term === 'Cart')!.translations['ja-JP']).toBe('カート');
  }, 120_000);

  it('lets a translator propose a whole termbase, but not settle one', async () => {
    const translator = new Client({ name: 'glossary-translator', version: '0.0.0' });
    await translator.connect(transport(translatorToken));
    try {
      const refused = await translator.callTool({
        name: 'import_glossary_terms',
        arguments: { project_id: projectId, status: 'APPROVED', terms: [{ term: 'Coupon', translations: { 'ja-JP': 'クーポン' } }] },
      });
      expect(refused.isError).toBe(true);
      // Approving through the side door is still approving.
      expect(JSON.stringify(refused.content)).toContain('ROLE_INSUFFICIENT');

      const allowed = await translator.callTool({
        name: 'import_glossary_terms',
        arguments: { project_id: projectId, terms: [{ term: 'Coupon', translations: { 'ja-JP': 'クーポン' } }] },
      });
      expect(allowed.isError, JSON.stringify(allowed.content)).toBeFalsy();
      expect(payload<{ created: string[]; status: string }>(allowed)).toMatchObject({ created: ['Coupon'], status: 'DRAFT' });
    } finally {
      await translator.close();
    }
  }, 120_000);

  it('switches a term back on when the termbase says it applies', async () => {
    // A project row can switch an organisation term off. Importing that term is a decision that it
    // applies here, and without clearing the flag the imported values would land on a row nobody
    // reads — a silent no-op that looks like a successful import.
    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        await tx.glossaryTerm.create({
          data: { organizationId, projectId: null, term: 'Invoice', translations: { 'ja-JP': '請求書' }, status: 'APPROVED' },
        });
        // A project row whose only job is to switch the organisation's term off here.
        await tx.glossaryTerm.create({
          data: { organizationId, projectId, term: 'Invoice', translations: {}, status: 'DRAFT', disabled: true },
        });
      });
    } finally {
      await prisma.$disconnect();
    }

    const before = await call<{ terms: { term: string }[] }>(`/projects/${projectId}/glossary`, { token: session.token });
    expect(before.body.data!.terms.map((term) => term.term)).not.toContain('Invoice');

    await client!.callTool({
      name: 'import_glossary_terms',
      arguments: { project_id: projectId, terms: [{ term: 'Invoice', translations: { 'ja-JP': 'インボイス' } }] },
    });

    const after = await call<{ terms: { term: string; translations: Record<string, string>; scope: string }[] }>(
      `/projects/${projectId}/glossary`,
      { token: session.token },
    );
    const invoice = after.body.data!.terms.find((term) => term.term === 'Invoice');
    expect(invoice).toMatchObject({ scope: 'project' });
    expect(invoice!.translations['ja-JP']).toBe('インボイス');
  }, 120_000);

  it('answers get_glossary the way the platform itself reads the termbase', async () => {
    // This tool used to be a raw `findMany` over both scopes — the one read path the resolver missed.
    // It answered a caller with a term twice when the organisation and the project both had one,
    // with a switched-off project row as if it were a term, and with no way to tell which reading it
    // was being held to. The assertions below are the four ways that lied.
    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        // Organisation says 元帳; this project says 台帳 and rules out 帳簿.
        await tx.glossaryTerm.create({
          data: { organizationId, projectId: null, term: 'Ledger', translations: { 'ja-JP': '元帳' }, status: 'APPROVED' },
        });
        await tx.glossaryTerm.create({
          data: {
            organizationId,
            projectId,
            term: 'Ledger',
            translations: { 'ja-JP': '台帳' },
            status: 'APPROVED',
            forbiddenTargets: { 'ja-JP': ['帳簿'] },
          },
        });
        // An organisation term this project switched off, and one it simply has no opinion about.
        await tx.glossaryTerm.create({
          data: { organizationId, projectId: null, term: 'Receipt', translations: { 'ja-JP': '領収書' }, status: 'APPROVED' },
        });
        await tx.glossaryTerm.create({
          data: { organizationId, projectId, term: 'Receipt', translations: {}, status: 'DRAFT', disabled: true },
        });
        await tx.glossaryTerm.create({
          data: { organizationId, projectId: null, term: 'NoJapanese', translations: { 'zh-CN': '无日语' }, status: 'DRAFT' },
        });
      });
    } finally {
      await prisma.$disconnect();
    }

    const all = payload<{ terms: { term: string; scope: string; translations: Record<string, string>; overrides?: { term: string; translations: Record<string, string> } }[] }>(
      await client!.callTool({ name: 'get_glossary', arguments: { project_id: projectId } }),
    );
    const ledger = all.terms.filter((term) => term.term === 'Ledger');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ scope: 'project', translations: { 'ja-JP': '台帳' } });
    // ...and it says what it overrode, so a caller can see the disagreement rather than guess.
    expect(ledger[0]!.overrides).toMatchObject({ translations: { 'ja-JP': '元帳' } });
    expect(all.terms.map((term) => term.term)).not.toContain('Receipt');

    const japanese = payload<{ locale: string; terms: { term: string; translation: string | null; forbidden: string[] }[] }>(
      await client!.callTool({ name: 'get_glossary', arguments: { project_id: projectId, locale: 'ja-JP' } }),
    );
    expect(japanese.locale).toBe('ja-JP');
    const localized = japanese.terms.find((term) => term.term === 'Ledger')!;
    // The value and the ruled-out wording, resolved for the language being asked about.
    expect(localized).toMatchObject({ translation: '台帳', forbidden: ['帳簿'] });
    // A term with nothing in this language is not a term *for* this language: returning it would read
    // as leave-it-as-it-is.
    expect(japanese.terms.map((term) => term.term)).not.toContain('NoJapanese');
  }, 120_000);

  it('stops complaining once the term is gone', async () => {
    const terms = await call<{ terms: { id: string; term: string }[] }>(`/projects/${projectId}/glossary`, { token: session.token });
    const termId = terms.body.data!.terms.find((term) => term.term === 'Course')!.id;

    const removed = await call<{ deleted: boolean; recheck: { queued: boolean } }>(`/projects/${projectId}/glossary/${termId}`, {
      method: 'DELETE',
      token: session.token,
    });
    expect(removed.status, JSON.stringify(removed.body.error)).toBe(200);

    // The other half of being a rule: deleting it has to take its complaints with it.
    await until(
      'the deleted term’s issue to go',
      async () => ((await openIssues(projectId)).length === 0 ? true : null),
    );
    expect(await openIssues(projectId)).toEqual([]);

    // Deleting the term has to unblock the release too, or the gate is a wall with no door.
    const check = await releaseCheck(projectId);
    expect(check.ok).toBe(true);
    expect(check.issues.filter((issue) => issue.code.startsWith('GLOSSARY'))).toEqual([]);
  }, 120_000);
});
