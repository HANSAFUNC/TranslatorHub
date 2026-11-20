/**
 * What a term's translation already is, read out of the project's own translations.
 *
 * An extractor that only lists the source phrases asks somebody to answer the same question the
 * project has already answered hundreds of times: a project with 2,795 translated keys has said what
 * `学习` is in Traditional Chinese 152 times. Finding that out is not guessing — it is counting, and
 * counting is what this does.
 *
 * Counting is not alignment, though, and that difference is why every answer here travels with its
 * evidence and lands as a **candidate**. Sentence-level alignment cannot say which part of a
 * translation a word inside the source became; what it can say is "this wording appears in 116 of
 * the 116 translations of keys containing `课程`, and in none of the 300 that do not". That is a
 * measurement with a number attached, and the number is what lets a person decide in one glance
 * instead of retyping the glossary from memory.
 *
 * Two failure modes are worth naming, because the counting alone gets them wrong and a wrong answer
 * with the platform's authority behind it is worse than no answer:
 *
 *   * **The boundary is wrong in the source, not the target.** `ID` appears in the project only
 *     inside `IDA标签`, so the count says `ID → IDA` at 95/109. It is not: the term the project
 *     means is `IDA`, and `ID` is the fragment `maximalPhrases` left behind. A Latin term whose
 *     "translation" is the term with more Latin letters glued on is refused here.
 *   * **The match is punctuation or machinery.** `%@`, `\n`, `{{count}}` and bare numbers recur
 *     exactly as often as real words in a strings file, and suggesting them fills a termbase with
 *     things nobody can act on.
 */

/** A key, its source text, and whatever translations it already has. */
export interface TermOccurrence {
  key: string;
  source: string;
  /** locale → value, for the locales this key has a non-empty translation in. */
  targets: Record<string, string>;
}

/** One locale's read of what a term is called there, with the count that supports it. */
export interface TermSuggestion {
  locale: string;
  value: string;
  /**
   * One occurrence, whole.
   *
   * Counting cannot align a sentence with its translation, so the counts can be right about the
   * wrong thing — a wording that recurs next to the term rather than for it. The example is what
   * makes that visible in the second it takes to read one line.
   */
  example: { source: string; target: string };
  /** How many of `total` occurrences already say exactly this. */
  support: number;
  /** How many occurrences had a translation to compare against. */
  total: number;
  /** How many keys *without* the term say the same thing — the null hypothesis, counted. */
  elsewhere: number;
  compared: number;
}

export interface MinedTerm {
  term: string;
  suggestions: TermSuggestion[];
  /**
   * Every locale that has an opinion says the term unchanged.
   *
   * Only true when *all* of them do: a Simplified-Chinese source is unchanged in Traditional Chinese
   * far more often than not (`您的` → `您的`), and reading that as "this term is never translated"
   * would hold the English translation to a Chinese string.
   */
  keepAsIs: boolean;
}

/** Machine text, not vocabulary. */
const MACHINERY =
  /%(\d+\$)?[@sdif]|\{\{?\s*[\w.]+\s*\}?\}|\$\{[\w.]+\}|<\/?[a-zA-Z][^>]*>|&[a-z]+;|\\[nrt]|^[\d\s\p{P}\p{S}]+$/u;

/** How many occurrences to consider, and how much background to compare against. */
const MAX_OCCURRENCES = 200;
const MAX_BACKGROUND = 300;

/** The wordings a string is made of, for counting purposes. */
function wordingsOf(text: string): string[] {
  const out = new Set<string>();
  const han = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  if (han) {
    const chars = [...text];
    // Runs of 2–6 characters. One character is a syllable, not a term, and the background count
    // would reject it anyway; beyond six the windows stop resembling anything anybody names.
    for (let size = 2; size <= 6; size += 1) {
      for (let start = 0; start + size <= chars.length; start += 1) {
        const piece = chars.slice(start, start + size).join('');
        if (/^\s|\s$/.test(piece)) continue;
        if (MACHINERY.test(piece)) continue;
        out.add(piece);
      }
    }
  }
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = 1; size <= 4; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const piece = words.slice(start, start + size).join(' ');
      if (MACHINERY.test(piece)) continue;
      out.add(piece);
    }
  }
  return [...out];
}

