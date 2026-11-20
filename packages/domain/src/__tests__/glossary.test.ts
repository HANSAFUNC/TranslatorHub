import { describe, expect, it } from 'vitest';

import { resolveGlossary, termTarget, type ResolvedTerm } from '../glossary';
import { runQaRules, type QaCandidateEntry } from '../qa';

/**
 * The termbase's two halves: the rule that decides *which* term applies, and the rule that decides
 * *how loud* a violation of it is.
 *
 * Both were the reason a termbase could not be trusted. The reconciliation was three separate
 * `OR: [{projectId}, {projectId: null}]` queries, so a term that existed in both scopes came back
 * twice and a disagreement between them was invisible; and every violation was a WARNING, so a term
 * somebody had signed off on counted for exactly as much as one a machine had guessed at.
 */

interface Row {
  id: string;
  projectId: string | null;
  term: string;
  translations?: Record<string, string>;
  caseSensitive?: boolean;
  status?: string;
  doNotTranslate?: boolean;
  forbiddenTargets?: Record<string, string[]>;
  disabled?: boolean;
}

/** Just enough of a transaction to answer the one query `resolveGlossary` makes. */
function reader(rows: Row[]) {
  return {
    glossaryTerm: {
      findMany: async () => rows.map((row) => ({ caseSensitive: false, doNotTranslate: false, disabled: false, ...row })),
    },
  } as never;
}

const SCOPES = { organizationId: 'org-1', projectId: 'proj-1' };

describe('resolveGlossary', () => {
  it('lets a project term win, and says what it won over', async () => {
    const resolved = await resolveGlossary(
      reader([
        { id: 'org', projectId: null, term: '课程', translations: { 'en-US': 'Module' } },
        { id: 'proj', projectId: 'proj-1', term: '课程', translations: { 'en-US': 'Course' } },
      ]),
      SCOPES,
    );

    // One row, not two. The old merge returned both and let the caller pick.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.translations['en-US']).toBe('Course');
    expect(resolved[0]!.scope).toBe('project');
    // The disagreement is carried rather than dropped, because "your project overrode the company"
    // is exactly what somebody needs to see before they wonder why a term changed meaning.
    expect(resolved[0]!.overrides).toEqual({ term: '课程', translations: { 'en-US': 'Module' } });
  });

  it('applies an organisation term where the project has nothing to say', async () => {
    const resolved = await resolveGlossary(
      reader([{ id: 'org', projectId: null, term: 'LocaleHub', translations: { 'ja-JP': 'ロケールハブ' } }]),
      SCOPES,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.scope).toBe('organization');
    expect(resolved[0]!.overrides).toBeUndefined();
  });

  it('switches an organisation term off in one project without inventing a replacement', async () => {
    const resolved = await resolveGlossary(
      reader([
        { id: 'org', projectId: null, term: '课程', translations: { 'en-US': 'Module' } },
        { id: 'proj', projectId: 'proj-1', term: '课程', disabled: true },
      ]),
      SCOPES,
    );

    // Nothing applies here. The alternative — a same-named project row with an empty translation —
    // reads as a term, so every reader downstream would have to know that empty means absent.
    expect(resolved).toEqual([]);
  });

  it('treats one spelling of a term as one term, whatever its case', async () => {
    const resolved = await resolveGlossary(
      reader([
        { id: 'org', projectId: null, term: 'Course', translations: { 'en-US': 'Course' } },
        { id: 'proj', projectId: 'proj-1', term: 'course', translations: { 'en-US': 'Kurs' } },
      ]),
      SCOPES,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.overrides).toBeDefined();
  });

  it('ignores a term belonging to another scope', async () => {
    // The query is scoped to the project and the organisation; a row from anywhere else arriving
    // here would be a tenant leak, so the resolver must not treat it as this project's.
    const resolved = await resolveGlossary(reader([{ id: 'org', projectId: null, term: 'Home', translations: {} }]), SCOPES);
    expect(resolved.map((term) => term.term)).toEqual(['Home']);
  });
});

describe('termTarget', () => {
  const base: ResolvedTerm = {
    id: 't',
    term: 'LocaleHub',
    translations: { 'en-US': 'LocaleHub', 'ja-JP': 'ロケールハブ' },
    caseSensitive: false,
    status: 'APPROVED',
    doNotTranslate: false,
    forbiddenTargets: {},
    scope: 'project',
  };

  it('answers with the translation for the locale that has one', () => {
    expect(termTarget(base, 'ja-JP')).toBe('ロケールハブ');
  });

  it('answers nothing for a locale the term does not speak', () => {
    // Not the source term: a term that has not been translated into a language must not silently
    // become "leave it as it is", which is a different instruction.
    expect(termTarget(base, 'ko-KR')).toBeNull();
  });

  it('holds a do-not-translate term to its own spelling in every language', () => {
    // The reason the flag exists: without it a product name has to be repeated per locale, and a
    // new locale silently loses the rule.
    expect(termTarget({ ...base, doNotTranslate: true }, 'ko-KR')).toBe('LocaleHub');
    expect(termTarget({ ...base, doNotTranslate: true }, 'ja-JP')).toBe('LocaleHub');
  });

  it('drops a deprecated term even at the locale it has a value for', () => {
    expect(termTarget({ ...base, status: 'DEPRECATED' }, 'ja-JP')).toBe('ロケールハブ');
    expect(termTarget({ ...base, status: 'DEPRECATED', doNotTranslate: true }, 'ja-JP')).toBeNull();
  });
});

