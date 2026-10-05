export interface UtilityParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

export function requireParentPort(): UtilityParentPort {
  const port = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
  if (!port) {
    throw new Error("DeskForge worker 必须作为 Electron utilityProcess 启动");
  }
  return port;
}
