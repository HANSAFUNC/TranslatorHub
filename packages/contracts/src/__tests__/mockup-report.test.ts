import { describe, expect, it } from 'vitest';

import { FINDING_CODES, analyzeDocument, analyzeSketch } from '../mockup-report';
import { documentAssets, documentMarkers, isFullDocument, normalizeDocument } from '../mockup-document';
import { REMOTE_MCP_SKETCH_GUIDE, remoteSketchPrompt } from '../mcp-guide';

/**
 * The guidance a sketch comes back with.
 *
 * Everything here is a failure that used to be silent: the upload succeeds, the picture looks like a
 * wireframe, and nobody learns that the images were referenced rather than carried, that the page's
 * colours live in a stylesheet that never arrived, or that four "states" are copies. The report reads
 * the finished picture, so it works on what is already on the platform.
 */
const page = (extra: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="600"><rect fill="#ffffff" width="390" height="600"/>${extra}</svg>`;

describe('what the report notices', () => {
  it('says a sketch has no pictures, and how to get them in', () => {
    const report = analyzeSketch({
      svg: page('<path d="M 1 2" fill="#a1a1aa" opacity="0.55"/>'),
      markers: [{ key: 'home.title', text: '我的' }],
      legend: [{ name: 'card' }],
    });
    const finding = report.findings.find((entry) => entry.code === 'PLACEHOLDER_PICTURES')!;
    expect(finding.title).toContain('占位');
    expect(finding.advice).toContain('data:');
    expect(report.stats.placeholders).toBe(1);
  });

  it('stays quiet about pictures when there are some', () => {
    const report = analyzeSketch({
      svg: page('<image href="data:image/png;base64,AA" width="20" height="20"/><svg x="8" y="8" viewBox="0 0 24 24"><path d="M0 0"/></svg>'),
      markers: [{ key: 'home.title', text: '我的' }],
      legend: [{ name: 'card' }],
    });
    expect(report.stats.pictures).toBe(2);
    expect(report.findings.map((entry) => entry.code)).not.toContain('NO_PICTURES');
  });

  it('says the colours all came from the platform when the page contributed none', () => {
    const report = analyzeSketch({
      svg: page('<image href="data:image/png;base64,AA" width="20" height="20"/><text fill="#3f3f46">我的</text>'),
      markers: [{ key: 'home.title', text: '我的' }],
      legend: [{ name: 'card' }],
    });
    const finding = report.findings.find((entry) => entry.code === 'NO_SOURCE_COLOURS')!;
    expect(finding.advice).toContain('css');
    expect(finding.advice).toContain('theme');
    expect(report.stats.sourceColours).toBe(0);
  });

  it('counts the page’s own colours, and says nothing when there are any', () => {
    const report = analyzeSketch({
      svg: page('<image href="data:image/png;base64,AA" width="20" height="20"/><rect fill="#306eee" width="10" height="10"/><text fill="#f5f7fc">我的</text>'),
      markers: [{ key: 'home.title', text: '我的' }],
      legend: [{ name: 'card' }],
    });
    expect(report.stats.sourceColours).toBe(2);
    expect(report.findings.map((entry) => entry.code)).not.toContain('NO_SOURCE_COLOURS');
  });

  it('says when several states are copies of each other', () => {
    const markers = ['默认', '空状态', '加载中'].flatMap((frame) =>
      ['home.title', 'home.empty'].map((key) => ({ key, frame, text: key, namespace: '' })),
    );
    const report = analyzeSketch({ svg: page('<image href="data:image/png;base64,AA" width="20" height="20"/><rect fill="#306eee"/>'), markers, legend: [{ name: 'card' }] });
    const finding = report.findings.find((entry) => entry.code === 'IDENTICAL_FRAMES')!;
    expect(finding.count).toBe(3);
    expect(report.stats.frames).toBe(3);
  });

  it('does not confuse three states that differ for copies', () => {
    const markers = [
      { key: 'home.title', frame: '默认', text: '我的', namespace: '' },
      { key: 'home.empty', frame: '空状态', text: '还没有保单', namespace: '' },
      { key: 'home.loading', frame: '加载中', text: '正在加载…', namespace: '' },
    ];
    const report = analyzeSketch({ svg: page('<image href="data:image/png;base64,AA"/><rect fill="#306eee"/>'), markers, legend: [{ name: 'card' }] });
    expect(report.findings.map((entry) => entry.code)).not.toContain('IDENTICAL_FRAMES');
  });

  it('reports markers that point at keys the platform does not have', () => {
    const report = analyzeSketch({
      svg: page('<image href="data:image/png;base64,AA"/><rect fill="#306eee"/>'),
      markers: [{ key: 'home.title', text: '我的', missing: true }],
      legend: [{ name: 'card' }],
    });
    const finding = report.findings.find((entry) => entry.code === 'MISSING_KEYS')!;
    expect(finding.advice).toContain('data-key');
  });

  it('is clean when there is nothing to say', () => {
    const report = analyzeSketch({
      svg: page('<image href="data:image/png;base64,AA"/><rect fill="#306eee"/>'),
      markers: [{ key: 'home.title', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
    });
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

/**
 * A finding is only worth having if the caller can act on it, and the caller only has the guide.
 *
 * Both directions are mistakes with the same cost: a code the report emits but the guide never
 * explains is a message that ends the conversation, and a code the guide explains but nothing emits
 * is a rule an agent follows for nothing. So the scenarios below have to cover the list exactly.
 */
describe('every finding is reachable and explained', () => {
  /**
   * One scenario per code, so the emitted set can be compared against the list.
   *
   * A scenario is for whichever reader the code belongs to: `svg` goes to `analyzeSketch`, `document`
   * to `analyzeDocument`.
   */
  const scenarios: Record<
    string,
    Parameters<typeof analyzeSketch>[0] & { document?: Parameters<typeof analyzeDocument>[0]['document'] }
  > = {
    NO_PICTURES: { svg: page('<text fill="#306eee">我的</text>'), markers: [{ key: 'home.title', text: '我的', component: 'card' }], legend: [{ name: 'card' }] },
    PLACEHOLDER_PICTURES: { svg: page('<path fill="#a1a1aa" opacity="0.55"/><rect fill="#306eee"/>'), markers: [{ key: 'home.title', text: '我的', component: 'card' }], legend: [{ name: 'card' }] },
    NO_SOURCE_COLOURS: { svg: page('<image href="data:image/png;base64,AA"/>'), markers: [{ key: 'home.title', text: '我的', component: 'card' }], legend: [{ name: 'card' }] },
    IDENTICAL_FRAMES: {
      svg: page('<image href="data:image/png;base64,AA"/><rect fill="#306eee"/>'),
      markers: ['默认', '空状态'].flatMap((frame) => [{ key: 'home.title', frame, text: '我的' }]),
      legend: [{ name: 'card' }],
    },
    MISSING_KEYS: {
      svg: page('<image href="data:image/png;base64,AA"/><rect fill="#306eee"/>'),
      markers: [{ key: 'home.title', text: '我的', component: 'card', missing: true }],
      legend: [{ name: 'card' }],
    },
    NO_COMPONENTS: {
      svg: page('<image href="data:image/png;base64,AA"/><rect fill="#306eee"/>'),
      markers: [{ key: 'home.title', text: '我的', component: 'card' }],
      legend: [],
    },
    // The replica path: the page is stored as sent, so the failures are the page's own omissions.
    NO_KEYS: {
      svg: '',
      document: { frames: [{ title: '默认', html: '<html><body><p>没有 key</p></body></html>' }] },
      markers: [],
      legend: [{ name: 'card' }],
    },
    ASSETS_NOT_INLINED: {
      svg: '',
      document: { frames: [{ title: '默认', html: '<html><body><img src="./logo.png" data-key="a"/></body></html>' }] },
      markers: [{ key: 'a', text: 'x', component: 'card' }],
      legend: [{ name: 'card' }],
    },
    REMOTE_ASSETS: {
      svg: '',
      document: {
        frames: [{ title: '默认', html: '<html><body><img src="https://cdn.example.com/a.png" data-key="a"/></body></html>' }],
      },
      markers: [{ key: 'a', text: 'x', component: 'card' }],
      legend: [{ name: 'card' }],
    },
    SCRIPTS_NOT_RUN: {
      svg: '',
      document: {
        frames: [{ title: '默认', html: '<html><body><span data-key="a">共 3 份</span><script>load()</script></body></html>' }],
      },
      markers: [{ key: 'a', text: '共 3 份', component: 'card' }],
      legend: [{ name: 'card' }],
    },
    NO_STYLE: {
      svg: '',
      document: { frames: [{ title: '默认', html: '<html><body><span data-key="a">我的</span></body></html>' }] },
      markers: [{ key: 'a', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
    },
  };

  /** Whichever reader the scenario is for: a picture goes to one, a page to the other. */
  function reportFor(scenario: (typeof scenarios)[string]) {
    return scenario.document
      ? analyzeDocument({
          document: scenario.document,
          markers: scenario.markers,
          legend: scenario.legend,
        })
      : analyzeSketch({ svg: scenario.svg, markers: scenario.markers, legend: scenario.legend });
  }

  it('has a scenario for every code, and each scenario emits it', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...FINDING_CODES].sort());
    for (const code of FINDING_CODES) {
      const report = reportFor(scenarios[code]!);
      expect(report.findings.map((finding) => finding.code), code).toContain(code);
    }
  });

  it('explains each code in the guide, with advice that names a field or a command', () => {
    for (const code of FINDING_CODES) expect(REMOTE_MCP_SKETCH_GUIDE, code).toContain(code);
    for (const code of FINDING_CODES) {
      const finding = reportFor(scenarios[code]!).findings.find((entry) => entry.code === code)!;
      expect(finding.title.length, code).toBeGreaterThan(4);
      // Advice is the reason the report exists: it has to name something the caller can pass, run, or
      // do. `IDENTICAL_FRAMES` is the one whose remedy is an edit rather than a field — there is no
      // argument that makes two copied frames differ — so its action verbs count.
      expect(finding.advice, code).toMatch(
        /`|data:|localehub|css|theme|data-key|data-component|data-i18n-key|import_translations|内联|删掉|补上|写成/,
      );
    }
  });

  it('tells the agent, in the prompt, to read the report before uploading again', () => {
    const prompt = remoteSketchPrompt({ projectId: 'p', page: 'page.tsx' });
    expect(prompt).toContain('report');
    expect(prompt).toContain('NO_SOURCE_COLOURS');
  });
});

