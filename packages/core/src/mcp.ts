/**
 * P0 keeps MCP as a typed stub. DeskForge does not open stdio servers or
 * forward tool calls yet. P1 can implement this interface without changing
 * the approval path: a future client still returns descriptors, and the
 * main process still decides whether a call may run.
 */
export interface McpServerConfig {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** Environment variable names whose values are supplied at runtime, never stored here. */
  env?: Record<string, string>;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
}

export interface McpClient {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<string>;
}

export function createStubMcpClient(config: McpServerConfig): McpClient {
  return {
    async listTools(): Promise<McpToolDescriptor[]> {
      return [];
    },
    async callTool(name: string): Promise<string> {
      throw new Error(`MCP 在 P0 尚未连接（server ${config.id}，tool ${name}）。`);
    },
  };
}
