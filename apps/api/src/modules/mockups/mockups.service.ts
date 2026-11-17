import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, type PlatformName } from '@localehub/contracts';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { analyzeSketch, type MockupReport } from '@localehub/contracts';
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
    filters: { platform?: PlatformName; key?: string; namespace?: string },
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const mockups = await listScreenMockups(tx, projectId, { platform: filters.platform });
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
        imagePath: `/projects/${projectId}/mockups/${mockup.id}/image`,
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

      // A sketch uploaded before the report existed carries an empty one: analyse it now, from the
      // bytes, and leave the row alone — a read stays a read. The next upload of the same screen
      // stores it.
      const stored = mockup.report as unknown as MockupReport | null;
      const report = stored?.findings
        ? stored
        : await this.analyzeStored(actor, projectId, mockupId, markers, mockup.legend as unknown as { name: string }[]);

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
          // The component numbering, exactly as the picture's badges show it.
          components: mockup.legend,
          report,
          imagePath: `/projects/${projectId}/mockups/${mockup.id}/image`,
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
  ): Promise<MockupReport> {
    const row = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.screenMockup.findFirst({ where: { id: mockupId, projectId }, select: { image: true } }),
    );
    if (!row) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Mockup ${mockupId} not found`, 404);
    return analyzeSketch({
      svg: Buffer.from(row.image).toString('utf8'),
      markers: markers.map((marker) => ({
        key: marker.key,
        namespace: marker.namespace,
        frame: marker.frame,
        component: marker.component,
        text: marker.text,
        missing: marker.platform === null,
      })),
      legend,
    });
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
    return mockup;
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
    const { image, markers, legend } = resolveMockupInput({
      imageBase64: body.imageBase64 ?? null,
      mimeType: body.mimeType ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      markers: body.markers,
      ui: body.ui ?? null,
      html: body.html ?? null,
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
        markers,
        legend,
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
        // The same two fields the MCP tool records, so "which callers keep declaring the wrong type"
        // has one answer across both surfaces rather than only the agent-written half.
        detectedMimeType: result.image.mimeType,
        declaredMimeType: image.declaredMimeType,
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