/**
 * Whether a Latin term appears in the value as a whole word at all.
 *
 * The rule that catches `ID` → `IDA`: in this project `ID` never appears in a translation except
 * glued to more letters, because it was never the term — `IDA标签` was, and `ID` is the fragment the
 * phrase extractor left behind. A real translation into Latin script either contains the term as a
 * token (`ID` → `ID card`) or does not contain it at all (`ID` → `Identification`); only the glued
 * case means the source boundary is wrong.
 */
function isLatinTerm(term: string): boolean {
  return /^[\p{Script=Latin}\s'-]+$/u.test(term);
}

/**
 * Does this value actually mention the term — not merely contain its letters?
 *
 * `includes` is the wrong question for a Latin term, and answering it that way is what made the
 * first version suggest `ID → IDA`: `IDA Profile` contains `id`, so every translation counted as
 * the term left verbatim.
 */
function mentionsTerm(term: string, value: string): boolean {
  if (!isLatinTerm(term)) return value.toLowerCase().includes(term.toLowerCase());
  return appearsAsWholeWord(term, value);
}

/**
 * Scripts that write words without spaces *between* words of the same script.
 *
 * Chinese does not: `課程學習` is two words that nothing separates, so a Chinese candidate being
 * glued to the characters around it means nothing. Katakana and Hangul do: `コース` is a word, and
 * `ース` — a window cut out of it — is not, which is a difference the counting cannot see and the
 * script can.
 */
const SEGMENTED = /[\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * True when the wording never once stands on its own in the translations.
 *
 * This is what separates `コース` from `ース`: both appear in exactly the same three translations, so
 * they count identically, and only one of them is a word.
 */
function alwaysGlued(value: string, texts: string[]): boolean {
  if (!SEGMENTED.test(value)) return false;
  for (const text of texts) {
    for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + 1)) {
      const before = index > 0 ? text[index - 1]! : '';
      const after = text[index + value.length] ?? '';
      if (!SEGMENTED.test(before) && !SEGMENTED.test(after)) return false;
    }
  }
  return true;
}

