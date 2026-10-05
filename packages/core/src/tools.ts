import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PathGuardError, resolveWorkspaceCwd, resolveWorkspaceFile } from "./path-guard.js";
import { loadSkill } from "./skills.js";

const MAX_TEXT_BYTES = 200_000;
const MAX_SHELL_OUTPUT = 32_000;
const SHELL_TIMEOUT_MS = 30_000;

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export interface ExecuteToolInput {
  name: string;
  args: unknown;
  workspaceRoot: string | null;
  skillDirs: readonly string[];
}

function argsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function shellBinary(): string {
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function shellEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（输出已截断）`;
}

function runShell(command: string, cwd: string): Promise<ToolOutcome> {
  return new Promise((resolve) => {
    const child = spawn(shellBinary(), ["-lc", command], {
      cwd,
      env: shellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: ToolOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, text: "命令超时（30 秒）" });
    }, SHELL_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = clip(stdout + chunk, MAX_SHELL_OUTPUT);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = clip(stderr + chunk, MAX_SHELL_OUTPUT);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, text: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = [`exit ${code ?? "null"}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
        .filter(Boolean)
        .join("\n");
      finish({ ok: code === 0, text });
    });
  });
}

/**
 * Executes a tool that the main process has already approved.
 * This is the body of the tool worker. It checks the workspace boundary again.
 */
export async function executeApprovedTool(input: ExecuteToolInput): Promise<ToolOutcome> {
  const args = argsOf(input.args);
  try {
    switch (input.name) {
      case "read_file": {
        if (!input.workspaceRoot) return { ok: false, text: "还没有选择工作区" };
        const filePath = resolveWorkspaceFile(input.workspaceRoot, String(args.path ?? ""));
        const stat = statSync(filePath);
        if (!stat.isFile()) return { ok: false, text: "不是文件" };
        if (stat.size > MAX_TEXT_BYTES) return { ok: false, text: "文件超过 200KB，已拒绝读取" };
        const text = readFileSync(filePath, "utf8");
        return { ok: true, text };
      }
      case "write_file": {
        if (!input.workspaceRoot) return { ok: false, text: "还没有选择工作区" };
        const content = args.content;
        if (typeof content !== "string") return { ok: false, text: "content 必须是字符串" };
        if (Buffer.byteLength(content) > MAX_TEXT_BYTES) return { ok: false, text: "内容超过 200KB" };
        const filePath = resolveWorkspaceFile(input.workspaceRoot, String(args.path ?? ""));
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, "utf8");
        return { ok: true, text: `已写入 ${args.path}` };
      }
      case "run_shell": {
        if (!input.workspaceRoot) return { ok: false, text: "还没有选择工作区" };
        const command = typeof args.command === "string" ? args.command : "";
        const cwd = resolveWorkspaceCwd(
          input.workspaceRoot,
          typeof args.cwd === "string" ? args.cwd : undefined,
        );
        return await runShell(command, cwd);
      }
      case "skill_load": {
        const name = typeof args.name === "string" ? args.name : "";
        const skill = loadSkill(input.skillDirs, name);
        if (!skill) return { ok: false, text: `找不到技能 ${name}` };
        return { ok: true, text: `# ${skill.name}\n\n${skill.description}\n\n${skill.body}` };
      }
      default:
        return { ok: false, text: `工具工人不能执行 ${input.name}` };
    }
  } catch (error) {
    const message = error instanceof PathGuardError ? error.message : error instanceof Error ? error.message : "执行失败";
    return { ok: false, text: message };
  }
}
