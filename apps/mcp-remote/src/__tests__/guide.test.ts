import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PrismaClient, TenantPrisma } from '@localehub/database';
import { REMOTE_MCP_SKETCH_GUIDE, REMOTE_MCP_TOOLS, Role, remoteToolSchemas } from '@localehub/contracts';
import { resolveMockupInput } from '@localehub/domain';
import type { ActorContext } from '@localehub/permissions';

import { buildRemoteMcpServer } from '../server';

/**
 * What the server teaches a client about itself.
 *
 * This exists because of a concrete failure: an agent connected to this server, called
 * `import_translations` with a deliberately malformed body, and learned the argument shape from the
 * validation errors — three round trips to discover `files[0].entries[0].key`, and it never
 * discovered `platform`, `namespace` or `confirm`, because error messages only name *required*
 * fields and those three have defaults. The defaults are the dangerous part: `platform` defaults to
 * `web`, so an iOS import silently lands under the wrong platform, which is part of a key's
 * identity and cannot be corrected afterwards without re-importing.
 *
 * So the surfaces that teach are pinned here: the server instructions, the guide resource, the
 * prompt, and the field descriptions that ride along with `tools/list`.
 */

const ACTOR: ActorContext = {
  kind: 'mcp',
  userId: 'user-1',
  organizationId: 'org-1',
  orgRole: Role.ORG_OWNER,
  projectRoles: {},
  scopes: [],
  boundProjectIds: [],
  isPlatformAdmin: false,
  actorType: 'mcp',
};

async function connect(): Promise<Client> {
  const tenant = {
    withOrganization: async (_organizationId: string, callback: (tx: unknown) => unknown) =>
      callback({ skill: { findMany: async () => [] } }),
  } as unknown as TenantPrisma;

  const server = await buildRemoteMcpServer(ACTOR, {} as PrismaClient, tenant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guide-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { contents: Array<{ text?: string; blob?: string }> }): string {
  const first = result.contents[0];
  return String(first && 'text' in first ? first.text : '');
}

describe('server instructions', () => {
  it('names both sync directions, so the agent does not reach for the wrong tool', async () => {
    const client = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('import_translations');
      expect(instructions).toContain('get_pending_platform_changes');
      expect(instructions).toContain('mark_applied');
      // The platform genuinely cannot read a checkout; saying so is what stops an agent looking
      // for a file tool that will never exist.
      expect(instructions).toContain('无法访问开发者的本地文件系统');
    } finally {
      await client.close();
    }
  });

  it('states the three rules a caller cannot recover from, and points at the guide', async () => {
    const client = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      // The repository's own directory name is what to pass — not a code the caller has to guess at.
      expect(instructions).toContain('zh-Hans');
      expect(instructions).toContain('归入');
      expect(instructions).toContain('自动新增');
      expect(instructions).toContain('platform 默认是 web');
      expect(instructions).toContain('300~400');
      expect(instructions).toContain('localehub://import-guide');
      // The dry-run default is the difference between "risky write" and "safe question".
      expect(instructions).toContain('dry run');
    } finally {
      await client.close();
    }
  });

  it('teaches the sketch flow as a description, not a drawing', async () => {
    const client = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      // The whole point of `ui` is that the caller does not hand-measure anything, and an agent that
      // reads only this paragraph has to come away knowing that — it is the surface every client
      // puts in front of the model.
      expect(instructions).toContain('ui');
      expect(instructions).toContain('不用你量坐标');
      expect(instructions).toContain('markers.unmatched');
      // The shortcut for an agent with a shell, and the guide for the rules.
      expect(instructions).toContain('localehub mockup --page');
      expect(instructions).toContain('localehub://screen-sketch-guide');
      // The write it cannot preview.
      expect(instructions).toContain('没有 dry run');
    } finally {
      await client.close();
    }
  });
});

