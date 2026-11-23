import { describe, expect, it } from 'vitest';

import { candidatePhrases, extractTermCandidates, maximalPhrases } from '../term-extraction';

/**
 * Finding the vocabulary, before asking what it means.
 *
 * The phrase extractor had no test of its own — it was exercised only through a browser check against
 * a live project, which is how a bug where English projects produced *no candidates at all* survived:
 * the window scanner stepped three words at a time, so the two windows straddling a boundary were
 * never tried. A Chinese project came back with twenty candidates, so nothing looked wrong.
 */

describe('the phrases a source string is made of', () => {
  it('takes every CJK run of two to five characters', () => {
    // Every window: three of length 2, two of length 3, and the whole run. Sorted on both sides
    // because the order the extractor happens to emit is not the point — the set is.
    expect(candidatePhrases('课程列表').sort()).toEqual(['课程', '程列', '列表', '课程列', '程列表', '课程列表'].sort());
  });

  it('takes every window of Latin words, not every third one', () => {
    // The bug this pins: `(?:\\s+word){0,2}` scans in steps of three, so `of the` and `the course`
    // were never tried and an English project produced nothing.
    const phrases = candidatePhrases('Start of the course');

    expect(phrases).toContain('Start of');
    expect(phrases).toContain('of the');
    expect(phrases).toContain('the course');
    expect(phrases).toContain('of the course');
  });

  it('keeps one word as a candidate when it is long enough to be a term', () => {
    const phrases = candidatePhrases('Course list');
    expect(phrases).toContain('Course');
    expect(phrases).toContain('list');
    // `the` and `of` are words of a sentence, not terms, and the length floor is what says so.
    expect(candidatePhrases('Start the course')).not.toContain('the');
  });

  it('does not offer punctuation or whitespace as a term', () => {
    for (const phrase of candidatePhrases('课程，请选择。（必填）')) {
      expect(phrase.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').length).toBeGreaterThanOrEqual(2);
      expect(phrase).not.toContain('，');
      expect(phrase).not.toContain('（');
    }
  });
});

describe('dropping the fragments', () => {
  const entry = (term: string, count: number) => ({ term, keys: new Set(Array.from({ length: count }, (_, i) => `k${i}`)) });

  it('keeps the longer phrase when the shorter is just part of it', () => {
    // `课程` and `课程学习` come out of the same sentences, and asking about both asks the same
    // question twice.
    expect(maximalPhrases([entry('课程', 10), entry('课程学习', 10)]).map((row) => row.term)).toEqual(['课程学习']);
  });

  it('keeps both when the shorter one is the more common of the two', () => {
    // A shorter phrase that appears in more keys is not a fragment of the longer one: they are
    // different terms that happen to nest.
    const kept = maximalPhrases([entry('课程', 40), entry('课程学习', 10)]).map((row) => row.term);
    expect(kept.sort()).toEqual(['课程', '课程学习']);
  });
});

/**
 * A transaction stub: this function's job is deciding *what to ask*, and the two tables it reads are
 * small enough to state outright.
 */
function reader(rows: { key: string; source: string; targets: Record<string, string> }[], known: string[] = [], sourceLocale = 'zh-CN') {
  return {
    project: {
      findUnique: async () => ({ sourceLocale, locales: [{ code: 'zh-CN' }, { code: 'zh-TW' }] }),
    },
    translationKey: {
      findMany: async () =>
        rows.map((row) => ({
          id: row.key,
          key: row.key,
          sourceVersions: [{ value: row.source }],
          entries: Object.entries(row.targets).map(([localeCode, value]) => ({ localeCode, value })),
        })),
    },
    glossaryTerm: {
      findMany: async () =>
        known.map((term, index) => ({
          id: `t${index}`,
          projectId: 'proj',
          term,
          translations: {},
          caseSensitive: false,
          status: 'DRAFT',
          doNotTranslate: false,
          forbiddenTargets: null,
          disabled: false,
        })),
    },
  };
}

describe('what a project keeps saying', () => {
  const vocabulary = [
    { key: 'a', source: '课程列表', targets: { 'zh-TW': '課程列表' } },
    { key: 'b', source: '课程详情', targets: { 'zh-TW': '課程詳情' } },
    { key: 'c', source: '课程学习', targets: { 'zh-TW': '課程學習' } },
  ];

  it('finds the recurring phrase and what the project calls it', async () => {
    const result = await extractTermCandidates(reader(vocabulary) as never, {
      organizationId: 'org',
      projectId: 'proj',
      minKeys: 3,
      limit: 20,
    });

    const course = result.candidates.find((row) => row.term === '课程');
    expect(course).toMatchObject({ keyCount: 3 });
    expect(course!.suggestions[0]).toMatchObject({ locale: 'zh-TW', value: '課程', support: 3, total: 3 });
    // The source language is not a language to suggest a translation into.
    expect(result.locales).toEqual(['zh-TW']);
  });

  it('leaves out what the termbase already decides', async () => {
    // Proposing to somebody what they settled last week is how a queue stops being read.
    const result = await extractTermCandidates(reader(vocabulary, ['课程']) as never, {
      organizationId: 'org',
      projectId: 'proj',
      minKeys: 3,
      limit: 20,
    });

    expect(result.candidates.map((row) => row.term)).not.toContain('课程');
  });

  it('leaves out a phrase that only one key uses', async () => {
    const result = await extractTermCandidates(reader(vocabulary) as never, {
      organizationId: 'org',
      projectId: 'proj',
      minKeys: 4,
      limit: 20,
    });

    expect(result.candidates).toEqual([]);
  });

  it('says how many keys the numbers came from', async () => {
    const result = await extractTermCandidates(reader(vocabulary) as never, {
      organizationId: 'org',
      projectId: 'proj',
      minKeys: 3,
      limit: 20,
    });

    // Every count in the answer is a fraction of this, and a caller that cannot see the denominator
    // cannot tell `152/152` from `3/3`.
    expect(result.scannedKeys).toBe(3);
  });
});
