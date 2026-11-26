export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1'
export const ELEVENLABS_MODELS = ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3']

export function isElevenLabsTts(endpoint: { provider?: string; baseUrl: string }): boolean {
  return endpoint.provider === 'elevenlabs' ||
    /^https:\/\/api\.elevenlabs\.io(?:\/v1)?\/?$/i.test(endpoint.baseUrl.trim())
}

export interface ElevenLabsVoice {
  id: string
  name: string
  korean?: boolean
  traits?: string
}

export const ELEVENLABS_CAST: ElevenLabsVoice[] = [
  { id: 's07IwTCOrCDCaETjUVjx', name: 'Hyunbin', korean: true, traits: 'male middle_aged calm clear' },
  { id: '9XzsrrLgecsKnylK9yxi', name: 'Siyeong', korean: true, traits: 'female young nervous soft' },
  { id: 'lO4E4qxAvq4BhWUWF8Ci', name: 'JasonK', korean: true, traits: 'male middle_aged calm neutral deep' }
]
export const ELEVENLABS_DEFAULT_VOICE = ELEVENLABS_CAST[0].id

export function elevenLabsModel(model: string | undefined, fallback = ELEVENLABS_MODELS[0]) {
  return model && ELEVENLABS_MODELS.includes(model) ? model : fallback
}

const traits = [
  [/여성|여자|\bfemale\b|\bwoman\b/i, /\bfemale\b/i, 6],
  [/남성|남자|\bmale\b|\bman\b/i, /\bmale\b/i, 6],
  [/젊|청년|소녀|소년|\byoung\b/i, /\byoung\b/i, 3],
  [/중년|middle[ _-]aged/i, /middle[ _-]aged/i, 3],
  [/노년|고령|\bold\b/i, /\b(?:old|elderly)\b/i, 3],
  [/침착|차분|calm/i, /calm|soothing/i, 1],
  [/저음|낮은|deep/i, /deep|low/i, 1],
  [/소심|불안|nervous/i, /nervous|anxious/i, 1],
  [/부드|soft/i, /soft|gentle/i, 1],
  [/명료|또렷|clear/i, /clear|articulate/i, 1]
] as const

export function recommendElevenLabsVoice(
  description = '', name = '', voices: ElevenLabsVoice[] = [], fallback = ELEVENLABS_DEFAULT_VOICE
): ElevenLabsVoice {
  const castIndex = ['역무원', '지연', '승객'].indexOf(name.trim())
  if (castIndex >= 0) return ELEVENLABS_CAST[castIndex]
  const candidates = [...ELEVENLABS_CAST, ...voices.filter((voice) => voice.korean)]
  const score = (voice: ElevenLabsVoice) => traits.reduce((total, [input, label, weight]) =>
    total + (input.test(description) && label.test(voice.traits || '') ? weight : 0), 0)
  const best = candidates.reduce((best, voice) => score(voice) > score(best) ? voice : best)
  return score(best) > 0 ? best : candidates.find(({ id }) => id === fallback) ?? { id: fallback, name: fallback }
}

const deliveryTags = [
  [/속삭|whisper/i, 'whispers'],
  [/불안|초조|anxious|nervous/i, 'anxiously'],
  [/단호|firm/i, 'firmly'],
  [/침착|차분|calm/i, 'calmly'],
  [/긴박|다급|urgent/i, 'urgently'],
  [/낮은 목소리|저음|low voice/i, 'in a low voice'],
  [/천천히|slowly/i, 'slowly'],
  [/화가|분노|angry/i, 'angrily']
] as const

export function elevenLabsTaggedText(text: string, instruction = ''): string {
  const explicit = instruction.match(/\[[^\[\]\r\n]{1,80}\]/g)
  const tags = explicit ?? deliveryTags.filter(([pattern]) => pattern.test(instruction)).map(([, tag]) => `[${tag}]`)
  return tags.length ? `${tags.slice(0, 4).join(' ')} ${text}` : text
}

export type ElevenLabsOperation =
  | { kind: 'connection'; model: string }
  | { kind: 'voices'; source: 'account' | 'library'; search: string; cursor?: string }
  | { kind: 'speech'; model: string; voice: string; text: string; instruction?: string }

export interface ElevenLabsRequest {
  requestId: string
  encryptedKey: string
  operation: ElevenLabsOperation
}

export type ElevenLabsReply =
  | { kind: 'connection'; creditsRemaining?: number }
  | { kind: 'voices'; voices: ElevenLabsVoice[]; next?: string }
  | { kind: 'speech'; wav: Uint8Array; durationMs: number; credits?: number }
  | { kind: 'http'; status: number }
  | { kind: 'cancelled' | 'timeout' | 'network' | 'unauthorized' | 'credits' | 'unsupportedLanguage'
      | 'invalidModel' | 'invalidVoice' | 'emptySpeech' | 'textLimit' | 'invalidRequest' | 'invalidResponse'
      | 'missingKey' | 'storedKey' }

export type ElevenLabsError = Exclude<ElevenLabsReply, { kind: ElevenLabsOperation['kind'] }>
