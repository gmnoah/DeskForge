export type PresetId = "deepseek" | "kimi" | "tongyi" | "custom";

export interface ModelPreset {
  id: PresetId;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

export interface ModelProfile {
  preset: PresetId;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

/**
 * Every preset speaks the OpenAI-compatible Chat Completions protocol.
 * `custom` has no default host; callers must supply baseUrl and model.
 */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-auto",
    apiKeyEnv: "MOONSHOT_API_KEY",
  },
  {
    id: "tongyi",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    model: "",
    apiKeyEnv: "DESKFORGE_API_KEY",
  },
];

export function presetById(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

export class ModelProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProfileError";
  }
}

export function resolveModelProfile(input: {
  preset: PresetId;
  baseUrl?: string | undefined;
  model?: string | undefined;
}): ModelProfile {
  const preset = presetById(input.preset);
  if (!preset) throw new ModelProfileError("未知的模型预设");
  const baseUrl = (input.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, "");
  const model = (input.model ?? preset.model).trim();
  if (!baseUrl) throw new ModelProfileError("需要填写 OpenAI 兼容 baseUrl");
  if (!model) throw new ModelProfileError("需要填写模型名称");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelProfileError("baseUrl 必须是绝对 URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !local) {
    throw new ModelProfileError("非本机 baseUrl 必须使用 https");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelProfileError("baseUrl 只支持 http 或 https");
  }
  return {
    preset: preset.id,
    label: preset.label,
    baseUrl,
    model,
    apiKeyEnv: preset.apiKeyEnv,
  };
}

/** Memory override wins, then the preset variable, then DESKFORGE_API_KEY. */
export function resolveApiKey(
  profile: ModelProfile,
  env: NodeJS.ProcessEnv,
  memoryKey?: string,
): string | undefined {
  const memory = memoryKey?.trim();
  if (memory) return memory;
  const presetKey = env[profile.apiKeyEnv]?.trim();
  if (presetKey) return presetKey;
  const shared = env.DESKFORGE_API_KEY?.trim();
  return shared || undefined;
}
