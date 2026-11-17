/**
 * The replica, where it matters: in a browser, looking at the page.
 *
 * "素材还是没上传上来" is a claim about what a reader sees, so the only honest check is to render the
 * thing and read the pixels and the layout back: did the page's own stylesheet apply (its brand colour
 * on the button), did the picture actually decode (an inlined SVG has a non-zero natural size), and do
 * the markers land on the elements the markup named — measured by the browser, not stored by the
 * platform. Then the linking: clicking a marker on the page must light the row beside it.
 */
/* eslint-disable no-undef -- `WebSocket` is a Node global here, and the flat config's globals list
   does not include the browser-ish ones Node ships. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CDP = 'http://127.0.0.1:9392';
const WEB = process.env.WEB ?? 'http://localhost:3000';
const MARK = Date.now().toString(36);

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9392', '--no-first-run', `--user-data-dir=/tmp/replica-${MARK}`, '--window-size=1500,1000', 'about:blank'],
  { stdio: 'ignore' },
);
for (let attempt = 0; ; attempt += 1) {
  try { await fetch(`${CDP}/json/version`); break; } catch (error) {
    if (attempt > 60) throw new Error(`chrome never opened its debug port: ${error.message}`);
    await delay(500);
  }
}
const target = await (await fetch(`${CDP}/json/new?${WEB}/login`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  pending.set(callId, { resolve, reject });
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (expression, what, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch (error) { last = error.message; }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last: ${last})` : ''}`);
};
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await delay(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await delay(400);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
await waitFor(`location.origin === '${WEB}' && document.readyState === 'complete'`, 'the login page');

// A page that carries everything: its own stylesheet, an inlined vector picture, a component name, and
// two keys. The second state is a real second page, not a copy.
const brand = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDIgTDIyIDIwIEwyIDIwIFoiIGZpbGw9IiMzMDZlZWUiLz48L3N2Zz4=';
const pageFor = (copy) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body { margin: 0; background: #f6f7f9; font-family: system-ui, sans-serif }
  .policy-card { background: #ffffff; border: 1px solid #dfe3ea; border-radius: 14px; padding: 16px; margin: 12px }
  .policy-card h1 { color: #101828; font-size: 20px; margin: 0 0 8px }
  .brand-mark img { width: 28px; height: 28px }
  .cta { background: #306eee; color: #ffffff; border: 0; border-radius: 10px; padding: 10px 18px }
  .muted { color: #667085; margin: 8px 0 12px }
</style></head><body>
  <div class="policy-card" data-component="policy-card">
    <h1 data-key="policy.title">我的保单</h1>
    <div class="brand-mark"><img src="data:image/svg+xml;base64,${brand}" alt="品牌图标"></div>
    <p class="muted" data-key="policy.summary">${copy}</p>
    <button class="cta" data-key="policy.view">查看详情</button>
  </div>
</body></html>`;

const setup = await evaluate(`(async () => {
  await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: 'demo@localehub.dev', password: 'demo-password-123' }) });
  const csrf = decodeURIComponent(document.cookie.split('; ').find((row) => row.startsWith('localehub_csrf=')).split('=')[1]);
  const post = async (path, body) => (await fetch('/api/v1' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, credentials: 'include', body: JSON.stringify(body) })).json();
  const created = await post('/projects', { name: '复刻检查 ${MARK}', sourceLocale: 'zh-CN', locales: ['en-US'], platforms: ['web'] });
  if (!created.success) return { error: JSON.stringify(created.error).slice(0, 300) };
  const project = created.data;
  const uploaded = await post('/projects/' + project.id + '/mockups', {
    name: '保单列表', platform: 'web', locale: 'zh-CN', replace: true,
    frames: [
      { title: '默认', document: ${JSON.stringify(pageFor('共 3 份保单，最近更新 2 天前'))} },
      { title: '空状态', document: ${JSON.stringify(pageFor('还没有保单，先去添加一份吧'))} },
    ],
  });
  return { project, uploaded: uploaded.success ? { id: uploaded.data.mockupId, kind: uploaded.data.kind, report: uploaded.data.report } : null, error: uploaded.success ? null : JSON.stringify(uploaded.error) };
})()`);
if (setup.error) throw new Error('setup failed: ' + setup.error);
console.log('uploaded kind:', setup.uploaded.kind);
console.log('report:', setup.uploaded.report.stats, setup.uploaded.report.findings.map((finding) => finding.code));

await send('Page.navigate', { url: `${WEB}/projects/${setup.project.id}/translations` });
await waitFor(`location.pathname.includes('/translations') && document.readyState === 'complete'`, 'the navigation');
await waitFor(`document.body.innerText.includes('界面草图')`, 'the editor', 45000);
await evaluate(`(() => { [...document.querySelectorAll('button')].find((node) => node.textContent.includes('界面草图')).click(); return true; })()`);
await waitFor(`document.querySelector('[role=dialog] iframe') !== null`, 'the replica frame', 45000);
await waitFor(`document.querySelector('[role=dialog] [data-marker]') !== null`, 'measured markers', 45000);
await delay(1200);

const inside = await evaluate(`(() => {
  const frame = document.querySelector('[role=dialog] iframe');
  const doc = frame.contentDocument;
  if (!doc) return { reachable: false };
  const button = doc.querySelector('[data-key="policy.view"]');
  const image = doc.querySelector('img');
  const title = doc.querySelector('[data-key="policy.title"]');
  const box = (node) => { const rect = node.getBoundingClientRect(); return { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }; };
  return {
    reachable: true,
    scriptRan: typeof doc.defaultView.tracked !== 'undefined' || Boolean(doc.querySelector('script[data-ran]')),
    // The page's own stylesheet, applied by the browser.
    buttonBackground: doc.defaultView.getComputedStyle(button).backgroundColor,
    cardRadius: doc.defaultView.getComputedStyle(doc.querySelector('.policy-card')).borderRadius,
    // The asset arrived and decoded: an <img> whose data URI failed has naturalWidth 0.
    imageWidth: image.naturalWidth,
    // Where the elements are, measured here — the platform stored no coordinates at all.
    titleBox: box(title),
    buttonBox: box(button),
    pageHeight: doc.documentElement.scrollHeight,
  };
})()`);
console.log('inside the frame:', inside);

const overlay = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-marker-row]')];
  const markers = [...document.querySelectorAll('[data-marker]')];
  return {
    rowIds: rows.map((row) => row.dataset.markerRow),
    markerIds: markers.map((marker) => marker.dataset.marker),
    markerBoxes: markers.map((marker) => { const rect = marker.getBoundingClientRect(); return { w: Math.round(rect.width), h: Math.round(rect.height) }; }),
  };
})()`);
console.log('overlay markers:', overlay.markerIds.length, 'rows:', overlay.rowIds.length, 'identities match:',
  JSON.stringify(overlay.rowIds) === JSON.stringify(overlay.markerIds));

// The measured box has to sit on the element, in the same coordinate system: convert both to fractions
// of the page and compare. The dialog scales the stage, so the overlay's own pixels are the scaled ones.
const agreement = await evaluate(`(() => {
  const frame = document.querySelector('[role=dialog] iframe');
  const doc = frame.contentDocument;
  const target = doc.querySelector('[data-key="policy.view"]');
  const rect = target.getBoundingClientRect();
  const width = doc.documentElement.scrollWidth;
  const height = doc.documentElement.scrollHeight;
  const expected = { x: rect.left / width, y: rect.top / height, w: rect.width / width, h: rect.height / height };
  const identity = [${JSON.stringify('')} + (target.getAttribute('data-namespace') || ''), target.getAttribute('data-key'), '默认'].join(String.fromCharCode(31));
  const marker = document.querySelector('[data-marker="' + CSS.escape(identity) + '"]');
  if (!marker) return { found: false, identity };
  const style = marker.style;
  const actual = { x: parseFloat(style.left) / 100, y: parseFloat(style.top) / 100, w: parseFloat(style.width) / 100, h: parseFloat(style.height) / 100 };
  const close = (a, b) => Math.abs(a - b) < 0.01;
  return { found: true, expected, actual, agree: close(expected.x, actual.x) && close(expected.y, actual.y) && close(expected.w, actual.w) && close(expected.h, actual.h) };
})()`);
console.log('marker on the element:', JSON.stringify(agreement));

// Linking, with a real mouse: the page's marker selects the row beside it.
const markerBox = await evaluate(`(() => {
  const marker = document.querySelector('[data-marker]');
  const rect = marker.getBoundingClientRect();
  return { x: rect.left + Math.min(6, rect.width / 2), y: rect.top + rect.height / 2, identity: marker.dataset.marker };
})()`);
await clickAt(markerBox.x, markerBox.y);
const linked = await evaluate(`[...document.querySelectorAll('[data-marker-row]')].filter((row) => /bg-accent/.test(row.className)).map((row) => row.dataset.markerRow)`);
console.log('clicked marker', JSON.stringify(markerBox.identity), '→ active rows:', JSON.stringify(linked));
console.log('LINKED:', linked.includes(markerBox.identity));

// The second state is a real switch: the frame reloads that page, and its own copy is on screen.
const beforeSwitch = await evaluate(`document.querySelector('[role=dialog] iframe').contentDocument.querySelector('[data-key="policy.summary"]').textContent`);
await evaluate(`(() => { const chip = [...document.querySelectorAll('[role=dialog] button')].find((node) => node.textContent.trim() === '空状态'); chip.click(); return true; })()`);
await delay(1500);
const afterSwitch = await evaluate(`document.querySelector('[role=dialog] iframe').contentDocument.querySelector('[data-key="policy.summary"]').textContent`);
console.log('state switch:', JSON.stringify(beforeSwitch), '→', JSON.stringify(afterSwitch));

console.log('console errors:', consoleErrors.length ? consoleErrors.slice(0, 3) : 'none');

await evaluate(`(async () => {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((row) => row.startsWith('localehub_csrf=')).split('=')[1]);
  await fetch('/api/v1/projects/${setup.project.id}?confirmName=' + encodeURIComponent(${JSON.stringify(setup.project.name)}), { method: 'DELETE', headers: { 'x-csrf-token': csrf }, credentials: 'include' });
})()`);
ws.close();
chrome.kill();
