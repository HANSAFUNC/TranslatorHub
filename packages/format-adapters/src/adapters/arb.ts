import {
  ErrorCode,
  LocaleHubError,
  canonicalizeLocaleTag,
  extractPlaceholders,
  type AdapterInput,
  type FormatAdapter,
  type NormalizedEntry,
  type Placeholder,
  type RawEntry,
  type TranslationPatch,
  type ValidationIssue,
} from '@localehub/contracts';
import { buildIcuPlural, parseIcuPlural } from '../icu';
import { trimTrailingWhitespace } from '../json-adapter';
import { JsonScanner, joinPath } from '../json-scan';
import { lineOfOffset } from '../text-utils';

/**
 * ARB — Flutter's localization format (`app_en.arb`), the one `flutter gen-l10n` reads.
 *
 * It is JSON with three conventions layered on top, and each of them is a way to get this wrong:
 *
 *   * `@@locale` and any other `@@` directive are file-level, not entries. `@@locale` also has to
 *     agree with the locale the file is *for* — a translator's file saying `"@@locale": "zh"` while
 *     the mapping says `th-TH` is how the wrong language ends up in the Thai build. That is a
 *     warning here, not a silent pass.
 *   * `@key` is the metadata for `key`: the description a translator reads, and the `placeholders`
 *     that tell gen-l10n what typed parameters to generate. **The platform never invents metadata**,
 *     and a template key without it fails a project that sets `required-resource-attributes: true`
 *     (the Flutter default for projects that mean it). So a patched file keeps its metadata
 *     untouched, and an inserted key says out loud what it could not know.
 *   * A value may be an object of plural/select branches. The platform's canonical form for those is
 *     an ICU message string (see `../icu`), so parse builds one and patch decomposes one — the same
 *     contract the Android `<plurals>` and Apple `.stringsdict` adapters follow.
 *
 * Everything else is the JSON adapter's discipline: parse is read-only, and `applyPatch` splices
 * only the value tokens that changed, so key order, indentation, comments-as-keys and unknown
 * directives survive byte for byte.
 */

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** `zh-CN` -> `zh_CN`: the spelling gen-l10n uses in `@@locale` and in file names. */
export function arbTagForLocale(locale: string): string {
  return locale.replace(/-/g, '_');
}

/**
 * `zh_CN` -> `zh-CN`.
 *
 * The dash/spelling split matters more than it looks: every locale tag the platform accepts goes
 * through `isValidLocaleTag`, which splits on `-` only — so `zh_CN` is not a valid platform locale,
 * while `zh-CN` is. ARB is the side that speaks underscores.
 */
export function localeFromArbTag(tag: string): string {
  return canonicalizeLocaleTag(tag.replace(/_/g, '-'));
}

/**
 * `lib/l10n/app_zh_CN.arb` -> `zh-CN`, and `lib/l10n/app_en.arb` -> `en`.
 *
 * gen-l10n names the files `<template>_<locale>.arb`, so the locale is everything after the *first*
 * underscore: taking everything after the last one reads `zh_CN` as `CN`.
 */
export function localeFromArbPath(filePath: string): string | null {
  const base = filePath.split(/[/\\]/).pop() ?? '';
  if (!/\.arb$/i.test(base)) return null;
  const stem = base.slice(0, -'.arb'.length);
  const at = stem.indexOf('_');
  if (at < 0) return null;
  const tag = stem.slice(at + 1);
  return tag ? localeFromArbTag(tag) : null;
}

interface ArbMetadata {
  description?: unknown;
  context?: unknown;
  placeholders?: Record<string, { type?: unknown; format?: unknown }>;
}

export class ArbAdapter implements FormatAdapter {
  readonly id = 'arb';
  readonly extensions = ['.arb'];

  async detect(filePath: string, content: Buffer): Promise<boolean> {
    if (!/\.arb$/i.test(filePath)) return false;
    try {
      const root = JSON.parse(content.toString('utf8')) as unknown;
      return Boolean(root) && typeof root === 'object' && !Array.isArray(root);
    } catch {
      return false;
    }
  }

