/**
 * Flutter, end to end, on a repository shaped the way `flutter gen-l10n` shapes one.
 *
 * The ARB format is only "compatible" if the whole loop holds on real files: `lib/l10n/app_<locale>.arb`
 * with `@@locale`, `@key` metadata and the generated Dart directory beside them; a scan big enough to
 * be a real project (this one is deliberately over the 100 kB body limit that used to refuse it); and
 * a write-back that changes the one value the platform approved and **not one byte of anything else** —
 * key order, indentation, `@` metadata, the plural object's shape. A regex that rewrote the file would
 * pass every assertion except the last one, and the last one is the promise.
 *
 * Everything it creates, it deletes: the project on the platform, and the workspace in /tmp.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'apps/cli/dist/bin.js');
// 127.0.0.1 rather than `localhost`: Node resolves `localhost` to ::1 first, and Docker Desktop's
// IPv6 port forward drops a response part-way through (the same request over IPv4 is fine). The
// symptom is `UND_ERR_SOCKET: other side closed` after a few kB, which reads like an API crash.
const API = process.env.API_BASE ?? 'http://127.0.0.1:3001/api/v1';
const MARK = Date.now().toString(36);
const LOCALES = ['en', 'zh-CN', 'th'];

/**
 * One API call, retried once when the pooled connection turns out to have been closed.
 *
 * This script runs the CLI as a subprocess between calls — seconds at a time — and Node keeps its
 * HTTP/1.1 connection pool alive in the meantime. The API closes an idle connection after its own
 * keep-alive window, and the next call that picks that socket up fails with
 * `UND_ERR_SOCKET: other side closed` after a few kB: it reads like the API died, and it is not
 * (curl and a fetch with no idle gap answer the same request with a full 100 kB body). Retrying once
 * is what separates that from a real failure.
 */
