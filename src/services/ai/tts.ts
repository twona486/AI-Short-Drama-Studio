import { directElevenLabsDelivery, loadKoreanElevenLabsVoices, recommendProjectElevenLabsVoice, type ElevenLabsDeliveryContext } from './elevenLabsDelivery'
import type { ElevenLabsSpeechRequest } from './elevenLabsTts'
import type { Subject } from '@/types'
import { elevenLabsRequest } from './elevenLabsDesktop'
import { t } from '@/i18n'
import { desktop, isDesktop } from '@/services/desktop'
import { isOfficialOpenAiUrl, OPENAI_TTS_DEFAULT_VOICE, OPENAI_TTS_VOICES } from './openAiTts'
import { spokenTextOnly } from './dialogue'
import { getTtsConfig } from './runtime'

export interface TTSInput {
  text: string
  voice?: string
  language?: 'Chinese' | 'English' | 'Auto'
  /** 읽을 본문과 별도로 자연어로 말투를 지정한다. */
  instruction?: string
  /** 노드에서 모델을 따로 선택할 수 있다. 선택하지 않으면 현재 더빙 설정을 사용한다. */
  model?: string
  signal?: AbortSignal
  delivery?: ElevenLabsDeliveryContext
  speakerId?: string
  subjects?: Subject[]
}

export interface TTSOutput {
  blob: Blob
  mimeType: string
  durationMs?: number
  elevenLabsRequest?: ElevenLabsSpeechRequest
  model: string
}

const MAX_CHARS = 580

const log = (msg: string) =>
  console.log('%c[tts]', 'color:#06b6d4;font-weight:600', msg)

/** Bailian의 qwen-audio-3.0-tts-flash 기본 음색 */
export const TTS_VOICES: { id: string; label: string }[] = [
  { id: 'longanhuan_v3.6', get label() { return t('voice.longanhuan') } },
  { id: 'longjielidou_v3.6', get label() { return t('voice.longjielidou') } },
  { id: 'longpaopao_v3.6', get label() { return t('voice.longpaopao') } },
  { id: 'longhuohuo_v3.6', get label() { return t('voice.longhuohuo') } },
  { id: 'longchuanshu_v3.6', get label() { return t('voice.longchuanshu') } },
  { id: 'loongeva_v3.6', get label() { return t('voice.loongeva') } }
]

/** 이 항목은 이니셜이나 관용적인 발음으로 읽는 약어로 처리한다. */
const SPELL_ACRONYMS = new Set([
  'VIP',
  'SKU',
  'UV',
  'UVA',
  'UVB',
  'LED',
  'USB',
  'CPU',
  'GPU',
  'PDF',
  'QR',
  'ID',
  'TV',
  'AI',
  'SPF',
  '3C',
  'OK'
])

const DIGIT_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const DIGIT_YAO = ['零', '幺', '二', '三', '四', '五', '六', '七', '八', '九']

function spellDigits(digits: string, yao = false): string {
  const table = yao ? DIGIT_YAO : DIGIT_CN
  return [...digits].map((ch) => (/[0-9]/.test(ch) ? table[Number(ch)] : '')).join('')
}

/**
 * 플랫폼 번호, 연락처, 행사 날짜는 자릿수별 발음을 적용한다.
 * 1688 같은 수가 한 덩어리 숫자로 읽히는 일을 방지한다.
 */
const SPELLED_NUMBER_CODES: Array<{ pattern: RegExp; spoken?: string; yao?: boolean }> = [
  { pattern: /1688/g, spoken: '一六八八' },
  { pattern: /12306/g, yao: true },
  { pattern: /10086/g, yao: true },
  { pattern: /10010/g, yao: true },
  { pattern: /10000(?![元万亿])/g, yao: true },
  { pattern: /95588/g, yao: true },
  { pattern: /95533/g, yao: true },
  { pattern: /95566/g, yao: true },
  { pattern: /(?<!\d)618(?!\d)/g, spoken: '六一八' },
  { pattern: /(?<!\d)1111(?!\d)/g, spoken: '双十一' },
  { pattern: /(?<!\d)1212(?!\d)/g, spoken: '双十二' },
  { pattern: /58(?=同城)/g, spoken: '五八' },
  { pattern: /(?<!\d)(?:110|119|120|122|114)(?!\d)/g, yao: true }
]

