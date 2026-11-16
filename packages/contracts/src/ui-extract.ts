import { ErrorCode, LocaleHubError } from './errors';
import {
  MAX_INLINE_IMAGE_CHARS,
  MAX_UI_NODES,
  UI_IMAGE_DATA_PATTERN,
  type UiNode,
  type UiSpec,
  type UiTheme,
} from './ui-spec';
import { mergeStyles, parseStyleSheet, styleForElement, type StyleSheet } from './ui-style';

/**
 * Turn a page's source into a screen description.
 *
 * The point of this module is that a sketch should not be a drawing someone made once. A page's code
 * already says which elements it has and what every string on it is; reading that gives a sketch that
 * covers *all* of the page's UI, and one that can be regenerated whenever the page changes. Measuring
 * coordinates by hand — the thing `upload_screen_mockup` used to require — is what made sketches rare,
 * stale, and partial.
 *
 * What this reads, in order of how much it can trust it:
 *
 *   1. JSX/TSX (`.tsx`, `.jsx`) — the component tree, with `t('key')` calls giving exact keys.
 *   2. HTML (`.html`) — the element tree, for pages that are already markup.
 *   3. A description file (`.json`) — a `UiSpec` written by hand or by an agent that read some other
 *      framework. Deliberately the escape hatch: this module does not pretend to parse SwiftUI.
 *
 * It lives in `@localehub/contracts` rather than in the CLI because the platform itself takes HTML:
 * an agent that has the page's markup can send it, and the server parses it with this same scanner.
 * Nothing here executes, resolves or fetches anything — it reads text and returns a tree.
 *
 * It is a *tolerant* scanner, not a compiler. It has to survive a real page — imports, generics,
 * conditionals, map() calls, comments — and produce something a person can recognize, rather than
 * fail on the first construct it does not model.
 */

export interface ExtractOptions {
  /** `namespace` stamped onto every node, so markers land in the right `.strings` table. */
  namespace?: string;
  /** Explicit text → key mapping, which wins over what the source says. */
  keys?: Record<string, string>;
  /** Cap on how many elements to emit; the platform's own limit is the real ceiling. */
  maxNodes?: number;
  /** The page's own `<style>` rules, when it has any. Read by `extractUiSpec` when omitted. */
  styleSheet?: StyleSheet;
  /**
   * A stylesheet that lives somewhere else — a `globals.css`, a design system's theme file.
   *
   * Most pages do not carry their colours in the file that lays them out: they carry class names that
   * a stylesheet elsewhere defines. Without that file the sketch can only fall back to its own
   * palette, which is how a screen ends up grey. Rules from here apply first, so the page's own
   * `<style>` and inline styles still win.
   */
  css?: string;
}

