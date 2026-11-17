/**
 * What is wrong with a sketch, said plainly.
 *
 * A sketch is uploaded by someone who cannot see what the platform made of it, and the failures are
 * quiet: an image referenced by URL becomes a grey box, a page whose colours live in a stylesheet
 * arrives monochrome, four "states" that were copied from each other fill the board with the same
 * picture. None of that is an error — the upload succeeds — so the caller never learns.
 *
 * This reads the finished picture and the markers and reports what a person looking at it would
 * notice, with the one thing a report is worth having for: what to do about it.
 *
 * It reads the *stored* sketch rather than the input, so it works on everything already uploaded, and
 * it describes what a reader sees rather than what the caller meant.
 */

export interface MockupFinding {
  code: FindingCode;
  severity: 'warning' | 'info';
  /** One line naming what is missing, in the reader's words. */
  title: string;
  /** What to do about it, naming the actual field, flag or command. */
  advice: string;
  count?: number;
}

/**
 * Every finding the report can carry.
 *
 * Both a type and a runtime list, because two things have to be checked against it: that each code is
 * reachable (a code nothing emits is a promise the report does not keep) and that the guide explains
 * each one (a code a caller cannot look up is a message it cannot act on). Only the list can be
 * iterated, so the type is derived from it rather than written beside it.
 */
export const FINDING_CODES = [
  'NO_PICTURES',
  'PLACEHOLDER_PICTURES',
  'NO_SOURCE_COLOURS',
  'IDENTICAL_FRAMES',
  'MISSING_KEYS',
  'NO_COMPONENTS',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export interface MockupReportStats {
  /** Pictures actually drawn: embedded vectors and inline rasters. */
  pictures: number;
  /** Picture slots that came out as our placeholder. */
  placeholders: number;
  /** Distinct colours the page itself contributed (anything outside the platform's palette). */
  sourceColours: number;
  frames: number;
  markers: number;
  missingKeys: number;
  components: number;
}

export interface MockupReport {
  findings: MockupFinding[];
  stats: MockupReportStats;
  /** True when nothing needs saying. */
  clean: boolean;
}

export interface ReportMarker {
  key: string;
  namespace?: string | null;
  frame?: string | null;
  component?: string | null;
  text?: string | null;
  /** True when the platform has no such key: the marker points at nothing a translator can open. */
  missing?: boolean;
}

/** The fills the renderer uses when the page said nothing — anything else came from the page. */
const PLATFORM_COLOURS = new Set([
  '#ffffff',
  '#09090b',
  '#18181b',
  '#3f3f46',
  '#52525b',
  '#71717a',
  '#a1a1aa',
  '#d4d4d8',
  '#e4e4e7',
  '#f4f4f5',
  '#fafafa',
  '#f5f5f5',
]);

/** The placeholder's diagonal mark, which is how a picture slot that drew nothing looks. */
const PLACEHOLDER_MARK = /opacity="0\.55"/g;

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/**
 * Read a finished sketch and say what a reader would notice.
 *
 * Deliberately conservative: every finding here is something the picture itself shows, so the report
 * cannot claim a problem that is not there. Silence is a valid answer.
 */
export function analyzeSketch(input: {
  svg: string;
  markers: readonly ReportMarker[];
  /** The component numbering the picture carries; empty means the board named no components. */
  legend?: readonly { name: string }[];
}): MockupReport {
  const { svg } = input;
  const findings: MockupFinding[] = [];

  // Pictures: an inline raster draws as `<image href>`, an embedded vector as a nested `<svg x=…>`.
  const pictures = countMatches(svg, /<image\s/g) + countMatches(svg, /<svg x="/g);
  const placeholders = countMatches(svg, PLACEHOLDER_MARK);
  const colours = new Set(
    [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{3,8})"/gi)].map((match) => match[1]!.toLowerCase()),
  );
  const sourceColours = [...colours].filter((colour) => !PLATFORM_COLOURS.has(colour)).length;

  const frames = [...new Set(input.markers.map((marker) => marker.frame).filter((frame): frame is string => Boolean(frame)))];
  const missingKeys = input.markers.filter((marker) => marker.missing).length;
  const components = input.legend?.length ?? 0;

  if (pictures === 0) {
    findings.push({
      code: placeholders ? 'PLACEHOLDER_PICTURES' : 'NO_PICTURES',
      severity: 'warning',
      count: placeholders || undefined,
      title: placeholders
        ? `图里 ${placeholders} 个图片位是空占位框，认不出是什么`
        : '这张图里没有任何图片或图标素材',
      advice:
        '平台不联网取图，所以图要跟载荷一起上来：行内 <svg> 现在会直接画出来（图标、插图最常见的形式）；' +
        '位图要内联成 data: URI；仓库里的图用 localehub mockup --page 生成（会自动内联小图）。' +
        '要像素级还原，就让 Agent 在本地跑浏览器截图，再把截图和量好的坐标传上来。',
    });
  }

  if (sourceColours === 0) {
    findings.push({
      code: 'NO_SOURCE_COLOURS',
      severity: 'warning',
      title: '颜色全部来自平台默认，看不出是哪个 App',
      advice:
        '页面里没有可读的样式：把颜色所在的那份样式表用 css 字段一起传（:root 变量会解析），' +
        '或者用 theme: {"accent": "品牌色", "background": "页面底色"} 说一次。' +
        '类名写成 Tailwind 的（bg-blue-600 / text-slate-900）或 inline style 都能读到。',
    });
  }

  // Two states drawn from the same content are not two states: the board is then four copies of one
  // screen, which is exactly what a translator does not need.
  if (frames.length > 1) {
    const signatures = new Map<string, string[]>();
    for (const marker of input.markers) {
      const frame = marker.frame;
      if (!frame) continue;
      const signature = `${marker.namespace ?? ''}\u0000${marker.key}\u0000${marker.text ?? ''}`;
      const list = signatures.get(frame) ?? [];
      list.push(signature);
      signatures.set(frame, list);
    }
    const counts = new Map<string, number>();
    for (const list of signatures.values()) {
      const key = [...list].sort().join('\u0001');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicated = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
    if (duplicated > 1) {
      findings.push({
        code: 'IDENTICAL_FRAMES',
        severity: 'warning',
        count: duplicated,
        title: `有 ${duplicated} 帧内容完全相同`,
        advice:
          '帧要画的是不同状态：空列表、加载中、校验失败、无权限、禁用……复制出来的几帧只会让画布变宽，' +
          '读的人还要逐个比对。把重复的删掉，或者把每帧真正不同的地方补上。',
      });
    }
  }

  if (missingKeys > 0) {
    findings.push({
      code: 'MISSING_KEYS',
      severity: 'info',
      count: missingKeys,
      title: `${missingKeys} 个标记指向平台还没有的 Key`,
      advice:
        '标记会存下来，导入语言文件后自动对上；要让它们一开始就对，用 import_translations 把 key 导进来，' +
        '或在 HTML 里给元素加 data-key="checkout.pay" 明确写上是哪条 key。',
    });
  }

  if (components === 0) {
    findings.push({
      code: 'NO_COMPONENTS',
      severity: 'info',
      title: '元素没有组件名，图例是空的',
      advice:
        '给组件的根加上名字：JSX 里用组件名（<PrimaryButton>），HTML 里用类名（class="policy-card"）或 ' +
        'data-component="PrimaryButton"。平台会给每个实例编号并在图上标出来，编辑器旁边就能按组件高亮。',
    });
  }

  return {
    findings,
    stats: { pictures, placeholders, sourceColours, frames: frames.length, markers: input.markers.length, missingKeys, components },
    clean: findings.length === 0,
  };
}
