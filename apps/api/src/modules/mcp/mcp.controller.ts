import { Controller, Get, Req } from '@nestjs/common';
import {
  REMOTE_MCP_PROMPTS,
  REMOTE_MCP_RESOURCES,
  SKILLS_INDEX_URI,
  SKILL_PROMPT_PREFIX,
  SKILL_RESOURCE_TEMPLATE,
  claudeCliCommand,
  formatMcpClientConfig,
  mcpClientConfig,
  mcpToolJsonSchemas,
} from '@localehub/contracts';
import { Public, type AuthenticatedRequest } from '../../common/auth';
import { REMOTE_TOOL_DESCRIPTIONS } from './tool-descriptions';

/**
 * Machine readable MCP discovery.
 *
 * The Remote MCP binary serves the same registry over the real MCP transport; this endpoint
 * exists so the web UI, the CLI and the docs can render tool schemas without speaking MCP.
 * It contains no secrets and grants no filesystem capability.
 *
 * The resources and prompts listed here are the ones the server actually registers, taken from
 * the same constants it registers them under. An earlier version of this endpoint advertised a
 * flat list that included resources no server implemented and prompts belonging to a second,
 * now-removed local server — a discovery endpoint that overstates a capability is worse than none.
 */
/**
 * The address a client should connect to — which is not the same question as where the server is.
 *
 * `MCP_PUBLIC_URL` answers it when the operator has said so. When it has not, this used to fall back
 * to `http://localhost:3003/mcp`, and that is correct for exactly one client: a client running on the
 * same machine as the platform. Everyone else copies the snippet, `localhost` resolves to *their own*
 * laptop, and `claude mcp list` says `ECONNREFUSED` with no hint that the address was never theirs —
 * which is how a working deployment reads as broken to every colleague.
 *
 * So the fallback is derived from the request that asked, the same way the CSRF origin check trusts the
 * host a request was actually addressed to. `x-forwarded-host` first, because the web app proxies
 * `/api/v1` and the raw `Host` there is the container name; the MCP port is its own, since MCP is
 * published separately from the web app.
 *
 * `warning` is set when the address cannot serve anyone but this machine and the caller is not on it —
 * that is the state that must not be silent.
 */
export function resolveRemoteMcpUrl(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): { remoteUrl: string; warning?: string } {
  const port = env.MCP_REMOTE_PORT ?? '3003';
  const configured = env.MCP_PUBLIC_URL?.trim();
  const first = (value: string | string[] | undefined): string =>
    (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() ?? '';
  const forwardedProto = first(headers['x-forwarded-proto']);
  const proto = forwardedProto || 'http';
  const callerHost = first(headers['x-forwarded-host']) || first(headers.host);
  const callerName = callerHost.replace(/:\d+$/, '');
  const callerIsLocal = !callerName || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(callerName);

  // What the caller would have been given if nobody had configured anything — the address that is
  // known to reach this deployment from where the caller is standing.
  const derived = `${proto}://${callerName}:${port}/mcp`;
  const address = configured || (callerIsLocal ? `http://localhost:${port}/mcp` : derived);
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(address);
  if (isLoopback && !callerIsLocal) {
    return {
      remoteUrl: address,
      // The address that does work, spelled out: "set it to something reachable" leaves the reader to
      // work out what that is, which is the same gap that produced the loopback default in the first
      // place.
      warning:
        `${address} 只有跑平台的这台机器能用：别人复制过去之后，localhost 指的是他自己的电脑。` +
        `把 MCP_PUBLIC_URL 设成 ${derived}（或别的对外地址）再重启 api。`,
    };
  }
  return { remoteUrl: address };
}

@Controller('mcp')
export class McpController {
  @Public()
  @Get('tools')
  tools(@Req() request: AuthenticatedRequest) {
    const schemas = mcpToolJsonSchemas();
    const { remoteUrl, warning } = resolveRemoteMcpUrl(request.headers);
    return {
      ...(warning ? { remoteUrlWarning: warning } : {}),
      remote: schemas.remote.map((tool) => ({ ...tool, description: REMOTE_TOOL_DESCRIPTIONS[tool.name] ?? '' })),
      resources: [
        ...REMOTE_MCP_RESOURCES,
        // Skill delivery: the index, plus one resource per published skill behind the template.
        SKILLS_INDEX_URI,
        SKILL_RESOURCE_TEMPLATE,
      ],
      prompts: [
        ...REMOTE_MCP_PROMPTS,
        // Plus one per PUBLISHED, PROMPT-kind skill, named `skill-<slug>`.
      ],
      // How a client reads and invokes skills. Served rather than hard-coded in the UI for the
      // same reason as the snippets below: `@localehub/contracts` reaches node:crypto, so the web
      // bundle cannot import the constants, and a second copy of the URI format in the browser is
      // how the two would drift apart.
      skillDelivery: {
        indexUri: SKILLS_INDEX_URI,
        resourceTemplate: SKILL_RESOURCE_TEMPLATE,
        promptPrefix: SKILL_PROMPT_PREFIX,
      },
      // What a client should connect to. Not a secret, and the UI cannot guess it: behind nginx
      // this is the public host, in development it is :3003.
      remoteUrl,
      // Rendered server-side from the same generator the CLI uses. The web bundle cannot import
      // @localehub/contracts (it reaches node:crypto), and duplicating the snippet logic in the
      // browser is how the two would drift apart.
      snippets: {
        remote: formatMcpClientConfig(mcpClientConfig({ remote: { url: remoteUrl } })),
        claudeCli: claudeCliCommand({ url: remoteUrl }),
      },
    };
  }
}
