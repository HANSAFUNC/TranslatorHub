import { stringify as toYaml } from 'yaml';
import { DEFAULT_MCP_SCOPES, type PlatformName } from '@localehub/contracts';
import { arbTagForLocale } from '@localehub/format-adapters';

/**
 * The `.localehub/config.yaml` template.
 *
 * Shared by `localehub init` and the MCP bootstrap tool, because both leave the same file behind
 * and a second copy of this shape is how the two would disagree about what a valid workspace
 * looks like. The workspace package owns it because it owns the config format.
 */

export interface LocalConfigTemplateInput {
  projectId: string;
  projectName?: string;
  sourceLocale: string;
  /** Target locales; the source is added automatically and duplicates are dropped. */
  locales: string[];
  platforms?: PlatformName[];
  apiUrl: string;
  tokenEnv?: string;
  /**
   * Where the language files live. Defaults match the layout most repositories use, and the
   * caller can narrow them; `allowWrite` follows the same paths, because a mapping that cannot be
   * written back is a mapping that can never be applied.
   */
  localesDir?: string;
  /**
   * Which repository layout to describe.
   *
   * `web` (the default) is the JSON tree `locales/<locale>/…`; `flutter` is gen-l10n's flat
   * `lib/l10n/<template>_<locale>.arb`, with flat keys (ARB keys are identifiers, never paths) and
   * no namespace from the path — a Flutter app's keys are one global set.
   */
  preset?: 'web' | 'flutter';
  /** Flutter only: the `<template>` in `<template>_<locale>.arb`. Defaults to `app`. */
  flutterTemplate?: string;
}

export interface LocalConfigTemplateResult {
  /** The YAML text, ready to write to `.localehub/config.yaml`. */
  yaml: string;
  /** The mapping ids, so a caller can describe what it produced. */
  fileSetIds: string[];
}

export function renderLocalConfig(input: LocalConfigTemplateInput): LocalConfigTemplateResult {
  const sourceLocale = input.sourceLocale;
  const targets = [...new Set(input.locales.filter((locale) => locale && locale !== sourceLocale))];
  const platforms = [...new Set(input.platforms ?? ['web'])];
  const flutter = input.preset === 'flutter';
  const dir = input.localesDir ?? (flutter ? 'lib/l10n' : 'locales');
  const extension = flutter ? 'arb' : 'json';
  // gen-l10n names the files `<template>_<locale>.arb`, and the locale is spelled with underscores
  // there (`app_zh_CN.arb`) while every locale tag the platform accepts uses dashes.
  const template = input.flutterTemplate ?? 'app';
  const nameFor = (locale: string) => (flutter ? `${template}_${arbTagForLocale(locale)}.arb` : null);

  const files = [
    {
      id: `${platforms[0]}-source`,
      platform: platforms[0],
      locale: sourceLocale,
      format: extension,
      source: true,
      paths: [flutter ? `${dir}/` + nameFor(sourceLocale) : `${dir}/${sourceLocale}/**/*.${extension}`],
      keyMode: flutter ? 'flat' : 'nested',
      namespaceFromPath: !flutter,
    },
    ...targets.map((locale) => ({
      id: `${platforms[0]}-${locale.toLowerCase()}`,
      platform: platforms[0],
      locale,
      format: extension,
      source: false,
      paths: [flutter ? `${dir}/` + nameFor(locale) : `${dir}/${locale}/**/*.${extension}`],
      keyMode: flutter ? 'flat' : 'nested',
      namespaceFromPath: !flutter,
    })),
  ];

  const config = {
    version: 1,
    project: {
      id: input.projectId,
      ...(input.projectName ? { name: input.projectName } : {}),
      sourceLocale,
      platforms,
    },
    localehub: {
      apiUrl: input.apiUrl,
      // A variable reference, never a literal: this file is committed.
      tokenEnv: input.tokenEnv ?? 'LOCALEHUB_TOKEN',
    },
    workspace: {
      root: '.',
      allowRead: ['src/**', 'app/**', `${dir}/**`],
      // Write access is limited to the language resources. Everything else in the repository stays
      // out of reach of the sync engine, which is the whole point of the allowlist.
      allowWrite: [`${dir}/**`],
      denyRead: ['.env*', '**/secrets/**', 'node_modules/**'],
      // `lib/l10n/generated/` is gen-l10n's output: source code, not a language resource, so it is
      // denied for writing and ignored for scanning in the Flutter preset.
      denyWrite: ['.env*', '**/secrets/**', '**/*.generated.*', ...(flutter ? [`${dir}/generated/**`] : [])],
    },
    sync: {
      defaultDirection: 'bidirectional',
      deletePolicy: 'archive',
      applyPolicy: 'approved_only',
      conflictPolicy: 'manual',
      // Writes stay off until somebody asks for them, even on a freshly initialised repository.
      writeMode: 'dry_run_by_default',
      preserveUnknownFields: true,
      createBackup: true,
      maxFilesPerBatch: 500,
    },
    files,
    ignore: { keys: ['debug.*'], paths: ['**/*.generated.*', ...(flutter ? [`${dir}/generated/**`] : [])] },
  };

  return {
    yaml: `# LocaleHub repository configuration — see docs/MCP.md\n${toYaml(config)}`,
    fileSetIds: files.map((file) => file.id),
  };
}

/**
 * The scopes a repository needs for the flow the config describes.
 *
 * Exported so the bootstrap tool can tell the caller which token to sign instead of leaving them
 * to guess from a list of twelve.
 */
export function recommendedScopes(): string[] {
  return [...DEFAULT_MCP_SCOPES];
}