function normalizeSpokenNumbers(text: string): string {
  let next = text
  for (const item of SPELLED_NUMBER_CODES) {
    next = next.replace(item.pattern, (match) => item.spoken || spellDigits(match.replace(/\D/g, ''), item.yao))
  }
  next = next.replace(/(?<!\d)([48]00)[- ]?(\d{3,4})[- ]?(\d{3,4})(?!\d)/g, (_all, a, b, c) =>
    `${spellDigits(a, true)}，${spellDigits(b, true)}，${spellDigits(c, true)}`
  )
  return next
}

/**
 * 음성 합성에 보낼 텍스트만 전처리하고 자막 원문을 유지한다.
 * 중국어 모델은 모두 대문자인 브랜드 이름을 글자별로 읽을 수 있다.
 * 모음이 있고 세 글자 이상인 대문자 단어는 첫 글자만 대문자로 바꾼다.
 * 1688이나 12306 같은 플랫폼 번호는 한 자리씩 읽는다.
 */
export function normalizeForSpeech(text: string): string {
  const branded = /\p{Script=Han}/u.test(text) && !/[가-힣]/.test(text) ? normalizeSpokenNumbers(text) : text
  return branded.replace(/[A-Za-z][A-Za-z0-9]*/g, (word) => {
    if (!/^[A-Z0-9]+$/.test(word)) return word
    if (SPELL_ACRONYMS.has(word)) return word
    if (word.length <= 2) return word
    if (/[AEIOUY]/.test(word)) {
      return word.charAt(0) + word.slice(1).toLowerCase()
    }
    return word
  })
}

export function detectSpeechLanguage(text: string): 'Chinese' | 'English' | 'Auto' {
  if (/[가-힣]/.test(text)) return 'Auto'
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  if (cjk > 0 && latin > 0) return 'Auto'
  if (cjk >= latin && cjk > 0) return 'Chinese'
  if (latin > 0 && cjk === 0) return 'English'
  return 'Auto'
}

/** SpeechSynthesizer 요청에 쓸 /api/v1 포함 주소를 구한다. */
function speechApiRoot(baseUrl: string): string {
  let u = baseUrl.replace(/\/+$/, '')
  // 호환 채팅 주소를 기본 /api/v1 경로로 바꾼다.
  u = u.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(u)) return u
  // 도메인만 주어지면 /api/v1을 추가한다.
  if (/^https?:\/\//i.test(u) && !/\/api\//i.test(u)) {
    return `${u}/api/v1`
  }
  return u
}

function clipText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= MAX_CHARS) return t
  const slice = t.slice(0, MAX_CHARS)
  const cut = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('.')
  )
  return (cut > 40 ? slice.slice(0, cut + 1) : slice).trim()
}

function languageHint(language: string): string | undefined {
  if (language === 'Chinese') return 'zh'
  if (language === 'English') return 'en'
  return undefined
}

async function downloadAudioUrl(audioUrl: string, signal?: AbortSignal): Promise<Blob> {
  const aResp = await fetch(audioUrl, { signal })
  if (!aResp.ok) throw new Error(`[TTS] 오디오 다운로드에 실패했습니다. ${aResp.status}`)
  const buf = await aResp.arrayBuffer()
  const ct = (aResp.headers.get('content-type') || '').toLowerCase()
  const mime =
    ct.includes('mpeg') || ct.includes('mp3')
      ? 'audio/mpeg'
      : ct.includes('wav')
        ? 'audio/wav'
        : 'audio/mpeg'
  return new Blob([buf], { type: mime })
}

