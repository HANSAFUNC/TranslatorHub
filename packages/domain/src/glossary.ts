import type { Prisma } from '@localehub/database';

/**
 * The terms that apply to a project, as one list.
 *
 * Three readers used to merge the two scopes themselves (`OR: [{ projectId }, { projectId: null }]`),
 * which meant a term that existed both organisation-wide and per project came back **twice** — QA
 * reported it twice, and when the two disagreed there was nothing to say which one the translator was
 * being held to. The merge is one rule, so it lives in one place.
 *
 * The rule, in full:
 *
 *   organisation row, no project row           → the organisation's term applies
 *   project row                                → the project's term applies, and says what it overrode
 *   project row with `disabled`                → the organisation's term is off *here*; nothing applies
 *   neither                                    → nothing applies
 *
 * "Disabled" exists so that switching off a company-wide term in one project does not require inventing
 * a same-named project row with an empty translation, which reads as a term rather than as an absence.
 */

/** The scopes a term can come from, in the order that decides. */
export type TermScope = 'organization' | 'project';

/** What a term is, once the two scopes have been reconciled. */
export interface ResolvedTerm {
  id: string;
  term: string;
  translations: Record<string, string>;
  caseSensitive: boolean;
  status: 'DRAFT' | 'APPROVED' | 'DEPRECATED';
  doNotTranslate: boolean;
  /** `{ "<locale>": ["never this"] }` */
  forbiddenTargets: Record<string, string[]>;
  scope: TermScope;
  /**
   * The organisation term this project row replaced, when there was one.
   *
   * Carried rather than dropped: "your project says 课程 → Course, the company says 课程 → Module" is a
   * thing somebody needs to see, and silently preferring one is how a termbase starts disagreeing with
   * itself.
   */
  overrides?: { term: string; translations: Record<string, string> };
}

/** Just enough of a Prisma client to read the two scopes. */
type GlossaryReader = Pick<Prisma.TransactionClient, 'glossaryTerm'>;

interface GlossaryRow {
  id: string;
  projectId: string | null;
  term: string;
  translations: unknown;
  caseSensitive: boolean;
  status: string;
  doNotTranslate: boolean;
  forbiddenTargets: unknown;
  disabled: boolean;
}

function asTranslations(value: unknown): Record<string, string> {
  return value && typeof value === 'object' ? (value as Record<string, string>) : {};
}

function asForbidden(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [locale, list] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(list)) out[locale] = list.filter((entry): entry is string => typeof entry === 'string');
  }
  return out;
}

/**
 * Every term that applies to this project, one row per term.
 *
 * Ordered by term so a UI and a QA run agree on the shape of the list without either sorting it.
 */
export async function resolveGlossary(
  tx: GlossaryReader,
  params: { organizationId: string; projectId: string },
): Promise<ResolvedTerm[]> {
  const rows = (await tx.glossaryTerm.findMany({
    where: {
      organizationId: params.organizationId,
      OR: [{ projectId: params.projectId }, { projectId: null }],
    },
    orderBy: { term: 'asc' },
  })) as unknown as GlossaryRow[];

  const organization = new Map<string, GlossaryRow>();
  const project = new Map<string, GlossaryRow>();
  for (const row of rows) {
    // Case-insensitively, matching the unique index: a termbase that treats `Course` and `course` as two
    // entries is one nobody can keep clean, and `caseSensitive` is how a term says it means the case.
    (row.projectId ? project : organization).set(row.term.toLowerCase(), row);
  }

  const names = [...new Set([...organization.keys(), ...project.keys()])].sort();
  const resolved: ResolvedTerm[] = [];
  for (const name of names) {
    const own = project.get(name);
    if (own?.disabled) continue; // switched off here, deliberately, with no replacement
    const shared = organization.get(name);
    const row = own ?? shared;
    if (!row) continue;

    const overridden = own && shared ? { term: shared.term, translations: asTranslations(shared.translations) } : undefined;
    resolved.push({
      id: row.id,
      term: row.term,
      translations: asTranslations(row.translations),
      caseSensitive: row.caseSensitive,
      status: (row.status as ResolvedTerm['status']) ?? 'DRAFT',
      doNotTranslate: row.doNotTranslate,
      forbiddenTargets: asForbidden(row.forbiddenTargets),
      scope: own ? 'project' : 'organization',
      ...(overridden ? { overrides: overridden } : {}),
    });
  }
  return resolved;
}

/**
 * The translation this term demands in one locale, or null when it is not applicable there.
 *
 * `doNotTranslate` answers with the source term itself, so a caller does not have to know about the flag
 * to hold a translator to it — and so that adding a language does not silently lose the rule.
 */
export function termTarget(term: ResolvedTerm, locale: string): string | null {
  if (term.doNotTranslate) return term.status === 'DEPRECATED' ? null : term.term;
  const value = term.translations?.[locale];
  return value ? value : null;
}