  async parse(input: AdapterInput): Promise<RawEntry[]> {
    const text = input.content.toString('utf8');
    const root = parseArbObject(text, input.filePath);
    const scan = new JsonScanner(text).scan();
    const entries: RawEntry[] = [];

    for (const [key, value] of Object.entries(root)) {
      if (key.startsWith('@@')) continue; // file-level directive
      if (key.startsWith('@')) continue; // metadata for the key after the '@'
      const meta = readMetadata(root[`@${key}`]);
      const declared = declaredPlaceholders(meta);
      // `@key` exists -> this file states what its placeholders are, and that statement is what
      // validation has to compare against. No `@key` block at all means the file says nothing
      // about placeholders (a target file does not have to), which is not the same as saying "none".
      const declaration = meta ? { arbDeclaredPlaceholders: declared?.map((p) => p.name) ?? [] } : {};
      const line = lineOfOffset(text, scan.spans.get(joinPath([key]))?.start ?? 0);
      const common = {
        key,
        locale: input.locale,
        namespace: input.namespace,
        platform: input.platform,
        filePath: input.filePath,
        line,
        ...(typeof meta?.description === 'string' ? { description: meta.description } : {}),
        // ARB's `context` is the disambiguation note a translator is meant to read, which is what
        // the platform shows as the developer comment on an entry.
        ...(typeof meta?.context === 'string' ? { context: { developerComment: meta.context } } : {}),
      };

      if (typeof value === 'string') {
        entries.push({
          ...common,
          value,
          placeholders: declared ?? extractPlaceholders(value),
          platformMetadata: {
            arbPath: [key],
            ...declaration,
            // ARB writes a plural either as an ICU string in the value or as an object of branches.
            // Both are real, and the file has to come back the way it went in — so which one this
            // was is recorded rather than re-decided on the way out.
            ...(parseIcuPlural(value) ? { arbValueForm: 'string' } : {}),
            ...(declaredLocaleOf(root) ? { arbLocale: declaredLocaleOf(root) } : {}),
          },
        });
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const branches = value as Record<string, unknown>;
        const icu = icuFromArbBranches(branches, meta);
        entries.push({
          ...common,
          value: icu.value,
          placeholders: declared ?? extractPlaceholders(icu.value),
          platformMetadata: {
            arbPath: [key],
            ...declaration,
            arbKind: icu.kind,
            arbArg: icu.argName,
            arbValueForm: 'object',
            ...(declaredLocaleOf(root) ? { arbLocale: declaredLocaleOf(root) } : {}),
          },
        });
        continue;
      }

      // A number/boolean/null value is not something a translation can carry, and skipping it
      // quietly is how a key disappears from the platform without anyone noticing.
      throw new LocaleHubError(
        ErrorCode.PARSE_ERROR,
        `ARB value at "${key}" is a ${value === null ? 'null' : typeof value}; only a string or a plural/select object is a message`,
        400,
        { filePath: input.filePath, key },
      );
    }

    return entries;
  }

