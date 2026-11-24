/**
 * baseUrl만으로 자체 호스팅 ComfyUI 이미지 및 영상 연결을 추가한다.
 * 실제 생성에는 어댑터에서 workflowTemplate을 등록해야 한다.
 */

import {
  testEndpointConnection,
  type AdapterConfig
} from '@/services/ai/adapters'
import { uniqueProfileName, useSettingsStore } from '@/stores/settings'

export type ComfyQuickKind = 'image' | 'video'

export interface ComfyQuickAddInput {
  baseUrl: string
  apiKey?: string
  /** 기본적으로 이미지 생성과 영상 생성 연결을 함께 추가한다. */
  kinds?: ComfyQuickKind[]
  /** 추가한 연결을 선택 상태로 만든다. 기본값은 true다. */
  select?: boolean
  /** 선택적으로 연결을 확인한다. */
  test?: boolean
}

export interface ComfyQuickAddResult {
  ok: boolean
  baseUrl: string
  imageId?: string
  videoId?: string
  notes: string[]
  test?: { ok: boolean; detail: string }
}

export function normalizeComfyBaseUrl(raw: string): string {
  let u = String(raw || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  u = u.replace(/\/+$/, '')
  // 잘못 붙여 넣은 ComfyUI 경로를 제거한다.
  u = u
    .replace(/\/upload\/image$/i, '')
    .replace(/\/prompt$/i, '')
    .replace(/\/system_stats$/i, '')
    .replace(/\/history(\/.*)?$/i, '')
    .replace(/\/view(\?.*)?$/i, '')
    .replace(/\/+$/, '')
  return u
}

export function looksLikeComfyUrl(url: string): boolean {
  const u = normalizeComfyBaseUrl(url)
  if (!u) return false
  try {
    const host = new URL(u).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    if (/comfy/i.test(u)) return true
    const port = new URL(u).port
    if (port === '8188' || port === '8189') return true
  } catch {
    return false
  }
  return /comfyui|8188/i.test(u)
}

function defaultAdapter(): AdapterConfig {
  return {
    type: 'comfyui-prompt',
    path: '/prompt',
    pollPath: '/history/{id}',
    authPrefix: ''
  }
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** 로컬 설정에 이미지 및 영상 ComfyUI 연결을 저장한다. */
export async function addComfyUiProfiles(input: ComfyQuickAddInput): Promise<ComfyQuickAddResult> {
  const settings = useSettingsStore()
  const baseUrl = normalizeComfyBaseUrl(input.baseUrl)
  const notes: string[] = []
  if (!baseUrl) {
    return { ok: false, baseUrl: '', notes: ['ComfyUI 주소를 입력하세요. 예를 들어 http://127.0.0.1:8188을 사용할 수 있습니다.'] }
  }

  const kinds = input.kinds?.length ? input.kinds : (['image', 'video'] as ComfyQuickKind[])
  const apiKey = String(input.apiKey || '').trim()
  const select = input.select !== false
  const adapter = defaultAdapter()
  const label = hostLabel(baseUrl)
  let imageId: string | undefined
  let videoId: string | undefined

  if (kinds.includes('image')) {
    const name = uniqueProfileName(
      settings.config.images.map((p) => p.name),
      `ComfyUI 이미지 생성 (${label})`
    )
    imageId = settings.addImage({
      name,
      baseUrl,
      apiKey,
      model: 'comfyui',
      models: ['comfyui'],
      provider: 'custom',
      adapter
    })
    if (select) settings.selectImage(imageId)
    notes.push(`이미지 생성 연결 ‘${name}’을 추가했습니다.`)
  }

  if (kinds.includes('video')) {
    const name = uniqueProfileName(
      settings.config.videos.map((p) => p.name),
      `ComfyUI 영상 (${label})`
    )
    videoId = settings.addVideo({
      name,
      baseUrl,
      apiKey,
      workflowId: 'comfyui-local',
      promptStyle: 'scene-narrative',
      provider: 'custom',
      stillMode: 'keyframe',
      adapter
    })
    if (select) settings.selectVideo(videoId)
    notes.push(`영상 연결 ‘${name}’을 추가했습니다.`)
  }

  notes.push(
    '이미지나 영상 생성 전에 ‘어댑터 → workflowTemplate’에 ComfyUI Save (API Format)으로 내보낸 JSON을 붙여 넣으세요. 도우미로 프롬프트와 참조 이미지의 입력 노드를 분석하세요.'
  )

  let test: ComfyQuickAddResult['test']
  if (input.test) {
    const probeKind = kinds.includes('video') ? 'video' : 'image'
    const ep = {
      baseUrl,
      apiKey,
      model: 'comfyui',
      workflowId: 'comfyui-local',
      provider: 'custom',
      adapter
    }
    const result = await testEndpointConnection(probeKind, ep)
    test = result
    notes.push(result.ok ? `연결 테스트 통과 ${result.detail}` : `연결 테스트 실패 ${result.detail}`)
  }

  return {
    ok: Boolean(imageId || videoId),
    baseUrl,
    imageId,
    videoId,
    notes,
    test
  }
}

/** 사용자 요청에서 ComfyUI 주소를 추출한다. */
export function extractComfyMention(text: string): { baseUrl: string; apiKey: string } | null {
  const t = String(text || '')
  const urlMatch =
    t.match(/https?:\/\/[^\s"'<>`]+/i) ||
    t.match(/(?:^|[\s：:是在])((?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?)/i) ||
    t.match(/(?:^|[\s：:是在])((?:\d{1,3}\.){3}\d{1,3}:\d{2,5})/)
  if (!urlMatch) return null
  let raw = (urlMatch[1] || urlMatch[0] || '').replace(/[),.;]+$/g, '')
  const baseUrl = normalizeComfyBaseUrl(raw)
  if (!baseUrl) return null

  const mentionsComfy =
    /comfy\s*ui|comfyui|自建\s*comfy|本地\s*comfy|我的\s*comfy|图生视频.*本机|本机.*出图/i.test(t) ||
    (/在\s*.+/.test(t) && /8188|localhost|127\.0\.0\.1/i.test(t))
  const bareShort = t.trim().length < 160 && /^(https?:\/\/)?[\w.:\[\]\/]+$/i.test(t.trim())
  // ComfyUI를 언급했거나 로컬 및 8188 주소 또는 짧은 단독 주소인 경우를 고려한다.
  if (!mentionsComfy && !looksLikeComfyUrl(baseUrl) && !bareShort) return null
  // 짧더라도 로컬이나 ComfyUI 주소가 아닌 경우 건너뛴다.
  if (!mentionsComfy && !looksLikeComfyUrl(baseUrl) && bareShort) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      if (host.includes('openai.com') || host.includes('aliyuncs.com') || host.includes('deepseek')) {
        return null
      }
    } catch { /* keep */ }
  }

  const key =
    t.match(/(?:api[_-]?key|token|令牌|密钥)[：:=\s]+([A-Za-z0-9._-]{8,})/i)?.[1] || ''
  return { baseUrl, apiKey: key }
}
