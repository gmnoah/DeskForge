import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

/** Reject empty paths and the filesystem root. `/` is never a valid workspace. */
export function assertSafeWorkspaceRoot(root: string): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new PathGuardError("工作区路径不能为空");
  }
  if (!path.isAbsolute(root)) {
    throw new PathGuardError("工作区必须是绝对路径");
  }
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new PathGuardError("拒绝把文件系统根目录当作工作区");
  }
  return resolved;
}

function existingRealPath(candidate: string): { real: string; missing: string[] } {
  const missing: string[] = [];
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PathGuardError("路径不在工作区内");
    }
    missing.push(path.basename(current));
    current = parent;
  }
  return { real: realpathSync(current), missing: missing.reverse() };
}

function assertInside(baseReal: string, real: string): void {
  const relative = path.relative(baseReal, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathGuardError("路径不在工作区内");
  }
}

/**
 * Resolve a user-supplied file path and prove the real path stays inside the workspace.
 * Symlinks that point outside the workspace are rejected.
 */
export function resolveWorkspaceFile(root: string, userPath: string): string {
  const base = assertSafeWorkspaceRoot(root);
  if (typeof userPath !== "string" || userPath.trim() === "" || userPath.includes("\0")) {
    throw new PathGuardError("文件路径无效");
  }
  const baseReal = realpathSync(base);
  const candidate = path.resolve(baseReal, userPath);
  const { real, missing } = existingRealPath(candidate);
  if (missing.length === 0 && real === baseReal) {
    throw new PathGuardError("不能把工作区目录本身当作文件");
  }
  assertInside(baseReal, real);
  const target = path.join(real, ...missing);
  const relative = path.relative(baseReal, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathGuardError("路径不在工作区内");
  }
  return target;
}

/** Working directory for a shell command: the workspace root or a directory inside it. */
export function resolveWorkspaceCwd(root: string, cwd?: string): string {
  const base = assertSafeWorkspaceRoot(root);
  const baseReal = realpathSync(base);
  if (cwd === undefined || cwd.trim() === "" || cwd === ".") {
    const stat = statSync(baseReal);
    if (!stat.isDirectory()) throw new PathGuardError("工作区不是目录");
    return baseReal;
  }
  if (cwd.includes("\0")) throw new PathGuardError("工作目录无效");
  const candidate = path.resolve(baseReal, cwd);
  const { real, missing } = existingRealPath(candidate);
  if (missing.length > 0) throw new PathGuardError("工作目录不存在");
  if (real !== baseReal) assertInside(baseReal, real);
  const stat = statSync(real);
  if (!stat.isDirectory()) throw new PathGuardError("工作目录不是文件夹");
  return real;
}
