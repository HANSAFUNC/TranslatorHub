import { Prisma } from '@localehub/database';
import type { Prisma as PrismaTypes } from '@localehub/database';
import { ErrorCode, LocaleHubError, MAX_MARKERS_PER_MOCKUP, MAX_MOCKUP_BYTES, MAX_MOCKUP_DIMENSION, MockupExpectations, analyzeDocument, analyzeRasterImage, analyzeSketch, canonicalizeLocaleTag, defaultViewport, detectImageType, documentFrameFit, documentMarkers, extractUiSpec, imageDimensions, isFullDocument, isValidLocaleTag, normalizeDocument, normalizeMarker, renderUiSketch, type MockupDocument, type MockupImageType, type MockupMarkerInput, type MockupReport, type PlatformName, type ReviewStatus, type UiLegendItem, type UiSpec, type UiTheme, uiSpecIssues, unsafeSvgReasons } from '@localehub/contracts';
import { createHash } from 'node:crypto';

/**
 * Screen mockups: the half of context a translation key cannot carry.
 *
 * A key says what a string is. It cannot say where it appears, so `checkout.pay_now` reaches a
 * translator as a sentence with no button under it. A mockup uploads the missing half — a sketch of
 * the screen plus a marker per key — and the editor puts the two side by side.
 *
 * This module is the single implementation behind both surfaces that accept an upload: the Remote
 * MCP tool `upload_screen_mockup` and `POST /projects/:projectId/mockups`. The API and the MCP server
 * are separate processes talking to the same database, so a second copy of "which bytes are
 * acceptable" would be a second answer to a question that has one.
 */

export interface DecodedMockupImage {
  bytes: Buffer;
  mimeType: MockupImageType;
  /** What the caller claimed, when it claimed something. Kept for the response, never for the row. */
  declaredMimeType: string | null;
  width: number | null;
  height: number | null;
}

// A data URL may carry parameters between the media type and `;base64` — `data:image/svg+xml;charset=utf-8;base64,…`
// is what several exporters emit, and the earlier form of this pattern rejected it as "not valid base64",
// which told the caller its encoding was wrong when the real answer was 'that spelling is not supported'.
const DATA_URL = /^data:(?:[\w.+-]+\/[\w.+-]+)?(?:;[\w.+-]+=[\w.+-]*)*;base64,/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Turn what a caller sent into bytes the platform is willing to store and serve.
 *
 * Every check here exists because the value is later handed back to a browser under a `content-type`
 * this function decides, and rendered in the editor:
 *
 *   - the format is read from the **bytes**, never from `mime_type`, so a caller cannot have a text
 *     file served as an image;
 *   - the size is checked before decoding, so an oversized payload is refused instead of allocated;
 *   - the pixel dimensions are read for every accepted format, so a small file that would decode into
 *     a gigantic canvas is refused by name;
 *   - an SVG that could act as a script is refused, listing the construct to remove. The editor also
 *     renders sketches through `<img>` and the API serves them under a restrictive CSP, but a sketch
 *     has no legitimate need for `<script>`, so the cheapest reliable answer is to not store one.
 */
export function decodeMockupImage(input: {
  imageBase64: string;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
}): DecodedMockupImage {
  const raw = input.imageBase64.trim().replace(DATA_URL, '').replace(/\s+/g, '');
  if (!raw) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'image_base64 is empty', 422);
  }
  if (!BASE64.test(raw)) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      'image_base64 is not valid base64 (no line breaks, no url-safe alphabet)',
      422,
    );
  }
  // Checked before decoding: 4 base64 characters carry 3 bytes, so the decoded size is known up front
  // and an oversized payload never becomes an allocation.
  const estimated = Math.floor((raw.length * 3) / 4);
  if (estimated > MAX_MOCKUP_BYTES + 3) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `Mockup image is ${Math.round(estimated / 1024)} KB; the limit is ${Math.round(MAX_MOCKUP_BYTES / 1024)} KB`,
      413,
      { limitBytes: MAX_MOCKUP_BYTES, actualBytes: estimated },
    );
  }

  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'image_base64 decoded to zero bytes', 422);
  }
  if (bytes.length > MAX_MOCKUP_BYTES) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `Mockup image is ${Math.round(bytes.length / 1024)} KB; the limit is ${Math.round(MAX_MOCKUP_BYTES / 1024)} KB`,
      413,
      { limitBytes: MAX_MOCKUP_BYTES, actualBytes: bytes.length },
    );
  }

  const view = new Uint8Array(bytes);
  const mimeType = detectImageType(view);
  if (!mimeType) {
    throw new LocaleHubError(
      ErrorCode.UNSUPPORTED_FORMAT,
      'Unrecognised image: expected SVG, PNG or JPEG. WebP is not accepted — the server cannot read its dimensions.',
      422,
    );
  }

  if (mimeType === 'image/svg+xml') {
    const reasons = unsafeSvgReasons(new TextDecoder().decode(view));
    if (reasons.length) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `This SVG cannot be stored because it contains ${reasons.join('、')}. Remove it and upload again — a sketch only needs shapes and text.`,
        422,
        { reasons },
      );
    }
  }

  const measured = imageDimensions(view, mimeType);
  const width = measured?.width ?? input.width ?? null;
  const height = measured?.height ?? input.height ?? null;
  return { bytes, mimeType, declaredMimeType: input.mimeType ?? null, width, height };
}

/** Throws when the caller's own dimensions — or the file's — describe a canvas too large to paint. */
export function assertMockupDimensions(image: DecodedMockupImage): void {
  if (image.width === null || image.height === null) return;
  if (image.width <= MAX_MOCKUP_DIMENSION && image.height <= MAX_MOCKUP_DIMENSION) return;
  // 413, not 422: the payload is well-formed and the caller did nothing wrong except export at a size
  // no browser should be asked to paint. The status is what tells a retry-on-4xx client to stop.
  throw new LocaleHubError(
    ErrorCode.VALIDATION_ERROR,
    `Mockup is ${image.width}×${image.height}; the limit is ${MAX_MOCKUP_DIMENSION}×${MAX_MOCKUP_DIMENSION}. ` +
      'Export the sketch at a sensible size — markers are fractions of the image, so a smaller export keeps every marker where it is.',
    413,
    { width: image.width, height: image.height, limit: MAX_MOCKUP_DIMENSION },
  );
}

