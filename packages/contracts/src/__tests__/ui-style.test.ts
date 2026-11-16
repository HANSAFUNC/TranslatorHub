import { describe, expect, it } from 'vitest';

import {
  declarationsFromInline,
  mergeStyles,
  parseStyleSheet,
  styleForElement,
  styleFromClassNames,
  styleFromDeclarations,
  tailwindColor,
} from '../ui-style';

/**
 * Reading a page's styling out of its source.
 *
 * The sketch is only recognisable if it carries the page's colours, and the page already says what
 * those are — in classes, in inline styles, in a `<style>` block. What these tests pin is that the
 * reading is *narrow*: a closed set of properties, a fixed palette, and nothing that would let a
 * page's stylesheet reach past the drawing into anything else.
 */

describe('tailwind colours', () => {
  it('resolves the palette at the values Tailwind ships', () => {
    // Spot checks against the published palette, because a wrong hex here is a sketch that lies
    // about the page it claims to show.
    expect(tailwindColor('blue-600')).toBe('#2563eb');
    expect(tailwindColor('zinc-900')).toBe('#18181b');
    expect(tailwindColor('red-500')).toBe('#ef4444');
    expect(tailwindColor('emerald-50')).toBe('#ecfdf5');
    expect(tailwindColor('slate-950')).toBe('#020617');
    expect(tailwindColor('white')).toBe('#ffffff');
    expect(tailwindColor('black')).toBe('#000000');
  });

  it('refuses what is neither a palette colour nor a CSS name', () => {
    expect(tailwindColor('blue-601')).toBeUndefined();
    expect(tailwindColor('chartreuse-500')).toBeUndefined();
    // A bare `blue` is a CSS name, not a Tailwind scale entry, and CSS names resolve to their own
    // values — which is not the same blue as `blue-500`.
    expect(tailwindColor('blue')).toBe('#0000ff');
  });
});

describe('tailwind classes', () => {
  it('reads the utilities a real page is built from', () => {
    const style = styleFromClassNames('flex items-center gap-4 bg-white text-sm font-semibold text-zinc-900');
    expect(style.background).toBe('#ffffff');
    expect(style.fontSize).toBe(14);
    expect(style.fontWeight).toBe('semibold');
    expect(style.color).toBe('#18181b');
    expect(style.gap).toBe(16);
  });

  it('reads a primary button as a filled, rounded control', () => {
    const style = styleFromClassNames('rounded-lg bg-blue-600 px-4 py-2 text-white shadow-sm');
    expect(style).toMatchObject({ background: '#2563eb', color: '#ffffff', radius: 8, paddingX: 16, paddingY: 8, shadow: true });
  });

  it('drops the conditional classes and keeps the unconditional ones', () => {
    // A sketch is one state of one screen: `dark:` and `hover:` describe states it cannot show. Taking
    // them would also mean a later `hover:bg-…` overwrote the colour the page actually displays.
    const style = styleFromClassNames('text-slate-900 dark:text-slate-100 hover:bg-slate-100');
    expect(style.color).toBe('#0f172a');
    expect(style.background).toBeUndefined();
  });

  it('reads arbitrary values, which is how a brand colour gets in', () => {
    const style = styleFromClassNames('bg-[#1a2b3c] text-[rgb(250,250,250)] rounded-[10px]');
    expect(style).toMatchObject({ background: '#1a2b3c', color: 'rgb(250,250,250)', radius: 10 });
  });

  it('does not confuse a font size with a text colour', () => {
    expect(styleFromClassNames('text-2xl').fontSize).toBe(24);
    expect(styleFromClassNames('text-2xl').color).toBeUndefined();
  });

  it('ignores the parts of a class list it does not draw', () => {
    expect(styleFromClassNames('sr-only md:grid-cols-3 transition-all')).toEqual({});
  });
});

