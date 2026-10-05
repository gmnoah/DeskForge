import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  MODEL_PRESETS,
  SessionStore,
  assertSafeWorkspaceRoot,
  buildSystemPrompt,
  coordinateToolCall,
  presetById,
  resolveApiKey,
  resolveModelProfile,
  type ApprovalRequest,
  type CapabilityId,
  type ModelProfile,
  type PresetId,
} from "@deskforge/core";
import { WorkerSupervisor } from "./supervisor.js";

interface PendingApproval {
  id: string;
  sessionId: string;
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
}

let memoryKey: string | undefined;
let running = false;
const approvals = new Map<string, PendingApproval>();

let store: SessionStore;
let supervisor: WorkerSupervisor;
let window: BrowserWindow | null = null;

function appRoot(): string {
  return app.getAppPath();
}

function send(event: unknown): void {
  window?.webContents.send("deskforge:event", event);
}

function currentProfile(): ModelProfile | null {
  const raw = store.getSetting("modelProfile");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelProfile;
  } catch {
    return null;
  }
}

function currentWorkspace(): string | null {
  return store.getSetting("workspaceRoot");
}

function skillDirs(workspaceRoot: string | null): string[] {
  const dirs = [path.join(appRoot(), "resources", "skills")];
  if (workspaceRoot) dirs.push(path.join(workspaceRoot, ".deskforge", "skills"));
  return dirs;
}

function publishAudit(): void {
  send({ type: "audit", records: store.listAudit(12), auditOk: store.verifyAudit().ok });
}

async function handleTool(sessionId: string, call: { name: string; args: unknown }): Promise<{ ok: boolean; text: string; loadedCapability?: CapabilityId }> {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, text: "会话不存在" };
  const loaded = [...session.capabilities];
  const result = await coordinateToolCall({
    call,
    workspaceRoot: session.workspaceRoot,
    loaded,
    approve: (request) =>
      new Promise((resolve) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          approvals.delete(id);
          send({ type: "approval-closed", id });
          resolve(false);
        }, 5 * 60 * 1000);
        approvals.set(id, {
          id,
          sessionId,
          request,
          resolve: (approved) => {
            clearTimeout(timer);
            approvals.delete(id);
            send({ type: "approval-closed", id });
            resolve(approved);
          },
        });
        send({ type: "approval", id, sessionId, request });
      }),
    execute: async (approvedCall) => {
      const callId = randomUUID();
      return supervisor.execute({
        callId,
        name: approvedCall.name,
        args: approvedCall.args,
        workspaceRoot: session.workspaceRoot,
        skillDirs: skillDirs(session.workspaceRoot),
      });
    },
    recordAudit: (event) => {
      store.appendAudit({ sessionId, action: event.action, decision: event.decision, payload: event.payload });
      publishAudit();
    },
  });
  if (result.loadedCapability && !loaded.includes(result.loadedCapability)) {
    store.updateSession(sessionId, { capabilities: [...loaded, result.loadedCapability] });
  }
  return result;
}

