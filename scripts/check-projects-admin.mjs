/**
 * The project list, as an operator uses it: newest at the top, and a project you can delete from the
 * row you are looking at.
 *
 * Both halves are checked against the page rather than the API, because both are things the API
 * cannot be wrong about on its own: the page could render yesterday's order, and a delete button
 * could be attached to the wrong row — the row's own id is what the dialog is opened with, and
 * deleting the neighbour would be the worst possible bug here.
 *
 * The two probe projects this creates are deleted again: one through the UI (that is the test), one
 * over the API (cleanup).
 */
/* eslint-disable no-undef -- `WebSocket` is a Node global the flat config does not list. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9383';
const WEB = process.env.WEB ?? 'http://localhost:3000';
const MARK = Date.now().toString(36);
const OLDER = `列表探针旧 ${MARK}`;
const NEWER = `列表探针新 ${MARK}`;

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9383', '--no-first-run', `--user-data-dir=/tmp/projects-${MARK}`, '--window-size=1500,1100', 'about:blank'],
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
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
await waitFor("location.origin === '" + WEB + "' && document.readyState === 'complete'", 'the login page');

// ---- arrange, over the API, from the page's own session -----------------------
const arrange = await evaluate(`(async () => {
  const login = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: 'demo@localehub.dev', password: 'demo-password-123' }) });
  if (!login.ok) return { error: 'login failed: ' + login.status };
  const csrf = decodeURIComponent(document.cookie.split('; ').find((r) => r.startsWith('localehub_csrf=')).split('=')[1]);
  const call = async (path, init = {}) => (await fetch('/api/v1' + path, { credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...init })).json();
  const create = async (name, slug) => {
    const made = await call('/projects', { method: 'POST', body: JSON.stringify({ name, slug, sourceLocale: 'en-US' }) });
    if (!made.success) throw new Error('create failed: ' + JSON.stringify(made.error));
    return { id: made.data.id, name: made.data.name };
  };
  // Explicit slugs: the two probe names differ only by a Chinese character, and slugify drops
  // non-ASCII — so the derived slugs would collide and the second create would be refused.
  const older = await create(${JSON.stringify(OLDER)}, 'list-probe-older-${MARK}');
  // A distinct creation timestamp, so "newest first" is a fact and not a tie.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const newer = await create(${JSON.stringify(NEWER)}, 'list-probe-newer-${MARK}');
  return { older, newer };
})()`);
if (arrange.error) throw new Error(arrange.error);
console.log('arranged:', arrange.older.name, '(older) then', arrange.newer.name, '(newer)');

// ---- the list renders the API's order, newest first ---------------------------
await send('Page.navigate', { url: `${WEB}/projects` });
await waitFor(`document.body.innerText.includes(${JSON.stringify(NEWER)})`, 'the new project in the table');
await waitFor("document.querySelectorAll('table tbody tr').length >= 2", 'the table rows');

const list = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const rendered = rows.map((row) => ({
    name: row.querySelector('td a') ? row.querySelector('td a').textContent.trim() : row.innerText.trim(),
    cells: [...row.querySelectorAll('td')].map((cell) => cell.innerText.trim()),
    deleteId: row.querySelector('[data-delete]') ? row.querySelector('[data-delete]').dataset.delete : null,
  }));
  const headers = [...document.querySelectorAll('table thead th')].map((th) => th.innerText.trim());
  const api = await (await fetch('/api/v1/projects', { credentials: 'include' })).json();
  return { rendered, headers, apiOrder: api.data.map((p) => p.name), total: api.data.length, newestName: api.data[0].name };
})()`);

const renderedNames = list.rendered.map((row) => row.name);
const olderIndex = renderedNames.indexOf(OLDER);
const newerIndex = renderedNames.indexOf(NEWER);
console.log('headers        :', list.headers.join(' | '));
console.log('newest 5 rows  :', renderedNames.slice(0, 5).join(' , '));
console.log('API order same :', JSON.stringify(renderedNames) === JSON.stringify(list.apiOrder.slice(0, renderedNames.length)));
console.log(`${NEWER} at ${newerIndex}, ${OLDER} at ${olderIndex} → newest first:`, newerIndex >= 0 && newerIndex < olderIndex);

const newerRow = list.rendered[newerIndex] ?? {};
console.log('its 创建时间 cell:', JSON.stringify(newerRow.cells?.[2]));
console.log('delete buttons on every row:', list.rendered.every((row) => row.deleteId !== null), `(${list.rendered.length} rows)`);

// ---- the round button on the row opens a dialog about *that* row --------------
await evaluate(`(() => { document.querySelector('[data-delete="${arrange.newer.id}"]').click(); return true; })()`);
await waitFor("document.querySelector('[data-slot=alert-dialog-content]') !== null", 'the delete dialog');
const dialog = await evaluate(`(() => {
  const box = document.querySelector('[data-slot=alert-dialog-content]');
  return { title: box.querySelector('[data-slot=alert-dialog-title]').innerText, hasInput: box.querySelector('#delete-project-confirm') !== null, confirmDisabled: box.querySelector('[data-delete-confirm]').disabled };
})()`);
console.log('dialog title   :', JSON.stringify(dialog.title));
console.log('names the row, asks for the name, starts locked:', dialog.title.includes(NEWER) && dialog.hasInput && dialog.confirmDisabled);

const gate = await evaluate(`(() => {
  const box = document.querySelector('[data-slot=alert-dialog-content]');
  const input = box.querySelector('#delete-project-confirm');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const type = (value) => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
  type('不匹配的名字');
  const wrong = box.querySelector('[data-delete-confirm]').disabled;
  type(${JSON.stringify(NEWER)});
  return { wrong, right: box.querySelector('[data-delete-confirm]').disabled };
})()`);
console.log('wrong name keeps it disabled:', gate.wrong, '| exact name enables it:', gate.right === false);
await delay(200);

await evaluate(`(() => { document.querySelector('[data-delete-confirm]').click(); return true; })()`);
await waitFor(`document.querySelector('[data-delete="${arrange.newer.id}"]') === null`, 'the row to disappear', 60000);
await delay(600);

const after = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll('table tbody tr')].map((row) => row.querySelector('td a') ? row.querySelector('td a').textContent.trim() : '');
  const gone = await fetch('/api/v1/projects/${arrange.newer.id}', { credentials: 'include' });
  const survivor = await fetch('/api/v1/projects/${arrange.older.id}', { credentials: 'include' });
  return {
    stillListed: rows.includes(${JSON.stringify(NEWER)}),
    neighbourStillListed: rows.includes(${JSON.stringify(OLDER)}),
    goneStatus: gone.status,
    survivorStatus: survivor.status,
    toast: document.body.innerText.includes('已删除'),
  };
})()`);
console.log('row gone from the table   :', !after.stillListed, '| the neighbouring row survives:', after.neighbourStillListed);
console.log('deleted project now       :', after.goneStatus, '(404 = gone) | the other one:', after.survivorStatus);
console.log('toast said so             :', after.toast);

await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  writeFileSync('/tmp/projects-list.png', Buffer.from(shot.data, 'base64'));
});
console.log('screenshot: /tmp/projects-list.png');

// ---- and the project's own page still offers the same action ------------------
// The permission rule moved to `@/lib/project-access` so both pages share it; this is the other page,
// and a refactor that quietly disabled its button would otherwise only show up on a real deletion.
await send('Page.navigate', { url: `${WEB}/projects/${arrange.older.id}` });
await waitFor("document.body.innerText.includes('删除项目')", 'the project page');
const detailButton = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '删除项目');
  return button ? { found: true, disabled: button.disabled } : { found: false };
})()`);
console.log('settings page still offers it, enabled:', detailButton.found && detailButton.disabled === false);

// ---- cleanup: the other probe goes back the way it came -----------------------
const cleanup = await evaluate(`(async () => {
  const csrf = decodeURIComponent(document.cookie.split('; ').find((r) => r.startsWith('localehub_csrf=')).split('=')[1]);
  const call = async (path, init = {}) => (await fetch('/api/v1' + path, { credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...init })).json();
  const removed = await call('/projects/${arrange.older.id}?confirmName=' + encodeURIComponent(${JSON.stringify(OLDER)}), { method: 'DELETE' });
  return { ok: removed.success === true };
})()`);
console.log('cleanup: the older probe deleted =', cleanup.ok);

const pass = detailButton.found && detailButton.disabled === false
  && newerIndex >= 0 && newerIndex < olderIndex
  && dialog.title.includes(NEWER) && dialog.confirmDisabled
  && gate.wrong && gate.right === false
  && !after.stillListed && after.neighbourStillListed
  && after.goneStatus === 404 && after.survivorStatus === 200;
console.log('RESULT:', pass ? 'newest first, and the row that was deleted is the row the button was on' : 'FAILED');

ws.close(); chrome.kill();
if (!pass) process.exit(1);
