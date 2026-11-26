import { pcm16ToWav } from "./pcm-wav"
import WebSocket from 'ws'
import { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES, type OpenAiTtsReply, type OpenAiTtsRequest } from '../src/services/ai/openAiTts'

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

export function pcmToWav(pcm: Buffer): OpenAiTtsReply {
  return pcm16ToWav(pcm, SAMPLE_RATE)
}

function providerError(code: unknown): Error {
  switch (code) {
    case 401:
    case 403:
    case 'invalid_api_key':
      return new Error('OpenAI 더빙 API 키 또는 프로젝트의 모델 권한을 확인해야 합니다.')
    case 429:
    case 'rate_limit_exceeded':
    case 'insufficient_quota':
      return new Error('OpenAI 더빙 사용 한도를 초과했습니다. 결제 상태와 한도를 확인해 주세요.')
    default:
      return new Error('OpenAI 더빙 요청이 실패했습니다. 모델 접근 권한과 네트워크 연결을 확인해 주세요.')
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
    const timer = setTimeout(() => finish(new Error('OpenAI 더빙 응답 시간이 초과됐습니다.')), 120_000)
    const abort = () => finish(new Error('OpenAI 더빙이 취소됐습니다.'))

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
    socket.on('close', () => finish(new Error('오디오를 받기 전에 OpenAI 더빙 연결이 종료됐습니다.')))
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
            finish(new Error('OpenAI 더빙에서 올바른 PCM 오디오를 받지 못했습니다.'))
          } else {
            finish(undefined, pcm)
          }
        }
      } catch {
        finish(new Error('OpenAI 더빙 응답을 처리하지 못했습니다.'))
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
    throw new Error('설정에서 OpenAI 더빙 API 키를 입력해야 합니다.')
  }
  if (!OPENAI_TTS_MODELS.includes(request.model) || !OPENAI_TTS_VOICES.includes(request.voice)) {
    throw new Error('OpenAI 더빙에서 지원하는 모델과 목소리를 선택해야 합니다.')
  }
  if (typeof request.text !== 'string' || !request.text.trim() || Array.from(request.text).length > MAX_TEXT) {
    throw new Error('OpenAI 더빙 원고를 1자 이상 12,000자 이하로 입력해야 합니다.')
  }
  const audio: Buffer[] = []
  for (const text of splitSpeech(request.text).filter((chunk) => chunk.trim())) {
    try {
      audio.push(await synthesizeChunk(request, text, signal, connect))
    } catch (error) {
      if (signal.aborted) throw new Error('OpenAI 더빙이 취소됐습니다.')
      throw error
    }
  }
  return pcmToWav(Buffer.concat(audio))
}