export interface ExtractResult {
  root: UiNode;
  /** Every string that became a marker, in document order. */
  strings: { text: string; key: string }[];
  /** Nodes that carried no text and were kept only for structure — useful when tuning. */
  elementCount: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ elements */

/** Map a tag or component name to the node kind that draws it recognizably. */
function kindOf(tag: string, attributes: Record<string, string> = {}): UiNode['type'] | null {
  const name = tag.toLowerCase();
  const raw = tag;
  const classes = (attributes.class ?? attributes.className ?? '').split(/\s+/).filter(Boolean);
  /**
   * Whether a *component* name appears on the element — in its tag or in one of its classes.
   *
   * `<div class="card">` and `<Card>` are the same thing to a reader, and a page that names its parts
   * in classes (`tabbar`, `btn`, `badge`) is as explicit as one that names them in components. So the
   * component names are read first, from either place; only what is left over is classified by its
   * tag (a `div` is a grouping, an `li` is a row). Reading the tag first meant `<div class="card">`
   * was a `section` and its own class was consulted only for styling.
   */
  const named = (pattern: RegExp): boolean => pattern.test(raw) || classes.some((token) => pattern.test(token));

  // `<input>` is decided by its `type` before anything else: a range is a slider and a checkbox is a
  // switch, and the name rule below would read the tag `input` as "a text field" and stop there.
  if (name === 'input') {
    const type = (attributes.type ?? '').toLowerCase();
    if (type === 'range') return 'slider';
    if (type === 'checkbox') return 'switch';
    return 'input';
  }

  // Component names, whichever way the page wrote them down.
  if (['nav', 'header'].includes(name) || named(/(navbar|nav-?bar|toolbar|topbar|top-?bar|appbar|app-?bar|titlebar)$/i)) {
    return 'nav';
  }
  // The bottom bar of a phone app: `UITabBar`, `BottomNavigationView`, `.tabbar`, `<TabBar>`.
  if (named(/(tabbar|tab-?bar|bottomnavigation|bottom-?navigation|bottombar|bottom-?bar|tabbarview)$/i)) {
    return 'tabbar';
  }
  // Controls that are neither text nor a text field. A settings page is mostly switches, and a switch
  // is the difference between "settings" and "a list of rows".
  if (named(/(switch|toggle|checkbox)$/i)) return 'switch';
  if (named(/(slider|range|stepper)$/i)) return 'slider';
  // Deliberately not `<Tabs>` or `<TabsList>`: a component library's `Tabs` wraps the triggers *and*
  // every panel, so drawing it as one segmented control squeezes whole screens into a 34 px bar.
  if (named(/(tabs?|segmented|segmentedcontrol|segmented-?control)$/i) && !named(/table$/i)) return 'tabs';
  // Suffix-anchored on purpose. A `Field` wraps a label and an input, but `FieldLabel` and
  // `FieldGroup` are not inputs — matching the substring anywhere turned a whole form into one box
  // and dropped every label inside it.
  if (named(/(button|btn)$/i)) return 'button';
  if (named(/(card|panel|sheet|dialog|modal)$/i)) return 'card';
  if (named(/(input|textarea|select|searchfield|textfield|field)$/i)) return 'input';
  if (named(/icon$/i)) return 'icon';
  if (named(/(image|img|avatar|logo|thumbnail|picture)$/i)) return 'image';
  if (named(/(badge|tag|chip|pill)$/i)) return 'badge';
  if (named(/(text|label|title|heading|caption|description|subtitle)$/i)) return 'text';

  // Then the markup itself.
  if (['textarea', 'select'].includes(name)) return 'input';
  if (name === 'img' || name === 'picture' || name === 'video' || name === 'svg' || name === 'canvas') return 'image';
  if (name === 'hr') return 'divider';
  if (name === 'li' || name === 'td' || name === 'th') return 'row';
  if (/^h[1-6]$/.test(name) || name === 'title' || name === 'legend') return 'text';
  if (['p', 'span', 'label', 'strong', 'em', 'small', 'dt', 'dd', 'figcaption', 'caption', 'blockquote'].includes(name)) {
    return 'text';
  }
  if (['button', 'a'].includes(name)) return 'button';
  if (
    ['div', 'main', 'section', 'article', 'aside', 'form', 'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'figure', 'body', 'html', 'footer'].includes(
      name,
    )
  ) {
    return 'section';
  }
  return null;
}

/** Roles that decide a text node's size in the drawing. */
function roleForTag(tag: string, explicit?: string): UiNode['role'] {
  if (explicit === 'heading' || explicit === 'subheading' || explicit === 'body' || explicit === 'label' || explicit === 'caption') {
    return explicit;
  }
  const name = tag.toLowerCase();
  if (/^h[12]$/.test(name)) return 'heading';
  if (/^h[3-6]$/.test(name)) return 'subheading';
  if (['label', 'dt', 'th', 'legend'].includes(name)) return 'label';
  if (['small', 'caption', 'figcaption'].includes(name)) return 'caption';
  return 'body';
}

/**
 * Is this string UI copy, or is it code?
 *
 * The scanner sees every string literal in the file, so the filter matters as much as the extraction:
 * a class name, a CSS value, a URL, an import path or a single punctuation character is not a
 * translatable string, and putting markers on those is what makes a generated sketch useless.
 */
export const CJK = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uff00-\\uffef]';

/** A space, unless the gap sits between two CJK characters where a space reads as a typo. */
function bufferedSeparator(buffer: string): string {
  const last = [...buffer].pop() ?? '';
  return new RegExp(CJK).test(last) ? '' : ' ';
}

/**
 * Drop the spaces that only exist because an expression sat between two words.
 *
 * `已选 {n} 项` is written with spaces around the placeholder, which is how JSX is formatted and not
 * how Chinese is typeset: the rendered line is `已选项`. Only spaces *between* two CJK characters go.
 */
function tidyCjk(text: string): string {
  return text.replace(new RegExp(`(${CJK})\\s+(${CJK})`, 'g'), '$1$2');
}

