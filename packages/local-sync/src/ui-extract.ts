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
 * Everything a whole page may inline, which is wider than what a sketch inlines.
 *
 * A drawn sketch only ever needed pictures. A replica brings the page's own look with it, so
 * stylesheets and fonts matter as much as images do — a page whose font never arrived is a page that
 * looks like a different app.
 */
const ASSET_TYPES: Record<string, string> = {
  ...INLINE_TYPES,
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
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

/**
 * Bring a whole page's assets with it.
 *
 * A replica is rendered by the caller's own browser, so anything the page names by a *relative* path
 * is a file that only exists on the machine that made it: `./logo.png` in the viewer's browser is a
 * request against the platform's origin, which has never seen that file. Those become `data:` URIs
 * here, where the checkout is on disk. Remote `https:` URLs are left alone — the viewer's browser
 * fetching them is a decision the caller already made by writing them.
 *
 * Four places a page can name a file, and all four matter: `<img src>`, `srcset` (including
 * `<source>`), `<link rel=stylesheet href>`, and `url()` inside a stylesheet — which is where the
 * background images live. A linked stylesheet is inlined as a `<style>` block *and* has its own
 * `url()`s rewritten, because a rule that survived without its picture is a broken layout.
 */
export function inlinePageAssets(
  guard: WorkspaceGuard,
  source: string,
  pagePath: string,
): { source: string; inlined: string[]; skipped: { ref: string; why: string }[] } {
  const inlined: string[] = [];
  const skipped: { ref: string; why: string }[] = [];
  const directory = dirname(pagePath);

  /**
   * Read one referenced file and hand back a data: URI, or null when it is not ours to inline.
   *
   * `base` is what the reference is relative to, and it is not always the page: a URL inside a
   * stylesheet resolves against *that stylesheet*, so `url(pattern.png)` in `assets/app.css` means
   * `assets/pattern.png`, not `pattern.png` beside the page. Inlining with the wrong base silently
   * produced a broken background instead of a missing file.
   */
  const asDataUri = (reference: string, base: string = directory): string | null => {
    const value = reference.trim();
    if (!value || value.startsWith('data:') || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    const extension = extname(value.split('?')[0] ?? '').toLowerCase();
    const type = ASSET_TYPES[extension];
    if (!type) {
      skipped.push({ ref: value, why: `不认识的类型（${extension || '无扩展名'}）` });
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(guard.absolute(guard.assertReadable(join(base, value).replace(/^\.\//, ''))));
    } catch (error) {
      skipped.push({ ref: value, why: error instanceof Error ? error.message.slice(0, 80) : '读不到' });
      return null;
    }
    const uri = `data:${type};base64,${bytes.toString('base64')}`;
    if (uri.length > MAX_INLINE_IMAGE_CHARS) {
      skipped.push({ ref: value, why: `${Math.round(bytes.length / 1024)} KB，超过单文件上限` });
      return null;
    }
    inlined.push(value);
    return uri;
  };

  /** `url(...)` inside CSS text, which is how a background image is written. */
  const rewriteCss = (css: string, base: string = directory): string =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote: string, reference: string) => {
      const uri = asDataUri(reference, base);
      return uri ? `url(${uri})` : whole;
    });

  // 1. Linked stylesheets become <style> blocks, so the page needs no second request for them.
  let next = source.replace(
    /<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi,
    (whole) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(whole)?.[1];
      if (!href) return whole;
      const uri = asDataUri(href);
      if (!uri) return whole;
      // The data: URI is the file's bytes, base64'd; the CSS text is what has to go inside <style>.
      const css = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');
      inlined.pop();
      inlined.push(href);
      // Its own `url()`s resolve against the stylesheet's directory, not the page's.
      const base = dirname(join(directory, href).replace(/^\.\//, ''));
      return `<style data-from="${href}">\n${rewriteCss(css, base)}\n</style>`;
    },
  );

  // 2. Inline <style> blocks, whose url()s point at the same kind of files.
  next = next.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_whole, open: string, css: string, close: string) => `${open}${rewriteCss(css)}${close}`);

  // 3. Pictures and other media, including the responsive `srcset` form.
  next = next.replace(/\bsrc\s*=\s*(["'])([^"']+)\1/gi, (whole, quote: string, reference: string) => {
    const uri = asDataUri(reference);
    return uri ? `src=${quote}${uri}${quote}` : whole;
  });
  next = next.replace(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi, (whole, quote: string, list: string) => {
    const rewritten = list
      .split(',')
      .map((candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        if (!url) return candidate;
        const uri = asDataUri(url);
        return [uri ?? url, ...descriptor].join(' ');
      })
      .join(', ');
    return `srcset=${quote}${rewritten}${quote}`;
  });
  next = next.replace(/\bposter\s*=\s*(["'])([^"']+)\1/gi, (whole, quote: string, reference: string) => {
    const uri = asDataUri(reference);
    return uri ? `poster=${quote}${uri}${quote}` : whole;
  });

  return { source: next, inlined, skipped };
}