/**
 * Turn a caller's screen description into the image and markers an upload stores.
 *
 * This is the "generate the sketch from code" path: instead of sending a picture and measuring every
 * string by hand, the caller sends the page's elements (`ui`) and the platform lays them out, draws
 * them and derives the marker geometry itself. The picture and the coordinates therefore always agree
 * with each other, and the same description always produces the same sketch.
 *
 * A spec is validated like an image is: the renderer's work is proportional to what the caller sent,
 * and the result has to satisfy the same size and marker limits an upload does.
 */
export function renderMockupSpec(spec: UiSpec): { image: DecodedMockupImage; markers: MockupMarkerInput[]; legend: UiLegendItem[] } {
  const issues = uiSpecIssues(spec);
  if (issues.length) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `ui 描述有问题：${issues.join('；')}`, 422, { issues });
  }

  const rendered = renderUiSketch(spec);
  if (rendered.truncated) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      'ui 描述在渲染时被截断（层级或元素数超过上限），请拆成更小的屏幕再上传。',
      422,
    );
  }
  if (!rendered.markers.length) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      'ui 描述里没有任何带文字的节点，画出来的 UI 页面没有可标记的 key。给 text / button / badge / input 节点填上文字。',
      422,
    );
  }
  if (rendered.markers.length > MAX_MARKERS_PER_MOCKUP) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `ui 描述会生成 ${rendered.markers.length} 个标记，一个屏幕的上限是 ${MAX_MARKERS_PER_MOCKUP}`,
      422,
    );
  }

  const bytes = Buffer.from(rendered.svg, 'utf8');
  if (bytes.length > MAX_MOCKUP_BYTES) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `根据 ui 描述生成的 UI 页面有 ${Math.round(bytes.length / 1024)} KB，超过 ${Math.round(MAX_MOCKUP_BYTES / 1024 / 1024)} MB 的图片上限。少画一些元素，或把屏幕拆开。`,
      413,
      { limitBytes: MAX_MOCKUP_BYTES, actualBytes: bytes.length },
    );
  }

  const image: DecodedMockupImage = {
    bytes,
    mimeType: 'image/svg+xml',
    declaredMimeType: null,
    width: rendered.width,
    height: rendered.height,
  };
  assertMockupDimensions(image);

  return {
    image,
    markers: rendered.markers.map((marker) => ({
      key: marker.key,
      namespace: marker.namespace,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
      text: marker.text,
      // Which state the marker is in, and which component its element is: the editor groups by the
      // first, and lists and highlights by the second.
      ...(marker.frame ? { frame: marker.frame } : {}),
      ...(marker.component ? { component: marker.component } : {}),
    })),
    legend: rendered.legend,
  };
}

/**
 * Which scanner to read a page's source with.
 *
 * Both are tolerant and both handle the other's input, so this only has to be right about the
 * obvious cases: a document that says it is HTML is parsed as HTML, and anything else — a component
 * file, a fragment — goes through the JSX reader, which understands embedded expressions.
 */
function sourceNameFor(source: string): string {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(source) ? 'page.html' : 'page.tsx';
}

/**
 * The one place that decides which input a caller used, and what the platform does with it.
 *
 * There are three, and the difference between the last two is the whole point of this dispatcher:
 *
 *   - `image_base64` + `markers` — the caller drew the picture and measured the coordinates.
 *   - `ui` — the caller described the screen; the platform lays it out and draws it.
 *   - `html` — the page's source. A *fragment* (a component file, a snippet) is read into the same
 *     element tree as `ui` and redrawn. A *whole page* is not redrawn at all: the markup is stored and
 *     the editor renders it, because a redrawn page is the platform's approximation of a screen, and
 *     an approximation is exactly what "还原度不够" means. Pass `document: true` to ask for the
 *     replica explicitly (a fragment can then still be framed by a document shell of the caller's
 *     choosing).
 *
 * `frames` carries the states for either kind: each frame is a screen of its own, on one board.
 */
export interface ResolvedMockupInput {
  /** The picture, when the platform drew one. A replica has none. */
  image: DecodedMockupImage | null;
  /** The page, when the caller sent one. A drawn sketch has none. */
  document: MockupDocument | null;
  markers: MockupMarkerInput[];
  legend: UiLegendItem[];
  /**
   * The size the screen is shown at, which is the picture's own size for a drawn sketch and the
   * platform's viewport for a replica.
   *
   * A replica's height is advisory: the page is as tall as its content, and the editor measures that
   * when it renders. The width is not advisory — a responsive page laid out at the wrong width is a
   * different screen — so it comes from the platform the mockup is filed under.
   */
  width: number | null;
  height: number | null;
}

/** Does this upload want the page kept whole (replica) rather than redrawn? */
function wantsDocument(input: {
  document?: string | null;
  html?: string | null;
  frames?: readonly { title: string; html?: string | null; document?: string | null }[] | null;
}): boolean {
  if (input.document) return true;
  if (input.frames?.length) {
    const pages = input.frames.filter((frame) => frame.html || frame.document);
    // Every state has to be a page. One fragment among them has no document to display, and mixing
    // the two would silently store a board with a state missing from it.
    return pages.length > 0 && pages.every((frame) => Boolean(frame.document) || isFullDocument(frame.html ?? ''));
  }
  // A single `html` that is a whole page is a replica by default: a caller that hands over a complete
  // document is asking for that page, not for a wireframe of it. This is what makes the common path
  // right without a new required field.
  return Boolean(input.html) && isFullDocument(input.html!);
}

/**
 * A replica's markers: the keys named in the markup, with no coordinates.
 *
 * Coordinates are deliberately absent rather than zero. The layout belongs to a browser, and the
 * editor has one: it measures the rendered elements and draws the boxes there. Storing a rectangle
 * the platform guessed would be worse than storing none, because it would look like a measurement.
 */
