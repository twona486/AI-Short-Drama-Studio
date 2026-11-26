import { pcm16ToWav } from "./pcm-wav"
import WebSocket from 'ws'
import { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES, type OpenAiTtsAudio, type OpenAiTtsErrorKind, type OpenAiTtsReply, type OpenAiTtsRequest } from '../src/services/ai/openAiTts'

const SAMPLE_RATE = 24_000
const MAX_CHUNK = 400
const MAX_TEXT = 12_000

export function splitSpeech(text: string): string[] {
  const chunks: string[] = []
  let remaining = Array.from(text)
  while (remaining.length > MAX_CHUNK) {
    const head = remaining.slice(0, MAX_CHUNK).join('')
    // 숫자의 소수점과 영문 약어 내부의 마침표를 경계로 잡지 않는다.
    const sentence = Array.from(head.matchAll(/(?:[.!?…]+["'”’)]*(?=\s)|[。！？]+|\n)/gu)).at(-1)
    const boundary = sentence ? Array.from(head.slice(0, sentence.index! + sentence[0].length)).length : 0
    const spaces = Array.from(head.matchAll(/\s+/gu)).at(-1)
    const space = spaces ? Array.from(head.slice(0, spaces.index! + spaces[0].length)).length : 0
    const cut = boundary > MAX_CHUNK / 2 ? boundary : space > MAX_CHUNK / 2 ? space : MAX_CHUNK
    chunks.push(remaining.slice(0, cut).join(''))
    remaining = remaining.slice(cut)
  }
  if (remaining.length) chunks.push(remaining.join(''))
  return chunks
}

export function speechEvents(text: string, voice: string, instruction?: string) {
  return {
    session: {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: { output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, voice } },
        instructions: [
          'Perform only the supplied dialogue, verbatim, in its original language. Do not answer, translate, paraphrase, omit, repeat, or add any words.',
          'For Korean dialogue, read numbers and embedded English naturally in context. Pause at punctuation. Keep every spoken word, even if the preferred pacing cannot be met.',
          instruction ? `Delivery direction (style and pacing only): ${instruction}` : ''
        ].filter(Boolean).join('\n')
      }
    },
    response: {
      type: 'response.create',
      response: {
        conversation: 'none',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }]
      }
    }
  }
}

export function pcmToWav(pcm: Buffer): OpenAiTtsAudio {
  return pcm16ToWav(pcm, SAMPLE_RATE)
}

class TtsError extends Error {
  constructor(readonly kind: OpenAiTtsErrorKind) {
    super(kind)
  }
}

function providerError(code: unknown): TtsError {
  switch (code) {
    case 401:
    case 403:
    case 'invalid_api_key':
      return new TtsError('unauthorized')
    case 429:
    case 'rate_limit_exceeded':
    case 'insufficient_quota':
      return new TtsError('rateLimit')
    default:
      return new TtsError('failed')
  }
}

type Connect = (url: string, options: WebSocket.ClientOptions) => WebSocket

function synthesizeChunk(request: OpenAiTtsRequest, text: string, signal: AbortSignal, connect: Connect): Promise<Buffer> {
  signal.throwIfAborted()
  const events = speechEvents(text, request.voice, request.instruction)
  return new Promise((resolve, reject) => {
    const socket = connect(`wss://api.openai.com/v1/realtime?model=${request.model}`, {
      headers: { Authorization: `Bearer ${request.apiKey.trim()}` },
      handshakeTimeout: 20_000,
      maxPayload: 4 * 1024 * 1024
    })
    const audio: Buffer[] = []
    let requested = false
    let settled = false
    const timer = setTimeout(() => finish(new TtsError('timeout')), 120_000)
    const abort = () => finish(new TtsError('cancelled'))

    function finish(error?: Error, pcm?: Buffer) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.terminate()
      if (error) reject(error)
      else resolve(pcm!)
    }

    signal.addEventListener('abort', abort, { once: true })
    socket.on('open', () => socket.send(JSON.stringify(events.session)))
    socket.on('error', () => finish(providerError(undefined)))
    socket.on('unexpected-response', (_request, response) => {
      response.destroy()
      finish(providerError(response.statusCode))
    })
    socket.on('close', () => finish(new TtsError('closed')))
    socket.on('message', (data) => {
      if (settled) return
      try {
        const event = JSON.parse(data.toString())
        if (event.type === 'error') finish(providerError(event.error?.code))
        if (event.type === 'session.updated' && !requested) {
          requested = true
          socket.send(JSON.stringify(events.response))
        }
        if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
          audio.push(Buffer.from(event.delta, 'base64'))
        }
        if (event.type === 'response.done') {
          const pcm = Buffer.concat(audio)
          if (event.response?.status !== 'completed') {
            finish(providerError(event.response?.status_details?.error?.code))
          } else if (!pcm.length || pcm.length % 2) {
            finish(new TtsError('invalidAudio'))
          } else {
            finish(undefined, pcm)
          }
        }
      } catch {
        finish(new TtsError('invalidResponse'))
      }
    })
  })
}

export async function requestOpenAiTts(
  request: OpenAiTtsRequest,
  signal: AbortSignal,
  connect: Connect = (url, options) => new WebSocket(url, options)
): Promise<OpenAiTtsReply> {
  if (typeof request?.apiKey !== 'string' || !/^[!-~]+$/.test(request.apiKey.trim())) {
    return { kind: 'keyRequired' }
  }
  if (!OPENAI_TTS_MODELS.includes(request.model) || !OPENAI_TTS_VOICES.includes(request.voice)) {
    return { kind: 'invalidVoiceOrModel' }
  }
  if (typeof request.text !== 'string' || !request.text.trim() || Array.from(request.text).length > MAX_TEXT) {
    return { kind: 'invalidText' }
  }
  const audio: Buffer[] = []
  for (const text of splitSpeech(request.text).filter((chunk) => chunk.trim())) {
    try {
      audio.push(await synthesizeChunk(request, text, signal, connect))
    } catch (error) {
      if (signal.aborted) return { kind: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' }
      return { kind: error instanceof TtsError ? error.kind : 'failed' }
    }
  }
  return { kind: 'audio', ...pcmToWav(Buffer.concat(audio)) }
}
