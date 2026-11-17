import { z } from 'zod';

/**
 * A UI described as data, and the wireframe the platform draws from it.
 *
 * `upload_screen_mockup` takes a picture plus markers, which means the caller has to *draw* the
 * screen and measure every string by hand — or run a browser and screenshot it. Neither is what an
 * agent reading a repository can do with what it has: it has the page's source. This module is the
 * other input shape: the caller describes the page's elements, and the platform lays them out
 * deterministically and computes the marker geometry itself.
 *
 * Pure and browser-safe on purpose (`node:` imports would break the web bundle): the CLI renders a
 * local page with it, the API renders a spec a caller sent, and both produce the same picture for the
 * same input — which is what makes "the sketch matches the page" a property of the code rather than
 * of who drew it.
 */

/**
 * The element kinds a spec may contain.
 *
 * Deliberately small. A wireframe needs to convey "there is a heading here, a button there, a list of
 * rows" — not to reproduce a design system. Every kind here has a distinct, recognizable drawing.
 */
export const UI_NODE_TYPES = [
  'canvas',
  'screen',
  'nav',
  'tabbar',
  'section',
  'row',
  'tabs',
  'switch',
  'slider',
  'card',
  'text',
  'button',
  'input',
  'image',
  'icon',
  'divider',
  'badge',
] as const;

export type UiNodeType = (typeof UI_NODE_TYPES)[number];

/** How a `text` node reads: a size and a colour, nothing more. */
export const UI_TEXT_ROLES = ['heading', 'subheading', 'body', 'label', 'caption'] as const;
export type UiTextRole = (typeof UI_TEXT_ROLES)[number];

/** Font weights as words, so a caller cannot invent 437. */
export const UI_FONT_WEIGHTS = ['regular', 'medium', 'semibold', 'bold'] as const;
export type UiFontWeight = (typeof UI_FONT_WEIGHTS)[number];

/**
 * An inline picture: `data:image/png;base64,…`.
 *
 * The platform never fetches anything, so a sketch can only show an image the caller brought with it.
 * That is what this is for — a logo, a hero, a product photo, base64'd into the payload. A URL is
 * refused rather than drawn as a broken frame, and anything oversized falls back to the placeholder.
 */
export const UI_IMAGE_DATA_PATTERN = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/;

/** One picture, ~300 KB of bytes once decoded. Beyond this the payload stops being a payload. */
export const MAX_INLINE_IMAGE_CHARS = 400_000;
/** All of them together: the stored sketch has its own 2 MB ceiling to stay under. */
export const MAX_INLINE_IMAGE_TOTAL_CHARS = 1_200_000;

const WEIGHT_VALUE: Record<UiFontWeight, number> = { regular: 400, medium: 500, semibold: 600, bold: 700 };

/**
 * A colour the sketch will accept.
 *
 * A wireframe that is grey is not recognisable: the whole point of a sketch is that a translator
 * looks at it and knows which page they are on, and a page is its colours as much as its words. So
 * nodes carry colours — but only in the forms a sketch needs, checked here rather than trusted:
 * these strings end up inside SVG attributes, and an attribute is not a place to put arbitrary text.
 */
/**
 * The named colours a sketch understands, at their CSS values.
 *
 * A short list rather than the whole of `named_colors`: a page that says `color: red` means a red
 * that every reader agrees on, and mapping the common names is what keeps hand-written CSS from
 * losing its colour. Anything outside this list is dropped rather than guessed at.
 */
export const UI_NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  red: '#ff0000',
  maroon: '#800000',
  yellow: '#ffff00',
  olive: '#808000',
  lime: '#00ff00',
  green: '#008000',
  aqua: '#00ffff',
  cyan: '#00ffff',
  teal: '#008080',
  blue: '#0000ff',
  navy: '#000080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  purple: '#800080',
  orange: '#ffa500',
  pink: '#ffc0cb',
  brown: '#a52a2a',
};

export const UI_COLOR_PATTERN =
  /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)|transparent|currentColor|black|white|silver|gr[ae]y|red|maroon|yellow|olive|lime|green|aqua|cyan|teal|blue|navy|fuchsia|magenta|purple|orange|pink|brown)$/i;

export const uiColorSchema = z.string().max(40).regex(UI_COLOR_PATTERN, '颜色只接受 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()');

/**
 * How a node looks.
 *
 * Deliberately a small, closed set of properties rather than CSS: a sketch is drawn by the
 * platform's own renderer, so every property here is one the renderer knows how to draw — and one
 * a caller cannot use to smuggle in something that is not a drawing instruction. Where a node has no
 * style, its type supplies a sensible default (a button is a filled control, a card is a bordered
 * panel), so an unstyled tree still looks like an interface instead of a pile of grey boxes.
 */
export interface UiStyle {
  /** Text colour. */
  color?: string;
  /** Fill behind the node. */
  background?: string;
  /** Border colour; `borderWidth` defaults to 1 when a border colour is given. */
  border?: string;
  borderWidth?: number;
  radius?: number;
  /** Overrides the size the node's type or role would use. */
  fontSize?: number;
  fontWeight?: UiFontWeight;
  align?: 'left' | 'center' | 'right';
  /** Space between the node's edge and its content. */
  paddingX?: number;
  paddingY?: number;
  /** Space between a container's children. */
  gap?: number;
  /** A soft drop shadow, for cards and sheets. */
  shadow?: boolean;
}

export const uiStyleSchema = z.object({
  color: uiColorSchema.optional(),
  background: uiColorSchema.optional(),
  border: uiColorSchema.optional(),
  borderWidth: z.number().min(0).max(8).optional(),
  radius: z.number().min(0).max(64).optional(),
  fontSize: z.number().min(8).max(72).optional(),
  fontWeight: z.enum(UI_FONT_WEIGHTS).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  paddingX: z.number().min(0).max(64).optional(),
  paddingY: z.number().min(0).max(64).optional(),
  gap: z.number().min(0).max(64).optional(),
  shadow: z.boolean().optional(),
});

export interface UiNode {
  type: UiNodeType;
  /** The string shown on screen. For a `text`/`button`/`badge` node this is what gets a marker. */
  text?: string;
  /** An explicit translation key. Falls back to the text itself, which is how some projects key. */
  key?: string;
  namespace?: string;
  role?: UiTextRole;
  /** Drawn with a border — a card or a panel rather than a bare grouping. */
  bordered?: boolean;
  /** Fixed size in the spec's pixels. Omitted means "decided by the layout". */
  width?: number;
  height?: number;
  /** Equal-width columns for a `row` (`grid-cols-3`). */
  columns?: number;
  /** The picture itself, as a base64 data URL. `image` and `icon` nodes only. */
  src?: string;
  /**
   * The component this element is an instance of (`PrimaryButton`, `ProductCard`, `card`).
   *
   * A sketch answers "which screen is this?", and a big part of that answer is "made of these
   * components". The platform numbers them and lists them beside the board; the caller only has to
   * name them, or let the extractor name them from the source.
   */
  component?: string;
  /** How it looks. Omitted means "however this kind of element looks by default". */
  style?: UiStyle;
  children?: UiNode[];
}

export const uiNodeSchema: z.ZodType<UiNode> = z.lazy(() =>
  z.object({
    type: z.enum(UI_NODE_TYPES),
    text: z.string().max(2000).optional(),
    key: z.string().max(512).optional(),
    namespace: z.string().max(255).optional(),
    role: z.enum(UI_TEXT_ROLES).optional(),
    bordered: z.boolean().optional(),
    width: z.number().positive().max(8192).optional(),
    height: z.number().positive().max(8192).optional(),
    columns: z.number().int().min(1).max(6).optional(),
    component: z.string().min(1).max(64).optional(),
    src: z
      .string()
      .max(MAX_INLINE_IMAGE_CHARS)
      .regex(UI_IMAGE_DATA_PATTERN, 'src 只接受 data:image/...;base64 形式的内联图片（平台不联网取图）')
      .optional(),
    style: uiStyleSchema.optional(),
    children: z.array(uiNodeSchema).max(400).optional(),
  }),
);

