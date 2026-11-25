export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const OPENAI_DEFAULT_CHAT_MODEL = 'gpt-5.4-mini'
export const OPENAI_CHAT_MODELS = [OPENAI_DEFAULT_CHAT_MODEL, 'gpt-5.4']

export function isOfficialOpenAi(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === 'https://api.openai.com'
  } catch {
    return false
  }
}

/** Apply the official API's model-specific fields without changing gateway requests. */
export function adaptOpenAiChatBody(baseUrl: string, body: Record<string, unknown>) {
  if (!isOfficialOpenAi(baseUrl)) return body
  const model = String(body.model ?? '')
  const modern = /^(gpt-[56](?:[.-]|$)|o[1-9](?:-|$))/i.test(model)
  const payload = { ...body }
  if (payload.max_tokens !== undefined) {
    payload.max_completion_tokens = payload.max_tokens
  }
  delete payload.max_tokens
  if (/^gpt-5\.(?:2(?:-|$)|4(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$)/i.test(model)) {
    payload.reasoning_effort = 'none'
  } else if (modern) {
    delete payload.temperature
  }
  return payload
}
