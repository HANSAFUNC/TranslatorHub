import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PrismaClient } from '@localehub/database';
import {
  AiService,
  SyncService,
  assertPlaceholdersPreserved,
  createProject,
  extractTermCandidates,
  recordAudit,
  resolveMockupInput,
  resolveGlossary,
  termTarget,
  emitProjectEvent,
  upsertScreenMockup,
  upsertTranslation,
} from '@localehub/domain';
import type { UiSpec } from '@localehub/contracts';
import { renderLocalConfig } from '@localehub/workspace';
import {
  ErrorCode,
  LocaleHubError,
  Role,
  contentHash,
  SKILLS_INDEX_URI,
  SKILL_RESOURCE_TEMPLATE,
  renderSkillIndex,
  remoteToolSchemas,
  selectDeliverableSkills,
  skillBody,
  REMOTE_MCP_PROMPTS,
  skillPromptArgs,
  type DeliveredSkill,
  REMOTE_MCP_INSTRUCTIONS,
  REMOTE_MCP_IMPORT_GUIDE,
  REMOTE_MCP_SKETCH_GUIDE,
  REMOTE_MCP_TOOL_SCOPES,
  remoteImportPrompt,
  remoteScreenMapPrompt,
  remoteSketchPrompt,
  resolveLocaleTag,
  type RemoteMcpTool,
} from '@localehub/contracts';
import { assertProjectBound, assertRole, assertScope, type ActorContext } from '@localehub/permissions';
import { TenantPrisma } from '@localehub/database';
import { enqueueQaRecheck } from './qa-queue';

/**
 * Remote MCP server (Streamable HTTP).
 *
 * It exposes *platform* capabilities only. There is deliberately no local file tool here: the
 * platform can never read or write a developer machine (spec §6.1, §0.3). Authorization reuses
 * the exact same role/scope logic as the REST API.
 */
/**
 * MCP requires `structuredContent` to be a JSON object, so arrays are wrapped and any Date /
 * undefined values are normalised through a JSON round-trip before being returned.
 */
function toStructuredContent(result: unknown): Record<string, unknown> {
  const normalised = JSON.parse(JSON.stringify(result ?? null)) as unknown;
  if (normalised && typeof normalised === 'object' && !Array.isArray(normalised)) {
    return normalised as Record<string, unknown>;
  }
  return { items: normalised };
}

/**
 * Published skills the actor may read: the organization's own plus the platform-wide ones.
 *
 * Same visibility rule as `GET /skills`, and the same RLS scoping — the query runs inside
 * `withOrganization`, so a bug here cannot reach another tenant's skills.
 *
 * Best effort on purpose. Skill delivery is an add-on to a server whose real job is the tools; if
 * this query throws, failing the whole request would take every tool down with it.
 */
async function loadSkills(actor: ActorContext, tenant: TenantPrisma): Promise<DeliveredSkill[]> {
  try {
    const rows = await tenant.withOrganization(actor.organizationId, (tx) =>
      tx.skill.findMany({
        where: { OR: [{ organizationId: actor.organizationId }, { organizationId: null }] },
        orderBy: [{ slug: 'asc' }, { version: 'desc' }],
      }),
    );
    return selectDeliverableSkills(rows, { reservedPromptNames: REMOTE_MCP_PROMPTS });
  } catch (error) {
    console.error('[mcp-remote] skill delivery unavailable:', error instanceof Error ? error.message : error);
    return [];
  }
}

