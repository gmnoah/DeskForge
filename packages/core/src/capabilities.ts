export const CAPABILITY_IDS = ["files", "shell", "skills"] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilitySpec {
  id: CapabilityId;
  description: string;
  tools: readonly string[];
}

export const CAPABILITIES: Record<CapabilityId, CapabilitySpec> = {
  files: {
    id: "files",
    description: "读取和写入当前工作区内的文本文件",
    tools: ["read_file", "write_file"],
  },
  shell: {
    id: "shell",
    description: "在工作区目录内运行 Shell。每次执行都需要你批准",
    tools: ["run_shell"],
  },
  skills: {
    id: "skills",
    description: "按名称读取 SKILL.md 技能说明",
    tools: ["skill_load"],
  },
};

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}

export function capabilityLoadText(id: CapabilityId): string {
  const spec = CAPABILITIES[id];
  return `已加载能力 ${spec.id}：${spec.description}。可用工具：${spec.tools.join("、")}。`;
}
