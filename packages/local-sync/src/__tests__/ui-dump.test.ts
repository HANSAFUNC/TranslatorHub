import { describe, expect, it } from 'vitest';
import { markersFromDump, parseUiDump, type DumpNode } from '../ui-dump';

/**
 * The dump a device gives back, read into markers.
 *
 * A replica assumes the caller can hand over the page. A native app that only exists as an APK cannot —
 * but it can be *run*, and a running screen knows exactly where everything is: `uiautomator dump` gives
 * every element's real bounds and `screencap` gives the real pixels. That pair is the only input in this
 * whole system that is true by construction rather than by transcription, which is why it is worth a
 * parser of its own.
 *
 * The fixture is a real dump (1080×1920, an app whose labels are accessibility descriptions rather than
 * `text` — which is the normal case, not the exception), trimmed to the nodes that matter here.
 */

/** One `<node …>` tag, spelled the way a device spells it. */
function node(attrs: Partial<Record<'text' | 'resource-id' | 'class' | 'content-desc', string>> & { bounds: string }, children = ''): string {
  const all: Record<string, string> = {
    index: '0',
    text: '',
    'resource-id': '',
    class: 'android.view.View',
    package: 'com.example.app',
    'content-desc': '',
    checkable: 'false',
    checked: 'false',
    clickable: 'false',
    enabled: 'true',
    focusable: 'false',
    focused: 'false',
    scrollable: 'false',
    'long-clickable': 'false',
    password: 'false',
    selected: 'false',
    ...attrs,
  };
  const body = Object.entries(all)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `<node ${body}>${children}</node>`;
}

const hierarchy = (children: string): string =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${children}</hierarchy>`;

describe('parseUiDump', () => {
  it('reads the frame, the package and every node with its depth', () => {
    const xml = hierarchy(
      node({ bounds: '[0,0][1080,1920]', class: 'android.widget.FrameLayout' }, node({ text: '登录', bounds: '[58,527][371,611]' })),
    );
    const parsed = parseUiDump(xml);

    expect(parsed.packageName).toBe('com.example.app');
    expect(parsed.rotation).toBe(0);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0]!.depth).toBe(0);
    expect(parsed.nodes[1]!.depth).toBe(1);
    expect(parsed.nodes[1]!.bounds).toEqual({ left: 58, top: 527, right: 371, bottom: 611 });
  });

  it('decodes the XML entities a device escapes text with, newlines included', () => {
    const xml = hierarchy(
      node({ 'content-desc': '噜噜大王&#10;创作有序，噜噜相伴 &#39;25 &amp; more', bounds: '[32,76][1048,184]' }),
    );
    const parsed = parseUiDump(xml);

    // `&#10;` is the only newline a dump can express, and it is how one node carries two lines of copy.
    expect(parsed.nodes[0]!.description).toBe("噜噜大王\n创作有序，噜噜相伴 '25 & more");
  });
});