describe('the import guide', () => {
  it('is served as markdown under a stable URI', async () => {
    const client = await connect();
    try {
      const listed = (await client.listResources()).resources.map((resource) => resource.uri);
      expect(listed).toContain('localehub://import-guide');

      const guide = await client.readResource({ uri: 'localehub://import-guide' });
      expect(guide.contents[0]?.mimeType).toBe('text/markdown');
      expect(textOf(guide).length).toBeGreaterThan(1000);
    } finally {
      await client.close();
    }
  });

  it('carries the call shape, including the fields that have defaults', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://import-guide' }));
      // The shape, so nobody has to probe for it.
      for (const field of ['project_id', 'confirm', 'files', 'path', 'locale', 'platform', 'namespace', 'entries']) {
        expect(text, field).toContain(field);
      }
    } finally {
      await client.close();
    }
  });

  it('explains that a batch is a partial upload, and that cost scales with the batch', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://import-guide' }));
      // The property that makes batching safe at all: a batch says nothing about the files it did
      // not carry. Without it, batching a 5,000-entry import proposed 5,000 deletions.
      expect(text).toContain('部分上传');
      expect(text).toContain('判成删除');
      // And the property that makes it fast: the cost is the batch, not the project.
      expect(text).toContain('与项目已经有多大无关');
      expect(text).toContain('整批回滚');
    } finally {
      await client.close();
    }
  });

  it('explains what happens to a locale the project does not have', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://import-guide' }));
      // The four outcomes, each of which the caller has to be able to predict.
      expect(text).toContain('zh-Hans');
      expect(text).toContain('zh-CN');
      expect(text).toContain('localesMatched');
      expect(text).toContain('localesAdded');
      expect(text).toContain('platformsAdded');
      expect(text).toContain('拒绝');
      // Why it matters: getting this wrong once cost the source versions.
      expect(text).toContain('source version');
      expect(text).toContain('namespace');
    } finally {
      await client.close();
    }
  });
});

