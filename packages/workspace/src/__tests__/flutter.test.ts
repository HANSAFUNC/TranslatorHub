import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localConfigSchema, type LocalConfig } from '@localehub/contracts';
import { parse as parseYaml } from 'yaml';
import { renderLocalConfig } from '../config-template';
import { WorkspaceGuard } from '../index';
import { scanWorkspace } from '../scanner';

/**
 * Flutter.
 *
 * A Flutter app keeps its languages in `lib/l10n/app_<locale>.arb`, one flat file per locale, with
 * the locale spelled with underscores (`app_zh_CN.arb`) — and `flutter gen-l10n` writing a whole
 * directory of Dart beside them. Each of those is a thing the generic `locales/<locale>/*.json`
 * template gets wrong, which is what this preset is for.
 */

let root: string;

const EN = `{
  "@@locale": "en",
  "appTitle": "InsureTalk",
  "@appTitle": {
    "description": "App title (brand name, same everywhere)"
  },
  "unknownRouteBody": "Unregistered route: {route}",
  "@unknownRouteBody": {
    "description": "Body of the unknown-route page",
    "placeholders": {
      "route": {
        "type": "String"
      }
    }
  }
}
`;

const ZH = `{
  "@@locale": "zh_CN",
  "appTitle": "安谈",
  "@appTitle": {
    "description": "App title (brand name, same everywhere)"
  },
  "unknownRouteBody": "未注册的路由：{route}",
  "@unknownRouteBody": {
    "description": "Body of the unknown-route page",
    "placeholders": {
      "route": {
        "type": "String"
      }
    }
  }
}
`;

const TH = `{
  "@@locale": "th",
  "appTitle": "InsureTalk",
  "@appTitle": {
    "description": "App title (brand name, same everywhere)"
  },
  "unknownRouteBody": "เส้นทางที่ยังไม่ลงทะเบียน: {route}",
  "@unknownRouteBody": {
    "description": "Body of the unknown-route page",
    "placeholders": {
      "route": {
        "type": "String"
      }
    }
  }
}
`;