export async function buildRemoteMcpServer(actor: ActorContext, prisma: PrismaClient, tenant: TenantPrisma): Promise<McpServer> {
  const server = new McpServer(
    { name: 'localehub-remote', version: '0.1.0' },
    {
      // The one place a client is expected to put text in front of the model before any tool call,
      // so it is where "how do I use this" has to be answered. See `mcp-guide.ts` for why it says
      // what it says.
      instructions: REMOTE_MCP_INSTRUCTIONS,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );

  const sync = new SyncService(prisma, tenant);
  const ai = new AiService(prisma, tenant);

  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> },
    handler: (input: unknown) => Promise<unknown>,
  ) => void;

  /**
   * Same erasure as `registerTool` above: the per-skill prompts add to a union that already
   * exceeds TypeScript's instantiation depth.
   */
  const registerPrompt = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: { title?: string; description?: string; argsSchema?: Record<string, unknown> },
    // `never` rather than a concrete arg shape: the prompts here take different arguments, and the
    // SDK's own generic is what pushes TypeScript past its instantiation depth.
    handler: (args: never) => { messages: unknown[] },
  ) => void;

  /**
   * Tools that change platform state. Declaring these as read-only would tell an MCP client the
   * call cannot modify anything — some clients use that to skip asking the user — so the four
   * that write drafts, review decisions and submission status must say so.
   */
  const WRITE_TOOLS = new Set<string>([
    'create_project',
    'import_translations',
    'translate_entries',
    'review_translation_entries',
    'update_translation_draft',
    'submit_review',
    'mark_applied',
    'upload_screen_mockup',
    'upsert_glossary_terms',
    'import_glossary_terms',
  ]);

  /**
   * Tools whose call can destroy what is already on the platform.
   *
   * `upload_screen_mockup` replaces a same-named screen wholesale — image and every marker — and keeps
   * no history, so it is the one write whose `destructiveHint` is true. It is not a dry-run tool
   * either, which the server instructions say explicitly rather than leaving the general "all writes
   * default to dry run" sentence to mislead a caller into previewing a regenerated screen onto the
   * live one.
   */
  const DESTRUCTIVE_TOOLS = new Set<RemoteMcpTool>(['upload_screen_mockup']);

  /**
   * Record one audit row for a write.
   *
   * The actor always comes from the token, never from the tool's arguments — the point of the
   * trail is that it says who really did it. `mcpClientId` is included so an operator can tell
   * which token was used, and therefore revoke it.
   */
  const audit = (input: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    projectId?: string | null;
    syncSessionId?: string | null;
    metadata?: Record<string, unknown>;
  }) =>
    recordAudit(prisma, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: 'mcp',
      mcpClientId: actor.mcpClientId ?? null,
      ...input,
    });

  const define = <K extends RemoteMcpTool>(name: K, description: string, handler: (input: never) => Promise<unknown>) => {
    const schema = remoteToolSchemas[name] as unknown as {
      shape?: Record<string, unknown>;
      _def?: { schema?: { shape?: Record<string, unknown> } };
    };
    // Most of these destroy nothing (versions are immutable, review decisions are reversible), so
    // `destructiveHint` stays false; they are simply not read-only. `upload_screen_mockup` is the
    // exception: it replaces a same-named screen's image *and* markers with no version history, so a
    // client is told the truth about it rather than being left to infer it from the description.
    const destructive = DESTRUCTIVE_TOOLS.has(name);
    const annotations = WRITE_TOOLS.has(name)
      ? { readOnlyHint: false, destructiveHint: destructive }
      : { readOnlyHint: true };
    registerTool(
      name,
      { description, inputSchema: schema.shape ?? schema._def?.schema?.shape ?? {}, annotations },
      async (input: unknown) => {
        try {
          // Before the handler, not inside it: a tool that forgets the check is a tool that has no
          // check, and this is the one place every tool goes through.
          for (const scope of REMOTE_MCP_TOOL_SCOPES[name] ?? []) assertScope(actor, scope);
          const result = await handler(input as never);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: toStructuredContent(result),
          };
        } catch (error) {
          const err = error instanceof LocaleHubError ? error : LocaleHubError.from(error);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: err.code, message: err.message } }) }],
          };
        }
      },
    );
  };

  /* ------------------------------------------------------------------- projects */

  define(
    'create_project',
    '创建一个项目，并返回可直接写入 .localehub/config.yaml 的配置。用于把本地仓库初始化到平台：' +
      '先用你自己的文件工具读语言文件，再用 import_translations 上传内容。',
    async (input: { name: string; source_locale: string; locales?: string[]; platforms?: string[]; description?: string; locales_dir?: string }) => {
      // Same rule as the REST route: creating a project is a manager act. `assertRole` with an
      // empty project id checks the organization role, which is what `POST /projects` does too.
      assertRole(actor, '', Role.PROJECT_MANAGER);

      const created = await tenant.withOrganization(actor.organizationId, (tx) =>
        createProject(tx, {
          organizationId: actor.organizationId,
          userId: actor.userId,
          name: input.name,
          description: input.description,
          sourceLocale: input.source_locale,
          locales: input.locales,
          platforms: input.platforms,
        }),
      );

      const template = renderLocalConfig({
        projectId: created.id,
        projectName: created.name,
        sourceLocale: created.sourceLocale,
        locales: created.locales,
        platforms: created.platforms as never,
        apiUrl: process.env.API_PUBLIC_URL || 'http://localhost:3001/api/v1',
        ...(input.locales_dir ? { localesDir: input.locales_dir } : {}),
      });

      await audit({
        action: 'project.create',
        resourceType: 'project',
        resourceId: created.id,
        projectId: created.id,
        metadata: { name: created.name, sourceLocale: created.sourceLocale, locales: created.locales, via: 'create_project' },
      });

      return {
        project: { id: created.id, name: created.name, slug: created.slug, sourceLocale: created.sourceLocale },
        // The exact file to write. Returning the text rather than writing it keeps the platform
        // out of the repository: the agent writes it, with the same tools it reads with.
        configPath: '.localehub/config.yaml',
        config: template.yaml,
        nextSteps: [
          `把 config 的内容写入 ${'.localehub/config.yaml'} 并提交进仓库（它是这个仓库与项目的对应关系，别人接手要靠它）`,
          'export LOCALEHUB_TOKEN=<你签发的 token>',
          `用 import_translations 上传内容，project_id=${created.id}`,
          '然后 localehub scan && localehub sync preview 检查平台与仓库是否一致',
        ],
      };
    },
  );

  define(
    'import_translations',
    '把本地语言文件的内容导入项目（建立 Key、源文版本与译文）。是你读文件、平台收内容：平台看不到你的磁盘。' +
      '入参：{project_id, confirm, files:[{path, locale, platform, namespace?, entries:[{key,value}]}]}。' +
      'locale 按仓库实际目录填（zh-Hans.lproj 就传 zh-Hans）：等价标签归入已有语言、项目没有的自动新增，' +
      '两者都在返回值的 expansion 里报告。platform 默认 web，iOS 要传 ios；多张字符串表用 namespace 区分。' +
      '批量写入有 60 秒预算（不是普通接口的 5 秒）：真正的上限是请求体，几千条一批没问题，超时整批回滚。' +
      '默认 confirm=false 只报告不写入。细节见资源 localehub://import-guide。',
    async (input: {
      project_id: string;
      files: { path: string; locale: string; platform: string; namespace?: string; entries: { key: string; value: string }[] }[];
      confirm: boolean;
    }) => {
      assertRole(actor, input.project_id, Role.DEVELOPER);
      assertProjectBound(actor, input.project_id);

      const project = await tenant.withOrganization(actor.organizationId, (tx) =>
        tx.project.findUnique({ where: { id: input.project_id }, select: { id: true, name: true, sourceLocale: true } }),
      );
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${input.project_id} not found`, 404);

      const entryCount = input.files.reduce((total, file) => total + file.entries.length, 0);
      // Both the report and the write work in project terms, so `planned` resolves the caller's
      // tags the same way `recordScan` will: a `zh-Hans.lproj` directory in a project whose source
      // locale is `zh-CN` is shown as `zh-CN` and as source, because that is what it is.
      const existingCodes = await tenant.withOrganization(actor.organizationId, (tx) =>
        tx.locale.findMany({ where: { projectId: project.id }, select: { code: true } }),
      );
      const resolvePlanned = (raw: string) => resolveLocaleTag(raw, existingCodes.map((row) => row.code)).code;
      const planned = input.files.map((file) => ({
        path: file.path,
        locale: resolvePlanned(file.locale),
        entries: file.entries.length,
        isSource: resolvePlanned(file.locale) === project.sourceLocale,
      }));

      // Dry run by default, like every other write in this codebase. It reports the expansion too:
      // "nothing was written" is true and useless on its own when the caller's real question is
      // whether their `zh-Hans` files are going to become a second Chinese locale.
      if (!input.confirm) {
        const expansion = await sync.previewShapeExpansion(
          {
            projectId: project.id,
            locales: input.files.map((file) => file.locale),
            platforms: input.files.map((file) => file.platform as never),
          },
          actor,
        );
        return {
          dryRun: true,
          project: { id: project.id, name: project.name, sourceLocale: project.sourceLocale },
          files: planned,
          entryCount,
          expansion,
          note: 'Nothing was written. Call again with confirm=true to import.',
        };
      }

      // The same path the CLI uses: upload a scan, then push the plan it produces. Reusing it means
      // an import and a repository push cannot produce different platform state.
      const scanId = `mcp-${Date.now().toString(36)}`;
      const payload = {
        projectId: project.id,
        scanId,
        // This call carries whichever files the agent chose to send, so it is a batch, never a
        // statement that the rest of the repository is gone. Without this an import of one key
        // into a 5,000-entry project proposed 5,000 archive candidates and blew the transaction.
        partial: true,
        client: { name: 'localehub-remote-mcp', version: '0.1.0' },
        files: input.files.map((file) => ({
          fileId: `${file.platform}-${file.locale}`,
          filePath: file.path,
          locale: file.locale,
          platform: file.platform,
          format: 'json',
          fileHash: contentHash(JSON.stringify(file.entries)),
          entryCount: file.entries.length,
        })),
        entries: input.files.flatMap((file) =>
          file.entries.map((entry) => ({
            key: entry.key,
            namespace: file.namespace ?? '',
            locale: file.locale,
            // The platform of the file this entry came from, which is part of the key's identity.
            // Leaving it out is what made every MCP import land under `web`, whatever the caller
            // declared — an iOS project's keys included.
            platform: file.platform,
            value: entry.value,
            // The scan's own copy of this flag is informational; the push re-derives source from
            // `identity.locale === project.sourceLocale` after `recordScan` normalises the locale.
            isSource: file.locale === project.sourceLocale,
            contentHash: contentHash(entry.value),
            fileId: `${file.platform}-${file.locale}`,
            filePath: file.path,
          })),
        ),
      };

      const scan = await sync.recordScan(project.id, payload as never, actor);
      const preview = await sync.createPreview(
        {
          projectId: project.id,
          connectionId: scan.connectionId,
          scanId: scan.scanId,
          direction: 'push',
          includeDeletes: false,
          includeDrafts: false,
        },
        actor,
      );
      const pushed = await sync.push(
        { syncPlanId: preview.planId, planHash: preview.planHash, client: { name: 'localehub-remote-mcp', version: '0.1.0' } } as never,
        actor,
      );

      // The same action name the REST push uses, because it is the same operation; `via` records
      // which surface performed it, which is what an operator needs when they ask "who pushed
      // forty keys at 3am" and the answer is an agent rather than a person.
      await audit({
        action: 'sync.push',
        resourceType: 'sync_session',
        resourceId: pushed.syncSessionId,
        projectId: project.id,
        syncSessionId: pushed.syncSessionId,
        metadata: {
          via: 'import_translations',
          entryCount,
          files: planned,
          summary: pushed.summary,
          localesAdded: scan.expansion.localesAdded,
          localesMatched: scan.expansion.localesMatched,
          platformsAdded: scan.expansion.platformsAdded,
        },
      });

      return {
        dryRun: false,
        project: { id: project.id, name: project.name, sourceLocale: project.sourceLocale },
        files: planned,
        entryCount,
        // Which languages this import added to the project, and which of the caller's tags were
        // matched to one it already had. Without this the expansion is invisible.
        expansion: scan.expansion,
        result: {
          revision: pushed.revision,
          summary: {
            ...pushed.summary,
            // Entries identical on both sides never enter the plan — that is what keeps a push's
            // cost proportional to the change. They are still the answer to "did my import do
            // anything?", so the count comes from the comparison rather than from the push.
            unchanged: preview.plan.summary.unchanged,
          },
        },
      };
    },
  );

  define('list_projects', '列出当前 Token 可访问的项目（只返回你自己的，看不到别人的）', async () =>
    tenant.withOrganization(actor.organizationId, async (tx) => {
      const projects = await tx.project.findMany({
        where: actor.boundProjectIds?.length ? { id: { in: actor.boundProjectIds } } : {},
        orderBy: { name: 'asc' },
        include: { _count: { select: { keys: true, entries: true, locales: true } } },
      });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        sourceLocale: project.sourceLocale,
        revision: project.revision,
        counts: project._count,
      }));
    }),
  );

  define('get_project', '读取项目详情：语言、平台、Key/译文计数、revision。导入前核对 state 用', async (input: { project_id: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.project.findUniqueOrThrow({ where: { id: input.project_id }, include: { locales: true, platforms: true } }),
    );
  });

  define('list_project_locales', '读取项目语言列表（含 sourceLocale）。导入前拿确切的 locale 代码，不要猜', async (input: { project_id: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return tenant.withOrganization(actor.organizationId, (tx) =>
      tx.locale.findMany({ where: { projectId: input.project_id }, orderBy: { code: 'asc' } }),
    );
  });

  /* --------------------------------------------------------------- translations */

  define(
    'search_translation_keys',
    '检索翻译 Key：按关键词/语言/状态/端过滤，返回条目 id 与当前值（分页，用 cursor 续取）',
    async (input: {
      project_id: string;
      query?: string;
      locale?: string;
      status?: string;
      platform?: string;
      limit?: number;
      cursor?: string;
    }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return tenant.withOrganization(actor.organizationId, async (tx) => {
        const rows = await tx.translationEntry.findMany({
          where: {
            projectId: input.project_id,
            ...(input.locale ? { localeCode: input.locale } : {}),
            ...(input.status ? { status: input.status as never } : {}),
            key: {
              archivedAt: null,
              ...(input.platform ? { platform: input.platform as never } : {}),
              ...(input.query ? { key: { contains: input.query, mode: 'insensitive' } } : {}),
            },
          },
          include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
          take: Math.min(input.limit ?? 50, 200),
          skip: input.cursor ? 1 : 0,
          ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
          orderBy: { id: 'asc' },
        });
        return rows.map((entry) => ({
          entryId: entry.id,
          key: entry.key.key,
          namespace: entry.key.namespace.name,
          platform: entry.key.platform,
          locale: entry.localeCode,
          value: entry.value,
          status: entry.status,
          source: entry.key.sourceVersions[0]?.value ?? null,
          revision: entry.revision,
        }));
      });
    },
  );

  define(
    'get_translation_entry',
    '读取单条翻译条目（含版本历史与 QA 问题）',
    async (input: { project_id: string; key: string; locale: string }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return tenant.withOrganization(actor.organizationId, async (tx) => {
        const entry = await tx.translationEntry.findFirst({
          where: { projectId: input.project_id, localeCode: input.locale, key: { key: input.key } },
          include: {
            key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 5 } } },
            versions: { orderBy: { version: 'desc' }, take: 10 },
          },
        });
        if (!entry) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No entry for ${input.key} in ${input.locale}`, 404);
        const qaIssues = await tx.qaIssue.findMany({ where: { entryId: entry.id, status: 'OPEN' } });
        return { entry, qaIssues };
      });
    },
  );

  /**
   * The termbase, as this project is actually held to it.
   *
   * Through the resolver rather than a raw `findMany` over both scopes — which is what this was, and
   * it was the one read path the resolver missed. The raw query has four ways of lying to a caller:
   * a term that exists organisation-wide *and* per project comes back **twice**, with nothing saying
   * which reading the translator is held to; a project row whose only meaning is to switch that
   * organisation term off here comes back as if it were a term; a `DEPRECATED` term comes back as if
   * it were current; and nothing carries `scope`, so the caller cannot tell one from another.
   *
   * `locale` used to be accepted and ignored. It now narrows to the terms that apply to that language
   * and resolves each one's value and forbidden wordings *for that language* — which is the question
   * an agent writing a translation actually has.
   */
  define(
    'get_glossary',
    '读取术语库：这个项目实际被要求遵守的词条（项目级覆盖组织级、被关掉的不出现、废弃的带状态返回，每条带 scope 与它覆盖了谁）。给 locale 就只返回在该语言适用的，并带上该语言的译法与禁用说法',
    async (input: { project_id: string; locale?: string }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return tenant.withOrganization(actor.organizationId, async (tx) => {
        const terms = await resolveGlossary(tx, { organizationId: actor.organizationId, projectId: input.project_id });
        if (!input.locale) return { terms };
        const locale = input.locale;
        return {
          locale,
          terms: terms
            .map((term) => ({
              ...term,
              // `termTarget` answers with the source term itself for a do-not-translate term, so the
              // caller never has to know about the flag to hold a translator to it.
              translation: termTarget(term, locale),
              forbidden: term.forbiddenTargets[locale] ?? [],
            }))
            // A term with no value in this language is not a term *for this language* — it would read
            // as leave-it-as-it-is, which is a different instruction.
            .filter((term) => term.translation !== null),
        };
      });
    },
  );

  /**
   * Bring an existing termbase in.
   *
   * The counterpart to `extract_glossary_candidates` for the other half of the world: teams that
   * already have a glossary — in Excel, in a TBX export, in a `.strings` file the CAT tool wrote —
   * rather than one to be mined out of their translations.
   *
   * It takes **terms, not a file**, for the same reason `import_translations` does: the platform
   * cannot see the caller's disk, so the caller parses its own spreadsheet and hands over what it
   * read. That is not a limitation to work around; it is the boundary the whole product is built on.
   *
   * Two decisions the caller has to make out loud:
   *
   *  * **Upsert by term.** A corrected spreadsheet imported twice must not leave two of everything.
   *  * **`status`.** Defaults to DRAFT, because a termbase arrival is a proposal until somebody says
   *    otherwise. `APPROVED` puts every violation of these terms in front of a release, so it takes
   *    a PROJECT_MANAGER: the person importing usually does know these words are settled, and that
   *    is exactly why they have to say so rather than have the platform assume it.
   *
   * A term somebody already approved is not rewritten by a draft import — it comes back in
   * `untouched`, the same rule `upsert_glossary_terms` follows.
   */
  define(
    'import_glossary_terms',
    '把一份现成的词表导入项目（按 term 覆盖，重复导入不会重复）。只收已经解析好的词条：文件在你自己那边，平台读不到。默认落成草稿，指定 APPROVED 需要 PROJECT_MANAGER 角色',
    async (input: {
      project_id: string;
      status: 'DRAFT' | 'APPROVED';
      terms: {
        term: string;
        translations?: Record<string, string>;
        case_sensitive?: boolean;
        do_not_translate?: boolean;
        forbidden_targets?: Record<string, string[]>;
        note?: string;
      }[];
    }) => {
      // Approving through the side door is still approving.
      assertRole(actor, input.project_id, input.status === 'APPROVED' ? Role.PROJECT_MANAGER : Role.TRANSLATOR);

      const result = await tenant.withOrganizationBulk(actor.organizationId, async (tx) => {
        const created: string[] = [];
        const updated: string[] = [];
        const untouched: { term: string; status: string; reason: string }[] = [];
        for (const entry of input.terms) {
          const existing = await tx.glossaryTerm.findFirst({
            where: {
              organizationId: actor.organizationId,
              projectId: input.project_id,
              term: { equals: entry.term, mode: 'insensitive' },
            },
          });
          if (existing && existing.status !== 'DRAFT' && input.status !== 'APPROVED') {
            untouched.push({ term: existing.term, status: existing.status, reason: '已定稿或已废弃的词条只能由人改动' });
            continue;
          }
          const data: Record<string, unknown> = {
            status: input.status,
            caseSensitive: entry.case_sensitive ?? false,
            doNotTranslate: entry.do_not_translate ?? false,
            forbiddenTargets: (entry.forbidden_targets ?? null) as never,
            description: entry.note ?? null,
            // Importing a term is defining it, so a project row that had switched it off applies
            // again: a spreadsheet whose values land on a switched-off row would otherwise import
            // silently into nothing.
            disabled: false,
          };
          if (entry.translations !== undefined) data.translations = entry.translations;
          if (existing) {
            await tx.glossaryTerm.update({ where: { id: existing.id }, data: data as never });
            updated.push(existing.term);
          } else {
            await tx.glossaryTerm.create({
              data: {
                organizationId: actor.organizationId,
                projectId: input.project_id,
                term: entry.term,
                createdById: actor.userId,
                ...data,
              } as never,
            });
            created.push(entry.term);
          }
        }
        return { created, updated, untouched };
      });

      const written = [...result.created, ...result.updated];
      const recheck = written.length
        ? await enqueueQaRecheck({
            organizationId: actor.organizationId,
            projectId: input.project_id,
            requestedBy: actor.userId,
            reason: 'glossary.imported',
            terms: written,
          })
        : { queued: true };

      await audit({
        action: 'glossary.imported',
        resourceType: 'glossary_term',
        projectId: input.project_id,
        metadata: {
          via: 'import_glossary_terms',
          status: input.status,
          created: result.created.length,
          updated: result.updated.length,
          untouched: result.untouched.length,
        },
      });

      return { ...result, status: input.status, recheck };
    },
  );

  /**
   * What this project keeps saying, and what it already calls it.
   *
   * The counterpart to `upsert_glossary_terms`, and the reason it exists: a caller about to propose
   * terms should first ask the project what it already decided. A project with 2,795 translated keys
   * has answered most of a termbase already — `学习` is `學習` in 152 of them — and a proposal that
   * contradicts 152 existing translations is worse than no proposal.
   *
   * Read-only, and it says so: nothing here writes a term. What it returns is counts and examples —
   * `コース 3/4` alongside the sentence that produced it — because counting is not aligning, and the
   * reader is the one who decides what a term means.
   */
  define(
    'extract_glossary_candidates',
    '从项目已有的译文里数出候选术语，并给出它已有的译法（带条数与例子）。只读：什么都不写；要落成术语用 upsert_glossary_terms',
    async (input: { project_id: string; min_keys: number; limit: number }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return tenant.withOrganization(actor.organizationId, (tx) =>
        extractTermCandidates(tx, {
          organizationId: actor.organizationId,
          projectId: input.project_id,
          minKeys: input.min_keys,
          limit: input.limit,
        }),
      );
    },
  );

  /**
   * Propose terms.
   *
   * The caller that has just read a whole repository is the one that notices "this word is always
   * rendered as X" first, so it is allowed to write into the termbase — as a **candidate**, and
   * nothing else. Two things it cannot do, both deliberate:
   *
   *  * it cannot approve. A term somebody approved is a rule the release check refuses on; handing that to a
   *    model is how a termbase fills with instructions nobody agreed to.
   *  * it cannot touch an already-approved term. Those rows come back under `untouched`, so the
   *    caller learns it was heard and that the answer belongs to a person.
   *
   * Every write is followed by a recheck, because writing a term is the moment the project's
   * translations have to be re-read against it — the same run the back office queues when somebody
   * approves one there.
   */
  define(
    'upsert_glossary_terms',
    '提出术语，落成草稿（不能定稿，也改不动已定稿的词条）。你在仓库里发现的固定说法用这个提上来；译法不确定就留空，不要猜',
    async (input: {
      project_id: string;
      terms: {
        term: string;
        translations?: Record<string, string>;
        case_sensitive?: boolean;
        do_not_translate?: boolean;
        note?: string;
      }[];
    }) => {
      assertRole(actor, input.project_id, Role.TRANSLATOR);
      const result = await tenant.withOrganization(actor.organizationId, async (tx) => {
        const created: string[] = [];
        const updated: string[] = [];
        const untouched: { term: string; status: string; reason: string }[] = [];
        for (const term of input.terms) {
          // Case-insensitive, matching the unique index: `Course` and `course` are one term, and
          // creating the second one would fail against the index rather than say why.
          const existing = await tx.glossaryTerm.findFirst({
            where: {
              organizationId: actor.organizationId,
              projectId: input.project_id,
              term: { equals: term.term, mode: 'insensitive' },
            },
          });
          if (existing && existing.status !== 'DRAFT') {
            untouched.push({
              term: existing.term,
              status: existing.status,
              reason: '已定稿或已废弃的词条只能由人改动',
            });
            continue;
          }
          // Built by assignment rather than a conditional spread: an omitted field must stay absent,
          // never present-and-undefined, or Prisma reads it as "set this Json column to nothing".
          const data: Record<string, unknown> = {};
          // Omitted translations keep whatever is there: a caller that only knows the source word
          // saying "here it is" must not blank out the answer somebody already filled in.
          if (term.translations !== undefined) data.translations = term.translations;
          if (term.note !== undefined) data.description = term.note;
          if (term.case_sensitive !== undefined) data.caseSensitive = term.case_sensitive;
          if (term.do_not_translate !== undefined) data.doNotTranslate = term.do_not_translate;
          if (existing) {
            await tx.glossaryTerm.update({ where: { id: existing.id }, data: data as never });
            updated.push(existing.term);
          } else {
            await tx.glossaryTerm.create({
              data: {
                organizationId: actor.organizationId,
                projectId: input.project_id,
                term: term.term,
                status: 'DRAFT',
                createdById: actor.userId,
                ...data,
              } as never,
            });
            created.push(term.term);
          }
        }
        return { created, updated, untouched };
      });

      const proposed = [...result.created, ...result.updated];
      const recheck = proposed.length
        ? await enqueueQaRecheck({
            organizationId: actor.organizationId,
            projectId: input.project_id,
            requestedBy: actor.userId,
            reason: 'glossary.terms_proposed',
            terms: proposed,
          })
        : { queued: true };

      await audit({
        action: 'glossary.terms_proposed',
        resourceType: 'glossary_term',
        projectId: input.project_id,
        metadata: { created: result.created.length, updated: result.updated.length, untouched: result.untouched.length },
      });

      return { ...result, recheck };
    },
  );

  define(
    'search_translation_memory',
    '检索翻译记忆：历史上出现过的相似译文，用于保持用词一致',
    async (input: { project_id: string; query: string; locale?: string; limit?: number }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return tenant.withOrganization(actor.organizationId, (tx) =>
        tx.translationMemoryEntry.findMany({
          where: {
            organizationId: actor.organizationId,
            ...(input.locale ? { targetLocale: input.locale } : {}),
            sourceText: { contains: input.query, mode: 'insensitive' },
          },
          take: Math.min(input.limit ?? 10, 50),
        }),
      );
    },
  );

  /* ------------------------------------------------------------------------ AI */

  define(
    'translate_entries',
    '调用 AI 生成草稿译文（永远写为 DRAFT，不能自动通过审核）',
    async (input: {
      project_id: string;
      entry_ids: string[];
      target_locales: string[];
      provider?: string;
      write_drafts: boolean;
    }) => {
      assertRole(actor, input.project_id, Role.PRODUCT_MANAGER);
      const result = await ai.draftTranslations(actor, input.project_id, {
        entryIds: input.entry_ids,
        targetLocales: input.target_locales,
        provider: input.provider,
        writeDrafts: input.write_drafts,
      });
      // `write_drafts` decides whether anything was written; a read-only generation should not
      // leave a trail that reads as a change.
      if (input.write_drafts) {
        await audit({
          action: 'translation.ai_translate',
          resourceType: 'translation_entry',
          projectId: input.project_id,
          metadata: { entries: input.entry_ids.length, locales: input.target_locales, provider: input.provider ?? 'default' },
        });
      }
      return result;
    },
  );

  define(
    'review_translation_entries',
    '提交审核决定（需要 REVIEWER 权限）',
    async (input: {
      project_id: string;
      entry_ids: string[];
      locales?: string[];
      decision: 'APPROVE' | 'REJECT';
      comment?: string;
    }) => {
      assertRole(actor, input.project_id, Role.REVIEWER);
      const results = await tenant.withOrganization(actor.organizationId, async (tx) => {
        const results: { entryId: string; status: string }[] = [];
        for (const entryId of input.entry_ids) {
          const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, include: { key: true } });
          if (!entry || entry.projectId !== input.project_id) continue;
          if (input.locales?.length && !input.locales.includes(entry.localeCode)) continue;
          if (entry.status === 'STALE' && input.decision === 'APPROVE') {
            throw new LocaleHubError(
              ErrorCode.STALE_TRANSLATION,
              `${entry.key.key} (${entry.localeCode}) is stale; re-translate before approving`,
              409,
            );
          }
          const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
          await tx.translationEntry.update({
            where: { id: entryId },
            data: { status: status as never, revision: entry.revision + 1 },
          });
          await emitProjectEvent(tx, {
            organizationId: actor.organizationId,
            projectId: input.project_id,
            eventType: input.decision === 'APPROVE' ? 'TRANSLATION_APPROVED' : 'TRANSLATION_REJECTED',
            resourceType: 'translation_entry',
            resourceId: entryId,
            payload: {
              entryId,
              key: entry.key.key,
              locale: entry.localeCode,
              platform: entry.key.platform,
              viaMcp: true,
              comment: input.comment ?? null,
            },
            actorId: actor.userId,
            actorType: 'mcp',
          });
          results.push({ entryId, status });
        }
        return results;
      });

      // Outside the transaction on purpose: `recordAudit` runs on its own connection, so a row
      // written from inside would survive a rollback and claim a review that never happened.
      await audit({
        action: 'translation.review',
        resourceType: 'translation_entry',
        projectId: input.project_id,
        metadata: {
          decision: input.decision,
          reviewed: results.length,
          skipped: input.entry_ids.length - results.length,
          comment: input.comment ?? null,
        },
      });
      return { results };
    },
  );

  define(
    'get_qa_issues',
    '读取 QA 问题：空译文、占位符不一致、缺译、过期、标签不匹配等，带严重级别',
    async (input: { project_id: string; locale?: string; severity?: string; limit?: number }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return tenant.withOrganization(actor.organizationId, (tx) =>
        tx.qaIssue.findMany({
          where: {
            projectId: input.project_id,
            status: 'OPEN',
            ...(input.locale ? { localeCode: input.locale } : {}),
            ...(input.severity ? { severity: input.severity as never } : {}),
          },
          take: Math.min(input.limit ?? 50, 200),
        }),
      );
    },
  );

  define(
    'update_translation_draft',
    '更新译文草稿（新版本，不覆盖历史）',
    async (input: { project_id: string; key: string; locale: string; value: string; expected_revision?: number }) => {
      assertRole(actor, input.project_id, Role.TRANSLATOR);
      const outcome = await tenant.withOrganization(actor.organizationId, async (tx) => {
        const entry = await tx.translationEntry.findFirst({
          where: { projectId: input.project_id, localeCode: input.locale, key: { key: input.key } },
          include: { key: { include: { sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
        });
        if (!entry) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No entry for ${input.key} in ${input.locale}`, 404);
        if (input.expected_revision !== undefined && input.expected_revision !== entry.revision) {
          throw new LocaleHubError(
            ErrorCode.CONFLICT,
            `Entry revision mismatch (expected ${input.expected_revision}, current ${entry.revision})`,
            409,
          );
        }
        assertPlaceholdersPreserved(entry.key.sourceVersions[0]?.value ?? '', input.value, entry.key.key, entry.localeCode);
        const result = await upsertTranslation(tx, {
          organizationId: actor.organizationId,
          projectId: input.project_id,
          keyId: entry.keyId,
          localeId: entry.localeId,
          localeCode: entry.localeCode,
          value: input.value,
          status: 'DRAFT',
          basedOnSourceVersionId: entry.key.sourceVersions[0]?.id ?? null,
          authorId: actor.userId,
          authorType: 'mcp',
        });
        return { entryId: entry.id, versionId: result.translationVersionId, changed: result.changed };
      });

      // Only a write that actually changed something is a change worth recording, and only after
      // the transaction committed — see the note on `review_translation_entries`.
      if (outcome.changed) {
        await audit({
          action: 'translation.draft_update',
          resourceType: 'translation_entry',
          resourceId: outcome.entryId,
          projectId: input.project_id,
          metadata: { key: input.key, locale: input.locale, translationVersionId: outcome.versionId },
        });
      }
      return { entryId: outcome.entryId, translationVersionId: outcome.versionId, changed: outcome.changed };
    },
  );

  define(
    'submit_review',
    '把译文提交审核（状态置为待审核并生成审核任务）。不会替你批准',
    async (input: { project_id: string; entry_ids: string[]; locales?: string[]; comment?: string }) => {
      assertRole(actor, input.project_id, Role.TRANSLATOR);
      const submitted = await tenant.withOrganization(actor.organizationId, async (tx) => {
        let submitted = 0;
        for (const entryId of input.entry_ids) {
          const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, include: { key: true } });
          if (!entry || entry.projectId !== input.project_id) continue;
          if (input.locales?.length && !input.locales.includes(entry.localeCode)) continue;
          await tx.translationEntry.update({ where: { id: entryId }, data: { status: 'PENDING_REVIEW' } });
          await tx.reviewTask.create({
            data: {
              organizationId: actor.organizationId,
              projectId: input.project_id,
              entryId,
              localeCode: entry.localeCode,
              status: 'PENDING_REVIEW',
              submittedById: actor.userId,
            },
          });
          await emitProjectEvent(tx, {
            organizationId: actor.organizationId,
            projectId: input.project_id,
            eventType: 'TRANSLATION_SUBMITTED',
            resourceType: 'translation_entry',
            resourceId: entryId,
            payload: { entryId, key: entry.key.key, locale: entry.localeCode, comment: input.comment ?? null },
            actorId: actor.userId,
            actorType: 'mcp',
          });
          submitted += 1;
        }
        return submitted;
      });

      // Submitted-and-skipped counts both belong in the row: "we asked for ten, six moved" is the
      // difference between a working client and one sending stale entry ids. Outside the
      // transaction, so a rollback cannot leave a row describing a submission that did not happen.
      if (submitted > 0) {
        await audit({
          action: 'translation.submit_review',
          resourceType: 'translation_entry',
          projectId: input.project_id,
          metadata: {
            submitted,
            skipped: input.entry_ids.length - submitted,
            comment: input.comment ?? null,
          },
        });
      }
      return { submitted };
    },
  );

  /* ------------------------------------------------------------------- sync view */

  define('get_project_sync_status', '读取仓库同步状态：连接、最近一次扫描、待推/待拉的计数（只读；不触碰开发者机器）', async (input: { project_id: string }) => {
    assertRole(actor, input.project_id, Role.READONLY);
    return sync.syncStatus(input.project_id, actor);
  });

  define(
    'get_pending_platform_changes',
    '读取平台侧已审核、尚未写进仓库的变更。每条带 translationVersionId——写回后用 mark_applied 回报时要用它',
    async (input: { project_id: string; locale?: string; status?: string; since_revision?: number; limit?: number }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return sync.getChanges(
        {
          projectId: input.project_id,
          locales: input.locale ? [input.locale] : undefined,
          statuses: [input.status ?? 'APPROVED'] as never,
          sinceRevision: input.since_revision,
          limit: input.limit ?? 100,
        },
        actor,
      );
    },
  );

  define(
    'mark_applied',
    '告诉平台：这些已审核译文已经写进仓库了（由你完成写入）。用 get_pending_platform_changes 拿到的 ' +
      'translationVersionId 逐条回报；平台据此停止再次下发这些变更。先 dry_run=true 预演。',
    async (input: {
      project_id: string;
      items: { key: string; locale: string; platform: string; file_path?: string; translation_version_id?: string }[];
      dry_run: boolean;
      git_commit?: string;
      git_branch?: string;
    }) => {
      assertRole(actor, input.project_id, Role.DEVELOPER);
      assertProjectBound(actor, input.project_id);

      const result = await sync.markApplied(
        {
          projectId: input.project_id,
          items: input.items.map((item) => ({
            key: item.key,
            locale: item.locale,
            platform: item.platform as never,
            filePath: item.file_path ?? null,
            translationVersionId: item.translation_version_id ?? null,
          })),
          gitCommit: input.git_commit ?? null,
          gitBranch: input.git_branch ?? null,
          dryRun: input.dry_run,
          client: { name: 'localehub-remote-mcp', version: '0.1.0' },
        },
        actor,
      );

      // Same action name the REST apply-report uses, because it is the same fact; `via` says which
      // surface asserted it. Nothing is recorded for a dry run — it is a question, not a claim.
      if (!result.dryRun && result.applied.length > 0) {
        await audit({
          action: 'sync.apply',
          resourceType: 'sync_apply_report',
          resourceId: result.sessionId,
          projectId: input.project_id,
          syncSessionId: result.sessionId,
          metadata: {
            via: 'mark_applied',
            applied: result.applied.length,
            skipped: result.skipped.length,
            reasons: result.skipped.map((row) => row.reason),
            gitCommit: input.git_commit ?? null,
          },
        });
      }

      return {
        ...result,
        nextStep: result.skipped.length
          ? 'Re-run get_pending_platform_changes. Items reported as VERSION_SUPERSEDED were changed on ' +
            'the platform after you read them: write the new text and report again.'
          : result.applied.length
            ? 'Recorded. Run localehub scan / sync preview to confirm the platform and the repository agree.'
            : 'Nothing was marked.',
      };
    },
  );

  define(
    'validate_release',
    '发布前校验（缺译、占位符、过期、未解决冲突）',
    async (input: { project_id: string }) => {
      assertRole(actor, input.project_id, Role.READONLY);
      return sync.validateForRelease(input.project_id, actor);
    },
  );

  /**
   * The half of context a key cannot carry.
   *
   * The platform cannot see the caller's screen, so the caller draws it: a sketch of the UI plus one
   * marker per key showing where its text sits. The translation editor then shows the sketch and the
   * translations side by side, in both directions — click a marker, the translation is selected;
   * select a translation, its markers light up.
   *
   * Stored and returned exactly as the REST route does it, because it is the same domain function.
   */
  define(
    'upload_screen_mockup',
    '给一个界面加上「这些文字在屏幕的什么位置」：平台的翻译编辑器会把界面和译文并排显示，点标记跳到对应译文。' +
      '**首选传 document**（整页 HTML）：平台不重画，原文存下来，编辑器在沙箱里照浏览器的方式渲染——' +
      '配色、圆角、字体、阴影、图片全是页面自己的，还原度最高；素材要内联成 data: URI（本地文件）或写成公开的 https 地址。' +
      '只有一段代码、没有整页时才传 html 片段或 ui（近似，不是复刻）；image_base64 + markers 只用于设计稿与截图。' +
      '**内容多高盒子就多高**：不要用固定 height + overflow:hidden 收口——排到盒子外面的文案在图上不存在，后面找不回来（CLIPPED_BOX）。' +
      '**每个元素绝对定位**：容器 position:relative、元素 position:absolute + left/top/width/height，坐标照抄工程的数值；' +
      '不要用 flex/grid 让浏览器替你排——字体差一点整块就挪走，平台会报 FLOW_LAYOUT。' +
      '**不要照着眼睛画一张像那个界面的图**：灰条当文字、手画的形状当图标，传上来就是线框图，平台会报 NO_PICTURES（手画的形状不算素材）。' +
      '原生界面（iOS/安卓/Flutter/RN）的布局数值和图片都在工程里（Auto Layout 约束、layout_*、Flutter 的 padding、资源目录），' +
      '照抄数值、把图内联上来——逐栈对照表见资源 localehub://screen-sketch-guide 的 §9。' +
      'key 从元素上的 data-key / data-i18n-key 来，整页的标记位置由浏览器实测、不用你给坐标；' +
      'key 还没导入也照存，会在返回值里以 markers.unmatched 报告，而不是拒绝。同名屏幕再传一次是整体替换（没有 dry run）。' +
      '返回值里的 report 是平台看过这一页之后的结论（stats 里 pictures 是页面带来的图、shapes 是手画的形状，findings 每条带 advice），' +
      'CLIPPED_BOX / DRAWN_SHAPES / FLOW_LAYOUT / NO_PICTURES / ASSETS_NOT_INLINED / NO_STYLE / NO_SOURCE_COLOURS / IDENTICAL_FRAMES 都说明还没还原到位，' +
      '按 advice 改输入后同名重传。节点表、key/namespace 的来源、上限，以及「让 CLI 从页面源码生成」见 localehub://screen-sketch-guide。',
    async (input: {
      project_id: string;
      name: string;
      platform?: string;
      locale: string;
      ui?: UiSpec;
      /**
       * The page's own source.
       *
       * A fragment is parsed into the same element tree `ui` describes and redrawn; a whole page (a
       * doctype or `<html>`) is kept as sent and rendered in the editor's sandboxed frame, scripts
       * and all — they never run.
       */
      html?: string;
      /** The page kept whole, which is what a full-page `html` means implicitly. */
      document?: string;
      /** Default namespace for an `html` upload. */
      namespace?: string;
      /** A screen's states, each its own frame on one canvas. */
      frames?: { title: string; html?: string; ui?: UiSpec; document?: string }[];
      /** The page's stylesheet, when its colours live in another file. */
      css?: string;
      /** Brand colours, for a screen whose own source carries none. */
      theme?: { accent?: string; background?: string };
      image_base64?: string;
      mime_type?: string;
      width?: number;
      height?: number;
      markers?: {
        key: string;
        namespace?: string;
        x: number;
        y: number;
        width?: number;
        height?: number;
        text?: string;
        note?: string;
      }[];
      replace: boolean;
      /** The caller asserts the screen has no pictures at all. */
      expect_no_images?: boolean;
    }) => {
      assertRole(actor, input.project_id, Role.DEVELOPER);
      assertProjectBound(actor, input.project_id);

      // Resolved before the transaction opens: a malformed, oversized or self-contradictory upload
      // should be refused without holding a database connection, and both error messages already say
      // what to change. `ui` is rendered here, so the stored picture and the stored markers come from
      // one pass over one description.
      const { image, document, markers: resolvedMarkers, legend, width, height } = resolveMockupInput({
        imageBase64: input.image_base64 ?? null,
        mimeType: input.mime_type ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        markers: input.markers,
        ui: input.ui ?? null,
        html: input.html ?? null,
        // A whole page — or an explicit `document` — is stored and rendered rather than redrawn.
        document: input.document ?? null,
        frames: input.frames ?? null,
        namespace: input.namespace ?? null,
        css: input.css ?? null,
        theme: input.theme ?? null,
        // The canvas size follows the screen's platform when the description does not name one.
        platform: input.platform ?? 'web',
      });

      const result = await tenant.withOrganization(actor.organizationId, (tx) =>
        upsertScreenMockup(tx, {
          organizationId: actor.organizationId,
          projectId: input.project_id,
          userId: actor.userId,
          name: input.name,
          platform: (input.platform ?? 'web') as never,
          locale: input.locale,
          image,
          document,
          width,
          height,
          // `namespace` carries a schema default, and a client is free to omit it; filling it here
          // means the domain function always receives the shape its type declares.
          markers: resolvedMarkers,
          legend,
          ...(input.expect_no_images ? { expectations: { noImages: true } } : {}),
          replace: input.replace,
        }),
      );

      await audit({
        action: 'mockup.upload',
        resourceType: 'screen_mockup',
        resourceId: result.mockupId,
        projectId: input.project_id,
        metadata: {
          via: 'upload_screen_mockup',
          name: result.name,
          platform: result.platform,
          locale: result.locale,
          markers: result.markers.total,
          unmatched: result.markers.unmatched.length,
          bytes: result.image.byteSize,
          // The format the server read from the bytes, and what the caller called it. Recorded on
          // purpose: a caller that keeps declaring the wrong type is worth noticing.
          detectedMimeType: result.image.mimeType,
          declaredMimeType: image?.declaredMimeType ?? null,
          // How the screen got here: drawn by the caller, rendered from a description, read out of the
          // page's own source, or the page itself. Recorded so "which callers still hand-measure
          // coordinates" stays answerable from the audit trail.
          source: input.ui ? 'ui' : input.document || result.kind === 'document' ? 'document' : input.html ? 'html' : 'image',
        },
      });

      return {
        ...result,
        // A marker pointing at a key the platform has not imported is normal — the sketch is often
        // drawn while the repository is still being read — so the response says what to do about it
        // rather than treating it as a failure.
        // The platform's own reading of what it just drew: the agent reads this and fixes the next
        // upload, which is the whole point of saying it here rather than in a document.
        report: result.report,
        nextSteps: [
          ...result.report.findings.map((finding) => `${finding.title}——${finding.advice}`),
          ...(result.markers.unmatched.length
          ? [
              `有 ${result.markers.unmatched.length} 个标记指向平台上还没有的 key：${result.markers.unmatched
                .slice(0, 5)
                .map((row) => (row.namespace ? `${row.namespace}:${row.key}` : row.key))
                .join('、')}${result.markers.unmatched.length > 5 ? ' 等' : ''}。`,
              '用 import_translations 把对应的语言文件导入后，这些标记会自动对上译文，不需要重新上传 UI 页面。',
            ]
          : ['UI 页面已保存。在翻译编辑器里点「UI 页面」可以并排查看，点标记或条目会互相跳转。']),
        ],
      };
    },
  );

  /* ------------------------------------------------------------------ resources */

  for (const resource of [
    { name: 'project', uri: 'localehub://projects/{projectId}', template: true },
    { name: 'locales', uri: 'localehub://projects/{projectId}/locales', template: true },
  ] as const) {
    void resource;
  }

  server.registerResource(
    'qa-rules',
    'localehub://qa-rules',
    { title: 'QA rules', description: 'Built-in localization QA rule set', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            [
              { code: 'EMPTY_TRANSLATION', severity: 'ERROR' },
              { code: 'PLACEHOLDER_MISMATCH', severity: 'ERROR' },
              { code: 'MISSING_TRANSLATION', severity: 'WARNING' },
              { code: 'STALE_TRANSLATION', severity: 'WARNING' },
              { code: 'HTML_TAG_MISMATCH', severity: 'WARNING' },
              { code: 'PUNCTUATION_MISMATCH', severity: 'INFO' },
              { code: 'GLOSSARY_TERM_MISSING', severity: 'WARNING' },
            ],
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'import-guide',
    'localehub://import-guide',
    {
      title: 'Import guide',
      description: 'How to upload localization files: call shape, the rules that cannot be undone, and the batching limit',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: REMOTE_MCP_IMPORT_GUIDE }],
    }),
  );

  server.registerResource(
    'screen-sketch-guide',
    'localehub://screen-sketch-guide',
    {
      title: 'Screen sketch guide',
      description:
        'How to give a translation a place on screen: the `ui` element tree, where keys and namespaces come from, the limits, and the two things that cannot be undone',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: REMOTE_MCP_SKETCH_GUIDE }],
    }),
  );

  /* -------------------------------------------------------------------- prompts */

  registerPrompt(
    'review-localization-changes',
    { title: 'Review localization changes', description: '审核平台侧译文变更' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: '请用 Remote MCP 检查本项目待审核与待拉取的变更：search_translation_keys(status=PENDING_REVIEW) → get_translation_entry → get_qa_issues，给出逐条审核建议。注意：你只能提出建议，最终审核必须由人类审核人执行。',
          },
        },
      ],
    }),
  );

  registerPrompt(
    'fix-translation-issues',
    { title: 'Fix translation issues', description: '根据 QA 问题给出修复草稿' },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: '请读取 get_qa_issues，对每个问题给出修复后的译文，并用 update_translation_draft 写入草稿（不要提交审核，也不要尝试批准）。',
          },
        },
      ],
    }),
  );

  registerPrompt(
    'import-localization-files',
    {
      title: 'Import localization files',
      description: '把仓库里的语言文件导入 LocaleHub（推导 locale 与 platform → dry run → 分批导入）',
      argsSchema: {
        projectId: z.string().optional().describe('目标项目 id；省略则先调 list_projects'),
        localesDir: z.string().optional().describe('仓库里语言文件的目录，例如 locales 或 ios/Resources'),
      },
    },
    (args: { focus?: string; projectId?: string; localesDir?: string }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: remoteImportPrompt(args ?? {}) } }],
    }),
  );

  /**
   * The step before the upload: know the app's whole navigation, then draw.
   *
   * Registered as its own prompt because it is a different job with a different deliverable — a table of
   * screens and the actions that reach them — and because an agent asked to "upload this screen" will
   * never discover on its own that the useful question is "which screens are there at all".
   */
  registerPrompt(
    'map-app-screens',
    {
      title: 'Map the app’s screens before uploading',
      description:
        '从启动开始摸清每一屏和进入它的触发点，列成表确认后再一屏一屏传（先读导航源码：storyboard segue / NavigationStack / nav_graph / 路由表）',
      argsSchema: {
        projectId: z.string().optional().describe('目标项目 id；省略则先调 list_projects'),
        app: z.string().optional().describe('要摸清的项目/App，例如 ios/ 或高研院 App'),
      },
    },
    (args: { projectId?: string; app?: string }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: remoteScreenMapPrompt(args ?? {}) } }],
    }),
  );

  registerPrompt(
    'upload-screen-sketch',
    {
      title: 'Upload a screen sketch',
      description:
        '把一个页面的UI 页面传到 LocaleHub（整页 HTML → 预览 → 上传；平台不重画，编辑器照浏览器的方式渲染），让译者在编辑器里对着界面看译文',
      argsSchema: {
        projectId: z.string().optional().describe('目标项目 id；省略则先调 list_projects'),
        page: z.string().optional().describe('要画的那个页面，例如 apps/web/src/app/projects/page.tsx'),
      },
    },
    (args: { projectId?: string; page?: string }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: remoteSketchPrompt(args ?? {}) } }],
    }),
  );

  /* --------------------------------------------------------------------- skills */

  const skills = await loadSkills(actor, tenant);

  server.registerResource(
    'skills-index',
    SKILLS_INDEX_URI,
    {
      title: 'LocaleHub Skills',
      description: '本组织已发布的 Skill 清单，含每个 Skill 的 resource URI 与 prompt 名称',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderSkillIndex(skills) }],
    }),
  );

  // The template advertises one resource per published skill; `list` is what makes them
  // discoverable, since a client cannot guess slugs.
  server.registerResource(
    'skill',
    new ResourceTemplate(SKILL_RESOURCE_TEMPLATE, {
      list: async () => ({
        resources: skills.map((skill) => ({
          uri: skill.resourceUri,
          name: skill.slug,
          title: skill.name,
          description: skill.description ?? `${skill.kind} skill v${skill.version}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Skill', description: '已发布的 Skill 正文（SKILL.md）', mimeType: 'text/markdown' },
    async (uri, variables) => {
      const slug = String(variables.slug);
      const skill = skills.find((candidate) => candidate.slug === slug);
      if (!skill) {
        throw new LocaleHubError(ErrorCode.NOT_FOUND, `Skill ${slug} is not published in this organization`, 404);
      }
      // Verbatim, frontmatter included: a resource is the file.
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill.content }] };
    },
  );

  for (const skill of skills) {
    if (!skill.promptName) continue;
    registerPrompt(
      skill.promptName,
      { title: skill.name, description: skill.description ?? `${skill.name} (v${skill.version})`, argsSchema: skillPromptArgs },
      ({ focus }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              // The blank line before the body is deliberate; only the focus line is optional.
              text: [
                `按 LocaleHub Skill「${skill.name}」(v${skill.version}) 执行本次本地化任务。`,
                ...(focus ? [`本次范围：${focus}`] : []),
                '',
                skillBody(skill.content),
              ].join('\n'),
            },
          },
        ],
      }),
    );
  }

  return server;
}
