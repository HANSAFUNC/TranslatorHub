/**
 * A screen captured from a device that is actually running, end to end.
 *
 * Every other way a screen reaches the platform is a transcription — HTML someone wrote, a `ui` tree
 * someone described, a picture someone drew and measured by eye. This one is a reading, and the whole
 * claim rests on two facts that only a real device can settle:
 *
 *   1. the pixels the platform serves back are the device's own bytes, not a redraw of them, and
 *   2. the marker boxes came from the same moment as those pixels, so they sit on the elements they
 *      name — the thing transcription kept getting wrong (19 of 29 Android screens in one measured
 *      project were laid out past the phone's frame).
 *
 * So this script photographs whatever is on the device right now, harvests the strings from the same
 * dump, pushes them as keys, captures, uploads, and then asks the platform to prove both facts: the
 * stored bytes are byte-identical, and every marker matched a key.
 *
 * Skips cleanly (exit 0, printing why) when there is no `adb` or no device — a machine without a phone
 * is not a failure. Everything it creates, it deletes: the probe project on the platform, and the
 * workspace in /tmp.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { markersFromDump, parseUiDump } = require('../packages/local-sync/dist/ui-dump.js');
const { captureAndroidScreen, listAndroidDevices, resolveDevice, systemDeviceRunner } = require('../packages/local-sync/dist/device.js');

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'apps/cli/dist/bin.js');
// 127.0.0.1 rather than `localhost`: Node resolves `localhost` to ::1 first and Docker Desktop's IPv6
// forward drops a response part-way through. See scripts/check-flutter-arb.mjs.
const API = process.env.API_BASE ?? 'http://127.0.0.1:3001/api/v1';
const MARK = Date.now().toString(36);

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

function cli(workspace, args, token) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: workspace,
    env: { ...process.env, LOCALEHUB_TOKEN: token },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

// ---- the device ---------------------------------------------------------------
let run;
let device;
try {
  run = systemDeviceRunner();
  const devices = listAndroidDevices(run).filter((device) => device.state === 'device');
  if (!devices.length) {
    console.log('SKIP: 没有连着安卓设备（adb devices 为空）。接一台真机或启动模拟器再跑。');
    process.exit(0);
  }
  // `ANDROID_SERIAL` when set; otherwise the first attached device. `resolveDevice` refuses to pick
  // between several on its own, which is the right call for a person and the wrong one for a check —
  // the check has to be able to run unattended, and any attached device exercises the same path.
  const serial = process.env.ANDROID_SERIAL ?? devices[0].serial;
  device = resolveDevice(run, serial);
  console.log('device   :', device.serial, device.model || '(型号未知)');
} catch (error) {
  // No adb at all is a skip, not a failure: this check needs hardware.
  if (/找不到 adb/.test(String(error?.message))) {
    console.log('SKIP: 找不到 adb（装 platform-tools 或把它放进 PATH）。');
    process.exit(0);
  }
  throw error;
}

const captured = captureAndroidScreen(run, { serial: device.serial });
console.log('captured :', `${captured.width}×${captured.height}`, captured.device.package ?? '(包名未知)');

const parsed = parseUiDump(captured.dumpXml);
const strings = [
  ...new Set(
    markersFromDump(
      parsed.nodes.filter((node) => !node.packageName || node.packageName === parsed.packageName),
      { width: captured.width, height: captured.height },
    ).markers.map((marker) => marker.text),
  ),
];
if (!strings.length) {
  console.log('SKIP: 这一屏没有任何可翻译文字（可能正在加载或全屏视频）。停在有文字的界面再跑。');
  process.exit(0);
}
console.log('on screen:', strings.length, 'strings, e.g.', JSON.stringify(strings.slice(0, 3)));

const session = (await call('/auth/login', { method: 'POST', body: { email: 'demo@localehub.dev', password: 'demo-password-123' } }))
  .body.data.token;

const created = await call('/projects', {
  method: 'POST',
  token: session,
  body: {
    name: `Device capture ${MARK}`,
    slug: `device-capture-${MARK}`,
    sourceLocale: 'zh-CN',
    locales: ['en-US'],
    platforms: ['android'],
  },
});
if (created.status !== 201) throw new Error(`project: ${JSON.stringify(created.body)}`);
const projectId = created.body.data.id;
const projectName = `Device capture ${MARK}`;

const issued = await call('/mcp-tokens', {
  method: 'POST',
  token: session,
  body: {
    name: `device-capture-${MARK}`,
    scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read', 'translation.pull'],
    projectIds: [projectId],
    expiresInDays: 1,
  },
});
if (issued.status >= 300) throw new Error(`token: ${JSON.stringify(issued.body)}`);
const token = issued.body.data.token;

const workspace = mkdtempSync(join(tmpdir(), 'device-capture-'));
let failure = null;
try {
  const init = cli(workspace, ['init', '--project', projectId, '--source-locale', 'zh-CN', '--locales', 'en-US']);
  if (init.code !== 0) throw new Error(`init failed: ${init.out}`);

  // The probe project's keys are the strings that happen to be on the screen — pushed through the
  // platform's own import path, so the lookup the capture does is the real one.
  const configPath = join(workspace, '.localehub/config.yaml');
  const config = readFileSync(configPath, 'utf8');
  writeFileSync(
    configPath,
    `${config.split('files:')[0]}files:
  - id: android-zh
    platform: android
    locale: zh-CN
    format: json
    source: true
    paths:
      - locales/*.json
    keyMode: flat
    namespaceFromPath: false
`,
  );
  mkdirSync(join(workspace, 'locales'), { recursive: true });
  writeFileSync(
    join(workspace, 'locales/zh-CN.json'),
    `${JSON.stringify(Object.fromEntries(strings.map((text, index) => [`capture.string_${index}`, text])), null, 2)}\n`,
  );

  const scan = cli(workspace, ['scan'], token);
  if (scan.code !== 0) throw new Error(`scan failed: ${scan.out}`);
  cli(workspace, ['sync', 'preview'], token);
  const push = cli(workspace, ['sync', 'push', '--confirm'], token);
  if (!push.out.includes('SUCCEEDED')) throw new Error(`push failed: ${push.out}`);
  console.log('platform :', strings.length, 'keys imported');

  // ---- the capture itself ----------------------------------------------------
  // The CLI captures for itself, so it needs the same device named: `resolveDevice` will not choose
  // between several on a person's behalf, and that is the behaviour worth keeping.
  const preview = cli(workspace, ['mockup', 'capture', '--name', '真机屏', '--locale', 'zh-CN', '--serial', device.serial], token);
  if (preview.code !== 0) throw new Error(`capture failed: ${preview.out}`);
  const resolved = Number(/→ (\d+) 个标记（(\d+) 个对上了 key）/.exec(preview.out)?.[2] ?? -1);
  const markerCount = Number(/→ (\d+) 个标记/.exec(preview.out)?.[1] ?? -1);
  console.log('preview  :', markerCount, 'markers,', resolved, 'resolved locally');

  const upload = cli(workspace, ['mockup', 'capture', '--name', '真机屏', '--locale', 'zh-CN', '--serial', device.serial, '--confirm'], token);
  if (!upload.out.includes('已提交真机截图')) throw new Error(`upload failed: ${upload.out}`);
  console.log('upload   :', upload.out.split('\n').pop());

  // ---- what the platform says about it ---------------------------------------
  const listed = await call(`/projects/${projectId}/mockups`, { token: session });
  const rows = listed.body.data.items ?? listed.body.data;
  const mockupId = rows[0]?.id;
  if (!mockupId) throw new Error('the mockup is not on the platform');
  const detail = await call(`/projects/${projectId}/mockups/${mockupId}`, { token: session });
  const stored = detail.body.data.mockup ?? detail.body.data;
  const report = stored.report;
  const codes = report.findings.map((finding) => finding.code);

  const servedResponse = await fetch(`${API}/projects/${projectId}/mockups/${mockupId}/image`, {
    headers: { authorization: `Bearer ${session}` },
  });
  const served = Buffer.from(await servedResponse.arrayBuffer());
  const local = readFileSync(join(workspace, '.localehub/mockups/真机屏.png'));

  console.log('kind     :', stored.kind, '| findings:', JSON.stringify(codes), '| inspected:', report.stats.inspected);
  console.log('bytes    :', `local ${local.length} / served ${served.length}`, '| identical:', local.equals(served));
  console.log('markers  :', report.stats.markers, '| missing keys:', report.stats.missingKeys);

  const checks = {
    'the platform stored the device’s own bytes, not a redraw': local.equals(served),
    'it is stored as a picture, not a replica': stored.kind === 'image',
    'markers came out of the dump': markerCount > 0 && report.stats.markers === markerCount,
    'every marker matched a key that the platform holds': report.stats.missingKeys === 0,
    'the report says plainly that pixels were not inspected': report.stats.inspected === false,
    'and does not pretend the screenshot is a wireframe': !codes.includes('NO_PICTURES') && !codes.includes('NO_SOURCE_COLOURS'),
    'the only finding is the one that says so': codes.length === 1 && codes[0] === 'CAPTURED_IMAGE',
  };
  for (const [what, ok] of Object.entries(checks)) console.log(ok ? 'ok  ' : 'FAIL', what);
  if (Object.values(checks).some((ok) => !ok)) failure = new Error('the capture flow did not hold up');

  console.log(
    'RESULT:',
    failure
      ? 'FAILED'
      : `a real screen — ${markerCount} markers on ${strings.length} strings — captured from ${captured.device.model || device.serial}, ` +
          'served back byte-identical, and reported honestly as a picture',
  );
} finally {
  await call(`/projects/${projectId}?confirmName=${encodeURIComponent(projectName)}`, { method: 'DELETE', token: session });
  rmSync(workspace, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.message);
  process.exit(1);
}
