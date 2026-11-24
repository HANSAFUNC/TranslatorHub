import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ErrorCode,
  LocaleHubError,
  buildUiSpec,
  comparePlaceholders,
  contentHash,
  defaultViewport,
  renderUiSketch,
  type ApplyReportRequest,
  type ConflictRecord,
  type ConflictResolution,
  type PlatformChange,
  type ProjectShapeExpansion,
  type PushResult,
} from '@localehub/contracts';
import { ApiClient, type SyncPreviewResponse } from '@localehub/api-client';
import {
  GitClient,
  SafeFileWriter,
  WorkspaceGuard,
  loadLocalConfig,
  resolveToken,
  scanWorkspace,
  walkWorkspace,
  type LoadedConfig,
  type ScanResult,
} from '@localehub/workspace';
import { globToRegExp } from '@localehub/contracts';
import type { ApplyPlan } from '@localehub/sync-engine';
import { executeApply, planApply, toApplyReportPayload } from './apply';
import { scanAndCollect, type ScanSummary } from './scan';
import { analyzeSketch } from '@localehub/contracts';

import { analyzeDocument, analyzeRasterImage, documentMarkers, imageDimensions, isFullDocument } from '@localehub/contracts';
import { inlineLocalImages, inlinePageAssets, readPageFile } from './ui-extract';
import { keyIndexFromTranslations, markersFromDump, parseUiDump } from './ui-dump';
import { StateStore } from './state';

export interface ServiceContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** JSON-shaped result of one operation. The CLI prints it; nothing here speaks a wire protocol. */
export interface OperationResult {
  [key: string]: unknown;
}

/**
 * Local repository operations, as driven by the CLI.
 *
 * Every operation that touches the network or the filesystem goes through:
 *   - WorkspaceGuard (path allowlists, symlink checks)
 *   - SafeFileWriter (backup + atomic write + re-parse)
 *   - the platform API (single source of business truth)
 * Nothing here commits or pushes git on its own.
 *
 * The class is deliberately transport-free. It used to back a stdio MCP server as well; that
 * server is gone (the platform exposes one MCP, on the platform side), and this engine is what
 * `localehub scan / sync / apply` runs on.
 */
export class LocalSyncServices {
  private loaded: LoadedConfig | null = null;
  private guard: WorkspaceGuard | null = null;
  private api: ApiClient | null = null;
  private state: StateStore | null = null;
  private lastScan: { result: ScanResult; summary: ScanSummary; payload: { projectId: string; scanId: string } } | null = null;

  constructor(private readonly context: ServiceContext = { cwd: process.cwd(), env: process.env }) {}

  /* -------------------------------------------------------------- bootstrap */

  config(): LoadedConfig {
    if (!this.loaded) {
      this.loaded = loadLocalConfig(this.context.cwd);
      // `LOCALEHUB_API_URL` is documented as overriding the config file (docs/MCP.md). It used to
      // be applied by the stdio entry point on its *own* copy of LoadedConfig, which the services
      // never read — they load their own — so the override was silently dropped and every caller
      // talked to the config file's address regardless. Applied here, where the config is read,
      // it holds for the CLI and the MCP server alike.
      const override = this.context.env.LOCALEHUB_API_URL;
      if (override) this.loaded.config.localehub.apiUrl = override;
    }
    return this.loaded;
  }

  workspace(): WorkspaceGuard {
    if (!this.guard) this.guard = new WorkspaceGuard(this.config().config, this.config().root);
    return this.guard;
  }

  store(): StateStore {
    if (!this.state) this.state = new StateStore(this.workspace().root);
    return this.state;
  }

  git(): GitClient {
    return new GitClient(this.workspace().root);
  }

  client(): ApiClient {
    if (!this.api) {
      const config = this.config().config;
      const token = resolveToken(config, this.context.env);
      this.api = new ApiClient({
        baseUrl: config.localehub.apiUrl.replace(/\/api\/v1$/, '') + '/api/v1',
        token,
        clientName: 'localehub-cli',
        clientVersion: '0.1.0',
      });
    }
    return this.api;
  }

  projectId(explicit?: string): string {
    return explicit ?? this.config().config.project.id;
  }

  clientInfo(): { name: string; version: string; gitBranch?: string; gitCommit?: string } {
    const git = this.git();
    const info = git.info();
    return {
      name: 'localehub-cli',
      version: '0.1.0',
      ...(info.branch ? { gitBranch: info.branch } : {}),
      ...(info.commit ? { gitCommit: info.commit } : {}),
    };
  }

  /* --------------------------------------------------- get_local_project_info */

  async getLocalProjectInfo(): Promise<OperationResult> {
    const loaded = this.config();
    const guard = this.workspace();
    const git = this.git();
    const info = git.info();
    const state = this.store().get();
    return {
      configPath: loaded.configPath,
      workspaceRoot: guard.root,
      project: {
        id: loaded.config.project.id,
        name: loaded.config.project.name ?? null,
        sourceLocale: loaded.config.project.sourceLocale,
        platforms: loaded.config.project.platforms ?? [],
      },
      apiUrl: loaded.config.localehub.apiUrl,
      tokenEnv: loaded.tokenEnv,
      fileMappings: loaded.config.files.map((mapping) => ({
        id: mapping.id,
        platform: mapping.platform,
        locale: mapping.locale ?? (mapping.localeFromPath ? '<from path>' : '*'),
        format: mapping.format,
        source: mapping.source === true,
        paths: mapping.paths,
      })),
      workspacePolicy: {
        allowRead: loaded.config.workspace.allowRead,
        allowWrite: loaded.config.workspace.allowWrite,
        denyRead: loaded.config.workspace.denyRead,
        denyWrite: loaded.config.workspace.denyWrite,
      },
      syncPolicy: loaded.config.sync,
      git: {
        isRepository: info.isRepository,
        branch: info.branch,
        commit: info.commit,
        shortCommit: info.shortCommit,
        dirty: info.dirty,
        changedFiles: info.changedFiles.slice(0, 50),
      },
      validation: loaded.validation,
      lastScanId: state.lastScanId,
      lastPreview: state.lastPreview,
      pendingApplyPlans: state.pendingApplyPlans.map((plan) => ({
        applyPlanId: plan.applyPlanId,
        expiresAt: plan.expiresAt,
        ready: plan.summary.ready,
        blocked: plan.summary.blocked,
      })),
    };
  }

  /* ------------------------------------------------------ scan_local_project */

