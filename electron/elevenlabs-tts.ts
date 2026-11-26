import {
  ELEVENLABS_MODELS, elevenLabsTaggedText,
  type ElevenLabsError, type ElevenLabsOperation, type ElevenLabsReply
} from '../src/services/ai/elevenLabsTts'
import { pcm16ToWav } from './pcm-wav'

const ORIGIN = 'https://api.elevenlabs.io'
const SAMPLE_RATE = 24_000

interface RawVoice {
  voice_id: string
  name: string
  language?: string
  verified_languages?: { language?: string }[]
  labels?: Record<string, string>
  gender?: string
  age?: string
  descriptive?: string
}

export async function requestElevenLabs(
  apiKey: string, operation: ElevenLabsOperation, signal: AbortSignal
): Promise<ElevenLabsReply> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  class RequestError extends Error {
    constructor(readonly reply: ElevenLabsError) {
      super(reply.kind)
    }
  }

  async function request(path: string, body?: Record<string, unknown>) {
    let response: Response
    try {
      response = await fetch(ORIGIN + path, {
        redirect: 'error',
        headers: { 'xi-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        signal: requestSignal
      })
    } catch {
      if (requestSignal.aborted) throw requestSignal.reason
      throw new RequestError({ kind: 'network' })
    }
    if (response.ok) return response
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) {
      throw new RequestError({ kind: 'unauthorized' })
    }
    if (response.status === 402) throw new RequestError({ kind: 'credits' })
    throw new RequestError({ kind: 'http', status: response.status })
  }

  try {
    switch (operation?.kind) {
      case 'connection': {
        const user = await (await request('/v1/user')).json() as {
          subscription?: { character_limit?: number; character_count?: number }
        }
        const models = await (await request('/v1/models')).json() as {
          model_id: string; can_do_text_to_speech: boolean; languages?: { language_id: string }[]
        }[]
        if (!models.some((model) => model.model_id === operation.model && model.can_do_text_to_speech &&
          model.languages?.some(({ language_id }) => language_id === 'ko'))) {
          throw new RequestError({ kind: 'unsupportedLanguage' })
        }
        const { character_count, character_limit } = user.subscription ?? {}
        return {
          kind: 'connection',
          creditsRemaining: typeof character_count === 'number' && typeof character_limit === 'number'
            ? Math.max(0, character_limit - character_count) : undefined
        }
      }
      case 'voices': {
        const query = new URLSearchParams({ page_size: '30' })
        if (operation.search) query.set('search', operation.search.slice(0, 120))
        const shared = operation.source === 'library'
        if (shared) {
          query.set('language', 'ko')
          query.set('page', operation.cursor || '0')
        } else if (operation.cursor) query.set('next_page_token', operation.cursor)
        const result = await (await request(`${shared ? '/v1/shared-voices' : '/v2/voices'}?${query}`)).json() as {
          voices: RawVoice[]; has_more: boolean; next_page_token?: string
        }
        return {
          kind: 'voices',
          voices: result.voices.filter((voice) => /^[a-zA-Z0-9_-]{1,100}$/.test(voice.voice_id)).map((voice) => ({
            id: voice.voice_id,
            name: voice.name,
            korean: shared || voice.labels?.language === 'ko' ||
              voice.verified_languages?.some(({ language }) => language === 'ko'),
            traits: [voice.gender, voice.age, voice.descriptive, ...Object.values(voice.labels ?? {})].filter(Boolean).join(' ')
          })),
          next: result.has_more ? shared ? String(Number(operation.cursor || '0') + 1) : result.next_page_token : undefined
        }
      }
      case 'speech': {
        const { model, voice, text, instruction } = operation
        if (!ELEVENLABS_MODELS.includes(model)) throw new RequestError({ kind: 'invalidModel' })
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(voice)) throw new RequestError({ kind: 'invalidVoice' })
        if (typeof text !== 'string' || !text.trim()) throw new RequestError({ kind: 'emptySpeech' })
        const tagged = elevenLabsTaggedText(text, typeof instruction === 'string' ? instruction : '')
        if (tagged.length > (model === 'eleven_v3' ? 5000 : 100_000)) {
          throw new RequestError({ kind: 'textLimit' })
        }
        const response = await request(`/v1/text-to-speech/${voice}?output_format=pcm_24000`, {
          text: tagged,
          model_id: model,
          language_code: 'ko',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
        const creditHeader = response.headers.get('character-cost')
        const pcm = Buffer.from(await response.arrayBuffer())
        return { kind: 'speech', ...pcm16ToWav(pcm, SAMPLE_RATE), credits: creditHeader ? Number(creditHeader) : undefined }
      }
      default:
        throw new RequestError({ kind: 'invalidRequest' })
    }
  } catch (error) {
    if (requestSignal.aborted) return { kind: requestSignal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' }
    return error instanceof RequestError ? error.reply : { kind: 'invalidResponse' }
  }
}
