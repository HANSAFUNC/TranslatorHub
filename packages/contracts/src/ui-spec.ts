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
  'screen',
  'section',
  'row',
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

export const uiSpecSchema = z.object({
  name: z.string().min(1).max(120),
  platform: z.string().max(40).optional(),
  locale: z.string().max(40).optional(),
  /** Canvas size. The caller picks it because it decides how the wireframe is laid out. */
  width: z.number().int().min(64).max(8192).optional(),
  height: z.number().int().min(64).max(8192).optional(),
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

  if (deepest > MAX_UI_DEPTH) issues.push(`ui 的嵌套层级是 ${deepest}，上限 ${MAX_UI_DEPTH}`);
  if (nodes > MAX_UI_NODES) issues.push(`ui 有 ${nodes} 个元素，上限 ${MAX_UI_NODES}`);
  if (!spec.root.text && !(spec.root.children ?? []).length) {
    issues.push('ui.root 既没有 text 也没有 children，画不出任何东西');
  }
  return issues;
}

/* ------------------------------------------------------------------ geometry */

export interface UiBox {
  node: UiNode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The box the marker should cover, when the node carries a translatable string. */
  marker: boolean;
}

export interface MarkerGeometry {
  key: string;
  namespace: string;
  text: string;
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

interface LayoutState {
  boxes: UiBox[];
  nodes: number;
  truncated: boolean;
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

  const push = (height: number, marker: boolean, boxWidth = width, boxX = x, boxY = y): number => {
    state.boxes.push({ node, x: boxX, y: boxY, width: boxWidth, height, marker });
    return height;
  };

  switch (node.type) {
    case 'text': {
      const role = node.role ?? 'body';
      const fontSize = FONT_SIZE[role];
      const lines = wrapText(node.text ?? '', fontSize, width);
      const height = Math.max(node.height ?? 0, lines.length * fontSize * LINE_HEIGHT);
      state.boxes.push({ node, x, y, width, height, marker: Boolean(node.text) });
      return height;
    }
    case 'button':
    case 'badge': {
      const fontSize = node.type === 'button' ? FONT_SIZE.body : FONT_SIZE.caption;
      const padding = node.type === 'button' ? 20 : 12;
      const inner = node.children ?? [];
      // A button with children is compound (`<Button><Icon/><span>Save</span></Button>`): the frame is
      // sized around them and they are drawn inside it, left to right. Without this the children had
      // markers but no ink — the label sat on an empty box.
      if (inner.length) {
        const laid: number[] = [];
        let cursor = x + padding;
        const available = Math.max(1, width - padding * 2);
        const each = Math.max(1, available / inner.length);
        const height = node.height ?? (node.type === 'button' ? 38 : 24);
        state.boxes.push({ node, x, y, width: Math.min(width, each * inner.length + padding * 2), height, marker: false });
        for (const child of inner) {
          const before = state.boxes.length;
          const used = layoutNode(child, cursor, y + (height - Math.min(height, 20)) / 2, each, state, depth + 1);
          if (state.boxes.length > before) cursor += each;
          laid.push(used);
        }
        return height;
      }
      const textWidth = measureText(node.text ?? '', fontSize) + padding * 2;
      const boxWidth = Math.min(width, Math.max(node.width ?? 0, textWidth));
      const height = node.height ?? (node.type === 'button' ? 38 : 22);
      state.boxes.push({ node, x, y, width: boxWidth, height, marker: Boolean(node.text) });
      return height;
    }
    case 'input': {
      const height = node.height ?? 38;
      state.boxes.push({ node, x, y, width, height, marker: Boolean(node.text) });
      return height;
    }
    case 'image': {
      const height = node.height ?? 120;
      const boxWidth = Math.min(width, node.width ?? width);
      state.boxes.push({ node, x, y, width: boxWidth, height, marker: false });
      return height;
    }
    case 'icon':
      state.boxes.push({ node, x, y, width: node.width ?? 20, height: node.height ?? 20, marker: false });
      return node.height ?? 20;
    case 'divider': {
      state.boxes.push({ node, x, y, width, height: node.height ?? 1, marker: false });
      return node.height ?? 1;
    }
    case 'row': {
      const children = node.children ?? [];
      if (!children.length) return 0;
      const columns = Math.max(1, Math.min(6, node.columns ?? children.length));
      const cellWidth = Math.max(1, (width - GAP * (columns - 1)) / columns);
      // Row heights first, on a scratch layout, so a wrapped line in one cell pushes the next row
      // down for every column. Placing as we go would make each cell's height depend on how many
      // cells had already been laid out, which is the kind of order-dependence that turns a
      // reproducible sketch into a one-off.
      const heights = rowHeights(children, columns, cellWidth);
      let cursor = y;
      for (let index = 0; index < children.length; index += 1) {
        const row = Math.floor(index / columns);
        const column = index % columns;
        if (column === 0 && row > 0) cursor += heights[row - 1]! + GAP;
        layoutNode(children[index]!, x + column * (cellWidth + GAP), cursor, cellWidth, state, depth + 1);
      }
      const lastRow = Math.ceil(children.length / columns) - 1;
      return heights.reduce((sum, height) => sum + height, 0) + GAP * Math.max(0, lastRow);
    }
    case 'screen':
    case 'section':
    case 'card': {
      const padding = node.type === 'card' ? 14 : node.type === 'screen' ? PAGE_PADDING : 0;
      const innerWidth = Math.max(1, width - padding * 2);
      let cursor = y + padding;
      for (const child of node.children ?? []) {
        const before = state.boxes.length;
        const height = layoutNode(child, x + padding, cursor, innerWidth, state, depth + 1);
        if (state.boxes.length === before ) continue;
        cursor += height + GAP;
      }
      const contentHeight = cursor - y - padding - ((node.children ?? []).length ? GAP : 0);
      const height = Math.max(node.height ?? 0, contentHeight + padding * 2);
      push(height, false);
      return height;
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
  truncated: boolean;
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
  const width = spec.width ?? viewport.width;
  const maxHeight = 8192;

  const state: LayoutState = { boxes: [], nodes: 0, truncated: false };
  const contentHeight = layoutNode(root, 0, 0, width, state, 0);
  let height = Math.max(spec.height ?? viewport.height, contentHeight);

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
      x: clamp01(box.x / width),
      y: clamp01(box.y / height),
      width: clamp01(box.width / width),
      height: clamp01(box.height / height),
    });
  }

  return { width, height, boxes, markers, truncated: state.truncated };
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

const COLORS = {
  page: '#ffffff',
  heading: '#09090b',
  subheading: '#18181b',
  body: '#3f3f46',
  label: '#52525b',
  caption: '#71717a',
  border: '#d4d4d8',
  panel: '#fafafa',
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
  parts.push(`<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${COLORS.page}"/>`);

  for (const box of layout.boxes) {
    const { node, x, y, width, height } = box;
    const rect = (fill: string, stroke?: string, radius = 6): string =>
      `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${radius}" fill="${fill}"${
        stroke ? ` stroke="${stroke}" stroke-width="1"` : ''
      }/>`;
    const label = (text: string, fontSize: number, fill: string, dy: number, anchor = 'start'): string => {
      const tx = anchor === 'middle' ? round(x + width / 2) : round(x + (node.type === 'button' || node.type === 'badge' ? 10 : 0));
      return `<text x="${tx}" y="${round(y + dy)}" font-size="${fontSize}" fill="${fill}"${anchor === 'middle' ? ' text-anchor="middle"' : ''}>${escapeXml(text)}</text>`;
    };

    switch (node.type) {
      case 'screen':
        break;
      case 'section':
        if (node.bordered) parts.push(rect(COLORS.panel, COLORS.border));
        break;
      case 'card':
        parts.push(rect(COLORS.panel, COLORS.border, 10));
        break;
      case 'row':
        break;
      case 'divider':
        parts.push(
          `<line x1="${round(x)}" y1="${round(y)}" x2="${round(x + width)}" y2="${round(y)}" stroke="${COLORS.border}" stroke-width="1"/>`,
        );
        break;
      case 'image':
        parts.push(rect(COLORS.image, COLORS.border));
        parts.push(
          `<path d="M ${round(x)} ${round(y + height)} L ${round(x + width)} ${round(y)}" stroke="${COLORS.border}" stroke-width="1"/>`,
        );
        break;
      case 'icon':
        parts.push(`<circle cx="${round(x + width / 2)}" cy="${round(y + height / 2)}" r="${round(Math.min(width, height) / 2)}" fill="${COLORS.icon}"/>`);
        break;
      case 'button':
        parts.push(rect(COLORS.button, undefined, 8));
        if (node.text) parts.push(label(node.text, FONT_SIZE.body, COLORS.buttonText, height / 2 + 5, 'middle'));
        break;
      case 'badge':
        parts.push(rect(COLORS.badge, COLORS.border, 11));
        if (node.text) parts.push(label(node.text, FONT_SIZE.caption, COLORS.label, height / 2 + 4, 'middle'));
        break;
      case 'input': {
        parts.push(rect('#ffffff', COLORS.border, 8));
        if (node.text) parts.push(label(node.text, FONT_SIZE.body, COLORS.caption, height / 2 + 5));
        break;
      }
      case 'text': {
        const role = node.role ?? 'body';
        const fontSize = FONT_SIZE[role];
        const fill = role === 'heading' ? COLORS.heading : role === 'subheading' ? COLORS.subheading : role === 'caption' ? COLORS.caption : role === 'label' ? COLORS.label : COLORS.body;
        const lines = wrapText(node.text ?? '', fontSize, width);
        lines.forEach((line, index) => {
          parts.push(
            `<text x="${round(x)}" y="${round(y + fontSize * 0.95 + index * fontSize * LINE_HEIGHT)}" font-size="${fontSize}"${role === 'heading' ? ' font-weight="600"' : ''} fill="${fill}">${escapeXml(line)}</text>`,
          );
        });
        break;
      }
      default:
        break;
    }
  }

  parts.push('</svg>');
  return parts.join('');
}

export interface RenderedSketch {
  svg: string;
  width: number;
  height: number;
  markers: MarkerGeometry[];
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
    nodes: layout.boxes.length,
    truncated: layout.truncated,
  };
}