function appearsAsWholeWord(term: string, value: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{Script=Latin}])${escaped}([^\\p{Script=Latin}]|$)`, 'iu').test(value);
}

/**
 * What this project already calls `term`, per locale.
 *
 * `occurrences` are the keys whose source contains the term; `background` is a sample of the keys
 * that do not. The background is what separates "this wording belongs to this term" from "this
 * wording is what every sentence in this project looks like" — without it, `的` and `Please` win
 * every count.
 */
export function mineTermTranslations(
  term: string,
  occurrences: TermOccurrence[],
  background: TermOccurrence[],
  locales: string[],
): MinedTerm {
  // The source side of the same rule. `ID` occurs 112 times in the project this was written
  // against — and every one of those occurrences is inside `IDA标签`, where the words are `IDA` and
  // `标签`. Counting those rows would answer a question about `ID` with statistics about `IDA`,
  // which is exactly how the first version proposed `ID → IDA`. Rows where the term is not a word of
  // its own are not occurrences of it.
  const latin = isLatinTerm(term);
  const isOccurrence = (row: TermOccurrence): boolean =>
    latin ? appearsAsWholeWord(term, row.source) : row.source.toLowerCase().includes(term.toLowerCase());
  // A term that is itself machinery (`%@`, `\n`, `{{count}}`) has no translation to find, and the
  // extractor's own filters are not the last line of defence: this is.
  if (MACHINERY.test(term)) return { term, suggestions: [], keepAsIs: false };

  const sample = occurrences.filter(isOccurrence).slice(0, MAX_OCCURRENCES);
  const rest = background.filter((row) => !isOccurrence(row)).slice(0, MAX_BACKGROUND);
  const suggestions: TermSuggestion[] = [];

  for (const locale of locales) {
    const withTerm = sample.map((row) => row.targets[locale]).filter((value): value is string => Boolean(value));
    // One example is an anecdote. Two that agree are still weak, which is why the count travels with
    // the suggestion and the count is what the reader sees.
    if (withTerm.length < 2) continue;

    const support = new Map<string, number>();
    for (const text of withTerm) {
      for (const wording of wordingsOf(text)) support.set(wording, (support.get(wording) ?? 0) + 1);
    }
    const backgroundTexts = rest.map((row) => row.targets[locale]).filter((value): value is string => Boolean(value));
    const elsewhere = new Map<string, number>();
    const backgroundChars = new Map<string, number>();
    for (const text of backgroundTexts) {
      for (const wording of wordingsOf(text)) elsewhere.set(wording, (elsewhere.get(wording) ?? 0) + 1);
      for (const char of new Set([...text])) backgroundChars.set(char, (backgroundChars.get(char) ?? 0) + 1);
    }
    const compared = backgroundTexts.length;

    // Left exactly as it is, the term is its own answer — and that beats every other candidate on
    // evidence, because a project that writes `LocaleHub` in every language has said what it means
    // as plainly as a project that writes `學習` does.
    const verbatim = withTerm.filter((value) => mentionsTerm(term, value) && !alwaysGlued(term, [value])).length;
    const verbatimRate = compared >= 5 ? (elsewhere.get(term) ?? 0) / compared : 0;
    if (verbatim / withTerm.length >= 0.5 && verbatimRate <= 0.2) {
      const exampleRow = sample.find((row) => mentionsTerm(term, row.targets[locale] ?? ''));
      suggestions.push({
        locale,
        value: term,
        example: { source: exampleRow?.source ?? term, target: exampleRow?.targets[locale] ?? term },
        support: verbatim,
        total: withTerm.length,
        elsewhere: elsewhere.get(term) ?? 0,
        compared,
      });
      continue;
    }

    const qualifying: { value: string; support: number; coverage: number; score: number; edge: number }[] = [];
    for (const [value, count] of support) {
      const coverage = count / withTerm.length;
      // Half is the floor: a wording that most translations do not use is not what the term means,
      // it is what one translator preferred.
      if (coverage < 0.5) continue;
      const rate = compared >= 5 ? (elsewhere.get(value) ?? 0) / compared : 0;
      // And a wording that is everywhere says nothing about *this* term. With too little background
      // to judge, the coverage floor has to carry it alone.
      if (compared >= 5 && rate > 0.2) continue;
      const score = coverage - rate;
      if (score < 0.35) continue;
      if (isLatinTerm(term) && value.toLowerCase().includes(term.toLowerCase()) && !appearsAsWholeWord(term, value)) continue;
      if (alwaysGlued(value, withTerm)) continue;

      // A wording whose first or last character is everywhere in the project is a wording cut across
      // a word boundary: `的學` out of `你的學習`, where `的` belongs to the word before the term.
      // The characters themselves say so, so no stopword list is needed.
      const chars = [...value];
      const edgeRate = (char: string | undefined): number =>
        compared >= 5 && char ? (backgroundChars.get(char) ?? 0) / compared : 0;
      const edge = Math.max(edgeRate(chars[0]), edgeRate(chars[chars.length - 1]));
      qualifying.push({ value, support: count, coverage, score, edge });
    }
    if (!qualifying.length) continue;

    // Best evidence first, then the smallest wording that carries it: `課程` rather than `課程學習`
    // and `your` rather than `your account`, because the longer one is the term with the sentence
    // around it still attached.
    const top = Math.max(...qualifying.map((item) => item.score));
    const group = qualifying.filter((item) => item.score >= top - 0.001);
    // Keep the wordings that do not contain another one: `課程` rather than `課程學習`, `your`
    // rather than `your account`. The longer one is the term with the sentence still attached.
    const minimal = group.filter((item) => !group.some((other) => other !== item && item.value.includes(other.value)));
    const pool = minimal.length ? minimal : group;
    pool.sort(
      (a, b) =>
        a.edge - b.edge ||
        b.coverage - a.coverage ||
        b.support - a.support ||
        // Shortest last, and only as a last resort: with the evidence equal, the smaller wording is
        // the term rather than the phrase around it.
        [...a.value].length - [...b.value].length ||
        a.value.localeCompare(b.value),
    );

    const best = pool[0]!;
    const exampleRow = sample.find((row) => (row.targets[locale] ?? '').includes(best.value));
    suggestions.push({
      locale,
      value: best.value,
      example: { source: exampleRow?.source ?? term, target: exampleRow?.targets[locale] ?? best.value },
      support: best.support,
      total: withTerm.length,
      elsewhere: elsewhere.get(best.value) ?? 0,
      compared,
    });
  }

  return {
    term,
    suggestions,
    keepAsIs: suggestions.length > 0 && suggestions.every((item) => item.value.toLowerCase() === term.toLowerCase()),
  };
}
