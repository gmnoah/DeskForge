import { utilityProcess, type UtilityProcess } from "electron";
import type { AgentHostEvent, AgentHostRequest, ToolHostEvent, ToolHostRequest, ToolOutcome } from "@deskforge/core";

interface ToolWaiter {
  resolve: (result: ToolOutcome) => void;
  reject: (error: Error) => void;
}

interface RunHandlers {
  onText: (delta: string) => void;
  onTool: (call: { callId: string; name: string; args: unknown }) => void;
  resolve: (result: { text: string }) => void;
  reject: (error: Error) => void;
}

function unwrap(message: unknown): unknown {
  if (message && typeof message === "object" && "data" in message && !("type" in message)) {
    return (message as { data: unknown }).data;
  }
  return message;
}

/**
 * Owns the two utility processes.
 * The agent worker may call the model. The tool worker may touch the workspace.
 * Neither one approves its own actions; that stays in the main process.
 */
export class WorkerSupervisor {
  private agent: UtilityProcess | null = null;
  private tool: UtilityProcess | null = null;
  private agentReady: Promise<void> | null = null;
  private toolReady: Promise<void> | null = null;
  private readonly runs = new Map<string, RunHandlers>();
  private readonly tools = new Map<string, ToolWaiter>();

  constructor(
    private readonly agentEntry: string,
    private readonly toolEntry: string,
  ) {}

  start(): { agent: Promise<void>; tool: Promise<void> } {
    this.agentReady = this.boot("agent");
    this.toolReady = this.boot("tool");
    return { agent: this.agentReady, tool: this.toolReady };
  }

  async execute(request: Omit<ToolHostRequest, "type">): Promise<ToolOutcome> {
    if (!this.tool) this.toolReady = this.boot("tool");
    await this.toolReady;
    const child = this.tool;
    if (!child) throw new Error("工具进程没有启动");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tools.delete(request.callId);
        reject(new Error("工具进程超时"));
      }, 45_000);
      this.tools.set(request.callId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const message: ToolHostRequest = { type: "execute", ...request };
      child.postMessage(message);
    });
  }

  async run(
    request: Omit<AgentHostRequest & { type: "run" }, "type">,
    handlers: { onText: (delta: string) => void; onTool: RunHandlers["onTool"] },
  ): Promise<{ text: string }> {
    if (!this.agent) this.agentReady = this.boot("agent");
    await this.agentReady;
    const child = this.agent;
    if (!child) throw new Error("agent 进程没有启动");
    return new Promise((resolve, reject) => {
      this.runs.set(request.runId, { ...handlers, resolve, reject });
      const message: AgentHostRequest = { type: "run", runId: request.runId, input: request.input };
      child.postMessage(message);
    });
  }

  answerTool(result: { runId: string; callId: string; ok: boolean; text: string }): void {
    this.agent?.postMessage({ type: "tool_result", ...result });
  }

  stop(): void {
    this.agent?.kill();
    this.tool?.kill();
    this.agent = null;
    this.tool = null;
  }

  private boot(kind: "agent" | "tool"): Promise<void> {
    const entry = kind === "agent" ? this.agentEntry : this.toolEntry;
    const child = utilityProcess.fork(entry, [], {
      serviceName: `deskforge-${kind}`,
      stdio: "inherit",
    });
    if (kind === "agent") this.agent = child;
    else this.tool = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${kind} 进程没有就绪`)), 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (kind === "agent") this.agent = null;
        else this.tool = null;
        const error = new Error(`${kind} 进程已退出 (${code ?? "null"})`);
        for (const [id, waiter] of this.tools) {
          waiter.reject(error);
          this.tools.delete(id);
        }
        for (const [id, run] of this.runs) {
          run.reject(error);
          this.runs.delete(id);
        }
      });
      child.on("message", (raw: unknown) => {
        const message = unwrap(raw) as { type?: string };
        if (message?.type === "ready") {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (kind === "tool") this.onTool(message as ToolHostEvent);
        else this.onAgent(message as AgentHostEvent);
      });
    });
  }

  private onTool(message: ToolHostEvent): void {
    if (message?.type !== "result") return;
    const waiter = this.tools.get(message.callId);
    if (!waiter) return;
    this.tools.delete(message.callId);
    waiter.resolve({ ok: message.ok, text: message.text });
  }

  private onAgent(message: AgentHostEvent): void {
    if (!message || typeof message !== "object" || !("runId" in message)) return;
    const run = this.runs.get(message.runId);
    if (!run) return;
    if (message.type === "text") {
      run.onText(message.delta);
      return;
    }
    if (message.type === "tool") {
      run.onTool({ callId: message.callId, name: message.name, args: message.args });
      return;
    }
    if (message.type === "done") {
      this.runs.delete(message.runId);
      run.resolve({ text: message.text });
      return;
    }
    if (message.type === "error") {
      this.runs.delete(message.runId);
      run.reject(new Error(message.message));
    }
  }
}