function resolveDocumentInput(
  input: {
    document?: string | null;
    html?: string | null;
    frames?: readonly { title: string; html?: string | null; document?: string | null }[] | null;
    namespace?: string | null;
    platform?: string | null;
  },
): ResolvedMockupInput {
  const document = normalizeDocument({
    document: input.document ?? null,
    html: input.document ? null : (input.html ?? null),
    frames: input.frames ?? null,
  });
  if (!document.frames.length) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, '缺少页面：document 或 html 里没有任何内容。', 422);
  }
  const markers: MockupMarkerInput[] = documentMarkers(document, { namespace: input.namespace ?? null }).map(
    (marker) => ({
      key: marker.key,
      namespace: marker.namespace,
      text: marker.text,
      frame: marker.frame,
      // The replica's boxes come from the browser that renders it, so there is no rectangle here: a
      // zero-size marker at the origin is "measured later", and the editor never draws it as if it
      // were placed. `x`/`y` are required by the wire schema; 0 is their neutral value.
      x: 0,
      y: 0,
      ...(marker.component ? { component: marker.component } : {}),
    }),
  );
  if (!markers.length) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      '这一页里没有一处 data-key（或 data-i18n-key）：复刻的页面靠元素上的 key 属性把译文挂到界面上，' +
        '至少给一个元素写上 data-key="checkout.pay"。',
      422,
    );
  }
  // The legend of a replica is its components, numbered in first-appearance order like a drawn board.
  const legend: UiLegendItem[] = [];
  for (const marker of markers) {
    if (!marker.component) continue;
    const existing = legend.find((item) => item.name === marker.component);
    if (existing) existing.count += 1;
    else legend.push({ index: legend.length + 1, name: marker.component, count: 1 });
  }
  const viewport = defaultViewport(input.platform ?? undefined);
  assertPageFitsFrame(document, viewport, input.platform ?? undefined);
  return { image: null, document, markers, legend, width: viewport.width, height: viewport.height };
}

/**
 * The frame is the platform's — one fixed phone size per platform — so a page laid out for another
 * canvas is refused here rather than stored and rendered clipped.
 *
 * Measured against the real uploads before this check existed: 19 of 29 Android pages had coordinates
 * outside the frame (none of 32 iOS pages did), one of them declaring a 412×4250 canvas, and a login
 * screen whose content ran to 1371px rendered as an empty grey page — while the report called it clean,
 * because nothing here looked at the numbers against the frame they would be drawn into. A page that
 * arrives clipped is worse than one that arrives late: it is the picture a translator then reads.
 */
/**
 * Why a page laid out for another canvas is nearly always a unit problem, in that platform's terms.
 *
 * Android is the one that bites: the layout's numbers are dp while a screenshot of the same screen is
 * 2× or 2.625× (a 412dp screen is 824 or 1080 px wide), so reading one as the other scales the page up.
 * Telling an iOS or web caller that would be advice about a platform they are not on.
 */
function densityHint(frame: { width: number; height: number }, platform: string | undefined): string {
  if (platform !== 'android') return '';
  return (
    '最常见的来源是单位搞混：安卓的布局数值是 dp，而同一屏的截图是 2× 或 2.625×' +
    `（${frame.width}dp 的屏，2× 截图宽 ${frame.width * 2}px，1080p 的截图则是 2.625×）——按 1× 读就会整屏放大。`
  );
}

function assertPageFitsFrame(
  document: MockupDocument,
  frame: { width: number; height: number },
  platform: string | undefined,
): void {
  const fit = documentFrameFit(document, frame);
  const overrun = fit.pastRight + fit.pastBottom;
  const ratio = fit.ratio >= 1.5 ? `，最远到 ${Math.round(Math.max(fit.maxRight, fit.maxBottom))}px（约 ${fit.ratio} 倍）` : '';
  if (overrun > 0) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `FRAME_OVERFLOW：这一页画在 ${frame.width}×${frame.height} 的框外，${overrun} 处坐标越界${ratio}。` +
        `复刻的是"一屏"，画框由 platform（${platform ?? '未指定，按 web 算'}）固定成 ${frame.width}×${frame.height}，` +
        '上传方改不了，框外的内容在编辑器和图里都不存在。' +
        densityHint(frame, platform) +
        `按 ${frame.width}×${frame.height} 重画这一页，或把数值先换算到画框的坐标系里。`,
      422,
      {
        frame,
        overflow: { right: fit.pastRight, bottom: fit.pastBottom },
        maxRight: fit.maxRight,
        maxBottom: fit.maxBottom,
        ratio: fit.ratio,
        measuredBoxes: fit.measured,
        unmeasuredBoxes: fit.unmeasured,
      },
    );
  }
  if (fit.declared && (Math.abs(fit.declared.width - frame.width) > 1 || Math.abs(fit.declared.height - frame.height) > 1)) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `CANVAS_MISMATCH：页面自己声明了 ${fit.declared.width}×${fit.declared.height} 的画布（${fit.declared.selector}），` +
        `平台按 ${frame.width}×${frame.height} 渲染——请把那份样式里的 width/height 改成平台的尺寸。`,
      422,
      { frame, declared: fit.declared },
    );
  }
}

