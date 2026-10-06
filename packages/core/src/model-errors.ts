import type { PublicError } from '@deskforge/contracts'
import { redactSecrets } from './secret-redaction'

/** Stable codes for model/provider failures. The UI keys off these, not the raw text. */
export type ModelErrorCode =
  | 'MODEL_REQUEST_ABORTED'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_PERMISSION_DENIED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_ENDPOINT_NOT_FOUND'
  | 'MODEL_QUOTA_EXHAUSTED'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_CONTEXT_TOO_LONG'
  | 'MODEL_CONTENT_FILTERED'
  | 'MODEL_OVERLOADED'
  | 'MODEL_SERVER_ERROR'
  | 'MODEL_TIMEOUT'
  | 'MODEL_NETWORK_UNREACHABLE'
  | 'MODEL_OUTPUT_INTERRUPTED'
  | 'MODEL_RESPONSE_INVALID'
  | 'MODEL_REQUEST_INVALID'
  | 'MODEL_CONNECTION_FAILED'

export interface ModelErrorContext {
  provider?: string
  modelId?: string
  baseUrl?: string
}

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  tongyi: '通义千问',
  custom: '模型服务',
}

const EXPECTED_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.cn/v1（国际站 https://api.moonshot.ai/v1）',
  tongyi: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
}

const RAW_DETAIL_LIMIT = 800

function rawText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>).message : undefined
    if (typeof nested === 'string') return nested
    if (typeof record.message === 'string') return record.message
  }
  return ''
}

function errorStatus(error: unknown, text: string): number | undefined {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const value of [record.status, record.statusCode]) if (typeof value === 'number') return value
  }
  // pi-ai / openai SDK messages start with the status: "401 Incorrect API key", "404: {...}".
  const leading = /^\s*(?:[A-Za-z][\w .-]{0,40}\s)?\(?([1-5]\d\d)\)?(?::|\s|$)/.exec(text)
  if (leading) return Number(leading[1])
  const labelled = /\b(?:status(?: code)?|http(?: status)?)\s*[:=]?\s*([1-5]\d\d)\b/i.exec(text)
  return labelled ? Number(labelled[1]) : undefined
}

function label(context: ModelErrorContext): string {
  return PROVIDER_LABELS[context.provider ?? ''] ?? '模型服务'
}

function authAdvice(context: ModelErrorContext): string {
  switch (context.provider) {
    case 'deepseek':
      return '在 platform.deepseek.com 的 API Keys 页面确认或重新生成 Key，然后在「设置 → 模型」更新。'
    case 'kimi':
      return 'Key 与服务地址必须同属一个平台：platform.moonshot.cn 的 Key 配 https://api.moonshot.cn/v1，platform.moonshot.ai 的 Key 配 https://api.moonshot.ai/v1。'
    case 'tongyi':
      return '请使用阿里云百炼控制台创建的 API Key，并确认 Key 所属地域与服务地址一致（北京 dashscope.aliyuncs.com，新加坡 dashscope-intl.aliyuncs.com）。'
    default:
      return '检查 API Key 是否填写完整、未过期，并与该服务地址匹配。'
  }
}

function modelAdvice(context: ModelErrorContext): string {
  const modelId = context.modelId?.trim()
  switch (context.provider) {
    case 'deepseek':
      return '可用模型示例：deepseek-flash、deepseek-v4-pro。旧的 deepseek-chat / deepseek-reasoner 已停用。'
    case 'kimi':
      return modelId && /^moonshot-v1|^kimi-(?:latest|thinking-preview)|^kimi-k2-(?:0711|0905|turbo)/.test(modelId)
        ? `${modelId} 已被 Moonshot 下线，请改用 kimi-k2.6、kimi-k3 或 kimi-k2.7-code。`
        : '确认模型 ID 拼写正确，例如 kimi-k2.6、kimi-k3、kimi-k2.7-code。'
    case 'tongyi':
      return '确认模型 ID 正确且已在百炼控制台开通，例如 qwen-plus、qwen3.8-flash。'
    default:
      return '确认模型 ID 与服务商文档一致，并且该账号有权限使用。'
  }
}

