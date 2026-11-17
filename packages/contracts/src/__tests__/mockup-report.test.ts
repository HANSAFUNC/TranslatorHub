import { describe, expect, it } from 'vitest';

import { FINDING_CODES, analyzeSketch } from '../mockup-report';
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
  /** One scenario per code, so the emitted set can be compared against the list. */
  const scenarios: Record<string, Parameters<typeof analyzeSketch>[0]> = {
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
  };

  it('has a scenario for every code, and each scenario emits it', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...FINDING_CODES].sort());
    for (const code of FINDING_CODES) {
      const report = analyzeSketch(scenarios[code]!);
      expect(report.findings.map((finding) => finding.code), code).toContain(code);
    }
  });

  it('explains each code in the guide, with advice that names a field or a command', () => {
    for (const code of FINDING_CODES) expect(REMOTE_MCP_SKETCH_GUIDE, code).toContain(code);
    for (const code of FINDING_CODES) {
      const finding = analyzeSketch(scenarios[code]!).findings.find((entry) => entry.code === code)!;
      expect(finding.title.length, code).toBeGreaterThan(4);
      // Advice is the reason the report exists: it has to name something the caller can pass, run, or
      // do. `IDENTICAL_FRAMES` is the one whose remedy is an edit rather than a field — there is no
      // argument that makes two copied frames differ — so its action verbs count.
      expect(finding.advice, code).toMatch(/`|data:|localehub|css|theme|data-key|data-component|import_translations|删掉|补上/);
    }
  });

  it('tells the agent, in the prompt, to read the report before uploading again', () => {
    const prompt = remoteSketchPrompt({ projectId: 'p', page: 'page.tsx' });
    expect(prompt).toContain('report');
    expect(prompt).toContain('NO_SOURCE_COLOURS');
  });
});
