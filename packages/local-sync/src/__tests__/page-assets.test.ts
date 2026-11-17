import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LocalConfig } from '@localehub/contracts';
import { WorkspaceGuard } from '@localehub/workspace';

import { inlinePageAssets } from '../ui-extract';

/**
 * A guard over a fixture directory.
 *
 * The CLI reads a page through this exact object, so a test that handed the inliner raw paths would
 * be testing a boundary the product never crosses: the workspace allowlist is what decides which file
 * may be read at all, and `..` or a symlink out of the root is refused there rather than here.
 */
function guardFor(root: string): WorkspaceGuard {
  const config = {
    version: 1,
    project: { id: '00000000-0000-0000-0000-000000000001', name: 'Fixture', sourceLocale: 'en-US', platforms: ['web'] },
    localehub: { apiUrl: 'http://localhost:3001/api/v1', tokenEnv: 'LOCALEHUB_TOKEN' },
    workspace: { root: '.', allowRead: ['**/*'], allowWrite: [], denyRead: [], denyWrite: [] },
    files: [],
  } as unknown as LocalConfig;
  return new WorkspaceGuard(config, root);
}

/**
 * A whole page's assets, coming along with it.
 *
 * This is the part only a checkout can do. The platform never fetches anything — that is the design,
 * not an omission — so a page that says `./logo.png` renders as a broken image in the viewer's
 * browser, which is pointed at the platform and has never seen that file. These pin what gets inlined,
 * what is deliberately left alone, and what the caller is told about the rest.
 */
function pageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'localehub-page-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  // A 1×1 PNG, so the data URI is a real one rather than a placeholder string.
  writeFileSync(
    join(root, 'assets', 'logo.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
  writeFileSync(join(root, 'assets', 'app.css'), '.card{background:#306eee;background-image:url(pattern.png)}', 'utf8');
  writeFileSync(join(root, 'assets', 'pattern.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(
    join(root, 'index.html'),
    [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./assets/app.css">',
      '<style>.hero{background-image:url("assets/logo.png")}</style>',
      '</head><body>',
      '<img src="./assets/logo.png" alt="">',
      '<img src="https://cdn.example.com/remote.png" alt="">',
      '<img srcset="./assets/logo.png 1x, ./assets/logo.png 2x" src="./assets/logo.png" alt="">',
      '<img src="./assets/missing.png" alt="">',
      '</body></html>',
    ].join('\n'),
    'utf8',
  );
  return root;
}

describe('inlinePageAssets', () => {
  it('carries the page’s own files, wherever the page names them', () => {
    const root = pageRoot();
    const guard = guardFor(root);
    const page = inlinePageAssets(guard, readPage(root), 'index.html');
    // One asset per place it appears, and the same file inlined in four shapes: a linked stylesheet
    // (which becomes a <style> block), a css url(), an <img src> and a srcset.
    expect(page.inlined).toContain('./assets/app.css');
    expect(page.inlined).toContain('./assets/logo.png');
    // The linked stylesheet becomes a <style> block holding its text, which is what makes the page
    // need no second request for it.
    expect(page.source).toContain('<style data-from="./assets/app.css">');
    expect(page.source).toContain('.card{background:#306eee');
    // The picture inside that stylesheet came along too — and it resolves against the *stylesheet's*
    // own directory, which is where `url(pattern.png)` points. A rule that survived without its image
    // is a broken layout, not a saved one.
    expect(page.source).toContain('url(data:image/png;base64,');
    expect(page.source).not.toContain('url(pattern.png)');
    expect(page.source).not.toContain('url("assets/logo.png")');
    // Nothing relative is left behind except the file that is genuinely missing.
    expect(page.source).not.toContain('src="./assets/logo.png"');
    expect(page.source).toContain('srcset="data:image/png;base64,');
  });

  it('leaves a remote URL alone, because fetching it is the caller’s decision', () => {
    const root = pageRoot();
    const guard = guardFor(root);
    const page = inlinePageAssets(guard, readPage(root), 'index.html');
    expect(page.source).toContain('https://cdn.example.com/remote.png');
    expect(page.skipped.map((entry) => entry.ref)).not.toContain('https://cdn.example.com/remote.png');
  });

  it('reports what it could not read instead of pretending the page is complete', () => {
    const root = pageRoot();
    const guard = guardFor(root);
    const page = inlinePageAssets(guard, readPage(root), 'index.html');
    const missing = page.skipped.find((entry) => entry.ref === './assets/missing.png');
    expect(missing, JSON.stringify(page.skipped)).toBeTruthy();
    expect(missing!.why.length).toBeGreaterThan(4);
    // The reference stays in the markup: rewriting it to nothing would hide the problem.
    expect(page.source).toContain('src="./assets/missing.png"');
  });
});

/** The fixture page, read the way the CLI reads it. */
function readPage(root: string): string {
  return readFileSync(join(root, 'index.html'), 'utf8');
}
