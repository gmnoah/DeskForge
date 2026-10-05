import type { AgentRunInput } from "./driver.js";

export type AgentHostRequest =
  | { type: "run"; runId: string; input: AgentRunInput }
  | { type: "tool_result"; runId: string; callId: string; ok: boolean; text: string };

export type AgentHostEvent =
  | { type: "tool"; runId: string; callId: string; name: string; args: unknown }
  | { type: "text"; runId: string; delta: string }
  | { type: "done"; runId: string; text: string }
  | { type: "error"; runId: string; message: string };

export type ToolHostRequest = {
  type: "execute";
  callId: string;
  name: string;
  args: unknown;
  workspaceRoot: string | null;
  skillDirs: string[];
};

export type ToolHostEvent = {
  type: "result";
  callId: string;
  ok: boolean;
  text: string;
};
