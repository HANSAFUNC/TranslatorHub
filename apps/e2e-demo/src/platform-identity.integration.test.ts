import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { contentHash } from '@localehub/contracts';

import { ensureApi, type ApiHandle } from './api-harness';

/**
 * The platform a caller declares has to reach the key's identity.
 *
 * A key is identified by `(project, platform, namespace, key)`, and every document the platform
 * serves says so — but `scanEntrySchema` had no `platform` field at all, so zod stripped whatever a
 * caller sent and `parseScanEntries` fell back to `web` for every entry of every import. An iOS
 * project with 2,791 keys had 2,791 `web` keys and not one `ios` key, while its own
 * `project_platforms` said `ios`.
 *
 * What only this suite can show is the whole path: REST scan → preview → push → the rows in
 * PostgreSQL, the identity a second push matches against, and the two-platform case that proves the
 * platform really is part of the identity rather than a label on the side.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let token = '';
let projectId = '';
let prisma: PrismaClient | null = null;

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; data: T | undefined; error?: { code: string; message: string } }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ?? token ? { authorization: `Bearer ${options.token ?? token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { data?: T; error?: { code: string; message: string } }) : {};
  return { status: response.status, data: payload.data, error: payload.error };
}

/** One file of one scan, with entries that deliberately carry no platform of their own. */
function scanBatch(scanId: string, files: { fileId: string; platform: string; locale: string; key: string; value: string }[]) {
  return {
    projectId,
    scanId,
    partial: true,
    client: { name: 'platform-identity-suite', version: '0.0.0' },
    files: files.map((file) => ({
      fileId: file.fileId,
      filePath: `locales/${file.locale}/${file.fileId}.strings`,
      locale: file.locale,
      platform: file.platform,
      format: 'json',
      fileHash: `hash-${file.fileId}`,
      entryCount: 1,
    })),
    entries: files.map((file) => ({
      key: file.key,
      namespace: '',
      locale: file.locale,
      value: file.value,
      isSource: file.locale === 'zh-CN',
      // The real hash of the value: a scan that lies about it makes every push look like an update,
      // which is how the second test below first failed.
      contentHash: contentHash(file.value),
      fileId: file.fileId,
      filePath: `locales/${file.locale}/${file.fileId}.strings`,
    })),
  };
}

interface Batch {
  files: Parameters<typeof scanBatch>[1];
  /** An entry that names its own platform, for the caller that sends no files at all. */
  entryPlatform?: string;
}

/**
 * Scan → preview → push, and the two summaries that matter.
 *
 * The plan says what the push *will* do (`pushNew`, `unchanged`, `archiveCandidates`); the result
 * says what it did (`created`, `updated`, `archived`). The bug this file exists for shows up in both:
 * a key whose platform changed looks like a new key *and* an archive candidate.
 */
async function pushScan(
  scanId: string,
  batch: Batch,
): Promise<{ plan: Record<string, number>; push: Record<string, number>; expansion: { platformsAdded: string[] } }> {
  const body = scanBatch(scanId, batch.files);
  if (batch.entryPlatform) {
    // Same payload, except that the platform is on the entry and there are no files to derive it from.
    body.files = [];
    for (const entry of body.entries) (entry as { platform?: string }).platform = batch.entryPlatform;
  }
  const scan = await call<{ connectionId: string; expansion: { platformsAdded: string[] } }>('/sync/scans', { method: 'POST', body });
  expect(scan.status, JSON.stringify(scan.error)).toBe(201);

  const preview = await call<{ syncPlanId: string; planHash: string; summary: Record<string, number> }>('/sync/preview', {
    method: 'POST',
    body: {
      projectId,
      repositoryConnectionId: scan.data!.connectionId,
      scanId,
      direction: 'push',
      includeDeletes: false,
      includeDrafts: false,
    },
  });
  expect(preview.status, JSON.stringify(preview.error)).toBe(201);

  const pushed = await call<{ summary: Record<string, number> }>('/sync/push', {
    method: 'POST',
    body: { syncPlanId: preview.data!.syncPlanId, planHash: preview.data!.planHash, confirmed: true },
  });
  expect(pushed.status, JSON.stringify(pushed.error)).toBe(201);
  return { plan: preview.data!.summary, push: pushed.data!.summary, expansion: scan.data!.expansion };
}

/** Key platforms straight from the database, where the identity actually lives. */
async function keyPlatforms(): Promise<Record<string, number>> {
  // Inside the bypass, like every other out-of-band query here: RLS hides all rows from a raw
  // connection without an organization context, and a test that reads nothing proves nothing.
  const rows = await prisma!.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return tx.$queryRawUnsafe<{ platform: string; count: bigint }[]>(
      `SELECT platform::text AS platform, count(*)::bigint AS count
         FROM translation_keys WHERE project_id = $1::uuid GROUP BY platform ORDER BY platform`,
      projectId,
    );
  });
  return Object.fromEntries(rows.map((row) => [row.platform, Number(row.count)]));
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  const email = `platform-${runId}@localehub.dev`;
  const password = 'platform-password-123';
  prisma = new PrismaClient();
  const { hashPassword } = await import('@localehub/domain');
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    const user = await tx.user.create({ data: { email, name: 'Platform Identity', passwordHash, isPlatformAdmin: false } });
    const organization = await tx.organization.create({
      data: { name: `Platform Org ${email}`, slug: `platform-${runId}` },
    });
    await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
  });

  const login = await call<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } });
  expect(login.status, JSON.stringify(login.error)).toBeLessThan(300);
  token = login.data!.token;

  // An iOS project, exactly like the one that exposed this: it declares `ios` and nothing else.
  const created = await call<{ id: string }>('/projects', {
    method: 'POST',
    body: { name: `iOS 身份 ${runId}`, sourceLocale: 'zh-CN', locales: ['en-US'], platforms: ['ios'] },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  projectId = created.data!.id;
}, 180_000);

