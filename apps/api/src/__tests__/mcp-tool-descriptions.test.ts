import { describe, expect, it } from 'vitest';

import { REMOTE_MCP_TOOLS } from '@localehub/contracts';

import { REMOTE_TOOL_DESCRIPTIONS } from '../modules/mcp/tool-descriptions';

/**
 * The one-line summaries the discovery endpoint hands out.
 *
 * `/mcp/tools` is what the web's MCP page renders, and it *overrides* each schema's own description with
 * a line from this map — so these strings are a second source of truth for what a tool is, and nothing
 * kept them in step with the first. One of them read 「传 ui 元素树，平台自己画图并算坐标」 for two rounds
 * after `document` replaced that path: the MCP client saw the new text, the platform's own page showed
 * the retired one. These pin what can be pinned mechanically.
 */
describe('the MCP tool summaries', () => {
  it('has a line for every registered tool', () => {
    const missing = REMOTE_MCP_TOOLS.filter((tool) => !REMOTE_TOOL_DESCRIPTIONS[tool]);
    expect(missing, `no summary for: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not name the inputs that were retired', () => {
    // `ui` is still a supported way to describe a screen, so it is not banned outright — but it is no
    // longer *the* path, and a summary that says it is tells a caller to draw a wireframe on purpose.
    const summaries = Object.values(REMOTE_TOOL_DESCRIPTIONS).join('\n');
    expect(summaries).not.toContain('传 ui 元素树');
  });

  it('tells a caller the screen tool wants the page itself', () => {
    // The claim that actually drifted, pinned where it drifted.
    expect(REMOTE_TOOL_DESCRIPTIONS.upload_screen_mockup).toContain('document');
  });

  it('describes tools the platform really has', () => {
    const names = new Set<string>(REMOTE_MCP_TOOLS);
    const unknown = Object.keys(REMOTE_TOOL_DESCRIPTIONS).filter((name) => !names.has(name));
    expect(unknown, `summaries for tools that do not exist: ${unknown.join(', ')}`).toEqual([]);
  });
});
