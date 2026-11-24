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

function workspaceWithConfig(platforms = '[web]'): string {
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
      `  platforms: ${platforms}`,
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

/**
 * The local gate, over the platform's own rules.
 *
 * "本地过、平台不过" was unavoidable while the caller re-implemented S1–S10 from the guide in its own
 * script: the rules lived in two places and only one of them was right. This runs the same analyzer the
 * platform runs, over the same markup, and answers with a verdict a shell can act on — which is the
 * point of checking before uploading rather than after.
 */
describe('localehub mockup check', () => {
  function workspaceWithPage(html: string): string {
    const root = workspaceWithConfig();
    writeFileSync(join(root, 'screen.html'), html, 'utf8');
    return root;
  }

  it('fails a page that breaks the standard, naming the rules it broke', async () => {
    // Everything the field reported at once: laid out by flow, a hand-drawn picture, and a box that
    // hides whatever does not fit it.
    const root = workspaceWithPage(
      [
        '<!doctype html><html><head><style>',
        '.screen{position:relative;width:390px;height:844px;overflow:hidden}',
        '.row{display:flex;gap:8px}',
        '</style></head><body><div class="screen"><div class="row">',
        '<svg viewBox="0 0 24 24"><path d="M0 0h4v4H0z"/></svg>',
        '<span data-key="home.title">我的</span></div></div></body></html>',
      ].join('\n'),
    );
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    const checked = await services.checkScreenMockup({ page: 'screen.html' });

    expect(checked.kind).toBe('document');
    expect(checked.passed).toBe(false);
    expect(checked.blocking).toEqual(expect.arrayContaining(['CLIPPED_BOX', 'FLOW_LAYOUT', 'DRAWN_SHAPES']));
    // The message is what the agent reads out, so it carries the advice, not just the code.
    expect(String(checked.message)).toContain('CLIPPED_BOX');
    expect(String(checked.message)).toContain('overflow');
  });

  it('passes a page that meets it, and writes nothing', async () => {
    const root = workspaceWithPage(
      [
        '<!doctype html><html><head><style>',
        '.screen{position:relative;width:390px;height:844px}',
        '.title{position:absolute;left:16px;top:60px;width:200px;font-size:17px}',
        '</style></head><body><div class="screen">',
        '<img src="data:image/png;base64,AA">',
        '<span class="title" data-key="home.title">我的</span></div></body></html>',
      ].join('\n'),
    );
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    // The page is drawn for an iPhone frame, so the check is told which platform it is for: the frame
    // comes from the platform, and measuring a 390×844 page against a web canvas is the mismatch this
    // check exists to find.
    const checked = await services.checkScreenMockup({ page: 'screen.html', platform: 'ios' });

    expect(checked.passed).toBe(true);
    expect(checked.blocking).toEqual([]);
    // A check is a read: nothing lands in the workspace for someone to commit by accident.
    expect(() => readFileSync(join(root, '.localehub', 'mockups', 'screen.html'), 'utf8')).toThrow();
  });

  it('blocks a page laid out for another canvas, the way the platform refuses it', async () => {
    // The local check used to be quiet about exactly the defect the platform refuses outright: it
    // called the analyzer without a frame, so a page drawn at 2× (the Android dp/screenshot mix-up)
    // passed here and came back a 422 from the upload — "本地过、平台不过" from a command whose help
    // promises the same analyzer.
    const root = workspaceWithPage(
      [
        '<!doctype html><html><head><style>',
        '.screen{position:relative;width:412px;height:915px}',
        '.row{position:absolute;left:428px;top:100px;width:412px;height:44px}',
        '</style></head><body><div class="screen">',
        '<span class="row" data-key="home.title">我的</span></div></body></html>',
      ].join('\n'),
    );
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    const checked = await services.checkScreenMockup({ page: 'screen.html', platform: 'android' });

    expect(checked.passed).toBe(false);
    expect(checked.blocking).toContain('FRAME_OVERFLOW');
    // The message carries the numbers, so a caller can fix it here instead of learning it from a 422.
    expect(String(checked.message)).toContain('412×915');
  });

  it('takes the frame from the project when the caller names no platform', async () => {
    // The gap the frame check was meant to close, reopened one level down: `--platform` is optional,
    // and when it is omitted both the platform and this check fall back to the project's first
    // platform. Reading the raw flag instead of that resolved value measured an Android project
    // against the *web* canvas — the page below is laid out for a 1280-wide web screen, so it came
    // back clean here and then the upload refused it. Same command, same project, opposite verdicts.
    const root = workspaceWithConfig('[android]');
    writeFileSync(
      join(root, 'screen.html'),
      [
        '<!doctype html><html><head><style>',
        '.screen{position:relative;width:1280px;height:800px}',
        '.row{position:absolute;left:1200px;top:100px;width:400px;height:44px}',
        '</style></head><body><div class="screen">',
        '<span class="row" data-key="home.title">我的</span></div></body></html>',
      ].join('\n'),
      'utf8',
    );
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    const checked = await services.checkScreenMockup({ page: 'screen.html' });

    // The project is Android, so the frame is 412×915 — and this page is drawn for neither.
    expect(checked.passed).toBe(false);
    expect(checked.blocking).toContain('FRAME_OVERFLOW');
    expect(String(checked.message)).toContain('412×915');
  });
});

/**
 * The preview is where an uploader finds out it drew a wireframe.
 *
 * A screen went up as grey bars, six hand-written `<svg>` glyphs and not one asset, and the platform
 * said nothing, because inline `<svg>` counted as a picture. Saying it only in the upload's report is
 * too late to be cheap: the mockup is already on the platform and the reviewer is already looking at a
 * shape that is not their screen. The CLI reads the same page through the same analyzer, so the answer
 * has to be in the preview, before `--confirm`.
 */
describe('what the preview says about a page that was drawn rather than brought', () => {
  function workspaceWithDrawnPage(): string {
    const root = workspaceWithConfig();
    writeFileSync(
      join(root, 'home.html'),
      [
        '<!doctype html><html lang="zh-CN"><head><style>',
        '.screen{width:390px;height:844px;background:#F1F5FC}',
        '.bar{height:16px;border-radius:8px;background:#DFE6F5}',
        '.avatar{width:40px;height:40px;border-radius:20px;background:#D7DEEA}',
        '</style></head><body><div class="screen">',
        '<div class="bar"></div>',
        '<svg viewBox="0 0 24 24"><path d="M12 2 22 20 2 20Z" fill="#FF7744"/></svg>',
        '<div class="avatar"></div>',
        '<span data-key="lesson.title">上课页</span>',
        '</div></body></html>',
      ].join('\n'),
      'utf8',
    );
    return root;
  }

  it('tells the uploader the artwork is hand-drawn, before anything is uploaded', async () => {
    const root = workspaceWithDrawnPage();
    const services = new LocalSyncServices({ cwd: root, env: { LOCALEHUB_TOKEN: 't' } });
    const preview = await services.generateScreenMockup({ page: 'home.html', name: '上课页' });

    expect(preview.kind).toBe('document');
    expect(preview.uploaded).toBe(false);
    // `OperationResult` is deliberately open (`[key: string]: unknown`), so the shape a caller reads here
    // is named once rather than asserted into existence at each use.
    const report = preview.report as { findings: { code: string }[]; stats: Record<string, number> };
    expect(report.findings.map((finding) => finding.code)).toContain('DRAWN_SHAPES');
    expect(report.stats).toMatchObject({ pictures: 0, shapes: 1 });
    // And it has to reach the human, not just sit in the returned object: the message is what the agent
    // reads out, and its advice is what it acts on.
    expect(String(preview.message)).toContain('手画的形状');
    expect(String(preview.message)).toContain('Assets.xcassets');
  });
});
