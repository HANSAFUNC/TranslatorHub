import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { ErrorCode, LocaleHubError, MAX_INLINE_IMAGE_CHARS } from '@localehub/contracts';
import type { WorkspaceGuard } from '@localehub/workspace';

/**
 * Reading a page out of the workspace.
 *
 * The scanner itself — pure string work — lives in `@localehub/contracts`, because the API parses
 * HTML the same way and cannot import this package's filesystem code. What stays here is the one
 * part that needs a disk: resolving a path through the guard that bounds every other read.
 */

const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

/**
 * Bring the page's own pictures with it.
 *
 * The platform never fetches an image — a sketch that reached out to a URL would be a sketch that
 * leaks who is looking at it and when — so an image the page references has to travel inside the
 * payload. The CLI is the one place that has the repository on disk, so it reads the file and inlines
 * it, as long as it is small enough to be part of a picture rather than the whole thing. Anything
 * larger, missing, or outside the workspace is left alone and reported.
 */
export function inlineLocalImages(
  guard: WorkspaceGuard,
  source: string,
  pagePath: string,
): { source: string; inlined: string[]; skipped: { ref: string; why: string }[] } {
  const inlined: string[] = [];
  const skipped: { ref: string; why: string }[] = [];
  const directory = dirname(pagePath);

  const next = source.replace(/\bsrc\s*=\s*(["'])([^"']+)\1/g, (whole, _quote: string, reference: string) => {
    if (reference.startsWith('data:')) return whole;
    const extension = extname(reference.split('?')[0] ?? '').toLowerCase();
    const type = INLINE_TYPES[extension];
    if (!type) return whole;

    let bytes: Buffer;
    try {
      // Through the guard: the workspace allowlist is what decides whether this file may be read.
      const relativePath = join(directory, reference).replace(/^\.\//, '');
      bytes = readFileSync(guard.absolute(guard.assertReadable(relativePath)));
    } catch (error) {
      skipped.push({ ref: reference, why: error instanceof Error ? error.message.slice(0, 80) : '读不到' });
      return whole;
    }

    const base64 = `data:${type};base64,${bytes.toString('base64')}`;
    if (base64.length > MAX_INLINE_IMAGE_CHARS) {
      skipped.push({ ref: reference, why: `${Math.round(bytes.length / 1024)} KB，超过单图上限` });
      return whole;
    }
    inlined.push(reference);
    return `src=${JSON.stringify(base64)}`;
  });

  return { source: next, inlined, skipped };
}

/** Read a file from the workspace through the guard, so the boundary is the same as everywhere else. */
export function readPageFile(guard: WorkspaceGuard, relativePath: string): { source: string; fileName: string } {
  const rel = guard.assertReadable(relativePath);
  const absolute = guard.absolute(rel);
  let source: string;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new LocaleHubError(
      ErrorCode.INTERNAL_ERROR,
      `读不到 ${rel}：${error instanceof Error ? error.message : String(error)}`,
      400,
      { path: rel },
    );
  }
  return { source, fileName: rel };
}
