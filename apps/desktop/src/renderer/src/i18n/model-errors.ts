import { getLocale } from './index'

/** Translate stable model error codes at presentation time; keep raw diagnostics intact. */
const messages: Record<string, readonly [string, string]> = {
  MODEL_REQUEST_ABORTED: ['Request cancelled.', 'Start a new request when ready.'],
  MODEL_AUTH_FAILED: ['The model provider rejected the API key.', 'Check your API key and make sure its platform and region match the endpoint.'],
  MODEL_PERMISSION_DENIED: ['This API key cannot access the model.', 'Check model access and the key project or workspace in the provider console.'],
  MODEL_NOT_FOUND: ['The requested model is unavailable.', 'Check the model ID and whether it is supported by your provider.'],
  MODEL_ENDPOINT_NOT_FOUND: ['The API endpoint is incorrect.', 'Check the OpenAI-compatible base URL in Settings → Models.'],
  MODEL_QUOTA_EXHAUSTED: ['The account has insufficient balance or quota.', 'Check your balance and plan in the provider console.'],
  MODEL_RATE_LIMITED: ['The provider rate limit was reached.', 'Wait and retry, or review your concurrency and rate limits.'],
  MODEL_CONTEXT_TOO_LONG: ['The conversation exceeds the model context limit.', 'Start a new task or reduce attached files and conversation history.'],
  MODEL_CONTENT_FILTERED: ['The provider blocked this request or response.', 'Revise your request or attached content and try again.'],
  MODEL_OVERLOADED: ['The provider is currently busy.', 'Wait and retry, or select another model in Settings.'],
  MODEL_SERVER_ERROR: ['The model provider returned a server error.', 'Wait and retry. Check the provider service status if the issue persists.'],
  MODEL_TIMEOUT: ['The model connection timed out.', 'Check your network, proxy and endpoint, then retry.'],
  MODEL_NETWORK_UNREACHABLE: ['Could not connect securely to the model provider.', 'Check the endpoint, network, DNS, proxy and HTTPS certificate.'],
  MODEL_OUTPUT_INTERRUPTED: ['The model response was interrupted.', 'Retry, shorten the task or use another model.'],
  MODEL_RESPONSE_INVALID: ['The model provider returned an invalid response.', 'Check API compatibility and the model configuration.'],
  MODEL_REQUEST_INVALID: ['The model provider rejected the request format.', 'Check model capabilities and API compatibility.'],
  MODEL_CONNECTION_FAILED: ['Could not connect to the model.', 'Check the API key, model ID, endpoint and network.'],
}

export function localizeModelError(error: { code?: unknown; message?: unknown; suggestedAction?: unknown }): { message?: string; suggestion?: string } {
  const original = {
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
    ...(typeof error.suggestedAction === 'string' ? { suggestion: error.suggestedAction } : {}),
  }
  const translated = typeof error.code === 'string' ? messages[error.code] : undefined
  return getLocale() === 'en-US' && translated
    ? { message: translated[0], suggestion: translated[1] }
    : original
}
