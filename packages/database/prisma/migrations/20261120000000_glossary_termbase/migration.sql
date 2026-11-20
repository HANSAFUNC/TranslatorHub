-- A termbase a project can be held to, rather than a list of suggestions.
--
-- What was missing was not a table — `glossary_terms` already carried a project scope — but the things
-- that make a term *fixed*: an identity (one row per term, so the same word cannot resolve two ways), a
-- state (a candidate a machine proposed is not the same as a term a reviewer approved), and an author.
--
-- `status` defaults to DRAFT on purpose. Existing rows and every new one start as drafts, which QA
-- treats exactly as it treats them today (a warning). Approving a term is what escalates a violation to
-- an error that blocks release, and that has to be somebody's decision rather than a migration's.
CREATE TYPE "TermStatus" AS ENUM ('DRAFT', 'APPROVED', 'DEPRECATED');

ALTER TABLE "glossary_terms"
  ADD COLUMN "status"            "TermStatus" NOT NULL DEFAULT 'DRAFT',
  -- A word that stays as it is in every language: a product name, an acronym, a legal entity.
  ADD COLUMN "do_not_translate"  BOOLEAN NOT NULL DEFAULT false,
  -- `{ "<locale>": ["bad", "worse"] }` — the "never translate it as this" list, which had nowhere to go.
  ADD COLUMN "forbidden_targets" JSONB,
  -- Project rows only: this row does not define a term, it switches an organisation term off here.
  ADD COLUMN "disabled"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "created_by_id"     UUID,
  ADD COLUMN "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The ground floor of "fixed": one project cannot hold the same term twice. Lowercased because a termbase
-- that treats `Course` and `course` as different entries is a termbase nobody can keep clean; a term that
-- genuinely needs case significance says so with `case_sensitive` instead.
--
-- Organisation rows are left out of the constraint: they are shared, and two projects may legitimately
-- want different casing of the same word while neither owns it.
CREATE UNIQUE INDEX "glossary_terms_project_term_key"
  ON "glossary_terms" ("project_id", lower("term"))
  WHERE "project_id" IS NOT NULL;
