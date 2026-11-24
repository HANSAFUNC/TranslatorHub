/**
 * A running screen, read back into markers.
 *
 * Every other way a screen gets into this platform is a transcription. A replica is the caller's HTML;
 * a drawn sketch is the caller's description of a layout; a design draft is a picture with hand-measured
 * boxes. This one is neither: `uiautomator dump` reports where each element actually is, and
 * `screencap` gives the pixels that are actually there. Nothing is estimated, so nothing can be
 * estimated wrong — which is the whole reason a native app that can be run should be captured rather
 * than rebuilt as HTML.
 *
 * The surprising part, and the reason this is not a five-line parser: most copy in a modern app is not
 * in `text`. It is in `content-desc` — the accessibility description an `ImageView` caption or a custom
 * `View` button carries — and one node often carries several lines of it joined by a newline. A parser
 * that read `text` alone would report a screen of 42 elements as having one string, which is exactly
 * what an early version of this file did against a real device.
 */

export interface DumpBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DumpNode {
  /** The visible label, when the element has one. */
  text: string;
  /** The accessibility description: the usual carrier of an app's copy. */
  description: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  scrollable: boolean;
  password: boolean;
  bounds: DumpBounds;
  /** Nesting depth, 0 at the root — what "the innermost node carrying this string" is decided with. */
  depth: number;
}

export interface ParsedDump {
  nodes: DumpNode[];
  /** The app the dump belongs to; the launcher and system UI share the hierarchy. */
  packageName: string | null;
  rotation: number;
}