export function resolveMockupInput(input: {
  imageBase64?: string | null;
  mimeType?: string | null;
  /** The page kept whole, for a replica. See `ResolvedMockupInput` for why this is not `html`. */
  document?: string | null;
  width?: number | null;
  height?: number | null;
  /** Required with `imageBase64`; ignored with `ui`, where the platform derives them. */
  markers?: readonly (Omit<MockupMarkerInput, 'namespace'> & { namespace?: string })[] | null;
  ui?: UiSpec | null;
  /**
   * The page's own source (HTML or JSX/TSX), for a caller that has the markup rather than a picture
   * or a description. Parsed with the same scanner the CLI uses — the page's colours and component
   * shapes come out of its classes, inline styles and `<style>` rules — and then drawn exactly like
   * a `ui` description, because that is what it becomes.
   */
  html?: string | null;
  /** Default namespace for an `html` upload; the same thing as `ui.root.namespace`. */
  namespace?: string | null;
  /** The page's stylesheet, when its colours live in another file. */
  css?: string | null;
  /** Brand colours, for a screen whose source says nothing about them. */
  theme?: UiTheme | null;
  /**
   * The screen's states, each its own frame on one canvas.
   *
   * A screen is rarely one picture: the empty list, the loading row, the validation error. Sending
   * them together is what lets a translator see that the same key reads differently — or does not
   * appear at all — in each state, instead of trusting one picture to stand for all of them.
   */
  frames?: readonly { title: string; html?: string | null; ui?: UiSpec | null; document?: string | null }[] | null;
  /**
   * The screen's platform, used only to pick the canvas size when the `ui` description does not
   * carry one of its own.
   *
   * Without this the platform of the *call* never reached the renderer, so an `ios` screen whose
   * description omitted `platform` was laid out on a 1280×800 canvas — and omitting it is exactly
   * what the sketch guide tells a caller to do, because the screen's identity comes from the call.
   */
  platform?: string | null;
}): ResolvedMockupInput {
  // Exactly one input, and the check has to see all of them.
  //
  // It used to name three (`ui` / `html` / `image_base64`) and run *after* the replica branch was
  // chosen, so `{document, ui}` stored the page and dropped the description without a word — the
  // caller's sketch was silently the other one it sent. Refusing costs a round trip; not refusing
  // costs an upload the caller believes shows something it does not.
  const given = [
    ['document', input.document],
    ['html', input.html],
    ['ui', input.ui],
    ['frames', input.frames?.length ? input.frames : null],
    ['image_base64', input.imageBase64],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name);
  if (given.length > 1) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `一次只用一种输入，你传了 ${given.join(' + ')}。五种输入选一种：document（整页复刻）、html（页面源码/片段）、` +
        'ui（界面描述）、frames（一屏多状态）、image_base64（自己画的图，配 markers）。',
      422,
    );
  }

  // A whole page is not read into an element tree at all: it is stored and rendered. Everything below
  // is the drawn path, which is what a fragment, a `ui` description and a hand-drawn picture take.
  if (wantsDocument(input)) return resolveDocumentInput(input);

  const hasImage = Boolean(input.imageBase64);
  const hasUi = Boolean(input.ui);
  const hasHtml = Boolean(input.html);

  // `frames` alongside `ui` / `html` / `image_base64` was refused here too; the single-input check above
  // now covers it (and `document`, which this one never saw), so this branch only lays the board out.
  if (input.frames?.length) {
    const viewport = defaultViewport(input.platform ?? undefined);
    const frames = input.frames.map((frame) => {
      const root = frame.ui
        ? frame.ui.root
        : frame.html
          ? extractUiSpec(frame.html, sourceNameFor(frame.html), {
              ...(input.namespace ? { namespace: input.namespace } : {}),
              ...(input.css ? { css: input.css } : {}),
            }).root
          : null;
      if (!root) {
        throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `frame「${frame.title}」既没有 ui 也没有 html。`, 422);
      }
      // Each frame is a screen at the platform's own size, titled with the state it shows.
      return { ...root, type: 'screen' as const, text: frame.title, width: viewport.width, height: viewport.height };
    });
    const spec: UiSpec = {
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.theme ? { theme: input.theme } : {}),
      root: { type: 'canvas', children: frames },
    };
    const rendered = renderMockupSpec(spec);
    return {
      image: rendered.image,
      document: null,
      markers: rendered.markers,
      legend: rendered.legend,
      width: rendered.image.width,
      height: rendered.image.height,
    };
  }

  if (hasHtml) {
    // The source is read into a spec, and from there it takes the same path a `ui` upload does: one
    // pass lays the page out, draws it and reports the markers, so picture and coordinates cannot
    // disagree. Nothing here renders the markup or runs anything it contains.
    const { root } = extractUiSpec(input.html!, sourceNameFor(input.html!), {
      ...(input.namespace ? { namespace: input.namespace } : {}),
      ...(input.css ? { css: input.css } : {}),
    });
    const spec: UiSpec = {
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.theme ? { theme: input.theme } : {}),
      root,
    };
    const rendered = renderMockupSpec(spec);
    return {
      image: rendered.image,
      document: null,
      markers: rendered.markers,
      legend: rendered.legend,
      width: rendered.image.width,
      height: rendered.image.height,
    };
  }

  if (hasUi) {
    // `ui.platform` wins when the caller did set it (a caller describing a different device than the
    // screen is filed under meant it), otherwise the call's platform decides the canvas.
    const spec: UiSpec = {
      ...input.ui!,
      platform: input.ui!.platform ?? input.platform ?? undefined,
      ...(input.theme && !input.ui!.theme ? { theme: input.theme } : {}),
    };
    const rendered = renderMockupSpec(spec);
    return {
      image: rendered.image,
      document: null,
      markers: rendered.markers,
      legend: rendered.legend,
      width: rendered.image.width,
      height: rendered.image.height,
    };
  }

  if (!hasImage) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      '缺少 UI 页面：传 ui（界面描述）、html（页面源码），或者 image_base64 + markers（自己画的图，坐标要自己量）。',
      422,
    );
  }

  // The wire type makes `namespace` optional (a schema default fills it in for the MCP path), while
  // the domain requires it: an omitted namespace is the empty one.
  const markers: MockupMarkerInput[] = (input.markers ?? []).map((marker) => ({
    ...marker,
    namespace: marker.namespace ?? '',
  }));
  if (!markers.length) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      '传了 image_base64 但没有 markers：图片上的每个 key 需要坐标。也可以改传 ui，由平台算坐标。',
      422,
    );
  }

  return {
    image: decodeMockupImage({
      imageBase64: input.imageBase64!,
      mimeType: input.mimeType ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
    }),
    document: null,
    markers,
    // A hand-drawn picture has no components to number; the legend is what a description produces.
    legend: [],
    width: null,
    height: null,
  };
}

