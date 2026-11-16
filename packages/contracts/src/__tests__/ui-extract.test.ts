import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layoutUiSpec } from '../ui-spec';
import { buildUiSpec, extractUiSpec, looksLikeUiText, parseJsx } from '../ui-extract';

/**
 * Reading a page's code into a screen description.
 *
 * The promise this module makes is "every string on the page gets a marker", so most of these tests
 * are about *not losing* text: the ways a hand-written scanner drops a page's copy are subtle (a
 * generic read as a tag, a block read as an expression, a wrapper collapsed past its own title) and
 * each one is pinned here with the construct that caused it.
 */

const REPO = join(__dirname, '../../../..');
const page = (relative: string): string => readFileSync(join(REPO, relative), 'utf8');

describe('what counts as UI copy', () => {
  it.each([
    ['下一步', true],
    ['Save changes', true],
    ['已选 155 学分', true],
    // A single word is copy, not a token. The earlier rule dropped every space-less string, so a
    // page whose title is one word lost its heading — the sketch showed a gap with no marker on it.
    ['Checkout', true],
    ['Cancel', true],
    ['设置', true],
    ['text-sm', false],
    ['flex-1', false],
    ['./components/button', false],
    ['https://example.com/x', false],
    ['application/json', false],
    ['MODULE_PATH', false],
    ['24px', false],
    ['·', false],
    ['a', false],
    ['aboutme_logo', false],
    ['bg-blue-600', false],
    // ...but an asset name or a utility chain still is not copy, which is what the punctuation and
    // lower-case-chain rules are for.
    ['logo', true],
  ])('%s → %s', (value, expected) => {
    expect(looksLikeUiText(value)).toBe(expected);
  });
});

describe('the JSX scanner', () => {
  it('reads elements, text and nesting', () => {
    const roots = parseJsx('<div><span>你好</span><button>下一步</button></div>');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.tag).toBe('div');
    expect(roots[0]!.children.map((child) => child.tag)).toEqual(['span', 'button']);
  });

  it('does not read a TypeScript generic as a tag', () => {
    // `useState<Foo>` used to open an element that never closed, so every real element became its
    // child — and the scan returned nothing at all for the commonest component shape there is.
    const source = `
      export function A() {
        const [items, setItems] = useState<Item[]>([]);
        const flag = count < 3 && ready;
        return <div><span>你好</span></div>;
      }`;
    const roots = parseJsx(source);
    const tags: string[] = [];
    const walk = (nodes: ReturnType<typeof parseJsx>): void => {
      for (const node of nodes) {
        tags.push(node.tag);
        walk(node.children);
      }
    };
    walk(roots);
    expect(tags).toEqual(['div', 'span']);
  });

  it('does not read a function body’s brace as a JSX expression', () => {
    const roots = parseJsx('export function A() { const x = 1; return <p>文案</p>; }');
    expect(roots.map((node) => node.tag)).toEqual(['p']);
  });

  it('keeps JSX that lives inside a .map(), where a list’s rows are', () => {
    const roots = parseJsx('<ul>{items.map((row) => <li>{row.title}</li>)}</ul>');
    expect(roots[0]!.children.map((child) => child.tag)).toEqual(['li']);
  });

  it('treats a JSX comment as a comment', () => {
    const roots = parseJsx('<div>{/* 这段注释不该出现 */}<span>真的文案</span></div>');
    expect(roots[0]!.children.map((child) => child.tag)).toEqual(['span']);
  });

  it('reads an attribute value that contains an angle bracket', () => {
    const roots = parseJsx('<div><a data-note="a > b" href="/x">下一步</a></div>');
    expect(roots[0]!.children[0]!.attributes['data-note']).toBe('a > b');
  });
});

