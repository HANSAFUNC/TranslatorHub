#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnvFiles } from '@localehub/config';
import type { PlatformName } from '@localehub/contracts';
import { LocalSyncServices, captureAndroidScreen, systemDeviceRunner } from '@localehub/local-sync';
import { loadLocalConfig, renderLocalConfig } from '@localehub/workspace';
import { flagBool, parseArgs } from './args';

/**
 * LocaleHub CLI.
 *
 * The CLI is a thin shell over the same engine the e2e suites drive, so a CI job and an
 * interactive agent cannot drift apart (spec §14: `localehub scan`, `sync preview`, `qa`,
 * `release validate`).
 */

const HELP = `localehub <command>

  init [--project <id>] [--api <url>] [--source-locale en-US] [--locales ja-JP,zh-CN]
       [--preset web|flutter] [--platform web,ios] [--locales-dir <dir>]
       [--flutter-template app]
      Create .localehub/config.yaml in the current repository.
      --preset flutter describes a Flutter app: gen-l10n's flat lib/l10n/app_<locale>.arb,
      flat keys, and lib/l10n/generated/ kept out of reach.

  info
      Print project, workspace policy, git state and configuration validation.

  scan [--file-set <id>]...
      Scan configured localization files and upload the normalized entries.

  sync preview [--direction bidirectional|push|pull] [--include-deletes]
      Three-way comparison; prints the change plan. Nothing is written.

  sync push --confirm [--idempotency-key <key>]
      Push the current preview plan to the platform.

  pull [--locale ja-JP] [--include-drafts]
      List approved platform changes (read only).

  apply preview
      Build the write-back plan (dry run) and print the per-file diff.
  apply --confirm [--apply-plan <id>] [--require-clean-worktree]
      Write approved translations into the repository (backup + atomic write).

  conflicts [--resolve <id> --as keep-local|keep-remote|manual|defer --value <text>]
      List open sync conflicts or resolve one.

  qa [--locale ja-JP]
      Local validation: format, placeholders, duplicates, missing translations.

  status
      Local state + remote sync status + open conflicts.

  mockup check <file> [--platform web] [--name <screen>]
      Run the platform's own S1-S10 rules over a page **without writing or uploading anything**, and
      exit non-zero if any of them is a warning. This is the same analyzer the platform runs, so a page
      that passes here passes there -- "本地过、平台不过" is what this closes.

  mockup --page <file> [--name <screen>] [--platform web] [--locale zh-CN]
         [--namespace <ns>] [--keys <json-file>] [--css <file>] [--accent <color>]
         [--background <color>] [--width <px>] [--height <px>] [--document] [--confirm]
      Make a screen out of a page, and with --confirm upload it so translators see it next to the
      translations.

      A whole page (.html with a doctype or <html>) is *kept*: the markup is stored with its assets
      inlined and the editor renders it in a sandboxed frame, so the picture is the page itself and
      not a redrawing of it. Scripts travel but never run — dynamic data is simply absent.

      A fragment (a component file, a snippet) is *redrawn*: the platform lays it out and draws a
      sketch, with every string becoming a marker at the position the layout gives it. Use --document
      to force the replica path for a page whose doctype was stripped.

      Either way the output goes to .localehub/mockups/ and nothing is uploaded without --confirm.

  mockup capture --name <screen> [--platform android] [--locale zh-CN]
         [--namespace <ns>] [--serial <adb-serial>] [--keys <json-file>]
         [--include-system-ui] [--confirm]
      Capture the screen that is running on an attached Android device: screencap for the pixels and
      uiautomator dump for where every element is, from the same moment. The picture is the app, and a
      marker lands on the element it names by construction — nothing is transcribed, so nothing can be
      transcribed wrong.

      This is the answer for an app that only exists as an installed APK: rebuild it as HTML by hand and
      the layout drifts (19 of 29 screens in one measured project were laid out past the phone's frame);
      capture it and the layout cannot drift. Keys come from the platform's own translations for the
      captured locale, matched by the text on screen; --keys overrides that with a
      {"text or resource-id": "key"} file, and anything unresolved is reported, not guessed.

      With several devices attached, --serial picks one. The screen is left as it was found.

  patch
      Write a git patch of the current working tree (never commits).

  mcp-config [--remote <url>]
      Print the .mcp.json snippet for Claude Code / Cursor / Codex.
      Without --remote, the platform is asked for its own externally reachable MCP URL.

Exit codes: 0 ok, 1 error, 2 usage error, 3 conflicts or blocked applies.
`;

