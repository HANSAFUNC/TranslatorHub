import { readFileSync } from 'node:fs';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import type { WorkspaceGuard } from '@localehub/workspace';

/**
 * Reading a page out of the workspace.
 *
 * The scanner itself — pure string work — lives in `@localehub/contracts`, because the API parses
 * HTML the same way and cannot import this package's filesystem code. What stays here is the one
 * part that needs a disk: resolving a path through the guard that bounds every other read.
 */

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
