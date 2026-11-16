import { UI_NAMED_COLORS, type UiStyle } from './ui-spec';

/**
 * Where a sketch's colours come from.
 *
 * A grey wireframe is not recognisable — the point of a sketch is that a translator looks at it and
 * knows which page they are on, and a page is its colours and its components as much as its words.
 * The page's own source already says what those are: `bg-blue-600 text-white rounded-xl` is a
 * primary button, `class="card"` plus a `<style>` block is whatever the stylesheet says it is.
 *
 * So this module reads *styling intent* out of the source and turns it into the closed set of
 * properties the renderer knows how to draw. It is a translation, not a CSS engine: no cascade
 * beyond "tag, then class, then inline", no layout, no units other than px and rem, and anything it
 * does not understand is dropped rather than approximated. What it produces is deterministic, goes
 * through `uiStyleSchema`, and is drawn by the platform's own renderer — nothing here is ever
 * interpreted by a browser.
 */

/** The Tailwind palette, shades 50…950, at the values Tailwind v3 ships. */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const PALETTE: Record<string, readonly string[]> = {
  slate: ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b', '#0f172a', '#020617'],
  gray: ['#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827', '#030712'],
  zinc: ['#fafafa', '#f4f4f5', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#71717a', '#52525b', '#3f3f46', '#27272a', '#18181b', '#09090b'],
  neutral: ['#fafafa', '#f5f5f5', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040', '#262626', '#171717', '#0a0a0a'],
  stone: ['#fafaf9', '#f5f5f4', '#e7e5e4', '#d6d3d1', '#a8a29e', '#78716c', '#57534e', '#44403c', '#292524', '#1c1917', '#0c0a09'],
  red: ['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d', '#450a0a'],
  orange: ['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#431407'],
  amber: ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f', '#451a03'],
  yellow: ['#fefce8', '#fef9c3', '#fef08a', '#fde047', '#facc15', '#eab308', '#ca8a04', '#a16207', '#854d0e', '#713f12', '#422006'],
  lime: ['#f7fee7', '#ecfccb', '#d9f99d', '#bef264', '#a3e635', '#84cc16', '#65a30d', '#4d7c0f', '#3f6212', '#365314', '#1a2e05'],
  green: ['#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d', '#052e16'],
  emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'],
  teal: ['#f0fdfa', '#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59', '#134e4a', '#042f2e'],
  cyan: ['#ecfeff', '#cffafe', '#a5f3fc', '#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63', '#083344'],
  sky: ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e', '#082f49'],
  blue: ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554'],
  indigo: ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b'],
  violet: ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'],
  purple: ['#faf5ff', '#f3e8ff', '#e9d5ff', '#d8b4fe', '#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8', '#581c87', '#3b0764'],
  fuchsia: ['#fdf4ff', '#fae8ff', '#f5d0fe', '#f0abfc', '#e879f9', '#d946ef', '#c026d3', '#a21caf', '#86198f', '#701a75', '#4a044e'],
  pink: ['#fdf2f8', '#fce7f3', '#fbcfe8', '#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d', '#9d174d', '#831843', '#500724'],
  rose: ['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0519'],
};

const SPACING: Record<string, number> = {
  '0': 0, '0.5': 2, '1': 4, '1.5': 6, '2': 8, '2.5': 10, '3': 12, '3.5': 14, '4': 16,
  '5': 20, '6': 24, '7': 28, '8': 32, '9': 36, '10': 40, '11': 44, '12': 48, '14': 56, '16': 64,
};

const TEXT_SIZE: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48 };

const RADIUS: Record<string, number> = { none: 0, sm: 2, '': 4, md: 6, lg: 8, xl: 12, '2xl': 16, '3xl': 24, full: 999 };

/** Named colours resolve to their CSS value; `transparent` is not a fill and is left as it is. */
const NAMED_COLORS: Record<string, string> = { ...UI_NAMED_COLORS, transparent: 'transparent' };

/** `blue-600` → `#2563eb`; `white` → `#ffffff`. Unknown names stay unknown. */
export function tailwindColor(value: string): string | undefined {
  const named = NAMED_COLORS[value];
  if (named) return named;
  const match = /^([a-z]+)-(\d{2,3})$/.exec(value);
  if (!match) return undefined;
  const family = PALETTE[match[1]!];
  if (!family) return undefined;
  const index = SHADES.indexOf(Number(match[2]) as (typeof SHADES)[number]);
  return index === -1 ? undefined : family[index];
}

/** Anything in brackets: `bg-[#1a2b3c]`, `text-[rgb(10,20,30)]`, `rounded-[10px]`. */
function bracketed(token: string): string | undefined {
  const match = /\[([^\]]+)\]/.exec(token);
  return match?.[1]?.trim();
}

