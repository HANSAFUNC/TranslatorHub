/**
 * Read what the Remote MCP teaches an agent about screen sketches — over the real transport, from
 * the deployed server, as a client sees it.
 *
 * The question is not "is the guide in the source" but "does an agent that reads everything it is
 * offered learn that it does not have to draw anything". The surfaces that answer it are the server
 * `instructions`, the guide resource, the prompt, the tool description and the discovery endpoint —
 * and the last check is the one that matters most: the example printed in the guide, pasted
 * verbatim into the tool.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const BASE = process.env.API_BASE ?? 'http://localhost:3001/api/v1';

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const login = await call('/auth/login', {
  method: 'POST',
  body: { email: 'demo@localehub.dev', password: 'demo-password-123' },
});
if (login.status >= 300) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
const session = login.body.data.token;

const issued = await call('/mcp-tokens', {
  method: 'POST',
  token: session,
  body: {
    name: `sketch-guide-${Date.now().toString(36)}`,
    // `sync.push` is what `upload_screen_mockup` requires, and the example upload at the end is a
    // real write — the point is that the guide's excerpt survives the tool's own validation.
    scopes: ['project.read', 'sync.push'],
    projectIds: [],
    expiresInDays: 1,
  },
});
if (issued.status >= 300) throw new Error(`token failed: ${JSON.stringify(issued.body)}`);
const token = issued.body.data.token;
const tokenId = issued.body.data.id;

const discovery = (await call('/mcp/tools')).body.data;
// Resolve the SDK from `apps/mcp-remote`, which declares it: `scripts/` has no node_modules.
const require = createRequire(new URL('../apps/mcp-remote/package.json', import.meta.url));
const sdk = (id) => pathToFileURL(require.resolve(id)).href;
const { Client } = await import(sdk('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport } = await import(sdk('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const client = new Client({ name: 'sketch-guide-check', version: '0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? discovery.remoteUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);

/* ------------------------------------------------------------------ what it says */

const instructions = client.getInstructions() ?? '';
console.log('instructions, the sketch paragraph:');
console.log(
  instructions
    .split('\n')
    .filter((line) => /ui|草图|mockup/.test(line))
    .map((line) => `  ${line}`)
    .join('\n'),
);
check(instructions.includes('不用你量坐标'), 'the instructions say the platform measures, not the caller');
check(instructions.includes('localehub://screen-sketch-guide'), 'the instructions point at the sketch guide');
check(instructions.includes('localehub mockup --page'), 'the instructions give the CLI shortcut');
check(instructions.includes('没有 dry run'), 'the instructions warn that the screen is replaced, not previewed');

const resources = (await client.listResources()).resources.map((row) => row.uri);
check(resources.includes('localehub://screen-sketch-guide'), 'the guide is registered as a resource');

const guide = await client.readResource({ uri: 'localehub://screen-sketch-guide' });
const guideText = String(guide.contents[0] && 'text' in guide.contents[0] ? guide.contents[0].text : '');
check(guide.contents[0]?.mimeType === 'text/markdown', 'the guide is markdown');
check(guideText.length > 1000, 'the guide has substance', `${guideText.length} chars`);
check(guideText.includes('"ui"') && guideText.includes('"root"'), 'the guide shows the ui call shape');
check(/\| `badge` \|/.test(guideText) && /\| `divider` \|/.test(guideText), 'the guide carries the node table');
check(guideText.includes('markers.unmatched') && guideText.includes('markers.matchedKeys'), 'the guide names the marker fields');
check(guideText.includes('整体替换'), 'the guide states the replacement rule');
check(guideText.includes('localehub mockup --page'), 'the guide gives the CLI recipe');
// The guidance tool: the guide has to say that a sketch is judged after it is drawn, and what each
// finding means — the failure modes are silent otherwise.
check(guideText.includes('report') && guideText.includes('sourceColours'), 'the guide explains the report the platform returns');
check(
  ['NO_PICTURES', 'PLACEHOLDER_PICTURES', 'NO_SOURCE_COLOURS', 'IDENTICAL_FRAMES', 'MISSING_KEYS', 'NO_COMPONENTS'].every(
    (code) => guideText.includes(code),
  ),
  'the guide lists every finding the report can carry',
);
// The fidelity half of the guide. An agent that reads it must learn that the layout numbers and the
// pictures are in the project, and that drawing something that merely looks like the screen is the
// failure the platform reports as DRAWN_SHAPES.
check(guideText.includes('DRAWN_SHAPES'), 'the guide names the finding for a hand-drawn wireframe');
check(
  ['constraint', 'layout_', 'padding', 'StyleSheet'].every((cue) => guideText.includes(cue)),
  'the guide says, per stack, where the layout numbers live',
);
check(
  ['xcassets', 'drawable'].every((cue) => guideText.includes(cue)),
  'the guide says where the project keeps its pictures',
);
check(guideText.includes('不要照着印象画'), 'the guide says not to draw the screen from memory');
// The standard the uploader is held to, pinned so a rewrite of the guide cannot quietly drop a rule.
check(
  ['S1', 'S2', 'S4', 'S5', 'S7', 'S10'].every((rule) => guideText.includes(rule)),
  'the guide carries the numbered delivery standard',
);
check(guideText.includes('CLIPPED_BOX'), 'the guide names the finding for a box that hides its content');
check(
  guideText.includes('内容多高') && guideText.includes('overflow'),
  'the standard says the canvas must not clip its content',
);

