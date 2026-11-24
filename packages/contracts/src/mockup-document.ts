import { parseHtml } from './ui-extract';

/**
 * The page itself, kept whole.
 *
 * The other inputs *redraw* the screen. `ui` and `html` are read into an element tree and drawn as
 * the platform's own SVG wireframe — which is why a page whose look comes from a stylesheet, a web
 * font or a 400 KB illustration arrives as grey boxes: the picture is ours, not the page's. A
 * `document` upload is the page. The markup is stored as it was sent, the editor renders it in a
 * sandboxed frame, and the assets come with it (inlined by the caller, or fetched by the browser that
 * displays it — never by the platform).
 *
 * What this file owns is the part that has to be true before that can work: recognising a whole
 * document, deriving the markers from the key attributes in the markup, and counting what the page
 * brought with it so the report can say what is still missing.
 *
 * Scripts are kept but never run. That is the "动态数据除外" half of the contract: the replica is the
 * page's *appearance*, not its behaviour, so a table that would be filled by a fetch stays as the
 * empty skeleton the markup describes — and the platform promises that by never executing anything.
 */

/**
 * How much markup one screen may carry.
 *
 * Sized against the 4 MB request body the MCP transport and this route share: a document travels as
 * JSON, so quoting alone costs a few percent, and the markers and metadata ride in the same body.
 */
export const MAX_DOCUMENT_CHARS = 3_000_000;

/** One state of the page, as the caller's own markup. */
export interface MockupDocumentFrame {
  title: string;
  html: string;
}

export interface MockupDocument {
  frames: MockupDocumentFrame[];
}

/** The key attributes, in the order a caller is most likely to have written them. */
const KEY_ATTRIBUTES = ['data-i18n-key', 'data-key', 'i18n-key', 'data-i18n'] as const;

/** Elements whose text is not copy, whatever it looks like. */
const NON_COPY_TAGS = new Set(['script', 'style', 'template', 'noscript']);

/** Attributes that name the component an element belongs to. */
const COMPONENT_ATTRIBUTES = ['data-component', 'data-testid'] as const;

/**
 * Utility-class prefixes, so a Tailwind-styled element is not mistaken for a named component.
 *
 * The document path reads components only to fill the legend ("this page is made of a policy-card, a
 * brand-mark…"), so a false positive is noise rather than a wrong marker. Still, `flex` and `p-4` are
 * not component names and listing them would make the legend useless.
 */
const UTILITY_CLASS = /^(?:flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|container|truncate|sr-only|[a-z]+-(?:\d|\[|px|auto|full|screen|none|center|between|around|start|end|wrap|nowrap|hidden|visible|solid|dashed|white|black|current))/;

/**
 * Is this source a whole page rather than a fragment?
 *
 * The distinction is the whole reason the replica path can be automatic: a full page is handed to the
 * page, and a fragment — a component file, a snippet — still goes to the renderer, because there is no
 * document to render and the wireframe is then the only thing that can show it. Deliberately generous
 * about what counts as a page (`<head>`, `<body>` or the doctype, in any case), because being wrong in
 * the fragment direction means the caller gets a redrawn page they did not ask for.
 */
export function isFullDocument(source: string): boolean {
  // Deliberately narrower than "mentions HTML": a `<body>` or `<head>` tag appears in snippets too,
  // and a snippet routed to the replica path would be stored and rendered as a page that has no
  // document around it. A whole page declares itself with a doctype or an `<html>` element — which is
  // what an export from a browser or a saved file always has.
  return /<!doctype\s+html|<html[\s>]/i.test(source);
}

/**
 * Normalise the three ways a caller can hand over a page into one shape.
 *
 * `document` is the explicit field, `html` is the field callers already use (a full page in it is a
 * page), and `frames` carries the states. A single page becomes one frame titled `默认`, so the editor
 * has one shape to render whichever way it arrived.
 */
export function normalizeDocument(input: {
  document?: string | null;
  html?: string | null;
  frames?: readonly { title: string; html?: string | null; document?: string | null }[] | null;
}): MockupDocument {
  const frames: MockupDocumentFrame[] = [];
  for (const frame of input.frames ?? []) {
    const html = frame.document ?? frame.html;
    if (html) frames.push({ title: frame.title, html });
  }
  if (!frames.length) {
    const html = input.document ?? input.html;
    if (html) frames.push({ title: '默认', html });
  }
  const total = frames.reduce((sum, frame) => sum + frame.html.length, 0);
  if (total > MAX_DOCUMENT_CHARS) {
    throw new DocumentTooLargeError(total);
  }
  return { frames };
}

/** Thrown rather than built into a `LocaleHubError`, which lives in another package's layer. */
export class DocumentTooLargeError extends Error {
  constructor(readonly chars: number) {
    super(`The page is ${chars} characters, over the ${MAX_DOCUMENT_CHARS} limit`);
    this.name = 'DocumentTooLargeError';
  }
}

interface Element {
  tag: string;
  attributes: Record<string, string>;
  runs: { kind: 'text' | 'expression'; value: string }[];
  children: Element[];
}

/** Everything a keyed element tells the platform about itself. */
export interface DocumentMarker {
  key: string;
  namespace: string;
  text: string;
  frame: string;
  component: string | null;
}

/** The literal text inside an element, whitespace-collapsed and capped. */
function literalText(element: Element, budget = 400): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (node: Element): void => {
    if (length > budget) return;
    if (NON_COPY_TAGS.has(node.tag)) return;
    for (const run of node.runs) {
      if (run.kind !== 'text') continue;
      const text = run.value.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      parts.push(text);
      length += text.length;
    }
    for (const child of node.children) walk(child);
  };
  walk(element);
  return parts.join(' ').slice(0, budget);
}