async function main(): Promise<void> {
  loadEnvFiles(process.cwd());
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const { command, flags, positionals } = parseArgs(argv);
  const [group, action] = command;
  const workspace = resolve((flags.workspace as string | undefined) ?? process.env.LOCALEHUB_WORKSPACE ?? process.cwd());
  const json = flagBool(flags, 'json');

  const output = (payload: unknown, summary?: string) => {
    if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else if (summary) process.stdout.write(`${summary}\n`);
    else process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  };

  if (group === 'init') {
    return init(workspace, flags);
  }

  const services = new LocalSyncServices({ cwd: workspace, env: process.env });

  switch (group) {
    case 'info':
      return output(await services.getLocalProjectInfo());
    case 'scan': {
      const fileSetIds = collectFlags(flags, 'file-set');
      const result = await services.scanLocalProject(fileSetIds.length ? { file_set_ids: fileSetIds } : {});
      if (json) return output(result);
      process.stdout.write(
        `scanned ${result.filesScanned} file(s), ${result.entriesFound} entr(ies), locales: ${(result.locales as string[]).join(', ')}\n`,
      );
      // Whether the scan reached the platform, said out loud.
      //
      // This used to be silent: the summary line printed the local count either way, so a scan the
      // API refused (a body over the transport limit, an expired token) read exactly like one it
      // accepted — and the next command failed with "No scan available". The upload result is the
      // one thing a caller cannot infer from the numbers above it.
      if (result.uploaded !== true) {
        process.stdout.write(
          `上传失败：${result.uploadError ?? '平台没有接受这次扫描'}\n` +
            '  扫描结果只在本地；修好原因后重跑 localehub scan，再 preview / apply。\n',
        );
      } else if ((result.expanded as string[]).length) {
        // The platform grows the project to match the repository. Saying so is what keeps a first
        // push from silently adding a language nobody expected.
        process.stdout.write(`平台补充了：${(result.expanded as string[]).join('、')}\n`);
      }
      if ((result.errors as unknown[]).length) process.stdout.write(`errors: ${JSON.stringify(result.errors)}\n`);
      // Print the warnings themselves, not just how many there were: when a scan matches no files
      // they are the only thing that explains why.
      if ((result.warnings as unknown[]).length) process.stdout.write(`warnings: ${JSON.stringify(result.warnings)}\n`);
      if (result.filesScanned === 0) {
        process.stdout.write(
          'no files matched. Check the `files[].paths` globs in .localehub/config.yaml against this ' +
            'repository layout (run `localehub info` to see the mappings as parsed).\n',
        );
      }
      return;
    }
    case 'sync': {
      if (action === 'preview') {
        const result = await services.previewSync({
          direction: (flags.direction as 'bidirectional' | 'push' | 'pull' | undefined) ?? 'bidirectional',
          include_deletes: flagBool(flags, 'include-deletes'),
        });
        if (json) return output(result);
        printPlan(result);
        return;
      }
      if (action === 'push') {
        const result = await services.pushProjectChanges({
          sync_plan_id: flags['plan'] as string | undefined,
          confirm: flagBool(flags, 'confirm'),
          idempotency_key: flags['idempotency-key'] as string | undefined,
          include_deletes: flagBool(flags, 'include-deletes'),
        });
        if (json) return output(result);
        if (result.requiresConfirmation) {
          process.stdout.write('Refused: pass --confirm to push the previewed plan.\n');
          process.exitCode = 2;
          return;
        }
        process.stdout.write(`push ${result.status}: ${JSON.stringify(result.summary)}\n`);
        if ((result.conflicts as unknown[]).length) process.exitCode = 3;
        return;
      }
      process.stderr.write(`unknown sync action: ${action ?? ''}\n`);
      process.exitCode = 2;
      return;
    }
    case 'mockup': {
      if (positionals[0] === 'capture') {
        const name = flags.name as string | undefined;
        if (!name) {
          process.stderr.write('mockup capture requires --name <screen> (the screen this is, e.g. 首页)\n');
          process.exitCode = 2;
          return;
        }
        // The device is read here, at the edge, and the rest of the operation is pure: the service
        // takes bytes and a dump, which is also what lets it be tested without a phone attached.
        const captured = captureAndroidScreen(systemDeviceRunner(), {
          ...(flags.serial ? { serial: flags.serial as string } : {}),
        });
        let keys: Record<string, string> | undefined;
        if (flags.keys) {
          keys = JSON.parse(readFileSync(resolve(workspace, flags.keys as string), 'utf8')) as Record<string, string>;
        }
        const result = await services.captureScreenMockup({
          name,
          image: captured.image,
          dumpXml: captured.dumpXml,
          device: captured.device as unknown as Record<string, unknown>,
          ...(flags.platform ? { platform: flags.platform as string } : {}),
          ...(flags.locale ? { locale: flags.locale as string } : {}),
          ...(flags.namespace ? { namespace: flags.namespace as string } : {}),
          ...(keys ? { keys } : {}),
          includeSystemUi: flagBool(flags, 'include-system-ui'),
          confirm: flagBool(flags, 'confirm'),
          replace: flags.replace === undefined ? undefined : flagBool(flags, 'replace'),
        });
        if (json) return output(result);
        process.stdout.write(
          `${result.name} · ${result.platform} · ${result.locale} · 真机截图 ${(result.canvas as { width: number }).width}×${(result.canvas as { height: number }).height}\n`,
        );
        process.stdout.write(
          `  ${result.nodes} 个节点 → ${result.markers} 个标记（${result.markersResolved} 个对上了 key）\n`,
        );
        process.stdout.write(`  截图：${result.imagePath}\n`);
        for (const warning of result.warnings as string[]) process.stdout.write(`  ⚠ ${warning}\n`);
        process.stdout.write(`${result.message}\n`);
        return;
      }
      if (positionals[0] === 'check') {
        const target = positionals[1];
        if (!target) {
          process.stderr.write('mockup check requires a file: localehub mockup check <file>\n');
          process.exitCode = 2;
          return;
        }
        const checked = await services.checkScreenMockup({
          page: target,
          ...(flags.platform ? { platform: flags.platform as string } : {}),
          ...(flags.name ? { name: flags.name as string } : {}),
          ...(flags.namespace ? { namespace: flags.namespace as string } : {}),
        });
        process.stdout.write(`${String(checked.message ?? '')}\n`);
        if (!json) process.stdout.write(`${checked.passed === true ? 'PASS' : 'FAIL'}\n`);
        // A warning is something to fix before uploading, so the shell can gate on it.
        if (checked.passed !== true) process.exitCode = 1;
        return;
      }
      const page = (flags.page as string | undefined) ?? positionals[0];
      if (!page) {
        process.stderr.write('mockup requires --page <file> (a page component or an .html file)\n');
        process.exitCode = 2;
        return;
      }
      const cssFile = flags.css as string | undefined;
      const accent = flags.accent as string | undefined;
      const background = flags.background as string | undefined;
      const keysFile = flags.keys as string | undefined;
      let keys: Record<string, string> | undefined;
      if (keysFile) {
        const raw = readFileSync(resolve(workspace, keysFile), 'utf8');
        keys = JSON.parse(raw) as Record<string, string>;
      }
      const result = await services.generateScreenMockup({
        page,
        ...(cssFile ? { cssFile } : {}),
        ...(accent || background ? { theme: { ...(accent ? { accent } : {}), ...(background ? { background } : {}) } } : {}),
        name: flags.name as string | undefined,
        platform: flags.platform as string | undefined,
        locale: flags.locale as string | undefined,
        namespace: flags.namespace as string | undefined,
        keys,
        width: flags.width ? Number(flags.width) : undefined,
        height: flags.height ? Number(flags.height) : undefined,
        // A whole page is detected from the file itself; this forces the replica path for a page
        // whose doctype was stripped on the way into the repository.
        document: flags.document === undefined ? undefined : flagBool(flags, 'document'),
        confirm: flagBool(flags, 'confirm'),
        replace: flags.replace === undefined ? undefined : flagBool(flags, 'replace'),
      });
      if (json) return output(result);
      if (result.kind === 'document') {
        process.stdout.write(
          `${result.name} · ${result.platform} · ${result.locale} · 整页复刻（浏览器渲染，脚本不执行）\n`,
        );
      } else {
        process.stdout.write(
          `${result.name} · ${result.platform} · ${result.locale} · ${(result.canvas as {width:number}).width}×${(result.canvas as {height:number}).height}\n`,
        );
      }
      process.stdout.write(`  ${result.strings} 个字符串 → ${result.markers} 个标记\n`);
      for (const key of result.keys as string[]) process.stdout.write(`    ${key}\n`);
      process.stdout.write(`  UI 页面：${result.svgPath}\n`);
      for (const warning of result.warnings as string[]) process.stdout.write(`  ⚠ ${warning}\n`);
      process.stdout.write(`${result.message}\n`);
      return;
    }
    case 'pull': {
      const result = await services.pullPlatformUpdates({
        locales: collectFlags(flags, 'locale'),
        include_drafts: flagBool(flags, 'include-drafts'),
      });
      if (json) return output(result);
      process.stdout.write(`${result.count} change(s) at revision ${result.revision}\n`);
      for (const change of result.changes as { key: string; locale: string; current: string; reviewStatus: string }[]) {
        process.stdout.write(`  ${change.locale} ${change.key} [${change.reviewStatus}] → ${change.current}\n`);
      }
      return;
    }
    case 'apply': {
      // Which of the two things `apply` means here.
      //
      // Bare `apply` and `apply preview` are the dry run. Asking to write is `--confirm` — the form
      // the help documents — or an explicit `write` action. Branching on the positional alone made
      // `apply --confirm --apply-plan <id>` fall through to the preview: it printed the diff, exited
      // 0, and wrote nothing, which is a success report for a repository that did not change.
      const wantsWrite =
        action !== 'preview' && (action === 'write' || flagBool(flags, 'confirm') || flags['apply-plan'] !== undefined);
      if (!wantsWrite) {
        const result = await services.previewApply({
          create_backup: !flagBool(flags, 'no-backup'),
          include_drafts: flagBool(flags, 'include-drafts'),
        });
        if (json) return output(result);
        const summary = result.summary as { ready: number; blocked: number; total: number };
        process.stdout.write(`apply plan ${result.applyPlanId}: ${summary.ready} ready / ${summary.blocked} blocked\n`);
        for (const change of result.changes as {
          filePath: string;
          key: string;
          locale: string;
          status: string;
          previousValue: string | null;
          newValue: string;
        }[]) {
          process.stdout.write(`  [${change.status}] ${change.filePath} ${change.locale} ${change.key}\n`);
          process.stdout.write(`      - ${change.previousValue ?? '(absent)'}\n      + ${change.newValue}\n`);
        }
        if (summary.blocked > 0) process.exitCode = 3;
        return;
      }
      const applyPlanId = (flags['apply-plan'] as string | undefined) ?? undefined;
      if (!applyPlanId) {
        process.stderr.write('apply --confirm requires --apply-plan <id> (from `localehub apply preview`)\n');
        process.exitCode = 2;
        return;
      }
      const result = await services.applyTranslationUpdates({
        apply_plan_id: applyPlanId,
        confirm: flagBool(flags, 'confirm'),
        require_clean_worktree: flagBool(flags, 'require-clean-worktree'),
        create_backup: !flagBool(flags, 'no-backup'),
      });
      if (json) return output(result);
      if (result.requiresConfirmation) {
        process.stdout.write('Refused: pass --confirm to write the previewed changes.\n');
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`apply ${result.status}: ${result.applied} applied, ${result.failed} failed\n`);
      process.stdout.write(`${result.gitDiffStat ?? ''}\n`);
      if ((result.failed as number) > 0) process.exitCode = 3;
      return;
    }
    case 'conflicts': {
      if (flags.resolve) {
        const as = (flags.as as string | undefined) ?? '';
        const map: Record<string, string> = {
          'keep-local': 'KEEP_LOCAL',
          'keep-remote': 'KEEP_REMOTE',
          manual: 'MANUAL_MERGE',
          defer: 'DEFER',
        };
        const resolution = map[as];
        if (!resolution) {
          process.stderr.write('--as must be one of keep-local | keep-remote | manual | defer\n');
          process.exitCode = 2;
          return;
        }
        const result = await services.resolveSyncConflict({
          conflict_id: flags.resolve as string,
          resolution: resolution as never,
          value: flags.value as string | undefined,
        });
        return output(result);
      }
      const status = await services.getSyncStatus({});
      if (json) return output(status);
      const conflicts = status.conflicts as { id: string; key: string; locale: string; reason: string }[];
      if (!conflicts.length) {
        process.stdout.write('no open conflicts\n');
        return;
      }
      for (const conflict of conflicts) {
        process.stdout.write(`  ${conflict.id} ${conflict.locale} ${conflict.key} (${conflict.reason})\n`);
      }
      return;
    }
    case 'qa': {
      const result = await services.validateLocalizationFiles({ file_set_ids: collectFlags(flags, 'file-set') });
      if (json) return output(result);
      process.stdout.write(
        `QA: ${result.issueCount} issue(s) over ${result.entriesChecked} entries — ${JSON.stringify(result.bySeverity)}\n`,
      );
      for (const issue of (result.issues as { severity: string; key?: string; locale?: string; message: string }[]).slice(
        0,
        50,
      )) {
        process.stdout.write(`  [${issue.severity}] ${issue.locale ?? ''} ${issue.key ?? ''} ${issue.message}\n`);
      }
      if ((result.bySeverity as { ERROR: number }).ERROR > 0) process.exitCode = 3;
      return;
    }
    case 'status':
      return output(await services.getSyncStatus({}));
    case 'patch':
      return output(services.createGitPatch({ output_path: flags.output as string | undefined }));
    case 'mcp-config': {
      const loaded = loadLocalConfig(workspace);
      const { mcpClientConfig, formatMcpClientConfig } = await import('@localehub/contracts');

      // The address a client must dial is a deployment fact this checkout cannot derive — behind
      // nginx it is the public host, in development it is :3003. The platform reports its own, so
      // asking it beats making every developer look the value up. `GET /mcp/tools` is public and
      // carries no secrets, so this needs no token.
      let url = typeof flags.remote === 'string' ? flags.remote : null;
      if (!url) {
        const apiUrl = (loaded.config.localehub.apiUrl || '').replace(/\/api\/v1\/?$/, '');
        try {
          const response = await fetch(`${apiUrl}/api/v1/mcp/tools`, { signal: AbortSignal.timeout(5_000) });
          const payload = (await response.json()) as { data?: { remoteUrl?: string; remoteUrlWarning?: string } };
          url = payload.data?.remoteUrl ?? null;
          // Printed, not swallowed: the whole problem is an address that looks fine on the machine
          // that printed it and fails on every other one.
          if (payload.data?.remoteUrlWarning) process.stderr.write(`warning: ${payload.data.remoteUrlWarning}\n`);
        } catch {
          url = null;
        }
      }
      if (!url) {
        process.stderr.write(
          `Could not determine the platform's MCP URL from ${loaded.config.localehub.apiUrl}.\n` +
            'Pass it explicitly: localehub mcp-config --remote https://localehub.example/mcp\n',
        );
        process.exitCode = 2;
        return;
      }

      process.stdout.write(formatMcpClientConfig(mcpClientConfig({ remote: { url, tokenEnv: loaded.tokenEnv } })));
      return;
    }
    case 'release': {
      if (action !== 'validate') {
        process.stderr.write('usage: localehub release validate\n');
        process.exitCode = 2;
        return;
      }
      const [{ ApiClient }, config] = [await import('@localehub/api-client'), loadLocalConfig(workspace)];
      const client = new ApiClient({
        baseUrl: config.config.localehub.apiUrl,
        token: process.env[config.tokenEnv] ?? '',
      });
      const result = await client.validateRelease(config.config.project.id);
      output(result);
      if (!result.ok) process.exitCode = 3;
      return;
    }
    default:
      process.stderr.write(`unknown command: ${group}\n\n${HELP}`);
      process.exitCode = 2;
  }

  void positionals;
}

