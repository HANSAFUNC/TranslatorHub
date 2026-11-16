-- The numbering the picture was drawn with. Kept on the mockup rather than recomputed from the
-- markers: the badges in the sketch and the list beside it have to agree, and only the render that
-- drew the numbers knows their order.
ALTER TABLE "screen_mockups" ADD COLUMN "legend" JSONB NOT NULL DEFAULT '[]';
