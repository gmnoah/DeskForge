import { randomUUID } from "node:crypto";
import { createPiAgentLoop } from "@deskforge/agent";
import { redactText, type AgentHostEvent, type AgentHostRequest } from "@deskforge/core";
import { requireParentPort } from "./parent-port.js";

const port = requireParentPort();
const loop = createPiAgentLoop();
const pending = new Map<string, (result: { ok: boolean; text: string }) => void>();
let active = false;

function post(message: AgentHostEvent | { type: "ready" }): void {
  port.postMessage(message);
}

port.on("message", (event) => {
  const data = event.data as AgentHostRequest | undefined;
  if (!data || typeof data !== "object") return;
  if (data.type === "tool_result") {
    pending.get(data.callId)?.({ ok: data.ok, text: data.text });
    pending.delete(data.callId);
    return;
  }
  if (data.type !== "run") return;
  if (active) {
    post({ type: "error", runId: data.runId, message: "已有进行中的运行" });
    return;
  }
  active = true;
  const secret = data.input.apiKey;
  void loop
    .run(data.input, {
      onTextDelta: (delta) => post({ type: "text", runId: data.runId, delta }),
      executeTool: (call) =>
        new Promise((resolve) => {
          const callId = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(callId);
            resolve({ ok: false, text: "等待主进程超时" });
          }, 5 * 60 * 1000);
          pending.set(callId, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
          post({ type: "tool", runId: data.runId, callId, name: call.name, args: call.args });
        }),
    })
    .then(
      (result) => post({ type: "done", runId: data.runId, text: result.text }),
      (error: unknown) =>
        post({
          type: "error",
          runId: data.runId,
          message: redactText(error instanceof Error ? error.message : "agent 失败", secret),
        }),
    )
    .finally(() => {
      active = false;
    });
});

post({ type: "ready" });