describe('extraction', () => {
  it('finds i18n keys and their default text', () => {
    const { strings } = extractUiSpec('<div><span>{t("checkout.pay", "Pay now")}</span></div>', 'x.tsx', {});
    expect(strings).toEqual([{ text: 'Pay now', key: 'checkout.pay' }]);
  });

  it('uses the text as the key when the project keys by source string', () => {
    const { strings } = extractUiSpec('<div><span>下一步</span></div>', 'x.tsx', {});
    expect(strings).toEqual([{ text: '下一步', key: '下一步' }]);
  });

  it('lets an explicit mapping win, which is what a caller with a key file wants', () => {
    const { strings } = extractUiSpec('<div><span>下一步</span></div>', 'x.tsx', { keys: { 下一步: 'exam.next' } });
    expect(strings).toEqual([{ text: '下一步', key: 'exam.next' }]);
  });

  it('joins the halves of a sentence an expression splits, without inventing a space in Chinese', () => {
    const { strings } = extractUiSpec('<p>已选 {count} 项</p>', 'x.tsx', {});
    expect(strings.map((entry) => entry.text)).toEqual(['已选项']);
  });

  it('keeps the spaces Latin text needs around an interpolated value', () => {
    const { strings } = extractUiSpec('<p>You have {count} items</p>', 'x.tsx', {});
    expect(strings.map((entry) => entry.text)).toEqual(['You have items']);
  });

  it('reads the copy out of attributes that are visible on screen', () => {
    const { strings } = extractUiSpec('<input placeholder="搜索代码、语言名或英文名" />', 'x.tsx', {});
    expect(strings.map((entry) => entry.text)).toEqual(['搜索代码、语言名或英文名']);
  });

  it('does not read an attribute whose value is decided at runtime', () => {
    // `aria-label={label}` names a variable; only the variable's *name* is in the file, and reading it
    // put the word "label" in the sketch as if it were a translation.
    const { strings } = extractUiSpec('<button aria-label={label}>复制</button>', 'x.tsx', {});
    expect(strings.map((entry) => entry.text)).toEqual(['复制']);
  });

  it('does not read a style or class list written as an expression', () => {
    const { root } = extractUiSpec('<div className={cx("a", active && "b")} style={styles.card}>内容</div>', 'x.tsx', {});
    expect(root.children![0]!.style).toBeUndefined();
  });

  it('refuses a source with no elements, and says what this reader can read', () => {
    expect(() => extractUiSpec('const x = 1;', 'x.tsx', {})).toThrow(/没有找到任何界面元素/);
  });

  it('refuses a JSON file, which is uploaded directly rather than extracted', () => {
    expect(() => extractUiSpec('{}', 'ui.json', {})).toThrow(/不需要从源码提取/);
  });

  it('stamps the namespace onto the screen so its markers land in the right table', () => {
    const { root } = extractUiSpec('<div><span>下一步</span></div>', 'x.tsx', { namespace: 'Exam' });
    expect(root.namespace).toBe('Exam');
    const layout = layoutUiSpec({ name: 's', root });
    expect(layout.markers[0]!.namespace).toBe('Exam');
  });
});

/**
 * The property that matters end to end, checked against real pages of this repository: every string
 * the extractor reports has to be drawable, so it gets a marker.
 *
 * The pages are this repo's own UI on purpose — they are ordinary application code, full of generics,
 * ternaries, `.map()` calls, Tailwind class names and Chinese copy, which is exactly the input a
 * generator has to survive. A test against a tidy fixture would pass while the real thing failed.
 */
describe('every string on a real page becomes a marker', () => {
  const pages = [
    'apps/web/src/app/projects/page.tsx',
    'apps/web/src/app/login/page.tsx',
    'apps/web/src/app/settings/account/page.tsx',
    'apps/web/src/components/locale-picker.tsx',
    'apps/web/src/app/mcp/page.tsx',
    'apps/web/src/app/projects/[projectId]/translations/page.tsx',
    'apps/web/src/app/review/page.tsx',
  ];

  it.each(pages)('%s', (relative) => {
    const { spec, strings } = buildUiSpec(page(relative), relative, { name: 'screen', platform: 'web' });
    const layout = layoutUiSpec(spec);

    expect(strings.length).toBeGreaterThan(3);
    const drawn = layout.markers.map((marker) => marker.text);
    const missing = strings.filter((entry) => !drawn.some((text) => text === entry.text || text.includes(entry.text)));
    expect(missing.map((entry) => entry.text)).toEqual([]);

    // And each marker is a real position inside the picture.
    for (const marker of layout.markers) {
      expect(marker.x).toBeGreaterThanOrEqual(0);
      expect(marker.x + marker.width).toBeLessThanOrEqual(1.0001);
      expect(marker.y + marker.height).toBeLessThanOrEqual(1.0001);
    }
  });
});