export interface UpsertScreenMockupInput {
  organizationId: string;
  projectId: string;
  userId: string | null;
  name: string;
  platform: PlatformName;
  locale: string;
  /** The picture, for a sketch the platform drew. Mutually exclusive with `document`. */
  image: DecodedMockupImage | null;
  /** What the caller asserts about this screen, so the report stops reporting it. See `MockupExpectations`. */
  expectations?: MockupExpectations;
  /** The page kept whole, for a replica. Stored as sent; scripts in it never run. */
  document?: MockupDocument | null;
  /** The size the screen is shown at: the picture's, or the platform's viewport for a page. */
  width?: number | null;
  height?: number | null;
  markers: MockupMarkerInput[];
  /** The component numbering drawn on the picture, stored so the editor lists the same numbers. */
  legend?: UiLegendItem[];
  /** Superseded by `replace` on the tool: the caller has already regenerated the screen. */
  replace: boolean;
}

export interface UnmatchedMarker {
  key: string;
  namespace: string;
  /** Why the marker is not shown next to a translation yet. */
  reason: 'KEY_NOT_IMPORTED';
}

export interface UpsertScreenMockupResult {
  mockupId: string;
  name: string;
  platform: string;
  locale: string;
  replaced: boolean;
  /** Which artefact the row holds: a picture the platform drew, or the page itself. */
  kind: 'image' | 'document';
  image: { mimeType: string; byteSize: number; width: number | null; height: number | null; checksum: string };
  markers: {
    total: number;
    matchedKeys: number;
    unmatched: UnmatchedMarker[];
    /** One entry per frame the upload drew, in the order it drew them. */
    frames: { title: string; markers: number }[];
  };
  /** The component numbering the picture carries, for the list the editor shows beside it. */
  components: UiLegendItem[];
  /** What is missing from the sketch, with advice — the same report the editor shows. */
  report: MockupReport;
  /** What the editor adds to a relative path to fetch the image. */
  imagePath: string;
}

/**
 * Create or replace a screen mockup, and report which of its markers point at nothing.
 *
 * Unmatched markers are stored, not rejected. A sketch is frequently uploaded while the caller is
 * still reading the repository, so pointing at a key the platform has not imported yet describes the
 * UI truthfully; the editor shows those markers as "平台还没有这个 Key", and a later import makes
 * them light up. Rejecting the upload instead would mean the sketch can only be drawn after the
 * translations exist, which is the opposite of when it is useful.
 */
