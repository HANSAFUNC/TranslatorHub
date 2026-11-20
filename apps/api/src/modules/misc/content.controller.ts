import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role, McpScope, platformSchema } from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { Actor, RequireRole } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { zodBody } from '../../common/zod.pipe';
import { TranslationsService } from '../translations/translations.service';
import { AiService, resolveGlossary } from '@localehub/domain';

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
  ) {}

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
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
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
  }

  /**
   * Change a term.
   *
   * Approving one is the switch that turns a violation into an error that blocks a release, so it takes
   * the same role a release does. `updatedAt` is the column, but the audit trail is what answers "who
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
    const updated = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.glossaryTerm.findFirst({ where: { id: termId, organizationId: actor.organizationId } });
      if (!existing) return null;
      return tx.glossaryTerm.update({
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
    });
    if (!updated) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No glossary term ${termId} in this organisation`, 404);
    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'glossary.term_updated',
      resourceType: 'glossary_term',
      resourceId: updated.id,
      projectId,
      metadata: { term: updated.term, status: updated.status, fields: Object.keys(body) },
    });
    return updated;
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
    return { deleted: true, termId };
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
    return result;
  }

  /**
   * The words this project keeps using, proposed as terms.
   *
   * A project that has already been translated has a vocabulary — it is just scattered across the
   * sentences. Nothing here guesses a translation: an alignment between a sentence and its translation
   * cannot say what one word inside it became, and inventing one would put a wrong answer in the
   * termbase with the platform's authority behind it. What comes out is the shape of the vocabulary —
   * which phrases recur, in how many keys — for somebody who does know the answer to fill in.
   */
  @Post('projects/:projectId/glossary/extract')
  @RequireRole(Role.PROJECT_MANAGER)
  async extractTerms(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(z.object({ minKeys: z.number().int().min(2).max(50).default(3), limit: z.number().int().min(1).max(200).default(60) }))) body: { minKeys: number; limit: number },
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const keys = await tx.translationKey.findMany({
        where: { projectId, archivedAt: null },
        select: { id: true, key: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1, select: { value: true } } },
        take: 5000,
      });
      const known = new Set((await resolveGlossary(tx, { organizationId: actor.organizationId, projectId })).map((term) => term.term.toLowerCase()));

      const seen = new Map<string, { term: string; keys: Set<string>; example: string }>();
      for (const row of keys) {
        const source = row.sourceVersions[0]?.value ?? '';
        if (!source) continue;
        for (const candidate of candidatePhrases(source)) {
          const identity = candidate.toLowerCase();
          if (known.has(identity)) continue;
          const entry = seen.get(identity) ?? { term: candidate, keys: new Set<string>(), example: row.key };
          entry.keys.add(row.key);
          seen.set(identity, entry);
        }
      }
      const candidates = maximalPhrases([...seen.values()].filter((entry) => entry.keys.size >= body.minKeys))
        // Longest first at equal frequency: `课程学习` says more than `课程`, and the shorter one is
        // almost always its substring showing up in the same sentences.
        .sort((a, b) => b.keys.size - a.keys.size || b.term.length - a.term.length || a.term.localeCompare(b.term))
        .slice(0, body.limit)
        .map((entry) => ({ term: entry.term, keyCount: entry.keys.size, exampleKey: entry.example }));
      return { candidates, scannedKeys: keys.length, minKeys: body.minKeys };
    });
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
const PHRASE_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

/**
 * The phrases a source string is made of, as candidates for a term.
 *
 * Deliberately over-generating — every 2–5 character run for CJK and every 1–3 word run otherwise —
 * because the frequency filter is what decides, and an extractor that tries to be clever about word
 * boundaries in a language it does not know just loses real terms. `maximalPhrases` then removes the
 * fragments.
 */
function candidatePhrases(source: string): string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu)) {
    const run = match[0];
    for (let size = 2; size <= Math.min(5, run.length); size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) out.add(run.slice(start, start + size));
    }
  }
  // Every window, not every third one. Scanning with `(?:\s+word){0,2}` steps three words at a time, so
  // the two windows that straddle a boundary are never tried — which is why an English project came back
  // with no candidates at all while a Chinese one came back with twenty.
  const words = (source.match(/[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [])
    .map((word) => word.replace(PHRASE_EDGE, ''))
    .filter((word) => /^[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(word));
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= words.length; size += 1) {
      const phrase = words.slice(start, start + size).join(' ');
      if (phrase.length >= 4) out.add(phrase);
    }
  }
  return [...out].filter((phrase) => phrase.replace(PHRASE_EDGE, '').length >= 2);
}

/**
 * Drop the fragments.
 *
 * `课程` and `课程学习` come out of the same sentence, and listing both asks somebody to answer the same
 * question twice. A candidate that is contained in a longer one and is no more frequent is the longer
 * one's substring, not a term of its own.
 */
function maximalPhrases<T extends { term: string; keys: Set<string> }>(candidates: T[]): T[] {
  const bounded = candidates.slice(0, 2000);
  return bounded.filter(
    (entry) =>
      !bounded.some(
        (other) =>
          other !== entry &&
          other.term.length > entry.term.length &&
          other.keys.size >= entry.keys.size &&
          other.term.includes(entry.term),
      ),
  );
}
