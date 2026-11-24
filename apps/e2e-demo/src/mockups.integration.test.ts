import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrismaClient } from '@localehub/database';
import { ensureApi, ensureRemoteMcp, type ApiHandle } from './api-harness';

/**
 * Screen mockups: a sketch of a UI, uploaded by an agent, read by the translation editor.
 *
 * What this suite pins is the contract between the two halves — the upload path (over MCP, and the
 * same thing over REST) and the editor's read path (list, markers joined with translations, image
 * bytes). The parts that are easy to get subtly wrong and invisible to a unit test:
 *
 *   - a marker pointing at a key the platform does not have is *stored and reported*, not rejected;
 *   - the image comes back under the content-type the server decided, with the headers that make
 *     serving an uploaded SVG safe;
 *   - the tool needs its scope, and a project id from the path is checked against the row;
 *   - re-uploading a screen replaces it, markers included, instead of piling up duplicates.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const MCP_PORT = 3035;
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let mcp: ApiHandle | null = null;
let client: Client | null = null;
let session = { email: '', password: '', token: '' };

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; requestId?: string };
}

async function call<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope<T>) : { success: false } };
}

/** The MCP result payload, unwrapped from the content block. */
function payload<T>(result: unknown): T {
  const blocks = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const block = blocks[0];
  return JSON.parse(block && block.type === 'text' && block.text ? block.text : '{}') as T;
}

function transport(token: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
}

/** A wireframe, small enough to inline: what a caller that *draws* a screen produces. */
const SKETCH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 667">
  <rect x="0" y="0" width="375" height="667" fill="#ffffff"/>
  <text x="24" y="96" font-size="24">Checkout</text>
  <text x="24" y="300" font-size="16">Your cart is empty</text>
  <rect x="24" y="580" width="327" height="48" rx="8" fill="#111111"/>
  <text x="150" y="610" font-size="16" fill="#ffffff">Pay now</text>