export async function upsertScreenMockup(
  tx: PrismaTypes.TransactionClient,
  input: UpsertScreenMockupInput,
): Promise<UpsertScreenMockupResult> {
  if (!isValidLocaleTag(input.locale)) {
    throw new LocaleHubError(ErrorCode.INVALID_LOCALE, `Invalid locale: ${input.locale}`, 422);
  }
  const locale = canonicalizeLocaleTag(input.locale);
  if (!input.markers.length) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'A mockup needs at least one marker', 422);
  }
  if (input.markers.length > MAX_MARKERS_PER_MOCKUP) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      `${input.markers.length} markers exceeds the limit of ${MAX_MARKERS_PER_MOCKUP} per screen`,
      422,
    );
  }
  if (!input.image && !input.document) {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'A mockup needs a picture or a page', 422);
  }
  if (input.image) assertMockupDimensions(input.image);

  // The project has to exist *inside this tenant's scope* before anything is written against it.
  //
  // RLS makes another organization's project invisible, so this lookup is exactly "is this project
  // ours?". Skipping it did two things, both reproduced against the running stack: a member of
  // organization A could upload a sketch against organization B's project id (the row was written,
  // invisible to B, but the global unique index `(project_id, platform, name)` is not tenant-scoped,
  // so B could no longer use that screen name — an undeletable cross-tenant squat), and an unknown id
  // reached the foreign key and surfaced as a 500 carrying raw Prisma text.
  const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
  if (!project) {
    throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${input.projectId} not found`, 404);
  }

  const markers = input.markers.map(normalizeMarker);
  // The artefact's bytes are what the checksum describes, whichever kind it is: for a replica that is
  // the markup, so re-uploading the same page under the same name is recognisably the same screen.
  const payload = input.image
    ? input.image.bytes
    : Buffer.from(JSON.stringify(input.document), 'utf8');
  const checksum = createHash('sha256').update(payload).digest('hex');
  const mimeType = input.image ? input.image.mimeType : 'text/html';

  const existing = await tx.screenMockup.findFirst({
    where: { projectId: input.projectId, platform: input.platform as never, name: input.name },
    select: { id: true },
  });
  if (existing && !input.replace) {
    throw new LocaleHubError(
      ErrorCode.CONFLICT,
      `A mockup named "${input.name}" already exists for ${input.platform}. Pass replace: true to overwrite it, or upload under a different name.`,
      409,
      { mockupId: existing.id, name: input.name, platform: input.platform },
    );
  }

  // What a reader would notice is missing, computed from the picture that was just drawn: an image
  // slot that came out as a placeholder, a page that contributed no colour of its own, frames that are
  // copies. It is stored with the sketch so the editor can show it without re-reading the bytes.
  const keyNames = [...new Set(markers.map((marker) => marker.key))];
  const keys = await tx.translationKey.findMany({
    // `archivedAt: null`, like every other key read in the codebase. An archived key was dropped from
    // the repository, so a marker pointing at it is pointing at something the editor will not list —
    // counting it as matched told the caller a key was imported when it had been removed.
    where: { projectId: input.projectId, key: { in: keyNames }, archivedAt: null },
    select: { key: true, namespace: { select: { name: true } } },
  });
  const known = new Set(keys.map((row) => `${row.namespace.name}\u0000${row.key}`));

  // What a reader would notice is missing, computed from the artefact that was just stored: for a
  // drawn sketch that is the picture (a placeholder, no colour of the page's own, copied frames); for
  // a replica it is the page itself (a relative asset nothing can resolve, a state with no key, a
  // script that will not run). One report shape, two readers.
  const reportMarkers = markers.map((marker) => ({
    key: marker.key,
    namespace: marker.namespace,
    frame: marker.frame ?? null,
    component: marker.component ?? null,
    text: marker.text ?? null,
    missing: !known.has(`${marker.namespace}\u0000${marker.key}`),
  }));
  const report = input.image
    ? input.image.mimeType === 'image/svg+xml'
      ? analyzeSketch({
          svg: input.image.bytes.toString('utf8'),
          markers: reportMarkers,
          legend: input.legend ?? [],
          ...(input.expectations ? { expectations: input.expectations } : {}),
        })
      : // A raster is pixels, not markup: running the sketch analyzer over PNG bytes found no pictures
        // and no colours every time, and told every screenshot it looked like a wireframe. Nothing here
        // reads inside the bytes, so the report says so instead of inventing conclusions.
        analyzeRasterImage({
          mimeType: input.image.mimeType,
          width: input.image.width,
          height: input.image.height,
          markers: reportMarkers,
          legend: input.legend ?? [],
        })
    : analyzeDocument({
        document: input.document!,
        markers: reportMarkers,
        legend: input.legend ?? [],
        // The frame the page will be rendered into, so the report can say when the page was drawn for
        // a different one. A document always arrives with the platform's viewport (see
        // `resolveDocumentInput`); the fallback is the same source, for a caller that built the input
        // by hand.
        frame:
          input.width && input.height
            ? { width: input.width, height: input.height }
            : defaultViewport(input.platform),
        ...(input.expectations ? { expectations: input.expectations } : {}),
      });

  const data = {
    legend: (input.legend ?? []) as unknown as PrismaTypes.InputJsonValue,
    report: report as unknown as PrismaTypes.InputJsonValue,
    // What the caller asserted, kept beside the report it affects: a page is re-read on every read, so a
    // declaration that only lived for one request would let the finding it suppressed come back.
    expectations: input.expectations
      ? (input.expectations as unknown as PrismaTypes.InputJsonValue)
      : Prisma.DbNull,
    organizationId: input.organizationId,
    projectId: input.projectId,
    name: input.name,
    platform: input.platform as never,
    locale,
    width: input.image ? input.image.width : (input.width ?? null),
    height: input.image ? input.image.height : (input.height ?? null),
    mimeType,
    byteSize: payload.length,
    contentHash: checksum,
    // `Uint8Array` rather than the `Buffer` we validated: Prisma 6 types a Bytes column as
    // `Uint8Array<ArrayBuffer>`, and a Buffer's backing store is `ArrayBufferLike`, which includes
    // SharedArrayBuffer. One copy per upload is cheaper than fighting the variance.
    image: input.image ? new Uint8Array(input.image.bytes) : null,
    document: (input.document ?? null) as unknown as PrismaTypes.InputJsonValue,
    createdById: input.userId,
  };

  // The write never decides *whether* it may replace — the read above does — and each intent gets the
  // statement that makes it true under concurrency:
  //
  //   - `replace: false` is a plain `create`. Only the unique index can tell two concurrent callers
  //     apart, and it does so atomically: the loser gets `P2002`, which the exception filter maps to
  //     409. A read-then-write let both pass the check and the second silently overwrote the first
  //     while reporting `replaced: false`.
  //   - `replace: true` is one raw `INSERT … ON CONFLICT DO UPDATE`. Prisma's own `upsert` is not
  //     enough here: with a nested relation in the `update` branch (`markers: { deleteMany: {} }`) it
  //     compiles to a SELECT followed by INSERT/UPDATE rather than a single conflict-handling
  //     statement, which reopens the very race it was chosen to close. The markers are cleared by
  //     their own delete instead of nesting, and the statement below is atomic by construction.
  //
  //     Column order follows `data`; the bytea is passed as-is and the enums cast from text.
  let mockupId: string;
  if (input.replace) {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO screen_mockups (
            id, organization_id, project_id, name, platform, locale,
            width, height, mime_type, byte_size, content_hash, image, document, legend, report, expectations, created_by_id,
            created_at, updated_at
          )
          VALUES (
            gen_random_uuid(), ${data.organizationId}::uuid, ${data.projectId}::uuid, ${data.name},
            ${data.platform}::text::"PlatformKind", ${data.locale},
            ${data.width}, ${data.height}, ${data.mimeType}, ${data.byteSize},
            ${data.contentHash}, ${data.image}, ${JSON.stringify(data.document)}::jsonb, ${JSON.stringify(data.legend)}::jsonb, ${JSON.stringify(data.report)}::jsonb, ${JSON.stringify(data.expectations ?? null)}::jsonb, ${data.createdById}::uuid,
            now(), now()
          )
          ON CONFLICT (project_id, platform, name) DO UPDATE SET
            organization_id = EXCLUDED.organization_id,
            locale = EXCLUDED.locale,
            width = EXCLUDED.width,
            height = EXCLUDED.height,
            mime_type = EXCLUDED.mime_type,
            byte_size = EXCLUDED.byte_size,
            content_hash = EXCLUDED.content_hash,
            image = EXCLUDED.image,
            document = EXCLUDED.document,
            legend = EXCLUDED.legend,
            report = EXCLUDED.report,
            expectations = EXCLUDED.expectations,
            created_by_id = EXCLUDED.created_by_id,
            updated_at = now()
          RETURNING id
        `;
    // `RETURNING id` is what makes this statement answer with the row it wrote. Without it the insert
    // still lands and the result is empty — which reads as a failure three lines further on, as a
    // TypeError about reading `id` of undefined, saying nothing about the cause. So an empty answer is
    // treated as what it is: the statement did not do what this code believes it does.
    const row = inserted[0];
    if (!row) {
      throw new LocaleHubError(
        ErrorCode.INTERNAL_ERROR,
        'The screen was written but the database returned no row for it; refusing to continue with an unknown id',
        500,
      );
    }
    mockupId = row.id;
  } else {
    mockupId = (await tx.screenMockup.create({ data, select: { id: true } })).id;
  }

  // Markers of a replaced screen go before the new ones arrive, outside the upsert for the reason
  // above. A freshly inserted row has none, so this is a no-op on the create path.
  if (input.replace) {
    await tx.screenMockupMarker.deleteMany({ where: { mockupId } });
  }

  // Resolve which markers name a key the project actually has, by (namespace, key) rather than by the
  // full identity.
  //
  // The platform is deliberately *not* part of this lookup. A sketch is one screen, and the same key
  // name can legitimately exist under several platforms with different text (an iOS and a web build
  // of the same product hold separate keys); asking "does this screen show my entry?" is answered by
  // the name, and which entry it is answered by the platform the screen names. That resolution is
  // reported per marker, so a key that resolved under a different platform stays visible in the
  // editor instead of silently counting as a match.
  //
  // (This lookup used to be textual for a second, worse reason: entries lost their platform on the
  // way in, so every key was stored as `web` and matching by platform failed for every honest sketch.
  // Fixed — see `scanEntrySchema` — but the lookup still does not filter on it, for the reason above.)
  const unmatched: UnmatchedMarker[] = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    const identity = `${marker.namespace}\u0000${marker.key}`;
    if (known.has(identity) || seen.has(identity)) continue;
    seen.add(identity);
    unmatched.push({ key: marker.key, namespace: marker.namespace, reason: 'KEY_NOT_IMPORTED' });
  }

  await tx.screenMockupMarker.createMany({
    data: markers.map((marker) => ({
      organizationId: input.organizationId,
      mockupId,
      key: marker.key,
      namespace: marker.namespace,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
      text: marker.text ?? null,
      // The frame (state) and the component are part of what a marker says: neither can be recovered
      // from the picture afterwards, and the editor groups and highlights by exactly these.
      frame: marker.frame ?? null,
      component: marker.component ?? null,
      note: marker.note ?? null,
    })),
  });

  const matchedKeys = new Set(
    markers.filter((marker) => known.has(`${marker.namespace}\u0000${marker.key}`)).map((m) => `${m.namespace}\u0000${m.key}`),
  ).size;

  return {
    mockupId,
    name: input.name,
    platform: input.platform,
    locale,
    replaced: Boolean(existing),
    kind: input.image ? 'image' : 'document',
    image: {
      mimeType,
      byteSize: payload.length,
      width: input.image ? input.image.width : (input.width ?? null),
      height: input.image ? input.image.height : (input.height ?? null),
      checksum,
    },
    markers: {
      total: markers.length,
      matchedKeys,
      unmatched,
      // Grouped the way the picture is drawn: one entry per state, in the order the frames appear.
      frames: summarizeFrames(markers),
    },
    components: input.legend ?? [],
    // The guidance a caller needs to fix its own upload: the agent reads this and corrects the next one.
    report,
    // Relative to the API base, not absolute: the browser client is handed `/api/v1/...` and adds its
    // own base, so an absolute path here produced `/api/v1/api/v1/...` and a 404 the dialog could
    // only report as a broken sketch.
    //
    // A replica has no picture: `imagePath` points at the page instead, so a caller that renders
    // "whatever this screen is" needs one field rather than a kind check.
    imagePath: `/projects/${input.projectId}/mockups/${mockupId}/${input.image ? 'image' : 'document'}`,
  };
}

