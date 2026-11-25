/** Bailian TTS 주소와 API 키를 사용한 Qwen3-TTS 음성 복제 및 비실시간 합성 */
import { t as translate } from '@/i18n'
import { getTtsConfig } from './runtime'
import { normalizeForSpeech } from './tts'

const CLONE_MODEL = 'qwen3-tts-vc-2026-01-22'

/** 오디오 노드에서 음색 복제 모델을 선택하면 참조 오디오를 업로드할 수 있다. */
export const VOICE_CLONE_MODEL = CLONE_MODEL

export function modelAcceptsReferenceAudio(model?: string): boolean {
  const name = (model || '').trim().toLowerCase()
  if (!name) return false
  if (name === CLONE_MODEL) return true
  return /tts-vc|voice-?clone|voice-enrollment|声音复刻|cosyvoice/.test(name)
}

function apiRoot(baseUrl: string): string {
  let value = baseUrl.trim().replace(/\/+$/, '')
  value = value.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(value)) return value
  if (/^https?:\/\//i.test(value) && !/\/api\//i.test(value)) return `${value}/api/v1`
  return value
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${blob.type || 'audio/mpeg'};base64,${btoa(binary)}`
}

function audioFromBase64(value: string, mime = 'audio/mpeg'): Blob {
  const raw = value.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

async function downloadAudio(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`복제한 음성을 다운로드하지 못했습니다. HTTP ${response.status}`)
  const type = response.headers.get('content-type') || 'audio/mpeg'
  return new Blob([await response.arrayBuffer()], { type })
}

async function request(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const config = getTtsConfig()
  if (config.openAi) throw new Error('음색을 복제하려면 더빙 설정에서 참조 오디오를 지원하는 기존 연결을 선택해야 합니다.')
  if (!config.apiKey.trim()) throw new Error(translate('providerErrors.voiceCloneDashscopeKey'))
  const response = await fetch(`${apiRoot(config.baseUrl)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  })
  const raw = await response.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`음성 서비스가 오류를 반환했습니다. HTTP ${response.status} ${raw.slice(0, 180)}`)
  }
  if (!response.ok || data?.code) {
    throw new Error(`음성 서비스가 실패했습니다. ${data?.message || data?.code || response.status}`)
  }
  return data
}

export interface CloneVoiceOutput {
  voiceId: string
  model: string
  fallbackMode?: boolean
  fallbackReason?: string
}

export async function cloneVoiceFromSample(
  sample: Blob,
  preferredName: string,
  signal?: AbortSignal
): Promise<CloneVoiceOutput> {
  if (sample.size > 10 * 1024 * 1024) throw new Error('음성 샘플은 10MB 이하여야 합니다.')
  const safeName = preferredName.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'aicutvoice'
  const data = await request(
    '/services/audio/tts/customization',
    {
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: CLONE_MODEL,
        preferred_name: safeName,
        audio: { data: await blobToDataUrl(sample) }
      }
    },
    signal
  )
  const voiceId = String(data?.output?.voice || '').trim()
  if (!voiceId) throw new Error('음성 복제 성공 응답에 voice ID가 없습니다.')
  return {
    voiceId,
    model: String(data?.output?.target_model || CLONE_MODEL),
    fallbackMode: data?.output?.fallback_mode,
    fallbackReason: data?.output?.fallback_reason
  }
}

export async function synthesizeClonedSpeech(
  text: string,
  voiceId: string,
  model = CLONE_MODEL,
  signal?: AbortSignal
): Promise<Blob> {
  const data = await request(
    '/services/aigc/multimodal-generation/generation',
    { model, input: { text: normalizeForSpeech(text.trim()), voice: voiceId } },
    signal
  )
  const audio = data?.output?.audio ?? data?.audio
  if (audio?.data) return audioFromBase64(String(audio.data), audio?.mime_type || 'audio/mpeg')
  const url = String(audio?.url || data?.output?.audio_url || '').trim()
  if (!url) throw new Error(`음성 복제 응답에 오디오가 없습니다. ${JSON.stringify(data).slice(0, 220)}`)
  return downloadAudio(url, signal)
}