/**
 * The replica path, read the same way.
 *
 * A page is not a picture, so what is wrong with it is different: nothing was redrawn, but the page may
 * name assets nobody can resolve, carry no keys to hang translations on, or hold scripts that will not
 * run. These pin the reader that says so — and the two things it must *not* say, because a false alarm
 * on a page the caller sent verbatim is worse than silence.
 */
describe('what the document report notices', () => {
  const pageWith = (body: string): Parameters<typeof analyzeDocument>[0] => ({
    document: { frames: [{ title: '默认', html: `<html><head><style>body{background:#f6f7f9}</style></head><body>${body}</body></html>` }] },
    markers: [{ key: 'policy.view', text: '查看详情', component: 'policy-card' }],
    legend: [{ name: 'policy-card' }],
  });

  it('is quiet about a page that brought its styles, its pictures and its keys', () => {
    const report = analyzeDocument(pageWith('<div class="policy-card" data-key="policy.view"><img src="data:image/png;base64,AA"/><svg viewBox="0 0 1 1"></svg>查看详情</div>'));
    expect(report.clean).toBe(true);
    expect(report.stats.keys).toBe(1);
    expect(report.stats.pictures).toBe(2);
  });

  it('says a relative asset will be a broken image, and what to do instead', () => {
    const report = analyzeDocument(pageWith('<img src="./assets/logo.png"/><div data-key="policy.view">查看</div>'));
    const finding = report.findings.find((entry) => entry.code === 'ASSETS_NOT_INLINED')!;
    expect(finding.count).toBe(1);
    expect(finding.advice).toContain('data:');
    expect(report.stats.localAssets).toBe(1);
  });

  it('counts a remote asset without calling it a mistake', () => {
    const report = analyzeDocument(pageWith('<img src="https://cdn.example.com/logo.png"/><div data-key="policy.view">查看</div>'));
    expect(report.findings.map((entry) => entry.code)).toContain('REMOTE_ASSETS');
    expect(report.findings.find((entry) => entry.code === 'REMOTE_ASSETS')!.severity).toBe('info');
    expect(report.stats.remoteAssets).toBe(1);
    expect(report.findings.map((entry) => entry.code)).not.toContain('ASSETS_NOT_INLINED');
  });

  it('says scripts will not run, as information rather than as a defect', () => {
    const report = analyzeDocument(pageWith('<div data-key="policy.view">查看</div><script>fetch("/api")</script>'));
    const finding = report.findings.find((entry) => entry.code === 'SCRIPTS_NOT_RUN')!;
    expect(finding.severity).toBe('info');
    expect(finding.advice).toContain('动态数据除外');
    expect(report.stats.scripts).toBe(1);
  });

  it('says a page with no keys cannot carry a single marker', () => {
    const report = analyzeDocument({ document: { frames: [{ title: '默认', html: '<html><body><p>没有 key</p></body></html>' }] }, markers: [] });
    expect(report.findings.map((entry) => entry.code)).toContain('NO_KEYS');
    expect(report.stats.keys).toBe(0);
  });

  it('says a page with no styling will look like no app at all', () => {
    const report = analyzeDocument({
      document: { frames: [{ title: '默认', html: '<html><body><span data-key="a">我的</span></body></html>' }] },
      markers: [{ key: 'a', text: '我的' }],
    });
    expect(report.findings.map((entry) => entry.code)).toContain('NO_STYLE');
  });

  it('catches two states that are the same page, from the markup itself', () => {
    const html = '<html><body><span data-key="a">我的</span></body></html>';
    const report = analyzeDocument({
      document: { frames: [{ title: '默认', html }, { title: '空状态', html }] },
      markers: [
        { key: 'a', text: '我的', frame: '默认' },
        { key: 'a', text: '我的', frame: '空状态' },
      ],
    });
    const finding = report.findings.find((entry) => entry.code === 'IDENTICAL_FRAMES')!;
    expect(finding.count).toBe(2);
    expect(report.stats.frames).toBe(2);
  });
});

