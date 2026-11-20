import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrismaClient } from '@localehub/database';
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
let mcp: ApiHandle | null = null;
let client: Client | null = null;
let worker: { stop(): Promise<void> } | null = null;
const session = { email: '', password: '', token: '' };

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
            ],
          },
          {
            path: 'web/ja-JP.json',
            locale: 'ja-JP',
            platform: 'web',
            entries: [
              { key: 'home.title', value: 'モジュール一覧' },
              { key: 'home.cta', value: 'コースを始める' },
            ],
          },
        ],
      },
    });
    expect(imported.isError, JSON.stringify(imported.content)).toBeFalsy();
  }, 120_000);

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
