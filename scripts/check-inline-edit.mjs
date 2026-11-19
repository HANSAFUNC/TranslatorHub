/**
 * Editing in place, verified the way a reader would notice it going wrong.
 *
 * The complaint was the button itself: the reader is looking at the screen, at the string, with the
 * page in front of them — and 「在编辑器中打开」 closed the view and navigated away, losing exactly the
 * context that made them open it. What this checks is the two halves of it being fixed: the row takes
 * an edit and keeps it, and the page does not go anywhere while that happens.
 */
/* eslint-disable no-undef -- `WebSocket` is a Node global the flat config does not list. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9382';
const WEB = process.env.WEB ?? 'http://localhost:3000';
const MARK = Date.now().toString(36);

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9382', '--no-first-run', `--user-data-dir=/tmp/inline-${MARK}`, '--window-size=1500,1000', 'about:blank'],
  { stdio: 'ignore' });
for (let i = 0; ; i += 1) { try { await fetch(`${CDP}/json/version`); break; } catch (e) { if (i > 60) throw e; await delay(500); } }
const target = await (await fetch(`${CDP}/json/new?${WEB}/login`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, what, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if (await evaluate(expression)) return true; } catch { /* retry */ } await delay(250); }
  throw new Error(`timed out waiting for ${what}`);
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
await waitFor("location.origin === '" + WEB + "' && document.readyState === 'complete'", 'the login page');

// ---- arrange, over the API, against the project that is already there ----------
const setup = await evaluate(`(async () => {
  await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: 'demo@localehub.dev', password: 'demo-password-123' }) });
  const csrf = decodeURIComponent(document.cookie.split('; ').find((r) => r.startsWith('localehub_csrf=')).split('=')[1]);
  const call = async (path, init = {}) => (await fetch('/api/v1' + path, { credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...init })).json();
  const projects = await call('/projects');
  const project = projects.data.find((p) => p.name === '高研院iOS');
  if (!project) return { error: 'project not found: ' + projects.data.map((p) => p.name).join(', ') };
  const detail = await call('/projects/' + project.id);
  const locales = (detail.data.locales ?? []).map((l) => l.code);
  const source = detail.data.sourceLocale;
  let found = null;
  for (const locale of locales.filter((c) => c !== source)) {
    const list = await call('/projects/' + project.id + '/translations?locale=' + encodeURIComponent(locale) + '&limit=50');
    const rows = Array.isArray(list.data) ? list.data : (list.data && list.data.items) || [];
    const hit = rows.find((row) => row.value && row.value.trim() && row.key.length < 40);
    if (hit) { found = { locale, key: hit.key, namespace: hit.namespace, entryId: hit.entryId, value: hit.value }; break; }
  }
  if (!found) return { error: 'no translated entry found in ' + locales.join(',') };
  const uploaded = await call('/projects/' + project.id + '/mockups', { method: 'POST', body: JSON.stringify({
    name: 'inline-edit-check-${MARK}', platform: 'ios', locale: source, replace: true,
    document: '<!doctype html><html><head><style>.screen{position:relative;width:390px;height:844px}.row{position:absolute;left:16px;top:120px;width:358px;font-size:17px}</style></head><body><div class="screen"><div class="row" data-component="Row" data-key=' + JSON.stringify(found.key) + '>' + found.value + '</div></div></body></html>',
  }) });
  return { projectId: project.id, projectName: project.name, found, uploaded: uploaded.success ? uploaded.data.mockupId : uploaded.error };
})()`);
if (setup.error || !setup.uploaded) throw new Error('arrange failed: ' + JSON.stringify(setup.error ?? setup.uploaded));
console.log('arranged on project', JSON.stringify(setup.projectName), '| locale', setup.found.locale, '| key', JSON.stringify(setup.found.key));
console.log('original value:', JSON.stringify(setup.found.value.slice(0, 40)));