/**
 * The page's colours.
 *
 * A sketch that is grey is a sketch nobody recognises. The page already says what its colours are —
 * in its classes, its inline styles, its stylesheet — and reading them is what makes the picture
 * answer "which page is this?" instead of only "what does the text say?".
 */
describe('styling comes from the page', () => {
  it('reads Tailwind classes into the tree', () => {
    const { root } = extractUiSpec(
      `<div class="rounded-xl bg-white p-4"><h2 class="text-2xl font-bold text-zinc-900">账户设置</h2>
       <button class="bg-blue-600 text-white rounded-lg px-4 py-2">保存</button></div>`,
      'page.html',
      {},
    );
    const card = root.children![0]!;
    expect(card.style).toMatchObject({ background: '#ffffff', radius: 12, paddingX: 16 });
    const heading = card.children!.find((child) => child.text === '账户设置')!;
    expect(heading.style).toMatchObject({ fontSize: 24, fontWeight: 'bold', color: '#18181b' });
    const button = card.children!.find((child) => child.text === '保存')!;
    expect(button.style).toMatchObject({ background: '#2563eb', color: '#ffffff', radius: 8, paddingX: 16, paddingY: 8 });
  });

  it('reads a stylesheet, including the variables it defines', () => {
    const { root } = extractUiSpec(
      `<style>:root { --brand: #2563eb } .btn { background: var(--brand); color: white; border-radius: 10px }</style>
       <button class="btn">下一步</button>`,
      'page.html',
      {},
    );
    const button = root.children!.find((child) => child.text === '下一步')!;
    expect(button.style).toMatchObject({ background: '#2563eb', color: '#ffffff', radius: 10 });
  });

  it('reads an inline style, which wins over the class', () => {
    const { root } = extractUiSpec(`<span class="text-zinc-500" style="color: #e11d48; font-weight: 700">已过期</span>`, 'page.html', {});
    expect(root.children![0]!.style).toMatchObject({ color: '#e11d48', fontWeight: 'bold' });
  });

  it('passes a nav through as a nav, not as a paragraph', () => {
    const { root } = extractUiSpec(
      `<nav class="bg-white border-b"><h1 class="text-lg font-semibold">课程详情</h1></nav>`,
      'page.html',
      {},
    );
    const nav = root.children![0]!;
    expect(nav.type).toBe('nav');
    expect(nav.text).toBe('课程详情');
  });
});

/**
 * The bug this pins: a `<script>` body and a `<style>` body are text to a scanner, and both were
 * being read as UI copy — a page with one inline script produced a marker whose text was
 * `const x = 1`, and a page with a stylesheet produced markers for its CSS.
 */
describe('program code is not copy', () => {
  it('never turns a script body into a string', () => {
    const { strings } = extractUiSpec(`<div><script>const label = '不是文案';</script><p>真的文案</p></div>`, 'page.html', {});
    expect(strings.map((entry) => entry.text)).toEqual(['真的文案']);
  });

  it('never turns a stylesheet into a string', () => {
    const { strings } = extractUiSpec(`<style>.a { color: red } /* 注释也不该出现 */</style><p>真的文案</p>`, 'page.html', {});
    expect(strings.map((entry) => entry.text)).toEqual(['真的文案']);
  });

  it('never turns an HTML comment into a string', () => {
    const { strings } = extractUiSpec(`<div><!-- TODO: 改文案 --><p>真的文案</p></div>`, 'page.html', {});
    expect(strings.map((entry) => entry.text)).toEqual(['真的文案']);
  });
});
