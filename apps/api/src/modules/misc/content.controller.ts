import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, McpScope, platformSchema } from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { Actor, RequireRole } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { QueueService, QUEUE_NAMES } from '../../common/queue.service';
import { AuditService } from '../../common/audit.service';
import { zodBody } from '../../common/zod.pipe';
import { TranslationsService } from '../translations/translations.service';
import { AiService, extractTermCandidates, resolveGlossary } from '@localehub/domain';

/**
 * Glossary, translation memory, AI drafting and the platform-wide overview endpoints used by
 * the Remote MCP and the web dashboard.
 */

const termStatusSchema = z.enum(['DRAFT', 'APPROVED', 'DEPRECATED']);

const glossarySchema = z.object({
  term: z.string().min(1).max(200),
  translations: z.record(z.string()),
  description: z.string().max(2000).optional(),
  caseSensitive: z.boolean().optional(),
  /** A term a machine or an import produced is a draft until somebody decides otherwise. */
  status: termStatusSchema.optional(),
  doNotTranslate: z.boolean().optional(),
  forbiddenTargets: z.record(z.array(z.string().max(200))).optional(),
});

const glossaryUpdateSchema = glossarySchema.partial().extend({
  /** Switch an organisation term off in this project, without defining a replacement for it. */
  disabled: z.boolean().optional(),
});

const glossaryImportSchema = z.object({
  terms: z.array(glossarySchema).min(1).max(2000),
  /** Importing a reviewed termbase should not file all of it as unreviewed candidates. */
  status: termStatusSchema.default('DRAFT'),
});

const tmSearchSchema = z.object({ query: z.string().min(1), locale: z.string().optional(), limit: z.coerce.number().int().positive().max(50).optional() });

const aiTranslateSchema = z.object({
  entryIds: z.array(z.string()).min(1).max(200),
  targetLocales: z.array(z.string()).min(1),
  provider: z.string().optional(),
  writeDrafts: z.boolean().default(true),
});