</svg>`;

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

const KEYS = ['checkout.title', 'checkout.empty', 'checkout.pay', 'checkout.missing'];

interface UploadResult {
  mockupId: string;
  name: string;
  replaced: boolean;
  /** Which artefact the platform stored: a picture it drew, or the page the caller sent. */
  kind: 'image' | 'document';
  image: { mimeType: string; byteSize: number; width: number | null; height: number | null; checksum: string };
  markers: {
    total: number;
    matchedKeys: number;
    unmatched: { key: string; namespace: string; reason: string }[];
    frames: { title: string; markers: number }[];
  };
  components: { index: number; name: string; count: number }[];
  report: { findings: { code: string; title: string; advice: string }[]; clean: boolean; stats?: Record<string, number> };
  imagePath: string;
}

async function uploadSketch(
  projectId: string,
  options: { name?: string; keys?: string[]; replace?: boolean; platform?: string } = {},
): Promise<UploadResult> {
  const keys = options.keys ?? KEYS;
  const result = await client!.callTool({
    name: 'upload_screen_mockup',
    arguments: {
      project_id: projectId,
      name: options.name ?? 'checkout',
      // `web`, because that is what the import above produced: `import_translations` takes its
      // `platform` per *file*, and a key's identity is (project, platform, namespace, key). A sketch
      // uploaded as `ios` would point at three keys the project does not have — which is exactly the
      // mistake this pairing is meant to catch, so the fixture says it out loud.
      platform: options.platform ?? 'web',
      locale: 'en-US',
      image_base64: base64(SKETCH),
      markers: keys.map((key, index) => ({
        key,
        x: 0.06,
        y: 0.1 + index * 0.08,
        width: 0.4,
        height: 0.04,
        text: key,
      })),
      replace: options.replace ?? true,
    },
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return payload<UploadResult>(result);
}

/** The REST upload, returning the raw status so a test can expect a refusal. */
async function uploadSketchRaw(
  projectId: string,
  options: { name: string; replace: boolean },
): Promise<{ status: number; body: Envelope<unknown> }> {
  return call(`/projects/${projectId}/mockups`, {
    method: 'POST',
    token: session.token,
    body: {
      name: options.name,
      platform: 'web',
      locale: 'en-US',
      imageBase64: base64(SKETCH),
      markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
      replace: options.replace,
    },
  });
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session = { email: `mockups-${runId}@localehub.dev`, password: 'mockups-password-123', token: '' };
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Mockup Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Mockup Org ${runId}`, slug: `mockups-${runId}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
    });
  } finally {
    await prisma.$disconnect();
  }

  const login = await call<{ token: string }>('/auth/login', {
    method: 'POST',
    body: { email: session.email, password: session.password },
  });
  session.token = login.body.data!.token;

  const issued = await call<{ token: string }>('/mcp-tokens', {
    method: 'POST',
    token: session.token,
    body: {
      name: 'mockup-suite',
      scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read'],
      projectIds: [],
      expiresInDays: 1,
    },
  });
  expect(issued.status, JSON.stringify(issued.body.error)).toBe(201);

  mcp = await ensureRemoteMcp(MCP_PORT, { root: ROOT });
  client = new Client({ name: 'mockup-suite', version: '0.0.0' });
  await client.connect(transport(issued.body.data!.token));
}, 180_000);

afterAll(async () => {
  await client?.close();
  await mcp?.stop();
  await api?.stop();
});

describe('screen mockups', () => {
  let projectId: string;

  beforeAll(async () => {
    const created = await client!.callTool({
      name: 'create_project',
      arguments: { name: `Sketch ${runId}`, source_locale: 'en-US', locales: ['ja-JP'], platforms: ['web', 'ios'] },
    });
    projectId = payload<{ project: { id: string } }>(created).project.id;

    const imported = await client!.callTool({
      name: 'import_translations',
      arguments: {
        project_id: projectId,
        confirm: true,
        files: [
          {
            path: 'ios/en-US/Localizable.strings',
            locale: 'en-US',
            platform: 'ios',
            entries: [
              { key: 'checkout.title', value: 'Checkout' },
              { key: 'checkout.empty', value: 'Your cart is empty' },
              { key: 'checkout.pay', value: 'Pay now' },
            ],
          },
          {
            path: 'ios/ja-JP/Localizable.strings',
            locale: 'ja-JP',
            platform: 'ios',
            entries: [
              { key: 'checkout.title', value: 'お会計' },
              { key: 'checkout.pay', value: '支払う' },
            ],
          },
        ],
      },
    });
    expect(imported.isError, JSON.stringify(imported.content)).toBeFalsy();
  }, 120_000);

  it('stores a sketch, reads its size from the file, and matches markers to keys', async () => {
    const result = await uploadSketch(projectId);

    expect(result.replaced).toBe(false);
    expect(result.image.mimeType).toBe('image/svg+xml');
    // The viewBox in the file, not anything the caller said.
    expect(result.image.width).toBe(375);
    expect(result.image.height).toBe(667);
    expect(result.markers.total).toBe(4);
    expect(result.markers.matchedKeys).toBe(3);
    // A marker for a key the platform has not imported is a fact about the UI, not an error.
    expect(result.markers.unmatched).toEqual([{ key: 'checkout.missing', namespace: '', reason: 'KEY_NOT_IMPORTED' }]);
    // Relative to the API base, because the browser client adds its own base to whatever it is given:
    // an absolute path here resolved to `/api/v1/api/v1/...` and the editor showed a broken sketch.
    expect(result.imagePath).toBe(`/projects/${projectId}/mockups/${result.mockupId}/image`);
    expect(result.imagePath.startsWith('/api/v1')).toBe(false);
  }, 60_000);

  it('serves the image under the type it decided, with the headers that make an SVG safe to serve', async () => {
    const list = await call<{ id: string; width: number | null; markerCount: number }[]>(`/projects/${projectId}/mockups`, {
      token: session.token,
    });
    const mockup = list.body.data!.find((row) => row.width === 375)!;
    expect(mockup.markerCount).toBe(4);

    const response = await fetch(`${API_BASE}/projects/${projectId}/mockups/${mockup.id}/image`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // The sketch is an uploaded document: without this, a browser opened directly on the URL would
    // run whatever it contains, on the API's own origin.
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(await response.text()).toContain('Pay now');

    const etag = response.headers.get('etag')!;
    const revalidated = await fetch(`${API_BASE}/projects/${projectId}/mockups/${mockup.id}/image`, {
      headers: { authorization: `Bearer ${session.token}`, 'if-none-match': etag },
    });
    expect(revalidated.status).toBe(304);
  }, 60_000);

  it('joins every marker with the source text and the translation of the locale being reviewed', async () => {
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;

    const detail = await call<{
      mockup: { name: string; width: number | null; markerCount: number };
      markers: {
        key: string;
        y: number;
        text: string | null;
        source: string | null;
        entry: { value: string; status: string; entryId: string } | null;
      }[];
    }>(`/projects/${projectId}/mockups/${mockupId}?locale=ja-JP`, { token: session.token });

    expect(detail.status).toBe(200);
    const markers = detail.body.data!.markers;
    // Reading order, top to bottom: the dialog's numbered badges follow the screen, not the upload.
    expect(markers.map((marker) => marker.y)).toEqual([...markers.map((marker) => marker.y)].sort((a, b) => a - b));

    const title = markers.find((marker) => marker.key === 'checkout.title')!;
    expect(title.source).toBe('Checkout');
    expect(title.entry?.value).toBe('お会計');

    // Imported source, no Japanese yet: source present, entry absent. Different from "no such key".
    const empty = markers.find((marker) => marker.key === 'checkout.empty')!;
    expect(empty.source).toBe('Your cart is empty');
    expect(empty.entry).toBeNull();

    const missing = markers.find((marker) => marker.key === 'checkout.missing')!;
    expect(missing.source).toBeNull();
    expect(missing.entry).toBeNull();
  }, 60_000);

  it('tells the editor which screen shows the entry it has selected', async () => {
    const withKey = await call<{ name: string; containsKey: boolean }[]>(`/projects/${projectId}/mockups?key=checkout.pay`, {
      token: session.token,
    });
    expect(withKey.body.data!).toHaveLength(1);
    expect(withKey.body.data![0]!.containsKey).toBe(true);

    const withoutKey = await call<{ containsKey: boolean }[]>(`/projects/${projectId}/mockups?key=checkout.absent`, {
      token: session.token,
    });
    // The screen is still listed: "no sketch marks this key" is the answer, not "no sketches exist".
    expect(withoutKey.body.data!).toHaveLength(1);
    expect(withoutKey.body.data![0]!.containsKey).toBe(false);
  }, 60_000);

  it('replaces a screen on re-upload rather than piling up markers', async () => {
    const second = await uploadSketch(projectId, { keys: ['checkout.title', 'checkout.empty'] });
    expect(second.replaced).toBe(true);

    const list = await call<{ id: string; markerCount: number }[]>(`/projects/${projectId}/mockups`, {
      token: session.token,
    });
    expect(list.body.data!).toHaveLength(1);
    expect(list.body.data![0]!.markerCount).toBe(2);
    expect(list.body.data![0]!.id).toBe(second.mockupId);

    // Put the fuller sketch back for the tests that follow.
    await uploadSketch(projectId);
  }, 60_000);

  it('refuses to overwrite when the caller says not to', async () => {
    // Same name *and* platform as the screen above: a screen's identity is the pair, so a `checkout`
    // sketch for another platform is a different screen and is not a collision.
    const result = await client!.callTool({
      name: 'upload_screen_mockup',
      arguments: {
        project_id: projectId,
        name: 'checkout',
        platform: 'web',
        locale: 'en-US',
        image_base64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        replace: false,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CONFLICT');
  }, 60_000);

  it('refuses an SVG that could act as a script, naming the construct to remove', async () => {
    const result = await client!.callTool({
      name: 'upload_screen_mockup',
      arguments: {
        project_id: projectId,
        name: 'hostile',
        platform: 'ios',
        locale: 'en-US',
        image_base64: base64('<svg onload="alert(1)"><rect width="10" height="10"/></svg>'),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        replace: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('事件属性');
  }, 60_000);

  it('refuses pixel coordinates, the mistake a caller measuring the image makes', async () => {
    const result = await client!.callTool({
      name: 'upload_screen_mockup',
      arguments: {
        project_id: projectId,
        name: 'pixels',
        platform: 'ios',
        locale: 'en-US',
        image_base64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 24, y: 96 }],
        replace: true,
      },
    });
    expect(result.isError).toBe(true);
  }, 60_000);

  it('accepts the same upload over REST, so the flow does not require an MCP client', async () => {
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'settings',
        platform: 'web',
        locale: 'en-US',
        imageBase64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
        replace: true,
      },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.markers.matchedKeys).toBe(1);

    const list = await call<{ name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    expect(list.body.data!.map((row) => row.name)).toContain('settings');
    expect(list.body.data!.filter((row) => row.name === 'checkout')).toHaveLength(1);
  }, 60_000);

  it('accepts the page’s own HTML and draws it, without running anything in it', async () => {
    // The third input: an agent that has the page's markup hands it over, and the platform reads it
    // into an element tree — layout, colours and markers all from that one pass.
    // `data-key` is how markup names the key its text belongs to — HTML has no `t('…')` call, and
    // without it a marker's key is the raw text, which only matches a project keyed by source string.
    const html = `<style>.card { background: #f8fafc; border-radius: 12px; padding: 16px }</style>
      <body><div class="card">
        <h1 class="text-xl font-bold" data-key="checkout.title">Checkout</h1>
        <p class="text-sm text-zinc-500" data-key="checkout.empty">Your cart is empty</p>
        <button class="bg-blue-600 text-white rounded-lg px-4 py-2" data-key="checkout.pay">Pay now</button>
        <script>window.tracked = true</script>
      </div></body>`;
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: { name: 'checkout-html', platform: 'web', locale: 'en-US', html, replace: true },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    // Three visible strings became three markers, matched by the keys the markup named.
    expect(response.body.data!.markers.total).toBe(3);
    expect(response.body.data!.markers.matchedKeys).toBe(3);
    expect(response.body.data!.markers.unmatched).toEqual([]);
    expect(response.body.data!.image.mimeType).toBe('image/svg+xml');

    const detail = await call<{ markers: { key: string; text: string }[] }>(
      `/projects/${projectId}/mockups/${response.body.data!.mockupId}`,
      { token: session.token },
    );
    expect(detail.body.data!.markers.map((marker) => marker.text)).toEqual(['Checkout', 'Your cart is empty', 'Pay now']);

    const image = await fetch(`${API_BASE}${response.body.data!.imagePath}`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const svg = await image.text();
    expect(svg).toContain('#2563eb'); // the button's colour, from the page's own class
    expect(svg).not.toContain('window.tracked');
    expect(svg).not.toContain('<script');
  }, 60_000);

  it('keeps a whole page as it was sent, and serves it back as a page', async () => {
    // The replica path: a full document is not read into an element tree and redrawn — it is stored
    // and rendered by a browser. The two things that has to be true of it are what this checks: the
    // markup survives verbatim (scripts included, so the page is the caller's page), and the platform
    // serves it under a policy that makes it a picture rather than a program.
    const html = `<!doctype html><html lang="en"><head><style>.card{background:#f8fafc;border-radius:12px}</style></head>
      <body><div class="card" data-component="policy-card">
        <h1 data-key="checkout.title">Checkout</h1>
        <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" alt="">
        <button data-key="checkout.pay">Pay now</button>
        <script>window.tracked = true</script>
      </div></body></html>`;
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: { name: 'checkout-replica', platform: 'web', locale: 'en-US', document: html, replace: true },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.kind).toBe('document');
    expect(response.body.data!.imagePath).toMatch(/\/document$/);
    // Two keys in the markup, both already imported: the replica's markers come from the attributes.
    expect(response.body.data!.markers.total).toBe(2);
    expect(response.body.data!.markers.matchedKeys).toBe(2);
    expect(response.body.data!.markers.unmatched).toEqual([]);

    const detail = await call<{ mockup: { kind: string; frames: string[]; imagePath: string }; markers: { key: string; component: string | null }[] }>(
      `/projects/${projectId}/mockups/${response.body.data!.mockupId}`,
      { token: session.token },
    );
    expect(detail.body.data!.mockup.kind).toBe('document');
    expect(detail.body.data!.mockup.frames).toEqual(['默认']);
    // The component the markup named is what the legend beside the page is built from.
    expect(detail.body.data!.markers.map((marker) => marker.component)).toEqual(['policy-card', 'policy-card']);

    const page = await fetch(`${API_BASE}${response.body.data!.imagePath}`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const served = await page.text();
    // Verbatim: the stylesheet, the inlined picture and the script all travelled, because what the
    // caller sent is what the page is. The script never runs — that is the policy's job below.
    expect(served).toContain('.card{background:#f8fafc');
    expect(served).toContain('data:image/svg+xml;base64,');
    expect(served).toContain('window.tracked');
    const policy = page.headers.get('content-security-policy') ?? '';
    expect(policy).toContain('sandbox allow-same-origin');
    expect(policy).not.toContain('allow-scripts');
    expect(policy).toContain("default-src 'none'");

    // The image route says where to look instead of answering with something that is not an image.
    const asImage = await fetch(`${API_BASE}/projects/${projectId}/mockups/${response.body.data!.mockupId}/image`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(asImage.status).toBe(409);

    // And it is the report that tells the caller what the page still needs: this one brought its own
    // style and its picture, so the only thing left to say is that the script will not run.
    const report = response.body.data!.report as { findings: { code: string }[]; stats: { keys?: number; scripts?: number } };
    expect(report.stats.keys).toBe(2);
    expect(report.stats.scripts).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual(['SCRIPTS_NOT_RUN']);
  }, 60_000);

  it('reads a stored page back through today’s rules, not the ones it was uploaded under', async () => {
    // A screen went up as a wireframe — grey bars for text, hand-drawn paths for its pictures — and the
    // platform blessed it: "clean: true", nothing to say. Not because the page was good, but because the
    // report was computed under an older rule set, when a hand-drawn `<svg>` still counted as a picture.
    // A stored report is a cached verdict, and a verdict that outlives the rules tells the caller
    // everything is fine about a picture that looks nothing like the app. So a page is re-read on read:
    // it costs a parse of markup the row already holds, and it means every improvement to the rules
    // reaches everything already uploaded rather than only the next upload.
    const html = `<!doctype html><html lang="en"><head><style>.banner{background:#E8ECF5;height:96px}</style></head>
      <body><div class="banner"></div>
      <svg viewBox="0 0 24 24"><path d="M0 0h4v4H0z" fill="#A9B4C7"/></svg>
      <p data-key="checkout.title">Checkout</p></body></html>`;
    const uploaded = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: { name: 'stale-report', platform: 'web', locale: 'en-US', document: html, replace: true },
    });
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201);
    const mockupId = uploaded.body.data!.mockupId;

    // What the older rules left in the row: `pictures` counted the drawn shape, so there was nothing
    // to report and `clean` came out true.
    const prisma = new PrismaClient();
    try {
      // `SET LOCAL`, so the bypass only exists inside this transaction — and the row count is checked,
      // because a test whose arrange step quietly matches nothing passes for the wrong reason.
      const rewritten = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        return tx.$executeRaw`
          UPDATE screen_mockups SET report = ${JSON.stringify({
            clean: true,
            findings: [],
            stats: { pictures: 2, placeholders: 0, sourceColours: 1, frames: 1, markers: 1, missingKeys: 0, components: 0 },
          })}::jsonb
          WHERE id = ${mockupId}::uuid`;
      });
      expect(rewritten).toBe(1);
    } finally {
      await prisma.$disconnect();
    }

    const detail = await call<{ mockup: { report: { clean: boolean; findings: { code: string }[]; stats: { pictures: number; shapes?: number } } } }>(
      `/projects/${projectId}/mockups/${mockupId}`,
      { token: session.token },
    );
    const report = detail.body.data!.mockup.report;
    expect(report.findings.map((finding) => finding.code)).toContain('DRAWN_SHAPES');
    expect(report.clean).toBe(false);
    // And the counts agree with the finding: no picture was brought, one shape was drawn.
    expect(report.stats.pictures).toBe(0);
    expect(report.stats.shapes).toBe(1);
  }, 60_000);

  it('lets a caller declare that a screen has no pictures, and keeps the declaration', async () => {
    // The dead end a caller hit: a dialog made of text and rounded corners really does have no artwork,
    // the finding's own advice said to ignore it, and an ignored finding still counts — so `clean` was
    // unreachable and could not be used as a delivery gate. The declaration has to survive a re-read,
    // because a page's report is recomputed on every read.
    const html = `<!doctype html><html lang="en"><head><style>.dialog{background:#fff;border-radius:12px;color:#333}</style></head>
      <body><div class="dialog" data-component="ConfirmDialog" data-key="checkout.title">Delete this file?</div></body></html>`;

    const plain = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: { name: 'no-images-plain', platform: 'web', locale: 'en-US', document: html, replace: true },
    });
    expect(plain.status, JSON.stringify(plain.body.error)).toBe(201);
    const plainReport = plain.body.data!.report as { clean: boolean; findings: { code: string }[] };
    expect(plainReport.findings.map((finding) => finding.code)).toContain('NO_PICTURES');
    expect(plainReport.clean).toBe(false);

    const declared = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: { name: 'no-images-declared', platform: 'web', locale: 'en-US', document: html, replace: true, expect_no_images: true },
    });
    expect(declared.status, JSON.stringify(declared.body.error)).toBe(201);
    const declaredReport = declared.body.data!.report as unknown as { clean: boolean; findings: { code: string }[]; stats: { pictures: number } };
    expect(declaredReport.findings.map((finding) => finding.code)).not.toContain('NO_PICTURES');
    expect(declaredReport.clean).toBe(true);
    // A declaration changes the verdict, not the facts: the page still brought no pictures.
    expect(declaredReport.stats.pictures).toBe(0);

    // And it is still true on the next read, which is where a declaration kept only for one request
    // would have let the finding come back.
    const detail = await call<{ mockup: { report: { clean: boolean; findings: { code: string }[] } } }>(
      `/projects/${projectId}/mockups/${declared.body.data!.mockupId}`,
      { token: session.token },
    );
    expect(detail.body.data!.mockup.report.findings.map((finding) => finding.code)).not.toContain('NO_PICTURES');
    expect(detail.body.data!.mockup.report.clean).toBe(true);
  }, 60_000);

  it('answers, for a whole project, which screens have strings nothing is attached to', async () => {
    // What a caller uploading screen after screen otherwise keeps a ledger for: which pages are up, how
    // many of each one's strings point at a key the project does not have, when each was last touched.
    // `qa/issues` is about translations and never covered the screens.
    const html = `<!doctype html><html><body><div data-component="Card">
      <span data-key="checkout.title">Checkout</span>
      <span data-key="not.imported.anywhere">Nothing</span></div></body></html>`;
    const uploaded = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: { name: 'unmatched-probe', platform: 'web', locale: 'en-US', document: html, replace: true },
    });
    expect(uploaded.status, JSON.stringify(uploaded.body.error)).toBe(201);

    const list = await call<{ id: string; name: string; unmatchedKeys?: number; findings?: string[]; markerCount: number }[]>(
      `/projects/${projectId}/mockups?include=unmatched`,
      { token: session.token },
    );
    expect(list.status, JSON.stringify(list.body.error)).toBe(200);
    const row = list.body.data!.find((entry) => entry.name === 'unmatched-probe')!;
    // One of the two markers points at a key the project does not have — counted, not guessed at.
    expect(row.markerCount).toBe(2);
    expect(row.unmatchedKeys).toBe(1);
    expect(Array.isArray(row.findings)).toBe(true);

    // And without the flag the list stays the cheap shape it was: a list of screens, not a report.
    const plain = await call<{ unmatchedKeys?: number }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    expect(plain.body.data!.every((entry) => entry.unmatchedKeys === undefined)).toBe(true);
  }, 60_000);

  it('refuses a page with no keys to hang translations on, and says what to add', async () => {    const response = await call(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'checkout-no-keys',
        platform: 'web',
        locale: 'en-US',
        document: '<!doctype html><html><body><p>没有 key 的页面</p></body></html>',
        replace: true,
      },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error)).toContain('data-key');
  }, 30_000);

  it('draws a screen’s states as frames on one canvas, and keeps the components it is made of', async () => {
    // The whole point of a board: a translator sees that the same key reads differently — or is not
    // there at all — in the empty state, and which component each string sits in.
    const frame = (title: string, body: string): { title: string; html: string } => ({
      title,
      html: `<nav class="navbar"><h1>Checkout</h1></nav><div class="policy-card">${body}</div>`,
    });
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'checkout-states',
        platform: 'web',
        locale: 'en-US',
        frames: [
          frame('默认', '<span>Your cart is empty</span><button class="primary-button">Pay now</button>'),
          frame('加载中', '<span>Loading…</span>'),
        ],
        replace: true,
      },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    // One frame per state, each reporting its own markers.
    // Each frame carries its own nav title, so three strings in the first state (title, empty text,
    // button) and two in the second (title, loading text).
    expect(response.body.data!.markers.frames).toEqual([
      { title: '默认', markers: 3 },
      { title: '加载中', markers: 2 },
    ]);
    // The components are numbered for the legend, in the order the picture first draws them.
    expect(response.body.data!.components.map((item) => item.name)).toEqual(['navbar', 'policy-card', 'primary-button']);
    // The canvas is two frames wide, not one viewport.
    expect(response.body.data!.image.width).toBeGreaterThan(1400);

    // The platform says what is wrong with what it just drew, rather than leaving the caller to
    // discover it by looking at a grey picture: no pictures here, no colours of the page's own, and
    // the same content in both frames.
    const codes = (response.body.data!.report.findings as { code: string }[]).map((finding) => finding.code);
    expect(codes).toContain('NO_SOURCE_COLOURS');
    expect(codes).toContain('NO_PICTURES');
    expect(codes.every((code) => typeof code === 'string')).toBe(true);

    const detail = await call<{ mockup: { components: { name: string }[]; report: { findings: unknown[] } }; markers: { key: string; frame: string | null; component: string | null }[] }>(
      `/projects/${projectId}/mockups/${response.body.data!.mockupId}`,
      { token: session.token },
    );
    const states = [...new Set(detail.body.data!.markers.map((marker) => marker.frame))];
    expect(states).toEqual(['默认', '加载中']);
    // A string inside the card belongs to the card, which is what the editor highlights by.
    expect(detail.body.data!.markers.filter((marker) => marker.component === 'policy-card').length).toBeGreaterThan(0);
    expect(detail.body.data!.mockup.components.map((item) => item.name)).toEqual(['navbar', 'policy-card', 'primary-button']);
    // The same report comes back when the editor opens the screen later.
    expect(detail.body.data!.mockup.report.findings.length).toBeGreaterThan(0);
  }, 60_000);

  it('refuses frames together with a single-screen input, so the board is unambiguous', async () => {
    const response = await call<unknown>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'both-shapes',
        platform: 'web',
        locale: 'en-US',
        html: '<div><p>Checkout</p></div>',
        frames: [{ title: '默认', html: '<div><p>Checkout</p></div>' }],
        replace: true,
      },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error)).toContain('frames');
  }, 60_000);

  it('refuses two input shapes at once, naming all three', async () => {
    const response = await call<unknown>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'both',
        platform: 'web',
        locale: 'en-US',
        html: '<div><p>Checkout</p></div>',
        imageBase64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.2 }],
        replace: true,
      },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error)).toContain('只用一种输入');
  }, 60_000);

  it('accepts a realistic payload over REST, which the default 100 kB body limit would not', async () => {
    // A wireframe that carries its own detail is a few hundred kilobytes, and a base64 image is ~4/3
    // its bytes — over Express's default `json` limit of 100 kB. The padded comment keeps the SVG a
    // real, renderable image while pushing the request past that boundary.
    const padded = SKETCH.replace('</svg>', `<!--${'x'.repeat(180 * 1024)}--></svg>`);
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'large',
        platform: 'web',
        locale: 'en-US',
        imageBase64: base64(padded),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
        replace: true,
      },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.image.byteSize).toBeGreaterThan(180 * 1024);
  }, 60_000);

  it('records the upload in the audit trail, with the format the server actually read', async () => {
    const audit = await call<{ action: string; metadata: Record<string, unknown> }[]>(
      '/organization/audit?action=mockup.',
      { token: session.token },
    );
    const uploads = audit.body.data!.filter((row) => row.action === 'mockup.upload');
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.some((row) => row.metadata.detectedMimeType === 'image/svg+xml')).toBe(true);
    expect(uploads.some((row) => row.metadata.via === 'upload_screen_mockup')).toBe(true);
    expect(uploads.some((row) => row.metadata.via === 'api')).toBe(true);
  }, 60_000);

  it('needs sync.push, so a read-only token cannot plant a sketch on the platform', async () => {
    const readOnly = await call<{ token: string }>('/mcp-tokens', {
      method: 'POST',
      token: session.token,
      body: { name: 'mockup-readonly', scopes: ['project.read', 'translation.read'], projectIds: [projectId], expiresInDays: 1 },
    });

    const scoped = new Client({ name: 'mockup-readonly', version: '0.0.0' });
    await scoped.connect(transport(readOnly.body.data!.token));
    try {
      const result = await scoped.callTool({
        name: 'upload_screen_mockup',
        arguments: {
          project_id: projectId,
          name: 'escalation',
          platform: 'ios',
          locale: 'en-US',
          image_base64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
          replace: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('SCOPE_INSUFFICIENT');
    } finally {
      await scoped.close();
    }

    const list = await call<{ name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    expect(list.body.data!.some((row) => row.name === 'escalation')).toBe(false);
  }, 120_000);

  it('checks the project id in the path against the row rather than trusting it', async () => {
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;

    const correct = await fetch(`${API_BASE}/projects/${projectId}/mockups/${mockupId}/image`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(correct.status).toBe(200);

    // The same screen id under a project that does not own it: 404, not the bytes.
    const wrongProject = await fetch(
      `${API_BASE}/projects/00000000-0000-0000-0000-000000000000/mockups/${mockupId}/image`,
      { headers: { authorization: `Bearer ${session.token}` } },
    );
    expect(wrongProject.status).toBe(404);
  }, 60_000);

  describe('the project has to belong to the caller', () => {
    /**
     * Another organization, and a project in it.
     *
     * The upload used to check the role on the *path's* project id and then write with whatever id it
     * was given. RLS made the foreign row invisible to its owner but does not scope the unique index
     * `(project_id, platform, name)`, so an upload against this project would occupy one of its
     * screen names permanently — the owner would see `CONFLICT` on a name no screen of theirs uses.
     */
    let foreign: { projectId: string };

    beforeAll(async () => {
      const prisma = new PrismaClient();
      try {
        const { hashPassword } = await import('@localehub/domain');
        const other = { email: `mockups-other-${runId}@localehub.dev`, password: 'mockups-other-password' };
        const passwordHash = await hashPassword(other.password);
        foreign = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
          const user = await tx.user.create({
            data: { email: other.email, name: 'Other Org', passwordHash, isPlatformAdmin: false },
          });
          const organization = await tx.organization.create({
            data: { name: `Other Org ${runId}`, slug: `mockups-other-${runId}` },
          });
          await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
          const project = await tx.project.create({
            data: {
              organizationId: organization.id,
              name: `Foreign ${runId}`,
              slug: `foreign-${runId}`,
              sourceLocale: 'en-US',
            },
            select: { id: true },
          });
          return { projectId: project.id };
        });
      } finally {
        await prisma.$disconnect();
      }
    }, 60_000);

    it('refuses an upload against a project in another organization, and writes nothing', async () => {
      const attempt = await call('/projects/' + foreign.projectId + '/mockups', {
        method: 'POST',
        token: session.token,
        body: {
          name: 'squat',
          locale: 'en-US',
          imageBase64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        },
      });
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(404);
      expect(attempt.body.error!.code).toBe('NOT_FOUND');

      // Nothing was written under that name — the point of the check is the unique index, not the row.
      const prisma = new PrismaClient();
      try {
        await prisma.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*)::bigint AS count FROM screen_mockups WHERE project_id = $1::uuid`,
          foreign.projectId,
        );
        expect(Number(rows[0]!.count)).toBe(0);
      } finally {
        await prisma.$disconnect();
      }
    }, 60_000);

    it('answers 404 rather than 500 for a project id that does not exist at all', async () => {
      // Reached the foreign key before, so the caller got a 500 carrying raw Prisma text.
      const attempt = await call('/projects/00000000-0000-0000-0000-000000000000/mockups', {
        method: 'POST',
        token: session.token,
        body: {
          name: 'nowhere',
          locale: 'en-US',
          imageBase64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        },
      });
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(404);
    }, 60_000);

    it('refuses the same upload through MCP, which shares the check', async () => {
      const result = await client!.callTool({
        name: 'upload_screen_mockup',
        arguments: {
          project_id: foreign.projectId,
          name: 'squat',
          platform: 'web',
          locale: 'en-US',
          image_base64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
          replace: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('NOT_FOUND');
    }, 60_000);
  });

  it('resolves the locale the same way the write path stores it', async () => {
    // Entries are stored under the canonical tag. Reading with `?locale=EN-US` used to match nothing
    // and report every marker as having no translation — a wrong answer with a 200, which is the
    // hardest kind to notice.
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;
    const canonical = await call<{ markers: { entry: unknown }[] }>(
      `/projects/${projectId}/mockups/${mockupId}?locale=en-US`,
      { token: session.token },
    );
    const upper = await call<{ markers: { entry: unknown }[] }>(
      `/projects/${projectId}/mockups/${mockupId}?locale=EN-US`,
      { token: session.token },
    );
    const filled = (rows: { entry: unknown }[]) => rows.filter((row) => row.entry !== null).length;
    expect(filled(canonical.body.data!.markers)).toBeGreaterThan(0);
    expect(filled(upper.body.data!.markers)).toBe(filled(canonical.body.data!.markers));
  }, 60_000);

  it('does not count an archived key as a match', async () => {
    // An archived key was dropped from the repository: the editor does not list it, so a marker that
    // resolves to it must not be reported as a match either.
    const prisma = new PrismaClient();
    // `set_config(…, true)` is transaction-local: run outside a transaction it is gone by the next
    // statement, the update matches nothing under RLS, and the assertion below then passes for the
    // wrong reason. Both halves run inside one transaction, like the suite's own bootstrap does.
    const setArchived = (archivedAt: Date | null) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const updated = await tx.translationKey.updateMany({
          where: { projectId, key: 'checkout.empty' },
          data: { archivedAt },
        });
        expect(updated.count).toBe(1);
      });
    try {
      await setArchived(new Date());

      const result = await uploadSketch(projectId);
      // It is reported as unmatched — "the platform does not have this" — rather than matched.
      expect(result.markers.unmatched.map((row) => row.key)).toContain('checkout.empty');

      await setArchived(null);
      const restored = await uploadSketch(projectId);
      expect(restored.markers.unmatched.map((row) => row.key)).not.toContain('checkout.empty');
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  it('returns the ETag and cache directive on a 304, so a revalidation has something to store', async () => {
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;
    const url = `${API_BASE}/projects/${projectId}/mockups/${mockupId}/image`;
    const first = await fetch(url, { headers: { authorization: `Bearer ${session.token}` } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const revalidated = await fetch(url, {
      headers: { authorization: `Bearer ${session.token}`, 'if-none-match': etag! },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(revalidated.headers.get('cache-control')).toContain('no-cache');
  }, 60_000);

  it('tells "no such key" apart from "no source text", which the editor shows differently', async () => {
    // A key imported only under a non-source locale has a key row and an entry but no SourceVersion.
    // The editor used to read `source === null` as "the platform does not have this key" and told the
    // reviewer to import a key the editor already lists — so the two states have to stay distinct in
    // the payload.
    await client!.callTool({
      name: 'import_translations',
      arguments: {
        project_id: projectId,
        confirm: true,
        files: [
          {
            path: 'ios/ja-JP/Localizable.strings',
            locale: 'ja-JP',
            platform: 'ios',
            entries: [{ key: 'checkout.only_japanese', value: 'お会計' }],
          },
        ],
      },
    });

    await uploadSketch(projectId, { name: 'partial', keys: ['checkout.only_japanese', 'checkout.absent'] });
    const list = await call<{ id: string; name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const partial = list.body.data!.find((row) => row.name === 'partial')!;
    const detail = await call<{ markers: { key: string; platform: string | null; source: string | null; entry: unknown }[] }>(
      `/projects/${projectId}/mockups/${partial.id}?locale=ja-JP`,
      { token: session.token },
    );

    const imported = detail.body.data!.markers.find((row) => row.key === 'checkout.only_japanese')!;
    expect(imported.platform).not.toBeNull();
    expect(imported.source).toBeNull();
    expect(imported.entry).not.toBeNull();

    const absent = detail.body.data!.markers.find((row) => row.key === 'checkout.absent')!;
    expect(absent.platform).toBeNull();
    expect(absent.entry).toBeNull();

    await call(`/projects/${projectId}/mockups/${partial.id}`, { method: 'DELETE', token: session.token });
  }, 120_000);

  it('lets the unique index decide a concurrent replace: false, rather than a read that both pass', async () => {
    // The guard is a read, and two requests in flight both see no row. `replace: false` therefore has
    // to be a create — only the index can settle it — or the second silently overwrites the first
    // while reporting `replaced: false`.
    const results = await Promise.all([
      uploadSketchRaw(projectId, { name: 'racer', replace: false }),
      uploadSketchRaw(projectId, { name: 'racer', replace: false }),
    ]);
    const ok = results.filter((row) => row.status === 201);
    const refused = results.filter((row) => row.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body.error?.code).toBe('CONFLICT');

    const list = await call<{ id: string; name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const racer = list.body.data!.find((row) => row.name === 'racer');
    if (racer) await call(`/projects/${projectId}/mockups/${racer.id}`, { method: 'DELETE', token: session.token });
  }, 120_000);

  it('draws the sketch itself when the caller sends a page description instead of a picture', async () => {
    // The path this exists for: a caller that has the page's code rather than a drawing. It sends the
    // elements, the platform lays them out, draws them and computes every marker — so the picture and
    // the coordinates cannot disagree, which is what hand-measured markers get wrong.
    const spec = {
      name: 'ui-probe',
      platform: 'ios',
      locale: 'en-US',
      width: 390,
      root: {
        type: 'screen',
        children: [
          { type: 'text', text: 'Checkout', role: 'heading', key: 'checkout.title' },
          { type: 'text', text: 'Your cart is empty', key: 'checkout.empty' },
          { type: 'row', columns: 2, children: [{ type: 'button', text: 'Pay now', key: 'checkout.pay' }] },
          { type: 'text', text: 'Not a key yet' },
        ],
      },
    };

    const uploaded = await call<UploadResult & { matchedKeys: number; markers: { matchedKeys: number; unmatched: { key: string }[] } }>(
      `/projects/${projectId}/mockups`,
      { method: 'POST', token: session.token, body: { ...spec, ui: spec, replace: true } },
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const data = uploaded.body.data!;
    expect(data.image.mimeType).toBe('image/svg+xml');
    expect(data.image.width).toBe(390);
    // Three keys the project has, one it does not.
    expect(data.markers.total).toBe(4);
    expect(data.markers.matchedKeys).toBe(3);
    expect(data.markers.unmatched.map((row) => row.key)).toEqual(['Not a key yet']);

    // The bytes really are a sketch, and they draw the strings the caller described.
    const image = await fetch(`${API_BASE}/projects/${projectId}/mockups/${data.mockupId}/image`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(image.status).toBe(200);
    const svg = await image.text();
    expect(svg).toContain('<svg');
    for (const text of ['Checkout', 'Your cart is empty', 'Pay now', 'Not a key yet']) {
      expect(svg).toContain(text);
    }

    // And the editor can join those markers back to real entries.
    const detail = await call<{ markers: { key: string; source: string | null }[] }>(
      `/projects/${projectId}/mockups/${data.mockupId}?locale=ja-JP`,
      { token: session.token },
    );
    const pay = detail.body.data!.markers.find((marker) => marker.key === 'checkout.pay')!;
    expect(pay.source).toBe('Pay now');

    await call(`/projects/${projectId}/mockups/${data.mockupId}`, { method: 'DELETE', token: session.token });
  }, 120_000);

  it('refuses a request that sends neither a picture nor a description, and one that sends both', async () => {
    // The rule lives in one resolver shared by this route and the MCP tool, so the sentence is the
    // same whichever door the caller came through.
    const neither = await call('/projects/' + projectId + '/mockups', {
      method: 'POST',
      token: session.token,
      body: { name: 'empty', locale: 'en-US' },
    });
    expect(neither.status).toBe(422);
    expect(neither.body.error!.message).toContain('image_base64');

    const both = await call('/projects/' + projectId + '/mockups', {
      method: 'POST',
      token: session.token,
      body: {
        name: 'both',
        locale: 'en-US',
        imageBase64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        ui: { name: 'both', root: { type: 'screen', children: [{ type: 'text', text: 'x' }] } },
      },
    });
    expect(both.status).toBe(422);
    expect(both.body.error!.message).toContain('只用一种输入');
  }, 60_000);

  it('answers a body over the route limit with 413 in the standard envelope', async () => {
    // The larger limit is mounted on this route alone. A refusal used to arrive as 500 (Express's
    // parser error passing through the generic branch) or, before that, as Nest's default HTML.
    const huge = 'A'.repeat(5 * 1024 * 1024);
    const response = await fetch(`${API_BASE}/projects/${projectId}/mockups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ name: 'huge', locale: 'en-US', imageBase64: huge, markers: [] }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.success).toBe(false);
    expect(body.error!.code).toBe('VALIDATION_ERROR');
    // This answer comes from a hand-mounted parser, which runs before the middleware that mints the
    // request id — so it used to be the one error a client could not correlate with the logs.
    expect(body.error!.requestId).toBeTruthy();
    expect(response.headers.get('x-request-id')).toBe(body.error!.requestId);
  }, 60_000);

  it('keeps the same-name-plus-namespace identity apart when asking which screen shows a key', async () => {
    // A namespace is part of a key's identity, so a marker in one namespace must not answer for an
    // entry in another with the same name — the dialog would otherwise open the wrong screen and
    // highlight a marker belonging to a different entry.
    await uploadSketch(projectId, {
      name: 'namespaced',
      keys: ['title'],
    });
    const inDefault = await call<{ name: string; containsKey: boolean }[]>(
      `/projects/${projectId}/mockups?key=title&namespace=`,
      { token: session.token },
    );
    expect(inDefault.body.data!.find((row) => row.name === 'namespaced')?.containsKey).toBe(true);

    const inOther = await call<{ name: string; containsKey: boolean }[]>(
      `/projects/${projectId}/mockups?key=title&namespace=InfoPlist`,
      { token: session.token },
    );
    expect(inOther.body.data!.find((row) => row.name === 'namespaced')?.containsKey).toBe(false);

    const cleanup = await call<{ id: string; name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const extra = cleanup.body.data!.find((row) => row.name === 'namespaced');
    if (extra) await call(`/projects/${projectId}/mockups/${extra.id}`, { method: 'DELETE', token: session.token });
  }, 60_000);
});