export function looksLikeUiText(value: string): boolean {
  const text = value.trim();
  if (text.length < 1 || text.length > 500) return false;
  // A single character is a separator or an icon stand-in, not copy.
  if ([...text].length < 2) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  // Code-ish shapes: an id, a class, a path, an asset name. What those have in common is
  // punctuation — `#main`, `bg-blue-600`, `./components/button`, `aboutme_logo` — so punctuation is
  // what is checked, not "one word". The earlier rule rejected every space-less token, which threw
  // away real copy: a single-word label (`Cancel`, `Settings`, `Checkout`) is extremely common, and a
  // page whose title is one word lost it — leaving a heading-sized hole with no marker on it.
  const singleWord = /^[\p{L}\p{N}]+(?:['’][\p{L}]+)*$/u.test(text);
  if (!singleWord && /[.#:/_[\]]/.test(text) && !/\s/.test(text)) return false;
  // A lower-case chain carrying a hyphen or a digit: `text-sm`, `flex-1`, `bg-blue-600`, `2xl`. That
  // shape is a class name or a token, and copy with no space and no capital letter at all is rare
  // enough that the trade is worth making — the copy that does exist is what the sketch is for.
  if (!/\s/.test(text) && text === text.toLowerCase() && /[-\d]/.test(text) && /\p{L}/u.test(text)) return false;
  if (/^(https?:|\/|\.\/|\.\.\/|data:|mailto:|tel:)/.test(text)) return false;
  if (/^[\w-]+\/[\w-]+$/.test(text)) return false; // module paths
  if (/^(application|image|text|font|video)\//.test(text)) return false; // media types
  if (/^[a-z]+(-[a-z]+)+$/i.test(text) && text === text.toLowerCase() && text.length > 8 && !text.includes(' ')) {
    // `flex-col`, `text-sm`, `justify-between`… a hyphen-chained lowercase token with no space.
    if (/^(flex|grid|text|bg|border|rounded|p|px|py|m|mx|my|w|h|min|max|gap|space|items|justify|font|leading|tracking|shadow|ring|opacity|z|top|left|right|bottom|inset|overflow|relative|absolute|hidden|block|inline|sticky|fixed|sm|md|lg|xl|hover|focus|active|dark|group|peer|transition|duration|ease|animate|translate|scale|rotate|origin|cursor|select|pointer|order|col|row|auto|sr)-/.test(text)) {
      return false;
    }
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(text)) return false; // CONSTANT_CASE
  if (/^\d+(\.\d+)?(px|rem|em|%|vh|vw|s|ms)?$/.test(text)) return false; // numbers and units
  // A string with no letters at all (e.g. "---", "•••") carries no copy.
  if (!/\p{L}/u.test(text)) return false;
  return true;
}

/* ------------------------------------------------------------- JSX/TSX scan */

interface Tokenizer {
  source: string;
  position: number;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return index;
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf('\n', start);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf('*/', start);
  return end === -1 ? source.length : end + 2;
}

/** Read `{ … }` including nested braces and strings; returns the index just past the closing brace. */
function readBraces(source: string, start: number): { text: string; end: number } {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, index + 1), end: index + 1 };
    } else if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index);
      continue;
    } else if (char === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    } else if (char === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    index += 1;
  }
  return { text: source.slice(start), end: source.length };
}

