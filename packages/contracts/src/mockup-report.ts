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
 *
 * There are two readers here, because there are two kinds of screen. `analyzeSketch` judges a picture
 * the platform drew from a description; `analyzeDocument` judges a page the platform is holding as it
 * was sent. Both answer the same question — what will the translator see that the caller did not
 * intend — and neither invents a finding it cannot see in the artefact itself.
 */

import { documentAssets, framesAreCopies } from './mockup-document';

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
  // The replica path (`document`): the page is stored as it was sent, so what can go wrong is
  // different — nothing was redrawn, but the page may name assets nobody can resolve, keys that are
  // not in the markup, or scripts that will not run.
  'NO_KEYS',
  'ASSETS_NOT_INLINED',
  'REMOTE_ASSETS',
  'SCRIPTS_NOT_RUN',
  'NO_STYLE',
  'DRAWN_SHAPES',
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
  /** Distinct (namespace, key) pairs the markers name. Only counted on the replica path. */
  keys?: number;
  /** Assets carried inside the markup, as `data:` URIs or inline SVG. */
  inlineAssets?: number;
  /** Assets the viewer's browser fetches from the network. */
  remoteAssets?: number;
  /** Assets referenced by a path nothing can resolve — the replica would show a broken image. */
  localAssets?: number;
  /** `<script>` elements. They travel with the page and never run. */
  scripts?: number;
  /**
   * Inline `<svg>` shapes on the replica path — drawn in the markup rather than brought from the
   * project.
   *
   * Counted apart from `pictures` on purpose. A screen whose photos, icons and illustration are all
   * hand-written paths renders as a wireframe, and calling those "pictures" is how such an upload came
   * back with nothing to say about itself.
   */
  shapes?: number;
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

/** Markers pointing at keys the platform does not have are stored, not refused — so they are said, not fixed. */
function missingKeyFinding(missingKeys: number): MockupFinding | null {
  if (!missingKeys) return null;
  return {
    code: 'MISSING_KEYS',
    severity: 'info',
    count: missingKeys,
    title: `${missingKeys} 个标记指向平台还没有的 Key`,
    advice:
      '标记会存下来，导入语言文件后自动对上；要让它们一开始就对，用 import_translations 把 key 导进来，' +
      '或在 HTML 里给元素加 data-key="checkout.pay" 明确写上是哪条 key。',
  };
}

function componentFinding(components: number): MockupFinding | null {
  if (components) return null;
  return {
    code: 'NO_COMPONENTS',
    severity: 'info',
    title: '元素没有组件名，图例是空的',
    advice:
      '给组件的根加上名字：JSX 里用组件名（<PrimaryButton>），HTML 里用类名（class="policy-card"）或 ' +
      'data-component="PrimaryButton"。平台会给每个实例编号并在图上标出来，编辑器旁边就能按组件高亮。',
  };
}

/** Two states drawn from the same content are not two states — the board is then copies of one screen. */
function identicalFrameFinding(duplicated: number): MockupFinding | null {
  if (duplicated <= 1) return null;
  return {
    code: 'IDENTICAL_FRAMES',
    severity: 'warning',
    count: duplicated,
    title: `有 ${duplicated} 帧内容完全相同`,
    advice:
      '帧要画的是不同状态：空列表、加载中、校验失败、无权限、禁用……复制出来的几帧只会让画布变宽，' +
      '读的人还要逐个比对。把重复的删掉，或者把每帧真正不同的地方补上。',
  };
}

/** How many markers sit in each frame, keyed by the frame's title. */
function frameSignatures(markers: readonly ReportMarker[]): Map<string, string[]> {
  const signatures = new Map<string, string[]>();
  for (const marker of markers) {
    const frame = marker.frame;
    if (!frame) continue;
    const list = signatures.get(frame) ?? [];
    list.push(`${marker.namespace ?? ''}\u0000${marker.key}\u0000${marker.text ?? ''}`);
    signatures.set(frame, list);
  }
  return signatures;
}

/** Frames whose marker sets are byte-identical to another frame's, counted per frame. */
function duplicatedFrames(markers: readonly ReportMarker[]): number {
  const counts = new Map<string, number>();
  for (const list of frameSignatures(markers).values()) {
    const key = [...list].sort().join('\u0001');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
}

function distinctFrames(markers: readonly ReportMarker[]): string[] {
  return [...new Set(markers.map((marker) => marker.frame).filter((frame): frame is string => Boolean(frame)))];
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

  const frames = distinctFrames(input.markers);
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
        '要像素级还原，就改用 document（整页复刻）：把页面的 HTML 连素材一起传，平台不重画。',
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
        '类名写成 Tailwind 的（bg-blue-600 / text-slate-900）或 inline style 都能读到。' +
        '样式在别处、或者还原度要求高时，改传 document（整页复刻）。',
    });
  }

  const copies = duplicatedFrames(input.markers);
  const identical = identicalFrameFinding(copies);
  if (frames.length > 1 && identical) findings.push(identical);

  const missing = missingKeyFinding(missingKeys);
  if (missing) findings.push(missing);
  const noComponents = componentFinding(components);
  if (noComponents) findings.push(noComponents);

  return {
    findings,
    stats: { pictures, placeholders, sourceColours, frames: frames.length, markers: input.markers.length, missingKeys, components },
    clean: findings.length === 0,
  };
}

/**
 * Read a stored page and say what a reader of the replica would notice.
 *
 * A different set of failures from a drawn sketch, because nothing was redrawn: the page is what the
 * caller sent. What can still be wrong is what the *page* needs and did not bring — an asset named by
 * a relative path (nothing resolves it in the viewer's browser), no key attributes to hang markers on,
 * a stylesheet that never arrived, scripts that will not run.
 *
 * The last one is not a defect but a promise: scripts travel with the page and are never executed, so
 * a view whose data comes from a fetch shows what the markup says. The finding exists so that a caller
 * reads it from the platform rather than discovering it in a screenshot.
 */
