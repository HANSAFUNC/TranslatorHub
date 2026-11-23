import { describe, expect, it } from 'vitest';

import { resolveRemoteMcpUrl } from '../modules/mcp/mcp.controller';

/**
 * Which address the platform hands out, and whether it says so when that address is useless.
 *
 * The failure this exists for: the fallback was `http://localhost:3003/mcp`, which is correct for
 * exactly one client — one running on the machine the platform runs on. A colleague copies the
 * snippet, `localhost` resolves to their own laptop, and `claude mcp list` reports
 * `ECONNREFUSED` about a deployment that is running perfectly well.
 */

describe('the address handed to MCP clients', () => {
  it('prefers what the operator configured', () => {
    expect(resolveRemoteMcpUrl({ host: '192.168.200.172:3000' }, { MCP_PUBLIC_URL: 'https://mcp.example.com/mcp' })).toEqual({
      remoteUrl: 'https://mcp.example.com/mcp',
    });
  });

  it('derives it from whoever asked, when nobody configured one', () => {
    // The MCP endpoint is published separately from the web app, so its port is not the caller's.
    expect(resolveRemoteMcpUrl({ host: '192.168.200.172:3000' }, {})).toEqual({
      remoteUrl: 'http://192.168.200.172:3003/mcp',
    });
  });

  it('reads the proxied host, not the container name the proxy used', () => {
    // Through the web app's `/api/v1` proxy the raw Host is `api:3001`; the browser-facing one only
    // survives in `x-forwarded-host`.
    expect(
      resolveRemoteMcpUrl({ host: 'api:3001', 'x-forwarded-host': '10.0.0.5:3000', 'x-forwarded-proto': 'https' }, {}),
    ).toEqual({ remoteUrl: 'https://10.0.0.5:3003/mcp' });
  });

  it('keeps localhost for a caller that is actually on this machine', () => {
    expect(resolveRemoteMcpUrl({ host: 'localhost:3000' }, {})).toEqual({ remoteUrl: 'http://localhost:3003/mcp' });
    expect(resolveRemoteMcpUrl({}, {})).toEqual({ remoteUrl: 'http://localhost:3003/mcp' });
  });

  it('says out loud when the configured address cannot serve the caller', () => {
    // A deployment that set `MCP_PUBLIC_URL=http://localhost:3003/mcp` on a shared machine hands every
    // colleague an address that points at their own laptop. That has to be visible on the page that
    // shows the address, not only in somebody else's `claude mcp list`.
    const { remoteUrl, warning } = resolveRemoteMcpUrl({ host: '192.168.200.172:3000' }, { MCP_PUBLIC_URL: 'http://localhost:3003/mcp' });

    expect(remoteUrl).toBe('http://localhost:3003/mcp');
    expect(warning).toContain('MCP_PUBLIC_URL');
    expect(warning).toContain('192.168.200.172');
  });

  it('does not warn when localhost is the honest answer', () => {
    const { warning } = resolveRemoteMcpUrl({ host: '127.0.0.1:3000' }, { MCP_PUBLIC_URL: 'http://localhost:3003/mcp' });
    expect(warning).toBeUndefined();
  });

  it('uses the configured MCP port when deriving', () => {
    expect(resolveRemoteMcpUrl({ host: '10.1.2.3:3000' }, { MCP_REMOTE_PORT: '3303' })).toEqual({
      remoteUrl: 'http://10.1.2.3:3303/mcp',
    });
  });
});