function endpointAdvice(context: ModelErrorContext): string {
  const expected = EXPECTED_BASE_URLS[context.provider ?? '']
  return expected
    ? `服务地址应为 ${expected}，不要包含 /chat/completions。`
    : '服务地址应是 OpenAI 兼容接口的根地址（通常以 /v1 结尾），不要包含 /chat/completions。'
}

function build(
  code: ModelErrorCode,
  message: string,
  retryable: boolean,
  suggestedAction: string | undefined,
  raw: string,
  status: number | undefined,
): PublicError {
  const details: Record<string, string | number> = {}
  if (raw) details.raw = raw.length > RAW_DETAIL_LIMIT ? `${raw.slice(0, RAW_DETAIL_LIMIT)}…` : raw
  if (status !== undefined) details.status = status
  return {
    code,
    message,
    retryable,
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  }
}

/**
 * Map provider/network failures to a stable code and a friendly Chinese message.
 * The redacted original text stays in details.raw for troubleshooting.
 */
export function classifyModelError(error: unknown, secrets: readonly string[] = [], context: ModelErrorContext = {}): PublicError {
  const original = rawText(error)
  const raw = original ? redactSecrets(original, secrets) : ''
  const text = raw.toLowerCase()
  const status = errorStatus(error, raw)
  const name = label(context)
  const out = (code: ModelErrorCode, message: string, retryable: boolean, suggestedAction?: string): PublicError =>
    build(code, message, retryable, suggestedAction, raw, status)

  if (/request was aborted|\baborted\b|cancel(?:l)?ed by user|用户已取消/.test(text) && status === undefined) {
    return out('MODEL_REQUEST_ABORTED', '请求已取消。', false)
  }
  if (/model[_ ]not[_ ]found|model not exist|unknown model|no such model|模型不存在|not found the model|model\b[^\n]{0,80}\b(?:does not exist|not found|is not supported|not available|has been (?:deprecated|retired|discontinued))/.test(text)) {
    return out('MODEL_NOT_FOUND', `${name}找不到这个模型${context.modelId ? `：${context.modelId}` : ''}。`, false, modelAdvice(context))
  }
  if (status === 402 || /insufficient[_ ](?:balance|quota|account)|exceeded_current_quota|exceeded your current quota|arrearage|overdue|余额不足|欠费|billing|quota (?:exceeded|exhausted)/.test(text)) {
    return out('MODEL_QUOTA_EXHAUSTED', `${name}账户余额或额度不足。`, false, '前往服务商控制台充值或检查套餐额度后再试。')
  }
  if (status === 401 || /unauthori[sz]ed|invalid[_ ]api[_ ]?key|incorrect api key|invalid_authentication|authentication (?:failed|error)|invalidapikey|api key (?:is )?(?:invalid|not valid|missing)|no api key/.test(text)) {
    return out('MODEL_AUTH_FAILED', `${name}拒绝了 API Key（认证失败）。`, false, authAdvice(context))
  }
  if (status === 403 || /permission denied|access denied|forbidden|not have access|accessdenied|没有权限/.test(text)) {
    return out('MODEL_PERMISSION_DENIED', `当前 API Key 没有权限访问${context.modelId ? `模型 ${context.modelId}` : '这个模型'}。`, false, '在服务商控制台确认已开通该模型，或检查 Key 所属的项目/工作空间。')
  }
  if (status === 413 || /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|input (?:is )?too long|range of input length|exceeds? the model'?s? max|max_tokens.*exceed|上下文.*(?:过长|超出)/.test(text)) {
    return out('MODEL_CONTEXT_TOO_LONG', '对话内容超出了模型的上下文长度。', false, '新建一个工作继续，或减少附带的文件与历史内容。')
  }
  if (/content_filter|data_inspection_failed|inappropriate[ -]content|high risk|content (?:security|moderation)|sensitive content|敏感/.test(text)) {
    return out('MODEL_CONTENT_FILTERED', `${name}的内容安全策略拦截了本次请求或回复。`, false, '调整提问措辞或附带的文件内容后再试。')
  }
  if (status === 529 || /insufficient_system_resource|overloaded|server is busy|服务繁忙|engine_overloaded|capacity/.test(text)) {
    return out('MODEL_OVERLOADED', `${name}当前繁忙，暂时无法处理请求。`, true, '稍等片刻后重试，或在设置中切换到其他模型。')
  }
  if (status === 429 || /rate.?limit|too many requests|requests? per minute|\btpm\b|\brpm\b|请求过于频繁/.test(text)) {
    return out('MODEL_RATE_LIMITED', `请求过于频繁，${name}触发了限速。`, true, '稍后重试；若持续出现，请检查账户的并发与限速档位。')
  }
  if (status === 404 || status === 405 || /<!doctype html|<html|cannot (?:post|get) \//.test(text)) {
    return out('MODEL_ENDPOINT_NOT_FOUND', '服务地址不正确，接口返回了“未找到”。', false, endpointAdvice(context))
  }
  if (/provider finish_reason|stream ended without finish_reason|network_error/.test(text)) {
    return out('MODEL_OUTPUT_INTERRUPTED', `${name}的输出意外中断。`, true, '可以直接重试；若反复出现，可缩短任务或换用其他模型。')
  }
  if (status === 408 || status === 504 || /timed? ?out|timeout|etimedout|und_err_(?:connect_|headers_|body_)?timeout|连接.*超时|请求超时/.test(text)) {
    return out('MODEL_TIMEOUT', `连接${name}超时。`, true, '检查网络或代理设置后重试；如在海外网络，确认服务地址可访问。')
  }
  if (/enotfound|eai_again|getaddrinfo/.test(text)) {
    return out('MODEL_NETWORK_UNREACHABLE', '无法解析服务地址的域名。', true, '检查服务地址拼写，以及网络/DNS/代理设置。')
  }
  if (/certificate|self[- ]signed|\b(?:ssl|tls)\b|unable to verify/.test(text)) {
    return out('MODEL_NETWORK_UNREACHABLE', '与服务地址建立安全连接失败（证书校验未通过）。', false, '确认服务地址使用有效的 HTTPS 证书，或检查公司代理设置。')
  }
  if (/econnrefused|econnreset|enetunreach|ehostunreach|connection (?:error|refused|reset)|fetch failed|network|socket hang up|other side closed/.test(text)) {
    return out('MODEL_NETWORK_UNREACHABLE', `无法连接到${name}。`, true, '检查网络连接、代理设置以及服务地址是否可访问。')
  }
  if (status !== undefined && status >= 500) {
    return out('MODEL_SERVER_ERROR', `${name}服务端出错（HTTP ${status}）。`, true, '通常是服务商临时故障，稍后重试即可。')
  }
  if (status === 400 || status === 422 || /invalid_request|invalid request|bad request|invalid parameter|unsupported/.test(text)) {
    return out('MODEL_REQUEST_INVALID', `${name}拒绝了请求参数。`, false, '检查模型 ID 与该模型支持的能力（如思考模式、工具调用）；详细原因见技术信息。')
  }
  if (/unexpected token|invalid json|json.parse|is not valid json|unexpected end of json/.test(text)) {
    return out('MODEL_RESPONSE_INVALID', '服务返回的内容不是有效的 OpenAI 兼容格式。', false, endpointAdvice(context))
  }
  return out('MODEL_CONNECTION_FAILED', `${name}请求失败。`, false, '查看技术信息了解原因，或稍后重试。')
}

/** One-line Chinese text for places that only show a string (chat timeline, notifications). */
export function formatModelErrorText(error: PublicError): string {
  return error.suggestedAction ? `${error.message}${error.suggestedAction}` : error.message
}
