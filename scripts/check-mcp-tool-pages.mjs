/**
 * Every tool, openable.
 *
 * The MCP page listed the tools and stopped there: a name, a paragraph, and a comma-separated list of
 * parameter names. "So what do I actually send it" — the question a caller has next — was answerable
 * only from an MCP client, by reading a JSON schema. This checks the two halves of that being fixed:
 * the row is a way in (and a real link, so it can be copied and opened in a new tab), and the page it
 * leads to is the contract — every parameter, which are required, and what each one means.
 */
/* eslint-disable no-undef -- `WebSocket` is a Node global the flat config does not list. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9381';
const WEB = process.env.WEB ?? 'http://localhost:3000';
const MARK = Date.now().toString(36);

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9381', '--no-first-run', `--user-data-dir=/tmp/tool-${MARK}`, '--window-size=1500,1100', 'about:blank'],
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

async function clickAt(x, y) {
  // Radix switches tabs on the real pointer events, not on a synthetic `.click()`, so the check drives
  // the mouse the way a reader does.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await delay(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await delay(500);
}

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
await waitFor("location.origin === '" + WEB + "' && document.readyState === 'complete'", 'the login page');
await evaluate(`(async () => {
  await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: 'demo@localehub.dev', password: 'demo-password-123' }) });
  return true;
})()`);

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await send('Page.navigate', { url: `${WEB}/mcp` });
await waitFor("document.body.innerText.includes('MCP 管理')", 'the MCP page');
// The tools live under their own tab (the page opens on the guide), so a reader gets there by clicking
// it — and so does this check, rather than reaching into a table Radix has not mounted yet.
const tabBox = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('[role=tab]')].find((n) => n.textContent.includes('Remote MCP'));
  if (!tab) return null;
  const r = tab.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
if (!tabBox) throw new Error('the tools tab is not on the page');
await clickAt(tabBox.x, tabBox.y);
await waitFor("document.querySelector('[data-mcp-tool]') !== null", 'the tool table');

const list = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[data-mcp-tool]')];
  const first = rows[0];
  const anchor = first.querySelector('a');
  return {
    count: rows.length,
    names: rows.map((row) => row.dataset.mcpTool),
    firstAnchorHref: anchor ? anchor.getAttribute('href') : null,
  };
})()`);
check(list.count >= 10, 'every tool is a row', `${list.count}`);
check(list.firstAnchorHref && list.firstAnchorHref.startsWith('/mcp/'), 'the name is a real link, not just a click handler', String(list.firstAnchorHref));

// Click the row a caller is most likely to want, and see where it lands.
const wanted = 'upload_screen_mockup';
check(list.names.includes(wanted), 'the screen-upload tool is listed', wanted);
const rowBox = await evaluate(`(() => {
  const row = document.querySelector('[data-mcp-tool="${wanted}"]');
  // Scroll it into the middle first: a rect read off-screen is a click at coordinates nothing occupies.
  row.scrollIntoView({ block: 'center' });
  const r = row.getBoundingClientRect();
  return { x: r.left + r.width - 60, y: r.top + r.height / 2 };
})()`);
await delay(300);
await clickAt(rowBox.x, rowBox.y);
await waitFor(`location.pathname === '/mcp/${wanted}'`, 'the tool page');
await waitFor("document.body.innerText.includes('原始 schema')", 'the schema card');

const page = await evaluate(`(() => {
  const text = document.body.innerText;
  const paramRows = [...document.querySelectorAll('table tbody tr')].map((row) => row.innerText.replace(/\\s+/g, ' '));
  return {
    url: location.pathname,
    showsName: text.includes('${wanted}'),
    hasParamTable: paramRows.length,
    requiredBadges: [...document.querySelectorAll('span,div')].filter((n) => n.textContent.trim() === '必填').length,
    namesFields: ['project_id', 'name', 'document', 'expect_no_images'].filter((field) => text.includes(field)),
    mentionsFrames: text.includes('frames'),
    backLink: Boolean([...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/mcp')),
  };
})()`);
check(page.showsName, 'the page names the tool');
check(page.hasParamTable >= 8, 'every parameter is a row of its own', `${page.hasParamTable} 行`);
check(page.requiredBadges >= 2, 'required parameters are marked', `${page.requiredBadges} 个必填`);
check(page.namesFields.length === 4, 'the field names a caller types are on the page', page.namesFields.join(', '));
check(page.backLink, 'there is a way back to the list');

await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  writeFileSync('/tmp/mcp-tool-page.png', Buffer.from(shot.data, 'base64'));
});

// A name nobody registered says so instead of rendering an empty page.
await send('Page.navigate', { url: `${WEB}/mcp/not_a_real_tool` });
await waitFor("document.body.innerText.includes('没有这个工具') || document.body.innerText.includes('没有注册')", 'the not-found state');
const notFound = await evaluate(`document.body.innerText.includes('没有') && document.body.innerText.includes('MCP 管理')`);
check(notFound, 'an unknown tool says so and points back');

console.log('\nscreenshot: /tmp/mcp-tool-page.png');
ws.close(); chrome.kill();
if (failures) { console.error(`\nRESULT: ${failures} check(s) failed`); process.exit(1); }
console.log('\nRESULT: every tool opens, and says what to send it');
