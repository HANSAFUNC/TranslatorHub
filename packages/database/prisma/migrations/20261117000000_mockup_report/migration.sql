-- What a reader would notice is missing from the sketch (no pictures, no colours from the page,
-- several frames that are copies of each other), with what to do about it. Written at upload so the
-- editor can show it without pulling the image bytes on every open.
ALTER TABLE "screen_mockups" ADD COLUMN "report" JSONB NOT NULL DEFAULT '[]';
