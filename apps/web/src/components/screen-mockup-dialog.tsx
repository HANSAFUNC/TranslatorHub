'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, ImageIcon, Monitor, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { StatusBadge } from '@/components/status-badge';
import { useAsync, timeAgo } from '@/components/use-async';
import { API_BASE, fetchObjectUrl, get, post, type MockupDetail, type MockupMarker, type MockupSummary } from '@/lib/api';
import { localeDisplayName } from '@localehub/contracts/locale';
import { cn } from '@/lib/utils';

import { SketchCanvas } from './sketch-canvas';

/**
 * The 90% detail view: the screen on the left, the translations on the right.
 *
 * A translation key says what a string is, never where it lives, so `checkout.pay_now` reaches a
 * translator as three words with no button under them. This dialog puts back the missing half. The
 * sketch on the left is what the caller saw; each numbered box is a key's text at its position on
 * that screen. The list on the right is the same keys with their translations in the locale being
 * reviewed.
 *
 * The two panes are linked both ways, which is the whole point: click a marker and its rows scroll
 * into view and light up; click a row and its markers light up. Numbers are what tie them together —
 * the same number appears on the box and on the row.
 */

/**
 * Load a binary resource as an object URL, revoking it when the source changes.
 *
 * `<img src>` pointing straight at the API is not reliable (the credential and the CORS rules depend
 * on the deployment), so the image travels the same path as every other request. What comes back is
 * an object URL for raster sketches and a data URL for SVG ones (see `fetchObjectUrl`); only the
 * former needs releasing, and not releasing it leaks the whole blob for the life of the tab, so a
 * reviewer clicking through ten screens would leak ten of them.
 */
/** Only object URLs are ours to release; a `data:` URL is a string with nothing to free. */
function revokeIfObjectUrl(url: string | null): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

function useObjectUrl(path: string | null): { url: string | null; error: unknown } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    if (!path) {
      setUrl(null);
      return;
    }
    void (async () => {
      try {
        created = await fetchObjectUrl(path);
        if (revoked) {
          revokeIfObjectUrl(created);
          return;
        }
        setUrl(created);
        setError(null);
      } catch (err) {
        if (!revoked) setError(err);
      }
    })();
    return () => {
      revoked = true;
      revokeIfObjectUrl(created);
      setUrl(null);
    };
  }, [path]);

  return { url, error };
}

/**
 * The number's own size, in the picture's pixels.
 *
 * Not a fraction: a badge is a printed label, so it is the same size on screen whatever the screen is
 * — a phone sketch and a 1440-wide replica get the same chip. It is in the picture's coordinate space
 * because that is what the canvas scales, so zooming in grows it with the picture like the annotation
 * it is.
 */
const BADGE_WIDTH = 17;
const BADGE_HEIGHT = 17;
/** Clearance between a number and the outline it belongs to, in screen pixels. */
const BADGE_GAP = 2;

/**
 * The identity the two panes agree on: a key plus its namespace.
 *
 * Nothing invisible in the separator. The DOM attributes below are read back with `CSS.escape`, which
 * replaces a NUL byte with U+FFFD — so an identity built with `\u0000` matched no element and every
 * click through `querySelector` silently did nothing. A character a namespace cannot contain (it is a
 * `.strings` table name) is both safe in a selector and readable in the inspector.
 */
/**
 * One marker's identity: the key, its namespace, and the frame it is in.
 *
 * The frame matters as soon as a board shows several states: the same key is on screen in each of them,
 * and identifying markers by key alone made four boxes and four rows light up at once — clicking one
 * occurrence looked like the panel had selected the whole board.
 */
function markerKey(marker: { key: string; namespace: string; frame?: string | null }): string {
  return `${marker.namespace}\u001f${marker.key}\u001f${marker.frame ?? ''}`;
}