describe('the upload prompt', () => {
  it('is registered with its arguments and renders them', async () => {
    const client = await connect();
    try {
      const prompt = (await client.listPrompts()).prompts.find((row) => row.name === 'import-localization-files');
      expect(prompt).toBeTruthy();
      expect((prompt?.arguments ?? []).map((arg) => arg.name).sort()).toEqual(['localesDir', 'projectId']);

      const rendered = await client.getPrompt({
        name: 'import-localization-files',
        arguments: { projectId: 'project-42', localesDir: 'ios/Resources' },
      });
      const text = String((rendered.messages[0]?.content as { text?: string }).text ?? '');
      expect(text).toContain('project_id=project-42');
      expect(text).toContain('ios/Resources');
      // It has to send the agent to the guide rather than restate it, or the two will drift.
      expect(text).toContain('localehub://import-guide');
      // And it must stop before writing when the two irreversible decisions are wrong.
      expect(text).toContain('先停下来');
    } finally {
      await client.close();
    }
  });

  it('does not collide with a skill prompt of the same name', async () => {
    const client = await connect();
    try {
      const names = (await client.listPrompts()).prompts.map((row) => row.name);
      expect(names.filter((name) => name === 'import-localization-files')).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

/**
 * The sketch flow used to be taught only by the tool's own field descriptions: the instructions
 * still described a caller that "画一张草图" and measured coordinates, and the only guide resource
 * was the import guide, which says nothing about `ui`. An agent that read them both would conclude
 * the picture had to be drawn by hand — the exact step the `ui` input exists to remove. These
 * pin the three surfaces that now teach it: the instructions (above), the guide, and the prompt.
 */
describe('the screen sketch guide', () => {
  it('is served as markdown under a stable URI', async () => {
    const client = await connect();
    try {
      const listed = (await client.listResources()).resources.map((resource) => resource.uri);
      expect(listed).toContain('localehub://screen-sketch-guide');

      const guide = await client.readResource({ uri: 'localehub://screen-sketch-guide' });
      expect(guide.contents[0]?.mimeType).toBe('text/markdown');
      expect(textOf(guide).length).toBeGreaterThan(1000);
    } finally {
      await client.close();
    }
  });

  it('leads with the page’s own source, and says the platform computes the coordinates', async () => {
    {
      const client = await connect();
      try {
        const text = textOf(await client.readResource({ uri: 'localehub://screen-sketch-guide' }));
        // The first example is the `html` shape: the cheapest thing for an agent that has the page.
        const first = /```jsonc\n([\s\S]*?)```/.exec(text)![1]!;
        expect(first).toContain('"html"');
        // …and the page's colours are part of what it promises, because a grey sketch is not
        // recognisable as any particular screen.
        expect(text).toContain('颜色');
        expect(text).toContain('data-key');
        expect(text).toContain('只解析');
      } finally {
        await client.close();
      }
    }
  });

  it('shows the ui tree too, and says the platform computes the coordinates', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://screen-sketch-guide' }));
      expect(text).toContain('"ui"');
      expect(text).toContain('root');
      expect(text).toContain('不需要量坐标');
      // Where a marker's key comes from is the one thing a caller cannot see in the schema.
      expect(text).toContain('namespace');
      expect(text).toContain('markers.unmatched');
      expect(text).toContain('markers.matchedKeys');
      // Every node type the renderer accepts, so the table cannot fall behind the schema.
      for (const type of ['screen', 'section', 'card', 'row', 'text', 'button', 'input', 'image', 'icon', 'divider', 'badge']) {
        expect(text, type).toContain(`\`${type}\``);
      }
      expect(text).toContain('columns');
    } finally {
      await client.close();
    }
  });

  it('states the two things that cannot be undone', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://screen-sketch-guide' }));
      // A second upload of the same name replaces the screen wholesale, with no dry run and no
      // history — the reason the tool's destructiveHint is true.
      expect(text).toContain('整体替换');
      expect(text).toContain('replace');
      expect(text).toContain('默认');
      expect(text).toContain('web');
      // And the shortcut for a caller that has the repository on disk.
      expect(text).toContain('localehub mockup --page');
    } finally {
      await client.close();
    }
  });
});

/**
 * The guide's example, run for real.
 *
 * A tutorial whose excerpt does not execute is worse than no tutorial, and this one gets copied
 * verbatim by an agent that has never uploaded a screen. It was already wrong once: the JSONC block
 * showed only `root` while the schema still required `ui.name`, so the first caller to paste it was
 * refused with "Required at ui.name" — and the platform's own docs said the same thing, so there was
 * nothing to compare against. Both are fixed; this is what keeps them fixed.
 */
describe('the example in the sketch guide', () => {
  /** Comments removed the way a reader must remove them: `//` inside a string is part of the value. */
  function stripComments(block: string): string {
    return block
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
  }

  /** The first ```jsonc block of the guide — a caller pastes it into a tool call. */
  function exampleFromGuide(): Record<string, unknown> {
    const match = /```jsonc\n([\s\S]*?)```/.exec(REMOTE_MCP_SKETCH_GUIDE);
    expect(match, 'the guide carries a JSON example').toBeTruthy();
    return JSON.parse(stripComments(match![1]!)) as Record<string, unknown>;
  }

  it('is accepted by the tool schema, which is what a caller pastes it into', () => {
    const example = exampleFromGuide();
    const parsed = remoteToolSchemas.upload_screen_mockup.safeParse(example);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('produces the sketch it promises: one marker per string, on the named screen', () => {
    // The first block is the `html` shape — the page's own source — so the example is run the way a
    // caller pastes it: into the resolver, which parses it and draws it.
    const example = exampleFromGuide() as { html: string; platform: string; namespace?: string };
    const { image, markers } = resolveMockupInput({ html: example.html, platform: example.platform, namespace: example.namespace ?? null });
    expect(markers.map((marker) => marker.text)).toEqual(['练习', '下一步']);
    // The button names its key rather than defaulting to its text, which is the one thing markup
    // cannot say by itself.
    expect(markers[1]!.key).toBe('exam.next');
    // The namespace reaches every marker, which is what an iOS string table needs.
    expect(markers.every((marker) => marker.namespace === 'Localizable')).toBe(true);
    // And an iPhone-shaped canvas, which is the property the guide states in prose.
    expect(image.width).toBe(390);
    expect(image.height).toBe(844);
  });

  it('shows the other shapes too, and each example is one a caller could actually send', () => {
    const blocks = [...REMOTE_MCP_SKETCH_GUIDE.matchAll(/```jsonc\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    // Comment-stripped the same way a caller pastes them, because a JSONC example that does not parse
    // is a tutorial that fails at the first step.
    const parsed = blocks.map((block) => JSON.parse(stripComments(block)) as Record<string, unknown>);

    const board = parsed.find((example) => 'frames' in example) as { frames: { title: string; html?: string; ui?: unknown }[] };
    expect(board.frames.map((frame) => frame.title)).toEqual(['默认', '空状态', '加载中']);
    // Every frame carries exactly one shape, which is the rule the prose states.
    for (const frame of board.frames) expect(Boolean(frame.html) !== Boolean(frame.ui)).toBe(true);

    const described = parsed.find((example) => 'ui' in example) as { ui: { root: { type: string } } };
    expect(described.ui.root.type).toBe('screen');
  });
});

describe('the sketch prompt', () => {
  it('is registered with its arguments and renders them', async () => {
    const client = await connect();
    try {
      const prompt = (await client.listPrompts()).prompts.find((row) => row.name === 'upload-screen-sketch');
      expect(prompt).toBeTruthy();
      expect((prompt?.arguments ?? []).map((arg) => arg.name).sort()).toEqual(['page', 'projectId']);

      const rendered = await client.getPrompt({
        name: 'upload-screen-sketch',
        arguments: { projectId: 'project-42', page: 'src/app/checkout/page.tsx' },
      });
      const text = String((rendered.messages[0]?.content as { text?: string }).text ?? '');
      expect(text).toContain('project_id=project-42');
      expect(text).toContain('src/app/checkout/page.tsx');
      // Same rule as the import prompt: send the agent to the guide rather than restate it.
      expect(text).toContain('localehub://screen-sketch-guide');
      // The two ways to get this wrong: hand-rolled markers, and a version-suffixed screen name.
      expect(text).toContain('不要传 markers');
      expect(text).toContain('不要用版本号');
    } finally {
      await client.close();
    }
  });
});

describe('tool schemas teach the arguments', () => {
  it('describes every field of import_translations that has a default', async () => {
    const client = await connect();
    try {
      const tool = (await client.listTools()).tools.find((row) => row.name === 'import_translations');
      const schema = tool?.inputSchema as {
        properties: Record<string, { description?: string; default?: unknown; items?: { properties: Record<string, { description?: string; default?: unknown }> } }>;
      };
      const file = schema.properties.files!.items!.properties;

      // These three are exactly what probing cannot reveal, because they are not required.
      expect(file.platform!.default).toBe('web');
      expect(file.platform!.description).toContain('ios');
      // A default the caller cannot see is the whole failure mode this test exists for, so the
      // description has to say both what the default is and when it is wrong.
      expect(file.platform!.description).toContain('自动加上');
      expect(file.locale!.description).toContain('zh-Hans');
      expect(file.locale!.description).toContain('自动新增');
      expect(file.namespace!.description).toContain('Localizable');
      expect(schema.properties.confirm!.default).toBe(false);
      expect(schema.properties.confirm!.description).toContain('dry run');
      expect(schema.properties.files!.description).toContain('300~400');
    } finally {
      await client.close();
    }
  });

  it('describes the fields of mark_applied that decide whether a claim is checkable', async () => {
    const client = await connect();
    try {
      const tool = (await client.listTools()).tools.find((row) => row.name === 'mark_applied');
      const schema = tool?.inputSchema as {
        properties: { items?: { items?: { properties: Record<string, { description?: string }> } }; dry_run?: { description?: string } };
      };
      expect(schema.properties.items!.items!.properties.translation_version_id!.description).toContain('当前版本');
      expect(schema.properties.dry_run!.description).toContain('不写库');
    } finally {
      await client.close();
    }
  });

  it('leaves no tool without a description', async () => {
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools;
      for (const name of REMOTE_MCP_TOOLS) {
        const tool = tools.find((row) => row.name === name);
        expect(tool, name).toBeTruthy();
        expect(tool!.description?.length ?? 0, name).toBeGreaterThan(10);
      }
    } finally {
      await client.close();
    }
  });
});
