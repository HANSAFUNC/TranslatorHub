-- A sketch can be a board of frames (a page's states side by side), and its elements belong to named
-- components. Both belong on the marker: it is the row that says "this string, here", and the editor
-- groups and highlights by exactly these two things.
ALTER TABLE "screen_mockup_markers" ADD COLUMN "frame" TEXT;
ALTER TABLE "screen_mockup_markers" ADD COLUMN "component" TEXT;