async function call(path, { method = 'GET', body, token } = {}) {
  const send = () =>
    fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let response;
  try {
    response = await send();
  } catch (error) {
    if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
    console.log('（连接被空闲关闭，重试一次）');
    response = await send();
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** One ARB file, in the shape a real one has: metadata for every key, a placeholder, a plural. */
function arb(locale, prefix) {
  const root = { '@@locale': locale.replace(/-/g, '_') };
  root.appTitle = { en: 'Probe App', 'zh-CN': '探针应用', th: 'แอปทดสอบ' }[locale];
  root['@appTitle'] = { description: 'App title (brand name)' };
  root.unknownRouteBody = { en: 'Unregistered route: {route}', 'zh-CN': '未注册的路由：{route}', th: 'เส้นทาง: {route}' }[locale];
  root['@unknownRouteBody'] = {
    description: 'Body of the unknown-route page',
    placeholders: { route: { type: 'String' } },
  };
  root.cartItems = { one: '{count} item', other: '{count} items' };
  root['@cartItems'] = { description: 'Items in the cart', placeholders: { count: { type: 'int' } } };
  // Bulk, so the scan payload is a real project's size rather than a toy's (and over the 100 kB
  // Express default the scan route used to be stuck with).
  for (let i = 0; i < 400; i += 1) {
    const key = `${prefix}${String(i).padStart(3, '0')}`;
    root[key] = { en: `Entry ${i}`, 'zh-CN': `词条 ${i}`, th: `รายการ ${i}` }[locale];
    root[`@${key}`] = { description: `Probe entry ${i}` };
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

function cli(workspace, args, token) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: workspace,
    env: { ...process.env, LOCALEHUB_TOKEN: token },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

const session = (await call('/auth/login', { method: 'POST', body: { email: 'demo@localehub.dev', password: 'demo-password-123' } }))
  .body.data.token;

const created = await call('/projects', {
  method: 'POST',
  token: session,
  body: {
    name: `Flutter ARB 检查 ${MARK}`,
    slug: `flutter-arb-check-${MARK}`,
    sourceLocale: 'en',
    locales: LOCALES.filter((locale) => locale !== 'en'),
    platforms: ['universal'],
  },
});
if (created.status !== 201) throw new Error(`project: ${JSON.stringify(created.body)}`);
const projectId = created.body.data.id;

const issued = await call('/mcp-tokens', {
  method: 'POST',
  token: session,
  body: {
    name: `flutter-arb-check-${MARK}`,
    scopes: [
      'project.read',
      'repository.scan',
      'sync.preview',
      'sync.push',
      'translation.read',
      'translation.write',
      'translation.pull',
      'translation.apply',
    ],
    projectIds: [projectId],
    expiresInDays: 1,
  },
});
if (issued.status >= 300) throw new Error(`token: ${JSON.stringify(issued.body)}`);
const token = issued.body.data.token;

const workspace = mkdtempSync(join(tmpdir(), 'flutter-arb-'));
let failure = null;
try {
  mkdirSync(join(workspace, 'lib/l10n'), { recursive: true });
  mkdirSync(join(workspace, 'lib/l10n/generated'), { recursive: true });
  for (const locale of LOCALES) {
    writeFileSync(join(workspace, `lib/l10n/app_${locale.replace(/-/g, '_')}.arb`), arb(locale, 'probe'));
  }
  writeFileSync(join(workspace, 'lib/l10n/generated/app_localizations.dart'), '// generated by gen-l10n\n');

  const init = cli(workspace, ['init', '--preset', 'flutter', '--project', projectId, '--source-locale', 'en', '--locales', 'zh-CN,th']);
  if (init.code !== 0) throw new Error(`init failed: ${init.out}`);
  const configPath = join(workspace, '.localehub/config.yaml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/platforms:\n\s+- universal/, 'platforms:\n    - universal'));
  console.log('workspace     :', workspace);
  console.log('config paths  :', LOCALES.map((locale) => `lib/l10n/app_${locale.replace(/-/g, '_')}.arb`).join(' , '));

  // ---- scan (this payload is over 100 kB on purpose) --------------------------
  const scan = cli(workspace, ['scan'], token);
  if (scan.code !== 0) throw new Error(`scan failed: ${scan.out}`);
  console.log('scan          :', scan.out.split('\n')[0]);
  if (scan.out.includes('上传失败')) throw new Error(`scan did not reach the platform:\n${scan.out}`);
  const remote = await call(`/projects/${projectId}/translations?locale=zh-CN&limit=1`, { token: session });
  console.log('platform      : accepted the scan (translation rows readable:', remote.status === 200, ')');

  // ---- push everything up -----------------------------------------------------
  const preview = cli(workspace, ['sync', 'preview'], token);
  const newCount = (preview.out.match(/PUSH_NEW\]/g) ?? []).length;
  console.log('preview       :', newCount, 'PUSH_NEW changes');
  const push = cli(workspace, ['sync', 'push', '--confirm'], token);
  if (!push.out.includes('SUCCEEDED')) throw new Error(`push failed: ${push.out}`);
  console.log('push          :', push.out.split('\n').pop());

  // ---- one change on the platform, then the documented write-back -------------
  const rows = await call(`/projects/${projectId}/translations?locale=zh-CN&limit=200`, { token: session });
  const target = (rows.body.data.items ?? rows.body.data).find((row) => row.key === 'appTitle');
  if (!target) throw new Error('appTitle not found among the pushed entries');
  await call(`/projects/${projectId}/translations/${target.entryId}/draft`, { method: 'POST', token: session, body: { value: '探针应用（已改）' } });
  await call(`/projects/${projectId}/translations/review`, { method: 'POST', token: session, body: { entryIds: [target.entryId], decision: 'APPROVE' } });

  const file = join(workspace, 'lib/l10n/app_zh_CN.arb');
  const before = readFileSync(file, 'utf8');
  const pull = cli(workspace, ['pull'], token);
  console.log('pull          :', pull.out.split('\n')[0]);
  const plan = cli(workspace, ['apply', 'preview'], token);
  const planId = /apply plan (\S+):/.exec(plan.out)?.[1];
  if (!planId) throw new Error(`no apply plan: ${plan.out}`);
  console.log('apply preview :', plan.out.split('\n')[0]);

  // The documented write form. Before this check existed, `apply --confirm` fell into the preview
  // branch and reported success while the file stayed as it was.
  const apply = cli(workspace, ['apply', '--confirm', '--apply-plan', planId], token);
  if (!apply.out.includes('apply SUCCEEDED')) throw new Error(`apply did not write: ${apply.out}`);
  console.log('apply         :', apply.out.split('\n')[0]);

  // ---- what actually changed --------------------------------------------------
  const after = readFileSync(file, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const changed = beforeLines.map((line, index) => (line === afterLines[index] ? null : index)).filter((index) => index !== null);
  const parsed = JSON.parse(after);
  const keys = Object.keys(parsed).filter((key) => !key.startsWith('@'));

  console.log('changed lines :', changed.length, changed.map((index) => `${index + 1}: ${beforeLines[index].trim()} → ${afterLines[index].trim()}`).join(' | '));
  console.log('@@locale      :', parsed['@@locale'], '| entries:', keys.length, '| @appTitle intact:', Boolean(parsed['@appTitle']?.description));
  console.log('plural shape  :', JSON.stringify(parsed.cartItems), '| @cartItems:', JSON.stringify(parsed['@cartItems']));
  console.log('key order     :', keys.slice(0, 4).join(','), '...');

  const sameLength = beforeLines.length === afterLines.length;
  const oneLine = changed.length === 1;
  const onlyTheValue = after.includes('"appTitle": "探针应用（已改）"');
  const metadataKept = parsed['@appTitle']?.description === 'App title (brand name)' && parsed['@unknownRouteBody']?.placeholders?.route?.type === 'String';
  const pluralKept = typeof parsed.cartItems === 'object' && parsed.cartItems.other === '{count} items';
  const orderKept = keys[0] === 'appTitle' && keys[1] === 'unknownRouteBody' && keys[2] === 'cartItems';
  // The generated Dart beside the ARB files is not a language resource and must not be touched.
  const generatedUntouched =
    readFileSync(join(workspace, 'lib/l10n/generated/app_localizations.dart'), 'utf8') === '// generated by gen-l10n\n';

  const pass = sameLength && oneLine && onlyTheValue && metadataKept && pluralKept && orderKept && generatedUntouched;
  console.log(
    'RESULT:',
    pass
      ? 'a Flutter repository scans, pushes, pulls and writes back — one value changed, the file otherwise byte-identical'
      : `FAILED (length ${sameLength}, oneLine ${oneLine}, value ${onlyTheValue}, metadata ${metadataKept}, plural ${pluralKept}, order ${orderKept}, generated ${generatedUntouched})`,
  );
  if (!pass) failure = new Error('write-back changed more than the approved value');
} finally {
  await call(`/projects/${projectId}?confirmName=${encodeURIComponent(`Flutter ARB 检查 ${MARK}`)}`, { method: 'DELETE', token: session });
  rmSync(workspace, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.message);
  process.exit(1);
}