/** One entry, in the shape the rules read. */
function entry(overrides: Partial<QaCandidateEntry> = {}): QaCandidateEntry {
  return {
    entryId: 'e1',
    key: 'home.title',
    locale: 'ja-JP',
    platform: 'web',
    namespace: 'ui',
    value: '',
    status: 'DRAFT',
    sourceValue: '',
    sourceLocale: 'en-US',
    ...overrides,
  };
}

const term = (overrides: Partial<NonNullable<QaCandidateEntry['glossaryTerms']>[number]> = {}) => ({
  term: 'Course',
  translations: { 'ja-JP': 'コース' },
  caseSensitive: false,
  status: 'APPROVED' as const,
  doNotTranslate: false,
  forbiddenTargets: {},
  ...overrides,
});

describe('how loud a termbase violation is', () => {
  it('fails an approved term, because that is what approved means', () => {
    const [finding] = runQaRules([
      entry({ sourceValue: 'Course list', value: 'モジュール一覧', glossaryTerms: [term()] }),
    ]);

    expect(finding!.ruleCode).toBe('GLOSSARY_TERM_MISSING');
    // The whole point of the state: an approved term gets into the release gate, a draft does not.
    expect(finding!.severity).toBe('ERROR');
  });

  it('only warns about one nobody has approved yet', () => {
    const [finding] = runQaRules([
      entry({ sourceValue: 'Course list', value: 'モジュール一覧', glossaryTerms: [term({ status: 'DRAFT' })] }),
    ]);

    expect(finding!.severity).toBe('WARNING');
  });

  it('says nothing about a term that has been replaced', () => {
    const findings = runQaRules([
      entry({ sourceValue: 'Course list', value: 'モジュール一覧', glossaryTerms: [term({ status: 'DEPRECATED' })] }),
    ]);

    expect(findings.filter((item) => item.ruleCode.startsWith('GLOSSARY'))).toEqual([]);
  });

  it('is satisfied when the translation uses the term', () => {
    const findings = runQaRules([entry({ sourceValue: 'Course list', value: 'コース一覧', glossaryTerms: [term()] })]);
    expect(findings.filter((item) => item.ruleCode.startsWith('GLOSSARY'))).toEqual([]);
  });

  it('holds a case-sensitive term to its case in the source', () => {
    // `Course` is a term; `course` in the source is not. Firing here would make the termbase
    // unusable for any word that is also an ordinary noun.
    const findings = runQaRules([
      entry({ sourceValue: 'course of action', value: '行動方針', glossaryTerms: [term({ caseSensitive: true })] }),
    ]);

    expect(findings.filter((item) => item.ruleCode.startsWith('GLOSSARY'))).toEqual([]);
  });

  it('requires a do-not-translate term verbatim wherever it appears', () => {
    const shared = { doNotTranslate: true, term: 'LocaleHub', translations: {} };
    const bad = runQaRules([entry({ sourceValue: 'Welcome to LocaleHub', value: 'ロケールハブへようこそ', glossaryTerms: [term(shared)] })]);
    const good = runQaRules([entry({ sourceValue: 'Welcome to LocaleHub', value: 'LocaleHub へようこそ', glossaryTerms: [term(shared)] })]);

    expect(bad.find((item) => item.ruleCode === 'GLOSSARY_TERM_MISSING')?.severity).toBe('ERROR');
    expect(good.filter((item) => item.ruleCode.startsWith('GLOSSARY'))).toEqual([]);
  });

  it('catches the wording the termbase rules out', () => {
    const findings = runQaRules([
      entry({
        sourceValue: 'Course list',
        value: '講座一覧',
        glossaryTerms: [term({ forbiddenTargets: { 'ja-JP': ['講座'] } })],
      }),
    ]);

    const forbidden = findings.find((item) => item.ruleCode === 'GLOSSARY_TERM_FORBIDDEN');
    expect(forbidden?.severity).toBe('ERROR');
    expect(forbidden?.details).toMatchObject({ forbidden: '講座' });
  });

  it('does not let a term in another language fire here', () => {
    const findings = runQaRules([
      entry({
        sourceValue: 'Course list',
        value: 'モジュール一覧',
        glossaryTerms: [term({ translations: { 'ko-KR': '코스' } })],
      }),
    ]);

    expect(findings.filter((item) => item.ruleCode.startsWith('GLOSSARY'))).toEqual([]);
  });
});