/**
 * Limits that keep a spec from becoming a denial-of-service.
 *
 * The renderer walks the tree and emits one SVG element per node, so the tree is attacker-controlled
 * work: depth and total node count are both capped, and the marker cap is the same one an upload
 * obeys, because a spec is just another way of producing an upload.
 */
export const MAX_UI_DEPTH = 24;
export const MAX_UI_NODES = 600;
/** A page's source is smaller than a picture of it; this is the cap on the `html` input. */
export const MAX_UI_HTML_CHARS = 1_000_000;

/**
 * How many states one board may hold.
 *
 * A board is read at a glance: past a handful of frames the shapes get small enough that a translator
 * is scrolling rather than comparing, and the point of putting states together is lost.
 */
export const MAX_MOCKUP_FRAMES = 8;

/**
 * The colours a sketch falls back to.
 *
 * A screen transcribed by hand — semantic class names, no colour utilities — carries no palette at
 * all, and a wireframe drawn in greys is both ugly and hard to place. So the platform has a default
 * per platform (an iPhone app is blue, a web app in this codebase is near-black), and a caller that
 * knows its brand can say so once instead of colouring every node.
 */
export interface UiTheme {
  /** Buttons, switches, the filled part of a slider, the selected tab. */
  accent?: string;
  /** The page behind everything. */
  background?: string;
}

export const uiThemeSchema = z.object({
  accent: uiColorSchema.optional(),
  background: uiColorSchema.optional(),
});

/** What an uncoloured screen is drawn with, by platform. */
export function defaultTheme(platform: string | undefined): Required<UiTheme> {
  switch (platform) {
    case 'ios':
      return { accent: '#0a84ff', background: '#f2f2f7' };
    case 'android':
      return { accent: '#1a73e8', background: '#ffffff' };
    default:
      return { accent: '#18181b', background: '#ffffff' };
  }
}

export const uiSpecSchema = z.object({
  /**
   * Optional, and ignored by both upload surfaces — the screen's identity is the `name` of the
   * `upload_screen_mockup` call (or the REST body), and only one of the two can decide it.
   *
   * It used to be required, which is the worst of both: a caller that only wants to describe a
   * screen had to invent a second name, and a caller that filled in both could set them to
   * different values and never be told which one won. The CLI still passes it when rendering a
   * sketch locally.
   */
  name: z.string().min(1).max(120).optional(),
  platform: z.string().max(40).optional(),
  locale: z.string().max(40).optional(),
  /** Canvas size. The caller picks it because it decides how the wireframe is laid out. */
  width: z.number().int().min(64).max(8192).optional(),
  height: z.number().int().min(64).max(8192).optional(),
  /** Brand colours, when the caller knows them and the page does not say. */
  theme: uiThemeSchema.optional(),
  root: uiNodeSchema,
});

export type UiSpec = z.infer<typeof uiSpecSchema>;

/** Screen sizes that match how the sketch is actually looked at. */
export const UI_VIEWPORTS = {
  web: { width: 1280, height: 800 },
  ios: { width: 390, height: 844 },
  android: { width: 412, height: 915 },
  universal: { width: 390, height: 844 },
} as const;

export function defaultViewport(platform: string | undefined): { width: number; height: number } {
  if (platform && platform in UI_VIEWPORTS) return { ...UI_VIEWPORTS[platform as keyof typeof UI_VIEWPORTS] };
  return { ...UI_VIEWPORTS.web };
}

/**
 * What is wrong with a spec, in the caller's terms — empty when nothing is.
 *
 * Returned rather than thrown so both surfaces can answer with the same sentence. The two limits here
 * exist because the renderer's work is proportional to the tree the *caller* sent: without them, one
 * upload could ask the platform to emit an SVG for a million nodes.
 */