/** The component name an element declares, by attribute first and then by class name. */
function declaredComponent(element: Element): string | null {
  for (const attribute of COMPONENT_ATTRIBUTES) {
    const value = element.attributes[attribute]?.trim();
    if (value) return value.slice(0, 64);
  }
  const classes = (element.attributes.class ?? '').split(/\s+/).filter(Boolean);
  for (const name of classes) {
    if (UTILITY_CLASS.test(name)) continue;
    // A component name is a word that is not a bare utility: `policy-card`, `brandMark`, `Card`.
    if (/^[a-zA-Z][\w-]*$/.test(name) && (name.includes('-') || /[A-Z]/.test(name))) return name.slice(0, 64);
  }
  return null;
}

/**
 * How many component names the markup declares, wherever they are.
 *
 * Counted over every element rather than over the markers, because the question the report asks is
 * "did the caller name its components", and a name on an element that carries no key is still a name.
 */
export function markupComponents(document: MockupDocument): number {
  const names = new Set<string>();
  for (const frame of document.frames) {
    const tree = parseHtml(frame.html) as unknown as Element[];
    const walk = (element: Element): void => {
      const name = declaredComponent(element);
      if (name) names.add(name);
      for (const child of element.children ?? []) walk(child);
    };
    for (const root of tree) walk(root);
  }
  return names.size;
}

/**
 * The markers a page carries, read from the key attributes in its markup.
 *
 * No coordinates: the page's layout is decided by a browser, and the platform does not run one. The
 * editor measures the rendered frame and puts the boxes where the elements actually are, which is the
 * only way the box can be right for a font the platform has never seen. What is stored here is
 * everything that is *not* geometric: which key, which namespace, which state, which component, and
 * the text the markup shows.
 */
export function documentMarkers(
  document: MockupDocument,
  options: { namespace?: string | null } = {},
): DocumentMarker[] {
  const markers: DocumentMarker[] = [];
  for (const frame of document.frames) {
    const tree = parseHtml(frame.html) as unknown as Element[];
    const walk = (element: Element, component: string | null, namespace: string): void => {
      const own = declaredComponent(element) ?? component;
      const elementNamespace = element.attributes['data-namespace']?.trim() || namespace;
      let key: string | null = null;
      for (const attribute of KEY_ATTRIBUTES) {
        // Taken verbatim: a key with a trailing space is a different key from the one without it, and
        // real string tables contain them (`"如需变更学习设备，点击 "`). Trimming here rewrote the
        // caller's key into one the project did not have, and the report then blamed the caller for a
        // key that was there all along. Whitespace-only is not a key at all.
        const value = element.attributes[attribute];
        if (value === undefined || value.trim() === '') continue;
        key = value;
        break;
      }
      if (key && !NON_COPY_TAGS.has(element.tag)) {
        markers.push({
          key: key.slice(0, 512),
          namespace: elementNamespace.slice(0, 255),
          text: literalText(element),
          frame: frame.title,
          component: own,
        });
      }
      for (const child of element.children) walk(child, own, elementNamespace);
    };
    for (const element of tree) walk(element, null, options.namespace ?? '');
  }
  return markers;
}

