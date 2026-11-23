import type { McpClientSnippets } from '@/components/mcp-client-config';

/**
 * What the MCP discovery endpoint answers with.
 *
 * Shared by the MCP page and each tool's own page, because the two describe the same objects: a tool
 * listed with one set of fields and opened with another is how a table and its detail view start
 * disagreeing about what the platform offers.
 */
export interface McpToolProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  /** Present on nested shapes (`frames[].ui`, an object parameter). */
  properties?: Record<string, McpToolProperty>;
  items?: McpToolProperty;
  required?: string[];
}

export interface ToolDescriptor {
  name: string;
  server: string;
  description: string;
  inputSchema: { properties?: Record<string, McpToolProperty>; required?: string[] } | null;
}

export interface McpTools {
  remote: ToolDescriptor[];
  resources: string[];
  prompts: string[];
  /** Externally reachable endpoint, as configured on the server. */
  remoteUrl: string;
  /**
   * Set when that address cannot serve anyone but the platform's own machine — the reader is most
   * likely about to hand it to a colleague.
   */
  remoteUrlWarning?: string;
  /** How a client reads and invokes skills; the API owns these strings, not the browser. */
  skillDelivery: { indexUri: string; resourceTemplate: string; promptPrefix: string };
  /** Ready-to-paste configs, generated server-side by the same code the CLI uses. */
  snippets: McpClientSnippets;
}