export function ScreenMockupDialog({
  projectId,
  open,
  onOpenChange,
  locales,
  sourceLocale,
  defaultLocale,
  focusEntryId,
  focusKey,
  focusNamespace,
  onOpenInEditor,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locales: { code: string; name: string }[];
  sourceLocale: string | undefined;
  /** The locale the editor is filtered to, so the dialog opens on the same one. */
  defaultLocale: string | null;
  /** The entry selected in the editor, focused when the dialog opens. */
  focusEntryId: string | null;
  focusKey: string | null;
  /** Namespace of the focused key: (namespace, key) is the identity, a bare key is not. */
  focusNamespace?: string | null;
  /** "Open in the editor": closes the dialog and lands on that entry. */
  onOpenInEditor: (entry: { entryId: string; value: string }) => void;
}) {
  const [mockupId, setMockupId] = useState<string | null>(null);
  const [locale, setLocale] = useState<string | null>(defaultLocale);
  const [selected, setSelected] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const targetLocales = useMemo(() => locales.filter((entry) => entry.code !== sourceLocale), [locales, sourceLocale]);

  // Reset on each open: the dialog is opened for a specific entry, and the state from the last visit
  // (a screen the reader has since left, a locale they were comparing) is noise, not a preference.
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    // Also forgotten: the screen. Keeping the previous choice meant the list refetched with the new
    // key but the dialog stayed on the screen the reader looked at last time, so the containsKey
    // answer it had just asked for was ignored from the second open onwards.
    setMockupId(null);
    setLocale((current) => {
      if (defaultLocale && targetLocales.some((entry) => entry.code === defaultLocale)) return defaultLocale;
      if (current && targetLocales.some((entry) => entry.code === current)) return current;
      return targetLocales[0]?.code ?? null;
    });
  }, [open, defaultLocale, targetLocales]);

  // `containsKey` answers "which screen is the entry I have selected on?" — the dialog should open on
  // that one rather than on whichever sketch was uploaded last.
  const { data: mockups, error: listError, loading: listLoading } = useAsync(
    () =>
      open
        ? get<MockupSummary[]>(
            `/projects/${projectId}/mockups${
              focusKey ? `?key=${encodeURIComponent(focusKey)}&namespace=${encodeURIComponent(focusNamespace ?? '')}` : ''
            }`,
          )
        : Promise.resolve([]),
    [projectId, open, focusKey, focusNamespace],
  );

  useEffect(() => {
    if (!open || !mockups?.length) {
      if (open && mockups && !mockups.length) setMockupId(null);
      return;
    }
    setMockupId((current) => {
      if (current && mockups.some((mockup) => mockup.id === current)) return current;
      return (mockups.find((mockup) => mockup.containsKey) ?? mockups[0]!).id;
    });
  }, [open, mockups]);

  const {
    data: detail,
    error: detailError,
    loading: detailLoading,
    reload: reloadDetail,
  } = useAsync(
    () =>
      open && mockupId
        ? get<MockupDetail>(`/projects/${projectId}/mockups/${mockupId}${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`)
        : Promise.resolve(null),
    [projectId, open, mockupId, locale],
  );

  /** A replica has no picture of ours to fetch: the page travels to the frame below. */
  const isReplica = detail?.mockup.kind === 'document';
  const { url: imageUrl, error: imageError } = useObjectUrl(
    open && detail && !isReplica ? detail.mockup.imagePath : null,
  );

  const markers = useMemo(() => detail?.markers ?? [], [detail]);

  /**
   * Save a translation from the screen it belongs to.
   *
   * The reader is looking at the page, at the string, with the surrounding context in front of them —
   * sending them to the editor to type the value loses exactly the thing that made them open this. The
   * call is the editor's own (`POST /translations/:id/draft`), so a draft written here and a draft
   * written there are the same draft: same endpoint, same revision check, same review workflow.
   */
  const saveMarkerValue = useCallback(
    async (entryId: string, value: string): Promise<void> => {
      await post(`/projects/${projectId}/translations/${entryId}/draft`, { value });
      await reloadDetail();
    },
    [projectId, reloadDetail],
  );

  /**
   * The replica's frame, and what the browser measured inside it.
   *
   * A page's layout belongs to a browser, and the platform is not one — so a replica's markers carry
   * no coordinates at all. The frame is rendered here, and its elements are measured here, which is
   * also the only way a box can be right for a font the platform has never seen. The measurement lands
   * in fractions of the page, the same coordinate system a drawn sketch uses, so everything downstream
   * (rendering, zooming, linking a marker to a row) is the same code.
   */
  /** What the canvas is currently scaled by, so the number labels can stay a constant screen size. */
  const [canvasScale, setCanvasScale] = useState(1);
  const replicaFrameRef = useRef<HTMLIFrameElement | null>(null);
  const replicaFrames = useMemo(() => detail?.mockup.frames ?? [], [detail]);
  const [replicaFrame, setReplicaFrame] = useState<string | null>(null);
  const [measured, setMeasured] = useState<{
    width: number;
    height: number;
    /**
     * One entry per place the marker appears.
     *
     * A key can legitimately be on a page twice — a label repeated in two rows — and collapsing those
     * into one union rectangle would draw a box over everything between them.
     */
    boxes: Map<string, { x: number; y: number; width: number; height: number }[]>;
  } | null>(null);

  useEffect(() => {
    setReplicaFrame(replicaFrames[0] ?? null);
    setMeasured(null);
  }, [detail?.mockup.id, replicaFrames]);

  const replicaViewport = useMemo(() => {
    const width = detail?.mockup.width ?? 390;
    const height = detail?.mockup.height ?? 800;
    return { width, height };
  }, [detail?.mockup.width, detail?.mockup.height]);

  /** Read the rendered page: its size, and the rectangle of every element that names a key. */
  const measureReplica = useCallback(() => {
    const doc = replicaFrameRef.current?.contentDocument;
    const root = doc?.documentElement;
    if (!doc || !root) return;
    const width = Math.max(1, root.scrollWidth);
    const height = Math.max(1, root.scrollHeight);
    const boxes = new Map<string, { x: number; y: number; width: number; height: number }[]>();
    const attributes = ['data-key', 'data-i18n-key', 'i18n-key', 'data-i18n'];
    for (const node of doc.querySelectorAll(attributes.map((name) => `[${name}]`).join(','))) {
      const key = attributes.map((name) => node.getAttribute(name)?.trim()).find(Boolean);
      if (!key) continue;
      // Which marker this element is: the same key in the frame on screen. An element that declares
      // its own namespace picks the marker in it, so a project with two `.strings` tables that both
      // hold `title` measures the right one.
      const declared = node.getAttribute('data-namespace')?.trim();
      const inFrame = markers.filter(
        (marker) => marker.key === key && (!replicaFrame || !marker.frame || marker.frame === replicaFrame),
      );
      const marker = (declared ? inFrame.find((candidate) => (candidate.namespace || '') === declared) : undefined) ?? inFrame[0];
      if (!marker) continue;
      const rect = node.getBoundingClientRect();
      const identity = markerKey(marker);
      const list = boxes.get(identity) ?? [];
      list.push({
        x: rect.left / width,
        y: rect.top / height,
        width: rect.width / width,
        height: rect.height / height,
      });
      boxes.set(identity, list);
    }
    setMeasured({ width, height, boxes });
  }, [markers, replicaFrame]);

  useEffect(() => {
    if (!isReplica) setMeasured(null);
  }, [isReplica]);

  /**
   * The picture's own pixel size, which is what the canvas scales.
   *
   * The sketch is drawn at this size and transformed, never re-laid-out: every marker is a percentage
   * of it, so a re-layout would move the text out from under its boxes.
   */
  const natural = useMemo(() => {
    // A replica's size is not stored anywhere: a responsive page is as wide as the viewport it is
    // laid out at and as tall as its content, and only a browser knows the second number. Until the
    // frame has loaded, the stored viewport stands in so the canvas has something to reserve.
    if (isReplica) return measured ? { width: measured.width, height: measured.height } : replicaViewport;
    const width = detail?.mockup.width;
    const height = detail?.mockup.height;
    return width && height ? { width, height } : null;
  }, [detail?.mockup.width, detail?.mockup.height, isReplica, measured, replicaViewport]);

  /**
   * The state (frame) or component the reader has picked out.
   *
   * A board of four states and a legend of six components is a lot of picture: picking one dims
   * everything that is not it, which is how "where does this button appear?" gets answered.
   */
  const [highlight, setHighlight] = useState<{ kind: 'frame' | 'component'; value: string } | null>(null);

  useEffect(() => {
    setHighlight(null);
  }, [detail?.mockup.id]);

  /** The states this board shows, in the order the picture draws them (markers are in reading order). */
  const frames = useMemo(() => {
    // A replica lists its states from the document itself — the caller sent them in order, and a state
    // with no keys at all is still a state worth showing. A drawn sketch can only list the states its
    // markers are in, because the picture is the only thing that knows them.
    if (isReplica && replicaFrames.length) return replicaFrames;
    const seen: string[] = [];
    for (const marker of markers) if (marker.frame && !seen.includes(marker.frame)) seen.push(marker.frame);
    return seen;
  }, [markers, isReplica, replicaFrames]);

  const components = detail?.mockup.components ?? [];

  const isDimmed = (marker: MockupMarker): boolean => {
    // A replica shows one state at a time, so everything belonging to another state is beside the
    // point while it is on screen.
    if (isReplica && replicaFrame && marker.frame && marker.frame !== replicaFrame) return true;
    if (!highlight) return false;
    return highlight.kind === 'frame' ? marker.frame !== highlight.value : marker.component !== highlight.value;
  };

  /**
   * Where each number goes: outside its box, and never on top of another number.
   *
   * The number used to sit inside the box, over the very text it was pointing at — which is what made
   * a marked-up screen unreadable: the annotation covered the thing it annotated, and two boxes close
   * together put their numbers on top of each other. So the box is now a bare red outline and the
   * number is placed *outside* it, in the first position that collides with neither another number nor
   * the box it belongs to. Positions are fractions of the stage, like everything else here, with the
   * badge's own size expressed in the picture's pixels so it stays the same size on screen.
   */
  const badgePlacements = useMemo(() => {
    const placements = new Map<string, { x: number; y: number }>();
    if (!natural) return placements;
    // The stage is scaled to fit, so a badge sized in the picture's pixels would come out 9px wide on
    // a tall page — the label has to be the same size on screen whatever the zoom, which means its
    // picture-space size is its screen size divided by the current scale.
    const width = BADGE_WIDTH / canvasScale / natural.width;
    const height = BADGE_HEIGHT / canvasScale / natural.height;
    const taken: { x: number; y: number; width: number; height: number }[] = [];

    const entries: { key: string; box: { x: number; y: number; width: number | null; height: number | null } }[] = [];
    for (const marker of markers) {
      const identity = markerKey(marker);
      const boxes = isReplica
        ? (measured?.boxes.get(identity) ?? [])
        : [{ x: marker.x, y: marker.y, width: marker.width, height: marker.height }];
      boxes.forEach((box, occurrence) => entries.push({ key: `${marker.id}-${occurrence}`, box }));
    }
    // Reading order, so the numbers run the way the eye does.
    entries.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

    const boxesOfOthers = entries.map((entry) => ({
      x: entry.box.x,
      y: entry.box.y,
      width: entry.box.width ?? 0,
      height: entry.box.height ?? 0,
    }));

    for (const entry of entries) {
      const boxWidth = entry.box.width ?? 0;
      const boxHeight = entry.box.height ?? 0;
      // A hair of clearance, so the number reads as a label *beside* the outline rather than as part
      // of it — touching is not overlapping, but at 18px it looks like a mistake.
      const gap = BADGE_GAP / canvasScale / natural.height;
      const candidates = [
        { x: entry.box.x, y: entry.box.y - height - gap }, // above the box, outside it
        { x: entry.box.x + boxWidth - width, y: entry.box.y - height - gap }, // above, at its right edge
        { x: entry.box.x, y: entry.box.y + boxHeight + gap }, // below the box
        { x: entry.box.x + boxWidth - width, y: entry.box.y + boxHeight + gap }, // below, at its right edge
        { x: entry.box.x, y: entry.box.y }, // inside, only when the stage leaves no room outside
      ];
      // The best candidate is the one that covers the least: never another number (four times as bad —
      // a number hidden behind a number is a number lost), and preferably not another control's
      // outline either. Off the stage at all is worst, because there it cannot be read.
      const share = (
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number },
      ): number =>
        Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const cost = (candidate: { x: number; y: number }): number => {
        const rect = { ...candidate, width, height };
        const outside =
          Math.max(0, -candidate.x) + Math.max(0, -candidate.y) + Math.max(0, candidate.x + width - 1) + Math.max(0, candidate.y + height - 1);
        const onBadge = taken.reduce((sum, other) => sum + share(rect, other), 0);
        const onBox = boxesOfOthers.reduce((sum, other) => sum + share(rect, other), 0);
        return outside * 1000 + onBadge * 4 + onBox * 3;
      };
      const chosen = candidates.reduce((best, candidate) => (cost(candidate) < cost(best) ? candidate : best), candidates[0]!);
      taken.push({ ...chosen, width, height });
      placements.set(entry.key, chosen);
    }
    return placements;
  }, [markers, isReplica, measured, natural, canvasScale]);

  /** Which key the panes agree is current: the marker list, or the entry the editor had selected. */
  const activeKey = useMemo(() => {
    if (selected) return selected;
    if (focusKey) {
      // Identity is key *and* namespace: comparing the key name alone picked a marker in another
      // namespace on a project whose iOS keys repeat across `.strings` tables, and highlighted the
      // wrong row. Done here rather than through the contract's `markerMatchesKey` because the web
      // bundle imports only the zod-free contract subpaths, and pulling that module in for two lines
      // would ship zod to the browser.
      const namespace = focusNamespace ?? '';
      const match = markers.find((marker) => marker.key === focusKey && (marker.namespace || '') === namespace);
      if (match) return markerKey(match);
    }
    const focused = markers.find((marker) => marker.entry?.entryId === focusEntryId);
    return focused ? markerKey(focused) : null;
  }, [selected, focusKey, focusNamespace, focusEntryId, markers]);

  const select = useCallback((identity: string) => setSelected(identity), []);

  // Both directions scroll: a marker clicked on the left has to bring its row into view, and a row
  // clicked on the right has to bring its box into view. Only the highlighted half is scrolled, so
  // clicking never yanks the pane the reader is already looking at.
  useEffect(() => {
    if (!activeKey) return;
    rowRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest' });
    document.querySelector(`[data-marker="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The width is stated twice on purpose: `DialogContent` ships `sm:max-w-lg`, so a plain
          `max-w-[94vw]` would lose to it above 640px and pin the dialog to 32rem — the opposite of
          the 90% this view exists for. */}
      <DialogContent
        className="flex h-[92svh] w-[94vw] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:h-[90svh] sm:w-[90vw] sm:max-w-[90vw]"
      >
        <DialogHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-b px-6 py-4 pr-14 text-left">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="size-4" />
              界面草图
            </DialogTitle>
            <DialogDescription className="truncate">
              {detail
                ? `${detail.mockup.name} · ${detail.mockup.platform} · ${detail.mockup.locale}${
                    detail.mockup.kind === 'document'
                      ? ` · 整页复刻${isReplica && measured ? ` · ${measured.width}×${measured.height}` : ''}${
                          replicaFrames.length > 1 ? ` · ${replicaFrames.length} 个状态` : ''
                        }`
                      : ` · 草图${detail.mockup.width ? ` ${detail.mockup.width}×${detail.mockup.height}` : ''}`
                  } · 更新于 ${timeAgo(detail.mockup.updatedAt)}`
                : isReplica
                  ? '左侧是调用端上传的整页复刻（沙箱渲染，脚本不执行），右侧是对应译文；点标记或条目会互相跳转'
                  : '左侧是调用端上传的界面草图，右侧是对应译文；点标记或条目会互相跳转'}
            </DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mockups && mockups.length > 1 ? (
              <Select value={mockupId ?? undefined} onValueChange={(value) => { setMockupId(value); setSelected(null); }}>
                <SelectTrigger size="sm" className="w-[180px]">
                  <SelectValue placeholder="选择界面" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {mockups.map((mockup) => (
                      <SelectItem key={mockup.id} value={mockup.id}>
                        {mockup.name} · {mockup.platform}
                        {mockup.containsKey ? ' · 含当前 Key' : ''}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <Select
              value={locale ?? undefined}
              onValueChange={(value) => { setLocale(value); setSelected(null); }}
            >
              <SelectTrigger size="sm" className="w-[190px]">
                <SelectValue placeholder="选择目标语言" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {targetLocales.map((entry) => (
                    <SelectItem key={entry.code} value={entry.code}>
                      {entry.code} · {entry.name || localeDisplayName(entry.code)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </DialogHeader>

        <ErrorAlert error={listError ?? detailError ?? imageError} />

        {/* The platform's own reading of the sketch: the failures here are quiet ones (a picture that
            came out as a grey box, a page that contributed no colour, four states that are copies), so
            the dialog says them out loud, with what to do about each. */}
        {detail?.mockup.report && !detail.mockup.report.clean ? (
          <div className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 mx-4 mt-2 flex flex-col gap-1 rounded-md border px-3 py-2 text-xs">
            <span className="font-medium">这张草图有 {detail.mockup.report.findings.length} 处可以改进</span>
            {detail.mockup.report.findings.map((finding) => (
              <div key={finding.code} className="flex flex-col gap-0.5">
                <span>
                  {finding.severity === 'warning' ? '⚠ ' : '· '}
                  {finding.title}
                </span>
                <span className="text-muted-foreground pl-3">{finding.advice}</span>
              </div>
            ))}
          </div>
        ) : null}

        {!listLoading && mockups && mockups.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<ImageIcon />}
              title="这个项目还没有界面草图"
              description={
                <>
                  草图由能看见界面的一方上传：Agent 在仓库里画出界面（SVG 最省事），用 Remote MCP 的{' '}
                  <span className="font-mono">upload_screen_mockup</span> 连同每个 Key 的位置一起传上来，
                  标出文案在界面上的位置。坐标是相对图片的比例（0~1），不是像素。
                </>
              }
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* Left: the sketch, on a canvas that pans and zooms. A board of states is wider than the
                dialog and a phone screen is taller, so "fit" shows the shape and 1:1 shows the print. */}
            {detailLoading || !detail || !natural ? (
              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-4">
                <Skeleton className="h-64 w-full max-w-xl" />
              </div>
            ) : (
              <SketchCanvas
                width={natural.width}
                height={natural.height}
                label={`${detail.mockup.name} ${mockupId ?? ''}`}
                onScaleChange={setCanvasScale}
                controls={
                  <>
                    {frames.length > 1 ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground text-xs">状态</span>
                        {frames.map((frame) => (
                          <button
                            key={frame}
                            type="button"
                            /* A drawn board is one picture, so picking a state dims the others. A replica
                               is a pile of pages, so picking a state shows that one — there is no picture
                               holding them side by side to dim. */
                            onClick={() =>
                              isReplica
                                ? setReplicaFrame(frame)
                                : setHighlight(highlight?.kind === 'frame' && highlight.value === frame ? null : { kind: 'frame', value: frame })
                            }
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-xs transition-colors',
                              (isReplica ? replicaFrame === frame : highlight?.kind === 'frame' && highlight.value === frame)
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'hover:bg-muted',
                            )}
                          >
                            {frame}
                          </button>
                        ))}
                      </span>
                    ) : null}
                    {components.length ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground text-xs">组件</span>
                        {components.map((item) => (
                          <button
                            key={item.name}
                            type="button"
                            data-component={item.name}
                            onClick={() =>
                              setHighlight(highlight?.kind === 'component' && highlight.value === item.name ? null : { kind: 'component', value: item.name })
                            }
                            className={cn(
                              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                              highlight?.kind === 'component' && highlight.value === item.name ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
                            )}
                          >
                            <span
                              className={cn(
                                'flex size-4 items-center justify-center rounded-full text-[10px] font-medium tabular-nums',
                                highlight?.kind === 'component' && highlight.value === item.name ? 'bg-primary-foreground text-primary' : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {item.index}
                            </span>
                            {item.name}
                            {item.count > 1 ? <span className="text-muted-foreground">×{item.count}</span> : null}
                          </button>
                        ))}
                      </span>
                    ) : null}
                    {!frames.length && !components.length ? (
                      <span className="text-muted-foreground text-xs">
                        {isReplica ? '标记位置由浏览器实测。拖动平移，滚轮缩放' : '拖动平移，滚轮缩放'}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <span className="inline-block size-2 rounded-full bg-red-500" />
                      待译
                      <span className="bg-amber-500 inline-block size-2 rounded-full" />
                      译文还是空的
                    </span>
                  </>
                }
              >
                {isReplica ? (
                  /* The page itself, in a frame that cannot run anything. `allow-same-origin` and
                     nothing else: no scripts, no forms, no popups — while still letting this component
                     (its parent) read the rendered elements to place the markers, which is the only
                     way a page can be measured without the platform running a browser. */
                  <iframe
                    ref={replicaFrameRef}
                    key={replicaFrame ?? replicaFrames[0] ?? 'frame'}
                    title={`${detail.mockup.name} 复刻`}
                    sandbox="allow-same-origin"
                    src={`${API_BASE}${detail.mockup.imagePath}${replicaFrame ? `?frame=${encodeURIComponent(replicaFrame)}` : ''}`}
                    onLoad={measureReplica}
                    className="absolute inset-0 h-full w-full rounded-md border-0 bg-white"
                  />
                ) : imageUrl ? (
                  <img src={imageUrl} alt={`${detail.mockup.name} 界面草图`} className="absolute inset-0 h-full w-full rounded-md" />
                ) : (
                  <Skeleton className="absolute inset-0" />
                )}
                <div className="absolute inset-0">
                  {markers.map((marker, index) => {
                    const identity = markerKey(marker);
                    const isActive = identity === activeKey;
                    // "This one still needs a translation" is a property of the entry, not of the
                    // outline — so it colours the number outside the box, where it cannot hide the
                    // text the outline is drawn around.
                    const untranslated = marker.source !== null && (!marker.entry || !marker.entry.value);
                    // A replica's box is wherever the browser found the element. Until the frame has
                    // loaded there is nowhere to draw it — and a marker with no element on the page
                    // at all stays in the list beside, which is how a key that is not really on this
                    // screen becomes visible instead of silently absent.
                    const boxes = isReplica
                      ? (measured?.boxes.get(identity) ?? [])
                      : [{ x: marker.x, y: marker.y, width: marker.width, height: marker.height }];
                    return boxes.map((box, occurrence) => {
                      const key = `${marker.id}-${occurrence}`;
                      const anchored = Boolean(box.width || box.height);
                      const badge = badgePlacements.get(key);
                      const title = `${marker.key}${marker.frame ? `
状态：${marker.frame}` : ''}${marker.text ? `
草图：${marker.text}` : ''}`;
                      return (
                        <span key={key}>
                          {/* A bare outline: nothing is painted over the screen, so the control it
                              marks is still readable — which is the whole point of marking it. */}
                          <button
                            type="button"
                            data-marker={identity}
                            onClick={() => select(identity)}
                            title={title}
                            style={{
                              left: `${box.x * 100}%`,
                              top: `${box.y * 100}%`,
                              width: box.width ? `${box.width * 100}%` : undefined,
                              height: box.height ? `${box.height * 100}%` : undefined,
                            }}
                            className={cn(
                              'absolute rounded-[4px] border-2 border-red-500 bg-transparent text-left transition',
                              anchored ? '' : 'size-4 -translate-x-1/2 -translate-y-1/2 rounded-full',
                              isDimmed(marker) ? 'opacity-20' : 'hover:bg-red-500/10',
                              isActive ? 'border-red-600 ring-2 ring-red-500/40' : '',
                            )}
                          />
                          {badge ? (
                            /* The number, outside the outline and, as far as the stage allows, off
                               every other number. Clicking it selects the same entry the box does. */
                            <button
                              type="button"
                              data-badge={identity}
                              onClick={() => select(identity)}
                              title={title}
                              style={{
                                left: `${badge.x * 100}%`,
                                top: `${badge.y * 100}%`,
                                width: BADGE_WIDTH / canvasScale,
                                height: BADGE_HEIGHT / canvasScale,
                                fontSize: Math.max(8, 11 / canvasScale),
                              }}
                              className={cn(
                                'absolute flex items-center justify-center rounded-full font-semibold leading-none text-white tabular-nums shadow-sm ring-1 ring-white/70 transition',
                                untranslated ? 'bg-amber-500' : 'bg-red-500',
                                isDimmed(marker) ? 'opacity-20' : 'hover:brightness-110',
                                isActive ? 'ring-2 ring-red-500/50' : '',
                              )}
                            >
                              {index + 1}
                            </button>
                          ) : null}
                        </span>
                      );
                    });
                  })}
                </div>
              </SketchCanvas>
            )}

            {/* Right: the same keys, with the translation for the locale under review. */}
            <div className="flex min-h-0 flex-1 flex-col border-t lg:max-w-[38rem] lg:border-l lg:border-t-0">
              <div className="text-muted-foreground flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs">
                <span>
                  {markers.length} 个标记
                  {frames.length > 1 ? ` · ${frames.length} 个状态` : ''} · 目标语言{' '}
                  <span className="font-mono">{locale ? localeDisplayName(locale) : '—'}</span>
                </span>
                <span className="hidden sm:inline">点标记 ↔ 点条目，两侧互相跳转</span>
              </div>
              {detailLoading || !detail ? (
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-16" />
                  ))}
                </div>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="flex flex-col divide-y">
                    {markers.map((marker, index) => (
                      <MarkerRow
                        key={marker.id}
                        index={index}
                        marker={marker}
                        screenPlatform={detail.mockup.platform}
                        sketchLocale={detail.mockup.locale}
                        sourceLocale={sourceLocale}
                        active={markerKey(marker) === activeKey}
                        dimmed={isDimmed(marker)}
                        onHighlight={setHighlight}
                        onSelect={() => select(markerKey(marker))}
                        onOpenInEditor={onOpenInEditor}
                        onSave={saveMarkerValue}
                        register={(node) => {
                          if (node) rowRefs.current.set(markerKey(marker), node);
                          else rowRefs.current.delete(markerKey(marker));
                        }}
                      />
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MarkerRow({
  index,
  marker,
  screenPlatform,
  sketchLocale,
  sourceLocale,
  active,
  dimmed,
  onHighlight,
  onSelect,
  onOpenInEditor,
  onSave,
  register,
}: {
  index: number;
  marker: MockupMarker;
  screenPlatform: string;
  /** The language the sketch's text is drawn in. */
  sketchLocale: string;
  /** The project's source locale; drift is only meaningful when the two agree. */
  sourceLocale: string | undefined;
  active: boolean;
  /** Dimmed when the reader has picked out another state or component. */
  dimmed?: boolean;
  onHighlight: (highlight: { kind: 'frame' | 'component'; value: string }) => void;
  onSelect: () => void;
  onOpenInEditor: (entry: { entryId: string; value: string }) => void;
  /** Write this entry's draft. The editor's own call, so the two cannot disagree. */
  onSave: (entryId: string, value: string) => Promise<void>;
  register: (node: HTMLElement | null) => void;
}) {
  // `platform === null` is the marker's "this key is not in the project" signal, from the domain's
  // resolution. `source === null` is not the same thing: a key imported only under a non-source
  // locale has a key row and an entry but no SourceVersion, and calling that "平台没有这个 Key" told a
  // reviewer to import a key the editor already lists.
  // Editing happens here rather than somewhere else, so the state lives here: one row, one draft.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cancelEdit = (): void => {
    setEditing(false);
    setSaveError(null);
  };
  const save = async (): Promise<void> => {
    if (!marker.entry) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(marker.entry.entryId, draft);
      setEditing(false);
    } catch (error) {
      // Shown in the row, next to the box that caused it. A refusal here is usually a role the reader
      // does not have, and "nothing happened" is the one thing that would be worse than saying so.
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const missingKey = marker.platform === null;
  const untranslated = !missingKey && (!marker.entry || !marker.entry.value);
  // The sketch is drawn in its own language (`mockup.locale`), which is often — but not always — the
  // project's source. Comparing against the source text without checking that is how a sketch
  // deliberately drawn in ja-JP gets flagged on every marker as drifting from an en-US original.
  const textDrift = Boolean(
    marker.text && marker.source && sketchLocale === sourceLocale && marker.text !== marker.source,
  );

  return (
    <li
      ref={register}
      // Named for the same reason `data-marker` is: the browser check drives these two panes by
      // clicking them, and "the third <li>" is not a stable way to find a row.
      data-marker-row={markerKey(marker)}
      onClick={onSelect}
      className={cn(
        'cursor-pointer px-4 py-3 transition-colors',
        active ? 'bg-accent/70' : 'hover:bg-muted/50',
        dimmed ? 'opacity-40' : '',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium tabular-nums',
            active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-xs">{marker.key}</span>
            {/* Which state this string appears in, and which component it belongs to: on a board of
                frames the same key shows up several times, and the two chips are what tell them apart. */}
            {marker.frame ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onHighlight({ kind: 'frame', value: marker.frame! });
                }}
                className="bg-muted text-muted-foreground hover:bg-accent rounded-full px-2 py-0.5 text-[10px]"
              >
                {marker.frame}
              </button>
            ) : null}
            {marker.component ? (
              <button
                type="button"
                data-row-component={marker.component}
                onClick={(event) => {
                  event.stopPropagation();
                  onHighlight({ kind: 'component', value: marker.component! });
                }}
                className="bg-muted text-muted-foreground hover:bg-accent rounded-full px-2 py-0.5 text-[10px]"
              >
                {marker.component}
              </button>
            ) : null}
            {marker.namespace ? <Badge variant="muted" className="text-[10px]">{marker.namespace}</Badge> : null}
            {missingKey ? (
              <Badge variant="outline" className="text-[10px]">平台没有这个 Key</Badge>
            ) : marker.platform !== screenPlatform ? (
              // The key exists, just not on the platform this screen claims. Shown rather than
              // silently resolved: it usually means the sketch or the import named the wrong 端.
              <Badge variant="warning" className="text-[10px]">
                Key 在 {marker.platform}，不在 {screenPlatform}
              </Badge>
            ) : marker.entry ? (
              <StatusBadge status={marker.entry.status} />
            ) : (
              <Badge variant="outline" className="text-[10px]">该语言还没有条目</Badge>
            )}
          </div>

          <div className="mt-1 flex flex-col gap-0.5 text-sm">
            {marker.source ? <div className="text-muted-foreground truncate">{marker.source}</div> : null}
            <div className={cn('break-words', untranslated ? 'text-muted-foreground italic' : 'font-medium')}>
              {marker.entry?.value || (missingKey ? '—' : '未翻译')}
            </div>
          </div>

          {textDrift ? (
            <div className="text-muted-foreground mt-1 text-xs">草图里写的是「{marker.text}」，与平台原文不一致</div>
          ) : null}

          {editing ? (
            /* Editing in place, rather than sending the reader to the editor and losing the screen
               they were looking at. The save is the same call the editor makes
               (`POST /translations/:id/draft`), so a value written here is the same draft a value
               written there is — no second path, no second set of rules. */
            <div className="mt-2 flex flex-col gap-2" onClick={(event) => event.stopPropagation()}>
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') cancelEdit();
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save();
                }}
                rows={2}
                autoFocus
                aria-label={`${marker.key} 的译文`}
                data-marker-editor={markerKey(marker)}
                className="text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" disabled={saving || draft === (marker.entry?.value ?? '')} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存'}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={cancelEdit}>
                  取消
                </Button>
                {saveError ? <span className="text-destructive text-xs">{saveError}</span> : null}
                <span className="text-muted-foreground text-xs">⌘/Ctrl + Enter 保存，Esc 取消</span>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {marker.entry ? (
                <Button
                  type="button"
                  variant={active ? 'default' : 'outline'}
                  size="sm"
                  data-marker-edit={markerKey(marker)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDraft(marker.entry!.value);
                    setSaveError(null);
                    setEditing(true);
                  }}
                >
                  <Pencil data-icon="inline-start" />
                  编辑
                </Button>
              ) : marker.entry ? null : (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <ExternalLink className="size-3" />
                  导入该 Key 后即可编辑
                </span>
              )}
              {marker.entry ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenInEditor({ entryId: marker.entry!.entryId, value: marker.entry!.value });
                  }}
                >
                  在编辑器中打开
                </Button>
              ) : null}
              {marker.note ? <span className="text-muted-foreground truncate text-xs">{marker.note}</span> : null}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** The button the editor puts in its header. Lives here so the two stay in step. */
export function ScreenMockupButton({ count, onClick }: { count: number | null; onClick: () => void }) {
  return (
    <Button variant="outline" onClick={onClick}>
      <Monitor />
      界面草图
      {count ? <Badge variant="muted" className="ml-1 text-[10px]">{count}</Badge> : null}
    </Button>
  );
}