// ---- open the editor, then the sketch, and edit the row in place --------------
await send('Page.navigate', { url: `${WEB}/projects/${setup.projectId}/translations` });
await waitFor("location.pathname.includes('/translations') && document.readyState === 'complete'", 'the editor');
await waitFor("document.body.innerText.includes('界面草图')", 'the editor toolbar');
await evaluate(`(() => { [...document.querySelectorAll('button')].find((n) => n.textContent.includes('界面草图')).click(); return true; })()`);
await waitFor("document.querySelector('[role=dialog] [data-marker-edit]') !== null", 'an editable row', 60000);
const urlBefore = await evaluate('location.href');

const rowBefore = await evaluate(`(() => {
  const button = document.querySelector('[role=dialog] [data-marker-edit]');
  const row = button.closest('[data-marker-row]');
  return { identity: row.dataset.markerRow, text: row.innerText.replace(/\\s+/g, ' ').slice(0, 120) };
})()`);
console.log('row before:', JSON.stringify(rowBefore.text));

await evaluate(`(() => { document.querySelector('[role=dialog] [data-marker-edit]').click(); return true; })()`);
await waitFor("document.querySelector('[role=dialog] [data-marker-editor]') !== null", 'the editor');
const hadFocus = await evaluate("document.activeElement && document.activeElement.dataset.markerEditor !== undefined");

const NEW = `就地编辑 ${MARK}`;
await evaluate(`(() => {
  const box = document.querySelector('[role=dialog] [data-marker-editor]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(box, ${JSON.stringify(NEW)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await delay(200);
await evaluate(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((n) => n.textContent.trim() === '保存'); b.click(); return true; })()`);
await waitFor(`document.querySelector('[role=dialog] [data-marker-edit]') !== null`, 'the row back in read mode', 30000);
await delay(800);

const after = await evaluate(`(() => {
  const row = document.querySelector('[role=dialog] [data-marker-row="' + CSS.escape(${JSON.stringify(rowBefore.identity)}) + '"]');
  return { url: location.href, text: row ? row.innerText.replace(/\\s+/g, ' ').slice(0, 140) : null };
})()`);
const persisted = await evaluate(`(async () => {
  const r = await fetch('/api/v1/projects/${setup.projectId}/translations/${setup.found.entryId}', { credentials: 'include' });
  const body = await r.json();
  return body.data ? body.data.value : null;
})()`);

console.log('editor took focus in the box:', hadFocus);
console.log('URL after saving     :', after.url === urlBefore ? 'unchanged (no navigation)' : `CHANGED → ${after.url}`);
console.log('row after            :', JSON.stringify((after.text ?? '').slice(0, 120)));
console.log('value on the platform:', JSON.stringify(String(persisted).slice(0, 40)));
console.log('SAVED IN PLACE       :', persisted === NEW && after.url === urlBefore);

await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  writeFileSync('/tmp/inline-edit.png', Buffer.from(shot.data, 'base64'));
});

// ---- put it back exactly as it was, and take the probe screen away -----------
const cleanup = await evaluate(`(async () => {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((r) => r.startsWith('localehub_csrf=')).split('=')[1]);
  const call = async (path, init = {}) => (await fetch('/api/v1' + path, { credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...init })).json();
  const restored = await call('/projects/${setup.projectId}/translations/${setup.found.entryId}/draft', { method: 'POST', body: JSON.stringify({ value: ${JSON.stringify(setup.found.value)} }) });
  const list = await call('/projects/${setup.projectId}/mockups');
  const mine = list.data.filter((m) => m.name.startsWith('inline-edit-check'));
  for (const m of mine) await call('/projects/${setup.projectId}/mockups/' + m.id, { method: 'DELETE' });
  return { restored: restored.success, removed: mine.length };
})()`);
console.log('cleanup: value restored =', cleanup.restored, '| probe screens removed =', cleanup.removed);
console.log('screenshot: /tmp/inline-edit.png');

ws.close(); chrome.kill();
