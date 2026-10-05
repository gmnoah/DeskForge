import assert from "node:assert/strict";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { resolveModelProfile } from "@deskforge/core";
import { createPiAgentLoop, toPiModel } from "./pi-loop.js";

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function finish(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  if (message.content.some((block) => block.type === "text")) {
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message,
    });
  }
  const reason = message.stopReason === "toolUse" ? "toolUse" : "stop";
  stream.push({ type: "done", reason, message });
  return stream;
}

test("model baseUrl is taken from the profile", () => {
  const profile = resolveModelProfile({
    preset: "custom",
    baseUrl: "https://llm.example.test/v1",
    model: "desk-model",
  });
  const model = toPiModel(profile);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://llm.example.test/v1");
  assert.equal(model.provider, "deskforge");
  assert.equal(model.id, "desk-model");
});

test("Pi loop loads a capability and then calls the new tool", async () => {
  const profile = resolveModelProfile({ preset: "deepseek" });
  const calls: string[] = [];
  let turn = 0;
  const streamFn: StreamFn = () => {
    turn += 1;
    const base = {
      role: "assistant" as const,
      api: "openai-completions" as const,
      provider: "deskforge",
      model: profile.model,
      usage: emptyUsage(),
      timestamp: Date.now(),
    };
    if (turn === 1) {
      return finish({
        ...base,
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "capability_load", arguments: { capability: "files" } }],
      });
    }
    if (turn === 2) {
      return finish({
        ...base,
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c2", name: "read_file", arguments: { path: "note.txt" } }],
      });
    }
    return finish({
      ...base,
      stopReason: "stop",
      content: [{ type: "text", text: "看到了" }],
    });
  };

  const loop = createPiAgentLoop({ streamFn });
  const deltas: string[] = [];
  const result = await loop.run(
    {
      systemPrompt: "test",
      history: [],
      userText: "读一下 note.txt",
      profile,
      apiKey: "test-key",
      loadedCapabilities: [],
      workspaceRoot: "/tmp/deskforge-workspace",
    },
    {
      onTextDelta: (delta) => deltas.push(delta),
      executeTool: async (call) => {
        calls.push(call.name);
        return { ok: true, text: call.name === "read_file" ? "笔记" : "已加载 files" };
      },
    },
  );

  assert.deepEqual(calls, ["capability_load", "read_file"]);
  assert.equal(result.text, "看到了");
  assert.deepEqual(deltas, ["看到了"]);
});