function printPlan(result: Record<string, unknown>): void {
  const summary = result.summary as Record<string, number>;
  process.stdout.write(
    `plan ${result.syncPlanId} (expires ${result.expiresAt})\n` +
      `  push_new=${summary.pushNew} push_updated=${summary.pushUpdated} pull_approved=${summary.pullApproved} ` +
      `pull_draft=${summary.pullDraft} unchanged=${summary.unchanged} conflicts=${summary.conflicts} archive=${summary.archiveCandidates}\n`,
  );
  for (const change of (result.changes as { action: string; locale: string; key: string; filePath: string | null }[]) ?? []) {
    if (change.action === 'SKIP') continue;
    process.stdout.write(
      `  [${change.action}] ${change.locale} ${change.key}${change.filePath ? ` (${change.filePath})` : ''}\n`,
    );
  }
}

function collectFlags(flags: Record<string, string | boolean>, key: string): string[] {
  const value = flags[key];
  if (value === undefined || value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function init(workspace: string, flags: Record<string, string | boolean>): void {
  const configPath = join(workspace, '.localehub', 'config.yaml');
  if (existsSync(configPath)) {
    process.stderr.write(`${configPath} already exists; refusing to overwrite.\n`);
    process.exitCode = 1;
    return;
  }
  const projectId = (flags.project as string | undefined) ?? 'prj_replace_me';
  const apiUrl = (flags.api as string | undefined) ?? 'http://localhost:3001/api/v1';
  const sourceLocale = (flags['source-locale'] as string | undefined) ?? 'en-US';
  const locales = String(flags.locales ?? 'ja-JP')
    .split(',')
    .map((locale) => locale.trim())
    .filter(Boolean);
  const preset = flags.preset === 'flutter' ? 'flutter' : 'web';
  const platforms = flags.platform
    ? String(flags.platform)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : [preset === 'flutter' ? 'universal' : 'web'];

  // The same template the Remote MCP's `create_project` returns, so a repository initialised here
  // and one initialised by an agent produce the same file.
  const { yaml } = renderLocalConfig({
    projectId,
    projectName: (flags.name as string | undefined) ?? 'My Product',
    sourceLocale,
    locales,
    platforms: platforms as PlatformName[],
    preset,
    apiUrl,
    ...(flags['locales-dir'] ? { localesDir: flags['locales-dir'] as string } : {}),
    ...(flags['flutter-template'] ? { flutterTemplate: flags['flutter-template'] as string } : {}),
  });

  mkdirSync(join(workspace, '.localehub'), { recursive: true });
  writeFileSync(configPath, yaml, 'utf8');
  const flutterHint =
    preset === 'flutter'
      ? `\n  Flutter: the ARB files live at ${(flags['locales-dir'] as string | undefined) ?? 'lib/l10n'}/, and \`flutter gen-l10n\` reads them; lib/l10n/generated/ is written by gen-l10n, not by us.\n`
      : '';
  process.stdout.write(
    `wrote ${configPath}${flutterHint}\nNext steps:\n  1. put your project id in project.id\n  2. export ${'LOCALEHUB_TOKEN'}=...\n  3. localehub info && localehub scan\n  4. localehub sync preview\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