afterAll(async () => {
  if (projectId) await call(`/projects/${projectId}?confirmName=${encodeURIComponent(`iOS 身份 ${runId}`)}`, { method: 'DELETE' });
  await prisma?.$disconnect();
  await api?.stop();
});

describe('the platform a caller declares becomes the key’s platform', () => {
  it('stores an iOS file’s entries under ios, not web', async () => {
    const { plan, push } = await pushScan(`ios-${runId}`, {
      files: [
        { fileId: 'ios-zh-CN', platform: 'ios', locale: 'zh-CN', key: 'checkout.pay_now', value: '立即支付' },
        { fileId: 'ios-en-US', platform: 'ios', locale: 'en-US', key: 'checkout.pay_now', value: 'Pay now' },
      ],
    });
    // One key, two locales: the key is what carries the platform.
    expect(plan).toMatchObject({ pushNew: 2, archiveCandidates: 0 });
    // Two entries — the same key in two locales — under one key row.
    expect(push).toMatchObject({ created: 2, archived: 0 });
    expect(await keyPlatforms()).toEqual({ ios: 1 });

    // And the API reports the same platform it stored, which is what the editor filters on.
    const listed = await call<{ items: { platform: string; key: string }[]; total: number }>(
      `/projects/${projectId}/translations?platform=ios`,
    );
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data!.items.map((row) => row.platform)).toContain('ios');
    expect(await call(`/projects/${projectId}/translations?platform=web`)).toMatchObject({ status: 200 });
  });

  it('is idempotent: re-pushing the same files changes nothing and archives nothing', async () => {
    // The failure mode this guards is the migration's: if the entry's platform were dropped again,
    // every key the platform already holds would become an archive candidate and a second, `web` set
    // would appear beside it.
    const { plan, push } = await pushScan(`ios-again-${runId}`, {
      files: [
        { fileId: 'ios-zh-CN', platform: 'ios', locale: 'zh-CN', key: 'checkout.pay_now', value: '立即支付' },
        { fileId: 'ios-en-US', platform: 'ios', locale: 'en-US', key: 'checkout.pay_now', value: 'Pay now' },
      ],
    });
    // Nothing new, nothing gone: the same platform on both sides means the same keys.
    expect(plan).toMatchObject({ pushNew: 0, pushUpdated: 0, archiveCandidates: 0, unchanged: 2 });
    expect(push).toMatchObject({ created: 0, updated: 0, archived: 0 });
    expect(await keyPlatforms()).toEqual({ ios: 1 });
  });

  it('keeps one key name twice when two platforms declare it — the identity is the pair', async () => {
    // The same `web` project the tooling has always produced, now alongside the iOS one. A platform
    // that were merely a label would collapse these into a single key and lose one of the values.
    const { plan } = await pushScan(`mixed-${runId}`, {
      files: [
        { fileId: 'ios-zh-CN-2', platform: 'ios', locale: 'zh-CN', key: 'nav.settings', value: '设置（iOS）' },
        { fileId: 'web-zh-CN', platform: 'web', locale: 'zh-CN', key: 'nav.settings', value: '设置（Web）' },
      ],
    });
    expect(plan).toMatchObject({ pushNew: 2, archiveCandidates: 0 });
    expect(await keyPlatforms()).toEqual({ ios: 2, web: 1 });

    type Listed = { items: { platform: string; key: string; source: string | null }[] };
    const iosKeys = await call<Listed>(`/projects/${projectId}/translations?platform=ios&locale=zh-CN`);
    expect(iosKeys.data!.items.map((row) => row.key).sort()).toEqual(['checkout.pay_now', 'nav.settings']);
    const webKeys = await call<Listed>(`/projects/${projectId}/translations?platform=web&locale=zh-CN`);
    expect(webKeys.data!.items.map((row) => row.key)).toEqual(['nav.settings']);
    // And the two values did not overwrite each other.
    expect(webKeys.data!.items[0]!.source).toBe('设置（Web）');
    expect(iosKeys.data!.items.find((row) => row.key === 'nav.settings')!.source).toBe('设置（iOS）');
  });

  it('also accepts an entry that names its own platform, for a caller that sends no files', async () => {
    const { plan, expansion } = await pushScan(`android-${runId}`, {
      files: [{ fileId: 'android-zh-CN', platform: 'android', locale: 'zh-CN', key: 'nav.settings', value: '设置（Android）' }],
      entryPlatform: 'android',
    });
    // The project's platform list grew with it, which is what `platformsAdded` is for — an entry
    // that names a platform the project does not declare would otherwise create an orphan.
    expect(expansion.platformsAdded).toEqual(['android']);
    expect(plan.pushNew).toBe(1);
    expect((await keyPlatforms()).android).toBe(1);
  });
});