describe('a stylesheet', () => {
  const sheet = parseStyleSheet(`
    /* a comment */
    :root { --brand: #2563eb; --muted: #71717a; }
    body { background: #f8fafc; }
    .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 16px; }
    .btn, .btn-primary { background: var(--brand); color: white; }
    h2 { font-size: 1.5rem; font-weight: 700; text-align: center; }
    * { color: var(--muted); }
  `);

  it('collects the variables a page defines', () => {
    expect(sheet.variables['--brand']).toBe('#2563eb');
  });

  it('resolves var() in the rules that use them', () => {
    const style = styleForElement({ tag: 'button', attributes: { class: 'btn' } }, sheet);
    expect(style?.background).toBe('#2563eb');
    expect(style?.color).toBe('#ffffff');
  });

  it('reads a shorthand border as a colour and a width', () => {
    const style = styleForElement({ tag: 'div', attributes: { class: 'card' } }, sheet);
    expect(style).toMatchObject({
      border: '#e4e4e7',
      borderWidth: 1,
      radius: 12,
      paddingX: 16,
      paddingY: 16,
      // Kept exactly as the stylesheet wrote it; the renderer takes short hex as it is.
      background: '#fff',
      // `* { color: … }` also matches, and loses to nothing — the card sets no colour of its own.
      color: '#71717a',
    });
  });

  it('lets a later rule win, property by property', () => {
    // `*` sets a colour, `.btn` sets another: both apply, and the class is the more specific of the
    // two in practice, which source order alone does not express — so classes are merged after tags.
    const style = styleForElement({ tag: 'button', attributes: { class: 'btn' } }, sheet);
    expect(style?.color).toBe('#ffffff');
  });

  it('reads rem as pixels', () => {
    expect(styleForElement({ tag: 'h2' }, sheet)?.fontSize).toBe(24);
  });

  it('keeps the page background, which the screen is drawn with', () => {
    expect(sheet.rules.find((rule) => rule.selector === 'body')?.declarations['background-color']).toBe('#f8fafc');
  });
});

describe('declarations', () => {
  it('reads the properties the renderer draws and ignores the rest', () => {
    const style = styleFromDeclarations(
      declarationsFromInline('color: #fff; display: grid; padding: 8px 12px; box-shadow: none; font-weight: 500; z-index: 9'),
    );
    // `padding: 8px 12px` is vertical then horizontal, exactly as CSS means it.
    expect(style).toEqual({ color: '#fff', paddingY: 8, paddingX: 12, fontWeight: 'medium' });
  });

  it('turns a percentage radius into a pill', () => {
    expect(styleFromDeclarations({ 'border-radius': '50%' }).radius).toBe(999);
  });

  it('drops a colour it cannot draw rather than passing it through', () => {
    // hsl() would need converting to be measured for contrast, and anything unknown is not a colour
    // this renderer should be putting into an SVG attribute.
    expect(styleFromDeclarations({ color: 'hsl(210 40% 96%)' }).color).toBeUndefined();
    expect(styleFromDeclarations({ color: 'url(javascript:alert(1))' }).color).toBeUndefined();
  });

  it('ignores a box-shadow that is explicitly off', () => {
    expect(styleFromDeclarations({ 'box-shadow': 'none' }).shadow).toBeUndefined();
  });
});

describe('the order styles are applied in', () => {
  it('is tag, then class, then inline — and the closest one wins', () => {
    const sheet = parseStyleSheet('p { color: #111111 } .muted { color: #222222 }');
    const fromSheet = styleForElement({ tag: 'p', attributes: { class: 'muted' } }, sheet);
    expect(fromSheet?.color).toBe('#222222');
    const inline = styleForElement({ tag: 'p', attributes: { class: 'muted', style: 'color: #333333' } }, sheet);
    expect(inline?.color).toBe('#333333');
  });

  it('merges without letting undefined overwrite a value', () => {
    expect(mergeStyles({ color: '#fff', radius: 8 }, undefined, { radius: 12 })).toEqual({ color: '#fff', radius: 12 });
  });

  it('returns nothing when the element says nothing about how it looks', () => {
    expect(styleForElement({ tag: 'div', attributes: {} }, undefined)).toBeUndefined();
  });
});