/** One marker, in the units the upload speaks: fractions of the image, not pixels. */
export interface DumpMarker {
  key: string;
  namespace: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DumpMarkerOptions {
  width: number;
  height: number;
  namespace?: string;
  /**
   * What key the string belongs to. Returning null falls back to the string itself, which the platform
   * reports as not-yet-imported instead of refusing the upload.
   */
  resolveKey?: (text: string, node: DumpNode) => string | null;
  /** Every key the string could belong to, when it is not exactly one. Reported, never guessed at. */
  candidates?: (text: string) => string[];
}

export interface DumpMarkerResult {
  markers: DumpMarker[];
  skipped: { empty: number; degenerate: number; offImage: number; duplicate: number };
  ambiguous: { text: string; keys: string[] }[];
}

/** `&#10;` and friends: a dump escapes the one newline it can express, and every quote in a label. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntityText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') || entity.startsWith('#X') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string {
  // Attribute values are double-quoted in every dump this has met; the XML declaration is the one place
  // single quotes appear, and it is not a node.
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntityText(match[1]!) : '';
}

function parseBounds(value: string): DumpBounds | null {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value.trim());
  if (!match) return null;
  return { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) };
}

/**
 * Read a `uiautomator dump` document.
 *
 * Written as a scan rather than a DOM parse on purpose: a dump is one line of a few hundred kilobytes,
 * and the attributes that matter are the same six on every node.
 */
export function parseUiDump(xml: string): ParsedDump {
  const nodes: DumpNode[] = [];
  let depth = 0;
  let packageName: string | null = null;
  const rotation = Number(/\brotation="(-?\d+)"/.exec(xml)?.[1] ?? 0);

  const tag = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  for (const match of xml.matchAll(tag)) {
    if (match[0] === '</node>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attributes = match[1] ?? '';
    const bounds = parseBounds(attribute(attributes, 'bounds'));
    const nodePackage = attribute(attributes, 'package');
    if (packageName === null && nodePackage) packageName = nodePackage;
    if (bounds) {
      nodes.push({
        text: attribute(attributes, 'text'),
        description: attribute(attributes, 'content-desc'),
        resourceId: attribute(attributes, 'resource-id'),
        className: attribute(attributes, 'class'),
        packageName: nodePackage,
        clickable: attribute(attributes, 'clickable') === 'true',
        enabled: attribute(attributes, 'enabled') === 'true',
        scrollable: attribute(attributes, 'scrollable') === 'true',
        password: attribute(attributes, 'password') === 'true',
        bounds,
        depth,
      });
    }
    if (!match[2]) depth += 1;
  }

  return { nodes, packageName, rotation };
}

/** The strings a node carries, in the order a translator would meet them. */
function stringsOf(node: DumpNode): string[] {
  // `text` wins when both are present: the description is an accessibility label and is often not a
  // translation key at all ("返回按钮" for a back arrow), while the visible text always is.
  const raw = node.text.trim() ? node.text : node.description;
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const fraction = (value: number): number => Number(value.toFixed(6));

export function markersFromDump(nodes: readonly DumpNode[], options: DumpMarkerOptions): DumpMarkerResult {
  const { width, height, namespace = '' } = options;
  const skipped = { empty: 0, degenerate: 0, offImage: 0, duplicate: 0 };
  const ambiguous: { text: string; keys: string[] }[] = [];

  interface Candidate {
    text: string;
    node: DumpNode;
    box: DumpBounds;
  }
  const candidates: Candidate[] = [];

  for (const node of nodes) {
    const strings = stringsOf(node);
    if (!strings.length) {
      skipped.empty += 1;
      continue;
    }
    const { left, top, right, bottom } = node.bounds;
    if (right - left <= 0 || bottom - top <= 0) {
      skipped.degenerate += 1;
      continue;
    }
    // A box that is entirely outside the frame is not on this screen; one that merely hangs over an edge
    // is, and is clamped to the part a reader can see.
    if (right <= 0 || bottom <= 0 || left >= width || top >= height) {
      skipped.offImage += 1;
      continue;
    }
    const box: DumpBounds = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(width, right),
      bottom: Math.min(height, bottom),
    };
    // One node carrying several lines is several strings stacked in one box: each line gets its own
    // slice, so a marker lands on the line it belongs to instead of in the middle of the block.
    const slice = (box.bottom - box.top) / strings.length;
    strings.forEach((text, index) => {
      candidates.push({
        text,
        node,
        box: {
          left: box.left,
          top: box.top + slice * index,
          right: box.right,
          bottom: box.top + slice * (index + 1),
        },
      });
    });
  }

  // The same string on nested boxes is one string: a card announces its title and its child announces it
  // again, one of them is where the text is drawn, and marking both would put two boxes on one word.
  const keep = new Set<Candidate>();
  const byText = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byText.get(candidate.text) ?? [];
    group.push(candidate);
    byText.set(candidate.text, group);
  }
  for (const group of byText.values()) {
    for (const candidate of group) {
      const contains = group.filter(
        (other) =>
          other !== candidate &&
          other.box.left >= candidate.box.left &&
          other.box.top >= candidate.box.top &&
          other.box.right <= candidate.box.right &&
          other.box.bottom <= candidate.box.bottom,
      );
      // Outermost of a nested set loses: the innermost box is the element that draws the text.
      if (contains.length) {
        skipped.duplicate += 1;
        continue;
      }
      keep.add(candidate);
    }
  }

  const ordered = [...keep].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left || a.text.localeCompare(b.text));

  const markers = ordered.map(({ text, node, box }) => {
    const keys = options.candidates?.(text) ?? [];
    if (keys.length > 1) ambiguous.push({ text, keys });
    return {
      key: options.resolveKey?.(text, node) ?? text,
      namespace,
      text,
      x: fraction(box.left / width),
      y: fraction(box.top / height),
      width: fraction((box.right - box.left) / width),
      height: fraction((box.bottom - box.top) / height),
    };
  });

  return { markers, skipped, ambiguous };
}

/**
 * The value → key index a capture is matched against.
 *
 * A captured screen shows *values*: the device drew translated text, not key names. The platform's own
 * translations for that locale are therefore the only honest dictionary for turning what is on screen
 * back into what it is called.
 */
export function keyIndexFromTranslations(
  rows: readonly { key: string; namespace?: string | null; value?: string | null }[],
  namespace = '',
): (text: string) => string[] {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    const value = row.value?.trim();
    if (!value) continue;
    if ((row.namespace ?? '') !== namespace) continue;
    const keys = index.get(value) ?? [];
    if (!keys.includes(row.key)) keys.push(row.key);
    index.set(value, keys);
  }
  return (text: string) => index.get(text.trim()) ?? [];
}
