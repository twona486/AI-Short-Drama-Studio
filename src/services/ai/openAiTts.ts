export const OPENAI_TTS_MODELS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1']
export const OPENAI_TTS_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
export const OPENAI_TTS_DEFAULT_VOICE = 'marin'

export function isOfficialOpenAiUrl(url: string): boolean {
  return /^https:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(url.trim())
}

export function isOpenAiTts(endpoint: { provider?: string; baseUrl: string }): boolean {
  return endpoint.provider === 'openai' || isOfficialOpenAiUrl(endpoint.baseUrl)
}

export function recommendOpenAiVoice(tag = ''): string {
  if (/\b(?:female|woman|girl)\b|여성|여자/i.test(tag)) {
    return /\b(?:bright|young|girl|cheerful)\b|밝은|소녀/i.test(tag) ? 'coral' : 'marin'
  }
  if (/\b(?:male|man|boy)\b|남성|남자/i.test(tag)) {
    return /\b(?:bright|young|boy|cheerful)\b|밝은|소년/i.test(tag) ? 'ash' : 'cedar'
  }
  return ''
}

export interface OpenAiTtsRequest {
  requestId: string
  apiKey: string
  model: string
  voice: string
  text: string
  instruction?: string
}

export interface OpenAiTtsReply {
  wav: Uint8Array
  durationMs: number
}
