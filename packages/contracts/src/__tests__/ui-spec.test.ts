import { describe, expect, it } from 'vitest';

import {
  MAX_UI_NODES,
  layoutUiSpec,
  uiStyleSchema,
  measureText,
  renderUiSketch,
  uiSpecIssues,
  wrapText,
  type UiSpec,
} from '../ui-spec';
import { svgDimensions, unsafeSvgReasons } from '../mockup';

/**
 * The wireframe renderer.
 *
 * What matters here is not that the picture is pretty — it is that it is *reproducible* and that the
 * markers it reports describe the picture it drew. Those two properties are what let a caller send a
 * description instead of a hand-drawn image: the platform's geometry and the platform's drawing come
 * from one pass over one tree, so they cannot disagree.
 */

const spec = (root: UiSpec['root'], extra: Partial<UiSpec> = {}): UiSpec => ({
  name: 'test',
  platform: 'ios',
  locale: 'zh-CN',
  ...extra,
  root,
});

describe('text measurement', () => {
  it('counts a CJK character as full width and a Latin one as a fraction', () => {
    // A wireframe's boxes have to be roughly right or labels overlap the element next to them.
    expect(measureText('中', 20)).toBe(20);
    expect(measureText('a', 20)).toBeLessThan(20);
    expect(measureText('中文', 20)).toBe(40);
  });

  it('wraps at the available width, and breaks a long word that cannot fit', () => {
    expect(wrapText('hello world', 10, 1000)).toHaveLength(1);
    expect(wrapText('hello world', 10, 30).length).toBeGreaterThan(1);
    // CJK has no spaces to break at.
    expect(wrapText('中文中文中文中文', 10, 25).length).toBeGreaterThan(1);
    // A single unbreakable token longer than the line still has to wrap.
    expect(wrapText('supercalifragilistic', 10, 30).length).toBeGreaterThan(1);
  });
});

