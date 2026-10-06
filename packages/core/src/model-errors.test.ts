import { describe, expect, it } from 'vitest'
import { classifyModelError, formatModelErrorText } from './model-errors'

const deepseek = { provider: 'deepseek', modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' }
const kimi = { provider: 'kimi', modelId: 'kimi-k2.6', baseUrl: 'https://api.moonshot.cn/v1' }
const tongyi = { provider: 'tongyi', modelId: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }

describe('classifyModelError', () => {
  it('classifies invalid keys per provider with Chinese guidance', () => {
    const error = classifyModelError(new Error('401 Authentication Fails, Your api key: ****abcd is invalid'), [], deepseek)
    expect(error).toMatchObject({ code: 'MODEL_AUTH_FAILED', retryable: false, message: 'DeepSeek拒绝了 API Key（认证失败）。', details: { status: 401 } })
    expect(error.suggestedAction).toContain('platform.deepseek.com')

    const kimiError = classifyModelError('401: {"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}', [], kimi)
    expect(kimiError.code).toBe('MODEL_AUTH_FAILED')
    expect(kimiError.suggestedAction).toContain('api.moonshot.ai')

    const qwen = classifyModelError('401 Incorrect API key provided. code: invalid_api_key', [], tongyi)
    expect(qwen.code).toBe('MODEL_AUTH_FAILED')
    expect(qwen.suggestedAction).toContain('dashscope-intl')
  })

  it('redacts secrets from the stored raw detail', () => {
    const error = classifyModelError(new Error('401 bad key sk-abcdefghijklmnop'), ['sk-abcdefghijklmnop'], deepseek)
    expect(JSON.stringify(error)).not.toContain('sk-abcdefghijklmnop')
    expect((error.details as Record<string, unknown>).raw).toContain('[REDACTED]')
  })

  it('distinguishes a wrong baseUrl (404 / HTML) from an unknown model', () => {
    expect(classifyModelError('404 status code (no body)', [], deepseek)).toMatchObject({ code: 'MODEL_ENDPOINT_NOT_FOUND', retryable: false })
    const html = classifyModelError('404 <!DOCTYPE html><html><body>Not Found</body></html>', [], tongyi)
    expect(html.code).toBe('MODEL_ENDPOINT_NOT_FOUND')
    expect(html.suggestedAction).toContain('/compatible-mode/v1')
    expect(classifyModelError('Unexpected token < in JSON at position 0', [], { provider: 'custom' }).code).toBe('MODEL_RESPONSE_INVALID')

    expect(classifyModelError('400 Model Not Exist', [], deepseek)).toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false })
    expect(classifyModelError('404: {"error":{"message":"Not found the model kimi-k9 or Permission denied","type":"resource_not_found_error"}}', [], kimi).code).toBe('MODEL_NOT_FOUND')
    expect(classifyModelError('404 The model `qwen-nope` does not exist or you do not have access to it. code: model_not_found', [], tongyi).code).toBe('MODEL_NOT_FOUND')
  })

  it('points retired Kimi models at current ones', () => {
    const error = classifyModelError('404 Not found the model moonshot-v1-auto or Permission denied', [], { ...kimi, modelId: 'moonshot-v1-auto' })
    expect(error.code).toBe('MODEL_NOT_FOUND')
    expect(error.suggestedAction).toContain('已被 Moonshot 下线')
  })

  it('separates quota, rate limits and overload', () => {
    expect(classifyModelError('402 Insufficient Balance', [], deepseek)).toMatchObject({ code: 'MODEL_QUOTA_EXHAUSTED', retryable: false })
    expect(classifyModelError('429 Your account is suspended, exceeded_current_quota_error', [], kimi).code).toBe('MODEL_QUOTA_EXHAUSTED')
    expect(classifyModelError('400 Access denied, please make sure your account is in good standing. code: Arrearage', [], tongyi).code).toBe('MODEL_QUOTA_EXHAUSTED')
    expect(classifyModelError('429 Rate limit reached for requests', [], kimi)).toMatchObject({ code: 'MODEL_RATE_LIMITED', retryable: true })
    expect(classifyModelError('Provider finish_reason: insufficient_system_resource', [], deepseek)).toMatchObject({ code: 'MODEL_OVERLOADED', retryable: true })
    expect(classifyModelError('503 Server overloaded', [], deepseek)).toMatchObject({ code: 'MODEL_OVERLOADED', retryable: true })
    expect(classifyModelError('500 Internal Server Error', [], deepseek)).toMatchObject({ code: 'MODEL_SERVER_ERROR', retryable: true })
  })

  it('classifies network failures and timeouts', () => {
    expect(classifyModelError(new Error('Connection error.'), [], kimi)).toMatchObject({ code: 'MODEL_NETWORK_UNREACHABLE', retryable: true, message: '无法连接到Kimi。' })
    expect(classifyModelError('connect ECONNREFUSED 127.0.0.1:9', [], { provider: 'custom' }).code).toBe('MODEL_NETWORK_UNREACHABLE')
    expect(classifyModelError('getaddrinfo ENOTFOUND api.deepseek.cm', [], deepseek).message).toBe('无法解析服务地址的域名。')
    expect(classifyModelError('Request timed out.', [], tongyi)).toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true })
    expect(classifyModelError('连接测试超时', [], tongyi).code).toBe('MODEL_TIMEOUT')
    expect(classifyModelError('unable to verify the first certificate', [], { provider: 'custom' })).toMatchObject({ code: 'MODEL_NETWORK_UNREACHABLE', retryable: false })
  })

  it('covers context length, content filters, interruptions and invalid params', () => {
    expect(classifyModelError("400 This model's maximum context length is 131072 tokens", [], deepseek).code).toBe('MODEL_CONTEXT_TOO_LONG')
    expect(classifyModelError('400 Input data may contain inappropriate content. code: data_inspection_failed', [], tongyi).code).toBe('MODEL_CONTENT_FILTERED')
    expect(classifyModelError('Provider finish_reason: content_filter', [], kimi).code).toBe('MODEL_CONTENT_FILTERED')
    expect(classifyModelError('Provider finish_reason: eos', [], { provider: 'custom' })).toMatchObject({ code: 'MODEL_OUTPUT_INTERRUPTED', retryable: true })
    expect(classifyModelError('400 invalid temperature: only 1 is allowed for this model', [], kimi)).toMatchObject({ code: 'MODEL_REQUEST_INVALID', retryable: false })
    expect(classifyModelError('403 Forbidden', [], tongyi).code).toBe('MODEL_PERMISSION_DENIED')
    expect(classifyModelError('Request was aborted', [], tongyi).code).toBe('MODEL_REQUEST_ABORTED')
  })

  it('reads status from SDK error objects and formats one-line text', () => {
    const error = Object.assign(new Error('Something odd'), { status: 401 })
    const classified = classifyModelError(error, [], { provider: 'custom' })
    expect(classified.code).toBe('MODEL_AUTH_FAILED')
    expect(formatModelErrorText(classified)).toBe(`${classified.message}${classified.suggestedAction}`)
    expect(classifyModelError('weird', [], {}).code).toBe('MODEL_CONNECTION_FAILED')
  })
})
