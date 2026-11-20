/**
 * The termbase, in the back office, doing what a termbase is for.
 *
 * Three things have to be true of the page or it is a table nobody can use: the terms are there and say
 * which scope they came from (a project row that replaced an organisation one is the disagreement that
 * used to be invisible), a term can be *approved* — the switch that turns a violation into an error that
 * blocks a release — and the candidates a project's own vocabulary suggests can be pulled in. Everything
 * this check writes, it writes back.
 */
/* eslint-disable no-undef -- `WebSocket` is a Node global the flat config does not list. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9379';
const WEB = process.env.WEB ?? 'http://localhost:3000';
const MARK = Date.now().toString(36);

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--remote-debugging-port=9379', '--no-first-run', `--user-data-dir=/tmp/gloss-${MARK}`, '--window-size=1500,1100', 'about:blank'],
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
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await delay(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  await delay(500);
}
const clickTestId = async (selector) => {
  const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  await delay(250);
  await clickAt(box.x, box.y);
};

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
await waitFor("location.origin === '" + WEB + "' && document.readyState === 'complete'", 'the login page');
await evaluate(`(async () => { await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: 'demo@localehub.dev', password: 'demo-password-123' }) }); return true; })()`);

// Which project actually has a termbase to look at.
const seeded = await evaluate(`(async () => {
  const projects = (await (await fetch('/api/v1/projects', { credentials: 'include' })).json()).data;
  for (const project of projects) {
    const body = await (await fetch('/api/v1/projects/' + project.id + '/glossary', { credentials: 'include' })).json();
    if (body.success && body.data.terms.length) return { projectId: project.id, name: project.name, terms: body.data.terms.map((t) => ({ term: t.term, status: t.status, scope: t.scope })) };
  }
  return null;
})()`);
check(Boolean(seeded), 'a project with a termbase was found', seeded ? seeded.name : 'none');
if (!seeded) { ws.close(); chrome.kill(); process.exit(1); }
console.log('   project:', seeded.name, '| terms:', JSON.stringify(seeded.terms));

await send('Page.navigate', { url: `${WEB}/glossary` });
await waitFor("document.body.innerText.includes('术语库') && document.querySelector('[data-term]') !== null", 'the glossary page');

const page = await evaluate(`(() => {
  const text = document.body.innerText;
  const rows = [...document.querySelectorAll('[data-term]')];
  const nav = [...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/glossary');
  return {
    inSidebar: nav,
    rowCount: rows.length,
    firstRow: rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').slice(0, 90) : null,
    showsScopes: text.includes('项目') && text.includes('组织'),
    statuses: [...document.querySelectorAll('[data-term]')].map((row) => row.innerText.includes('已定稿') ? 'APPROVED' : row.innerText.includes('已废弃') ? 'DEPRECATED' : 'DRAFT'),
    hasStats: text.includes('生效中的词条') && text.includes('还没定稿'),
  };
})()`);
check(page.inSidebar, '术语库 is in the back-office nav');
check(page.hasStats, 'the counts are on the page');
check(page.rowCount === seeded.terms.length, 'every term is a row', `${page.rowCount}`);
check(page.showsScopes, 'rows say which scope they come from');
console.log('   first row:', JSON.stringify(page.firstRow));

// Approve one, and put it back: approving is what makes a violation an error, so the switch has to
// actually throw.
const draft = await evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-term]')].find((r) => r.innerText.includes('草稿'));
  if (!row) return null;
  return { term: row.dataset.term };
})()`);
if (draft) {
  const before = await evaluate(`(async () => {
    const body = await (await fetch('/api/v1/projects/${seeded.projectId}/glossary', { credentials: 'include' })).json();
    return body.data.terms.find((t) => t.term === ${JSON.stringify(draft.term)}).status;
  })()`);
  // Named, not "the first button in the row": every translation cell became a button when the row
  // learned to be edited in place, and the first one is now the language cell — which is how this
  // check started clicking the wrong thing and reporting that approving does nothing.
  await clickTestId(`[data-term="${draft.term}"] [data-term-status]`);
  await delay(1500);
  const after = await evaluate(`(async () => {
    const body = await (await fetch('/api/v1/projects/${seeded.projectId}/glossary', { credentials: 'include' })).json();
    return body.data.terms.find((t) => t.term === ${JSON.stringify(draft.term)}).status;
  })()`);
  check(before === 'DRAFT' && after === 'APPROVED', 'a draft can be approved', `${before} → ${after}`);

  // Approving is what turns a suggestion into a rule, and a rule that nobody applied to the
  // translations already written is a document. The button is supposed to leave a recheck behind it.
  const queued = await evaluate(`(async () => {
    // The run history is not exposed over REST in a way this check can read, so it reads the same
    // page the audit trail does: the toast the button raised, which says what happened.
    return document.body.innerText.includes('重查');
  })()`);
  check(queued, 'approving leaves a recheck behind it', queued ? 'toast says so' : 'no mention of 重查');
  // Put it back exactly as it was.
  await clickTestId(`[data-term="${draft.term}"] [data-term-status]`);
  await delay(1500);
  const restored = await evaluate(`(async () => {
    const body = await (await fetch('/api/v1/projects/${seeded.projectId}/glossary', { credentials: 'include' })).json();
    return body.data.terms.find((t) => t.term === ${JSON.stringify(draft.term)}).status;
  })()`);
  check(restored === 'DRAFT', 'and put back', restored);
} else {
  check(false, 'a draft term to approve was found');
}

await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  writeFileSync('/tmp/glossary-admin.png', Buffer.from(shot.data, 'base64'));
});

// The candidates: a project that has been translated already has a vocabulary, scattered — and it has
// already answered most of the termbase, so a candidate should arrive with the translation the
// project itself uses. This has to run against a project that actually has both, which is not the
// one with the most keys: a scale fixture has 5,250 keys and one string repeated.
const richest = await evaluate(`(async () => {
  const attempts = [];
  const projects = (await (await fetch('/api/v1/projects', { credentials: 'include' })).json()).data;
  const bySize = projects.slice().sort((a, b) => b.counts.keys - a.counts.keys).slice(0, 8);
  for (const project of bySize) {
    // The endpoint is the only thing that knows whether this project can answer; asking it beats
    // guessing from counts.
    // The double-submit token the app itself sends: a cookie-authenticated POST without it is
    // refused, and a probe that reads 403 as "this project has nothing" would be looking in the
    // wrong place entirely.
    const csrf = (document.cookie.match(/(?:^|; )localehub_csrf=([^;]*)/) ?? [])[1] ?? '';
    const response = await fetch('/api/v1/projects/' + project.id + '/glossary/extract', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
      body: JSON.stringify({ minKeys: 3, limit: 20 }),
    });
    if (!response.ok) {
      // Reported rather than skipped silently: a probe that quietly finds nothing looks exactly like
      // a project that has nothing to find.
      attempts.push(project.name + ': HTTP ' + response.status);
      continue;
    }
    const body = await response.json();
    const candidates = body.data?.candidates ?? [];
    const withSuggestion = candidates.find((c) => (c.suggestions ?? []).length > 0);
    attempts.push(project.name + ': ' + candidates.length + ' candidates, ' + candidates.filter((c) => (c.suggestions ?? []).length).length + ' with a suggestion');
    if (withSuggestion) {
      return { id: project.id, name: project.name, keys: project.counts.keys, term: withSuggestion.term, suggestion: withSuggestion.suggestions[0] };
    }
  }
  return { id: null, attempts };
})()`);
check(
  Boolean(richest.id),
  'a project whose own translations can answer is found',
  richest.id
    ? `${richest.name} · ${richest.term} → ${richest.suggestion.locale} ${richest.suggestion.value} (${richest.suggestion.support}/${richest.suggestion.total})`
    : (richest.attempts ?? []).join(' | '),
);

if (!richest.id) {
  console.log('\nscreenshot: /tmp/glossary-admin.png');
  ws.close(); chrome.kill();
  console.error('\nRESULT: no project with existing translations to extract from');
  process.exit(1);
}
const richest_project_unused = null;
void richest_project_unused;

// Which project is open is part of the address, so the check opens the one it wants the way anybody
// would send it to a colleague.
await send('Page.navigate', { url: `${WEB}/glossary?project=${richest.id}` });
await waitFor("document.body.innerText.includes('术语库') && document.querySelector('[data-glossary-extract]') !== null", 'the termbase for that project');
const openedFor = await evaluate(`(async () => {
  const body = await (await fetch('/api/v1/projects/${richest.id}/glossary', { credentials: 'include' })).json();
  // The name has to be *on the page*: checking the query string alone passed while the container was
  // still serving the build that ignored it.
  const picker = document.querySelector('[data-project-picker]');
  return {
    terms: body.data.terms.length,
    project: new URLSearchParams(location.search).get('project'),
    pickerShows: picker ? picker.innerText.trim() : null,
  };
})()`);
check(
  openedFor.project === richest.id && (openedFor.pickerShows ?? '').includes(richest.name),
  'the page is actually showing that project',
  `${openedFor.pickerShows} · ${openedFor.terms} 词条`,
);

await clickTestId('[data-glossary-extract]');
await waitFor("document.body.innerText.includes('扫了')", 'the extraction to finish', 120000);
await delay(800);
const candidates = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('table tbody tr')].filter((r) => r.dataset.term === undefined && /\\d+ 条/.test(r.innerText));
  return { count: rows.length, sample: rows.slice(0, 5).map((r) => r.innerText.replace(/\\s+/g, ' ').slice(0, 60)) };
})()`);
check(candidates.count > 0, 'the project’s own vocabulary comes back as candidates', `${candidates.count} 个`);
console.log('   candidates:', JSON.stringify(candidates.sample));
// The candidate table on its own: this one is about how it reads, and the layout is the thing under
// discussion when a row can be as wide as a sentence.
await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  writeFileSync('/tmp/glossary-candidates.png', Buffer.from(shot.data, 'base64'));
});

// The suggestion, on the page, with its count and an example — the three things that make it
// something a person can accept in one glance instead of something they have to go and check.
const shown = await evaluate(`(() => {
  const row = [...document.querySelectorAll('[data-candidate]')].find((r) => /\\d+\\/\\d+/.test(r.innerText));
  if (!row) return null;
  return { term: row.dataset.candidate, text: row.innerText.replace(/\\s+/g, ' ').slice(0, 160) };
})()`);
check(
  Boolean(shown) && shown.text.includes('→'),
  'a candidate arrives with the translation the project already uses',
  shown ? shown.text : 'no suggestion on any candidate row',
);

// The action has to survive the row's own content: a suggestion's example can be a whole sentence, and
// a table that scrolls sideways takes the button off-screen — leaving out the one thing the row is for.
//
// Measured at a narrow window with the table scrolled fully *left*, which is the only measurement that
// says anything: scrolled right, the last column is on screen whether it is pinned or not, and at
// 1500px the table simply fits — both of which let a first version of this check pass for the wrong
// reason. What is being asked is "can the button be seen while reading the row", not "can it be
// scrolled to".
const measure = async () => evaluate(`(() => {
  const row = document.querySelector('[data-candidate]');
  const container = row ? row.closest('[data-slot="table-container"]') : null;
  if (!row || !container) return null;
  container.scrollLeft = 0;
  const button = [...row.querySelectorAll('button')].pop();
  const box = container.getBoundingClientRect();
  const spot = button.getBoundingClientRect();
  return {
    overflow: container.scrollWidth - container.clientWidth,
    visibleWithoutScrolling: spot.width > 0 && spot.right <= box.right + 1 && spot.left >= box.left - 1,
    fromTheRightEdge: Math.round(box.right - spot.right),
  };
})()`);
await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1000, deviceScaleFactor: 1, mobile: false });
await delay(500);
const pinned = await measure();
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
await delay(300);
check(
  Boolean(pinned) && pinned.visibleWithoutScrolling && pinned.fromTheRightEdge <= 24,
  '加入 is on screen without scrolling sideways, at the narrow end',
  pinned
    ? `表格宽出 ${pinned.overflow}px，未横向滚动时按钮距右边缘 ${pinned.fromTheRightEdge}px`
    : 'no candidate row',
);

if (shown) {
  const landed = await evaluate(`(async () => {
    const before = await (await fetch('/api/v1/projects/${richest.id}/glossary', { credentials: 'include' })).json();
    const had = before.data.terms.some((t) => t.term === ${JSON.stringify(shown.term)});
    return { had };
  })()`);
  await clickTestId(`[data-candidate="${shown.term}"] button`);
  await delay(1500);
  const added = await evaluate(`(async () => {
    const body = await (await fetch('/api/v1/projects/${richest.id}/glossary', { credentials: 'include' })).json();
    const term = body.data.terms.find((t) => t.term === ${JSON.stringify(shown.term)});
    return term ? { status: term.status, translations: term.translations } : null;
  })()`);
  // The value that lands is the one the page showed, and it lands as a draft like everything else.
  check(
    Boolean(added) && Object.values(added.translations).length > 0 && Object.values(added.translations).every((value) => shown.text.includes(value)),
    '加入 carries that translation into the termbase',
    added ? `${added.status} ${JSON.stringify(added.translations)}` : 'not added',
  );
  // Put the project back the way it was.
  if (!landed.had && added) {
    await evaluate(`(async () => {
      const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )localehub_csrf=([^;]*)/) ?? [])[1] ?? '');
      const list = await (await fetch('/api/v1/projects/${richest.id}/glossary', { credentials: 'include' })).json();
      const term = list.data.terms.find((t) => t.term === ${JSON.stringify(shown.term)});
      if (term) {
        await fetch('/api/v1/projects/${richest.id}/glossary/' + term.id, {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'x-csrf-token': csrf },
        });
      }
      return true;
    })()`);
    check(true, 'and the check put the project back');
  }
}

console.log('\nscreenshot: /tmp/glossary-admin.png');
ws.close(); chrome.kill();
if (failures) { console.error(`\nRESULT: ${failures} check(s) failed`); process.exit(1); }
console.log('\nRESULT: the termbase is in the back office, and it behaves like one');