function blobFromBase64(data: string, mime = 'audio/wav'): Blob {
  const bin = atob(String(data).replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * Bailian SpeechSynthesizer 비실시간 HTTP
 * 문서 https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
 * 콘솔 문서 2938790의 모델 제품군
 */
async function speechSynthesizer(
  apiRoot: string,
  apiKey: string,
  model: string,
  text: string,
  voice: string,
  language: string,
  instruction?: string,
  signal?: AbortSignal
): Promise<Blob> {
  const hint = languageHint(language)
  const input: Record<string, unknown> = {
    text,
    voice,
    format: 'wav',
    sample_rate: 24000
  }
  if (hint) input.language_hints = [hint]
  if (instruction) input.instruction = instruction

  const resp = await fetch(`${apiRoot}/services/audio/tts/SpeechSynthesizer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input }),
    signal
  })
  const raw = await resp.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`[TTS] SpeechSynthesizer ${resp.status} ${raw.slice(0, 200)}`)
  }
  if (!resp.ok || data.code) {
    throw new Error(
      `[TTS] SpeechSynthesizer ${data.code || resp.status} ${data.message || raw.slice(0, 200)}`
    )
  }

  const audio = data.output?.audio ?? data.audio
  if (audio?.data) {
    return blobFromBase64(String(audio.data), 'audio/wav')
  }
  const audioUrl = audio?.url
  if (!audioUrl) {
    throw new Error(`[TTS] SpeechSynthesizer 응답에 오디오가 없습니다. ${JSON.stringify(data).slice(0, 240)}`)
  }
  return downloadAudioUrl(audioUrl, signal)
}

/** 이전 Qwen3-TTS multimodal-generation 대체 경로 */
async function nativeQwen3Speech(
  origin: string,
  apiKey: string,
  model: string,
  text: string,
  voice: string,
  language: string,
  signal?: AbortSignal
): Promise<Blob> {
  const apiRoot = origin.replace(/\/api\/v1$/i, '') + '/api/v1'
  const resp = await fetch(`${apiRoot}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: {
        text,
        voice,
        language_type: language
      }
    }),
    signal
  })
  const raw = await resp.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`[TTS] native ${resp.status} ${raw.slice(0, 200)}`)
  }
  if (!resp.ok || data.code) {
    throw new Error(`[TTS] native ${data.code || resp.status} ${data.message || raw.slice(0, 200)}`)
  }
  const audio = data.output?.audio ?? data.audio
  if (audio?.data) return blobFromBase64(String(audio.data), 'audio/wav')
  const audioUrl = audio?.url
  if (!audioUrl) {
    throw new Error(`[TTS] 네이티브 TTS 응답에 오디오가 없습니다. ${JSON.stringify(data).slice(0, 240)}`)
  }
  return downloadAudioUrl(audioUrl, signal)
}

/** 모델과 음색 버전이 맞지 않아 발음이 어색해질 수 있어 호환 음색으로 전환한다. */
export function compatibleVoice(model: string, requested?: string): string {
  const voice = (requested || '').trim()
  if (/^qwen-audio-3\.0-tts-flash/i.test(model)) {
    const safe = new Set([
      'longanhuan_v3.6',
      'longjielidou_v3.6',
      'longpaopao_v3.6',
      'longhuohuo_v3.6',
      'longchuanshu_v3.6',
      'loongeva_v3.6'
    ])
    return safe.has(voice) ? voice : 'longanhuan_v3.6'
  }
  return voice || 'longanhuan_v3.6'
}