/**
 * Reading a page's markup: which elements are marked, and what the page brought with it.
 *
 * The keys come from attributes rather than from the text, because a page's text is not a key — the
 * whole point of the replica is that the caller's markup already says which string is which.
 */
describe('reading a page', () => {
  it('takes keys from every attribute a caller might have used, with the namespace they declare', () => {
    const document = normalizeDocument({
      document:
        '<html><body><div data-component="policy-card"><h1 data-i18n-key="policy.title">我的保单</h1>' +
        '<button data-key="policy.view" data-namespace="Localizable">查看详情</button>' +
        '<span data-i18n="policy.empty">还没有保单</span></div></body></html>',
    });
    const markers = documentMarkers(document, { namespace: 'App' });
    expect(markers.map((marker) => marker.key)).toEqual(['policy.title', 'policy.view', 'policy.empty']);
    expect(markers.map((marker) => marker.namespace)).toEqual(['App', 'Localizable', 'App']);
    expect(markers.map((marker) => marker.text)).toEqual(['我的保单', '查看详情', '还没有保单']);
    // The component is inherited from the nearest ancestor that names one, which is what the legend
    // beside the page is built from.
    expect(markers.every((marker) => marker.component === 'policy-card')).toBe(true);
    expect(markers.every((marker) => marker.frame === '默认')).toBe(true);
  });

  it('does not read a script or a style block as copy', () => {
    const document = normalizeDocument({
      document: '<html><head><style>.a{content:"不是文案"}</style></head><body><script>track("也不是")</script><p data-key="a">真的文案</p></body></html>',
    });
    expect(documentMarkers(document)).toHaveLength(1);
    expect(documentMarkers(document)[0]!.text).toBe('真的文案');
  });

  it('classifies every asset the page points at', () => {
    const document = normalizeDocument({
      document:
        '<html><head><link rel="stylesheet" href="./app.css"></head><body>' +
        '<img src="data:image/png;base64,AA"><img src="/static/hero.png"><img src="https://cdn.example.com/a.png">' +
        '<div style="background-image:url(../img/pattern.png)"></div></body></html>',
    });
    const assets = documentAssets(document);
    // Four pictures: three `<img>` plus the CSS background on the div. One of the `<img>` is a data:
    // URI, so it is both a picture and an inlined asset.
    expect(assets).toMatchObject({ inline: 1, local: 3, remote: 1, styles: 1, pictures: 4 });
  });

  it('knows a whole page from a fragment, which is what routes it to the replica path', () => {
    expect(isFullDocument('<!doctype html><html><body>x</body></html>')).toBe(true);
    expect(isFullDocument('<html lang="zh">x</html>')).toBe(true);
    // A snippet with a body or head tag is still a snippet: routing it to the replica path would store
    // and render a page that has no document around it.
    expect(isFullDocument('<body><div>片段</div></body>')).toBe(false);
    expect(isFullDocument('<div class="card">片段</div>')).toBe(false);
  });
});