describe('markersFromDump', () => {
  const frame = { width: 1080, height: 1920 };

  const markersFor = (nodes: DumpNode[], options: Partial<Parameters<typeof markersFromDump>[1]> = {}) =>
    markersFromDump(nodes, { width: frame.width, height: frame.height, ...options });

  const parsed = (xml: string): DumpNode[] => parseUiDump(xml).nodes;

  it('turns bounds into fractions of the image, the way a hand-drawn marker is spelled', () => {
    const nodes = parsed(hierarchy(node({ text: '登录', bounds: '[54,960][540,1152]' })));
    const { markers } = markersFor(nodes);

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ key: '登录', text: '登录' });
    // 54/1080, 960/1920, 486/1080, 192/1920 — the editor multiplies these back by the image size.
    expect(markers[0]!.x).toBeCloseTo(0.05, 5);
    expect(markers[0]!.y).toBeCloseTo(0.5, 5);
    expect(markers[0]!.width).toBeCloseTo(0.45, 5);
    expect(markers[0]!.height).toBeCloseTo(0.1, 5);
  });

  it('uses the accessibility description when a node has no text, splitting the lines it merged', () => {
    // Most of a modern app's copy reaches the dump as `content-desc`, not `text`: an `ImageView` that
    // carries a caption, a `View` that is a button. One node carrying two lines is two strings a
    // translator will be asked about, so it is two markers — each on its own half of the box.
    const nodes = parsed(hierarchy(node({ 'content-desc': '我的账号&#10;涛涛短剧', bounds: '[32,280][1048,639]' })));
    const { markers } = markersFor(nodes);

    expect(markers.map((marker) => marker.text)).toEqual(['我的账号', '涛涛短剧']);
    expect(markers[0]!.y).toBeCloseTo(280 / 1920, 5);
    expect(markers[1]!.y).toBeCloseTo((280 + 359 / 2) / 1920, 5);
    // Both keep the box's own height-halves, so the two boxes tile the node exactly.
    expect(markers[0]!.height).toBeCloseTo(359 / 2 / 1920, 5);
  });

  it('prefers the visible text over the description, and never emits the same string twice', () => {
    const nodes = parsed(
      hierarchy(node({ text: '立即登录', 'content-desc': '立即登录', bounds: '[0,0][400,100]' })),
    );
    const { markers } = markersFor(nodes);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toBe('立即登录');
  });

  it('keeps the innermost of nested nodes carrying the same string', () => {
    // A card states its own title and its child states it again; the child is where the text is drawn.
    const nodes = parsed(
      hierarchy(
        node(
          { 'content-desc': '订单详情', bounds: '[0,0][1080,400]' },
          node({ 'content-desc': '订单详情', bounds: '[40,60][600,140]' }),
        ),
      ),
    );
    const { markers, skipped } = markersFor(nodes);

    expect(markers).toHaveLength(1);
    expect(markers[0]!.x).toBeCloseTo(40 / 1080, 5);
    expect(skipped.duplicate).toBe(1);
  });

  it('emits markers in reading order, not in dump order', () => {
    const nodes = parsed(
      hierarchy(
        node({ text: '第二行', bounds: '[40,300][400,360]' }) +
          node({ text: '右下', bounds: '[600,300][900,360]' }) +
          node({ text: '第一行', bounds: '[40,100][400,160]' }),
      ),
    );
    const { markers } = markersFor(nodes);
    expect(markers.map((marker) => marker.text)).toEqual(['第一行', '第二行', '右下']);
  });

  it('drops nodes with nothing to translate, an empty box, or a box off the image', () => {
    const nodes = parsed(
      hierarchy(
        node({ bounds: '[0,0][1080,1920]' }) +
          node({ text: '   ', bounds: '[0,0][10,10]' }) +
          node({ text: '零尺寸', bounds: '[10,10][10,10]' }) +
          node({ text: '画面之外', bounds: '[1200,2000][1400,2100]' }) +
          node({ text: '正常', bounds: '[40,40][400,100]' }),
      ),
    );
    const { markers, skipped } = markersFor(nodes);

    expect(markers.map((marker) => marker.text)).toEqual(['正常']);
    // `empty` counts the layout node too — a container has no string of its own, which is the ordinary
    // case and the reason a screen of 42 nodes yields a handful of markers rather than 42.
    expect(skipped).toMatchObject({ empty: 2, degenerate: 1, offImage: 1 });
  });

  it('clamps a box that only partly hangs off the image instead of dropping it', () => {
    // A status bar or a scrolled row can start above the frame; the visible part is still the element.
    const nodes = parsed(hierarchy(node({ text: '贴在顶部', bounds: '[0,-40][1080,60]' })));
    const { markers } = markersFor(nodes);

    expect(markers).toHaveLength(1);
    expect(markers[0]!.y).toBe(0);
    expect(markers[0]!.height).toBeCloseTo(60 / 1920, 5);
  });

  it('names each marker after the key the caller resolves, and keeps the text beside it', () => {
    const nodes = parsed(hierarchy(node({ text: '扫码登录', 'resource-id': 'com.example.app:id/tv_scan', bounds: '[58,527][371,611]' })));
    const { markers } = markersFor(nodes, {
      resolveKey: (text, node) => (node.resourceId.endsWith('tv_scan') ? 'login.scan_qr' : null),
    });

    expect(markers[0]).toMatchObject({ key: 'login.scan_qr', text: '扫码登录' });
  });

  it('falls back to the text itself as the key, which the platform reports as not-yet-imported', () => {
    // The caller cannot always know the key (an APK with no sources in reach); the platform's own
    // `markers.unmatched` is the report for that, and it is a better answer than refusing to upload.
    const nodes = parsed(hierarchy(node({ text: '未知文案', bounds: '[0,0][100,50]' })));
    const { markers } = markersFor(nodes, { resolveKey: () => null });
    expect(markers[0]!.key).toBe('未知文案');
  });

  it('reports an ambiguity rather than guessing which key a repeated string belongs to', () => {
    const nodes = parsed(hierarchy(node({ text: '确定', bounds: '[0,0][100,50]' })));
    const { markers, ambiguous } = markersFor(nodes, {
      resolveKey: () => 'confirm.ok',
      candidates: () => ['confirm.ok', 'dialog.ok'],
    });

    expect(markers[0]!.key).toBe('confirm.ok');
    expect(ambiguous).toEqual([{ text: '确定', keys: ['confirm.ok', 'dialog.ok'] }]);
  });
});
