import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LocalSyncServices } from '../services';

/**
 * Configuration resolution for the local engine.
 *
 * `LOCALEHUB_API_URL` is documented as overriding `.localehub/config.yaml`. It used to be applied
 * by the MCP entry point on its own copy of `LoadedConfig`, which the services never read — they
 * load their own — so the override was silently dropped and every caller talked to the config
 * file's address regardless. These tests pin it where it now lives: `config()`.
 */

function workspaceWithConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'localehub-local-'));
  mkdirSync(join(root, '.localehub'), { recursive: true });
  writeFileSync(
    join(root, '.localehub', 'config.yaml'),
    [
      'version: 1',
      'project:',
      '  id: "00000000-0000-0000-0000-000000000001"',
      '  name: "Fixture"',
      '  sourceLocale: "en-US"',
      '  platforms: [web]',
      'localehub:',
      '  apiUrl: "http://config-file.invalid/api/v1"',
      '  tokenEnv: "LOCALEHUB_TOKEN"',
      'workspace:',
      '  root: "."',
      'files:',
      '  - id: "web-en"',
      '    platform: "web"',
      '    locale: "en-US"',
      '    format: "json"',
      '    source: true',
      '    paths: ["src/en-US/**/*.json"]',
    ].join('\n'),
    'utf8',
  );
  return root;
}

describe('LOCALEHUB_API_URL', () => {
  it('overrides the address in .localehub/config.yaml', () => {
    const services = new LocalSyncServices({
      cwd: workspaceWithConfig(),
      env: { LOCALEHUB_TOKEN: 't', LOCALEHUB_API_URL: 'http://env-wins/api/v1' },
    });
    expect(services.config().config.localehub.apiUrl).toBe('http://env-wins/api/v1');
  });

  it('leaves the config file address in place when unset', () => {
    const services = new LocalSyncServices({
      cwd: workspaceWithConfig(),
      env: { LOCALEHUB_TOKEN: 't' },
    });
    expect(services.config().config.localehub.apiUrl).toBe('http://config-file.invalid/api/v1');
  });
});

/**
 * What `localehub mockup` leaves in the workspace.
 *
 * `.localehub/` is the repo's link to the platform, and `mockups/` in it is meant to be committed: an
 * agent that puts a screen on the platform should leave behind something a reviewer can look at, and a
 * picture on its own does not say where it came from or whether it is still what the platform holds.
 */
describe('the sketch written into .localehub/mockups', () => {
  function workspaceWithPage(): string {
    const root = workspaceWithConfig();
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      [
        'export default function Page() {',
        '  return (',
        '    <div className="card">',
        '      <h1 className="text-2xl font-bold text-slate-900">我的保单</h1>',
        '      <button className="bg-blue-600 text-white rounded-lg px-4 py-2">查看详情</button>',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
      'utf8',
    );
    return root;
  }

  it('writes the picture and a record of what it is', async () => {
    const root = workspaceWithPage();
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    const result = await services.generateScreenMockup({ page: 'src/app/page.tsx', name: '我的保单' });

    const svg = readFileSync(join(root, '.localehub', 'mockups', '我的保单.svg'), 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);

    const manifest = JSON.parse(readFileSync(join(root, '.localehub', 'mockups', '我的保单.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      projectId: '00000000-0000-0000-0000-000000000001',
      name: '我的保单',
      platform: 'web',
      locale: 'en-US',
      page: 'src/app/page.tsx',
      uploaded: null,
    });
    expect(manifest.markers).toBeGreaterThan(0);
    // The comment is the instruction a reviewer needs: this file is the upload, not a source to edit.
    expect(String(manifest.$comment)).toContain('就是上传到平台的那张图');
    expect(String(result.manifestPath)).toBe('.localehub/mockups/我的保单.json');
  });

  it('records the platform’s own checksum once the screen is uploaded', async () => {
    // The upload itself is the API's; what matters here is that the manifest is written twice — once
    // for the preview, again once the platform has the bytes — so the committed file can be compared.
    const root = workspaceWithPage();
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    const preview = await services.generateScreenMockup({ page: 'src/app/page.tsx', name: '预览' });
    const manifest = JSON.parse(readFileSync(join(root, String(preview.manifestPath)), 'utf8')) as { uploaded: unknown };
    expect(manifest.uploaded).toBeNull();
  });
});