export function analyzeDocument(input: {
  document: { frames: readonly { title: string; html: string }[] };
  markers: readonly ReportMarker[];
  legend?: readonly { name: string }[];
}): MockupReport {
  const findings: MockupFinding[] = [];
  const assets = documentAssets({ frames: [...input.document.frames] });
  const keys = new Set(input.markers.map((marker) => `${marker.namespace ?? ''}\u0000${marker.key}`)).size;
  const missingKeys = input.markers.filter((marker) => marker.missing).length;
  const components = input.legend?.length ?? 0;
  const frames = distinctFrames(input.markers).length || input.document.frames.length;

  if (keys === 0) {
    findings.push({
      code: 'NO_KEYS',
      severity: 'warning',
      title: '整页里没有一处 data-key，标记落不到元素上',
      advice:
        '复刻的页面要标出「这句话在哪」，靠的是元素上的 key 属性：给每个要翻译的元素加 data-key="policy.view"' +
        '（或 data-i18n-key）。平台按这些属性在渲染出来的页面上量位置，所以标记一定落在那个元素上；' +
        '一个都没有时，编辑器只能显示页面，指不出任何一条译文的位置。',
    });
  }

  if (assets.local > 0) {
    findings.push({
      code: 'ASSETS_NOT_INLINED',
      severity: 'warning',
      count: assets.local,
      title: `${assets.local} 个素材是相对路径，浏览器取不到（会显示成破图）`,
      advice:
        '页面里 src/href/url() 指向本地文件时，只有调用端读得到那些文件：把它们换成 data: URI 再传' +
        '（localehub mockup --page 会自动内联：<link rel=stylesheet>、<img src>、srcset 与 CSS url()），' +
        '或者换成能公开访问的 https 地址。平台自己不去取图——不会替调用端联网。',
    });
  }

  if (assets.pictures === 0 && assets.shapes === 0) {
    findings.push({
      code: 'NO_PICTURES',
      severity: 'warning',
      title: '这一页里没有任何图片、图标或背景图',
      advice:
        '如果页面上本来有图，说明它们没跟着上来：<img>/background-image 里的地址要能被浏览器解析，' +
        '本地文件请内联成 data: URI。如果页面确实没有图，这条可以忽略。',
    });
  }

  // Artwork the caller drew rather than the project supplied. This is the difference between a replica
  // of the screen and a wireframe of it, and it is invisible in every other number the report prints:
  // the page has style, keys and layout, and looks nothing like the app.
  if (assets.pictures === 0 && assets.shapes > 0) {
    findings.push({
      code: 'DRAWN_SHAPES',
      severity: 'warning',
      count: assets.shapes,
      title: `${assets.shapes} 处图形是手画的形状，这一页一张真素材都没有`,
      advice:
        '手画的形状是示意图，不是那个界面：App 里的头像、照片、插画、图标在工程里都有源文件，把它们内联成 ' +
        'data: URI 一起传（iOS 从 Assets.xcassets / android 从 res/drawable 取；位图用 <img src="data:image/png;base64,…">，' +
        '矢量图标可以直接内联 <svg>…</svg> 但要照抄工程里那份 path，不要自己画一个像的）。' +
        '这一步做完，看图的译者才认得出这是哪个页面。',
    });
  }

  if (assets.styles === 0 && assets.colours === 0) {
    findings.push({
      code: 'NO_STYLE',
      severity: 'warning',
      title: '页面没有带任何样式，渲染出来是浏览器默认的样子',
      advice:
        '整页复刻不会替页面补样式：把样式表一起传（<style> 内联、或 <link rel=stylesheet> 指向的文件内联成 <style>），' +
        '否则配色、圆角、字号全丢，看起来不像那个 App。',
    });
  }

  if (assets.remote > 0) {
    findings.push({
      code: 'REMOTE_ASSETS',
      severity: 'info',
      count: assets.remote,
      title: `${assets.remote} 个素材走的是网络地址，看图的人要能访问那个域名`,
      advice:
        '这些素材由查看页面的浏览器去取（平台不取），所以内网地址、需要登录的地址、已经下线的地址都会是破图。' +
        '要保证任何环境下都一样，就把它们内联成 data: URI。',
    });
  }

  if (assets.scripts > 0) {
    findings.push({
      code: 'SCRIPTS_NOT_RUN',
      severity: 'info',
      count: assets.scripts,
      title: `${assets.scripts} 段脚本不会执行：复刻的是外观，不是行为`,
      advice:
        '沙箱里不跑脚本，所以由接口填的数据（列表、金额、"加载中"）不会出现——这正是「动态数据除外」。' +
        '要让某个状态有内容，就把那个状态写成独立的 frame，用静态标记把内容写进去。',
    });
  }

  const identical = identicalFrameFinding(framesAreCopies({ frames: [...input.document.frames] }));
  if (frames > 1 && identical) findings.push(identical);

  const missing = missingKeyFinding(missingKeys);
  if (missing) findings.push(missing);
  const noComponents = componentFinding(components);
  if (noComponents) findings.push(noComponents);

  return {
    findings,
    stats: {
      pictures: assets.pictures,
      placeholders: 0,
      sourceColours: assets.colours,
      frames,
      markers: input.markers.length,
      missingKeys,
      components,
      keys,
      inlineAssets: assets.inline,
      remoteAssets: assets.remote,
      localAssets: assets.local,
      scripts: assets.scripts,
      shapes: assets.shapes,
    },
    clean: findings.length === 0,
  };
}