export interface DocumentAssetCounts {
  /** Assets carried inside the markup: `data:` URIs, inline SVG. */
  inline: number;
  /** Assets the viewer's browser will fetch over the network (an `https:` URL). */
  remote: number;
  /** Assets referenced by a relative path, which nothing can resolve: the replica would 404. */
  local: number;
  /** `<script>` elements. Kept, never run. */
  scripts: number;
  /** Stylesheets and `<style>` blocks the page brought with it. */
  styles: number;
  /**
   * Pictures the page brought with it: `<img>`, an SVG `<image>`, a CSS `background-image`.
   *
   * Deliberately not counting inline `<svg>`. A shape written into the markup is something the caller
   * drew, not something the project supplied, and the two answer different questions: "did the screen's
   * artwork arrive" is the one a translator looking at a wireframe is asking.
   */
  pictures: number;
  /** Inline `<svg>` shapes: artwork drawn in the markup rather than brought from the project. */
  shapes: number;
  /**
   * Elements the page places at a coordinate: `position: absolute` / `fixed` declarations.
   *
   * Counted because it is what makes a replica judgeable. A page arranged by flow hands the placement
   * to the browser's layout engine, so a wrong number is absorbed into a plausible-looking layout and
   * nothing can be checked; a page of coordinates shows its mistakes as overlap, gaps and overflow.
   */
  positioned: number;
  /** `display: flex` / `grid` declarations: elements placed by the layout engine, not by a number. */
  flow: number;
  /**
   * Boxes that hide whatever does not fit them: a fixed pixel `height` together with `overflow: hidden`.
   *
   * The one defect a picture cannot recover from. A real screen arrived with `.screen{height:844px;
   * overflow:hidden}` and content laid out to 1507px, so 27 of its 42 marked strings sat outside the box
   * and were discarded *before* anything was drawn — 64% of the copy, invisible to every later check
   * because the only artefact left is the picture. The declaration is visible in the markup even though
   * the overflow is not: finding what actually spilled needs a layout engine, and this is the warning
   * that says to go and look.
   */
  clipped: number;
  /** Distinct colours the page names, so "it arrived monochrome" is answerable. */
  colours: number;
}

