import { describe, expect, it } from 'vitest';

import { FINDING_CODES, analyzeDocument, analyzeSketch } from '../mockup-report';
import { documentAssets, documentMarkers, isFullDocument, normalizeDocument } from '../mockup-document';
import {
  REMOTE_MCP_IMPORT_GUIDE,
  REMOTE_MCP_INSTRUCTIONS,
  REMOTE_MCP_SKETCH_GUIDE,
  remoteScreenMapPrompt,
  remoteSketchPrompt,
} from '../mcp-guide';

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
    Parameters<typeof analyzeSketch>[0] & {
      document?: Parameters<typeof analyzeDocument>[0]['document'];
      frame?: Parameters<typeof analyzeDocument>[0]['frame'];
    }
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
    FRAME_OVERFLOW: {
      svg: '',
      document: {
        frames: [
          {
            title: '默认',
            html: '<html><body><div style="position:absolute;left:0px;top:0px;width:412px;height:915px;background:#fff"></div><div style="position:absolute;left:426px;top:100px;width:100px;height:20px;background:#eee"></div></body></html>',
          },
        ],
      },
      markers: [{ key: 'home.title', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
      frame: { width: 412, height: 915 },
    },
    CANVAS_MISMATCH: {
      svg: '',
      document: {
        frames: [
          {
            title: '默认',
            html: '<html><head><style>.screen{position:relative;width:412px;height:1371px;background:#fff}</style></head><body><div class="screen" data-key="home.title">我的</div></body></html>',
          },
        ],
      },
      markers: [{ key: 'home.title', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
      frame: { width: 412, height: 915 },
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
    DRAWN_SHAPES: {
      svg: '',
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.card{background:#fff}</style></head><body>' +
              '<svg viewBox="0 0 24 24"><path d="M0 0h4v4H0z" fill="#667085"/></svg>' +
              '<span data-key="a" class="card">我的</span></body></html>',
          },
        ],
      },
      markers: [{ key: 'a', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
    },
    FLOW_LAYOUT: {
      svg: '',
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.card{background:#fff;display:flex;gap:8px}</style></head><body>' +
              '<img src="data:image/png;base64,AA">' +
              '<span data-key="a" class="card">我的</span></body></html>',
          },
        ],
      },
      markers: [{ key: 'a', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
    },
    CLIPPED_BOX: {
      svg: '',
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.screen{position:relative;height:844px;overflow:hidden}</style></head><body>' +
              '<img src="data:image/png;base64,AA">' +
              '<span data-key="a">我的</span></body></html>',
          },
        ],
      },
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
          ...(scenario.frame ? { frame: scenario.frame } : {}),
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
 * The frame, and the page drawn for a different one.
 *
 * A replica is rendered into one fixed phone size per platform, and the caller cannot widen it — so a
 * page laid out for another canvas does not fail loudly, it renders clipped. In the real uploads this
 * was the difference between the two platforms: 19 of 29 Android pages had coordinates outside the frame
 * (none of 32 iOS pages did), the worst declaring a 412×4250 canvas, and a login screen whose content
 * ran to 1371px rendered as an empty grey page while its report said `clean: true`.
 */
describe('the frame a page is drawn for', () => {
  const android = { width: 412, height: 915 };
  const pageWith = (body: string, frame = android): Parameters<typeof analyzeDocument>[0] => ({
    document: { frames: [{ title: '默认', html: `<html><body>${body}</body></html>` }] },
    markers: [{ key: 'home.title', text: '我的', component: 'card' }],
    legend: [{ name: 'card' }],
    frame,
  });
  const box = (left: number, top: number, width: number, height: number) =>
    `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:#eee"></div>`;

  it('says nothing about a page that fits the frame', () => {
    const report = analyzeDocument(pageWith(box(0, 0, 412, 915) + box(16, 100, 380, 44)));
    expect(report.findings.map((entry) => entry.code)).not.toContain('FRAME_OVERFLOW');
    expect(report.stats.frameWidth).toBe(412);
    expect(report.stats.frameHeight).toBe(915);
    expect(report.stats.frameOverflow).toBe(0);
    expect(report.stats.frameRatio).toBe(1);
  });

  it('counts the boxes outside it, and says how far out they are', () => {
    // The shape of the real failure: content laid out at twice the frame's width.
    const report = analyzeDocument(pageWith(box(0, 0, 412, 915) + box(428, 100, 412, 44) + box(413, 200, 412, 44)));
    const finding = report.findings.find((entry) => entry.code === 'FRAME_OVERFLOW');
    expect(finding?.count).toBe(2);
    expect(finding?.title).toContain('412×915');
    expect(finding?.title).toContain('2.04 倍');
    // The advice names the likely cause rather than only the symptom: dp read as px.
    expect(finding?.advice).toContain('dp');
    expect(finding?.advice).toContain('824');
    expect(report.stats.frameRatio).toBe(2.04);
  });

  it('says when the page declares a canvas of its own', () => {
    const report = analyzeDocument(
      pageWith('<div class="screen" style="position:relative;width:412px;height:1371px;background:#fff"></div>'),
    );
    const finding = report.findings.find((entry) => entry.code === 'CANVAS_MISMATCH');
    expect(finding?.title).toContain('412×1371');
    expect(finding?.title).toContain('.screen');
  });

  it('stays quiet about a page whose positions it cannot read', () => {
    // A page arranged by flow has no coordinates to be outside of, and boxes pinned to the right edge
    // fit by construction — an overflow invented from missing numbers would be a finding about the
    // checker.
    const report = analyzeDocument(
      pageWith('<div style="display:flex">我的</div><div style="position:absolute;right:16px;top:10px;width:40px;height:40px"></div>'),
    );
    expect(report.findings.map((entry) => entry.code)).not.toContain('FRAME_OVERFLOW');
    expect(report.stats.measuredBoxes).toBe(0);
    expect(report.stats.unmeasuredBoxes).toBe(1);
  });

  it('says nothing at all when the caller had no frame to measure against', () => {
    const report = analyzeDocument({
      document: { frames: [{ title: '默认', html: `<html><body>${box(428, 0, 800, 400)}</body></html>` }] },
      markers: [{ key: 'home.title', text: '我的' }],
    });
    expect(report.findings.map((entry) => entry.code)).not.toContain('FRAME_OVERFLOW');
    expect(report.stats.frameWidth).toBeUndefined();
  });
});


/**
 * The frame rule, in every text an agent reads before it draws.
 *
 * A rule that lives only in the guide's §9 is a rule the caller meets after it has already written the
 * page: the instructions are what a client puts in front of the model before any tool call, and the
 * prompt is what walks it through the upload. Both used to describe only the redrawing path — "the
 * platform parses the element tree, lays it out and computes the coordinates" — which is false for a
 * whole page, where the platform renders the markup as it is: that is exactly the belief that produces a
 * page laid out for some other canvas.
 */
describe('what the prompts say about the frame', () => {
  it('names the frame and the refusal in all three texts', () => {
    for (const [name, text] of [
      ['instructions', REMOTE_MCP_INSTRUCTIONS],
      ['sketch prompt', remoteSketchPrompt({})],
      ['sketch guide', REMOTE_MCP_SKETCH_GUIDE],
    ] as const) {
      expect(text, name).toContain('412×915');
      expect(text, name).toContain('390×844');
    }
    // The refusal is new behaviour: a caller that does not know about it reads a 422 as a platform fault.
    expect(remoteSketchPrompt({})).toContain('会被拒绝上传');
    expect(remoteSketchPrompt({})).toContain('FRAME_OVERFLOW');
    expect(REMOTE_MCP_SKETCH_GUIDE).toContain('FRAME_OVERFLOW');
    expect(REMOTE_MCP_SKETCH_GUIDE).toContain('CANVAS_MISMATCH');
  });

  it('separates the two paths in the instructions, because only one of them is redrawn', () => {
    expect(REMOTE_MCP_INSTRUCTIONS).toContain('不重画');
    expect(REMOTE_MCP_INSTRUCTIONS).toContain('自己排版画图');
    // And the unit trap, which is what actually produced the broken pages in the field.
    expect(REMOTE_MCP_INSTRUCTIONS).toContain('dp');
    expect(REMOTE_MCP_INSTRUCTIONS).toContain('2.625');
  });

  it('numbers the conventions it actually lists', () => {
    // The heading said 四条 while the list had six — a count nobody re-reads is a count that drifts.
    const heading = /## 10\. (.)条容易踩错的约定/.exec(REMOTE_MCP_SKETCH_GUIDE)?.[1];
    const count = ['①', '②', '③', '④', '⑤', '⑥', '⑦'].filter((mark) => REMOTE_MCP_SKETCH_GUIDE.includes(`**${mark}`)).length;
    const numerals: Record<string, number> = { 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
    expect(heading).toBeDefined();
    expect(numerals[heading!]).toBe(count);
  });
});
/**
 * Fidelity is the uploader's job, and it cannot be done from imagination.
 *
 * A caller that has the app has the layout: Auto Layout constraints, Android's `layout_*` attributes,
 * Flutter's padding and size arguments, an RN stylesheet. What it must not do is draw something that
 * looks roughly like the screen — that is how a screen arrived as grey bars, six hand-written glyphs and
 * not one asset, and the translation editor then showed a wireframe nobody recognised. These pin the
 * instructions that say where the numbers come from, per stack, and that route the caller to the path
 * where the browser does the rendering.
 */
describe('telling the uploader where the layout and the assets come from', () => {
  it('names the layout source in each stack a caller might have', () => {
    for (const cue of ['constraint', 'layout_', 'padding', 'StyleSheet']) {
      expect(REMOTE_MCP_SKETCH_GUIDE, cue).toContain(cue);
    }
  });

  it('names where the pictures come from, so a screen with photos is not drawn by hand', () => {
    for (const cue of ['xcassets', 'drawable']) {
      expect(REMOTE_MCP_SKETCH_GUIDE, cue).toContain(cue);
    }
  });

  it('names the codes that mean "you drew it instead of bringing it"', () => {
    expect(REMOTE_MCP_SKETCH_GUIDE).toContain('DRAWN_SHAPES');
  });

  it('routes the upload prompt to the replica path, not to "the platform redraws"', () => {
    const prompt = remoteSketchPrompt({ projectId: 'p', page: 'HomeView.swift' });
    expect(prompt).toContain('document');
    // The stale line: it described the platform as parse-and-redraw, which is what an uploading agent
    // read as permission to hand-write a wireframe.
    expect(prompt).not.toContain('平台只解析、不渲染');
    expect(prompt).not.toContain('三种输入选一种');
  });

  it('asks for the whole app before a single screen, and says where the navigation lives', () => {
    // A screen on its own answers "where does this string live" only for the strings that happen to be
    // on it. The map is what turns "a few screens" into "the app's screens" — and it is a different job,
    // so it is a different prompt rather than a paragraph inside the upload one.
    const prompt = remoteScreenMapPrompt({ projectId: 'p', app: '高研院 App' });
    expect(prompt).toContain('高研院 App');
    // Per stack: an agent that has the app in front of it needs to know where *its* navigation is.
    for (const cue of ['segue', 'NavigationStack', 'nav_graph', 'routes', 'react-navigation']) {
      expect(prompt, cue).toContain(cue);
    }
    // The table comes first and the upload second: the order is the whole point of the prompt.
    expect(prompt.indexOf('先不要传')).toBeGreaterThan(-1);
    expect(prompt).toContain('从哪一屏');
    expect(prompt).toContain('到哪一屏');
    expect(prompt).toContain('flow.md');
    expect(REMOTE_MCP_SKETCH_GUIDE).toContain('map-app-screens');
  });

  it('does not send an agent down the redraw path in the guide it reads first', () => {
    // The import guide's sketch section used to open with "上游只有一条路值得走：传 ui" — one path, the
    // one that redraws. The agent followed it, and the result was this wireframe.
    expect(REMOTE_MCP_IMPORT_GUIDE).not.toContain('上游只有一条路值得走');
    expect(REMOTE_MCP_IMPORT_GUIDE).toContain('document');
    expect(REMOTE_MCP_IMPORT_GUIDE).toContain('DRAWN_SHAPES');
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
    // One picture and one shape: a picture is something the page *brought* — an `<img>` or a CSS
    // background — while an inline `<svg>` is something the caller drew. Counting the two together is
    // what let a page of six hand-written glyphs report "6 pictures, nothing to say".
    expect(report.stats.pictures).toBe(1);
    expect(report.stats.shapes).toBe(1);
  });

  it('says the pictures are hand-drawn shapes when the page brought no asset at all', () => {
    const report = analyzeDocument(pageWith('<div class="policy-card" data-key="policy.view"><svg viewBox="0 0 24 24"><path d="M0 0h4v4H0z"/></svg>查看详情</div>'));
    const finding = report.findings.find((entry) => entry.code === 'DRAWN_SHAPES')!;
    expect(finding.count).toBe(1);
    expect(finding.advice).toContain('data:');
    // The upload that prompted this: a screen whose photos, icons and illustration were all drawn as
    // shapes, so it rendered as a wireframe. The report must not call that "has pictures".
    expect(report.stats.pictures).toBe(0);
    expect(report.stats.shapes).toBe(1);
    expect(report.findings.map((entry) => entry.code)).not.toContain('NO_PICTURES');
  });

  it('says a box with a fixed height and hidden overflow loses whatever does not fit', () => {
    // The defect that cost 64% of a real screen's copy: the page declared `.screen{height:844px;
    // overflow:hidden}` and laid its content out to 1507px, so everything below the fold was gone —
    // 27 of 42 markers sat outside the box. It is worth its own warning because *nothing downstream can
    // recover it*: the picture is the only artefact, and the content was discarded before it was drawn.
    // The declaration is checkable even though the overflow is not (that needs a layout engine).
    const report = analyzeDocument({
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.screen{position:relative;width:390px;height:844px;overflow:hidden}' +
              '.nav{height:91px;overflow:hidden}.title{position:absolute;left:16px;top:60px}</style></head>' +
              '<body><div class="screen"><div class="nav"></div><div class="title" data-key="home.title">我的</div></div></body></html>',
          },
        ],
      },
      markers: [{ key: 'home.title', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
    });
    const finding = report.findings.find((entry) => entry.code === 'CLIPPED_BOX')!;
    expect(finding.count).toBe(2);
    expect(finding.advice).toContain('overflow');
    expect(report.stats.clipped).toBe(2);
  });

  it('stays quiet when a page lets its content decide the height', () => {
    const report = analyzeDocument({
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.screen{position:relative;width:390px}</style>' +
              '<style>.title{position:absolute;left:16px;top:60px}</style></head>' +
              '<body><div class="screen"><div class="title" data-key="home.title">我的</div></div></body></html>',
          },
        ],
      },
      markers: [{ key: 'home.title', text: '我的', component: 'card' }],
      legend: [{ name: 'card' }],
    });
    expect(report.findings.map((entry) => entry.code)).not.toContain('CLIPPED_BOX');
    expect(report.stats.clipped).toBe(0);
  });

  it('says a page laid out by flow is a re-composition, not the screen', () => {
    // The other half of "it does not look like the app": the boxes are put where the browser's layout
    // engine decides, so every difference in font metrics moves something. Nothing is checkable when a
    // page is arranged this way — a wrong number is absorbed into a plausible-looking layout — which is
    // why an absolutely-positioned page is the only kind whose fidelity can be judged at all.
    const report = analyzeDocument({
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.card{background:#fff;display:flex;gap:8px}' +
              '.grid{display:grid;grid-template-columns:repeat(5,1fr)}.banner{height:96px}</style></head>' +
              '<body><div class="card" data-key="policy.view"><div class="grid"><div class="banner"></div></div>查看详情</div></body></html>',
          },
        ],
      },
      markers: [{ key: 'policy.view', text: '查看详情', component: 'policy-card' }],
      legend: [{ name: 'policy-card' }],
    });
    const finding = report.findings.find((entry) => entry.code === 'FLOW_LAYOUT')!;
    expect(finding.count).toBe(2);
    expect(finding.advice).toContain('position:absolute');
    expect(report.stats.positioned).toBe(0);
    expect(report.stats.flow).toBe(2);
  });

  it('stays quiet about a page whose elements are each placed at a coordinate', () => {
    const report = analyzeDocument({
      document: {
        frames: [
          {
            title: '默认',
            html:
              '<html><head><style>.screen{position:relative;width:390px;height:844px}</style>' +
              '<style>.title{position:absolute;left:16px;top:60px;width:200px}</style></head>' +
              '<body><div class="screen"><div class="title" data-key="policy.view" style="position:absolute;left:16px;top:60px">查看详情</div></div></body></html>',
          },
        ],
      },
      markers: [{ key: 'policy.view', text: '查看详情', component: 'policy-card' }],
      legend: [{ name: 'policy-card' }],
    });
    expect(report.findings.map((entry) => entry.code)).not.toContain('FLOW_LAYOUT');
    expect(report.stats.positioned).toBe(2);
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
/**
 * What a real caller hit, in one project, over 50+ frames.
 *
 * Each of these is a case where the platform told the caller something untrue about its own upload, and
 * the caller had no way to tell: a key that matched but was reported missing, a frame count that
 * disagreed with the request, a component name that was there but called absent. They are grouped
 * because they share a shape — the platform read its own bookkeeping instead of the markup.
 */
describe('what the caller reported from the field', () => {
  it('keeps the key exactly as the page wrote it, so a key with a trailing space can still match', () => {
    // The project's key set has keys with trailing spaces (`"如需变更学习设备，点击 "` — common in real
    // string tables). The page wrote the same value. Reading the attribute with `.trim()` silently
    // rewrote the caller's key, so the marker could never match the row that was there all along, and
    // the report blamed the caller for a key it did not have.
    const document = normalizeDocument({
      document: '<html><body><div data-key="如需变更学习设备，点击 ">如需变更学习设备，点击 </div></body></html>',
    });
    expect(documentMarkers(document)[0]!.key).toBe('如需变更学习设备，点击 ');
    // An attribute that is only whitespace is still not a key.
    const blank = normalizeDocument({ document: '<html><body><div data-key="   ">甲</div></body></html>' });
    expect(documentMarkers(blank)).toHaveLength(0);
  });

  it('names the keys a marker could not find, instead of only counting them', () => {
    // "1 key is missing" is not actionable: the caller ends up probing `GET /keys?search=…` once per key
    // to find out which one. The names are already in hand when the finding is built.
    const document = normalizeDocument({
      document: '<html><body><span data-key="a">甲</span><span data-key="b">乙</span><span data-key="c">丙</span></body></html>',
    });
    const markers = documentMarkers(document).map((marker) => ({ ...marker, missing: marker.key === 'b' }));
    const report = analyzeDocument({ document, markers, legend: [{ name: 'card' }] });
    const finding = report.findings.find((entry) => entry.code === 'MISSING_KEYS')!;
    expect(finding.count).toBe(1);
    expect(finding.keys).toEqual(['b']);
  });

  it('counts the frames it was sent, and says how many of them carry markers', () => {
    // A splash frame with no strings is a frame. Reporting two frames for a three-frame upload reads as
    // "a frame went missing", and the caller re-uploads to fix a problem it does not have.
    const document = normalizeDocument({
      frames: [
        { title: '启动图', html: '<html><body><div class="splash"></div></body></html>' },
        { title: '默认', html: '<html><body><div data-key="a">甲</div></body></html>' },
        { title: '空状态', html: '<html><body><div data-key="b">乙</div></body></html>' },
      ],
    });
    const report = analyzeDocument({ document, markers: documentMarkers(document), legend: [{ name: 'card' }] });
    expect(report.stats.frames).toBe(3);
    expect(report.stats.framesWithMarkers).toBe(2);
  });

  it('only says the elements have no component name when the markup names none', () => {
    // The criterion was "the legend is empty", and the legend is derived from the *markers* — so a
    // component named on an element that carries no key contributed nothing, and the platform told the
    // caller its elements had no component names while they were right there in the markup.
    const named = normalizeDocument({
      document: '<html><body><div data-component="PolicyCard"><span>甲</span></div><span data-key="a">乙</span></body></html>',
    });
    const namedReport = analyzeDocument({ document: named, markers: documentMarkers(named), legend: [] });
    expect(namedReport.findings.map((entry) => entry.code)).not.toContain('NO_COMPONENTS');
    expect(namedReport.stats.components).toBe(1);

    const unnamed = normalizeDocument({
      document: '<html><body><div class="flex-row"><span data-key="a">乙</span></div></body></html>',
    });
    const unnamedReport = analyzeDocument({ document: unnamed, markers: documentMarkers(unnamed), legend: [] });
    expect(unnamedReport.findings.map((entry) => entry.code)).toContain('NO_COMPONENTS');
  });
});


/**
 * What the caller asserts about its own upload.
 *
 * `NO_PICTURES` exists to catch artwork that failed to travel. For a screen made of text and CSS it is
 * noise that can never be cleared, because it fires on a fact that is simply true — and its own advice
 * said "if the page really has no images, ignore this", which is not something a delivery gate can act
 * on. A declaration turns "ignore this" into something a caller can say, so `clean` means what it says.
 */
describe('what the caller declares about a screen', () => {
  const textPage: Parameters<typeof analyzeDocument>[0] = {
    document: {
      frames: [
        {
          title: '默认',
          html: '<html><head><style>.dialog{background:#fff;border-radius:12px;color:#333}</style></head><body><div class="dialog" data-component="ConfirmDialog" data-key="policy.view">确认删除？</div></body></html>',
        },
      ],
    },
    markers: [{ key: 'policy.view', text: '确认删除？', component: 'dialog' }],
    legend: [{ name: 'dialog' }],
  };

  it('stops reporting no pictures once the caller says there are none', () => {
    expect(analyzeDocument(textPage).findings.map((entry) => entry.code)).toContain('NO_PICTURES');
    const declared = analyzeDocument({ ...textPage, expectations: { noImages: true } });
    expect(declared.findings.map((entry) => entry.code)).not.toContain('NO_PICTURES');
    // The gate the finding was blocking: "no findings" now means the caller is done.
    expect(declared.clean).toBe(true);
    // The counts still tell the truth about what arrived — a declaration changes the verdict, not the facts.
    expect(declared.stats.pictures).toBe(0);
  });

  it('does not let the declaration hide a picture that failed to arrive', () => {
    // The one thing a declaration must not do. A screen that names artwork nobody can resolve is not
    // "a screen with no pictures", and saying so must not silence the finding that says it.
    const broken = analyzeDocument({
      document: {
        frames: [
          {
            title: '默认',
            html: '<html><body><img src="./logo.png" data-key="a"><img src="https://cdn.example.com/a.png" data-key="b"></body></html>',
          },
        ],
      },
      markers: [
        { key: 'a', text: '', component: 'card' },
        { key: 'b', text: '', component: 'card' },
      ],
      legend: [{ name: 'card' }],
      expectations: { noImages: true },
    });
    const codes = broken.findings.map((entry) => entry.code);
    expect(codes).toContain('ASSETS_NOT_INLINED');
    expect(codes).toContain('REMOTE_ASSETS');
    expect(broken.clean).toBe(false);
  });
});

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