const config = (overrides: Partial<LocalConfig> = {}): LocalConfig => {
  const { yaml } = renderLocalConfig({
    projectId: 'prj_flutter',
    projectName: 'InsureTalk',
    sourceLocale: 'en',
    locales: ['zh', 'zh-CN', 'zh-TW', 'th'],
    platforms: ['universal'],
    apiUrl: 'https://localehub.example.com/api/v1',
    preset: 'flutter',
  });
  return localConfigSchema.parse({ ...(parseYaml(yaml) as object), ...overrides });
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'localehub-flutter-'));
  mkdirSync(join(root, 'lib/l10n/generated'), { recursive: true });
  writeFileSync(join(root, 'lib/l10n/app_en.arb'), EN);
  writeFileSync(join(root, 'lib/l10n/app_zh_CN.arb'), ZH);
  writeFileSync(join(root, 'lib/l10n/app_zh.arb'), ZH);
  writeFileSync(join(root, 'lib/l10n/app_zh_TW.arb'), ZH);
  writeFileSync(join(root, 'lib/l10n/app_th.arb'), TH);
  // gen-l10n's output: source code that must never be treated as a language resource.
  writeFileSync(join(root, 'lib/l10n/generated/app_localizations.dart'), '// generated\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the Flutter preset', () => {
  it('describes gen-l10n’s layout, with the underscores it spells locales with', () => {
    const parsed = config();
    expect(parsed.files.map((file) => file.paths[0])).toEqual([
      'lib/l10n/app_en.arb',
      'lib/l10n/app_zh.arb',
      'lib/l10n/app_zh_CN.arb',
      'lib/l10n/app_zh_TW.arb',
      'lib/l10n/app_th.arb',
    ]);
    // Flat keys (ARB keys are identifiers), and no namespace invented from the directory: a Flutter
    // app has one global key set.
    expect(parsed.files.every((file) => file.format === 'arb')).toBe(true);
    expect(parsed.files.every((file) => file.keyMode === 'flat')).toBe(true);
    expect(parsed.files.every((file) => file.namespaceFromPath === false)).toBe(true);
    expect(parsed.files.filter((file) => file.source).map((file) => file.locale)).toEqual(['en']);
  });

  it('keeps gen-l10n’s generated directory out of reach', () => {
    const parsed = config();
    expect(parsed.workspace.allowWrite).toEqual(['lib/l10n/**']);
    expect(parsed.workspace.denyWrite).toContain('lib/l10n/generated/**');
    expect(parsed.ignore.paths).toContain('lib/l10n/generated/**');
    // The generated Dart is not a translation file, and reading it is not the point of the mapping.
    expect(parsed.files.every((file) => !file.paths.some((path) => path.includes('generated')))).toBe(true);
  });

  it('names the files the way the template does when the project renames it', () => {
    const { yaml } = renderLocalConfig({
      projectId: 'prj_flutter',
      sourceLocale: 'en',
      locales: ['zh-CN'],
      apiUrl: 'https://localehub.example.com/api/v1',
      preset: 'flutter',
      flutterTemplate: 'intl',
    });
    const parsed = localConfigSchema.parse(parseYaml(yaml));
    expect(parsed.files.map((file) => file.paths[0])).toEqual(['lib/l10n/intl_en.arb', 'lib/l10n/intl_zh_CN.arb']);
  });

  it('scans the real files: flat keys, metadata carried, the locale from the file name', async () => {
    const guard = new WorkspaceGuard(config(), root);
    const result = await scanWorkspace(guard, { projectId: 'prj_flutter', sourceLocale: 'en' });

    expect(result.locales.sort()).toEqual(['en', 'th', 'zh', 'zh-CN', 'zh-TW']);
    // `lib/l10n/generated/app_localizations.dart` is not a language resource and is not scanned.
    expect(result.files.map((file) => file.filePath)).not.toContain('lib/l10n/generated/app_localizations.dart');
    expect(result.errors).toEqual([]);

    const zh = result.entries.find((entry) => entry.locale === 'zh-CN' && entry.key === 'unknownRouteBody');
    expect(zh?.namespace).toBe('');
    expect(zh?.value).toBe('未注册的路由：{route}');
    expect(zh?.description).toBe('Body of the unknown-route page');
    expect(zh?.placeholders).toEqual([{ name: 'route', type: 'String' }]);

    const en = result.entries.find((entry) => entry.locale === 'en' && entry.key === 'appTitle');
    expect(en?.isSource).toBe(true);
    // `@@locale` and the `@…` metadata blocks are not entries.
    expect(result.entries.filter((entry) => entry.key.startsWith('@'))).toEqual([]);
  });

  it('derives the locale from the file name when the mapping does not name one', async () => {
    // `locale: '*'` is how a repository says "one mapping, every language" — and for ARB the file
    // name is the only place the language is written.
    const parsed = config();
    parsed.files = [
      {
        id: 'flutter-all',
        platform: 'universal',
        locale: '*',
        localeFromPath: true,
        format: 'arb',
        source: true,
        paths: ['lib/l10n/*.arb'],
        keyMode: 'flat',
        namespaceFromPath: false,
      },
    ];
    const guard = new WorkspaceGuard(parsed, root);
    const result = await scanWorkspace(guard, { projectId: 'prj_flutter', sourceLocale: 'en' });
    expect(result.locales.sort()).toEqual(['en', 'th', 'zh', 'zh-CN', 'zh-TW']);
  });

  it('maps a file to its mapping, so a write goes through the same path the scan read', () => {
    const guard = new WorkspaceGuard(config(), root);
    const mapping = guard.mapFile('lib/l10n/app_zh_CN.arb');
    expect(mapping?.mapping.locale).toBe('zh-CN');
    expect(mapping?.mapping.format).toBe('arb');
    // A path the guard has not mapped is refused rather than guessed at.
    expect(guard.mapFile('lib/l10n/generated/app_localizations.dart')).toBeNull();
  });

  it('leaves the ARB files byte-identical, including what the platform does not model', () => {
    // Nothing in a scan writes; this is the file the assertion above reads, held to the byte.
    expect(readFileSync(join(root, 'lib/l10n/app_en.arb'), 'utf8')).toBe(EN);
  });
});
