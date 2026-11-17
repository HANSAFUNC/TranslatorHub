import type { Prisma } from '@localehub/database';
import {
  ErrorCode,
  LocaleHubError,
  MAX_MARKERS_PER_MOCKUP,
  MAX_MOCKUP_BYTES,
  MAX_MOCKUP_DIMENSION,
  analyzeSketch,
  canonicalizeLocaleTag,
  defaultViewport,
  detectImageType,
  extractUiSpec,
  imageDimensions,
  isValidLocaleTag,
  normalizeMarker,
  renderUiSketch,
  type MockupImageType,
  type MockupMarkerInput,
  type PlatformName,
  type ReviewStatus,
  type MockupReport,
  type UiLegendItem,
  type UiSpec,
  type UiTheme,
  uiSpecIssues,
  unsafeSvgReasons,
} from '@localehub/contracts';
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
      'ui 描述里没有任何带文字的节点，画出来的草图没有可标记的 key。给 text / button / badge / input 节点填上文字。',
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
      `根据 ui 描述生成的草图有 ${Math.round(bytes.length / 1024)} KB，超过 ${Math.round(MAX_MOCKUP_BYTES / 1024 / 1024)} MB 的图片上限。少画一些元素，或把屏幕拆开。`,
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
 * The one place that decides which of the two input shapes a caller used.
 *
 * `upload_screen_mockup` accepts either a picture (`image_base64` + `markers`) or a description
 * (`ui`), and so does `POST /projects/:projectId/mockups`. Resolving the pair here keeps the two
 * surfaces from disagreeing about what is required — a caller that sends neither, or both, gets the
 * same sentence whichever door it came through.
 */
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

export function resolveMockupInput(input: {
  imageBase64?: string | null;
  mimeType?: string | null;
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
  frames?: readonly { title: string; html?: string | null; ui?: UiSpec | null }[] | null;
  /**
   * The screen's platform, used only to pick the canvas size when the `ui` description does not
   * carry one of its own.
   *
   * Without this the platform of the *call* never reached the renderer, so an `ios` screen whose
   * description omitted `platform` was laid out on a 1280×800 canvas — and omitting it is exactly
   * what the sketch guide tells a caller to do, because the screen's identity comes from the call.
   */
  platform?: string | null;
}): { image: DecodedMockupImage; markers: MockupMarkerInput[]; legend: UiLegendItem[] } {
  const hasImage = Boolean(input.imageBase64);
  const hasUi = Boolean(input.ui);
  const hasHtml = Boolean(input.html);

  if ([hasImage, hasUi, hasHtml].filter(Boolean).length > 1) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      '三种输入选一种：ui（界面描述）、html（页面源码）、image_base64（自己画的图，配 markers）。不要同时传。',
      422,
    );
  }

  if (input.frames?.length) {
    if (hasUi || hasHtml || hasImage) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        '传了 frames 就不要再传 ui / html / image_base64：每个状态在自己的 frame 里给。',
        422,
      );
    }
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
    return { image: rendered.image, markers: rendered.markers, legend: rendered.legend };
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
    return { image: rendered.image, markers: rendered.markers, legend: rendered.legend };
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
    return { image: rendered.image, markers: rendered.markers, legend: rendered.legend };
  }

  if (!hasImage) {
    throw new LocaleHubError(
      ErrorCode.VALIDATION_ERROR,
      '缺少草图：传 ui（界面描述）、html（页面源码），或者 image_base64 + markers（自己画的图，坐标要自己量）。',
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
    markers,
    // A hand-drawn picture has no components to number; the legend is what a description produces.
    legend: [],
  };
}

export interface UpsertScreenMockupInput {
  organizationId: string;
  projectId: string;
  userId: string | null;
  name: string;
  platform: PlatformName;
  locale: string;
  image: DecodedMockupImage;
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
  tx: Prisma.TransactionClient,
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
  assertMockupDimensions(input.image);

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
  const checksum = createHash('sha256').update(input.image.bytes).digest('hex');

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

  const report = analyzeSketch({
    svg: input.image.bytes.toString('utf8'),
    markers: markers.map((marker) => ({
      key: marker.key,
      namespace: marker.namespace,
      frame: marker.frame ?? null,
      component: marker.component ?? null,
      text: marker.text ?? null,
      missing: !known.has(`${marker.namespace}\u0000${marker.key}`),
    })),
    legend: input.legend ?? [],
  });

  const data = {
    legend: (input.legend ?? []) as unknown as Prisma.InputJsonValue,
    report: report as unknown as Prisma.InputJsonValue,
    organizationId: input.organizationId,
    projectId: input.projectId,
    name: input.name,
    platform: input.platform as never,
    locale,
    width: input.image.width,
    height: input.image.height,
    mimeType: input.image.mimeType,
    byteSize: input.image.bytes.length,
    contentHash: checksum,
    // `Uint8Array` rather than the `Buffer` we validated: Prisma 6 types a Bytes column as
    // `Uint8Array<ArrayBuffer>`, and a Buffer's backing store is `ArrayBufferLike`, which includes
    // SharedArrayBuffer. One copy per upload is cheaper than fighting the variance.
    image: new Uint8Array(input.image.bytes),
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
  const mockupId = input.replace
    ? (
        await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO screen_mockups (
            id, organization_id, project_id, name, platform, locale,
            width, height, mime_type, byte_size, content_hash, image, legend, report, created_by_id,
            created_at, updated_at
          )
          VALUES (
            gen_random_uuid(), ${data.organizationId}::uuid, ${data.projectId}::uuid, ${data.name},
            ${data.platform}::text::"PlatformKind", ${data.locale},
            ${data.width}, ${data.height}, ${data.mimeType}, ${data.byteSize},
            ${data.contentHash}, ${data.image}, ${JSON.stringify(data.legend)}::jsonb, ${JSON.stringify(data.report)}::jsonb, ${data.createdById}::uuid,
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
            legend = EXCLUDED.legend,
            report = EXCLUDED.report,
            created_by_id = EXCLUDED.created_by_id,
            updated_at = now()
          RETURNING id
        `
      )[0]!.id
    : (await tx.screenMockup.create({ data, select: { id: true } })).id;

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
    image: {
      mimeType: input.image.mimeType,
      byteSize: input.image.bytes.length,
      width: input.image.width,
      height: input.image.height,
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
    imagePath: `/projects/${input.projectId}/mockups/${mockupId}/image`,
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
  width: number | null;
  height: number | null;
  mimeType: string;
  byteSize: number;
  markerCount: number;
  updatedAt: Date;
}

/** Screens of a project, newest first, without the image bytes. */
export async function listScreenMockups(
  tx: Prisma.TransactionClient,
  projectId: string,
  filters: { platform?: PlatformName } = {},
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
      _count: { select: { markers: true } },
    },
    orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform as string,
    locale: row.locale,
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    markerCount: row._count.markers,
    updatedAt: row.updatedAt,
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
  tx: Prisma.TransactionClient,
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