/** `url(...)` targets in a stylesheet, which are assets too — a background is a picture. */
function cssUrls(html: string): string[] {
  return [...html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((match) => match[1]!.trim());
}

/** Classify one asset reference. */
function classifyAsset(reference: string): 'inline' | 'remote' | 'local' {
  const value = reference.trim();
  if (/^data:/i.test(value)) return 'inline';
  if (/^(?:https?:)?\/\//i.test(value)) return 'remote';
  // A fragment or an empty reference is not an asset; treat `#…` as inline so it is not counted as a
  // missing file, which is what a caller would otherwise be told to go and inline.
  if (!value || value.startsWith('#')) return 'inline';
  return 'local';
}

/**
 * What the page brought with it.
 *
 * Counted rather than judged: whether a remote asset is acceptable is the caller's decision, and the
 * report's job is to say which ones are missing, not to have an opinion about the others.
 */
export function documentAssets(document: MockupDocument): DocumentAssetCounts {
  const counts: DocumentAssetCounts = { inline: 0, remote: 0, local: 0, scripts: 0, styles: 0, pictures: 0, shapes: 0, positioned: 0, flow: 0, clipped: 0, colours: 0 };
  const colours = new Set<string>();
  for (const frame of document.frames) {
    const html = frame.html;
    counts.scripts += (html.match(/<script[\s>]/gi) ?? []).length;
    counts.styles += (html.match(/<style[\s>]/gi) ?? []).length + (html.match(/<link[^>]+rel\s*=\s*['"]?stylesheet/gi) ?? []).length;
    // `pictures` is what the page *brought*; `shapes` is what the caller drew. `<image>` is the SVG
    // element that carries a real raster, so it belongs with the pictures.
    counts.pictures +=
      (html.match(/<img[\s>]/gi) ?? []).length +
      (html.match(/<image[\s>]/gi) ?? []).length +
      (html.match(/background-image\s*:/gi) ?? []).length;
    counts.shapes += (html.match(/<svg[\s>]/gi) ?? []).length;
    // How the page is placed. Only the CSS the markup itself carries is readable — a linked stylesheet
    // is an asset the caller was told to inline, and an unreadable one simply contributes nothing here
    // rather than being guessed at.
    const css = [
      ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]!),
      ...[...html.matchAll(/\sstyle\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]!),
    ].join('\n');
    counts.positioned += (css.match(/position\s*:\s*(?:absolute|fixed)\b/gi) ?? []).length;
    counts.flow += (css.match(/display\s*:\s*(?:inline-)?(?:flex|grid)\b/gi) ?? []).length;
    // A box that hides its overflow *and* has a fixed height is a box whose content can be discarded.
    // Counted per declaration block rather than per property: `height` and `overflow` only clip together
    // when they sit on the same rule. `!important` and stray whitespace are tolerated; a `height` in
    // another unit is not a fixed pixel height and is left alone.
    for (const block of css.split('}')) {
      const [, declarations = ''] = block.includes('{') ? [block.slice(0, block.indexOf('{')), block.slice(block.indexOf('{') + 1)] : ['', block];
      if (!/overflow\s*:\s*hidden/i.test(declarations)) continue;
      if (!/height\s*:\s*\d+(?:\.\d+)?px/i.test(declarations)) continue;
      counts.clipped += 1;
    }
    for (const match of html.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']*)["']/gi)) {
      const value = match[1]!;
      // A link to another page is not an asset; only what the browser would fetch to paint the frame.
      if (/\.(?:css|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|mp4|webm|ico)(?:\?|#|$)/i.test(value) || /^data:/i.test(value) || /^(?:https?:)?\/\//i.test(value)) {
        counts[classifyAsset(value)] += 1;
      }
    }
    for (const match of html.matchAll(/srcset\s*=\s*["']([^"']*)["']/gi)) {
      for (const candidate of match[1]!.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) counts[classifyAsset(url)] += 1;
      }
    }
    for (const url of cssUrls(html)) counts[classifyAsset(url)] += 1;
    for (const match of html.matchAll(/#[0-9a-f]{3,8}\b/gi)) colours.add(match[0].toLowerCase());
  }
  counts.colours = colours.size;
  return counts;
}

/**
 * Whether two frames are the same page.
 *
 * Whitespace-insensitive, because a state copied and reformatted is still a copy, and the report's
 * point is that a translator cannot tell three identical pictures apart.
 */
export function framesAreCopies(document: MockupDocument): number {
  const seen = new Map<string, number>();
  for (const frame of document.frames) {
    const signature = frame.html.replace(/\s+/g, ' ').trim();
    seen.set(signature, (seen.get(signature) ?? 0) + 1);
  }
  return [...seen.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
}

export interface DocumentFrameFit {
  /** Coordinates boxes with all four numbers in px — everything a layout engine is not needed for. */
  measured: number;
  /**
   * Coordinates boxes whose position is not fully stated (`right:`/`bottom:`, percentages, `auto`).
   *
   * Reported rather than guessed at: an element pinned to the right edge fits by construction, and
   * calling it an overflow because the numbers are missing would be a finding about the checker.
   */
  unmeasured: number;
  /** Furthest right / bottom edge among the measured boxes, in CSS px. */
  maxRight: number;
  maxBottom: number;
  pastRight: number;
  pastBottom: number;
  /** The canvas the page declares for itself, when a rule names one. */
  declared: { width: number; height: number; selector: string } | null;
  /** The worst edge as a multiple of the frame. 1.0 means it fits exactly. */
  ratio: number;
}

const BOX_DECLARATION = /position\s*:\s*(?:absolute|fixed)/i;
const DECLARED_CANVAS = /(?:screen|frame|canvas|page|artboard)/i;

/** px numbers out of one declaration block, keyed by property. */
function declarationNumbers(block: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const match of block.matchAll(/(left|top|width|height)\s*:\s*(-?\d+(?:\.\d+)?)px/gi)) {
    out[match[1]!.toLowerCase()] = Number(match[2]);
  }
  return out;
}

/**
 * How far the page's own coordinate system runs past the frame it will be rendered into.
 *
 * The frame is the platform's: one fixed phone size per platform (`UI_VIEWPORTS`), because a replica
 * exists to show a screen at the size the screen is — and the caller does not get to widen it, so a page
 * laid out for a different canvas does not fail loudly. It renders, clipped, and the reader sees a
 * half-empty screen or a blank one while everything here looks fine. Measured against the real uploads:
 * 19 of 29 Android pages had boxes past the frame (none of the 32 iOS ones did), the worst declaring a
 * 412×4250 canvas, and a login screen whose content ran to 1371px rendered as an empty grey page.
 *
 * Where the overrun comes from is nearly always the same confusion: Android layout values are dp, a
 * screenshot of the same screen is 2× or 2.625× (412dp is 824 or 1080 px wide), and reading one as the
 * other scales the whole page. So the report says the number and the ratio, and leaves the diagnosis to
 * whoever knows which file they read.
 *
 * A declaration block is the unit of measurement — inline `style="…"` and CSS rule bodies alike — and a
 * block counts as a box only when it places itself at a coordinate with all four numbers in px. That is
 * the same regex-level view `documentAssets` takes, with the same ceiling: what actually spills needs a
 * layout engine, and this is the number that says to go and look.
 */
export function documentFrameFit(
  document: { frames: readonly { html: string }[] },
  frame: { width: number; height: number },
): DocumentFrameFit {
  const fit: DocumentFrameFit = {
    measured: 0,
    unmeasured: 0,
    maxRight: 0,
    maxBottom: 0,
    pastRight: 0,
    pastBottom: 0,
    declared: null,
    ratio: 1,
  };

  for (const page of document.frames) {
    const html = page.html;
    // Every declaration block: the inline styles, and the bodies of the `<style>` rules.
    //
    // The stylesheet is split on `}` rather than matched with a regex over the whole page — the same
    // reading `documentAssets` does, and for a measured reason: a pattern like `([^{}<>]*)\{([^{}]*)\}` is
    // quadratic on a page with one large inlined asset, and this function then takes 64 seconds on a
    // 424 kB upload, inside the tenant transaction that expires after 5.
    const blocks: { selector: string; body: string }[] = [];
    for (const sheet of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      for (const chunk of sheet[1]!.split('}')) {
        const at = chunk.indexOf('{');
        if (at >= 0) blocks.push({ selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1) });
      }
    }
    for (const tag of html.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)) {
      const style = /style\s*=\s*["']([^"']*)["']/i.exec(tag[0]!)?.[1];
      if (style === undefined) continue;
      // The element's first class stands in for a selector: an inline
      // `class="screen" style="width:412px;height:1371px"` states the same canvas a `.screen{…}` rule does.
      const className = /class\s*=\s*["']([^"']*)["']/i.exec(tag[0]!)?.[1]?.trim().split(/\s+/)[0];
      blocks.push({ selector: className ? `.${className}` : '', body: style });
    }

    for (const block of blocks) {
      if (!BOX_DECLARATION.test(block.body)) continue;
      const numbers = declarationNumbers(block.body);
      const placesItself = /\b(?:left|right)\s*:/i.test(block.body) && /\b(?:top|bottom)\s*:/i.test(block.body);
      if (!placesItself) continue;
      const complete =
        numbers.left !== undefined && numbers.top !== undefined && numbers.width !== undefined && numbers.height !== undefined;
      if (!complete) {
        fit.unmeasured += 1;
        continue;
      }
      fit.measured += 1;
      const right = numbers.left! + numbers.width!;
      const bottom = numbers.top! + numbers.height!;
      fit.maxRight = Math.max(fit.maxRight, right);
      fit.maxBottom = Math.max(fit.maxBottom, bottom);
      if (right > frame.width + 0.5) fit.pastRight += 1;
      if (bottom > frame.height + 0.5) fit.pastBottom += 1;
    }

    // A rule that names the screen and states both dimensions is the page telling us its own canvas.
    for (const block of blocks) {
      if (!block.selector || !DECLARED_CANVAS.test(block.selector)) continue;
      const numbers = declarationNumbers(block.body);
      if (numbers.width === undefined || numbers.height === undefined) continue;
      const declared = { width: numbers.width, height: numbers.height, selector: block.selector };
      // The widest declaration wins: a page that states several is stating its own size somewhere.
      if (!fit.declared || declared.width * declared.height > fit.declared.width * fit.declared.height) fit.declared = declared;
    }
  }

  fit.ratio = Math.round(Math.max(fit.maxRight / frame.width, fit.maxBottom / frame.height) * 100) / 100;
  return fit;
}
