import { agentLoop, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  CAPABILITIES,
  redactText,
  type AgentDriver,
  type AgentRunInput,
  type AgentToolHooks,
  type CapabilityId,
  type ModelProfile,
} from "@deskforge/core";

const MAX_TOOL_CALLS = 16;

export interface PiAgentLoopOptions {
  /** Replaces the OpenAI-compatible HTTP stream. Tests pass a scripted stream. */
  streamFn?: StreamFn;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** OpenAI-compatible model record. baseUrl always comes from the DeskForge profile. */
export function toPiModel(profile: ModelProfile): Model<"openai-completions"> {
  return {
    id: profile.model,
    name: profile.label,
    api: "openai-completions",
    provider: "deskforge",
    baseUrl: profile.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function errorStream(error: unknown, secret: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "deskforge",
    model: "unknown",
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: redactText(error instanceof Error ? error.message : "模型请求失败", secret).slice(0, 500),
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

function isTranscriptMessage(message: { role?: string }): boolean {
  return message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/**
 * Pi agent loop. Pi chooses tool calls; it does not grant permission.
 * Every execute() returns through AgentToolHooks so the main process can approve.
 */
export function createPiAgentLoop(options: PiAgentLoopOptions = {}): AgentDriver {
  const providerStream: StreamFn =
    options.streamFn ??
    ((model, context, streamOptions) => streamSimple(model as Model<"openai-completions">, context, streamOptions));

  return {
    async run(input: AgentRunInput, hooks: AgentToolHooks, signal?: AbortSignal): Promise<{ text: string }> {
      let toolCalls = 0;
      const bridge = async (name: string, args: unknown) => {
        toolCalls += 1;
        if (toolCalls > MAX_TOOL_CALLS) {
          return {
            content: [{ type: "text" as const, text: "工具调用次数已达上限" }],
            details: { ok: false },
            isError: true,
            terminate: true,
          };
        }
        const outcome = await hooks.executeTool({ name, args });
        return {
          content: [{ type: "text" as const, text: outcome.text }],
          details: { ok: outcome.ok },
          isError: !outcome.ok,
        };
      };

      const tools: AgentTool[] = [];
      const add = (tool: AgentTool) => {
        if (!tools.some((item) => item.name === tool.name)) tools.push(tool);
      };
      const toolsFor = (id: CapabilityId): AgentTool[] => {
        if (id === "files") {
          return [
            {
              name: "read_file",
              label: "读取文件",
              description: "读取工作区内的 UTF-8 文本文件。path 相对工作区根目录。",
              parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
              executionMode: "sequential",
              execute: async (_toolCallId, params) => bridge("read_file", params),
            },
            {
              name: "write_file",
              label: "写入文件",
              description: "写入工作区内的文本文件。会请求用户批准。",
              parameters: Type.Object({
                path: Type.String({ minLength: 1 }),
                content: Type.String(),
              }),
              executionMode: "sequential",
              execute: async (_toolCallId, params) => bridge("write_file", params),
            },
          ];
        }
        if (id === "shell") {
          return [
            {
              name: "run_shell",
              label: "运行命令",
              description: "在工作区目录内运行一条 Shell 命令。每次执行都要等用户批准。不要把工作目录设到工作区外。",
              parameters: Type.Object({
                command: Type.String({ minLength: 1 }),
                cwd: Type.Optional(Type.String()),
              }),
              executionMode: "sequential",
              execute: async (_toolCallId, params) => bridge("run_shell", params),
            },
          ];
        }
        return [
          {
            name: "skill_load",
            label: "读取技能",
            description: "按目录名读取 SKILL.md。name 是小写短横线标识。",
            parameters: Type.Object({ name: Type.String({ minLength: 1 }) }),
            executionMode: "sequential",
            execute: async (_toolCallId, params) => bridge("skill_load", params),
          },
        ];
      };

      add({
        name: "capability_load",
        label: "加载能力",
        description: `按需加载能力：${Object.values(CAPABILITIES)
          .map((item) => item.id)
          .join("、")}。加载后同一轮里就可以调用对应工具。`,
        parameters: Type.Object({
          capability: Type.Union([Type.Literal("files"), Type.Literal("shell"), Type.Literal("skills")]),
        }),
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
          const outcome = await bridge("capability_load", params);
          const capability = (params as { capability?: CapabilityId }).capability;
          if (!outcome.isError && (capability === "files" || capability === "shell" || capability === "skills")) {
            for (const tool of toolsFor(capability)) add(tool);
          }
          return outcome;
        },
      });
      for (const id of input.loadedCapabilities) {
        for (const tool of toolsFor(id)) add(tool);
      }

      const model = toPiModel(input.profile);
      const context = {
        messages: [
          { role: "system" as const, content: input.systemPrompt, timestamp: Date.now() },
          ...input.history.map((entry) =>
            entry.role === "user"
              ? { role: "user" as const, content: entry.content, timestamp: Date.now() }
              : {
                  role: "assistant" as const,
                  content: [{ type: "text" as const, text: entry.content }],
                  api: "openai-completions" as const,
                  provider: "deskforge",
                  model: input.profile.model,
                  usage: emptyUsage(),
                  stopReason: "stop" as const,
                  timestamp: Date.now(),
                },
          ),
        ],
        tools,
      };

      const stream = agentLoop(
        [{ role: "user", content: input.userText, timestamp: Date.now() }],
        context,
        {
          model,
          apiKey: input.apiKey,
          toolExecution: "sequential",
          convertToLlm: (messages) => messages.filter(isTranscriptMessage),
          getApiKey: () => input.apiKey,
        },
        signal,
        async (nextModel, nextContext, streamOptions) => {
          try {
            return await providerStream(nextModel, nextContext, streamOptions);
          } catch (error) {
            return errorStream(error, input.apiKey);
          }
        },
      );

      let finalText = "";
      let failure: string | undefined;
      for await (const event of stream) {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          hooks.onTextDelta?.(event.assistantMessageEvent.delta);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const assistant = event.message;
          finalText = textOf(assistant);
          if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
            failure = assistant.errorMessage || "模型请求失败";
          }
        }
      }

      if (failure) throw new Error(redactText(failure, input.apiKey));
      return { text: finalText || "（模型没有返回文本）" };
    },
  };
}
