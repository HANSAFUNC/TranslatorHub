import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, type PlatformName, defaultViewport } from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { analyzeDocument, analyzeSketch, type MockupDocument, type MockupReport } from '@localehub/contracts';
import { listScreenMockups, resolveMockupInput, resolveScreenMarkers, upsertScreenMockup } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { MockupUploadBody } from './mockups.controller';

/**
 * Screen mockups, as the editor reads them.
 *
 * Uploads arrive here from two directions — this REST route and the Remote MCP tool
 * `upload_screen_mockup` — and both go through the same `@localehub/domain` functions, so a sketch
 * uploaded by an agent and one uploaded through the API cannot differ in validation, geometry or the
 * way unmatched markers are reported.
 */
@Injectable()
export class MockupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Screens of a project, without their bytes.
   *
   * `key` answers the question the editor actually asks — "does a screen show the entry I have
   * selected?" — by adding `containsKey` to every row rather than by filtering. The caller types a
   * key and wants the screens it can open; filtering would hide the screen list entirely when the
   * key appears nowhere, which reads as "no sketches were uploaded" instead of "this key is not
   * marked on any of them".
   */
  async list(
    actor: ActorContext,
    projectId: string,
    filters: { platform?: PlatformName; key?: string; namespace?: string; include?: 'unmatched' },
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockups = await listScreenMockups(tx, projectId, {
        platform: filters.platform,
        includeUnmatched: filters.include === 'unmatched',
      });
      let containing = new Set<string>();
      if (filters.key) {
        // Matched on (namespace, key), which is what a marker actually points at. Matching the key
        // name alone answered "yes" for a screen whose only `title` marker is in another namespace,
        // and the dialog then opened that screen and highlighted a marker for a different entry.
        const rows = await tx.screenMockupMarker.findMany({
          where: {
            mockupId: { in: mockups.map((mockup) => mockup.id) },
            key: filters.key,
            namespace: filters.namespace ?? '',
          },
          select: { mockupId: true },
        });
        containing = new Set(rows.map((row) => row.mockupId));
      }
      return mockups.map((mockup) => ({
        ...mockup,
        // Relative to the API base. The MCP server and the API are addressed differently by different
        // clients, so an absolute path would be right for exactly one of them.
        //
        // The path follows the kind: a drawn sketch is fetched as an image, a replica as a page. One
        // field rather than a kind check in every client.
        imagePath: `/projects/${projectId}/mockups/${mockup.id}/${mockup.kind === 'document' ? 'document' : 'image'}`,
        ...(filters.key ? { containsKey: containing.has(mockup.id) } : {}),
      }));
    });
  }

  /**
   * One screen: its metadata and every marker, joined with the source text and the translation in
   * `locale`. This is the whole payload the 90% detail view needs, in one request.
   */
  async get(actor: ActorContext, projectId: string, mockupId: string, locale: string | null) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockup = await tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        // `image` is absent on purpose: the bytes travel on their own endpoint, so a JSON response
        // never carries a megabyte of base64 the client has to throw away.
        select: {
          id: true,
          name: true,
          platform: true,
          locale: true,
          width: true,
          height: true,
          mimeType: true,
          byteSize: true,
          contentHash: true,
          // The component numbering the picture carries, so the editor lists the same numbers.
          legend: true,
          // What is missing from the sketch, written when it was uploaded.
          report: true,
          // What the caller asserted about it, so re-reading the page re-reads it under the same claim.
          expectations: true,
          // Present only for a replica, and only to say how many states it holds: the markup itself
          // travels on its own endpoint, one frame at a time.
          document: true,
          createdAt: true,
          updatedAt: true,
          markers: {
            select: {
              id: true,
              key: true,
              namespace: true,
              x: true,
              y: true,
              width: true,
              height: true,
              text: true,
              frame: true,
              component: true,
              note: true,
            },
          },
        },
      });
      if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);

      const markers = await resolveScreenMarkers(tx, {
        projectId,
        platform: mockup.platform as string,
        markers: mockup.markers,
        // Omitted means "source text only": the caller may be showing the sketch against the original.
        locale,
      });

      const document = mockup.document as unknown as MockupDocument | null;
      const kind = document ? 'document' : 'image';

      // A page is re-read on every read; a drawn sketch keeps the verdict stored beside it (that one
      // means decoding the image, and its picture cannot change under it). The reason a page is not
      // cached is that a stored report is a cached *judgement*, and a judgement that outlives the rules
      // is worse than no judgement at all: a screen that arrived as grey bars with hand-drawn shapes in
      // place of its pictures was served as `clean: true` for as long as nothing disagreed with it —
      // which is exactly what a caller reads as "the platform says this one is fine". Re-reading costs a
      // parse of markup the row already holds, and it means fixing a rule reaches everything already
      // uploaded instead of only the next upload.
      const stored = mockup.report as unknown as MockupReport | null;
      const report =
        kind === 'document' || !stored?.findings
          ? await this.analyzeStored(
              actor,
              projectId,
              mockupId,
              markers,
              mockup.legend as unknown as { name: string }[],
              kind,
            )
          : stored;

      return {
        mockup: {
          id: mockup.id,
          name: mockup.name,
          platform: mockup.platform as string,
          locale: mockup.locale,
          width: mockup.width,
          height: mockup.height,
          mimeType: mockup.mimeType,
          byteSize: mockup.byteSize,
          contentHash: mockup.contentHash,
          createdAt: mockup.createdAt,
          updatedAt: mockup.updatedAt,
          markerCount: markers.length,
          // Which artefact this screen is, so the editor renders a page as a page.
          kind,
          // A replica's states, in the order the caller sent them: the editor switches between them.
          frames: document ? document.frames.map((frame) => frame.title) : [],
          // The component numbering, exactly as the picture's badges show it (for a replica: read from
          // the markup's own class and data-component names).
          components: mockup.legend,
          report,
          imagePath: `/projects/${projectId}/mockups/${mockup.id}/${kind === 'document' ? 'document' : 'image'}`,
        },
        locale,
        markers,
      };
    });
  }

  /**
   * The report for a sketch that was uploaded before there was one.
   *
   * Reads the stored bytes, which is exactly why new uploads compute it once and keep it.
   */
  private async analyzeStored(
    actor: ActorContext,
    projectId: string,
    mockupId: string,
    markers: readonly { key: string; namespace: string; frame: string | null; component: string | null; text: string | null; platform: string | null }[],
    legend: { name: string }[],
    kind: 'image' | 'document',
  ): Promise<MockupReport> {
    const row = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { image: true, document: true, expectations: true, width: true, height: true, platform: true },
      }),
    );
    if (!row) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    const reportMarkers = markers.map((marker) => ({
      key: marker.key,
      namespace: marker.namespace,
      frame: marker.frame,
      component: marker.component,
      text: marker.text,
      missing: marker.platform === null,
    }));
    // The declaration travels with the row, so a page re-read months later is still read under the claim
    // its caller made — otherwise the finding it suppressed would come back on the next look.
    const expectations = (row.expectations ?? undefined) as { noImages?: boolean } | undefined;
    if (kind === 'document') {
      return analyzeDocument({
        document: row.document as unknown as MockupDocument,
        markers: reportMarkers,
        legend,
        // The frame this page is rendered into. It is read from the row rather than assumed, so a page
        // stored when the platform's viewport was a different size is judged against the frame it is
        // actually shown in.
        frame:
          row.width && row.height
            ? { width: row.width, height: row.height }
            : defaultViewport(row.platform ?? undefined),
        ...(expectations ? { expectations } : {}),
      });
    }
    return analyzeSketch({
      svg: Buffer.from(row.image ?? new Uint8Array()).toString('utf8'),
      markers: reportMarkers,
      legend,
      ...(expectations ? { expectations } : {}),
    });
  }

  /**
   * The page of one frame, for the editor's sandboxed frame.
   *
   * The markup is served as-is, under a CSP that makes it a picture: `sandbox` without `allow-scripts`
   * means nothing in it can run, `default-src 'none'` with an `img-src`/`style-src` allowlist means it
   * can paint itself (locally inlined assets, or ones the *viewer's* browser fetches from the internet
   * — the platform never does) and do nothing else. `allow-same-origin` is what lets the editor, which
   * is the frame's parent, measure the elements to place its markers; scripts stay off, so the page
   * cannot reach back into the app even though the origin matches.
   */
  async documentFrame(actor: ActorContext, projectId: string, mockupId: string, frame: string | null) {
    assertRole(actor, projectId, Role.READONLY);
    const row = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({ where: { id: mockupId, projectId }, select: { document: true, contentHash: true } }),
    );
    if (!row) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    const document = row.document as unknown as MockupDocument | null;
    if (!document?.frames?.length) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `Mockup ${mockupId} is a drawn sketch, not a page: fetch its image instead`,
        409,
      );
    }
    const index = frame ? document.frames.findIndex((candidate) => candidate.title === frame) : 0;
    if (index < 0) {
      throw new LocaleHubError(
        ErrorCode.NOT_FOUND,
        `Mockup ${mockupId} has no frame named ${frame}. It has: ${document.frames.map((f) => f.title).join(', ')}`,
        404,
      );
    }
    return { html: document.frames[index]!.html, title: document.frames[index]!.title, contentHash: row.contentHash, index };
  }

  /** What the document route needs to answer `If-None-Match`, without pulling the markup back out. */
  async documentMeta(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.READONLY);
    const mockup = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({ where: { id: mockupId, projectId }, select: { contentHash: true, document: true } }),
    );
    if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    return { contentHash: mockup.contentHash, isDocument: Boolean(mockup.document) };
  }

  /**
   * What the image route needs to answer `If-None-Match` — and nothing more.
   *
   * The response is `no-cache` with an ETag, so a browser revalidates on every open. Selecting only
   * the hash means a 304 costs a few bytes instead of pulling up to `MAX_MOCKUP_BYTES` out of the
   * BYTEA column and allocating it in this process just to throw it away.
   */
  async imageMeta(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.READONLY);
    const mockup = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { mimeType: true, contentHash: true },
      }),
    );
    if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    return mockup;
  }

  /** The bytes, for the `<img>` the dialog draws. Ownership is checked against the row, not the path. */
  async image(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.READONLY);
    const mockup = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { image: true },
      }),
    );
    if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    if (!mockup.image) {
      // A replica has no picture of ours: it is the page, and rendering it is the browser's job.
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `Mockup ${mockupId} is a page, not a picture: fetch /document instead`,
        409,
      );
    }
    return { ...mockup, image: mockup.image };
  }

  /**
   * Store a sketch. Same validation and same rows as the MCP tool, because it is the same function.
   *
   * The image decoder throws `LocaleHubError`s that already say which construct to remove or which
   * limit was passed; nothing here rewrites them, so a caller over either surface reads the same
   * sentence.
   */
  async upload(actor: ActorContext, projectId: string, body: MockupUploadBody) {
    assertRole(actor, projectId, Role.DEVELOPER);
    // Either a picture the caller drew, or a description the platform draws. Same resolver as the MCP
    // tool, so "you sent neither / both" reads identically on both surfaces.
    const { image, document, markers, legend, width, height } = resolveMockupInput({
      imageBase64: body.imageBase64 ?? null,
      mimeType: body.mimeType ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      markers: body.markers,
      ui: body.ui ?? null,
      html: body.html ?? null,
      // A whole page (or an explicit `document`) is kept as it was sent rather than redrawn.
      document: body.document ?? null,
      frames: body.frames ?? null,
      namespace: body.namespace ?? null,
      css: body.css ?? null,
      theme: body.theme ?? null,
      // Same as the MCP tool: the canvas size follows the screen's platform when `ui` omits one.
      platform: body.platform ?? 'web',
    });

    const result = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      upsertScreenMockup(tx, {
        organizationId: actor.organizationId,
        projectId,
        userId: actor.userId,
        name: body.name,
        platform: body.platform ?? 'web',
        locale: body.locale,
        image,
        document,
        width,
        height,
        markers,
        legend,
        ...(body.expect_no_images ? { expectations: { noImages: true } } : {}),
        replace: body.replace ?? true,
      }),
    );

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'user',
      action: 'mockup.upload',
      resourceType: 'screen_mockup',
      resourceId: result.mockupId,
      projectId,
      metadata: {
        name: result.name,
        platform: result.platform,
        locale: result.locale,
        markers: result.markers.total,
        unmatched: result.markers.unmatched.length,
        bytes: result.image.byteSize,
        via: 'api',
        // Which artefact this was, so the audit log can tell a page from a picture.
        kind: result.kind,
        // The same two fields the MCP tool records, so "which callers keep declaring the wrong type"
        // has one answer across both surfaces rather than only the agent-written half.
        detectedMimeType: result.image.mimeType,
        declaredMimeType: image?.declaredMimeType ?? null,
      },
    });

    return result;
  }

  async remove(actor: ActorContext, projectId: string, mockupId: string) {
    assertRole(actor, projectId, Role.DEVELOPER);
    const removed = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockup = await tx.screenMockup.findFirst({
        where: { id: mockupId, projectId },
        select: { id: true, name: true, platform: true },
      });
      if (!mockup) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
      // Markers cascade from the mockup row by foreign key, so one delete is the whole screen.
      await tx.screenMockup.delete({ where: { id: mockup.id } });
      return mockup;
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'user',
      action: 'mockup.delete',
      resourceType: 'screen_mockup',
      resourceId: removed.id,
      projectId,
      metadata: { name: removed.name, platform: removed.platform as string, via: 'api' },
    });

    return { deleted: true, mockupId: removed.id };
  }
}