@Controller()
export class ContentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly translations: TranslationsService,
    /* Named `auditService` because this controller already has an `audit` route of its own. */
    private readonly auditService: AuditService,
    private readonly queue: QueueService,
  ) {}

  /**
   * A term changed, so what this project's translations are supposed to say changed with it.
   *
   * This is the line between a termbase and a document. Approving `课程 → Course` has to turn every
   * existing translation that says otherwise into an issue *without* anybody remembering to run QA,
   * or the "fixed" vocabulary is only fixed for whoever reads it next.
   *
   * Queued rather than run here: it recomputes a whole project, and the API has no business doing
   * that inside somebody's save. One job id per project collapses a burst — an import followed by a
   * correction — into a single run, and `removeOnComplete` frees the id again for the next edit.
   *
   * Failure to queue is reported, never thrown: the term is saved either way, and a Redis hiccup
   * must not make a saved term look unsaved.
   */
  private async recheckAfterGlossaryChange(
    actor: ActorContext,
    projectId: string,
    reason: string,
    terms: string[],
  ): Promise<{ queued: boolean }> {
    if (!terms.length) return { queued: true };
    const result = await this.queue.enqueue(
      QUEUE_NAMES.QA,
      'qa.run',
      { organizationId: actor.organizationId, projectId, requestedBy: actor.userId, reason, terms },
      { jobId: `qa-glossary-${projectId}`, removeOnComplete: true, removeOnFail: true },
    );
    return { queued: result.queued };
  }

  /* --------------------------------------------------------------- glossary */

  /**
   * Every term that applies here, once.
   *
   * Resolved rather than listed: a term that exists both organisation-wide and per project used to come
   * back twice, with nothing to say which reading the translator was being held to. Each row now carries
   * its `scope`, and a project row that replaced an organisation one carries what it replaced.
   */
  @Get('projects/:projectId/glossary')
  async glossary(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const terms = await resolveGlossary(tx, { organizationId: actor.organizationId, projectId });
      // The rows the resolver matched, so the editor can patch a term it is looking at without knowing
      // which scope won — and can tell that a project row is a switch-off rather than a definition.
      const rows = await tx.glossaryTerm.findMany({
        where: { organizationId: actor.organizationId, OR: [{ projectId }, { projectId: null }] },
        select: { id: true, projectId: true, term: true, disabled: true, status: true },
      });
      return {
        terms,
        rows,
        counts: {
          organization: terms.filter((term) => term.scope === 'organization').length,
          project: terms.filter((term) => term.scope === 'project').length,
          draft: terms.filter((term) => term.status === 'DRAFT').length,
        },
      };
    });
  }

  @Post('projects/:projectId/glossary')
  @RequireRole(Role.PROJECT_MANAGER)
  async addTerm(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Body(zodBody(glossarySchema)) body: z.infer<typeof glossarySchema>) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    const created = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.glossaryTerm.create({
        data: {
          organizationId: actor.organizationId,
          projectId,
          term: body.term,
          translations: body.translations as never,
          description: body.description ?? null,
          caseSensitive: body.caseSensitive ?? false,
          status: body.status ?? 'DRAFT',
          doNotTranslate: body.doNotTranslate ?? false,
          forbiddenTargets: (body.forbiddenTargets ?? null) as never,
          createdById: actor.userId,
        },
      }),
    );
    const recheck = await this.recheckAfterGlossaryChange(actor, projectId, 'glossary.term_added', [created.term]);
    return { ...created, recheck };
  }

  /**
   * Change a term.
   *
   * Approving one is the switch that turns a violation into an error the release check refuses on, so it
   * takes the same role a release does. `updatedAt` is the column, but the audit trail is what answers "who
   * decided this" — a termbase nobody can be held to is not a termbase.
   */
  @Patch('projects/:projectId/glossary/:termId')
  @RequireRole(Role.PROJECT_MANAGER)
  async updateTerm(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('termId') termId: string,
    @Body(zodBody(glossaryUpdateSchema)) body: z.infer<typeof glossaryUpdateSchema>,
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    const change = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.glossaryTerm.findFirst({ where: { id: termId, organizationId: actor.organizationId } });
      if (!existing) return null;
      const updated = await tx.glossaryTerm.update({
        where: { id: termId },
        data: {
          ...(body.term !== undefined ? { term: body.term } : {}),
          ...(body.translations !== undefined ? { translations: body.translations as never } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.caseSensitive !== undefined ? { caseSensitive: body.caseSensitive } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.doNotTranslate !== undefined ? { doNotTranslate: body.doNotTranslate } : {}),
          ...(body.forbiddenTargets !== undefined ? { forbiddenTargets: body.forbiddenTargets as never } : {}),
          ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
        },
      });
      // The spelling it had before is part of the change: entries containing the term as it *was*
      // have to be re-read too, or renaming a term quietly leaves its old issues behind.
      return { updated, previousTerm: existing.term };
    });
    if (!change) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No glossary term ${termId} in this organisation`, 404);
    const { updated, previousTerm } = change;
    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'glossary.term_updated',
      resourceType: 'glossary_term',
      resourceId: updated.id,
      projectId,
      metadata: { term: updated.term, status: updated.status, fields: Object.keys(body) },
    });
    const recheck = await this.recheckAfterGlossaryChange(actor, projectId, 'glossary.term_updated', [
      ...new Set([previousTerm, updated.term]),
    ]);
    return { ...updated, recheck };
  }

  @Delete('projects/:projectId/glossary/:termId')
  @RequireRole(Role.PROJECT_MANAGER)
  async deleteTerm(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Param('termId') termId: string) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    const deleted = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.glossaryTerm.findFirst({ where: { id: termId, organizationId: actor.organizationId } });
      if (!existing) return null;
      return tx.glossaryTerm.delete({ where: { id: termId } });
    });
    if (!deleted) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No glossary term ${termId} in this organisation`, 404);
    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'glossary.term_deleted',
      resourceType: 'glossary_term',
      resourceId: termId,
      projectId,
      metadata: { term: deleted.term, scope: deleted.projectId ? 'project' : 'organization' },
    });
    // A deleted term's violations have to stop being reported; the run recomputes the project and
    // therefore clears them, which is the other half of "the termbase is the rule".
    const recheck = await this.recheckAfterGlossaryChange(actor, projectId, 'glossary.term_deleted', [deleted.term]);
    return { deleted: true, termId, recheck };
  }

  /**
   * Bring an existing termbase in.
   *
   * Upsert by term, because the second import of a corrected spreadsheet should not leave two of
   * everything — which is exactly what the unique index now forbids anyway. Organisation rows are only
   * touched when the caller asks for them, so a project import cannot rewrite the company glossary.
   */
  @Post('projects/:projectId/glossary/import')
  @RequireRole(Role.PROJECT_MANAGER)
  async importTerms(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(glossaryImportSchema)) body: z.infer<typeof glossaryImportSchema>,
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    const result = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      let created = 0;
      let updated = 0;
      for (const term of body.terms) {
        const existing = await tx.glossaryTerm.findFirst({
          where: { organizationId: actor.organizationId, projectId, term: { equals: term.term, mode: 'insensitive' } },
        });
        const data = {
          translations: term.translations as never,
          description: term.description ?? null,
          caseSensitive: term.caseSensitive ?? false,
          status: term.status ?? body.status,
          doNotTranslate: term.doNotTranslate ?? false,
          forbiddenTargets: (term.forbiddenTargets ?? null) as never,
        };
        if (existing) {
          await tx.glossaryTerm.update({ where: { id: existing.id }, data });
          updated += 1;
        } else {
          await tx.glossaryTerm.create({
            data: { organizationId: actor.organizationId, projectId, term: term.term, createdById: actor.userId, ...data },
          });
          created += 1;
        }
      }
      return { created, updated, total: body.terms.length };
    });
    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'glossary.imported',
      resourceType: 'glossary_term',
      projectId,
      metadata: result,
    });
    const recheck = await this.recheckAfterGlossaryChange(
      actor,
      projectId,
      'glossary.imported',
      body.terms.map((term) => term.term),
    );
    return { ...result, recheck };
  }

  /**
   * The words this project keeps using, with what the project already calls them.
   *
   * A project that has already been translated has a vocabulary — and it has already answered most of
   * the termbase: 2,795 translated keys have said what `学习` is in Traditional Chinese 152 times.
   * Reading that back is counting, not guessing, and the count travels with every suggestion so the
   * person deciding can see exactly how much of the project agrees.
   *
   * It is still an *extraction*, not an alignment: a sentence pair cannot say which part of the
   * translation a word inside the source became, so every suggestion lands as a DRAFT term that
   * somebody approves — and a term with no clear answer comes back with no suggestion rather than a
   * plausible one. See `packages/domain/src/term-mining.ts` for the two counting mistakes this
   * refuses to make (a source boundary that is wrong, and machinery counted as vocabulary).
   */
  @Post('projects/:projectId/glossary/extract')
  @RequireRole(Role.PROJECT_MANAGER)
  async extractTerms(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(z.object({ minKeys: z.number().int().min(2).max(50).default(3), limit: z.number().int().min(1).max(200).default(60) }))) body: { minKeys: number; limit: number },
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    // One implementation, two callers: this route and the `extract_glossary_candidates` MCP tool. See
    // `packages/domain/src/term-extraction.ts`.
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      extractTermCandidates(tx, { organizationId: actor.organizationId, projectId, minKeys: body.minKeys, limit: body.limit }),
    );
  }

  /* ------------------------------------------------------ translation memory */

  @Get('projects/:projectId/translation-memory')
  async searchTm(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(tmSearchSchema)) query: z.infer<typeof tmSearchSchema>,
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationMemoryEntry.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(query.locale ? { targetLocale: query.locale } : {}),
          sourceText: { contains: query.query, mode: 'insensitive' },
        },
        orderBy: [{ usageCount: 'desc' }, { updatedAt: 'desc' }],
        take: query.limit ?? 10,
      }),
    );
  }

  /* ------------------------------------------------------------------- AI */

  /**
   * AI drafting. The provider is a pluggable adapter; the default "heuristic" provider needs
   * no network and is what the demo uses. AI output is *always* written as DRAFT and can never
   * approve itself (spec §0.1 "AI 审核结果不能绕过人工审核").
   */
  @Post('projects/:projectId/ai/translate')
  @RequireRole(Role.PRODUCT_MANAGER)
  async aiTranslate(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(aiTranslateSchema)) body: z.infer<typeof aiTranslateSchema>,
  ) {
    assertRole(actor, projectId, Role.PRODUCT_MANAGER);
    const service = new AiService(this.prisma);
    return service.draftTranslations(actor, projectId, body);
  }

  @Post('projects/:projectId/ai/review')
  @RequireRole(Role.REVIEWER)
  async aiReview(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Body(zodBody(z.object({ entryIds: z.array(z.string()).min(1).max(200) }))) body: { entryIds: string[] }) {
    assertRole(actor, projectId, Role.REVIEWER);
    const service = new AiService(this.prisma);
    return service.reviewSuggestions(actor, projectId, body.entryIds);
  }

  /* --------------------------------------------------------- organization */

  @Get('organization/overview')
  async overview(@Actor() actor: ActorContext) {
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const [projects, keys, entries, pendingReview, conflicts, members] = await Promise.all([
        tx.project.count(),
        tx.translationKey.count({ where: { archivedAt: null } }),
        tx.translationEntry.count(),
        tx.translationEntry.count({ where: { status: 'PENDING_REVIEW' } }),
        tx.syncConflict.count({ where: { status: 'OPEN' } }),
        tx.membership.count(),
      ]);
      return { projects, keys, entries, pendingReview, conflicts, members };
    });
  }

  @Get('projects/:projectId/keys')
  async keys(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(z.object({ search: z.string().optional(), platform: platformSchema.optional(), limit: z.coerce.number().int().positive().max(200).optional() })))
    query: { search?: string; platform?: string; limit?: number },
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationKey.findMany({
        where: {
          projectId,
          archivedAt: null,
          ...(query.platform ? { platform: query.platform as never } : {}),
          ...(query.search ? { key: { contains: query.search, mode: 'insensitive' } } : {}),
        },
        include: {
          namespace: true,
          sourceVersions: { orderBy: { version: 'desc' }, take: 1 },
          entries: { select: { localeCode: true, status: true, value: true } },
        },
        orderBy: { key: 'asc' },
        take: query.limit ?? 100,
      }),
    );
  }

  @Get('projects/:projectId/entry-by-key')
  async entryByKey(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(z.object({ key: z.string().min(1), locale: z.string().min(1) }))) query: { key: string; locale: string },
  ) {
    return this.translations.byKey(actor, projectId, query.key, query.locale);
  }

  @Get('projects/:projectId/audit')
  async audit(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.auditLog.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  }

  @Get('projects/:projectId/ai/providers')
  async aiProviders(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    void McpScope;
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const providers = await tx.aiProviderConfig.findMany({
        where: { organizationId: actor.organizationId },
        select: { id: true, name: true, kind: true, model: true, enabled: true, isDefault: true, baseUrl: true },
      });
      return providers;
    });
  }
}

/** Punctuation and symbols that never belong at the edge of a term. */