  async validate(entries: NormalizedEntry[]): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.value.trim() === '') {
        issues.push({
          code: 'EMPTY_VALUE',
          severity: 'WARNING',
          message: 'Translation value is empty',
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      const dedupe = `${entry.namespace}\u0001${entry.key}\u0001${entry.locale}`;
      if (seen.has(dedupe)) {
        issues.push({
          code: 'DUPLICATE_KEY',
          severity: 'ERROR',
          message: `Duplicate key ${entry.key} for locale ${entry.locale}`,
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
      seen.add(dedupe);

      // gen-l10n generates the parameters of a message from `@key.placeholders`. A `{name}` the
      // metadata does not declare becomes a literal in the generated Dart, which is a bug that
      // surfaces as a stray brace on screen rather than as a build failure.
      const declaredNames = entry.platformMetadata?.arbDeclaredPlaceholders;
      if (Array.isArray(declaredNames)) {
        const declared = new Set(declaredNames as string[]);
        for (const name of icuArguments(entry.value)) {
          if (declared.has(name)) continue;
          issues.push({
            code: 'ARB_UNDECLARED_PLACEHOLDER',
            severity: 'WARNING',
            message: `Value uses {${name}} but @${entry.key}.placeholders does not declare it; gen-l10n will emit it literally`,
            key: entry.key,
            locale: entry.locale,
            filePath: entry.filePath,
          });
        }
      }

      const declaredForFile = entry.platformMetadata?.arbLocale;
      if (typeof declaredForFile === 'string' && localeFromArbTag(declaredForFile) !== entry.locale) {
        issues.push({
          code: 'ARB_LOCALE_MISMATCH',
          severity: 'WARNING',
          message: `File declares "@@locale": "${declaredForFile}" but the mapping says ${entry.locale}`,
          key: entry.key,
          locale: entry.locale,
          filePath: entry.filePath,
        });
      }
    }
    return issues;
  }

  /**
   * Splice the changed values into the file.
   *
   * A plural/select entry holds an ICU message on the platform's side and an object in the file, so
   * the two shapes are converted here in both directions — including the case that must *not* be
   * converted: replacing a branch object with a plain string would leave `@key.placeholders`
   * declaring a parameter the message no longer uses, which is a broken ARB file, so it is refused
   * rather than written.
   */
  async applyPatch(input: {
    originalContent: Buffer;
    changes: TranslationPatch[];
    preserveUnknownFields: boolean;
  }): Promise<Buffer> {
    const text = input.originalContent.toString('utf8');
    const scan = new JsonScanner(text).scan();
    const root = scan.root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw new LocaleHubError(ErrorCode.PARSE_ERROR, 'ARB root must be a JSON object', 400);
    }
    const rootKey = joinPath([]);
    const rootInner = scan.objectInnerSpans.get(rootKey);
    const edits: { start: number; end: number; text: string }[] = [];
    const appended: string[] = [];

    for (const change of input.changes) {
      const path = change.variantPath?.length ? [change.key, ...change.variantPath] : [change.key];
      const span = scan.spans.get(joinPath(path));

      if (!span) {
        appended.push(renderMember(change, rootInner?.indent ?? '  '));
        continue;
      }

      if (span.type === 'string') {
        edits.push({ start: span.start, end: span.end, text: JSON.stringify(change.newValue) });
        continue;
      }

      if (span.type === 'object') {
        const parsed = change.variantPath?.length ? null : parseIcuPlural(change.newValue);
        if (!parsed) {
          throw new LocaleHubError(
            ErrorCode.UNSUPPORTED_FORMAT,
            `ARB entry "${change.key}" holds plural/select branches: send an ICU message ` +
              `({arg, plural, one {…} other {…}}) instead of a plain string, or the value and ` +
              `"@${change.key}.placeholders" would disagree`,
            422,
            { key: change.key, filePath: change.locale },
          );
        }
        edits.push({
          start: span.start,
          end: span.end,
          text: renderBranches(branchesFromIcu(parsed), indentAt(text, span.start)),
        });
        continue;
      }

      throw new LocaleHubError(
        ErrorCode.UNSUPPORTED_FORMAT,
        `ARB value at "${change.key}" is a ${span.type}; only strings and plural/select objects can be patched`,
        422,
        { key: change.key },
      );
    }

    if (appended.length && rootInner) {
      const at = trimTrailingWhitespace(text, rootInner.start, rootInner.end);
      edits.push({ start: at, end: at, text: appended.join('') });
    }

    edits.sort((a, b) => b.start - a.start);
    let out = text;
    for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return Buffer.from(out, 'utf8');
  }

  /**
   * Write a whole ARB file.
   *
   * `@@locale` first, then each key with its metadata — the shape `flutter gen-l10n` writes and the
   * one a checked-in ARB directory has. Metadata is emitted only where the platform actually holds
   * something (a description or declared placeholders): an empty `@key` block is noise, and a
   * description invented to fill it would be worse.
   */
  async serialize(entries: NormalizedEntry[]) {
    const grouped = new Map<string, NormalizedEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.filePath) ?? [];
      list.push(entry);
      grouped.set(entry.filePath, list);
    }
    return [...grouped.entries()].map(([filePath, list]) => {
      const root: Record<string, unknown> = { '@@locale': arbTagForLocale(list[0]?.locale ?? '') };
      for (const entry of list) {
        const parsed = parseIcuPlural(entry.value);
        const asBranches = Boolean(parsed) && entry.platformMetadata?.arbValueForm !== 'string';
        root[entry.key] = asBranches && parsed ? branchesFromIcu(parsed) : entry.value;
        const metadata: Record<string, unknown> = {};
        if (entry.description) metadata.description = entry.description;
        const placeholders = placeholdersForDeclaration(entry, asBranches ? parsed : null);
        if (placeholders) metadata.placeholders = placeholders;
        if (Object.keys(metadata).length) root[`@${entry.key}`] = metadata;
      }
      return {
        filePath,
        format: this.id,
        locale: list[0]?.locale ?? '',
        content: `${JSON.stringify(root, null, 2)}\n`,
      };
    });
  }
}

function parseArbObject(text: string, filePath: string): Record<string, unknown> {
  let root: unknown;
  try {
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new LocaleHubError(
      ErrorCode.PARSE_ERROR,
      `Failed to parse ARB file ${filePath}: ${(error as Error).message}`,
      400,
      { filePath },
    );
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new LocaleHubError(ErrorCode.PARSE_ERROR, `ARB root of ${filePath} must be a JSON object`, 400, { filePath });
  }
  return root as Record<string, unknown>;
}

function readMetadata(value: unknown): ArbMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as ArbMetadata;
}

function declaredLocaleOf(root: Record<string, unknown>): string | undefined {
  const value = root['@@locale'];
  return typeof value === 'string' && value ? value : undefined;
}