/** How many markers each frame holds, in the order the frames were drawn. */
function summarizeFrames(markers: readonly { frame?: string | null }[]): { title: string; markers: number }[] {
  const frames: { title: string; markers: number }[] = [];
  for (const marker of markers) {
    if (!marker.frame) continue;
    const existing = frames.find((frame) => frame.title === marker.frame);
    if (existing) existing.markers += 1;
    else frames.push({ title: marker.frame, markers: 1 });
  }
  return frames;
}

export interface ScreenMockupSummary {
  id: string;
  name: string;
  platform: string;
  locale: string;
  /** A picture the platform drew, or the page itself. Decides what a client renders. */
  kind: 'image' | 'document';
  width: number | null;
  height: number | null;
  mimeType: string;
  byteSize: number;
  markerCount: number;
  updatedAt: Date;
  /** Present only with `include=unmatched`: markers pointing at a key the project does not have. */
  unmatchedKeys?: number;
  /** Present only with `include=unmatched`: the codes from the report written when it was uploaded. */
  findings?: string[];
}

/** Screens of a project, newest first, without the image bytes. */
export async function listScreenMockups(
  tx: PrismaTypes.TransactionClient,
  projectId: string,
  /**
   * `includeUnmatched` adds, per screen, how many of its markers point at a key the project does not
   * have, plus the codes from the report written when it was uploaded.
   *
   * A caller that uploads screen after screen has no way to see the shape of what it has done — which
   * pages are up, how many of each one's strings are still unattached, when each was last touched — and
   * ends up keeping that ledger itself. `qa/issues` is about *translations* and never covered this.
   * Opt-in because it costs a second query, and most reads of the list do not need it.
   */
  filters: { platform?: PlatformName; includeUnmatched?: boolean } = {},
): Promise<ScreenMockupSummary[]> {
  const rows = await tx.screenMockup.findMany({
    where: { projectId, ...(filters.platform ? { platform: filters.platform as never } : {}) },
    // `image` is never selected here: a list of screens should not drag megabytes of bytes across the
    // wire, and Prisma returns every scalar column unless told otherwise.
    select: {
      id: true,
      name: true,
      platform: true,
      locale: true,
      width: true,
      height: true,
      mimeType: true,
      byteSize: true,
      updatedAt: true,
      // Only whether a page is there, not the markup: the list says which kind each screen is, and a
      // JSONB column of megabytes is not what "does this screen exist" costs.
      document: true,
      _count: { select: { markers: true } },
    },
    orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
  });
  const summaries = rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform as string,
    locale: row.locale,
    kind: row.document ? ('document' as const) : ('image' as const),
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    markerCount: row._count.markers,
    updatedAt: row.updatedAt,
  }));
  if (!filters.includeUnmatched || !summaries.length) return summaries;

  // One query for every screen rather than one per screen. A marker is unmatched when the project has
  // no live key with the same (namespace, key) — the same identity `resolveScreenMarkers` matches on,
  // so the count here and the "平台没有这个 Key" the editor shows agree by construction.
  const counts = await tx.$queryRaw<{ mockup_id: string; unmatched: bigint }[]>`
    SELECT m.mockup_id, count(*) AS unmatched
    FROM screen_mockup_markers m
    WHERE m.mockup_id = ANY(${summaries.map((summary) => summary.id)}::uuid[])
      AND NOT EXISTS (
        SELECT 1 FROM translation_keys k
        JOIN namespaces n ON n.id = k.namespace_id
        WHERE k.project_id = ${projectId}::uuid
          AND k.key = m.key
          AND n.name = m."namespace"
          AND k.archived_at IS NULL
      )
    GROUP BY m.mockup_id
  `;
  const unmatchedByMockup = new Map(counts.map((row) => [row.mockup_id, Number(row.unmatched)]));
  const findings = await tx.screenMockup.findMany({
    where: { id: { in: summaries.map((summary) => summary.id) } },
    select: { id: true, report: true },
  });
  const codesByMockup = new Map(
    findings.map((row) => {
      const report = row.report as unknown as { findings?: { code: string }[] } | null;
      return [row.id, (report?.findings ?? []).map((finding) => finding.code)];
    }),
  );
  return summaries.map((summary) => ({
    ...summary,
    unmatchedKeys: unmatchedByMockup.get(summary.id) ?? 0,
    findings: codesByMockup.get(summary.id) ?? [],
  }));
}