export function uiSpecIssues(spec: UiSpec): string[] {
  const issues: string[] = [];
  let nodes = 0;
  let deepest = 0;
  const walk = (node: UiNode, depth: number): void => {
    nodes += 1;
    deepest = Math.max(deepest, depth);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(spec.root, 1);

  let inline = 0;
  const weigh = (node: UiNode): void => {
    inline += node.src?.length ?? 0;
    for (const child of node.children ?? []) weigh(child);
  };
  weigh(spec.root);
  if (inline > MAX_INLINE_IMAGE_TOTAL_CHARS) {
    issues.push(
      `ui 里内联了约 ${Math.round(inline / 1024)} KB 的图片，上限 ${Math.round(MAX_INLINE_IMAGE_TOTAL_CHARS / 1024)} KB——外链图片请自己在本地截图后用 image_base64 上传`,
    );
  }

  if (deepest > MAX_UI_DEPTH) issues.push(`ui 的嵌套层级是 ${deepest}，上限 ${MAX_UI_DEPTH}`);
  if (nodes > MAX_UI_NODES) issues.push(`ui 有 ${nodes} 个元素，上限 ${MAX_UI_NODES}`);
  if (!spec.root.text && !(spec.root.children ?? []).length) {
    issues.push('ui.root 既没有 text 也没有 children，画不出任何东西');
  }
  return issues;
}

/* ------------------------------------------------------------------ geometry */

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiBox {
  node: UiNode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** How deep the node sits, root = 1. Surfaces are painted in this order, parents first. */
  depth: number;
  /** The frame this box was laid out inside, for a sketch that is a board of them. */
  frame?: string;
  /**
   * The component this box belongs to — its own, or the nearest ancestor's.
   *
   * A card's *contents* are the card's: the strings inside it are what a reader means by "this
   * component", and a marker that did not inherit the name could not be grouped with it.
   */
  component?: string;
  /** True on the box that actually declares the component, which is where the badge is drawn. */
  componentRoot?: boolean;
  /**
   * Where the node's own content sits, once its padding is taken off.
   *
   * Markers cover this rather than the whole box: a button's marker should sit on its label, not on
   * the frame around it, and the text is what a translator is being pointed at.
   */
  content: UiRect;
  /** The box the marker should cover, when the node carries a translatable string. */
  marker: boolean;
  /**
   * What the marker covers, when that is not simply the node's content.
   *
   * A string's marker should sit on the thing the reader recognises as carrying it: a button's whole
   * frame, an input's whole field, the cell a tab occupies in its bar. Circling only the glyphs makes
   * a board of labels look like it was annotated by a machine — which it was, and that is the problem.
   */
  markerRect?: UiRect;
  /**
   * The first item of a `tabs` or `tabbar`: the one a screen shows as current.
   *
   * A segmented control with nothing selected reads as three loose words, and a tab bar with nothing
   * highlighted reads as a footer. The first item is the default in both, and a caller that means a
   * different one gives that item its own colour.
   */
  selected?: boolean;
}

const rect = (x: number, y: number, width: number, height: number): UiRect => ({ x, y, width, height });

export interface MarkerGeometry {
  key: string;
  namespace: string;
  text: string;
  /** The frame (state) the marker sits in, when the sketch is a board of them. */
  frame?: string;
  /** The component the element belongs to, matching the canvas legend. */
  component?: string;
  /** Fractions of the image, which is what an upload stores. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAGE_PADDING = 20;
const GAP = 10;
const FONT_SIZE: Record<UiTextRole, number> = { heading: 22, subheading: 17, body: 14, label: 13, caption: 12 };
const LINE_HEIGHT = 1.45;
/** Bar heights for the structural elements, so a nav looks like a nav and not like a paragraph. */
const NAV_HEIGHT = 52;
const TABS_HEIGHT = 34;
const TABBAR_HEIGHT = 56;
const CANVAS_GAP = 32;
/** The annotation rail: a callout column to the right of the board, with a line to each control. */
const RAIL_WIDTH = 280;
const RAIL_LINE = 15;
const RAIL_HEAD = 18;
const RAIL_GAP = 14;
const RAIL_FONT = 12;
/** Room for the component legend under a board that has one. */
const LEGEND_HEIGHT = 46;
const LEGEND_FONT = 13;
const SWITCH_WIDTH = 46;
const SWITCH_HEIGHT = 28;
const SLIDER_HEIGHT = 28;

/** The size a node's text is drawn at: its own if it says so, otherwise whatever its kind uses. */
function fontSizeOf(node: UiNode): number {
  if (node.style?.fontSize) return node.style.fontSize;
  switch (node.type) {
    case 'text':
      return FONT_SIZE[node.role ?? 'body'];
    case 'badge':
      return FONT_SIZE.caption;
    case 'nav':
      return FONT_SIZE.subheading;
    case 'tabs':
    case 'tabbar':
      return FONT_SIZE.label;
    default:
      return FONT_SIZE.body;
  }
}

function weightOf(node: UiNode): number {
  if (node.style?.fontWeight) return WEIGHT_VALUE[node.style.fontWeight];
  if (node.type === 'nav') return WEIGHT_VALUE.semibold;
  if (node.type === 'text' && node.role === 'heading') return WEIGHT_VALUE.semibold;
  return WEIGHT_VALUE.regular;
}

/** Bold text is wider. Not by much, but a label that runs past its box is a label that got cut. */
function weightScale(weight: number): number {
  return weight >= 700 ? 1.06 : weight >= 600 ? 1.04 : weight >= 500 ? 1.02 : 1;
}

function measureStyled(text: string, fontSize: number, weight: number): number {
  return measureText(text, fontSize) * weightScale(weight);
}

function wrapStyled(text: string, fontSize: number, maxWidth: number, weight: number): string[] {
  return wrapText(text, fontSize, maxWidth / weightScale(weight));
}

/** The padding a node has: its own, or the one its kind is drawn with. */
function paddingOf(node: UiNode): { x: number; y: number } {
  const fallback: Record<string, { x: number; y: number }> = {
    button: { x: 18, y: 9 },
    badge: { x: 12, y: 2 },
    input: { x: 12, y: 0 },
    card: { x: 14, y: 14 },
    nav: { x: 16, y: 0 },
    tabs: { x: 4, y: 4 },
    screen: { x: PAGE_PADDING, y: PAGE_PADDING },
  };
  const base = fallback[node.type] ?? { x: 0, y: 0 };
  return { x: node.style?.paddingX ?? base.x, y: node.style?.paddingY ?? base.y };
}

function gapOf(node: UiNode): number {
  return node.style?.gap ?? GAP;
}
/** Rough advance width per character. CJK is full-width; Latin is a bit over half. */
function charWidth(char: string, fontSize: number): number {
  const code = char.codePointAt(0) ?? 0;
  const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? fontSize : fontSize * 0.56;
}

export function measureText(text: string, fontSize: number): number {
  let total = 0;
  for (const char of text) total += charWidth(char, fontSize);
  return total;
}

/** Break a string into lines that fit `maxWidth`, honouring explicit newlines and breaking CJK anywhere. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    let width = 0;
    const words = paragraph.split(/(\s+)/);
    for (const word of words) {
      const wordWidth = measureText(word, fontSize);
      if (width + wordWidth <= maxWidth || current === '') {
        // A single word longer than the line (or CJK, which has no spaces) still has to break.
        if (wordWidth > maxWidth && current === '') {
          let chunk = '';
          let chunkWidth = 0;
          for (const char of word) {
            const cw = charWidth(char, fontSize);
            if (chunkWidth + cw > maxWidth && chunk) {
              lines.push(chunk);
              chunk = '';
              chunkWidth = 0;
            }
            chunk += char;
            chunkWidth += cw;
          }
          current = chunk;
          width = chunkWidth;
          continue;
        }
        current += word;
        width += wordWidth;
        continue;
      }
      lines.push(current.trimEnd());
      current = word.trimStart();
      width = measureText(current, fontSize);
    }
    lines.push(current.trimEnd());
  }
  return lines.length ? lines : [''];
}

/**
 * Boxes in the order a reader meets them: parents before children, layout order within that.
 *
 * The legend numbers components by first appearance, and "first" has to mean the same thing on every
 * render — the layout's own order is post-order for containers, which would number a card's contents
 * before the card.
 */
function boxesInPaintOrder(boxes: UiBox[]): UiBox[] {
  return [...boxes].sort((a, b) => a.depth - b.depth);
}

/** The whole control is what its string is on. */
function markControl(state: LayoutState, node: UiNode, rect: UiRect): void {
  for (let index = state.boxes.length - 1; index >= 0; index -= 1) {
    const box = state.boxes[index]!;
    if (box.node !== node) break;
    box.markerRect = rect;
  }
}

/** The cell an item occupies in a bar: from where the bar starts, the full height of the bar. */
function markCells(state: LayoutState, from: number, rect: UiRect): void {
  for (let index = from; index < state.boxes.length; index += 1) state.boxes[index]!.markerRect = rect;
}

/** Everything the first item of a bar drew is the selected one. */
function markSelected(state: LayoutState, from: number): void {
  for (let index = from; index < state.boxes.length; index += 1) state.boxes[index]!.selected = true;
}

interface LayoutState {
  boxes: UiBox[];
  nodes: number;
  truncated: boolean;
  /**
   * Bars that belong to the bottom edge of the screen rather than to the flow.
   *
   * A tab bar sits at the bottom of the *screen*, not after the last row of content — laying it out
   * inline put it below the fold on every screen whose content is taller than the viewport, which is
   * most of them. They are placed once the canvas height is known, so the picture and their markers
   * still come from one pass.
   */
  docked?: { node: UiNode; x: number; width: number; depth: number; bottom?: number; frame?: string }[];
  /** The frame currently being laid out, stamped onto every box inside it. */
  frame?: string;
  /** The component currently being laid out, inherited by everything inside it. */
  component?: string;
  /** The bottom edge a docked bar belongs to: the screen's, or the frame that holds it. */
  dockBottom?: number;
  /** The viewport a frame is drawn at, so a `screen` inside a canvas knows its own size. */
  viewport?: { width: number; height: number };
}

/**
 * Lay a node out inside `width` starting at `y`, and return the height it used.
 *
 * Vertical flow, like a document: children stack, a `row` puts them side by side, and everything is
 * sized from its text. That is enough to make the picture legible and, more importantly, it is
 * *deterministic* — the same spec always produces the same geometry, so a marker's position is
 * reproducible rather than measured once by whoever drew the screen.
 */
function layoutNode(node: UiNode, x: number, y: number, width: number, state: LayoutState, depth: number): number {
  if (depth > MAX_UI_DEPTH || state.nodes >= MAX_UI_NODES) {
    state.truncated = true;
    return 0;
  }
  state.nodes += 1;

  // A component's name reaches everything inside it, and is taken back afterwards: `<div
  // class="policy-card">` declares a card, and the strings inside it belong to that card.
  const declared = node.component;
  const previous = state.component;
  if (declared) state.component = declared;
  try {
    return placeNode(node, x, y, width, state, depth, declared);
  } finally {
    state.component = previous;
  }
}

function placeNode(node: UiNode, x: number, y: number, width: number, state: LayoutState, depth: number, declared?: string): number {

  const padding = paddingOf(node);
  const push = (height: number, marker: boolean, boxWidth = width, boxX = x, boxY = y, pad = padding): number => {
    state.boxes.push({
      node,
      depth,
      x: boxX,
      y: boxY,
      width: boxWidth,
      height,
      content: rect(
        boxX + pad.x,
        boxY + pad.y,
        Math.max(0, boxWidth - pad.x * 2),
        Math.max(0, height - pad.y * 2),
      ),
      marker,
      ...(state.frame ? { frame: state.frame } : {}),
      ...(state.component ? { component: state.component } : {}),
      ...(declared && declared === state.component ? { componentRoot: true } : {}),
    });
    return height;
  };

  switch (node.type) {
    case 'text': {
      const fontSize = fontSizeOf(node);
      const lines = wrapStyled(node.text ?? '', fontSize, Math.max(1, width - padding.x * 2), weightOf(node));
      const height = Math.max(node.height ?? 0, lines.length * fontSize * LINE_HEIGHT + padding.y * 2);
      return push(height, Boolean(node.text));
    }
    case 'button':
    case 'badge': {
      const fontSize = fontSizeOf(node);
      const weight = weightOf(node);
      const inner = node.children ?? [];
      // A button with children is compound (`<Button><Icon/><span>Save</span></Button>`): the frame is
      // sized around them and they are drawn inside it, left to right. Without this the children had
      // markers but no ink — the label sat on an empty box.
      if (inner.length) {
        let cursor = x + padding.x;
        const available = Math.max(1, width - padding.x * 2);
        const each = Math.max(1, available / inner.length);
        // Tall enough for its own text, or for whatever the children need, whichever is more.
        const height = node.height ?? Math.max(node.type === 'button' ? 38 : 24, fontSize * LINE_HEIGHT + padding.y * 2);
        for (const child of inner) {
          const before = state.boxes.length;
          layoutNode(child, cursor, y + Math.max(0, (height - Math.min(height, 22)) / 2), each, state, depth + 1);
          if (state.boxes.length > before) cursor += each;
        }
        return push(height, false, Math.min(width, each * inner.length + padding.x * 2));
      }
      const textWidth = measureStyled(node.text ?? '', fontSize, weight) + padding.x * 2;
      const boxWidth = Math.min(width, Math.max(node.width ?? 0, textWidth));
      const height = node.height ?? Math.max(node.type === 'button' ? 38 : 22, fontSize * LINE_HEIGHT + padding.y * 2);
      const boxHeight = push(height, Boolean(node.text), boxWidth);
      // A button or a chip is one object: the marker covers the whole control, not the letters in it.
      markControl(state, node, { x, y, width: boxWidth, height: boxHeight });
      return boxHeight;
    }
    case 'input': {
      const height = node.height ?? Math.max(38, fontSizeOf(node) * LINE_HEIGHT + padding.y * 2);
      const used = push(height, Boolean(node.text));
      // The field, not the placeholder text: a placeholder is a hint inside a control a person types in.
      markControl(state, node, { x, y, width, height: used });
      return used;
    }
    case 'image': {
      const height = node.height ?? 120;
      const boxWidth = Math.min(width, node.width ?? width);
      // `alt`/`aria-label` is copy when it is the only name the element has, so it gets a marker.
      return push(height, Boolean(node.text), boxWidth, x, y, { x: 0, y: 0 });
    }
    case 'icon':
      // An icon with a radius is a rounded square (an app icon, a tile); without one it is a circle.
      return push(node.height ?? 20, Boolean(node.text), node.width ?? 20, x, y, { x: 0, y: 0 });
    case 'divider':
      return push(node.height ?? 1, false, width, x, y, { x: 0, y: 0 });
    case 'switch':
    case 'slider': {
      const controlWidth = node.type === 'switch' ? node.width ?? SWITCH_WIDTH : Math.min(width, node.width ?? width);
      const controlHeight = node.height ?? (node.type === 'switch' ? SWITCH_HEIGHT : SLIDER_HEIGHT);
      // A labelled control — `<label class="checkbox">全选</label>`, a settings row — is a label and a
      // control side by side: the string gets its own marker on the left, and the control sits against
      // the right edge, the way it does on a phone.
      if (node.text) {
        const label: UiNode = {
          type: 'text',
          text: node.text,
          ...(node.key ? { key: node.key } : {}),
          ...(node.namespace ? { namespace: node.namespace } : {}),
          ...(node.role ? { role: node.role } : {}),
        };
        const height = Math.max(controlHeight, FONT_SIZE.body * LINE_HEIGHT);
        const labelWidth = Math.max(1, width - controlWidth - 12);
        layoutNode(label, x, y + (height - FONT_SIZE.body * LINE_HEIGHT) / 2, labelWidth, state, depth + 1);
        const control: UiNode = { ...node, text: undefined };
        state.boxes.push({
          node: control,
          depth,
          x: x + width - controlWidth,
          y: y + (height - controlHeight) / 2,
          width: controlWidth,
          height: controlHeight,
          content: rect(x + width - controlWidth, y + (height - controlHeight) / 2, controlWidth, controlHeight),
          marker: false,
          ...(state.frame ? { frame: state.frame } : {}),
          ...(state.component ? { component: state.component } : {}),
        });
        return height;
      }
      return push(controlHeight, false, controlWidth, x, y, { x: 0, y: 0 });
    }
    case 'tabbar': {
      // Like a nav, but it belongs to the bottom edge of the screen: items spread across the full
      // width, each drawing whatever it came with.
      const height = node.height ?? TABBAR_HEIGHT;
      const items = node.children ?? [];
      const each = Math.max(1, width / Math.max(1, items.length));
      items.forEach((item, index) => {
        const before = state.boxes.length;
        layoutNode(item, x + index * each, y + 8, each, state, depth + 1);
        if (index === 0) markSelected(state, before);
        // A tab is a cell, not a line of text: the marker covers the cell a thumb would land on.
        markCells(state, before, { x: x + index * each, y, width: each, height });
      });
      return push(height, false, width, x, y, { x: 0, y: 0 });
    }
    case 'nav': {
      const height = node.height ?? NAV_HEIGHT;
      const actions = node.children ?? [];
      const titleSpace = { x: padding.x, y: Math.max(0, (height - fontSizeOf(node) * LINE_HEIGHT) / 2) };
      if (!node.text) {
        // No title of its own, so the bar's contents are its contents: side by side, in flow. Laying
        // them out as right-hand actions would squeeze them into half the bar for no reason.
        const each = Math.max(1, (width - padding.x * 2) / Math.max(1, actions.length));
        actions.forEach((action, index) => {
          layoutNode(action, x + padding.x + index * each, y + (height - 24) / 2, each, state, depth + 1);
        });
        return push(height, false, width, x, y, titleSpace);
      }
      // Actions sit against the right edge, as they do in a real bar; the title keeps the rest.
      const actionWidth = actions.length ? Math.min(width * 0.5, actions.length * 44) : 0;
      let cursor = x + width - padding.x - actionWidth;
      for (const action of actions) {
        layoutNode(action, cursor, y + (height - 24) / 2, actionWidth / actions.length, state, depth + 1);
        cursor += actionWidth / actions.length;
      }
      const used = push(height, Boolean(node.text), width, x, y, titleSpace);
      // The title's own area of the bar — its half of the width, the bar's full height — rather than the
      // line of text inside it. A nav bar with a small box on its text reads as an annotation on a word.
      markControl(state, node, { x: titleSpace.x, y, width: Math.max(1, width - padding.x * 2 - actionWidth), height });
      return used;
    }
    case 'tabs': {
      const items = node.children ?? [];
      const height = node.height ?? TABS_HEIGHT;
      if (items.length) {
        const available = Math.max(1, width - padding.x * 2);
        const each = available / items.length;
        items.forEach((item, index) => {
          const before = state.boxes.length;
          layoutNode(item, x + padding.x + index * each, y + padding.y, each, state, depth + 1);
          if (index === 0) markSelected(state, before);
          markCells(state, before, { x: x + padding.x + index * each, y, width: each, height });
        });
      }
      return push(height, false, width, x, y, { x: padding.x, y: padding.y });
    }
    case 'row': {
      const children = node.children ?? [];
      if (!children.length) return 0;
      const gap = gapOf(node);
      const columns = Math.max(1, Math.min(6, node.columns ?? children.length));
      const cellWidth = Math.max(1, (width - padding.x * 2 - gap * (columns - 1)) / columns);
      // Row heights first, on a scratch layout, so a wrapped line in one cell pushes the next row
      // down for every column. Placing as we go would make each cell's height depend on how many
      // cells had already been laid out, which is the kind of order-dependence that turns a
      // reproducible sketch into a one-off.
      const heights = rowHeights(children, columns, cellWidth);
      let cursor = y + padding.y;
      for (let index = 0; index < children.length; index += 1) {
        const row = Math.floor(index / columns);
        const column = index % columns;
        if (column === 0 && row > 0) cursor += heights[row - 1]! + gap;
        layoutNode(children[index]!, x + padding.x + column * (cellWidth + gap), cursor, cellWidth, state, depth + 1);
      }
      const lastRow = Math.ceil(children.length / columns) - 1;
      return (
        heights.reduce((sum, height) => sum + height, 0) +
        gap * Math.max(0, lastRow) +
        padding.y * 2
      );
    }
    case 'canvas': {
      // A board of states: each child is a frame drawn at its own viewport size, with its title above
      // it. The point is that a translator sees the same screen in each state it can be in — the empty
      // list, the loading row, the validation error — instead of one picture and a guess.
      const gap = node.style?.gap ?? CANVAS_GAP;
      const frames = node.children ?? [];
      const viewport = state.viewport ?? { width: 390, height: 844 };
      const titleHeight = FONT_SIZE.subheading * LINE_HEIGHT + 8;
      let cursor = x + padding.x;
      let tallest = 0;
      for (const frame of frames) {
        const frameWidth = frame.width ?? viewport.width;
        const frameHeight = frame.height ?? viewport.height;
        const frameTop = y + padding.y + titleHeight;
        if (frame.text) {
          // The frame's title is the platform's annotation, not the page's copy: drawn, never marked.
          state.boxes.push({
            node: { type: 'text', role: 'subheading', text: frame.text, ...(frame.style ? { style: frame.style } : {}) },
            depth,
            x: cursor,
            y: y + padding.y,
            width: frameWidth,
            height: FONT_SIZE.subheading * LINE_HEIGHT,
            content: rect(cursor, y + padding.y, frameWidth, FONT_SIZE.subheading * LINE_HEIGHT),
            marker: false,
          });
        }
        const previousFrame = state.frame;
        const previousBottom = state.dockBottom;
        const previousViewport = state.viewport;
        state.frame = frame.text ?? previousFrame;
        state.viewport = { width: frameWidth, height: frameHeight };
        state.dockBottom = frameTop + frameHeight;
        layoutNode({ ...frame, width: frameWidth, height: frameHeight }, cursor, frameTop, frameWidth, state, depth + 1);
        state.frame = previousFrame;
        state.dockBottom = previousBottom;
        state.viewport = previousViewport;
        cursor += frameWidth + gap;
        tallest = Math.max(tallest, titleHeight + frameHeight);
      }
      const height = node.height ?? tallest + padding.y * 2;
      return push(height, false, Math.max(1, cursor - gap - x + padding.x));
    }
    case 'screen':
    case 'section':
    case 'card': {
      const gap = gapOf(node);
      const children = node.children ?? [];
      const innerWidth = Math.max(1, width - padding.x * 2);
      let cursor = y + padding.y;
      let bottom = y;
      for (const child of children) {
        if (node.type === 'screen' && child.type === 'tabbar') {
          (state.docked ??= []).push({
            node: child,
            x,
            width,
            depth: depth + 1,
            ...(state.dockBottom ? { bottom: state.dockBottom } : {}),
            ...(state.frame ? { frame: state.frame } : {}),
          });
          continue;
        }
        // A nav spans the screen: a page's header is not inset like its content, and drawing it inset
        // is the difference between "a phone screen" and "a box in a box".
        const bleeds = node.type === 'screen' && child.type === 'nav';
        const childY = bleeds && cursor === y + padding.y ? y : cursor;
        const before = state.boxes.length;
        const height = layoutNode(child, bleeds ? x : x + padding.x, childY, bleeds ? width : innerWidth, state, depth + 1);
        if (state.boxes.length === before) continue;
        cursor = childY + height + gap;
        bottom = Math.max(bottom, childY + height);
      }
      // The top padding is already inside `bottom`; the bottom one is added unless there is nothing
      // to pad around.
      const contentHeight = children.length ? bottom - y : 0;
      const sized = node.type === 'screen' && node.height ? node.height : 0;
      const height = Math.max(sized, contentHeight + padding.y * (children.length ? 1 : 2));
      return push(height, false);
    }
    default:
      return 0;
  }
}

/**
 * Per-column heights for a row, so a second line of a grid starts below the tallest cell of the
 * first. Computed on a scratch layout so nothing is recorded twice.
 */
function rowHeights(children: UiNode[], columns: number, cellWidth: number): number[] {
  const heights: number[] = [];
  for (let index = 0; index < children.length; index += columns) {
    const slice = children.slice(index, index + columns);
    heights.push(
      Math.max(
        0,
        ...slice.map((child) => {
          const scratch: LayoutState = { boxes: [], nodes: 0, truncated: false };
          return layoutNode(child, 0, 0, cellWidth, scratch, 0);
        }),
      ),
    );
  }
  return heights;
}

export interface UiLayout {
  width: number;
  height: number;
  boxes: UiBox[];
  /** One per node that carries a string, in reading order. */
  markers: MarkerGeometry[];
  /** The accent and page colour the drawing falls back to. */
  theme: Required<UiTheme>;
  /** The components the board is made of, numbered in the order they first appear. */
  legend: UiLegendItem[];
  /**
   * The annotation rail, when the board has states to compare.
   *
   * A board answers "what does this key read like in each state?" only if the reader can find the same
   * key in every frame. The rail is the answer: a leader line from each key's control out to a callout
   * that lists what every state says there — including the states where the string is not on screen at
   * all, which is itself the answer to a translator's question.
   */
  rail?: UiRail;
  truncated: boolean;
}

export interface UiRailItem {
  key: string;
  /** Where the leader line starts: the control the string sits on. */
  from: { x: number; y: number };
  /** Where the callout sits. */
  y: number;
  /** One line per frame, in board order. */
  lines: { frame: string; text: string }[];
}

export interface UiRail {
  x: number;
  width: number;
  items: UiRailItem[];
}

export interface UiLegendItem {
  /** The number drawn on every instance of this component. */
  index: number;
  name: string;
  count: number;
}

/**
 * Lay a spec out and derive its markers.
 *
 * The image grows to fit the content: a page laid out at 390 px wide may need more than 844 px of
 * height, and cutting it off would hide exactly the UI the sketch exists to show. If it still does
 * not fit the platform's dimension cap, the whole picture is scaled down uniformly, which keeps every
 * marker where it belongs because the markers are fractions of the final image.
 */
export function layoutUiSpec(spec: UiSpec): UiLayout {
  // A namespace set on the screen is the default for everything under it — that is what a caller
  // means by setting it once — and a node that names its own wins.
  const root = spec.root.namespace
    ? inheritNamespace(spec.root, spec.root.namespace)
    : spec.root;
  const viewport = defaultViewport(spec.platform);
  // A board is as wide as its frames: the whole point is to see the states side by side, and a canvas
  // clipped to one viewport would stack them off the right edge.
  const boardWidth = (node: UiNode): number => {
    if (node.type !== 'canvas') return 0;
    const frames = node.children ?? [];
    if (!frames.length) return 0;
    const gap = node.style?.gap ?? CANVAS_GAP;
    const padding = node.style?.paddingX ?? 0;
    const total = frames.reduce((sum, frame) => sum + (frame.width ?? viewport.width), 0) + gap * (frames.length - 1);
    return total + padding * 2;
  };
  const width = spec.width ?? (boardWidth(root) || viewport.width);
  const maxHeight = 8192;

  const state: LayoutState = { boxes: [], nodes: 0, truncated: false };
  const contentHeight = layoutNode(root, 0, 0, width, state, 0);

  // Anything docked to the bottom edge waits for the canvas: it is placed against the bottom of the
  // drawing, whatever the content above it turned out to need.
  const placed = (): number => state.boxes.reduce((lowest, box) => Math.max(lowest, box.y + box.height), 0);
  state.viewport = { width, height: spec.height ?? viewport.height };
  let canvasHeight = Math.max(spec.height ?? viewport.height, contentHeight, placed());
  for (const docked of state.docked ?? []) {
    const barHeight = docked.node.height ?? TABBAR_HEIGHT;
    // Against the bottom of whatever holds it: the whole picture for a plain screen, the frame when the
    // screen is one of several states on a board.
    const bottom = docked.bottom ?? canvasHeight;
    // Its own frame, so the bar's labels are markers of that state like everything else in the frame.
    state.frame = docked.frame;
    layoutNode(docked.node, docked.x, bottom - barHeight, docked.width, state, docked.depth);
    state.frame = undefined;
  }
  canvasHeight = Math.max(canvasHeight, placed());
  /**
   * The canvas covers everything that was drawn into it.
   *
   * A container's height is the sum of its children's *reported* heights, and a node may draw
   * outside the box it reports — a fixed-height bar holding taller content, say. An upload requires
   * every marker to be a fraction of the image, so the image is grown to fit rather than left with
   * markers hanging off the bottom: the guarantee holds by construction instead of by every node
   * type being careful.
   */
  // The legend band, reserved before the height is final: the numbers it explains are drawn on the
  // picture, so it has to be part of it.
  const seen = new Map<string, UiLegendItem>();
  if (canvasHeight > 0) {
    for (const box of boxesInPaintOrder(state.boxes)) {
      // One entry per *instance*: the count answers "how many of these are on this board", which is
      // what a legend is for. The name a marker carries is the inherited one, so its strings group
      // with it either way.
      if (!box.componentRoot || !box.component) continue;
      const existing = seen.get(box.component);
      if (existing) existing.count += 1;
      else seen.set(box.component, { index: seen.size + 1, name: box.component, count: 1 });
    }
  }
  // One component is not a legend, it is a label: a band explaining "this screen is a card" adds a
  // strip to every sketch ever drawn. Two or more is when a reader needs the map.
  const legend = seen.size >= 2 ? [...seen.values()] : [];
  const legendHeight = legend.length ? LEGEND_HEIGHT : 0;
  if (legendHeight) canvasHeight += legendHeight;

  let height = canvasHeight;

  let boxes = state.boxes;
  const scale = height > maxHeight ? maxHeight / height : 1;
  height = Math.min(height, maxHeight);
  if (scale < 1) {
    boxes = boxes.map((box) => ({
      ...box,
      x: box.x * scale,
      y: box.y * scale,
      width: box.width * scale,
      height: box.height * scale,
    }));
  }

  const markers: MarkerGeometry[] = [];
  for (const box of boxes) {
    if (!box.marker) continue;
    const text = box.node.text ?? '';
    if (!text.trim()) continue;
    const key = box.node.key ?? text;
    markers.push({
      key,
      namespace: box.node.namespace ?? '',
      text,
      ...(box.frame ? { frame: box.frame } : {}),
      ...(box.component ? { component: box.component } : {}),
      // The control the string belongs to when there is one, its own text box otherwise.
      ...(() => {
        const rect = box.markerRect ?? box.content;
        return {
          x: clamp01(rect.x / width),
          y: clamp01(rect.y / height),
          width: clamp01(rect.width / width),
          height: clamp01(rect.height / height),
        };
      })(),
    });
  }

  const theme = { ...defaultTheme(spec.platform), ...stripUndefined(spec.theme) };
  const rail = buildRail(markers, width, height);
  if (!rail) {
    return { width, height, boxes, markers, theme, legend, truncated: state.truncated };
  }

  // The rail widens the picture, and the markers are fractions *of the picture* — the whole upload
  // contract is "x is the fraction of the image". So they are remapped once the margin is added, or
  // every box would sit a little to the right of the control it describes.
  const finalWidth = width + rail.width;
  const finalHeight = Math.max(height, (rail.items.at(-1)?.y ?? 0) + RAIL_HEAD + 40);
  const remapped = markers.map((marker) => ({
    ...marker,
    x: clamp01((marker.x * width) / finalWidth),
    width: clamp01((marker.width * width) / finalWidth),
    y: clamp01((marker.y * height) / finalHeight),
    height: clamp01((marker.height * height) / finalHeight),
  }));

  return {
    width: finalWidth,
    height: finalHeight,
    boxes,
    markers: remapped,
    theme,
    legend,
    rail,
    truncated: state.truncated,
  };
}

/**
 * The callouts, when the board shows more than one state.
 *
 * Order is the frames' own: the first state a key appears in leads, and every state gets a line — with
 * an em dash where the string is not on that screen, because "it is not there in the empty state" is
 * exactly what a translator needs to know.
 */
function buildRail(markers: readonly MarkerGeometry[], boardWidth: number, boardHeight: number): UiRail | undefined {
  const frames = [...new Set(markers.map((marker) => marker.frame).filter((frame): frame is string => Boolean(frame)))];
  if (frames.length < 2) return undefined;

  interface Group {
    identity: string;
    key: string;
    anchor: MarkerGeometry;
    lines: { frame: string; text: string }[];
  }
  const groups: Group[] = [];
  for (const marker of markers) {
    const identity = `${marker.namespace}\u0000${marker.key}`;
    let group = groups.find((candidate) => candidate.identity === identity);
    if (!group) {
      group = { identity, key: marker.namespace ? `${marker.namespace}:${marker.key}` : marker.key, anchor: marker, lines: [] };
      groups.push(group);
    }
    const frame = marker.frame ?? '';
    if (!group.lines.some((line) => line.frame === frame)) group.lines.push({ frame, text: marker.text });
  }
  // Every state gets a line, even where the key says nothing at all.
  for (const group of groups) {
    group.lines = frames.map((frame) => group.lines.find((line) => line.frame === frame) ?? { frame, text: '—' });
  }

  let cursor = 24;
  const items: UiRailItem[] = groups.map((group) => {
    const y = cursor;
    cursor += RAIL_HEAD + group.lines.length * RAIL_LINE + RAIL_GAP;
    return {
      key: group.key,
      from: {
        x: (group.anchor.x + (group.anchor.width ?? 0)) * boardWidth,
        y: (group.anchor.y + (group.anchor.height ?? 0) / 2) * boardHeight,
      },
      y,
      lines: group.lines,
    };
  });

  return { x: boardWidth + 24, width: RAIL_WIDTH, items };
}

/** Only the fields the caller actually set; anything else keeps the platform's default. */
function stripUndefined(theme: UiTheme | undefined): UiTheme {
  return {
    ...(theme?.accent ? { accent: theme.accent } : {}),
    ...(theme?.background ? { background: theme.background } : {}),
  };
}

/** Copy a namespace down the tree, leaving any node that names its own alone. */
function inheritNamespace(node: UiNode, namespace: string): UiNode {
  return {
    ...node,
    namespace: node.namespace ?? namespace,
    ...(node.children ? { children: node.children.map((child) => inheritNamespace(child, namespace)) } : {}),
  };
}

/** Keep a fraction inside [0,1] and leave room for the box, so an upload's geometry rules hold. */
function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : Math.round(value * 100000) / 100000;
}

/* ------------------------------------------------------------------ rendering */

/** The default look, used wherever a node carries no style of its own. */
const COLORS = {
  page: '#ffffff',
  heading: '#09090b',
  subheading: '#18181b',
  body: '#3f3f46',
  label: '#52525b',
  caption: '#71717a',
  border: '#e4e4e7',
  panel: '#ffffff',
  track: '#f4f4f5',
  button: '#18181b',
  buttonText: '#fafafa',
  badge: '#f4f4f5',
  image: '#f4f4f5',
  icon: '#a1a1aa',
} as const;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Draw the laid-out boxes as an SVG wireframe.
 *
 * Only shapes and text — no `<script>`, no event attributes, nothing the platform's own SVG check
 * rejects. The output is deterministic for a given spec, so two callers that describe the same page
 * produce byte-identical pictures and a re-upload only replaces the row when the page actually
 * changed.
 */
export function renderUiSvg(layout: UiLayout, fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" font-family="${escapeXml(fontFamily)}">`,
  );
  const accent = layout.theme.accent;
  const screen = layout.boxes.find((box) => box.node.type === 'screen');
  parts.push(
    `<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${escapeXml(screen?.node.style?.background ?? layout.theme.background)}"/>`,
  );

  /**
   * Two passes, and the order matters: every surface first, then everything drawn on top of one.
   *
   * Boxes are recorded in layout order, which is *post-order* for containers — a card's box comes
   * after its children's, because its height is only known once they are laid out. Painting in that
   * order drew the card's opaque background over the text and buttons inside it: the picture was an
   * empty card, and every marker still pointed at a hole. Nothing in the geometry was wrong, which is
   * why only reading the drawn pixels caught it.
   */
  const surfaces: string[] = [];
  const contents: string[] = [];
  const defs: string[] = [];
  let pictures = 0;

  // A parent's surface has to be under its children's, and `layout.boxes` is in post-order for
  // containers — a card's box only exists once its children are measured. Depth is what recovers the
  // nesting: shallower first, and layout order within a depth (a stable sort keeps it).
  const painting = [...layout.boxes].sort((a, b) => a.depth - b.depth);

  for (const box of painting) {
    const { node, x, y, width, height, content } = box;
    const style = node.style ?? {};
    const fontSize = fontSizeOf(node);
    const weight = weightOf(node);

    const panel = (fill: string, stroke: string | undefined, radius: number, inset = 0): string =>
      `<rect x="${round(x + inset)}" y="${round(y + inset)}" width="${round(Math.max(0, width - inset * 2))}" height="${round(Math.max(0, height - inset * 2))}" rx="${round(radius)}" fill="${escapeXml(fill)}"${
        stroke ? ` stroke="${escapeXml(stroke)}" stroke-width="${style.borderWidth ?? 1}"` : ''
      }/>`;
    const line = (text: string, where: UiRect, align: 'left' | 'center' | 'right', fill: string, dy: number): string => {
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
      const tx = align === 'center' ? where.x + where.width / 2 : align === 'right' ? where.x + where.width : where.x;
      return `<text x="${round(tx)}" y="${round(where.y + dy)}" font-size="${round(fontSize)}" fill="${escapeXml(fill)}"${
        weight !== WEIGHT_VALUE.regular ? ` font-weight="${weight}"` : ''
      }${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${escapeXml(text)}</text>`;
    };
    /** A control's label sits in the middle of its content box, wherever its padding put that. */
    const centred = (text: string, fill: string, align: 'left' | 'center' | 'right'): string =>
      line(text, content, align, fill, content.height / 2 + fontSize * 0.36);

    switch (node.type) {
      case 'screen':
        break;
      case 'nav': {
        const fill = style.background ?? COLORS.page;
        surfaces.push(panel(fill, style.border, style.radius ?? 0));
        contents.push(
          `<line x1="${round(x)}" y1="${round(y + height)}" x2="${round(x + width)}" y2="${round(y + height)}" stroke="${escapeXml(style.border ?? COLORS.border)}" stroke-width="1"/>`,
        );
        if (node.text) contents.push(centred(node.text, style.color ?? COLORS.heading, style.align ?? 'left'));
        break;
      }
      case 'section':
        if (style.background || style.border || node.bordered) {
          surfaces.push(panel(style.background ?? COLORS.panel, style.border ?? COLORS.border, style.radius ?? 6));
        }
        break;
      case 'card': {
        if (style.shadow) {
          surfaces.push(
            `<rect x="${round(x)}" y="${round(y + 2)}" width="${round(width)}" height="${round(height)}" rx="${round(style.radius ?? 14)}" fill="#000000" opacity="0.06"/>`,
          );
        }
        surfaces.push(panel(style.background ?? COLORS.panel, style.border ?? COLORS.border, style.radius ?? 14));
        break;
      }
      case 'row':
      case 'tabs': {
        if (node.type === 'tabs') {
          surfaces.push(
            `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${round(style.radius ?? 10)}" fill="${escapeXml(style.background ?? COLORS.track)}"/>`,
          );
        } else if (style.background || style.border) {
          surfaces.push(panel(style.background ?? 'transparent', style.border, style.radius ?? 0));
        }
        break;
      }
      case 'tabbar': {
        surfaces.push(panel(style.background ?? COLORS.page, style.border, style.radius ?? 0));
        contents.push(
          `<line x1="${round(x)}" y1="${round(y)}" x2="${round(x + width)}" y2="${round(y)}" stroke="${escapeXml(style.border ?? COLORS.border)}" stroke-width="1"/>`,
        );
        break;
      }
      case 'switch': {
        // On, and drawn as on: a switch whose state is ambiguous is worse than no switch.
        const fill = style.background ?? accent;
        surfaces.push(panel(fill, style.border, style.radius ?? height / 2));
        const knob = height / 2 - 3;
        contents.push(
          `<circle cx="${round(x + width - height / 2)}" cy="${round(y + height / 2)}" r="${round(knob)}" fill="#ffffff"/>`,
        );
        break;
      }
      case 'slider': {
        const track = Math.max(4, height * 0.18);
        const trackY = y + (height - track) / 2;
        const fill = style.background ?? accent;
        surfaces.push(
          `<rect x="${round(x)}" y="${round(trackY)}" width="${round(width)}" height="${round(track)}" rx="${round(track / 2)}" fill="${escapeXml(COLORS.track)}"/>`,
        );
        // Two thirds along: a slider at rest sits somewhere, and drawing it at zero reads as empty.
        const at = x + width * 0.62;
        contents.push(
          `<rect x="${round(x)}" y="${round(trackY)}" width="${round(at - x)}" height="${round(track)}" rx="${round(track / 2)}" fill="${escapeXml(fill)}"/>`,
          `<circle cx="${round(at)}" cy="${round(y + height / 2)}" r="${round(height / 2)}" fill="#ffffff" stroke="${escapeXml(COLORS.border)}" stroke-width="1"/>`,
        );
        break;
      }
      case 'divider':
        contents.push(
          `<line x1="${round(x)}" y1="${round(y)}" x2="${round(x + width)}" y2="${round(y)}" stroke="${escapeXml(style.border ?? COLORS.border)}" stroke-width="${style.borderWidth ?? 1}"/>`,
        );
        break;
      case 'image': {
        const radius = style.radius ?? 8;
        surfaces.push(panel(style.background ?? COLORS.image, style.border ?? COLORS.border, radius));
        if (node.src) {
          // Clipped to the frame, so a rounded corner stays rounded with a photo in it. The id is the
          // picture's index: unique within the document, and identical on every render.
          const clip = `img${pictures}`;
          pictures += 1;
          defs.push(
            `<clipPath id="${clip}"><rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${round(radius)}"/></clipPath>`,
          );
          contents.push(
            `<image href="${node.src}" x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`,
          );
          break;
        }
        // A picture mark, drawn from the box's own geometry: enough to read as an image at any size.
        const mark = Math.min(width, height) * 0.22;
        const cx = x + width / 2;
        const cy = y + height / 2;
        contents.push(
          `<path d="M ${round(cx - mark)} ${round(cy + mark * 0.6)} L ${round(cx - mark * 0.25)} ${round(cy - mark * 0.5)} L ${round(cx + mark * 0.2)} ${round(cy + mark * 0.05)} L ${round(cx + mark * 0.6)} ${round(cy - mark * 0.35)} L ${round(cx + mark)} ${round(cy + mark * 0.6)} Z" fill="${escapeXml(style.color ?? COLORS.icon)}" opacity="0.55"/>`,
        );
        if (node.text) contents.push(centred(node.text, style.color ?? COLORS.caption, style.align ?? 'center'));
        break;
      }
      case 'icon': {
        const fill = style.background ?? COLORS.icon;
        if (style.radius !== undefined) {
          surfaces.push(
            `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${round(style.radius)}" fill="${escapeXml(fill)}"/>`,
          );
        } else {
          contents.push(
            `<circle cx="${round(x + width / 2)}" cy="${round(y + height / 2)}" r="${round(Math.min(width, height) / 2)}" fill="${escapeXml(fill)}"/>`,
          );
        }
        break;
      }
      case 'button': {
        const fill = style.background ?? accent;
        surfaces.push(panel(fill, style.border, style.radius ?? 10));
        if (node.text) contents.push(centred(node.text, style.color ?? readableOn(fill), style.align ?? 'center'));
        break;
      }
      case 'badge': {
        const fill = style.background ?? COLORS.badge;
        surfaces.push(panel(fill, style.border, style.radius ?? height / 2));
        if (node.text) contents.push(centred(node.text, style.color ?? readableOn(fill), style.align ?? 'center'));
        break;
      }
      case 'input': {
        const fill = style.background ?? '#ffffff';
        surfaces.push(panel(fill, style.border ?? COLORS.border, style.radius ?? 10));
        // A placeholder starts at the left edge of the content box, like a real one does.
        if (node.text) contents.push(centred(node.text, style.color ?? COLORS.caption, style.align ?? 'left'));
        break;
      }
      case 'text': {
        const align = style.align ?? 'left';
        if (box.selected && !style.background) {
          // The current tab or segment: a filled pill behind the label, which is what makes a bar read
          // as a bar with something chosen.
          surfaces.push(
            `<rect x="${round(content.x - 8)}" y="${round(y + 4)}" width="${round(content.width + 16)}" height="${round(height - 8)}" rx="${round((height - 8) / 2)}" fill="${escapeXml(style.color ?? accent)}"/>`,
          );
          const lines = [node.text ?? ''];
          lines.forEach((text) => {
            contents.push(line(text, content, 'center', readableOn(style.color ?? accent), content.height / 2 + fontSize * 0.36));
          });
          break;
        }
        const fill = style.color ?? COLORS[node.role ?? 'body'];
        const lines = wrapStyled(node.text ?? '', fontSize, content.width, weight);
        lines.forEach((text, index) => {
          contents.push(line(text, content, align, fill, fontSize * 0.95 + index * fontSize * LINE_HEIGHT));
        });
        break;
      }
      default:
        break;
    }
  }

  // Component numbers, drawn last: they are annotations over the picture, not part of any frame.
  const numbers = new Map(layout.legend.map((item) => [item.name, item.index]));
  for (const box of boxesInPaintOrder(layout.boxes)) {
    // The badge marks the component's root: numbering every string inside the card as well would say
    // the same thing four times.
    const name = box.componentRoot ? box.component : undefined;
    if (!name) continue;
    const index = numbers.get(name);
    if (!index) continue;
    const cx = box.x + 12;
    const cy = box.y + 13;
    parts.push(
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="9" fill="${escapeXml(accent)}"/>`,
      `<text x="${round(cx)}" y="${round(cy + 4)}" font-size="11" font-weight="600" fill="${escapeXml(readableOn(accent))}" text-anchor="middle">${index}</text>`,
    );
  }

  if (layout.legend.length) {
    // One row under the board: a number, a name, how many instances. The numbers match the badges.
    const bandTop = layout.height - LEGEND_HEIGHT;
    parts.push(
      `<rect x="0" y="${round(bandTop)}" width="${layout.width}" height="${LEGEND_HEIGHT + 1}" fill="${escapeXml(COLORS.track)}"/>`,
      `<line x1="0" y1="${round(bandTop)}" x2="${layout.width}" y2="${round(bandTop)}" stroke="${escapeXml(COLORS.border)}" stroke-width="1"/>`,
    );
    let cursor = 16;
    for (const item of layout.legend) {
      const label = `${item.index}  ${item.name}${item.count > 1 ? ` ×${item.count}` : ''}`;
      const width = measureText(label, LEGEND_FONT) + 26;
      parts.push(
        `<circle cx="${round(cursor + 11)}" cy="${round(bandTop + LEGEND_HEIGHT / 2)}" r="9" fill="${escapeXml(accent)}"/>`,
        `<text x="${round(cursor + 11)}" y="${round(bandTop + LEGEND_HEIGHT / 2 + 4)}" font-size="11" font-weight="600" fill="${escapeXml(readableOn(accent))}" text-anchor="middle">${item.index}</text>`,
        `<text x="${round(cursor + 26)}" y="${round(bandTop + LEGEND_HEIGHT / 2 + 5)}" font-size="${LEGEND_FONT}" fill="${escapeXml(COLORS.body)}">${escapeXml(item.name)}${item.count > 1 ? ` ×${item.count}` : ''}</text>`,
      );
      cursor += width + 14;
    }
  }

  if (layout.rail) {
    // The callout column: a leader line from each key's control out to the margin, then what every
    // state says there. It is the board's own answer to "where does this string live, and what does it
    // read like in each state" — a translator should not have to hunt for the same key in four frames.
    const rail = layout.rail;
    const last = rail.items.at(-1);
    const bottom = (last ? last.y + RAIL_HEAD + last.lines.length * RAIL_LINE : 0) + 12;
    parts.push(
      `<line x1="${round(rail.x - 16)}" y1="12" x2="${round(rail.x - 16)}" y2="${round(bottom)}" stroke="${escapeXml(COLORS.border)}" stroke-width="1"/>`,
    );
    for (const item of rail.items) {
      parts.push(
        `<circle cx="${round(item.from.x)}" cy="${round(item.from.y)}" r="3" fill="${escapeXml(accent)}"/>`,
        `<path d="M ${round(item.from.x + 3)} ${round(item.from.y)} L ${round(rail.x - 18)} ${round(item.from.y)} L ${round(rail.x - 18)} ${round(item.y + RAIL_HEAD / 2)} L ${round(rail.x - 6)} ${round(item.y + RAIL_HEAD / 2)}" fill="none" stroke="${escapeXml(accent)}" stroke-width="1" opacity="0.6"/>`,
        `<text x="${round(rail.x)}" y="${round(item.y + 11)}" font-size="${RAIL_FONT}" font-weight="600" fill="${escapeXml(COLORS.heading)}">${escapeXml(item.key.slice(0, 34))}</text>`,
      );
      item.lines.forEach((line, index) => {
        const y = item.y + RAIL_HEAD + index * RAIL_LINE + 10;
        parts.push(
          `<text x="${round(rail.x)}" y="${round(y)}" font-size="${RAIL_FONT - 1}" fill="${escapeXml(COLORS.caption)}">${escapeXml(line.frame.slice(0, 8))}</text>`,
          `<text x="${round(rail.x + 52)}" y="${round(y)}" font-size="${RAIL_FONT - 1}" fill="${escapeXml(line.text === '—' ? COLORS.icon : COLORS.body)}">${escapeXml(line.text.slice(0, 30))}${line.text.length > 30 ? '…' : ''}</text>`,
        );
      });
    }
  }

  parts.push(...defs, ...surfaces, ...contents);
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Black or white, whichever reads on this fill.
 *
 * A label is the one thing a sketch cannot afford to lose, and a caller that sets a light background
 * on a button — `bg-white text-zinc-900` is a real pattern — would otherwise get white text on white.
 */
function readableOn(color: string): string {
  return isLight(color) ? COLORS.heading : COLORS.buttonText;
}

function isLight(color: string): boolean {
  const value = color.trim().toLowerCase();
  if (value === 'white') return true;
  if (value === 'black') return false;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  let r: number;
  let g: number;
  let b: number;
  if (hex) {
    const digits = hex[1]!;
    const full = digits.length <= 4 ? digits.split('').map((digit) => digit + digit).join('') : digits;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    const rgb = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(value);
    // `transparent` and `currentColor` are not fills at all: the page shows through, so text reads dark.
    if (!rgb) return true;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

export interface RenderedSketch {
  svg: string;
  width: number;
  height: number;
  markers: MarkerGeometry[];
  /** The components the board is made of, numbered as the badges on the picture are. */
  legend: UiLegendItem[];
  /** The callouts beside the board, one per key, when there are states to compare. */
  rail?: UiRail;
  nodes: number;
  truncated: boolean;
}

/** Render a spec: lay it out, draw it, and hand back the markers in the same pass. */
export function renderUiSketch(spec: UiSpec): RenderedSketch {
  const layout = layoutUiSpec(spec);
  return {
    svg: renderUiSvg(layout),
    width: layout.width,
    height: layout.height,
    markers: layout.markers,
    legend: layout.legend,
    ...(layout.rail ? { rail: layout.rail } : {}),
    nodes: layout.boxes.length,
    truncated: layout.truncated,
  };
}