async function sendMessage(sessionId: string | undefined, text: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "请输入内容" };
  if (running) return { ok: false, error: "上一轮还在进行" };
  const profile = currentProfile();
  if (!profile) return { ok: false, error: "请先保存模型设置" };
  const apiKey = resolveApiKey(profile, process.env, memoryKey);
  if (!apiKey) {
    const where = profile.apiKeyEnv === "DESKFORGE_API_KEY" ? "DESKFORGE_API_KEY" : `${profile.apiKeyEnv} 或 DESKFORGE_API_KEY`;
    return { ok: false, error: `没有 API key。可以设置 ${where}，或在界面里临时填写。` };
  }

  const workspaceRoot = currentWorkspace();
  let session = sessionId ? store.getSession(sessionId) : null;
  if (!session) {
    session = store.createSession({
      title: trimmed.slice(0, 24),
      workspaceRoot,
      profile,
    });
    send({ type: "sessions", sessions: store.listSessions() });
  } else {
    store.updateSession(session.id, { workspaceRoot, profile });
    session = store.getSession(session.id)!;
  }

  store.addMessage({ sessionId: session.id, role: "user", content: trimmed });
  const history = store.listMessages(session.id).slice(0, -1).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  send({ type: "messages", sessionId: session.id, messages: store.listMessages(session.id) });

  const runId = randomUUID();
  running = true;
  send({ type: "status", running: true, sessionId: session.id });
  let streamed = "";
  try {
    // The key is passed only into the agent worker for this run.
    // TODO(P1): proxy the model HTTP call in the main process so the worker never sees it.
    const result = await supervisor.run(
      {
        runId,
        input: {
          systemPrompt: buildSystemPrompt(session.workspaceRoot),
          history,
          userText: trimmed,
          profile,
          apiKey,
          loadedCapabilities: session.capabilities,
          workspaceRoot: session.workspaceRoot,
        },
      },
      {
        onText: (delta) => {
          streamed += delta;
          send({ type: "text", sessionId: session.id, delta, text: streamed });
        },
        onTool: (call) => {
          void handleTool(session.id, { name: call.name, args: call.args })
            .then((outcome) => {
              supervisor.answerTool({ runId, callId: call.callId, ok: outcome.ok, text: outcome.text });
            })
            .catch((error: unknown) => {
              supervisor.answerTool({
                runId,
                callId: call.callId,
                ok: false,
                text: error instanceof Error ? error.message : "主进程处理工具失败",
              });
            });
        },
      },
    );
    store.addMessage({ sessionId: session.id, role: "assistant", content: result.text });
    send({ type: "messages", sessionId: session.id, messages: store.listMessages(session.id) });
    return { ok: true, sessionId: session.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行失败";
    store.addMessage({ sessionId: session.id, role: "assistant", content: message });
    send({ type: "error", message, sessionId: session.id });
    send({ type: "messages", sessionId: session.id, messages: store.listMessages(session.id) });
    return { ok: false, error: message, sessionId: session.id };
  } finally {
    running = false;
    send({ type: "status", running: false, sessionId: session.id });
  }
}

function bootstrap() {
  const profile = currentProfile();
  const audit = store.verifyAudit();
  return {
    presets: MODEL_PRESETS,
    workspaceRoot: currentWorkspace(),
    profile,
    hasApiKey: profile ? Boolean(resolveApiKey(profile, process.env, memoryKey)) : Boolean(memoryKey || process.env.DESKFORGE_API_KEY),
    envBaseUrl: process.env.DESKFORGE_BASE_URL?.trim() ?? "",
    envModel: process.env.DESKFORGE_MODEL?.trim() ?? "",
    sessions: store.listSessions(),
    auditOk: audit.ok,
    audit: store.listAudit(12),
    platform: process.platform,
  };
}

function saveSettings(payload: unknown): { ok: boolean; error?: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "设置无效" };
  const body = payload as { preset?: string; baseUrl?: string; model?: string; apiKey?: string | null };
  if (!body.preset || !presetById(body.preset)) return { ok: false, error: "未知预设" };
  try {
    const profile = resolveModelProfile({
      preset: body.preset as PresetId,
      baseUrl: body.baseUrl,
      model: body.model,
    });
    store.setSetting("modelProfile", JSON.stringify(profile));
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      memoryKey = body.apiKey.trim();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "无法保存模型设置" };
  }
}

async function chooseWorkspace(): Promise<{ ok: boolean; workspaceRoot?: string; error?: string }> {
  const result = await dialog.showOpenDialog({
    title: "选择 DeskForge 工作区",
    properties: ["openDirectory", "createDirectory"],
  });
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return { ok: false, error: "没有选择文件夹" };
  try {
    const root = assertSafeWorkspaceRoot(selected);
    if (!statSync(root).isDirectory()) return { ok: false, error: "不是文件夹" };
    store.setSetting("workspaceRoot", root);
    return { ok: true, workspaceRoot: root };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "工作区无效" };
  }
}