export interface ResolvedMarker {
  id: string;
  key: string;
  namespace: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  /** The text drawn in the sketch, as the uploader saw it. */
  text: string | null;
  /** The frame (state) the marker is in, on a board that shows several. */
  frame: string | null;
  /** The component the marker's element belongs to, matching a number in the legend. */
  component: string | null;
  note: string | null;
  /** The platform the key was actually found on; `null` when the key is not in the project. */
  platform: string | null;
  /** The platform's current source text for this key. `null` when the key is not in the project. */
  source: string | null;
  /** The translation in the requested locale. `null` when there is no entry for it yet. */
  entry: {
    entryId: string;
    value: string;
    status: ReviewStatus;
    revision: number;
    updatedAt: Date;
  } | null;
}

/**
 * Join a screen's markers with the source text and the translation they point at.
 *
 * Reads two rows per marker at most, in two queries rather than 2N, and reports what it could not
 * find instead of dropping it: "this marker has no key yet" and "this key has no translation in the
 * locale you are looking at" are different facts, and the editor shows them differently.
 *
 * Markers come back in reading order (top to bottom, left to right) so the numbered badges in the
 * dialog follow the screen rather than the order the caller happened to list them in.
 */
export async function resolveScreenMarkers(
  tx: PrismaTypes.TransactionClient,
  params: { projectId: string; platform: string; markers: {
    id: string;
    key: string;
    namespace: string;
    x: number;
    y: number;
    width: number | null;
    height: number | null;
    text: string | null;
    frame: string | null;
    component: string | null;
    note: string | null;
  }[]; locale: string | null },
): Promise<ResolvedMarker[]> {
  const ordered = [...params.markers].sort((a, b) => a.y - b.y || a.x - b.x);
  if (!ordered.length) return [];

  const keyNames = [...new Set(ordered.map((marker) => marker.key))];
  const keys = await tx.translationKey.findMany({
    // No platform filter — see the note in `upsertScreenMockup`: the field a caller sets never reaches
    // a key's stored platform today, so requiring it here would resolve nothing. Archived keys *are*
    // filtered: the editor's own list does not show them, and a sketch that presents one as current
    // would offer an 「在编辑器中打开」 that lands on a row the editor cannot display.
    where: { projectId: params.projectId, key: { in: keyNames }, archivedAt: null },
    select: {
      id: true,
      key: true,
      platform: true,
      namespace: { select: { name: true } },
      sourceVersions: { orderBy: { version: 'desc' }, take: 1, select: { value: true } },
    },
    // Deterministic when one key name exists on several platforms: the screen's platform wins, then
    // the order is fixed so two calls cannot disagree about which row a marker points at.
    orderBy: [{ platform: 'asc' }, { id: 'asc' }],
  });

  const byIdentity = new Map<string, typeof keys>();
  for (const row of keys) {
    const identity = `${row.namespace.name}\u0000${row.key}`;
    const bucket = byIdentity.get(identity);
    if (bucket) bucket.push(row);
    else byIdentity.set(identity, [row]);
  }
  /** The screen's own platform when the key exists there, otherwise the first row in platform order. */
  const pickKey = (identity: string) => {
    const bucket = byIdentity.get(identity);
    if (!bucket?.length) return null;
    return bucket.find((row) => (row.platform as string) === params.platform) ?? bucket[0]!;
  };

  // Canonicalised the same way the write path and the project's locale list are: entries are stored
  // under the canonical tag, so `?locale=EN-US` used to match nothing and report every string as
  // untranslated — a wrong answer with a 200, which is the hardest kind to notice.
  const locale = params.locale && isValidLocaleTag(params.locale) ? canonicalizeLocaleTag(params.locale) : params.locale;
  const entries = locale
    ? await tx.translationEntry.findMany({
        where: {
          projectId: params.projectId,
          localeCode: locale,
          keyId: { in: keys.map((row) => row.id) },
        },
        select: { id: true, keyId: true, value: true, status: true, revision: true, updatedAt: true },
      })
    : [];
  const entryByKeyId = new Map(entries.map((row) => [row.keyId, row]));

  return ordered.map((marker) => {
    const identity = `${marker.namespace}\u0000${marker.key}`;
    const row = pickKey(identity);
    const entry = row ? entryByKeyId.get(row.id) : undefined;
    return {
      id: marker.id,
      key: marker.key,
      namespace: marker.namespace,
      x: marker.x,
      y: marker.y,
      width: marker.width,
      height: marker.height,
      text: marker.text,
      // The editor groups markers by frame (the state they belong to) and lists and highlights them by
      // component, so both travel with the marker rather than being re-derived from the picture.
      frame: marker.frame,
      component: marker.component,
      note: marker.note,
      platform: (row?.platform as string | undefined) ?? null,
      source: row?.sourceVersions[0]?.value ?? null,
      entry: entry
        ? {
            entryId: entry.id,
            value: entry.value,
            status: entry.status as ReviewStatus,
            revision: entry.revision,
            updatedAt: entry.updatedAt,
          }
        : null,
    };
  });
}
