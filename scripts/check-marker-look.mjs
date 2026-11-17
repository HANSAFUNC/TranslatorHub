/**
 * The annotation, as a reader sees it: red outlines that hide nothing, numbers outside them.
 *
 * Two complaints are checked here, both about the picture rather than the model. The outline used to be
 * a filled box with the number *inside* it, so the annotation covered the text it annotated and two
 * nearby markers piled their numbers on top of each other. What a good annotation has to satisfy is
 * measurable: the box paints nothing over the screen, it is drawn in red, its number sits outside it,
 * and no two numbers overlap.
 */
/* eslint-disable no-undef -- `WebSocket` is a Node global; the flat config's globals list does not
   include the browser-ish ones Node ships. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const CDP = 'http://127.0.0.1:9393';
const WEB = process.env.WEB ?? 'http://localhost:3000';
const MARK = Date.now().toString(36);

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9393', '--no-first-run', `--user-data-dir=/tmp/marker-look-${MARK}`, '--window-size=1500,1000', 'about:blank'],
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
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
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
const waitFor = async (expression, what, timeoutMs = 40000) => {
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

// A page with markers packed close together — a title, a row of three chips, a caption and a button,
// plus a second state — which is exactly the case where numbers used to land on one another.
const html = `<!doctype html><html><head><style>
  body{margin:0;background:#f6f7f9;font-family:system-ui,sans-serif}
  .card{background:#fff;border-radius:14px;padding:14px;margin:10px}
  h1{font-size:18px;margin:0 0 6px}
  .chips{display:flex;gap:4px;margin:6px 0}
  .chip{background:#eef1f6;border-radius:8px;padding:4px 6px;font-size:12px}
  .muted{color:#667085;font-size:12px;margin:2px 0}
  button{background:#306eee;color:#fff;border:0;border-radius:9px;padding:8px 14px}
</style></head><body>
  <div class="card">
    <h1 data-key="policy.title">我的保单</h1>
    <div class="chips">
      <span class="chip" data-key="policy.chip.active">生效中</span>
      <span class="chip" data-key="policy.chip.pending">待生效</span>
      <span class="chip" data-key="policy.chip.expired">已过期</span>
    </div>
    <p class="muted" data-key="policy.summary">共 3 份保单，最近更新 2 天前</p>
    <button data-key="policy.view">查看详情</button>
  </div>
</body></html>`;

const setup = await evaluate(`(async () => {
  await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: 'demo@localehub.dev', password: 'demo-password-123' }) });
  const csrf = decodeURIComponent(document.cookie.split('; ').find((row) => row.startsWith('localehub_csrf=')).split('=')[1]);
  const post = async (path, body) => (await fetch('/api/v1' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, credentials: 'include', body: JSON.stringify(body) })).json();
  const created = await post('/projects', { name: '标注外观检查 ${MARK}', sourceLocale: 'zh-CN', locales: ['en-US'], platforms: ['web'] });
  if (!created.success) return { error: JSON.stringify(created.error).slice(0, 300) };
  const project = created.data;
  const uploaded = await post('/projects/' + project.id + '/mockups', {
    name: '保单列表', platform: 'web', locale: 'zh-CN', replace: true,
    document: ${JSON.stringify(html)},
  });
  return { project, ok: uploaded.success, error: uploaded.success ? null : JSON.stringify(uploaded.error) };
})()`);
if (setup.error || !setup.ok) throw new Error('setup failed: ' + (setup.error ?? setup.error));

await send('Page.navigate', { url: `${WEB}/projects/${setup.project.id}/translations` });
await waitFor(`location.pathname.includes('/translations') && document.readyState === 'complete'`, 'the navigation');
await waitFor(`document.body.innerText.includes('界面草图')`, 'the editor', 45000);
await evaluate(`(() => { [...document.querySelectorAll('button')].find((node) => node.textContent.includes('界面草图')).click(); return true; })()`);
await waitFor(`document.querySelector('[role=dialog] [data-badge]') !== null`, 'the badges', 45000);
await delay(1200);

const LOOK_EXPRESSION = `(() => {
  const dialog = document.querySelector('[role=dialog]');
  const rectOf = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const boxes = [...dialog.querySelectorAll('[data-marker]')].map((node) => ({ identity: node.dataset.marker, ...rectOf(node), style: getComputedStyle(node) }));
  const badges = [...dialog.querySelectorAll('[data-badge]')].map((node) => ({ identity: node.dataset.badge, index: node.textContent.trim(), ...rectOf(node), style: getComputedStyle(node) }));
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const gap = (badge, box) => ({
    below: Math.round((box.top - badge.bottom) * 10) / 10,
    above: Math.round((badge.top - box.bottom) * 10) / 10,
    right: Math.round((box.left - badge.right) * 10) / 10,
    left: Math.round((badge.left - box.right) * 10) / 10,
  });
  const badgeOnBox = [];
  const closest = [];
  for (const badge of badges) {
    for (const box of boxes) {
      if (badge.identity !== box.identity) continue;
      if (overlaps(badge, box)) badgeOnBox.push(badge.index);
      const g = gap(badge, box);
      closest.push({ n: badge.index, ...g, separated: Math.max(g.below, g.above, g.right, g.left) });
    }
  }
  const badgeOnBadge = [];
  for (let i = 0; i < badges.length; i += 1) for (let j = i + 1; j < badges.length; j += 1) if (overlaps(badges[i], badges[j])) badgeOnBadge.push(badges[i].index + '×' + badges[j].index);
  return {
    boxes: boxes.map((box) => ({ border: box.style.borderTopColor, width: box.style.borderTopWidth, background: box.style.backgroundColor, radius: box.style.borderTopLeftRadius, w: Math.round(box.width), h: Math.round(box.height) })),
    badges: badges.map((badge) => ({ n: badge.index, background: badge.style.backgroundColor, radius: badge.style.borderTopLeftRadius, w: Math.round(badge.width), h: Math.round(badge.height) })),
    badgeOnBox,
    badgeOnBadge,
    closest,
  };
})()`;
const look = await evaluate(LOOK_EXPRESSION);
const unique = (values) => [...new Set(values)];
console.log('boxes:', look.boxes.length, 'badges:', look.badges.length);
console.log('outline colour:', unique(look.boxes.map((box) => box.border)).join(' / '), '| width:', unique(look.boxes.map((box) => box.width)).join(' / '));
console.log('outline fill:', unique(look.boxes.map((box) => box.background)).join(' / '), '(transparent = nothing painted over the screen)');
console.log('badge size:', unique(look.badges.map((badge) => `${badge.w}×${badge.h}`)).join(' / '), '| colours:', unique(look.badges.map((badge) => badge.background)).join(' / '));
console.log('numbers covering their own box:', look.badgeOnBox.length ? look.badgeOnBox : 'none');
console.log('gap between each number and its outline (px):', JSON.stringify(look.closest.map((entry) => entry.n + ':' + entry.separated + 'px')));
console.log('numbers covering each other:', look.badgeOnBadge.length ? look.badgeOnBadge : 'none');

// Clicking the number selects the same entry the box would.
const badgeBox = await evaluate(`(() => { const node = document.querySelector('[data-badge]'); const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, identity: node.dataset.badge }; })()`);
await clickAt(badgeBox.x, badgeBox.y);
const active = await evaluate(`[...document.querySelectorAll('[data-marker-row]')].filter((row) => /bg-accent/.test(row.className)).map((row) => row.dataset.markerRow)`);
console.log('clicking the number selects its row:', active.includes(badgeBox.identity));

// And the outline is an outline: the pixels under it are the page's, not the annotation's.
const pixel = await evaluate(`(() => {
  const frame = document.querySelector('[role=dialog] iframe');
  const doc = frame.contentDocument;
  const chip = doc.querySelector('[data-key="policy.chip.active"]');
  return { chipBackground: doc.defaultView.getComputedStyle(chip).backgroundColor };
})()`);
console.log('the marked control still has its own look:', pixel.chipBackground);

await send('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/marker-look.png', Buffer.from(shot.data, 'base64'));
  console.log('screenshot: /tmp/marker-look.png');
});

// The other kind of screen, with the same two complaints to answer: a fragment the platform draws as an
// SVG, whose boxes come from the drawing rather than from a browser's measurement. Same project, one
// screen at a time — a second project would collide on the slug the platform derives from a name that
// is entirely Chinese.
console.log('\n— the same checks on a sketch the platform drew —');
await evaluate(`(async () => {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((row) => row.startsWith('localehub_csrf=')).split('=')[1]);
  const send = async (method, path, body) => (await fetch('/api/v1' + path, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, credentials: 'include', body: body ? JSON.stringify(body) : undefined })).json();
  const list = await (await fetch('/api/v1/projects/${setup.project.id}/mockups', { credentials: 'include' })).json();
  for (const mockup of list.data) await send('DELETE', '/projects/${setup.project.id}/mockups/' + mockup.id);
  const uploaded = await send('POST', '/projects/${setup.project.id}/mockups', {
    name: '练习页', platform: 'ios', locale: 'zh-CN', replace: true,
    html: '<style>.card{background:#ffffff;border-radius:12px;padding:14px}</style><div class="card"><h1 data-key="exam.title">练习</h1><p data-key="exam.hint">先看题，再作答</p><button data-key="exam.next">下一步</button></div>',
  });
  return uploaded.success;
})()`);
await send('Page.navigate', { url: `${WEB}/projects/${setup.project.id}/translations` });
await waitFor(`location.pathname.includes('/translations') && document.readyState === 'complete'`, 'the navigation');
await waitFor(`document.body.innerText.includes('界面草图')`, 'the editor', 45000);
await evaluate(`(() => { [...document.querySelectorAll('button')].find((node) => node.textContent.includes('界面草图')).click(); return true; })()`);
await waitFor(`document.querySelector('[role=dialog] [data-badge]') !== null`, 'the badges', 45000);
await delay(1200);
const drawnLook = await evaluate(LOOK_EXPRESSION);
console.log('drawn: numbers covering their own box:', drawnLook.badgeOnBox.length ? drawnLook.badgeOnBox : 'none');
console.log('drawn: numbers covering each other:', drawnLook.badgeOnBadge.length ? drawnLook.badgeOnBadge : 'none');
console.log('drawn: outline colour:', unique(drawnLook.boxes.map((box) => box.border)).join(' / '), '| fill:', unique(drawnLook.boxes.map((box) => box.background)).join(' / '));
console.log('drawn: gap between each number and its outline:', JSON.stringify(drawnLook.closest.map((entry) => entry.n + ':' + entry.separated + 'px')));
console.log('drawn: badge size:', unique(drawnLook.badges.map((badge) => `${badge.w}×${badge.h}`)).join(' / '));

await evaluate(`(async () => {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((row) => row.startsWith('localehub_csrf=')).split('=')[1]);
  await fetch('/api/v1/projects/${setup.project.id}?confirmName=' + encodeURIComponent(${JSON.stringify(setup.project.name)}), { method: 'DELETE', headers: { 'x-csrf-token': csrf }, credentials: 'include' });
})()`);
ws.close();
chrome.kill();
