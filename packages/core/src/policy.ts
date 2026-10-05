import { isCapabilityId, type CapabilityId } from "./capabilities.js";
import { PathGuardError, resolveWorkspaceCwd, resolveWorkspaceFile } from "./path-guard.js";

export type RiskTier = "low" | "medium" | "high";

export type PolicyDecision =
  | { kind: "allow"; tier: RiskTier; reason: string }
  | { kind: "require_approval"; tier: RiskTier; reason: string }
  | { kind: "deny"; reason: string };

export interface PolicyInput {
  tool: string;
  args: unknown;
  workspaceRoot: string | null;
  loaded: readonly CapabilityId[];
}

function argsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/** Small denylist. Approval is the real control; this only stops a few catastrophic commands. */
export function blockedShellReason(command: string): string | null {
  const normalized = command.trim();
  if (/\brm\s+(-\S+\s+)*\/(\s|$)/.test(normalized)) return "拒绝删除文件系统根目录";
  if (/\bmkfs(\.|$|\s)/.test(normalized)) return "拒绝 mkfs";
  if (/\bdd\s+if=/.test(normalized)) return "拒绝 dd";
  if (/\b(shutdown|reboot|poweroff|halt)\b/.test(normalized)) return "拒绝关机或重启命令";
  if (/:\(\)\s*\{/.test(normalized)) return "拒绝疑似 fork bomb";
  if (/\bdiskutil\s+eraseDisk\b/i.test(normalized)) return "拒绝抹盘命令";
  return null;
}

function needsCapability(loaded: readonly CapabilityId[], id: CapabilityId, tool: string): PolicyDecision | null {
  if (loaded.includes(id)) return null;
  return { kind: "deny", reason: `工具 ${tool} 尚未加载。请先 capability_load ${id}` };
}

/**
 * Risk policy for P0 tools.
 * Reads inside the workspace are allowed. Writes and shell require approval.
 * Anything outside the workspace, or a workspace rooted at `/`, is denied.
 */
export function classifyAction(input: PolicyInput): PolicyDecision {
  const args = argsOf(input.args);
  switch (input.tool) {
    case "capability_load": {
      const capability = args.capability;
      if (!isCapabilityId(capability)) {
        return { kind: "deny", reason: "capability_load 需要 files、shell 或 skills" };
      }
      return { kind: "allow", tier: "low", reason: `加载能力 ${capability}` };
    }
    case "read_file": {
      const missing = needsCapability(input.loaded, "files", input.tool);
      if (missing) return missing;
      if (!input.workspaceRoot) return { kind: "deny", reason: "还没有选择工作区" };
      const filePath = stringArg(args, "path");
      if (!filePath) return { kind: "deny", reason: "read_file 需要 path" };
      try {
        resolveWorkspaceFile(input.workspaceRoot, filePath);
      } catch (error) {
        const message = error instanceof PathGuardError ? error.message : "路径被拒绝";
        return { kind: "deny", reason: message };
      }
      return { kind: "allow", tier: "low", reason: "读取工作区内的文件" };
    }
    case "write_file": {
      const missing = needsCapability(input.loaded, "files", input.tool);
      if (missing) return missing;
      if (!input.workspaceRoot) return { kind: "deny", reason: "还没有选择工作区" };
      const filePath = stringArg(args, "path");
      if (!filePath || typeof args.content !== "string") {
        return { kind: "deny", reason: "write_file 需要 path 和 content" };
      }
      try {
        resolveWorkspaceFile(input.workspaceRoot, filePath);
      } catch (error) {
        const message = error instanceof PathGuardError ? error.message : "路径被拒绝";
        return { kind: "deny", reason: message };
      }
      return { kind: "require_approval", tier: "medium", reason: "写入工作区内的文件" };
    }
    case "run_shell": {
      const missing = needsCapability(input.loaded, "shell", input.tool);
      if (missing) return missing;
      if (!input.workspaceRoot) return { kind: "deny", reason: "还没有选择工作区" };
      const command = stringArg(args, "command");
      if (!command?.trim()) return { kind: "deny", reason: "run_shell 需要 command" };
      if (command.length > 4000) return { kind: "deny", reason: "命令过长" };
      const blocked = blockedShellReason(command);
      if (blocked) return { kind: "deny", reason: blocked };
      const cwd = stringArg(args, "cwd");
      try {
        resolveWorkspaceCwd(input.workspaceRoot, cwd);
      } catch (error) {
        const message = error instanceof PathGuardError ? error.message : "工作目录被拒绝";
        return { kind: "deny", reason: message };
      }
      return {
        kind: "require_approval",
        tier: "high",
        reason: "在工作区目录内运行 Shell。命令仍可能尝试访问工作区以外的路径，请阅读后再批准",
      };
    }
    case "skill_load": {
      const missing = needsCapability(input.loaded, "skills", input.tool);
      if (missing) return missing;
      const name = stringArg(args, "name");
      if (!name) return { kind: "deny", reason: "skill_load 需要 name" };
      return { kind: "allow", tier: "low", reason: "读取技能说明" };
    }
    default:
      return { kind: "deny", reason: `未知工具 ${input.tool}` };
  }
}
