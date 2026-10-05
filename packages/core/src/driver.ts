import type { CapabilityId } from "./capabilities.js";
import type { ModelProfile } from "./models.js";
import type { ToolOutcome } from "./tools.js";

export interface AgentRunInput {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
  profile: ModelProfile;
  apiKey: string;
  loadedCapabilities: CapabilityId[];
  workspaceRoot: string | null;
}

export interface AgentToolHooks {
  executeTool(call: { name: string; args: unknown }): Promise<ToolOutcome>;
  onTextDelta?: (delta: string) => void;
}

/**
 * Host-facing agent loop. The Pi implementation lives in @deskforge/agent.
 * Tool hooks must return through the main process; the loop does not get a filesystem.
 */
export interface AgentDriver {
  run(input: AgentRunInput, hooks: AgentToolHooks, signal?: AbortSignal): Promise<{ text: string }>;
}