const prompts = (await client.listPrompts()).prompts.map((row) => row.name);
check(prompts.includes('upload-screen-sketch'), 'the sketch prompt is registered', prompts.join(', '));
const rendered = await client.getPrompt({ name: 'upload-screen-sketch', arguments: { projectId: 'demo', page: 'src/app/page.tsx' } });
const promptText = String(rendered.messages[0]?.content?.text ?? '');
check(promptText.includes('localehub://screen-sketch-guide'), 'the prompt sends the agent to the guide');
check(promptText.includes('不要传 markers'), 'the prompt says not to hand-roll markers');
check(promptText.includes('report'), 'the prompt tells the agent to read the report back');
check(
  promptText.includes('自检') && promptText.includes('四个问题'),
  'the prompt makes the pre-upload self-check a step',
);
check(promptText.includes('CLIPPED_BOX') && promptText.includes('FLOW_LAYOUT'), 'the prompt names the findings that gate an upload');
// The prompt used to say "平台只解析、不渲染" and offer three inputs with no `document` — which is what
// an uploading agent read as permission to hand-write a wireframe.
check(promptText.includes('document'), 'the prompt routes the agent to the replica path');
check(!promptText.includes('平台只解析、不渲染'), 'the prompt no longer describes the platform as parse-only');

const tool = (await client.listTools()).tools.find((row) => row.name === 'upload_screen_mockup');
check(tool?.description?.includes('document'), 'the tool description leads with document');
check(tool?.description?.includes('localehub://screen-sketch-guide'), 'the tool description points at the guide');

check(discovery.resources.includes('localehub://screen-sketch-guide'), 'GET /mcp/tools advertises the guide');
check(discovery.prompts.includes('upload-screen-sketch'), 'GET /mcp/tools advertises the prompt');

/* --------------------------------------------------- the example, taken literally */

/** The guide's first ```jsonc block, comments removed — what a caller copies into a tool call. */
function exampleFrom(guide_text) {
  const match = /```jsonc\n([\s\S]*?)```/.exec(guide_text);
  if (!match) throw new Error('the guide carries no JSON example');
  const withoutComments = match[1]
    .split('\n')
    .map((line) => {
      let quote = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' && line[index - 1] !== '\\') quote = !quote;
        if (!quote && character === '/' && line[index + 1] === '/') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
  return JSON.parse(withoutComments);
}

const created = await call('/projects', {
  method: 'POST',
  token: session,
  body: { name: `草图教程校验 ${Date.now().toString(36)}`, sourceLocale: 'zh-CN', locales: ['en-US'] },
});
if (created.status >= 300) throw new Error(`could not create the probe project: ${JSON.stringify(created.body)}`);
const project = created.body.data;

const example = { ...exampleFrom(guideText), project_id: project.id };
const uploaded = await client.callTool({ name: 'upload_screen_mockup', arguments: example });
if (uploaded.isError) throw new Error(`the guide's example was refused: ${uploaded.content[0].text}`);
const result = uploaded.structuredContent ?? JSON.parse(uploaded.content[0].text);
console.log('the guide\'s example, uploaded:');
console.log(JSON.stringify({ markers: result.markers, image: result.image }, null, 1));
// The example is the `html` shape: two strings, one of them naming its key through `data-key`.
check(result.markers?.total === 2, 'the two strings in the example became two markers', String(result.markers?.total));
check(result.markers?.unmatched?.length === 2, 'none matched a key yet, reported rather than rejected');
check(
  result.markers?.unmatched?.some((row) => row.key === 'exam.next' && row.namespace === 'Localizable'),
  'the button kept the key the markup named, under the namespace the call set',
  JSON.stringify(result.markers?.unmatched),
);
check(result.image?.width === 390 && result.image?.height === 844, 'the named screen decided the canvas', `${result.image?.width}×${result.image?.height}`);
check(result.image?.mimeType === 'image/svg+xml', 'the platform drew an SVG');

const image = await fetch(`http://localhost:3001/api/v1${result.imagePath}`, { headers: { authorization: `Bearer ${token}` } });
const svg = await image.text();
check(image.status === 200 && svg.startsWith('<svg'), 'the sketch is served back', `${image.status}, ${svg.length} chars`);
check(svg.includes('下一步') && !svg.includes('<script>'), 'the text is drawn, and nothing scriptable came with it');

await client.close();

// The check creates its own data and removes it again: the demo organization is shared.
const removed = await call(`/projects/${project.id}?confirmName=${encodeURIComponent(project.name)}`, {
  method: 'DELETE',
  token: session,
});
check(removed.status < 300, 'the probe project is cleaned up', String(removed.status));
await call(`/mcp-tokens/${tokenId}`, { method: 'DELETE', token: session });

if (failures) {
  console.error(`\nRESULT: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nRESULT: the sketch flow is taught, and the guide\'s example runs');