describe('layout', () => {
  it('stacks children vertically and reports a marker for every string', () => {
    const layout = layoutUiSpec(
      spec({
        type: 'screen',
        children: [
          { type: 'text', text: '亲爱的', role: 'heading' },
          { type: 'text', text: '讲义' },
        ],
      }),
    );
    expect(layout.markers.map((marker) => marker.text)).toEqual(['亲爱的', '讲义']);
    // The second one is below the first, not on top of it.
    expect(layout.markers[1]!.y).toBeGreaterThan(layout.markers[0]!.y);
    expect(layout.markers.every((marker) => marker.width > 0 && marker.height > 0)).toBe(true);
  });

  it('puts a row’s children side by side and starts a wrapped line below the tallest cell', () => {
    const layout = layoutUiSpec(
      spec({
        type: 'screen',
        children: [
          {
            type: 'row',
            columns: 2,
            children: [
              { type: 'text', text: '第一行第一列' },
              { type: 'text', text: '第一行第二列' },
              { type: 'text', text: '第二行第一列' },
              { type: 'text', text: '第二行第二列' },
            ],
          },
        ],
      }),
    );
    const [a, b, c, d] = layout.markers;
    expect(a!.y).toBe(b!.y);
    expect(a!.x).toBeLessThan(b!.x);
    expect(c!.y).toBe(d!.y);
    // The second line clears the first, which is the bug that made a header overlap the body.
    expect(c!.y).toBeGreaterThan(a!.y + a!.height - 0.0001);
    expect(c!.x).toBe(a!.x);
  });

  it('is deterministic: the same spec lays out identically twice', () => {
    const root: UiSpec['root'] = {
      type: 'screen',
      children: [
        { type: 'text', text: '标题', role: 'heading' },
        { type: 'row', columns: 3, children: [{ type: 'button', text: '再想想' }, { type: 'button', text: '下一步' }, { type: 'button', text: '不保存' }] },
        { type: 'input', text: '搜索课程' },
      ],
    };
    expect(JSON.stringify(layoutUiSpec(spec(root)).boxes)).toBe(JSON.stringify(layoutUiSpec(spec(root)).boxes));
  });

  it('keeps every marker inside the image, which is what an upload requires', () => {
    const layout = layoutUiSpec(
      spec({
        type: 'screen',
        children: [{ type: 'text', text: '很长的一段说明文字，用来逼近图片的右边缘，看看它会不会越界。' }],
      }),
    );
    for (const marker of layout.markers) {
      expect(marker.x).toBeGreaterThanOrEqual(0);
      expect(marker.y).toBeGreaterThanOrEqual(0);
      expect(marker.x + marker.width).toBeLessThanOrEqual(1.0001);
      expect(marker.y + marker.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it('grows the canvas to fit content rather than cutting the page off', () => {
    const long = Array.from({ length: 30 }, (_, index) => ({ type: 'text' as const, text: `第 ${index} 行` }));
    const layout = layoutUiSpec(spec({ type: 'screen', children: long }, { height: 400 }));
    expect(layout.height).toBeGreaterThan(400);
  });

  it('uses the key from the node when it has one, and the text otherwise', () => {
    const layout = layoutUiSpec(
      spec({ type: 'screen', children: [{ type: 'text', key: 'header.greeting', text: '亲爱的' }] }),
    );
    expect(layout.markers[0]!.key).toBe('header.greeting');
    expect(layout.markers[0]!.text).toBe('亲爱的');
  });

  it('carries the namespace onto the marker, so it lands in the right table', () => {
    const layout = layoutUiSpec(
      spec({ type: 'screen', namespace: 'Localizable', children: [{ type: 'text', text: '下一步' }] }),
    );
    expect(layout.markers[0]!.namespace).toBe('Localizable');
  });
});

describe('spec validation', () => {
  it('accepts a page with strings', () => {
    expect(uiSpecIssues(spec({ type: 'screen', children: [{ type: 'text', text: '你好' }] }))).toEqual([]);
  });

  it('refuses a tree that is too deep or too big, because the renderer walks it', () => {
    let deep: UiSpec['root'] = { type: 'text', text: '底' };
    for (let index = 0; index < 30; index += 1) deep = { type: 'section', children: [deep] };
    expect(uiSpecIssues(spec(deep)).join(' ')).toContain('嵌套层级');

    const many = { type: 'screen' as const, children: Array.from({ length: MAX_UI_NODES + 10 }, () => ({ type: 'text' as const, text: 'x' })) };
    expect(uiSpecIssues(spec(many)).join(' ')).toContain('上限');
  });

  it('refuses a spec that would draw nothing', () => {
    expect(uiSpecIssues(spec({ type: 'screen' })).join(' ')).toContain('画不出任何东西');
  });
});

describe('rendered SVG', () => {
  const sketch = renderUiSketch(
    spec({
      type: 'screen',
      children: [
        { type: 'text', text: '亲爱的', role: 'heading' },
        { type: 'button', text: '下一步' },
        { type: 'text', text: '<script>alert(1)</script>' },
      ],
    }),
  );

  it('passes the platform’s own SVG gate and reports its size', () => {
    // The generator's output goes back through the same decoder an uploaded image does, so it has to
    // satisfy the same rules — including the ones that exist to keep a served SVG from being a script.
    expect(unsafeSvgReasons(sketch.svg)).toEqual([]);
    expect(svgDimensions(sketch.svg)).toEqual({ width: sketch.width, height: sketch.height });
  });

  it('escapes text rather than emitting markup', () => {
    expect(sketch.svg).not.toContain('<script>');
    expect(sketch.svg).toContain('&lt;script&gt;');
  });

  it('draws one text element per line and a frame per button', () => {
    expect(sketch.svg).toContain('亲爱的');
    expect(sketch.svg).toContain('下一步');
    expect(sketch.svg.match(/<rect /g)!.length).toBeGreaterThan(1);
  });
});

/**
 * Styling.
 *
 * A grey wireframe is not recognisable, and "which page is this?" is the question a sketch exists to
 * answer. What matters here is that a colour a caller states is *drawn* — and that the picture stays
 * inside the same guarantees as before: deterministic, inside the canvas, and every marker where the
 * text actually is.
 */
describe('styled drawing', () => {
  it('fills a control with the colour it was given, and keeps its label readable', () => {
    const sketch = renderUiSketch(
      spec({
        type: 'screen',
        children: [
          { type: 'button', text: '保存', style: { background: '#2563eb', color: '#ffffff' } },
          { type: 'button', text: '取消', style: { background: '#ffffff' } },
        ],
      }),
    );
    expect(sketch.svg).toContain('fill="#2563eb"');
    expect(sketch.svg).toContain('fill="#ffffff"');
    // The second button asked for a white fill and named no text colour: dark ink, or the label
    // would be white on white.
    expect(sketch.svg).toContain('fill="#09090b"');
  });

  it('honours size, weight, alignment and radius', () => {
    const sketch = renderUiSketch(
      spec({
        type: 'screen',
        children: [
          { type: 'text', text: '标题', style: { fontSize: 30, fontWeight: 'bold', align: 'center' } },
          { type: 'card', style: { radius: 20, shadow: true, background: '#fafafa', border: '#e4e4e7' } },
        ],
      }),
    );
    expect(sketch.svg).toContain('font-size="30"');
    expect(sketch.svg).toContain('font-weight="700"');
    expect(sketch.svg).toContain('text-anchor="middle"');
    expect(sketch.svg).toContain('rx="20"');
    expect(sketch.svg).toContain('opacity="0.06"');
  });

  it('points a padded control’s marker at its text, not at its frame', () => {
    const padded = layoutUiSpec(
      spec({ type: 'screen', children: [{ type: 'button', text: '下一步', style: { paddingX: 40, paddingY: 20 } }] }),
    );
    const plain = layoutUiSpec(spec({ type: 'screen', children: [{ type: 'button', text: '下一步' }] }));
    const paddedBox = padded.boxes.find((box) => box.node.type === 'button')!;
    const plainBox = plain.boxes.find((box) => box.node.type === 'button')!;
    expect(paddedBox.width).toBeGreaterThan(plainBox.width);
    // The marker covers the content box; the frame is wider than that.
    const marker = padded.markers[0]!;
    expect(marker.x).toBeGreaterThan(0);
    expect(marker.width * padded.width).toBeLessThan(paddedBox.width);
  });

  it('draws a nav as a bar whose marker is its title', () => {
    const layout = layoutUiSpec(
      spec({
        type: 'screen',
        children: [{ type: 'nav', text: '课程详情', children: [{ type: 'icon', width: 20, height: 20 }] }],
      }),
    );
    const nav = layout.boxes.find((box) => box.node.type === 'nav')!;
    expect(nav.height).toBe(52);
    expect(layout.markers.map((marker) => marker.text)).toEqual(['课程详情']);
    // The title starts inside the bar's padding and does not run under the action on the right.
    expect(layout.markers[0]!.width).toBeLessThan(1);
    // A header spans the screen rather than sitting inside the page's content padding.
    expect(nav.width).toBe(layout.width);
  });

  it('lays tabs out side by side and keeps every label', () => {
    const layout = layoutUiSpec(
      spec({
        type: 'screen',
        children: [
          {
            type: 'tabs',
            children: [
              { type: 'text', text: '全部' },
              { type: 'text', text: '进行中' },
              { type: 'text', text: '已完成' },
            ],
          },
        ],
      }),
    );
    const labels = layout.markers.filter((marker) => ['全部', '进行中', '已完成'].includes(marker.text));
    expect(labels).toHaveLength(3);
    expect(labels[0]!.y).toBe(labels[1]!.y);
    expect(labels[0]!.x).toBeLessThan(labels[1]!.x);
    expect(labels[1]!.x).toBeLessThan(labels[2]!.x);
  });

  it('refuses a colour that is not a colour, at the schema rather than the renderer', () => {
    // Colors end up in SVG attributes, so they are validated where every other input is: a value
    // that is not a color never reaches the drawing at all.
    expect(uiStyleSchema.safeParse({ color: '#2563eb' }).success).toBe(true);
    expect(uiStyleSchema.safeParse({ color: 'blue' }).success).toBe(true);
    expect(uiStyleSchema.safeParse({ color: 'red; }' }).success).toBe(false);
    expect(uiStyleSchema.safeParse({ color: 'url(#x)' }).success).toBe(false);
    expect(uiStyleSchema.safeParse({ color: '" onload="alert(1)' }).success).toBe(false);
    expect(uiStyleSchema.safeParse({ fontSize: 900 }).success).toBe(false);
  });

  it('still passes the platform’s own SVG gate', () => {
    const sketch = renderUiSketch(
      spec({
        type: 'screen',
        children: [
          { type: 'nav', text: '<script>alert(1)</script>' },
          { type: 'button', text: '保存', style: { background: '#2563eb' } },
        ],
      }),
    );
    expect(unsafeSvgReasons(sketch.svg)).toEqual([]);
    expect(sketch.svg).not.toContain('<script>');
    expect(svgDimensions(sketch.svg)).toEqual({ width: sketch.width, height: sketch.height });
  });
});

/**
 * Paint order.
 *
 * Layout records a container's box *after* its children's — its height is only known once they are
 * measured — and drawing in that order put a card's opaque background on top of everything inside it.
 * The picture was an empty card while every marker still pointed at the right place, so no geometry
 * test could see it: the check has to be about what is drawn over what.
 */
describe('what is drawn over what', () => {
  const nested = renderUiSketch(
    spec({
      type: 'screen',
      children: [
        {
          type: 'card',
          style: { background: '#f8fafc', border: '#e4e4e7' },
          children: [{ type: 'button', text: '保存', style: { background: '#2563eb' } }],
        },
      ],
    }),
  );

  it('paints a container before the things inside it', () => {
    const card = nested.svg.indexOf('#f8fafc');
    const button = nested.svg.indexOf('#2563eb');
    const label = nested.svg.indexOf('保存');
    expect(card).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(card);
    expect(label).toBeGreaterThan(button);
  });

  it('keeps every surface before every label, however deep the nesting goes', () => {
    const deep = renderUiSketch(
      spec({
        type: 'screen',
        children: [
          {
            type: 'card',
            style: { background: '#111111' },
            children: [
              { type: 'section', style: { background: '#222222' }, children: [{ type: 'button', text: '深层按钮', style: { background: '#333333' } }] },
            ],
          },
        ],
      }),
    );
    const lastSurface = Math.max(deep.svg.indexOf('#111111'), deep.svg.indexOf('#222222'), deep.svg.indexOf('#333333'));
    expect(deep.svg.indexOf('深层按钮')).toBeGreaterThan(lastSurface);
  });
});
