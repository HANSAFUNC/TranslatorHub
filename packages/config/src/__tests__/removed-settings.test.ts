import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../index';

/**
 * Settings that were removed, and the fact that the process says so.
 *
 * `AI_DEFAULT_POLICY` and three API-key variables went with the providers they configured. They are
 * no longer in the schema, and zod ignores unknown keys — so an environment file left over from
 * before the change would be *silently* ignored while the deployment quietly started using a
 * different provider. That is the failure this warning exists to prevent, which makes it worth a
 * test: an advisory that stops working is indistinguishable from one that was never needed.
 */

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  vi.restoreAllMocks();
});

/** An empty directory, so no real environment file is read into the test. */
function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'localehub-env-'));
}

function warningsFrom(load: () => void): string[] {
  const warnings: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  load();
  return warnings;
}

describe('settings that no longer do anything', () => {
  it('names every removed variable that is still set', () => {
    process.env.DATABASE_URL = 'postgresql://test/test';
    process.env.AI_DEFAULT_POLICY = 'anthropic';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

    const warnings = warningsFrom(() => loadEnv(emptyDir()));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('AI_DEFAULT_POLICY');
    expect(warnings[0]).toContain('OLLAMA_BASE_URL');
    // The one that is not set is not named — the list is what is actually there, not a fixed sentence.
    expect(warnings[0]).not.toContain('ANTHROPIC_API_KEY');
  });

  it('says nothing when the environment is clean', () => {
    process.env.DATABASE_URL = 'postgresql://test/test';

    expect(warningsFrom(() => loadEnv(emptyDir()))).toEqual([]);
  });
});
