-- What the caller asserts about a screen, so the report can stop reporting it.
--
-- `NO_PICTURES` fires when a page carries no picture at all, which is exactly right for artwork that
-- failed to travel and exactly wrong for a screen that is made of text and CSS. The finding's own
-- advice says to ignore it in that case, but an ignored finding still counts, so `clean` was
-- unreachable and a caller could not use it as a delivery gate.
--
-- Stored per row rather than applied at upload time: a page's report is recomputed on every read (see
-- `20261118` in docs/STATUS.md §1.50), so the declaration has to persist or the finding returns.
ALTER TABLE "screen_mockups" ADD COLUMN "expectations" JSONB;