  async scanLocalProject(input: { project_id?: string; file_set_ids?: string[] } = {}): Promise<OperationResult> {
    const projectId = this.projectId(input.project_id);
    const guard = this.workspace();
    const scanId = `scan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const config = this.config().config;
    const { result, summary, payload } = await scanAndCollect(guard, {
      projectId,
      sourceLocale: config.project.sourceLocale,
      fileSetIds: input.file_set_ids,
      scanId,
      client: this.clientInfo(),
      // `--file-set` narrows the scan to part of the repository. Saying so keeps the platform from
      // reading every excluded file as deleted.
      partial: Boolean(input.file_set_ids?.length),
    });

    // Upload the scan so the platform can compute the three-way comparison.
    let uploaded: { connectionId: string; expansion: ProjectShapeExpansion | null } | null = null;
    let uploadError: string | null = null;
    try {
      const response = await this.client().uploadScan(payload);
      uploaded = { connectionId: response.connectionId, expansion: response.expansion ?? null };
      this.store().patch({
        projectId,
        connectionId: response.connectionId,
        lastScanId: scanId,
        lastScanAt: new Date().toISOString(),
      });
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error);
    }

    this.lastScan = { result, summary, payload: { projectId, scanId } };
    this.store().record('scan_local_project', `${summary.filesScanned} files, ${summary.entriesFound} entries`);

    // The platform adds any language or platform the repository has and the project does not, so
    // the scan has to say when it did — otherwise a first push silently grows the project's locale
    // list and nobody learns about it until the project page shows an unfamiliar language.
    const expansion = uploaded?.expansion ?? null;
    const expanded = expansion
      ? [
          ...expansion.localesAdded.map((code) => `${code}（新增语言）`),
          ...expansion.localesMatched.map((row) => `${row.from} → ${row.to}（已归入现有语言）`),
          ...expansion.platformsAdded.map((platform) => `${platform}（新增端）`),
        ]
      : [];

    return {
      ...summary,
      uploaded: uploaded !== null,
      uploadError,
      connectionId: uploaded?.connectionId ?? null,
      expansion,
      expanded,
      localOnly: uploaded === null,
      hint: uploaded
        ? expanded.length
          ? `Scan uploaded; the platform also added ${expanded.join('、')}. Call preview_sync to compute the three-way diff.`
          : 'Scan uploaded. Call preview_sync to compute the three-way diff.'
        : 'Scan works offline. Start the API and re-run scan_local_project before push/pull.',
    };
  }

  /* ----------------------------------------------------- read_project_context */

  /**
   * Read source files for context. Strictly read-only, restricted to `workspace.allowRead`,
   * and never uploaded anywhere by this call (spec §0.3: code context is read on demand).
   */
  async readProjectContext(input: { glob: string; max_files: number; max_bytes_per_file: number }): Promise<OperationResult> {
    const guard = this.workspace();
    const matcher = globToRegExp(input.glob);
    const candidates = walkWorkspace(guard.root).filter((file) => matcher.test(file));
    const allowed: string[] = [];
    const denied: { file: string; reason: string }[] = [];
    for (const file of candidates) {
      try {
        guard.assertReadable(file);
        allowed.push(file);
      } catch (error) {
        denied.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const selected = allowed.slice(0, input.max_files);
    const files = selected.map((file) => {
      const content = readFileSync(guard.absolute(file), 'utf8');
      const truncated = Buffer.byteLength(content, 'utf8') > input.max_bytes_per_file;
      return { file, excerpt: truncated ? content.slice(0, input.max_bytes_per_file) : content, truncated };
    });
    return {
      files,
      matched: candidates.length,
      allowed: allowed.length,
      denied: denied.slice(0, 20),
      note: 'Context is read locally only. It is never uploaded unless the user explicitly asks for it.',
    };
  }

  /* -------------------------------------------------------- get_remote_project */

  async getRemoteProject(input: { project_id?: string } = {}): Promise<OperationResult> {
    const projectId = this.projectId(input.project_id);
    const [project, status] = await Promise.all([this.client().getProject(projectId), this.client().syncStatus(projectId)]);
    return { project, syncStatus: status };
  }

  /* ------------------------------------------------------------- preview_sync */

  async previewSync(input: {
    project_id?: string;
    direction?: 'bidirectional' | 'push' | 'pull';
    scan_id?: string;
    include_deletes?: boolean;
    include_drafts?: boolean;
    file_set_ids?: string[];
    locales?: string[];
  }): Promise<OperationResult> {
    const projectId = this.projectId(input.project_id);
    const scanId = input.scan_id ?? this.lastScan?.summary.scanId ?? this.store().get().lastScanId;
    if (!scanId) {
      throw new LocaleHubError(ErrorCode.NOT_FOUND, 'No scan available. Call scan_local_project first.', 400);
    }

    const status = await this.client().syncStatus(projectId);
    const connectionId = status.connection?.id ?? this.store().get().connectionId;
    if (!connectionId) {
      throw new LocaleHubError(
        ErrorCode.NOT_FOUND,
        'No repository connection yet. Run scan_local_project once so the platform can register this repository.',
        400,
      );
    }

    const preview: SyncPreviewResponse = await this.client().previewSync({
      projectId,
      repositoryConnectionId: connectionId,
      scanId,
      direction: input.direction ?? 'bidirectional',
      includeDeletes: input.include_deletes ?? false,
      includeDrafts: input.include_drafts ?? false,
      locales: input.locales,
    });

    this.store().patch({
      lastPreview: {
        syncPlanId: preview.syncPlanId,
        planHash: preview.planHash,
        sessionId: preview.sessionId,
        expiresAt: preview.expiresAt,
        summary: preview.summary as unknown as Record<string, number>,
        createdAt: new Date().toISOString(),
      },
      lastRevision: status.revision,
    });
    this.store().record('preview_sync', `plan ${preview.syncPlanId}`);

    return {
      syncPlanId: preview.syncPlanId,
      planHash: preview.planHash,
      sessionId: preview.sessionId,
      expiresAt: preview.expiresAt,
      summary: preview.summary,
      requiresConfirmation: true,
      changes: preview.plan.items.map((item) => ({
        changeId: item.changeId,
        action: item.action,
        key: item.identity.key,
        namespace: item.identity.namespace,
        locale: item.identity.locale,
        platform: item.identity.platform,
        filePath: item.diff.filePath,
        base: item.diff.baseValue,
        local: item.diff.localValue,
        platformValue: item.diff.remoteValue,
        reason: item.diff.reason,
        conflictReason: item.diff.conflictReason ?? null,
        reviewStatus: item.diff.reviewStatus,
        remoteApplyEligible: item.diff.remoteApplyEligible,
      })),
      nextStep:
        preview.summary.pushNew + preview.summary.pushUpdated > 0
          ? 'Show this list to the user. Call push_project_changes with confirm=true only after they approve.'
          : 'Nothing to push. Call pull_platform_updates to fetch approved platform changes.',
    };
  }

  /* ---------------------------------------------------- push_project_changes */

  async pushProjectChanges(input: {
    preview_id?: string;
    sync_plan_id?: string;
    confirm?: boolean;
    idempotency_key?: string;
    include_deletes?: boolean;
  }): Promise<OperationResult> {
    const state = this.store().get();
    const preview = state.lastPreview;
    const planId = input.sync_plan_id ?? input.preview_id ?? preview?.syncPlanId;
    if (!planId || !preview || preview.syncPlanId !== planId) {
      throw new LocaleHubError(
        ErrorCode.SYNC_PLAN_NOT_FOUND,
        'No matching preview found. Call preview_sync first, show the plan to the user, then push with that plan id.',
        409,
      );
    }
    if (!input.confirm) {
      return {
        requiresConfirmation: true,
        syncPlanId: planId,
        planHash: preview.planHash,
        summary: preview.summary,
        message: 'Not pushed. Re-run with confirm=true after the user explicitly approves this plan.',
      };
    }

    const idempotencyKey =
      input.idempotency_key ??
      `repo-${this.store().get().connectionId ?? 'conn'}-${this.clientInfo().gitCommit ?? 'nocommit'}-${preview.planHash.slice(0, 16)}`;

    const result: PushResult = await this.client().push({
      syncPlanId: planId,
      planHash: preview.planHash,
      idempotencyKey,
      client: this.clientInfo(),
    });

    this.store().patch({
      lastRevision: result.revision,
      lastPreview: { ...preview, summary: result.summary as unknown as Record<string, number> },
    });
    this.store().record('push_project_changes', `${result.summary.created} created, ${result.summary.updated} updated`);

    return {
      syncSessionId: result.syncSessionId,
      status: result.status,
      revision: result.revision,
      idempotentReplay: result.idempotentReplay,
      summary: result.summary,
      accepted: result.accepted,
      conflicts: result.conflicts,
      failed: result.failed,
      nextStep:
        result.summary.conflicts > 0
          ? 'Some entries conflict. Use resolve_sync_conflict or fix them on the platform, then preview again.'
          : 'Push complete. On the platform, edit and approve translations, then call pull_platform_updates.',
    };
  }

  /* ------------------------------------------------- pull_platform_updates */

  /**
   * Generate a screen sketch from a page in this repository and (optionally) upload it.
   *
   * The whole point is that nobody measures coordinates: the page's own code says which elements it
   * has and what text is on them, so every string on the screen gets a marker at the position the
   * layout gives it. Without `confirm` nothing is uploaded — the preview is written next to the
   * config as an SVG so it can be looked at first, which is the same "look before you write" rule the
   * sync commands follow.
   */
  /**
   * A whole page, kept as it is.
   *
   * This is the highest-fidelity path there is, and it is deliberately the one the CLI takes when the
   * file is a page: the platform stores the markup and the editor renders it in a sandboxed frame, so
   * the picture a translator sees is the caller's own page instead of the platform's approximation of
   * it. What the CLI adds is the part only a checkout can do — the page's assets come along, inlined,
   * because `./logo.png` means nothing to a browser pointed at the platform.
   *
   * Scripts travel with the page and never run: the replica is the page's appearance, not its
   * behaviour, so anything filled in by a fetch is simply absent (动态数据除外).
   */
  private async generateReplicaMockup(
    input: {
      page: string;
      name?: string;
      platform?: string;
      locale?: string;
      namespace?: string;
      width?: number;
      height?: number;
      confirm?: boolean;
      replace?: boolean;
    },
    read: { source: string; fileName: string },
  ): Promise<OperationResult> {
    const config = this.config().config;
    const guard = this.workspace();
    const assets = inlinePageAssets(guard, read.source, read.fileName);
    const html = assets.source;
    const name = input.name ?? read.fileName.split('/').pop()!.replace(/\.[^.]+$/, '');
    const locale = input.locale ?? config.project.sourceLocale;
    const platform = input.platform ?? config.project.platforms?.[0] ?? 'web';
    const document = { frames: [{ title: '默认', html }] };
    const markers = documentMarkers(document, { namespace: input.namespace ?? null });
    const legend: { index: number; name: string; count: number }[] = [];
    for (const marker of markers) {
      if (!marker.component) continue;
      const existing = legend.find((item) => item.name === marker.component);
      if (existing) existing.count += 1;
      else legend.push({ index: legend.length + 1, name: marker.component, count: 1 });
    }

    const outDir = join(guard.root, '.localehub', 'mockups');
    mkdirSync(outDir, { recursive: true });
    const stem = name.replace(/[^\p{L}\p{N}._-]+/gu, '-');
    const htmlPath = join(outDir, `${stem}.html`);
    const manifestPath = join(outDir, `${stem}.json`);
    writeFileSync(htmlPath, html, 'utf8');

    const report = analyzeDocument({
      document,
      markers: markers.map((marker) => ({
        key: marker.key,
        namespace: marker.namespace,
        frame: marker.frame,
        component: marker.component,
        text: marker.text,
        missing: false,
      })),
      legend,
    });

    const writeManifest = (uploaded: { mockupId: string; checksum: string } | null): void => {
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            $comment:
              '由 localehub mockup 生成；这份 .html 就是上传到平台的整页复刻，浏览器照它渲染。' +
              '要改就改页面源码再跑一次，不要手改这里的文件。',
            kind: 'document',
            projectId: this.projectId(),
            name,
            platform,
            locale,
            namespace: input.namespace ?? null,
            page: read.fileName,
            frames: document.frames.map((frame) => frame.title),
            markers: markers.length,
            components: legend,
            inlinedAssets: assets.inlined.length,
            skippedAssets: assets.skipped,
            uploaded,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    };
    writeManifest(null);

    const skipped = assets.skipped.map((entry) => `没有内联 ${entry.ref}：${entry.why}（复刻里会是破图）`);
    const summary = {
      page: read.fileName,
      name,
      platform,
      locale,
      kind: 'document' as const,
      frames: document.frames.map((frame) => frame.title),
      markers: markers.length,
      components: legend,
      htmlPath: relative(guard.root, htmlPath),
      manifestPath: relative(guard.root, manifestPath),
      inlinedAssets: assets.inlined.length,
      skippedAssets: assets.skipped,
      warnings: [...skipped, ...(markers.length ? [] : ['整页里没有一处 data-key：标记落不到元素上，译文挂不上去'])],
      report,
      uploaded: false as boolean,
      requiresConfirmation: !input.confirm,
    };

    if (!input.confirm) {
      return {
        ...summary,
        message:
          `生成了一份整页复刻（${markers.length} 个标记，写到这里：${summary.htmlPath}）。` +
          '要提交到平台，加 --confirm；提交后编辑器在沙箱里照页面渲染，标记落在元素自己身上。' +
          (report.findings.length
            ? `\n可以先改这些：\n${report.findings.map((finding) => `  · ${finding.title}——${finding.advice}`).join('\n')}`
            : ''),
      };
    }

    const result = await this.client().uploadScreenMockup(this.projectId(), {
      name,
      platform,
      locale,
      document: html,
      ...(input.namespace ? { namespace: input.namespace } : {}),
      replace: input.replace ?? true,
    });
    writeManifest({ mockupId: result.mockupId, checksum: result.image.checksum });

    return {
      ...summary,
      uploaded: true,
      requiresConfirmation: false,
      mockupId: result.mockupId,
      replaced: result.replaced,
      matchedKeys: result.markers.matchedKeys,
      unmatched: result.markers.unmatched,
      imagePath: result.imagePath,
      message:
        `已提交整页复刻：${result.markers.total} 个标记，${result.markers.matchedKeys} 个对上了平台的 Key` +
        (result.markers.unmatched.length
          ? `，${result.markers.unmatched.length} 个还没有导入（编辑器会显示「平台没有这个 Key」）。`
          : '。'),
    };
  }

  /**
   * The platform's own reading of a page, run locally, and nothing else.
   *
   * `generateScreenMockup` already computes this report — but it also writes a preview into
   * `.localehub/mockups/` and is phrased as "make a screen". A caller who has just written the HTML and
   * wants to know whether it passes has a different question, and wants an exit code rather than a
   * paragraph. This closes "本地过、平台不过": one analyzer, one set of rules, both ends of the wire.
   *
   * Nothing is written and nothing is uploaded.
   */
  async checkScreenMockup(input: { page: string; platform?: string; name?: string; namespace?: string }): Promise<OperationResult> {
    const guard = this.workspace();
    const read = readPageFile(guard, input.page);
    const name = input.name ?? read.fileName.split('/').pop()!.replace(/\.[^.]+$/, '');
    const platform = input.platform ?? this.config().config.project.platforms?.[0] ?? 'web';

    /** The findings are the answer; a warning is something to fix, an info is something to know. */
    const summarise = (kind: 'document' | 'drawn', frames: string[], report: ReturnType<typeof analyzeDocument>) => {
      const blocking = report.findings.filter((finding) => finding.severity === 'warning');
      return {
        page: read.fileName,
        name,
        platform,
        kind,
        frames,
        markers: report.stats.markers,
        report,
        blocking: blocking.map((finding) => finding.code),
        passed: blocking.length === 0,
        message:
          `检查完毕（${kind === 'document' ? '整页复刻' : '片段重画'}，${frames.length} 帧，${report.stats.markers} 个标记）：` +
          (blocking.length
            ? `${blocking.length} 条必须改：\n` + blocking.map((f) => `  · ${f.code} ${f.title}\n    ${f.advice}`).join('\n')
            : report.findings.length
              ? `没有必须改的；${report.findings.length} 条提示：` + report.findings.map((f) => f.code).join('、')
              : '没有问题。'),
      } as OperationResult;
    };

    if (isFullDocument(read.source)) {
      const page = inlinePageAssets(guard, read.source, read.fileName);
      const document = { frames: [{ title: '默认', html: page.source }] };
      const markers = documentMarkers(document, { namespace: input.namespace ?? null });
      const legend: { index: number; name: string; count: number }[] = [];
      for (const marker of markers) {
        if (!marker.component) continue;
        const existing = legend.find((item) => item.name === marker.component);
        if (existing) existing.count += 1;
        else legend.push({ index: legend.length + 1, name: marker.component, count: 1 });
      }
      const report = analyzeDocument({
        document,
        markers: markers.map((marker) => ({
          key: marker.key,
          namespace: marker.namespace,
          frame: marker.frame,
          component: marker.component,
          text: marker.text,
          missing: false,
        })),
        legend,
        // The frame the platform will render this page into, measured here too.
        //
        // Without it the local check was quiet about the one defect the platform refuses outright: a
        // page laid out for another canvas passed `localehub mockup check` and then came back a 422 —
        // "本地过、平台不过", from a command whose help promises the same analyzer.
        //
        // `platform`, not `input.platform`: the platform checks against the call's resolved platform
        // (the project's first when the caller named none), so measuring against the raw flag here
        // would reopen exactly that gap for every project that is not `web`.
        frame: defaultViewport(platform),
      });
      return summarise('document', ['默认'], report);
    }

    const pictures = inlineLocalImages(guard, read.source, read.fileName);
    const { spec, strings } = buildUiSpec(pictures.source, read.fileName, {
      name,
      platform,
      ...(input.namespace ? { namespace: input.namespace } : {}),
    });
    const sketch = renderUiSketch(spec);
    const report = analyzeSketch({
      svg: sketch.svg,
      markers: sketch.markers.map((marker) => ({
        key: marker.key,
        namespace: marker.namespace,
        frame: marker.frame ?? null,
        component: marker.component ?? null,
        text: marker.text,
        missing: false,
      })),
      legend: sketch.legend,
    });
    void strings;
    return summarise('drawn', ['默认'], report);
  }

  async generateScreenMockup(input: {
    page: string;
    name?: string;
    platform?: string;
    locale?: string;
    namespace?: string;
    keys?: Record<string, string>;
    /** A stylesheet that lives outside the page, read through the workspace guard. */
    cssFile?: string;
    /** Brand colours the page itself does not carry. */
    theme?: { accent?: string; background?: string };
    width?: number;
    height?: number;
    /** Force the replica path for a page whose doctype was stripped, or to skip the detection. */
    document?: boolean;
    confirm?: boolean;
    replace?: boolean;
  }): Promise<OperationResult> {
    const config = this.config().config;
    const guard = this.workspace();
    const read = readPageFile(guard, input.page);
    // A whole page is not redrawn: it is stored and rendered. Detected from the file itself, so
    // `localehub mockup --page index.html` does the right thing without a second flag, and
    // `--document` forces it for a page whose doctype was stripped.
    if (input.document || isFullDocument(read.source)) return this.generateReplicaMockup(input, read);

    // The page's pictures come along, base64'd, so the sketch shows them instead of a grey frame.
    const pictures = inlineLocalImages(guard, read.source, read.fileName);
    const source = pictures.source;
    const fileName = read.fileName;
    const name = input.name ?? fileName.split('/').pop()!.replace(/\.[^.]+$/, '');
    const locale = input.locale ?? config.project.sourceLocale;
    const platform = input.platform ?? config.project.platforms?.[0] ?? 'web';

    // The page's colours often live in a stylesheet next to it (a globals.css, a theme file): read
    // it so the sketch can use them instead of falling back to the platform's palette.
    const providedCss = input.cssFile ? readFileSync(guard.absolute(guard.assertReadable(input.cssFile)), 'utf8') : undefined;

    const { spec, strings, warnings } = buildUiSpec(source, fileName, {
      name,
      platform,
      locale,
      ...(input.namespace ? { namespace: input.namespace } : {}),
      ...(input.keys ? { keys: input.keys } : {}),
      ...(providedCss ? { css: providedCss } : {}),
      ...(input.theme ? { theme: input.theme } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
    });

    const sketch = renderUiSketch(spec);
    const outDir = join(guard.root, '.localehub', 'mockups');
    mkdirSync(outDir, { recursive: true });
    // The screen's name is usually the page's name in its own language, so keep Unicode letters.
    const svgPath = join(outDir, `${name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}.svg`);
    writeFileSync(svgPath, sketch.svg, 'utf8');

    /**
     * The sketch's own record, written beside it.
     *
     * `.localehub/mockups/` is meant to be committed, and a picture on its own does not say where it
     * came from or whether it is what the platform holds. This does: the page it was read out of, the
     * screen's identity, how many markers, and — once uploaded — the checksum the platform stored, so
     * a reviewer can tell a current sketch from one that has drifted.
     */
    const manifestPath = join(outDir, `${name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}.json`);
    const writeManifest = (uploaded: { mockupId: string; checksum: string } | null): void => {
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            $comment:
              '由 localehub mockup 生成；这份 .svg 就是上传到平台的那张图。' +
              '要改就改页面源码再跑一次，不要手改这里的文件。',
            projectId: this.projectId(),
            name,
            platform,
            locale,
            namespace: input.namespace ?? null,
            page: fileName,
            canvas: { width: sketch.width, height: sketch.height },
            markers: sketch.markers.length,
            strings: strings.length,
            components: sketch.legend,
            uploaded,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    };
    writeManifest(null);

    // The same reading the platform will do, run here so the caller hears it before uploading.
    const report = analyzeSketch({
      svg: sketch.svg,
      markers: sketch.markers.map((marker) => ({
        key: marker.key,
        namespace: marker.namespace,
        frame: marker.frame ?? null,
        component: marker.component ?? null,
        text: marker.text,
        missing: false,
      })),
      legend: sketch.legend,
    });

    const summary = {
      page: fileName,
      name,
      platform,
      locale,
      canvas: { width: sketch.width, height: sketch.height },
      strings: strings.length,
      markers: sketch.markers.length,
      keys: strings.slice(0, 5).map((entry) => entry.key),
      svgPath: relative(guard.root, svgPath),
      manifestPath: relative(guard.root, manifestPath),
      inlinedImages: pictures.inlined.length,
      skippedImages: pictures.skipped,
      warnings: [
        ...warnings,
        ...pictures.skipped.map((entry) => `没有内联 ${entry.ref}：${entry.why}（UI 页面里会是占位框）`),
      ],
      report,
      uploaded: false as boolean,
      requiresConfirmation: !input.confirm,
    };

    if (!input.confirm) {
      return {
        ...summary,
        message:
          `生成了 ${sketch.markers.length} 个标记（写到这里：${summary.svgPath}）。` +
          '要提交到平台，加 --confirm；提交后这个屏幕在翻译编辑器里就能和译文并排看了。' +
          (report.findings.length
            ? `\n可以先改这些：\n${report.findings.map((finding) => `  · ${finding.title}——${finding.advice}`).join('\n')}`
            : ''),

      };
    }

    const result = await this.client().uploadScreenMockup(this.projectId(), {
      name,
      platform,
      locale,
      ui: spec,
      replace: input.replace ?? true,
    });

    writeManifest({ mockupId: result.mockupId, checksum: result.image.checksum });

    return {
      ...summary,
      uploaded: true,
      requiresConfirmation: false,
      mockupId: result.mockupId,
      replaced: result.replaced,
      matchedKeys: result.markers.matchedKeys,
      unmatched: result.markers.unmatched,
      imagePath: result.imagePath,
      message:
        `已提交：${result.markers.total} 个标记，${result.markers.matchedKeys} 个对上了平台的 Key` +
        (result.markers.unmatched.length
          ? `，${result.markers.unmatched.length} 个还没有导入（编辑器会显示「平台没有这个 Key」）。`
          : '。'),
    };
  }

  /**
   * A screen that is running, captured instead of described.
   *
   * Every other way in is a transcription: the HTML a caller wrote, the `ui` tree a caller described,
   * the picture a caller drew and measured by eye. This one is a reading — `screencap` hands back the
   * pixels and `uiautomator dump` hands back where every element actually is, from the same moment. So
   * the picture is the app, and a marker lands on the element it names by construction rather than by
   * arithmetic.
   *
   * It exists because the alternative was measured and failed: an app whose screens were rebuilt as
   * HTML by hand came back with 19 of its 29 Android screens laid out past the frame (the worst at
   * 4.64×, one rendering blank), and no amount of re-reading the layout could be trusted to fix it.
   * Capture is the only input here that cannot be wrong about where things are.
   *
   * The keys still have to come from somewhere: a device shows *values*, not key names. They are
   * looked up in the platform's own translations for the captured locale, and whatever cannot be
   * resolved is reported rather than guessed at.
   */
  async captureScreenMockup(input: {
    name: string;
    platform?: string;
    locale?: string;
    namespace?: string;
    /** The screenshot, exactly as the device produced it. */
    image: Buffer;
    /** The `uiautomator dump` document for the same moment as the screenshot. */
    dumpXml: string;
    /** Which device this came from, written into the manifest for whoever reviews the screen later. */
    device?: Record<string, unknown>;
    /** `text` (or a resource-id's last segment) → key, when the caller already knows the mapping. */
    keys?: Record<string, string>;
    /** Keep the status bar and navigation bar's own nodes. Off: they are not the app's copy. */
    includeSystemUi?: boolean;
    confirm?: boolean;
    replace?: boolean;
  }): Promise<OperationResult> {
    const config = this.config().config;
    const guard = this.workspace();
    const dimensions = imageDimensions(input.image, 'image/png');
    if (!dimensions) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        '这张截图不是能识别的 PNG。截屏要用 `adb exec-out screencap -p`（不能过 shell 重定向，那会破坏字节）。',
        422,
      );
    }

    const parsed = parseUiDump(input.dumpXml);
    if (!parsed.nodes.length) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        '这份 uiautomator dump 里没有任何带 bounds 的节点。先 `adb shell uiautomator dump` 再取回文件；屏幕全黑或正在动画时会拿到空树，重取一次。',
        422,
      );
    }
    // The launcher and the system UI are in the same hierarchy as the app. Their nodes belong to a
    // different package, and their strings are the framework's, not the product's.
    const nodes =
      input.includeSystemUi || !parsed.packageName
        ? parsed.nodes
        : parsed.nodes.filter((node) => !node.packageName || node.packageName === parsed.packageName);

    const locale = input.locale ?? config.project.sourceLocale;
    const namespace = input.namespace ?? '';

    // What is on screen are values. The platform's own translations for that locale are the only
    // dictionary that can say what they are called — and it is read once, in pages, rather than asked
    // per string: there is no "search by value" and inventing one would be a lie about the index.
    const rows: { key: string; namespace: string; value: string | null }[] = [];
    let truncation: string | null = null;
    if (!input.keys) {
      const pageSize = 200;
      const maxRows = 20_000;
      let cursor: string | undefined;
      for (;;) {
        const page = await this.client().listTranslations(this.projectId(), {
          locale,
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        });
        rows.push(...page.items.map((item) => ({ key: item.key, namespace: item.namespace ?? '', value: item.value ?? null })));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        if (rows.length >= maxRows) {
          truncation = `项目在这个语言下有超过 ${maxRows} 条译文，只读了前 ${maxRows} 条用于匹配`;
          break;
        }
      }
    }
    const candidates = keyIndexFromTranslations(rows, namespace);

    const byResourceId = new Map<string, string>();
    for (const [token, key] of Object.entries(input.keys ?? {})) {
      byResourceId.set(token, key);
      byResourceId.set(token.split('/').pop()!, key);
    }

    const resolveKey = (text: string, node: { resourceId: string }): string | null => {
      if (input.keys) {
        const id = node.resourceId.split('/').pop() ?? '';
        return byResourceId.get(text) ?? byResourceId.get(node.resourceId) ?? (id ? byResourceId.get(id) ?? null : null) ?? text;
      }
      const found = candidates(text);
      return found.length === 1 ? found[0]! : null;
    };

    const { markers, skipped, ambiguous } = markersFromDump(nodes, {
      width: dimensions.width,
      height: dimensions.height,
      namespace,
      resolveKey,
      candidates,
    });
    if (!markers.length) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `这一屏上没有任何可翻译的文字（读了 ${nodes.length} 个节点）。确认应用在前台、这一屏已经加载完再截一次。`,
        422,
      );
    }
    if (markers.length > 400) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        `这一屏解析出 ${markers.length} 个标记，平台一个屏幕的上限是 400。这一屏可能包含列表或长文，请截取真正要看的那一屏。`,
        422,
      );
    }

    const resolved = input.keys ? markers.length : markers.filter((marker) => candidates(marker.text).length === 1).length;
    const unmatched = [...new Set(markers.filter((m) => !input.keys && candidates(m.text).length !== 1).map((m) => m.text))];

    // The platform's own reading of a bitmap: it stores the picture and says plainly that it did not
    // look inside it. Run here so the caller hears the same thing before uploading.
    const report = analyzeRasterImage({
      mimeType: 'image/png',
      width: dimensions.width,
      height: dimensions.height,
      markers: markers.map((marker) => ({
        key: marker.key,
        namespace: marker.namespace,
        text: marker.text,
        missing: !input.keys && candidates(marker.text).length !== 1,
      })),
      legend: [],
    });

    const outDir = join(guard.root, '.localehub', 'mockups');
    mkdirSync(outDir, { recursive: true });
    const stem = input.name.replace(/[^\p{L}\p{N}._-]+/gu, '-');
    const imagePath = join(outDir, `${stem}.png`);
    const manifestPath = join(outDir, `${stem}.json`);
    writeFileSync(imagePath, input.image);

    const writeManifest = (uploaded: { mockupId: string; checksum: string } | null): void => {
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          {
            $comment:
              '由 localehub mockup capture 生成：这张 .png 是真机上的这一屏，标记框是同一时刻量出来的元素位置。' +
              '要重截就再跑一次，不要手改这里的文件。',
            kind: 'image',
            projectId: this.projectId(),
            name: input.name,
            platform: input.platform ?? config.project.platforms?.[0] ?? 'android',
            locale,
            namespace: namespace || null,
            canvas: { width: dimensions.width, height: dimensions.height },
            source: 'device-capture',
            device: input.device ?? null,
            nodes: nodes.length,
            markers: markers.length,
            markersResolved: resolved,
            unmatched,
            ambiguous,
            skipped,
            uploaded,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    };
    writeManifest(null);

    const platform = input.platform ?? config.project.platforms?.[0] ?? 'android';
    const summary = {
      name: input.name,
      platform,
      locale,
      kind: 'image' as const,
      canvas: { width: dimensions.width, height: dimensions.height },
      device: input.device ?? null,
      nodes: nodes.length,
      markers: markers.length,
      markersResolved: resolved,
      unmatched,
      ambiguous,
      skipped,
      sample: markers.slice(0, 8).map((marker) => ({ key: marker.key, text: marker.text, x: marker.x, y: marker.y })),
      imagePath: relative(guard.root, imagePath),
      manifestPath: relative(guard.root, manifestPath),
      warnings: [...(truncation ? [truncation] : []), ...(unmatched.length ? [`${unmatched.length} 条文案在 ${locale} 下找不到对应的 key，已用文案本身当 key；平台会在 markers.unmatched 里再报一次`] : [])],
      report,
      uploaded: false as boolean,
      requiresConfirmation: !input.confirm,
    };

    if (!input.confirm) {
      return {
        ...summary,
        message:
          `从设备截到 ${dimensions.width}×${dimensions.height} 的一屏，${nodes.length} 个节点 → ${markers.length} 个标记` +
          `（写入 ${summary.imagePath}）。要提交到平台，加 --confirm。`,
      };
    }

    const result = await this.client().uploadScreenMockup(this.projectId(), {
      name: input.name,
      platform,
      locale,
      imageBase64: input.image.toString('base64'),
      mimeType: 'image/png',
      width: dimensions.width,
      height: dimensions.height,
      markers,
      ...(namespace ? { namespace } : {}),
      replace: input.replace ?? true,
    });
    writeManifest({ mockupId: result.mockupId, checksum: result.image.checksum });

    return {
      ...summary,
      uploaded: true,
      requiresConfirmation: false,
      mockupId: result.mockupId,
      replaced: result.replaced,
      matchedKeys: result.markers.matchedKeys,
      unmatched: result.markers.unmatched,
      imagePathOnPlatform: result.imagePath,
      message:
        `已提交真机截图：${result.markers.total} 个标记，${result.markers.matchedKeys} 个对上了平台的 Key` +
        (result.markers.unmatched.length
          ? `，${result.markers.unmatched.length} 个还没有导入（编辑器会显示「平台没有这个 Key」）。`
          : '。') +
        '这一屏在编辑器里就是真机上的样子，点标记跳到对应译文。',
    };
  }

  async pullPlatformUpdates(
    input: {
      project_id?: string;
      locales?: string[];
      statuses?: string[];
      since_revision?: string | number;
      include_drafts?: boolean;
      limit?: number;
    } = {},
  ): Promise<OperationResult> {
    const projectId = this.projectId(input.project_id);
    const statuses = input.include_drafts
      ? [...(input.statuses ?? ['APPROVED']), 'DRAFT', 'PENDING_REVIEW']
      : (input.statuses ?? ['APPROVED']);
    // Default window = everything the platform recorded after our last successful push/apply.
    // Passing an explicit since_revision always wins (recovery from a missed event).
    const sinceRevision =
      input.since_revision !== undefined ? Number(input.since_revision) : (this.store().get().lastRevision ?? undefined);

    const { changes, revision } = await this.client().getChanges({
      projectId,
      locales: input.locales,
      statuses,
      sinceRevision,
      limit: input.limit ?? 500,
    });

    this.store().record('pull_platform_updates', `${changes.length} change(s)`);

    return {
      revision,
      count: changes.length,
      changes: changes.map((change) => ({
        entryId: change.entryId,
        key: change.key,
        namespace: change.namespace,
        locale: change.locale,
        platform: change.platform,
        current: change.content,
        previous: change.previousContent,
        reviewStatus: change.reviewStatus,
        translationVersionId: change.translationVersionId,
        remoteRevision: change.remoteRevision,
        appliedToRepo: change.appliedToRepo,
        contentHash: change.contentHash,
      })),
      nextStep: changes.length
        ? 'Call preview_apply to see the exact file/key diff. Nothing has been written yet.'
        : 'No approved platform changes to pull.',
    };
  }

  /* ------------------------------------------------------------- preview_apply */

  async previewApply(
    input: {
      project_id?: string;
      change_ids?: string[];
      dry_run?: boolean;
      create_backup?: boolean;
      include_drafts?: boolean;
    } = {},
  ): Promise<OperationResult> {
    const projectId = this.projectId(input.project_id);
    const guard = this.workspace();
    const config = this.config().config;

    const { changes } = await this.client().getChanges({
      projectId,
      statuses: input.include_drafts ? ['APPROVED', 'DRAFT', 'PENDING_REVIEW'] : ['APPROVED'],
      limit: 2000,
    });
    // A change that is already in the repository must not be offered again.
    const pending = changes.filter((change) => !change.appliedToRepo);
    const selected = input.change_ids?.length
      ? pending.filter((change) => input.change_ids!.includes(changeKeyId(change)))
      : pending;

    const scan = await scanWorkspace(guard, { projectId, sourceLocale: config.project.sourceLocale });
    const plan = planApply({
      guard,
      projectId,
      createBackup: input.create_backup ?? config.sync.createBackup,
      preserveUnknownFields: config.sync.preserveUnknownFields,
      includeDrafts: input.include_drafts ?? false,
      scan,
      changes: selected,
    });

    this.store().storeApplyPlan(plan);
    this.store().record('preview_apply', `${plan.summary.ready} ready / ${plan.summary.total}`);

    return {
      applyPlanId: plan.applyPlanId,
      expiresAt: plan.expiresAt,
      dryRun: input.dry_run !== false,
      summary: plan.summary,
      files: plan.files,
      changes: plan.items.map((item) => ({
        changeId: item.changeId,
        key: item.identity.key,
        locale: item.identity.locale,
        filePath: item.filePath,
        status: item.status,
        reason: item.reason,
        previousValue: item.previousValue,
        newValue: item.newValue,
        reviewStatus: item.reviewStatus,
        translationVersionId: item.translationVersionId,
      })),
      requiresConfirmation: true,
      riskWarning: input.include_drafts
        ? 'include_drafts=true: unapproved translations are part of this plan. Writing them replaces approved copy with draft text.'
        : null,
      nextStep: plan.summary.ready
        ? 'Show the per-file diff to the user. Call apply_translation_updates with confirm=true only after they approve.'
        : 'Nothing can be applied. See the blocked reasons (stale local value, drafts, or already applied).',
    };
  }

  /* ------------------------------------------- apply_translation_updates */

  async applyTranslationUpdates(input: {
    apply_plan_id: string;
    confirm?: boolean;
    require_clean_worktree?: boolean;
    create_backup?: boolean;
  }): Promise<OperationResult> {
    const store = this.store();
    const plan: ApplyPlan | null = store.getApplyPlan(input.apply_plan_id);
    if (!plan) {
      throw new LocaleHubError(
        ErrorCode.SYNC_PLAN_NOT_FOUND,
        `Unknown apply plan ${input.apply_plan_id}. Call preview_apply first.`,
        404,
      );
    }
    if (new Date(plan.expiresAt).getTime() <= Date.now()) {
      throw new LocaleHubError(
        ErrorCode.SYNC_PLAN_EXPIRED,
        `Apply plan expired at ${plan.expiresAt}. Re-run preview_apply.`,
        409,
      );
    }
    if (!input.confirm) {
      return {
        requiresConfirmation: true,
        applyPlanId: plan.applyPlanId,
        ready: plan.summary.ready,
        blocked: plan.summary.blocked,
        files: plan.files,
        message: 'Nothing written. Re-run with confirm=true after the user explicitly approves this diff.',
      };
    }

    const config = this.config().config;
    const git = this.git();
    const info = git.info();
    if (input.require_clean_worktree && info.isRepository && info.dirty) {
      throw new LocaleHubError(
        ErrorCode.APPLY_REJECTED_STALE_PREVIEW,
        `Working tree is dirty (${info.changedFiles.length} file(s)). Commit or stash first, or run with require_clean_worktree=false.`,
        409,
        { changedFiles: info.changedFiles },
      );
    }

    const guard = this.workspace();
    const writer = new SafeFileWriter(guard);
    const scan = await scanWorkspace(guard, { projectId: plan.projectId, sourceLocale: config.project.sourceLocale });

    const report = await executeApply(
      {
        guard,
        writer,
        git,
        projectId: plan.projectId,
        createBackup: input.create_backup ?? config.sync.createBackup,
        preserveUnknownFields: config.sync.preserveUnknownFields,
        includeDrafts: plan.items.some((item) => item.reviewStatus !== 'APPROVED'),
      },
      plan,
      scan,
    );

    const session = store.get().lastPreview?.sessionId;
    let reportError: string | null = null;
    if (session) {
      try {
        await this.client().reportApply(
          toApplyReportPayload(report, {
            syncSessionId: session,
            client: this.clientInfo(),
            gitCommit: git.currentHead(),
          }) as ApplyReportRequest,
        );
      } catch (error) {
        reportError = error instanceof Error ? error.message : String(error);
      }
    }

    store.patch({
      lastApplyReport: {
        applyPlanId: plan.applyPlanId,
        status: report.status,
        files: report.files.map((file) => file.filePath),
        appliedAt: new Date().toISOString(),
        gitCommit: git.currentHead(),
      },
    });
    store.clearApplyPlan(plan.applyPlanId);
    store.record('apply_translation_updates', `${report.items.filter((item) => item.applied).length} applied`);

    return {
      applyPlanId: plan.applyPlanId,
      status: report.status,
      applied: report.items.filter((item) => item.applied).length,
      failed: report.items.filter((item) => !item.applied && item.errorCode !== 'ALREADY_APPLIED').length,
      skipped: report.items.filter((item) => item.errorCode === 'ALREADY_APPLIED' || item.errorCode?.startsWith('NO_')).length,
      files: report.files,
      items: report.items.map((item) => ({
        key: item.key,
        locale: item.locale,
        filePath: item.filePath,
        applied: item.applied,
        previousValue: item.previousValue,
        newValue: item.newValue,
        error: item.errorMessage ?? null,
      })),
      gitDiffStat: report.gitDiffStat,
      gitCommit: git.currentHead(),
      reportError,
      nextStep: reportError
        ? 'Files were written but the apply report could not reach the platform. Re-run report_apply_result once the API is reachable.'
        : 'Review the git diff, then commit yourself. Nothing was committed or pushed by LocaleHub.',
    };
  }

  /* ------------------------------------------- validate_localization_files */

  async validateLocalizationFiles(
    input: { file_set_ids?: string[]; check_placeholders?: boolean; check_duplicates?: boolean; check_missing?: boolean } = {},
  ): Promise<OperationResult> {
    const config = this.config().config;
    const guard = this.workspace();
    const scan = await scanWorkspace(guard, {
      projectId: config.project.id,
      sourceLocale: config.project.sourceLocale,
      fileSetIds: input.file_set_ids,
    });

    const issues: {
      code: string;
      severity: 'ERROR' | 'WARNING' | 'INFO';
      key?: string;
      locale?: string;
      filePath?: string;
      message: string;
    }[] = [
      ...scan.errors.map((error) => ({
        code: error.code,
        severity: 'ERROR' as const,
        filePath: error.file,
        message: error.message,
      })),
      ...scan.warnings.map((warning) => ({
        code: warning.code,
        severity: 'WARNING' as const,
        filePath: warning.file,
        message: warning.message,
      })),
    ];

    // missing translations + placeholder checks against the source locale
    const sourceLocale = config.project.sourceLocale;
    const byKey = new Map<string, Map<string, { value: string; filePath: string }>>();
    for (const entry of scan.entries) {
      const id = `${entry.platform}\u0001${entry.namespace}\u0001${entry.key}`;
      const map = byKey.get(id) ?? new Map();
      map.set(entry.locale, { value: entry.value, filePath: entry.filePath });
      byKey.set(id, map);
    }
    const locales = [...new Set(scan.entries.map((entry) => entry.locale))].filter((locale) => locale !== sourceLocale);

    for (const [id, localeMap] of byKey) {
      const source = localeMap.get(sourceLocale);
      if (!source) continue;
      const [, namespace, key] = id.split('\u0001');
      for (const locale of locales) {
        const target = localeMap.get(locale);
        if (!target) {
          if (input.check_missing !== false) {
            issues.push({
              code: 'MISSING_TRANSLATION',
              severity: 'WARNING',
              key,
              locale,
              message: `Key is missing for locale ${locale}${namespace ? ` (namespace ${namespace})` : ''}`,
            });
          }
          continue;
        }
        if (input.check_placeholders !== false) {
          const mismatch = comparePlaceholders(source.value, target.value);
          if (mismatch.missing.length || mismatch.added.length) {
            issues.push({
              code: 'PLACEHOLDER_MISMATCH',
              severity: 'ERROR',
              key,
              locale,
              filePath: target.filePath,
              message: `Placeholders differ from source (missing: ${mismatch.missing.join(', ') || '-'}; extra: ${mismatch.added.join(', ') || '-'})`,
            });
          }
        }
        if (target.value.trim() === '') {
          issues.push({
            code: 'EMPTY_TRANSLATION',
            severity: 'ERROR',
            key,
            locale,
            filePath: target.filePath,
            message: 'Translation is empty',
          });
        }
      }
    }

    return {
      filesScanned: scan.files.length,
      entriesChecked: scan.entries.length,
      locales,
      issueCount: issues.length,
      bySeverity: {
        ERROR: issues.filter((issue) => issue.severity === 'ERROR').length,
        WARNING: issues.filter((issue) => issue.severity === 'WARNING').length,
        INFO: issues.filter((issue) => issue.severity === 'INFO').length,
      },
      issues: issues.slice(0, 300),
    };
  }

  /* --------------------------------------------------------- get_sync_status */

  async getSyncStatus(input: { project_id?: string; include_conflicts?: boolean } = {}): Promise<OperationResult> {
    const projectId = this.projectId(input.project_id);
    const state = this.store().get();
    const git = this.git().info();
    let remote: unknown = null;
    let remoteError: string | null = null;
    let conflicts: ConflictRecord[] = [];
    try {
      remote = await this.client().syncStatus(projectId);
      if (input.include_conflicts !== false) {
        conflicts = await this.client().listConflicts({ projectId, status: 'OPEN' });
      }
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error);
    }
    return {
      local: {
        projectId: this.config().config.project.id,
        lastScanId: state.lastScanId,
        lastScanAt: state.lastScanAt,
        lastPreview: state.lastPreview,
        lastApplyReport: state.lastApplyReport,
        pendingApplyPlans: state.pendingApplyPlans.map((plan) => ({
          applyPlanId: plan.applyPlanId,
          expiresAt: plan.expiresAt,
          ready: plan.summary.ready,
        })),
        git: { branch: git.branch, commit: git.commit, dirty: git.dirty },
        history: state.history.slice(0, 10),
      },
      remote,
      remoteError,
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        key: conflict.key,
        locale: conflict.locale,
        platform: conflict.platform,
        reason: conflict.reason,
        base: conflict.baseValue,
        local: conflict.localValue,
        platformValue: conflict.remoteValue,
        status: conflict.status,
        createdAt: conflict.createdAt,
      })),
    };
  }

  /* ---------------------------------------------------- resolve_sync_conflict */

  async resolveSyncConflict(input: {
    conflict_id: string;
    resolution: ConflictResolution;
    value?: string;
    note?: string;
  }): Promise<OperationResult> {
    if (!input.resolution) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        'resolution is required (KEEP_LOCAL | KEEP_REMOTE | MANUAL_MERGE | DEFER)',
        422,
      );
    }
    if (input.resolution === 'MANUAL_MERGE' && typeof input.value !== 'string') {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'MANUAL_MERGE requires an explicit value', 422);
    }
    const resolved = await this.client().resolveConflict(input.conflict_id, {
      resolution: input.resolution,
      value: input.value,
      note: input.note,
    });
    this.store().record('resolve_sync_conflict', `${input.conflict_id} -> ${input.resolution}`);
    return {
      conflict: resolved,
      nextStep:
        input.resolution === 'DEFER'
          ? 'Conflict deferred; nothing changed on either side.'
          : 'Resolution recorded. Run preview_sync again to recompute the plan and baseline.',
    };
  }

  /* ------------------------------------------------------- report_apply_result */

  async reportApplyResult(input: { apply_plan_id: string; git_commit?: string | null; note?: string }): Promise<OperationResult> {
    const state = this.store().get();
    const lastReport = state.lastApplyReport;
    const sessionId = state.lastPreview?.sessionId;
    if (!sessionId) {
      throw new LocaleHubError(
        ErrorCode.SYNC_SESSION_NOT_FOUND,
        'No sync session recorded locally. Run preview_sync first.',
        404,
      );
    }
    if (!lastReport || lastReport.applyPlanId !== input.apply_plan_id) {
      throw new LocaleHubError(
        ErrorCode.NOT_FOUND,
        `No local record of apply plan ${input.apply_plan_id}. Use apply_translation_updates, which reports automatically.`,
        404,
      );
    }
    const response = await this.client().reportApply({
      syncSessionId: sessionId,
      applyPlanId: input.apply_plan_id,
      client: this.clientInfo(),
      status: lastReport.status,
      files: lastReport.files.map((file) => ({ filePath: file, backupPath: null, contentHash: contentHash(file) })),
      items: [],
      gitCommit: input.git_commit ?? lastReport.gitCommit ?? null,
      gitDiffStat: null,
    });
    this.store().record('report_apply_result', input.apply_plan_id);
    return { reported: true, ...response, note: input.note ?? null };
  }

  /* ----------------------------------------------------------- create_git_patch */

  createGitPatch(input: { apply_plan_id?: string; output_path?: string; include_untracked?: boolean } = {}): OperationResult {
    const git = this.git();
    if (!git.isRepository()) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        'The workspace is not a git repository, so no patch can be produced.',
        400,
      );
    }
    const diff = git.diff();
    const stat = git.diffStat();
    const store = this.store();
    const outputPath = input.output_path ?? join(store.artifactDir('patches'), `localehub-${Date.now()}.patch`);
    writeFileSync(outputPath, `${diff}\n`, 'utf8');
    store.record('create_git_patch', outputPath);
    return {
      patchPath: outputPath,
      diffStat: stat,
      committed: false,
      pushed: false,
      filesChanged: git.info().changedFiles,
      note:
        input.include_untracked === false
          ? 'Untracked files are not included in `git diff`.'
          : 'Patch written but nothing committed or pushed.',
    };
  }

  /* ----------------------------------------------------------------- helpers */

  readStateFile(): string {
    return readFileSync(this.store().get() ? join(this.workspace().root, '.localehub', 'state.json') : '/dev/null', 'utf8');
  }
}

/** Stable id for a platform change, matching the convention used by preview_apply. */
export function changeKeyId(change: PlatformChange): string {
  return `chg_${contentHash(`${change.platform}\u0001${change.namespace}\u0001${change.key}\u0001${change.locale}`).slice(0, 16)}`;
}
