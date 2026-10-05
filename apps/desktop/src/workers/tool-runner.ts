import { executeApprovedTool, type ToolHostEvent, type ToolHostRequest } from "@deskforge/core";
import { requireParentPort } from "./parent-port.js";

const port = requireParentPort();

port.on("message", (event) => {
  const data = event.data as ToolHostRequest | undefined;
  if (!data || data.type !== "execute") return;
  void executeApprovedTool({
    name: data.name,
    args: data.args,
    workspaceRoot: data.workspaceRoot,
    skillDirs: data.skillDirs,
  }).then((result) => {
    const message: ToolHostEvent = { type: "result", callId: data.callId, ok: result.ok, text: result.text };
    port.postMessage(message);
  });
});

port.postMessage({ type: "ready" });
