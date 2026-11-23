import type { Prisma } from '@localehub/database';

import { resolveGlossary } from './glossary';
import { mineTermTranslations, type TermOccurrence, type TermSuggestion } from './term-mining';

/**
 * Mining a project's own vocabulary out of the sentences it has already written.
 *
 * This lives in the domain rather than in the route that first needed it because two surfaces now
 * ask the same question — the back office's "从已有译文抽候选" button and the Remote MCP tool an
 * agent calls — and the second one cannot be allowed to answer it differently. It is also the most
 * expensive read in the product (up to 5,000 keys, every candidate phrase in each, then a count
 * across every translation), so having one implementation is not only a consistency argument.
 */

/** One phrase that recurs, and what the project calls it. */
export interface TermCandidate {
  term: string;
  /** How many keys' source text contains it. */
  keyCount: number;
  /** One key it appears in, for a reader deciding whether it is a term at all. */
  exampleKey: string;
  suggestions: TermSuggestion[];
  keepAsIs: boolean;
}

export interface TermExtraction {
  candidates: TermCandidate[];
  /** How many keys were read — the denominator for everything above. */
  scannedKeys: number;
  minKeys: number;
  /** The languages a suggestion could be made in (the project's, minus its source). */
  locales: string[];
}

const PHRASE_EDGE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;

/**
 * The phrases a source string is made of, as candidates for a term.
 *
 * Deliberately over-generating — every 2–5 character run for CJK and every 1–3 word run otherwise —
 * because the frequency filter is what decides, and an extractor that tries to be clever about word
 * boundaries in a language it does not know just loses real terms. `maximalPhrases` then removes the
 * fragments.
 */
export function candidatePhrases(source: string): string[] {
  const out = new Set<string>();
  for (const match of source.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu)) {
    const run = match[0];
    for (let size = 2; size <= Math.min(5, run.length); size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) out.add(run.slice(start, start + size));
    }
  }
  // Every window, not every third one. Scanning with `(?:\s+word){0,2}` steps three words at a time, so
  // the two windows that straddle a boundary are never tried — which is why an English project came back
  // with no candidates at all while a Chinese one came back with twenty.
  const words = (source.match(/[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [])
    .map((word) => word.replace(PHRASE_EDGE, ''))
    .filter((word) => /^[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(word));
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= words.length; size += 1) {
      const phrase = words.slice(start, start + size).join(' ');
      if (phrase.length >= 4) out.add(phrase);
    }
  }
  return [...out].filter((phrase) => phrase.replace(PHRASE_EDGE, '').length >= 2);
}

/**
 * Drop the fragments.
 *
 * `课程` and `课程学习` come out of the same sentence, and listing both asks somebody to answer the same
 * question twice. A candidate that is contained in a longer one and is no more frequent is the longer
 * one's substring, not a term of its own.
 */
export function maximalPhrases<T extends { term: string; keys: Set<string> }>(candidates: T[]): T[] {
  const bounded = candidates.slice(0, 2000);
  return bounded.filter(
    (entry) =>
      !bounded.some(
        (other) =>
          other !== entry &&
          other.term.length > entry.term.length &&
          other.keys.size >= entry.keys.size &&
          other.term.includes(entry.term),
      ),
  );
}

type ExtractionReader = Pick<Prisma.TransactionClient, 'project' | 'translationKey' | 'glossaryTerm'>;

/**
 * What this project keeps saying, and what it already calls it.
 *
 * Reads the project's keys, finds the phrases they repeat, and for each one counts what the
 * translations of those keys actually say — see `term-mining.ts`. Terms the termbase already has are
 * left out: proposing to somebody what they decided last week is how a queue stops being read.
 */
export async function extractTermCandidates(
  tx: ExtractionReader,
  params: { organizationId: string; projectId: string; minKeys: number; limit: number },
): Promise<TermExtraction> {
  const project = await tx.project.findUnique({
    where: { id: params.projectId },
    select: { sourceLocale: true, locales: { select: { code: true } } },
  });
  const keys = await tx.translationKey.findMany({
    where: { projectId: params.projectId, archivedAt: null },
    select: {
      id: true,
      key: true,
      sourceVersions: { orderBy: { version: 'desc' }, take: 1, select: { value: true } },
      // The translations that make a suggestion possible at all. Only the target languages: the
      // source locale's own values are the source, and asking what a Chinese term is in Chinese is
      // the one answer that is always right and never useful.
      entries: { select: { localeCode: true, value: true } },
    },
    take: 5000,
  });
  const sourceLocale = project?.sourceLocale ?? '';
  const locales = (project?.locales ?? []).map((entry) => entry.code).filter((code) => code !== sourceLocale);
  const known = new Set(
    (await resolveGlossary(tx as never, { organizationId: params.organizationId, projectId: params.projectId })).map((term) =>
      term.term.toLowerCase(),
    ),
  );

  const rows: TermOccurrence[] = keys
    .map((row) => ({
      key: row.key,
      source: row.sourceVersions[0]?.value ?? '',
      targets: Object.fromEntries(
        row.entries
          .filter((entry) => entry.localeCode !== sourceLocale && entry.value)
          .map((entry) => [entry.localeCode, entry.value]),
      ),
    }))
    .filter((row) => row.source);

  const seen = new Map<string, { term: string; keys: Set<string>; example: string }>();
  for (const row of rows) {
    for (const candidate of candidatePhrases(row.source)) {
      const identity = candidate.toLowerCase();
      if (known.has(identity)) continue;
      const entry = seen.get(identity) ?? { term: candidate, keys: new Set<string>(), example: row.key };
      entry.keys.add(row.key);
      seen.set(identity, entry);
    }
  }

  const has = (source: string, term: string): boolean => source.toLowerCase().includes(term.toLowerCase());
  const candidates = maximalPhrases([...seen.values()].filter((entry) => entry.keys.size >= params.minKeys))
    // Longest first at equal frequency: `课程学习` says more than `课程`, and the shorter one is
    // almost always its substring showing up in the same sentences.
    .sort((a, b) => b.keys.size - a.keys.size || b.term.length - a.term.length || a.term.localeCompare(b.term))
    .slice(0, params.limit)
    .map((entry) => {
      // What the project already says this term is, per language, with the count that supports it.
      const occurrences = rows.filter((row) => has(row.source, entry.term));
      const background = rows.filter((row) => !has(row.source, entry.term)).slice(0, 300);
      const mined = mineTermTranslations(entry.term, occurrences, background, locales);
      return {
        term: entry.term,
        keyCount: entry.keys.size,
        exampleKey: entry.example,
        suggestions: mined.suggestions,
        keepAsIs: mined.keepAsIs,
      };
    });

  return { candidates, scannedKeys: rows.length, minKeys: params.minKeys, locales };
}
