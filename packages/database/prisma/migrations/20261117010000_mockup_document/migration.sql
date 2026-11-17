-- A screen may be a page the platform holds rather than a picture it drew.
--
-- The image column becomes nullable because a replica has no bytes of our own to store; `document`
-- holds the markup. Existing rows are untouched: they all have an image and no document.
ALTER TABLE "screen_mockups" ALTER COLUMN "image" DROP NOT NULL;
ALTER TABLE "screen_mockups" ADD COLUMN "document" JSONB;