export async function generateSpeech(input: TTSInput): Promise<TTSOutput> {
  const cfg = getTtsConfig()
  const model = input.model?.trim() || cfg.model
  if (cfg.elevenLabs) {
    if (!input.text.trim()) throw new Error(t('elevenLabsErrors.emptySpeech'))
    if (!cfg.encryptedElevenLabsKey) throw new Error(t('elevenLabs.missingKey'))
    const voiceForSpeech = async () => {
      if (input.voice) return input.voice
      if (!input.speakerId && cfg.voice) return cfg.voice
      const voices = await loadKoreanElevenLabsVoices(cfg.encryptedElevenLabsKey, input.signal)
      const voice = recommendProjectElevenLabsVoice(input.subjects ?? [], input.speakerId, voices,
        cfg.voice, input.delivery?.voiceDescription)
      if (!voice) throw new Error(t('elevenLabsErrors.invalidVoice'))
      return voice
    }
    const [voice, text] = await Promise.all([
      voiceForSpeech(),
      directElevenLabsDelivery(input.text, input.instruction, input.delivery, input.signal)
    ])
    const { wav, durationMs, request } = await elevenLabsRequest(cfg.encryptedElevenLabsKey, {
      kind: 'speech', model, voice, text, previousText: input.delivery?.previousText, nextText: input.delivery?.nextText
    }, input.signal)
    const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
    return { blob, mimeType: blob.type, durationMs, model, elevenLabsRequest: request }
  }
  if (cfg.openAi) {
    if (!isOfficialOpenAiUrl(cfg.baseUrl)) throw new Error(t('openAiTtsErrors.officialAddress'))
    if (!input.text.trim()) throw new Error(t('openAiTtsErrors.emptySpeech'))
    if (!cfg.apiKey.trim()) throw new Error(t('openAiTtsErrors.linkKey'))
    if (!isDesktop() || typeof desktop().openAiTts !== 'function') {
      throw new Error(t('openAiTtsErrors.desktopRequired'))
    }
    input.signal?.throwIfAborted()
    const requestId = crypto.randomUUID()
    const voice = [input.voice, cfg.voice, OPENAI_TTS_DEFAULT_VOICE]
      .find((item): item is string => Boolean(item && OPENAI_TTS_VOICES.includes(item)))!
    const cancel = () => desktop().cancelProviderFetch(requestId)
    input.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const reply = await desktop().openAiTts({
        requestId, apiKey: cfg.apiKey, model, voice, text: input.text, instruction: input.instruction
      })
      input.signal?.throwIfAborted()
      if (reply.kind === 'cancelled') throw new DOMException(t('providerRequestErrors.aborted'), 'AbortError')
      if (reply.kind === 'timeout') throw new DOMException(t('openAiTtsErrors.timeout'), 'TimeoutError')
      if (reply.kind !== 'audio') throw new Error(t(`openAiTtsErrors.${reply.kind}`))
      const { wav, durationMs } = reply
      const blob = new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
      return { blob, mimeType: blob.type, durationMs, model }
    } catch (error) {
      input.signal?.throwIfAborted()
      throw error
    } finally {
      input.signal?.removeEventListener('abort', cancel)
    }
  }

  const spoken = clipText(spokenTextOnly(input.text || ''))
  const text = /[가-힣]/.test(spoken) ? spoken : normalizeForSpeech(spoken)
  if (!text) throw new Error(t('openAiTtsErrors.emptySpeech'))

  const voice = compatibleVoice(model, input.voice || cfg.voice)
  const language = input.language || detectSpeechLanguage(text)
  log(`내레이션 텍스트 ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}  lang=${language}`)

  if (!cfg.apiKey) throw new Error(t('openAiTtsErrors.speechKeyRequired'))

  const apiRoot = speechApiRoot(cfg.baseUrl)
  const errors: string[] = []

  try {
    log(`→ SpeechSynthesizer (${model}, ${voice})`)
    const blob = await speechSynthesizer(
      apiRoot,
      cfg.apiKey,
      model,
      text,
      voice,
      language,
      input.instruction,
      input.signal
    )
    log(`✓ ${(blob.size / 1024).toFixed(1)} KB`)
    return { blob, mimeType: blob.type, model }
  } catch (e: any) {
    errors.push(e?.message ?? String(e))
    log(`음성 합성에 실패했어요. ${e?.message ?? e}`)
  }

  // 이전 qwen3-tts 모델을 사용하는 경우 멀티모달 방식으로 다시 시도한다.
  if (/^qwen3-tts/i.test(model) || /^qwen-tts/i.test(model)) {
    try {
      const origin = apiRoot.replace(/\/api\/v1$/i, '')
      log(`→ 다중 모달 대체 연결 (${model}, ${voice})`)
      const blob = await nativeQwen3Speech(
        origin,
        cfg.apiKey,
        model,
        text,
        voice,
        language,
        input.signal
      )
      log(`✓ ${(blob.size / 1024).toFixed(1)} KB`)
      return { blob, mimeType: blob.type, model }
    } catch (e: any) {
      errors.push(e?.message ?? String(e))
    }
  }

  throw new Error(errors.join('\n') || t('openAiTtsErrors.speechFailed'))
}
