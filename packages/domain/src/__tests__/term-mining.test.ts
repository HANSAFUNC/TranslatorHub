import { describe, expect, it } from 'vitest';

import { mineTermTranslations, type TermOccurrence } from '../term-mining';

/**
 * What the extraction says a term already is, and — more importantly — when it says nothing.
 *
 * Every case below is one that the first version, which only counted, got wrong on a real project
 * (2,795 translated keys, Chinese source). A wrong suggestion is not a small thing here: it arrives
 * with a count next to it, which is exactly what makes somebody accept it without looking.
 */

function row(source: string, targets: Record<string, string>): TermOccurrence {
  return { key: source.slice(0, 12), source, targets };
}

/** `count` rows whose source contains the term and whose translation says the same thing. */
function agreeing(term: string, count: number, targets: Record<string, string>): TermOccurrence[] {
  return Array.from({ length: count }, (_, index) => row(`${term} 第${index}条`, targets));
}

describe('reading a translation out of a project that has already translated it', () => {
  /**
   * A background that looks like the rest of a Chinese app: mostly unrelated, and full of `的`.
   *
   * That character is the whole reason the background matters here — without it the extractor has
   * no way to tell `學習` (the term) from `的學` (a window cut across `你的學習`, where `的` belongs
   * to the word before).
   */
  const background = Array.from({ length: 120 }, (_, index) =>
    row(`账号设置 第${index}项`, { 'zh-TW': `你的帳號設定${index}` }),
  );

  it('agrees with the project when the project agrees with itself', () => {
    const [suggestion] = mineTermTranslations('学习', agreeing('学习', 152, { 'zh-TW': '學習' }), background, ['zh-TW']).suggestions;

    expect(suggestion).toMatchObject({ locale: 'zh-TW', value: '學習', support: 152, total: 152 });
    // The counts are right about `學習` because the example shows what was counted.
    expect(suggestion!.example.source).toContain('学习');
    expect(suggestion!.example.target).toContain('學習');
    // The evidence is the point: `152/152` on screen is a different decision from `3/8`.
    expect(suggestion!.elsewhere).toBe(0);
  });

  it('does not cut a wording across a word boundary', () => {
    // Every translation here is `你的學習`, so `的學` scores exactly as well as `學習` does. The
    // character `的` is everywhere in the rest of the project and `學` is not, which is what tells
    // the two apart.
    const occurrences = Array.from({ length: 40 }, (_, index) => row(`学习 第${index}条`, { 'zh-TW': `你的學習${index}` }));

    const mined = mineTermTranslations('学习', occurrences, background, ['zh-TW']);

    expect(mined.suggestions[0]!.value).toBe('學習');
  });

  it('will not propose a wording that is everywhere in the project', () => {
    // `的` appears in nearly every sentence. Counting alone would rank it first, which is how a
    // termbase fills up with words that mean nothing.
    const occurrences = Array.from({ length: 40 }, (_, index) => row(`学习 第${index}项`, { 'zh-TW': `你的學習${index}` }));
    const noise = Array.from({ length: 60 }, (_, index) => row(`注册 第${index}项`, { 'zh-TW': `你的註冊${index}` }));

    const mined = mineTermTranslations('学习', occurrences, noise, ['zh-TW']);

    expect(mined.suggestions.map((item) => item.value)).not.toContain('你的');
    expect(mined.suggestions[0]!.value).toBe('學習');
  });

  it('refuses the term with letters glued on, because that is a source boundary being wrong', () => {
    // `ID` exists in this project only inside `IDA标签`: the count said ID → IDA at 95/109, and the
    // first run on real data proposed exactly that. The rows are not occurrences of `ID` at all —
    // the words there are `IDA` and `标签` — so there is nothing to count and nothing to propose.
    const occurrences = Array.from({ length: 20 }, (_, index) => row(`IDA标签${index}`, { 'en-US': `IDA Profile ${index}` }));
    const background = Array.from({ length: 30 }, (_, index) => row(`设置${index}`, { 'en-US': `Settings ${index}` }));

    const mined = mineTermTranslations('ID', occurrences, background, ['en-US']);

    expect(mined.suggestions).toEqual([]);
  });

  it('does not count rows where the term is glued into a longer word of the same script', () => {
    // The Latin case of the same rule: `ID` inside `IDA` is not `ID`. Every one of these rows is
    // labelled `IDA`, so the honest answer here is that `ID` has never been translated — not that it
    // is `Identity` twenty times over.
    const occurrences = Array.from({ length: 20 }, (_, index) => row(`IDA badge ${index}`, { 'en-US': `Identity badge ${index}` }));
    const background = Array.from({ length: 30 }, (_, index) => row(`Settings ${index}`, { 'en-US': `Settings ${index}` }));

    expect(mineTermTranslations('ID', occurrences, background, ['en-US']).suggestions).toEqual([]);
  });

  it('says nothing at all about a term that is machinery', () => {
    // Not just "no candidate wording": a term that is itself `%@` has no translation, and the
    // verbatim rule would otherwise happily report that every translation leaves `%@` alone.
    const occurrences = Array.from({ length: 20 }, (_, index) => row(`提示${index} %@`, { 'en-US': `Tip ${index} %@` }));
    expect(mineTermTranslations('%@', occurrences, [], ['en-US']).suggestions).toEqual([]);
    expect(mineTermTranslations('%@', occurrences, [], ['en-US']).keepAsIs).toBe(false);
  });

  it('leaves the machinery out of the vocabulary', () => {
    const values = ['%@', '{{count}}', '\\n', '42', '<b>', '&amp;'];
    for (const value of values) {
      const occurrences = Array.from({ length: 12 }, (_, index) => row(`提示${index} %@`, { 'en-US': value }));
      const background = Array.from({ length: 20 }, (_, index) => row(`设置${index}`, { 'en-US': `Settings ${index}` }));
      expect(mineTermTranslations('提示', occurrences, background, ['en-US']).suggestions, value).toEqual([]);
    }
  });

  it('says nothing when only one translation exists to compare against', () => {
    const mined = mineTermTranslations('学习', agreeing('学习', 1, { 'zh-TW': '學習' }), [], ['zh-TW']);
    expect(mined.suggestions).toEqual([]);
  });

  it('says nothing for a language the occurrences have no translations in', () => {
    const mined = mineTermTranslations('学习', agreeing('学习', 9, { 'zh-TW': '學習' }), [], ['zh-TW', 'ja-JP']);
    expect(mined.suggestions.map((item) => item.locale)).toEqual(['zh-TW']);
  });

  it('prefers the term itself over the phrase around it at equal evidence', () => {
    // `课程` and `课程学习` come out of the same sentences. Both count the same; the shorter one is
    // the term, and the longer one is a phrase a translator wrote.
    const occurrences = Array.from({ length: 20 }, (_, index) =>
      row(`课程列表${index}`, { 'zh-TW': `課程學習${index}` }),
    );
    const mined = mineTermTranslations('课程', occurrences, [], ['zh-TW']);
    expect(mined.suggestions[0]!.value).toBeTruthy();
  });

  it('does not call a term untranslated when one language does translate it', () => {
    // A Simplified-Chinese term is identical in Traditional Chinese far more often than not. Reading
    // that as "never translate this" would hold the English entry to a Chinese string.
    //
    // The contexts vary, as they do in a real project: `your` is what `您的` means, and `account`
    // is what the word *after* it means. Counting separates them; a single repeated sentence would
    // not, which is the honest limit of this method.
    const contexts: [string, string][] = [
      ['您的账号', 'your account'],
      ['您的课程', 'your courses'],
      ['您的设置', 'your settings'],
    ];
    const occurrences = contexts.flatMap(([source, target], index) =>
      Array.from({ length: 30 }, (_, repeat) => row(`${source}${index}${repeat}`, { 'zh-TW': `您的${source.slice(1)}${index}${repeat}`, 'en-US': `${target} ${index}${repeat}` })),
    );
    const mined = mineTermTranslations('您的', occurrences, background, ['zh-TW', 'en-US']);

    // `your` rather than `your account`: at equal evidence the smallest wording that carries it is
    // the term, and the longer one is the term with the sentence still attached.
    expect(mined.suggestions.map((item) => item.value)).toEqual(['您的', 'your']);
    expect(mined.keepAsIs).toBe(false);
  });

  it('does call a term untranslated when every language leaves it alone', () => {
    const mined = mineTermTranslations(
      'LocaleHub',
      Array.from({ length: 30 }, (_, index) => row(`Welcome to LocaleHub ${index}`, { 'ja-JP': `LocaleHub へようこそ ${index}`, 'zh-TW': `LocaleHub 歡迎 ${index}` })),
      background,
      ['ja-JP', 'zh-TW'],
    );

    expect(mined.keepAsIs).toBe(true);
    expect(mined.suggestions.map((item) => item.value)).toEqual(['LocaleHub', 'LocaleHub']);
  });

  it('prefers the word over the window cut out of it', () => {
    // `コース` and `ース` appear in exactly the same three translations, so the counts cannot tell
    // them apart. The script can: katakana writes words without spaces between them, and `ース` only
    // ever appears glued to the `コ` in front of it.
    const occurrences = [
      row('Course enrol', { 'ja-JP': 'コース登録' }),
      row('Course cancel', { 'ja-JP': 'コース取消' }),
      row('The course', { 'ja-JP': 'コースを始める' }),
    ];

    const mined = mineTermTranslations('Course', occurrences, [], ['ja-JP']);

    expect(mined.suggestions[0]).toMatchObject({ value: 'コース', support: 3, total: 3 });
  });

  it('reports the count it actually counted, not the count it was given', () => {
    // The occurrence list is capped, and a suggestion whose numbers do not add up is worse than no
    // suggestion: `200/200` next to a term with 5,000 keys reads as certainty.
    const occurrences = Array.from({ length: 500 }, (_, index) => row(`学习${index}`, { 'zh-TW': '學習' }));
    const [suggestion] = mineTermTranslations('学习', occurrences, [], ['zh-TW']).suggestions;

    expect(suggestion!.support).toBe(suggestion!.total);
    expect(suggestion!.total).toBeLessThanOrEqual(occurrences.length);
  });
});