/**
 * Read one class list into styling.
 *
 * Prefixes are stripped in the order they appear in Tailwind itself (`sm:`, `hover:`, `dark:`), and
 * the variant is dropped rather than modelled: a sketch shows one state of one screen, and the
 * unconditional class is the one a static picture should use.
 */
export function styleFromClassNames(classNames: string): UiStyle {
  const style: UiStyle = {};
  for (const raw of classNames.split(/\s+/)) {
    if (!raw) continue;
    // `dark:`, `hover:`, `md:` and friends describe a state or a breakpoint. A sketch is one state of
    // one screen, so the unconditional class is the one to draw — and skipping the variants entirely
    // is what keeps a later `hover:bg-…` from overwriting the colour the page actually shows.
    if (/^[a-z-]+:/i.test(raw)) continue;
    const token = raw;

    let match: RegExpExecArray | null;
    if ((match = /^bg-(.+)$/.exec(token))) {
      const color = tailwindColor(match[1]!) ?? bracketed(token);
      if (color && /^(#|rgb|hsl|white|black|transparent)/i.test(color)) style.background = color;
      continue;
    }
    if ((match = /^(?:text|font)-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/.exec(token))) {
      style.fontSize = TEXT_SIZE[match[1]!];
      continue;
    }
    if ((match = /^(?:text|font)-(normal|medium|semibold|bold)$/.exec(token))) {
      style.fontWeight = match[1] as UiStyle['fontWeight'];
      continue;
    }
    if ((match = /^text-(left|center|right)$/.exec(token))) {
      style.align = match[1] as UiStyle['align'];
      continue;
    }
    if ((match = /^text-(.+)$/.exec(token))) {
      const color = tailwindColor(match[1]!.replace(/\/\d+$/, '')) ?? bracketed(token);
      if (color && /^(#|rgb|hsl|white|black|transparent)/i.test(color)) style.color = color;
      continue;
    }
    if ((match = /^border(?:-(\d+))?$/.exec(token))) {
      style.borderWidth = match[1] ? Number(match[1]) : 1;
      continue;
    }
    if ((match = /^border-(.+)$/.exec(token))) {
      const color = tailwindColor(match[1]!.replace(/\/\d+$/, '')) ?? bracketed(token);
      if (color && /^(#|rgb|hsl|white|black|transparent)/i.test(color)) style.border = color;
      continue;
    }
    if ((match = /^rounded(?:-(.+))?$/.exec(token))) {
      const key = match[1] ?? '';
      if (key in RADIUS) style.radius = RADIUS[key]!;
      else {
        const arbitrary = bracketed(token);
        const px = arbitrary ? toPixels(arbitrary) : undefined;
        if (px !== undefined) style.radius = px;
      }
      continue;
    }
    if ((match = /^p([xytrbl])?-(\S+)$/.exec(token))) {
      const size = SPACING[match[2]!];
      if (size === undefined) continue;
      const side = match[1] ?? 'all';
      if (side === 'all' || side === 'x' || side === 'l' || side === 'r') style.paddingX = size;
      if (side === 'all' || side === 'y' || side === 't' || side === 'b') style.paddingY = size;
      continue;
    }
    if ((match = /^gap-(\S+)$/.exec(token))) {
      const size = SPACING[match[1]!];
      if (size !== undefined) style.gap = size;
      continue;
    }
    if (/^shadow(?:-(?:sm|md|lg|xl|2xl))?$/.test(token)) {
      style.shadow = true;
      continue;
    }
  }
  return style;
}

/** `12px`, `0.875rem`, `50%` → a number the renderer can use. */
function toPixels(value: string): number | undefined {
  const match = /^([\d.]+)(px|rem|em)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? 'px';
  return unit === 'px' ? amount : amount * 16;
}

/** `rgb()`/`hsl()` as written, or a hex triple/quad. Anything else is not a colour we draw. */
function normaliseColor(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return trimmed;
  if (/^rgba?\([^)]*\)$/i.test(trimmed)) return trimmed.replace(/\s+/g, '');
  if (/^hsla?\([^)]*\)$/i.test(trimmed)) return undefined; // the renderer measures luminance, and hsl is not worth converting
  return NAMED_COLORS[trimmed.toLowerCase()];
}

/** `1px solid #e4e4e7` → a width and a colour; `2px` → just the width. */
function fromBorderShorthand(value: string, style: UiStyle): void {
  const width = /(\d+(?:\.\d+)?)px/.exec(value);
  if (width) style.borderWidth = Number(width[1]);
  // A colour is the token that parses as one; `solid` and `dashed` are not colours and are dropped.
  for (const token of value.trim().split(/\s+/)) {
    const resolved = normaliseColor(token);
    if (resolved) {
      style.border = resolved;
      break;
    }
  }
}

/**
 * CSS declarations → styling.
 *
 * Only the properties the renderer draws are read; the rest are ignored rather than guessed at. That
 * is the whole safety story for `<style>` blocks: a stylesheet cannot reach anything here except a
 * colour, a length and an alignment.
 */
export function styleFromDeclarations(declarations: Record<string, string>, variables: Record<string, string> = {}): UiStyle {
  const style: UiStyle = {};
  const value = (raw: string): string => {
    const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(raw.trim());
    if (!variable) return raw.trim();
    return (variables[variable[1]!] ?? variable[2] ?? '').trim();
  };

  for (const [property, raw] of Object.entries(declarations)) {
    const resolved = value(raw);
    if (!resolved) continue;
    switch (property) {
      case 'color': {
        const color = normaliseColor(resolved);
        if (color) style.color = color;
        break;
      }
      case 'background':
      case 'background-color': {
        const color = normaliseColor(resolved);
        if (color) style.background = color;
        break;
      }
      case 'border':
        fromBorderShorthand(resolved, style);
        break;
      case 'border-color': {
        const color = normaliseColor(resolved);
        if (color) style.border = color;
        break;
      }
      case 'border-width': {
        const px = toPixels(resolved);
        if (px !== undefined) style.borderWidth = px;
        break;
      }
      case 'border-radius': {
        const px = toPixels(resolved);
        // `50%` and `9999px` are both "as round as it goes".
        style.radius = resolved.includes('%') ? 999 : px;
        break;
      }
      case 'font-size': {
        const px = toPixels(resolved);
        if (px !== undefined) style.fontSize = px;
        break;
      }
      case 'font-weight': {
        const weight = Number(resolved);
        if (resolved === 'bold' || weight >= 700) style.fontWeight = 'bold';
        else if (resolved === 'semibold' || weight >= 600) style.fontWeight = 'semibold';
        else if (weight >= 500) style.fontWeight = 'medium';
        else if (resolved === 'normal' || weight > 0) style.fontWeight = 'regular';
        break;
      }
      case 'text-align':
        if (resolved === 'left' || resolved === 'center' || resolved === 'right') style.align = resolved;
        break;
      case 'padding': {
        // One value is all round; two are vertical then horizontal, as CSS means them.
        const parts = resolved.split(/\s+/);
        const first = toPixels(parts[0] ?? '');
        const second = parts.length > 1 ? toPixels(parts[1]!) : first;
        if (first !== undefined) style.paddingY = first;
        if (second !== undefined) style.paddingX = second;
        break;
      }
      case 'padding-left':
      case 'padding-right':
      case 'padding-inline': {
        const px = toPixels(resolved);
        if (px !== undefined) style.paddingX = px;
        break;
      }
      case 'padding-top':
      case 'padding-bottom':
      case 'padding-block': {
        const px = toPixels(resolved);
        if (px !== undefined) style.paddingY = px;
        break;
      }
      case 'gap': {
        const px = toPixels(resolved.split(/\s+/)[0] ?? '');
        if (px !== undefined) style.gap = px;
        break;
      }
      case 'box-shadow':
        if (resolved !== 'none') style.shadow = true;
        break;
      default:
        break;
    }
  }
  return style;
}

/** `style="color: #fff; padding: 8px"` → declarations. */
export function declarationsFromInline(value: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const piece of value.split(';')) {
    const colon = piece.indexOf(':');
    if (colon === -1) continue;
    const property = piece.slice(0, colon).trim().toLowerCase();
    const value_ = piece.slice(colon + 1).trim();
    if (property && value_) declarations[property] = value_;
  }
  return declarations;
}

export interface StyleRule {
  /** A class name without its dot, a tag name, or `*`. */
  selector: string;
  kind: 'class' | 'tag' | 'any';
  declarations: Record<string, string>;
  /** Where it appeared, so equal-specificity rules apply in the order they were written. */
  order?: number;
}

/** The little of CSS specificity a sketch needs: a class beats a tag, and `*` beats nothing. */
function specificityOf(rule: StyleRule): number {
  return rule.kind === 'class' ? 10 : rule.kind === 'tag' ? 1 : 0;
}

export interface StyleSheet {
  rules: StyleRule[];
  variables: Record<string, string>;
}

/**
 * A `<style>` block, read as far as a sketch needs it.
 *
 * Selectors are limited to a single class, a tag, or `*` — no descendant combinators, no pseudo
 * classes, no at-rules. A page that styles itself with a real stylesheet still gets its headings,
 * cards and buttons coloured; a page that leans on `@media` and `:hover` gets the unconditional
 * rules, which is what a still picture shows anyway. Specificity is resolved by source order, which
 * is close enough for the drawing and far simpler to reason about than the real cascade.
 */
export function parseStyleSheet(css: string): StyleSheet {
  const rules: StyleRule[] = [];
  const variables: Record<string, string> = {};
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  let order = 0;
  for (const block of withoutComments.split('}')) {
    const open = block.indexOf('{');
    if (open === -1) continue;
    const selectorText = block.slice(0, open).trim();
    const declarations = declarationsFromInline(block.slice(open + 1));
    if (!selectorText) continue;
    order += 1;

    // `:root { --brand: #2563eb }` — the variables a page's rules refer to.
    if (/:root|^html$|^body$/i.test(selectorText.replace(/\s+/g, ' ').trim())) {
      for (const [property, value] of Object.entries(declarations)) {
        if (property.startsWith('--')) variables[property] = value;
      }
      // `body { background: … }` is the page behind everything.
      const bodyStyle = styleFromDeclarations(declarations, variables);
      if (bodyStyle.background) {
        rules.push({ selector: 'body', kind: 'tag', declarations: { 'background-color': bodyStyle.background }, order });
      }
      continue;
    }

    for (const selector of selectorText.split(',')) {
      const trimmed = selector.trim();
      const classMatch = /^\.([\w-]+)$/.exec(trimmed);
      if (classMatch) {
        rules.push({ selector: classMatch[1]!, kind: 'class', declarations, order });
        continue;
      }
      if (/^\*$/.test(trimmed)) {
        rules.push({ selector: '*', kind: 'any', declarations, order });
        continue;
      }
      if (/^[a-z][\w-]*$/i.test(trimmed)) {
        rules.push({ selector: trimmed.toLowerCase(), kind: 'tag', declarations, order });
      }
    }
  }
  return { rules, variables };
}

/** Later wins, property by property — the same order a stylesheet's reader would expect. */
export function mergeStyles(...styles: (UiStyle | undefined)[]): UiStyle {
  const merged: UiStyle = {};
  for (const style of styles) {
    if (!style) continue;
    for (const [key, value] of Object.entries(style)) {
      if (value !== undefined && value !== null) (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * The styling of one element: tag rules, then class rules in source order, then its own `class`
 * utilities, and finally its inline `style` — the closest thing to the cascade that is still cheap
 * enough to run over a page on every upload. Empty means "draw it the way its kind is normally
 * drawn".
 */
export function styleForElement(
  element: { tag: string; attributes?: Record<string, string>; expressions?: string[] },
  sheet: StyleSheet | undefined,
): UiStyle | undefined {
  const attributes = element.attributes ?? {};
  // `style={styles.card}` and `className={cx(…)}` are decided at runtime; there is nothing to read.
  const isExpression = (name: string): boolean => element.expressions?.includes(name) ?? false;
  const inline = attributes.style && !isExpression('style') ? declarationsFromInline(attributes.style) : {};
  let style: UiStyle | undefined;

  if (sheet) {
    const classNames = (element.attributes?.class ?? element.attributes?.className ?? '').split(/\s+/);
    const matching = sheet.rules
      .filter(
        (rule) =>
          rule.kind === 'any' ||
          (rule.kind === 'tag' && rule.selector === element.tag.toLowerCase()) ||
          (rule.kind === 'class' && classNames.includes(rule.selector)),
      )
      // Specificity first, then the order they were written in: `* { color }` is a page-wide default
      // and `.btn { color }` is about this element, whatever order the stylesheet lists them in.
      .sort((a, b) => specificityOf(a) - specificityOf(b) || (a.order ?? 0) - (b.order ?? 0));
    for (const rule of matching) {
      style = mergeStyles(style, styleFromDeclarations(rule.declarations, sheet.variables));
    }
  }

  const classNames =
    isExpression('className') || isExpression('class') ? '' : (attributes.className ?? attributes.class ?? '');
  style = mergeStyles(style, styleFromClassNames(classNames));

  // `style="…"` can name a variable too, and those live on the sheets that declared them.
  if (Object.keys(inline).length) style = mergeStyles(style, styleFromDeclarations(inline, sheet?.variables ?? {}));

  return Object.keys(style).length ? style : undefined;
}