function registerIpc(): void {
  ipcMain.handle("deskforge:invoke", async (_event, message: unknown) => {
    const body = message as { method?: string; payload?: unknown };
    switch (body?.method) {
      case "bootstrap":
        return bootstrap();
      case "saveSettings":
        return saveSettings(body.payload);
      case "chooseWorkspace":
        return chooseWorkspace();
      case "messages": {
        const sessionId = (body.payload as { sessionId?: string } | undefined)?.sessionId;
        if (!sessionId) return [];
        return store.listMessages(sessionId);
      }
      case "send": {
        const payload = body.payload as { sessionId?: string; text?: string } | undefined;
        return sendMessage(payload?.sessionId, payload?.text ?? "");
      }
      case "decide": {
        const payload = body.payload as { id?: string; approved?: boolean } | undefined;
        const pending = payload?.id ? approvals.get(payload.id) : undefined;
        if (!pending) return { ok: false, error: "这条审批已经结束" };
        pending.resolve(Boolean(payload?.approved));
        return { ok: true };
      }
      default:
        return { ok: false, error: "未知请求" };
    }
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 880,
    minHeight: 640,
    title: "DeskForge",
    backgroundColor: "#f3efe6",
    webPreferences: {
      preload: path.join(appRoot(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  void win.loadFile(path.join(appRoot(), "renderer", "index.html"));
  return win;
}

app.setName("DeskForge");
if (process.env.DESKFORGE_SMOKE === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}
if (process.platform !== "darwin") {
  console.warn("DeskForge P0 的目标平台是 macOS。当前系统仍可用来检查界面和单元测试。");
}

app.whenReady().then(() => {
  store = new SessionStore(path.join(app.getPath("userData"), "deskforge.sqlite"));
  supervisor = new WorkerSupervisor(
    path.join(appRoot(), "dist", "workers", "agent-host.js"),
    path.join(appRoot(), "dist", "workers", "tool-runner.js"),
  );
  const ready = supervisor.start();
  registerIpc();
  window = createWindow();
  const smoke = process.env.DESKFORGE_SMOKE === "1";
  if (smoke) {
    const loaded = new Promise<void>((resolve, reject) => {
      window?.webContents.once("did-finish-load", () => {
        void window?.webContents
          .executeJavaScript(`(async () => {
            for (let i = 0; i < 40; i += 1) {
              const presets = document.querySelectorAll("#preset option").length;
              if (presets >= 4 && document.querySelector("#workspace")) break;
              await new Promise((done) => setTimeout(done, 50));
            }
            document.querySelector("#settings").requestSubmit();
            let status = "";
            for (let i = 0; i < 40; i += 1) {
              status = document.querySelector("#status").textContent || "";
              if (status.includes("模型已保存")) break;
              await new Promise((done) => setTimeout(done, 50));
            }
            return {
              presets: document.querySelectorAll("#preset option").length,
              workspace: document.querySelector("#workspace").textContent,
              title: document.querySelector(".mark").textContent,
              api: typeof window.deskforge,
              baseUrl: document.querySelector("#base-url").value,
              status,
              keyState: document.querySelector("#key-state").textContent,
            };
          })()`)
          .then(async (report: { presets: number; workspace: string; title: string; api: string; baseUrl: string; status: string; keyState: string }) => {
            if (report.title !== "DeskForge" || report.presets !== 4 || report.api !== "object") {
              reject(new Error(`界面检查失败 ${JSON.stringify(report)}`));
              return;
            }
            if (!report.workspace.includes("不会默认使用") || report.baseUrl.includes("api.deepseek.com") === false) {
              reject(new Error(`默认状态不对 ${JSON.stringify(report)}`));
              return;
            }
            if (!report.status.includes("模型已保存") || !report.keyState.includes("还没有密钥")) {
              reject(new Error(`保存模型没有反映到界面 ${JSON.stringify(report)}`));
              return;
            }
            if (process.env.DESKFORGE_SHOT === "1" && window) {
              const image = await window.webContents.capturePage();
              mkdirSync("/tmp/deskforge", { recursive: true });
              writeFileSync("/tmp/deskforge/smoke.png", image.toPNG());
            }
            resolve();
          })
          .catch(reject);
      });
    });
    void Promise.all([ready.agent, ready.tool, loaded])
      .then(() => {
        console.log("deskforge-ready");
        app.exit(0);
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        app.exit(1);
      });
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  supervisor?.stop();
  store?.close();
});