function declaredPlaceholders(meta: ArbMetadata | undefined): Placeholder[] | undefined {
  const placeholders = meta?.placeholders;
  if (!placeholders || typeof placeholders !== 'object') return undefined;
  const out: Placeholder[] = [];
  for (const [name, spec] of Object.entries(placeholders)) {
    out.push({
      name,
      ...(typeof spec?.type === 'string' ? { type: spec.type } : {}),
      ...(typeof spec?.format === 'string' ? { format: spec.format } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * Which ARB object is a plural and which is a select, and what its argument is called.
 *
 * The metadata answers it when the project declared it (`{count: {type: int}}`), and the branch
 * names answer it when it did not — `one/two/few/…` are plural categories, `male/female/other` are
 * not. Getting this backwards writes `{gender, plural, …}`, which gen-l10n compiles into nonsense.
 */
function icuFromArbBranches(
  branches: Record<string, unknown>,
  meta: ArbMetadata | undefined,
): { value: string; kind: 'plural' | 'select'; argName: string } {
  const names = Object.keys(branches);
  const pluralish = names.length > 0 && names.every((name) => PLURAL_CATEGORIES.has(name) || /^=\d+$/.test(name));
  const kind: 'plural' | 'select' = pluralish ? 'plural' : 'select';
  const argName = declaredArgName(meta, kind) ?? (kind === 'plural' ? 'count' : 'choice');

  const quantities: Record<string, string> = {};
  const exactMatches: Record<string, string> = {};
  for (const [branch, value] of Object.entries(branches)) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    if (branch.startsWith('=')) exactMatches[branch] = body;
    else quantities[branch] = body;
  }
  const value = buildIcuPlural(
    { argName, quantities, ...(Object.keys(exactMatches).length ? { exactMatches } : {}) },
    kind,
  );
  return { value, kind, argName };
}

function declaredArgName(meta: ArbMetadata | undefined, kind: 'plural' | 'select'): string | undefined {
  const declared = Object.entries(meta?.placeholders ?? {});
  const numeric = /^(int|num|double|number)$/i;
  const typed = declared.find(([, spec]) => {
    const type = String(spec?.type ?? '');
    return kind === 'plural' ? numeric.test(type) : /^string$/i.test(type);
  });
  if (typed) return typed[0];
  // A single declared placeholder is the argument, whatever its type says.
  return declared.length === 1 ? declared[0]?.[0] : undefined;
}

function branchesFromIcu(parsed: ReturnType<typeof parseIcuPlural> & object): Record<string, string> {
  return { ...parsed.quantities, ...(parsed.exactMatches ?? {}) };
}

function placeholdersForDeclaration(
  entry: NormalizedEntry,
  parsed: ReturnType<typeof parseIcuPlural> | null,
): Record<string, { type: string }> | null {
  // A branch object is generated from one declared argument; anything else declares what the entry
  // itself carries (the file's own metadata, or the placeholders its value uses).
  if (parsed) return { [parsed.argName]: { type: parsed.kind === 'select' ? 'String' : 'int' } };
  const declared = entry.placeholders ?? [];
  if (!declared.length) return null;
  return Object.fromEntries(
    declared.map((placeholder) => [placeholder.name, { type: placeholder.type ?? 'String' }]),
  );
}

/** The ICU arguments a message actually uses, plural/select argument included. */
function icuArguments(value: string): string[] {
  const parsed = parseIcuPlural(value);
  const names = new Set(extractPlaceholders(value).map((placeholder) => placeholder.name));
  if (parsed) {
    names.add(parsed.argName);
    names.delete('#'); // ICU's shorthand for the plural argument, not a placeholder of its own
  }
  return [...names];
}

function renderBranches(branches: Record<string, string>, indent: string): string {
  const body = Object.entries(branches)
    .map(([branch, value]) => `${indent}  ${JSON.stringify(branch)}: ${JSON.stringify(value)}`)
    .join(',\n');
  return `{\n${body}\n${indent}}`;
}

/** The leading whitespace of the line a value starts on, so a rewritten object lines up. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

/**
 * A key the file does not have yet: the value, plus the `@key` block gen-l10n needs to generate a
 * parameter for it.
 *
 * The description is *not* invented — an inserted key that a Flutter project with
 * `required-resource-attributes: true` then rejects is a failure the platform should not be able to
 * cause silently. (The platform's own apply flow never inserts a key that is missing locally: the
 * plan marks those `MISSING_LOCAL_ENTRY` and stops.)
 */
function renderMember(change: TranslationPatch, indent: string): string {
  const parsed = parseIcuPlural(change.newValue);
  const value = parsed ? renderBranches(branchesFromIcu(parsed), indent) : JSON.stringify(change.newValue);
  const placeholders = parsed
    ? { [parsed.argName]: { type: parsed.kind === 'select' ? 'String' : 'int' } }
    : Object.fromEntries(
        extractPlaceholders(change.newValue).map((placeholder) => [placeholder.name, { type: 'String' }]),
      );
  const metadata: Record<string, unknown> = {};
  if (Object.keys(placeholders).length) metadata.placeholders = placeholders;
  return `,\n${indent}${JSON.stringify(change.key)}: ${value},\n${indent}${JSON.stringify(`@${change.key}`)}: ${JSON.stringify(metadata, null, 2).replace(/\n/g, `\n${indent}`)}`;
}