/** The literal inside `{expr}` when the expression *is* a literal, else null. */
function expressionLiteral(expression: string): string | null {
  const inner = expression.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  const literal = /^(['"])([\s\S]*)\1$/.exec(inner);
  if (literal) return unescapeLiteral(literal[2]!);
  // `{cond ? 'Yes' : 'No'}` — take the first branch; the sketch needs one label, not a decision tree.
  const ternary = /^(?:[\s\S]*?)\?\s*(['"])([\s\S]*?)\1\s*:/.exec(inner);
  if (ternary) return unescapeLiteral(ternary[2]!);
  // `{count} 条` and similar: keep the literal parts, drop the interpolation.
  return null;
}

function unescapeLiteral(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * i18n calls found in an expression, as `{ key, fallback }`.
 *
 * Covers the shapes that actually appear: `t('key')`, `t('key', 'Default')`, `$t('key')`,
 * `i18n.t('key')`, `translate('key')`, and `<Trans i18nKey="key">default</Trans>`, plus
 * `intl.formatMessage({ id: 'key', defaultMessage: 'x' })`.
 */
export function i18nCalls(expression: string): { key: string; fallback: string | null }[] {
  const found: { key: string; fallback: string | null }[] = [];
  const patterns = [
    /(?<![\w.$])\$?t\(\s*(['"])([\s\S]*?)\1\s*(?:,\s*(['"])([\s\S]*?)\3)?/g,
    /(?<![\w.$])(?:i18n|intl|translate|i18next)\.t\(\s*(['"])([\s\S]*?)\1\s*(?:,\s*(['"])([\s\S]*?)\3)?/g,
    /(?:i18nKey|i18nkey|translationKey|messageId|id)\s*[:=]\s*(['"])([\s\S]*?)\1/g,
    /defaultMessage\s*[:=]\s*(['"])([\s\S]*?)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of expression.matchAll(pattern)) {
      // `id=` also matches DOM ids; a key with a dot or a namespace-ish shape is the useful filter.
      const key = unescapeLiteral(match[2] ?? '');
      if (pattern.source.startsWith('(?:i18nKey') && !/[.:_-]/.test(key)) continue;
      const fallback = match[4] ? unescapeLiteral(match[4]) : null;
      if (key) found.push({ key, fallback });
    }
  }
  return found;
}

/**
 * Read the strings inside a `{ … }` expression, in order.
 *
 * Returns the i18n keys it recognized plus any literal text, because a page mixes both: `t('a.b')`
 * next to a hardcoded `"保存"`.
 */
function stringsInExpression(expression: string): { text: string | null; key: string | null }[] {
  const calls = i18nCalls(expression);
  if (calls.length) return calls.map((call) => ({ text: call.fallback, key: call.key }));

  const literal = expressionLiteral(expression);
  if (literal !== null) {
    const text = literal.trim();
    return [{ text: text || null, key: null }];
  }

  // `{items.length} 条` and `{a ? 'x' : 'y'}` are common; what the page shows is the *literal* parts
  // with a value where the expression is. Collecting only those keeps the sentence, and dropping the
  // expression itself keeps `selected.length === 1 ? …` from becoming a marker.
  const pieces: string[] = [];
  for (const match of expression.matchAll(/(['"])([\s\S]*?)\1/g)) {
    const text = unescapeLiteral(match[2]!).trim();
    if (text) pieces.push(text);
  }
  const joined = pieces.join(' ').replace(/\s+/g, ' ').trim();
  if (joined && looksLikeUiText(joined)) return [{ text: joined, key: null }];
  return [];
}

/** Attributes that hold user-visible copy. */
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'alt', 'aria-label', 'label', 'description', 'subtitle', 'caption'];

/**
 * Attributes that name the *key* a string belongs to.
 *
 * HTML cannot say "this text is `checkout.pay_now`" the way `t('checkout.pay_now')` can, and a marker
 * whose key is the raw text only finds an entry in a project that keys by source string. These are the
 * names the marker takes when a page carries one — `data-i18n-key` is what i18next and several other
 * frameworks emit, and `data-key` is the neutral one. `key` itself is deliberately not read: in JSX it
 * is React's list key, which is an index or an id rather than a translation key.
 */
const KEY_ATTRIBUTES = ['data-i18n-key', 'data-key', 'i18n-key'];

interface ParsedElement {
  tag: string;
  attributes: Record<string, string>;
  /**
   * Attributes whose value was written as `{…}` rather than as a literal.
   *
   * The difference matters for copy: `aria-label="复制"` is a string the page will show,
   * `aria-label={label}` is a variable that happens to be named like one. Reading the second as text
   * put the word `label` in the sketch as if it were a translation.
   */
  expressions?: string[];
  /** Alternating runs: literal text and the raw `{…}` expressions, in source order. */
  runs: { kind: 'text' | 'expression'; value: string }[];
  children: ParsedElement[];
}

/**
 * Scan JSX/TSX into an element tree.
 *
 * Tolerant by design: anything it does not understand is skipped rather than fatal, because this runs
 * over real application code, not over a grammar. It tracks a frame stack so nesting survives
 * fragments (`<>`), self-closing tags, and components.
 */
export function parseJsx(source: string): ParsedElement[] {
  const roots: ParsedElement[] = [];
  const stack: { element: ParsedElement; tag: string }[] = [];
  const tokenizer: Tokenizer = { source, position: 0 };

  const currentChildren = (): ParsedElement[] | null => (stack.length ? stack[stack.length - 1]!.element.children : roots);
  const pushText = (value: string): void => {
    const children = currentChildren();
    if (!children || !value.trim()) return;
    const owner = stack.length ? stack[stack.length - 1]!.element : null;
    if (!owner) return;
    owner.runs.push({ kind: 'text', value });
  };

  while (tokenizer.position < source.length) {
    const char = source[tokenizer.position]!;
    const next = source[tokenizer.position + 1];

    if (char === '/' && next === '/') {
      tokenizer.position = skipLineComment(source, tokenizer.position);
      continue;
    }
    if (char === '/' && next === '*') {
      tokenizer.position = skipBlockComment(source, tokenizer.position);
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      tokenizer.position = skipString(source, tokenizer.position);
      continue;
    }
    if (char === '{') {
      // Outside a JSX element a `{` opens a *block*, not an expression container. Treating it as one
      // and skipping to the matching brace swallowed the entire component body — braces are how a
      // function body is written, so the scanner found no elements at all in any real page.
      if (!stack.length) {
        tokenizer.position += 1;
        continue;
      }
      const { text, end } = readBraces(source, tokenizer.position);
      const inner = text.slice(1, -1).trim();
      const owner = stack[stack.length - 1]!.element;
      // `{/* … */}` is a comment in JSX and renders nothing.
      const isComment = inner.startsWith('/*') || inner.startsWith('//');
      if (isComment) {
        tokenizer.position = end;
        continue;
      }
      // A container may hold UI rather than a value: `{items.map((row) => <li>{row}</li>)}` is where a
      // list's rows live, and skipping it wholesale would draw every list as an empty box.
      if (inner.includes('<')) {
        const nested = parseJsx(inner);
        if (nested.length) {
          owner.children.push(...nested);
          tokenizer.position = end;
          continue;
        }
      }
      owner.runs.push({ kind: 'expression', value: text });
      tokenizer.position = end;
      continue;
    }
    if (char === '<') {
      // A closing tag is always a tag.
      if (next !== '/' && !looksLikeTagStart(source, tokenizer.position)) {
        // `<` is also TypeScript's generic bracket and JavaScript's comparison operator, and reading
        // `useState<Foo>` or `a < b` as an opening tag swallows the file: the fake element never
        // closes, so every real element becomes its child.
        tokenizer.position += 1;
        continue;
      }
      // Closing tag.
      if (next === '/') {
        const close = source.indexOf('>', tokenizer.position);
        if (close === -1) break;
        const tag = source.slice(tokenizer.position + 2, close).trim();
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index]!.tag === tag) {
            stack.length = index;
            break;
          }
        }
        tokenizer.position = close + 1;
        continue;
      }
      // Comment.
      if (source.startsWith('<!--', tokenizer.position)) {
        const end = source.indexOf('-->', tokenizer.position);
        tokenizer.position = end === -1 ? source.length : end + 3;
        continue;
      }
      // Fragment.
      if (next === '>') {
        const element: ParsedElement = { tag: '', attributes: {}, runs: [], children: [] };
        currentChildren()!.push(element);
        stack.push({ element, tag: '' });
        tokenizer.position += 2;
        continue;
      }
      const nameMatch = /^[A-Za-z][\w.:-]*/.exec(source.slice(tokenizer.position + 1));
      if (!nameMatch) {
        tokenizer.position += 1;
        continue;
      }
      const tag = nameMatch[0];
      let cursor = tokenizer.position + 1 + tag.length;
      let attributesText = '';
      // Attributes: read until the closing `>` of the opening tag, respecting quoted values and braces.
      while (cursor < source.length) {
        const attrChar = source[cursor]!;
        if (attrChar === '>') break;
        if (attrChar === '"' || attrChar === "'") {
          const end = skipString(source, cursor);
          attributesText += source.slice(cursor, end);
          cursor = end;
          continue;
        }
        if (attrChar === '{') {
          const { text, end } = readBraces(source, cursor);
          attributesText += text;
          cursor = end;
          continue;
        }
        attributesText += attrChar;
        cursor += 1;
      }
      const selfClosing = attributesText.trimEnd().endsWith('/');
      if (selfClosing) attributesText = attributesText.trimEnd().slice(0, -1);

      const parsed = parseAttributes(attributesText);
      const element: ParsedElement = {
        tag,
        attributes: parsed.attributes,
        ...(parsed.expressions.length ? { expressions: parsed.expressions } : {}),
        runs: [],
        children: [],
      };
      currentChildren()!.push(element);
      tokenizer.position = cursor + 1;
      if (!selfClosing && !VOID_ELEMENTS.has(tag.toLowerCase())) stack.push({ element, tag });
      continue;
    }
    // Plain text between tags — up to the next tag *or* the next `{…}`. Stopping only at `<` swallowed
    // the expression that follows a word (`已选 {n} 项` became one run of source code), and with it
    // every string inside a `{/* comment */}`.
    let end = tokenizer.position;
    while (end < source.length && source[end] !== '<' && source[end] !== '{') end += 1;
    pushText(source.slice(tokenizer.position, end));
    tokenizer.position = end;
  }

  return roots;
}

/**
 * Is this `<` the start of an element, or a type parameter / comparison operator?
 *
 * The tell is what precedes it. An element appears where an *expression* may begin: after `(`, `{`,
 * `,`, `=`, `:`, `;`, `?`, `&&`, `=>`, `>` — or after a keyword, `return <div>` being the commonest
 * line of JSX there is. A generic or a comparison follows an identifier, `)`, `]` or a literal, and
 * `useState<Foo>` treated as a tag would never close.
 *
 * The keyword case is why this looks at the last *word* and not only the last character: `return` ends
 * in a letter, so a character-only rule reads `return <div>` as `return < div`.
 */
function looksLikeTagStart(source: string, index: number): boolean {
  const before = source.slice(0, index).replace(/\s+$/, '');
  if (/(?:^|[\s;{(,:=!&|?])(?:return|yield|await|else|do|case|default|typeof|in|of)$/.test(before)) return true;
  const last = before.slice(-1);
  if (last === '>') return true; // `=> <div>` and `a > <b>`
  return !/[\w$)\]'"`]/.test(last);
}

const VOID_ELEMENTS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'track', 'area', 'base', 'col', 'embed', 'param', 'wbr']);

function parseAttributes(text: string): { attributes: Record<string, string>; expressions: string[] } {
  const attributes: Record<string, string> = {};
  const expressions: string[] = [];
  const pattern = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([\s\S]*?)\})/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[name] = value;
    if (match[4] !== undefined) expressions.push(name);
  }
  // Bare attributes (`disabled`, `bordered`) matter for drawing decisions.
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z_:][\w.:-]*)(?=\s|$)/g)) {
    const name = match[1]!;
    if (!(name in attributes) && !['className', 'class'].includes(name)) attributes[name] = 'true';
  }
  return { attributes, expressions };
}

/* --------------------------------------------------------------- HTML scan */

/** HTML is JSX's simpler cousin; the same scanner reads it once the void elements are known. */
export function parseHtml(source: string): ParsedElement[] {
  const withoutDoctype = source.replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  return parseJsx(withoutDoctype);
}

/* ---------------------------------------------------------- element → node */

function keyForAttributes(element: ParsedElement, keys: Record<string, string> | undefined, strings: { text: string; key: string }[]): { text: string; key: string } | null {
  for (const attribute of TEXT_ATTRIBUTES) {
    // `title={t('x')}` is resolved at runtime; `title="保存"` is the string the page shows.
    if (element.expressions?.includes(attribute)) continue;
    const raw = element.attributes[attribute];
    if (!raw || raw === 'true') continue;
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!looksLikeUiText(text)) continue;
    const key = keys?.[text] ?? text;
    strings.push({ text, key });
    return { text, key };
  }
  return null;
}

/** The strings a set of runs produces, in document order, with the key each one resolves to. */
function runsToPieces(
  runs: { kind: 'text' | 'expression'; value: string }[],
  keys: Record<string, string> | undefined,
): { text: string; key: string }[] {
  const pieces: { text: string; key: string }[] = [];
  // A sentence interrupted by a value — `还有 {n} 个，见项目列表。` — arrives as text, expression, text.
  // The browser renders one line, so the halves are buffered and flushed together; splitting them
  // produced two markers for one sentence ("还有", "个，见项目列表。"), neither of which is copy.
  let buffer = '';
  const flush = (): void => {
    // Only collapse runs of whitespace; `已选{n}项` must come out as `已选 项` → `已选项`, not with a
    // space between the CJK characters. The join below adds the separator where the script wants one.
    const collapsed = buffer.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
    buffer = '';
    const tidied = tidyCjk(collapsed);
    if (tidied) pieces.push({ text: tidied, key: keys?.[tidied] ?? tidied });
  };
  for (const run of runs) {
    if (run.kind === 'text') {
      buffer += run.value;
      continue;
    }
    const found = stringsInExpression(run.value);
    if (!found.length) {
      // The value itself is not text; keep the sentence flowing around it. A space is right between
      // Latin words and wrong inside CJK, so it is decided by what surrounds the gap.
      buffer += bufferedSeparator(buffer);
      continue;
    }
    flush();
    for (const entry of found) {
      const text = (entry.text ?? entry.key ?? '').trim();
      if (!text) continue;
      pieces.push({ text, key: keys?.[text] ?? entry.key ?? text });
    }
  }
  flush();
  return pieces.filter((piece) => looksLikeUiText(piece.text));
}

function toNode(
  element: ParsedElement,
  options: ExtractOptions,
  strings: { text: string; key: string }[],
  depth: number,
): UiNode | null {
  if (depth > 40) return null;
  const namespace = options.namespace ?? '';
  const children = (element.children ?? [])
    .map((child) => toNode(child, options, strings, depth + 1))
    .filter((node): node is UiNode => node !== null);

  const pieces = runsToPieces(element.runs, options.keys);
  const own = pieces.length
    ? pieces.reduce(
        (acc, piece) => ({ text: `${acc.text} ${piece.text}`.trim(), key: acc.key ?? (options.keys?.[piece.text] ? piece.key : null) }),
        { text: '', key: null as string | null },
      )
    : null;
  if (pieces.length) strings.push(...pieces);

  const attributeText = keyForAttributes(element, options.keys, strings);
  const explicitKey = KEY_ATTRIBUTES.map((attribute) => element.attributes[attribute]).find(
    (value) => value && value !== 'true' && !element.expressions?.includes('data-key'),
  );
  const kind = kindOf(element.tag, element.attributes);
  // Whatever the page says about how this element looks — its tag's rules, its classes, its inline
  // style, in that order. `undefined` means "draw it the way this kind of element is drawn".
  const style = styleForElement(element, options.styleSheet);
  const styled = <T extends UiNode>(node: T): T => (style ? { ...node, style } : node);

  // A container's text becomes a label when it has none of its own — a `<button>Save</button>` inside a
  // `<div>` should read as a button, not as an empty box with a floating caption.
  const text = own?.text || attributeText?.text || null;

  // Leaf kinds draw their own shape. A component *named* like one but wrapping other elements is not
  // a leaf: `<Field>` contains a label and an input, and drawing it as an input threw both away.
  const leaf = kind === 'input' || kind === 'image' || kind === 'icon' || kind === 'divider';
  const isLeaf = leaf && children.length === 0;
  if (isLeaf) {
    // A picture the page carries with it (`<img src="data:image/png;base64,…">`) is drawn; a URL or a
    // path is not, because the platform never fetches anything. Oversized ones fall back too.
    const src = element.attributes.src;
    const inline =
      kind === 'image' && src && src.length <= MAX_INLINE_IMAGE_CHARS && UI_IMAGE_DATA_PATTERN.test(src) ? src : undefined;
    return styled({
      type: kind as UiNode['type'],
      ...(text ? { text } : {}),
      ...(inline ? { src: inline } : {}),
      ...(text && explicitKey ? { key: explicitKey } : {}),
      ...(namespace ? { namespace } : {}),
    });
  }

  // Same rule as the leaf kinds: a text-ish element that *wraps* other elements is a container. A
  // `<span>` holding two `<span>`s is a layout slot, and returning the text node without its children
  // lost the strings inside them.
  if (kind === 'text' && children.length === 0) {
    // A text-ish element with nothing to say is not drawn: `<span>{expr}</span>` where the expression
    // is not a literal has no label, and an empty text node would only add noise to the picture.
    if (!text) return null;
    return styled({
      type: 'text',
      role: roleForTag(element.tag, element.attributes.role),
      ...(text ? { text } : {}),
      ...(text && explicitKey ? { key: explicitKey } : {}),
      ...(namespace ? { namespace } : {}),
    });
  }

  const containerKind: UiNode['type'] | null = leaf || kind === 'text' ? 'section' : kind;
  if (containerKind === null || containerKind === 'section' || containerKind === 'row' || containerKind === 'card') {
    // A grouping element with its own text and no children drawn is a text node; one with children
    // keeps them and, if it also carries text, keeps the text on the group.
    if (!children.length) {
      if (!text) return null;
      return styled({
        type: 'text',
        role: roleForTag(element.tag, element.attributes.role),
        text,
        ...(namespace ? { namespace } : {}),
      });
    }
    if (kind === null) {
      // An element we do not draw — `<Step title="…">`, a layout wrapper, a provider. Its children are
      // kept, and its *own* text (usually an attribute like `title=`) comes with them: collapsing the
      // wrapper and dropping its text was how a page's section headings disappeared.
      if (!text) {
        if (children.length === 1) return children[0]!;
        return { type: 'section', ...(namespace ? { namespace } : {}), children };
      }
      const label: UiNode = styled({
        type: 'text',
        role: roleForTag(element.tag, element.attributes.role),
        text,
        ...(namespace ? { namespace } : {}),
      });
      if (children.length === 0) return label;
      if (children.length === 1) {
        const only = children[0]!;
        // A single child that draws no text of its own can take the label, keeping the tree shallow.
        if (!only.text && (only.type === 'text' || only.type === 'button' || only.type === 'badge')) {
          return { ...only, text };
        }
      }
      return { type: 'section', ...(namespace ? { namespace } : {}), children: [label, ...children] };
    }
  }

  // `<nav><h1>课程详情</h1></nav>` is a bar with a title, which is what a nav node means by `text`:
  // keeping the heading as a child would lay it out beside the bar's actions instead of in it.
  if (containerKind === 'nav' && !text && children.length === 1 && children[0]!.type === 'text' && children[0]!.text) {
    const title = children[0]!;
    const merged = mergeStyles(style, title.style);
    return {
      type: 'nav',
      text: title.text,
      // The bar's own styling first, so the title's typography wins where they disagree.
      ...(Object.keys(merged).length ? { style: merged } : {}),
      ...(namespace ? { namespace } : {}),
    };
  }

  const node: UiNode = styled({ type: containerKind ?? 'section' });
  if (namespace) node.namespace = namespace;

  // A `row` of several short siblings — a toolbar, a button pair — is drawn side by side.
  const className = element.attributes.className ?? element.attributes.class ?? '';
  const gridColumns = /(?:^|\s)(?:sm:|md:|lg:)?grid-cols-([1-6])/.exec(className);
  // Flex direction decides the drawing. `flex` alone is a *row* in CSS (the default), `flex-col` is a
  // column, and a grid is a row of equal cells — reading those is what makes a header's two ends sit
  // side by side and a footer's buttons share one line instead of stacking into a list.
  if (gridColumns) {
    node.type = 'row';
    node.columns = Math.min(6, Number(gridColumns[1]));
  } else if (
    // Whole class tokens only: `flex-1`, `flex-none` and `flex-wrap` are sizing and wrapping utilities,
    // not `display: flex`. Matching the prefix turned every `flex-1` column into a row and drew their
    // children on top of each other.
    /(?:^|\s)(?:sm:|md:|lg:|xl:)?(?:inline-)?flex(?=\s|$)/.test(className) &&
    !/(?:^|\s)(?:sm:|md:|lg:|xl:)?flex-col(?=\s|$)/.test(className) &&
    !/(?:^|\s)(?:sm:|md:|lg:|xl:)?grid(?=\s|$)/.test(className)
  ) {
    node.type = 'row';
    node.columns = Math.min(6, Math.max(1, children.length));
  }
  if (/(?:^|\s)border\b/.test(className) || element.attributes.bordered === 'true') node.bordered = true;

  if (explicitKey && text) node.key = explicitKey;

  if (children.length && text) {
    // A container does not draw its own text — a `section` is a box and a `button` draws one label —
    // so a string that belongs to one becomes a child. In a button that child is its label, drawn
    // inside the button's frame; in a section it is a caption above its contents. Either way every
    // string keeps a marker of its own.
    children.unshift({
      type: 'text',
      role: roleForTag(element.tag, element.attributes.role),
      text,
      ...(namespace ? { namespace } : {}),
    });
  } else if (text) {
    node.text = text;
  }

  if (children.length) node.children = children;
  return node;
}

/**
 * Read a page (or a fragment of one) into a `UiSpec`.
 *
 * The root is always a `screen` so the renderer has a canvas to lay out into; a fragment's elements
 * become its children.
 */
export function extractUiSpec(source: string, fileName: string, options: ExtractOptions = {}): ExtractResult {
  const warnings: string[] = [];
  const strings: { text: string; key: string }[] = [];
  const isJson = /\.json$/i.test(fileName);
  if (isJson) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `${fileName} 是 JSON，请直接用 ui 字段上传，不需要从源码提取。`, 422);
  }

  // Program code is not copy. A `<script>` body and a `<style>` body are text to a scanner and would
  // otherwise be read as UI strings — a page with one inline script produced a marker whose text was
  // `const x = 1`, and a page with a stylesheet produced markers for its CSS.
  const withoutCode = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // The stylesheets are read for colour, not applied: every rule that survives becomes one of the
  // properties the renderer draws, and nothing in a stylesheet is ever interpreted as CSS.
  const inlineCss = [...withoutCode.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? '').join('\n');
  const provided = options.css ? parseStyleSheet(options.css) : { rules: [], variables: {} };
  const own = inlineCss.trim() ? parseStyleSheet(inlineCss) : { rules: [], variables: {} };
  // The page's own rules come after the provided stylesheet, so they win where both say something.
  const styleSheet = options.styleSheet ?? {
    rules: [...provided.rules, ...own.rules],
    variables: { ...provided.variables, ...own.variables },
  };
  const withSheet: ExtractOptions = { ...options, styleSheet };

  const markup = withoutCode.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const elements = /\.html?$/i.test(fileName) ? parseHtml(markup) : parseJsx(markup);

  const nodes = elements
    .map((element) => toNode(element, withSheet, strings, 1))
    .filter((node): node is UiNode => node !== null);

  if (!nodes.length) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `在 ${fileName} 里没有找到任何界面元素。这个提取器读的是 JSX/TSX 或 HTML 的标签结构；` +
        '如果这个页面用的是别的框架（SwiftUI、Compose、Vue 模板…），请直接把界面写成 ui 描述再上传。',
      422,
    );
  }

  const maxNodes = options.maxNodes ?? MAX_UI_NODES;
  if (strings.length > maxNodes) {
    warnings.push(`页面里有 ${strings.length} 个字符串，只取了前 ${maxNodes} 个（平台单个屏幕的标记上限是 400）。`);
  }
  const kept = strings.slice(0, maxNodes);

  // A node's label is the *join* of the pieces it was built from ("(no namespace) · rev"), so asking
  // whether its text equals one of the kept pieces dropped every joined line — the whole node went
  // with it, which is how a detail card's metadata disappeared from the sketch.
  const isKeptText = (text: string): boolean =>
    kept.some((entry) => entry.text === text || text.includes(entry.text));

  // Controls that are worth keeping even when they carry no string: dropping them left a settings
  // page as a list of labels with no switches beside them, which is not the screen anyone is on.
  const drawsItself = new Set<UiNode['type']>(['switch', 'slider', 'image', 'icon', 'divider', 'input']);

  const pick = (node: UiNode): UiNode | null => {
    // Drop nodes whose only purpose was to carry a string we did not keep, so the picture and the
    // markers stay in step.
    const children = (node.children ?? []).map(pick).filter((child): child is UiNode => child !== null);
    const carriesText = Boolean(node.text);
    const keepText = !carriesText || isKeptText(node.text!);
    if (!children.length && !keepText && !drawsItself.has(node.type)) return null;
    const next: UiNode = { ...node };
    if (!keepText) delete next.text;
    if (children.length) next.children = children;
    else delete next.children;
    return next;
  };

  const bodyBackground = styleSheet.rules
    .filter((rule) => rule.kind === 'tag' && rule.selector === 'body' && rule.declarations['background-color'])
    .map((rule) => rule.declarations['background-color']!)
    .pop();
  const root: UiNode = {
    type: 'screen',
    ...(bodyBackground ? { style: { background: bodyBackground } } : {}),
    children: nodes.map(pick).filter((node): node is UiNode => node !== null),
  };
  if (options.namespace) root.namespace = options.namespace;

  return { root, strings: kept, elementCount: nodes.length, warnings };
}

/** Build the spec a caller uploads, from a page's source. */
export function buildUiSpec(
  source: string,
  fileName: string,
  options: ExtractOptions & {
    name: string;
    platform?: string;
    locale?: string;
    width?: number;
    height?: number;
    theme?: UiTheme;
  },
): { spec: UiSpec; strings: { text: string; key: string }[]; warnings: string[] } {
  const extracted = extractUiSpec(source, fileName, options);
  const spec: UiSpec = {
    name: options.name,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.width ? { width: options.width } : {}),
    ...(options.height ? { height: options.height } : {}),
    root: extracted.root,
  };
  return { spec, strings: extracted.strings, warnings: extracted.warnings };
}
