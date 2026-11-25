import { isLtxDesktop } from './ltxDesktopOptions'
/**
 * 런타임 AI 설정은 저장된 설정을 우선하고 없으면 .env를 사용한다.
 */

import { useSettingsStore } from '@/stores'
import { isAutodlHost, normalizeStoredVideoEndpoint } from './adapters'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from './env'
import { zealmanWorkflowById } from './zealman'
import type { AIMode, ServiceEndpoint } from '@/stores/settings'
import type { VideoPromptStyle } from '@/utils/shotPrompt'

function pick() {
  try {
    return useSettingsStore().config
  } catch {
    return null
  }
}

export function getAIMode(): AIMode {
  return 'real'
}

function chatConfig(kind: 'llm' | 'vision') {
  const config = pick()?.[kind] ?? envDefaults()[kind]
  return { ...config, baseUrl: (config.baseUrl || '').replace(/\/+$/, '') }
}

export function getLlmConfig() {
  return chatConfig('llm')
}

/** 이미지 이해 기능이 켜져 있고 현재 연결의 주소, 키, 모델이 모두 설정돼 있어야 한다. */
export function visionCallsEnabled(): boolean {
  const config = pick()
  const vision = config?.vision
  return Boolean(config?.visionEnabled && vision?.baseUrl?.trim() && vision.apiKey?.trim() && vision.model?.trim())
}

export function getVisionConfig() {
  return chatConfig('vision')
}

export function getImageConfig() {
  const s: Omit<ServiceEndpoint, 'models'> = pick()?.image ?? envDefaults().image
  return {
    ...s,
    baseUrl: (s.baseUrl || '').replace(/\/+$/, '')
  }
}

export function getTtsConfig() {
  const d = envDefaults().tts
  const s = pick()?.tts
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model,
    voice: s?.voice || d.voice
  }
}

export function getVideoPromptStyle(): VideoPromptStyle {
  return pick()?.video?.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative'
}

/** 내장 H3는 AutoDL 토큰을 사용한다. Zealman 토큰을 대신 사용하지 않는다. */
export function autodlVideoProfileId(): string | undefined {
  const settings = pick()
  const list = (settings?.videos || []).filter((profile) => {
    const normalized = normalizeStoredVideoEndpoint(profile)
    if (normalized.provider === 'zealman') return false
    if (normalized.adapter?.type === 'zealman-workflow' && zealmanWorkflowById(normalized.workflowId || '')) return false
    return normalized.provider === 'autodl' || isAutodlHost(normalized.baseUrl || '')
  })
  const active = list.find((profile) => profile.id === settings?.activeVideoId)
  return (active || list[0])?.id
}

function isAutodlVideoProfile(profile: { provider?: string; baseUrl?: string }): boolean {
  return profile.provider === 'autodl' || isAutodlHost(profile.baseUrl || '')
}

/** AutoDL이 아닌 연결에는 잘못 저장된 AutoDL 토큰을 보내지 않는다. */
function videoKeyForProfile(
  profile: { id?: string; provider?: string; baseUrl?: string; apiKey?: string } | undefined,
  envKey: string
): string {
  const key = String(profile?.apiKey || '').trim()
  if (!profile) return envKey
  if (isAutodlVideoProfile(profile)) return key || envKey
  const settings = pick()
  const stolen = (settings?.videos || []).some((item) => {
    if (item.id === profile.id) return false
    return isAutodlVideoProfile(item) && String(item.apiKey || '').trim() === key && Boolean(key)
  })
  return stolen ? '' : key
}

export function getVideoConfig(profileId?: string) {
  const d = envDefaults().video
  const settings = pick()
  if (profileId && settings && !settings.videos?.some((profile) => profile.id === profileId)) {
    throw new Error('이 노드에서 사용하던 영상 연결이 삭제됐어요. 모델이나 워크플로를 다시 선택하세요.')
  }
  let s = profileId
    ? settings?.videos?.find((profile) => profile.id === profileId) || settings?.video
    : settings?.video
  if (s) s = normalizeStoredVideoEndpoint(s)
  // Zealman 연결이며 내장 U 시리즈 ID일 때만 AutoDL 오입력 주소를 미러로 교체한다.
  // 남아 있는 어댑터 설정만으로 사용자가 선택한 AutoDL 연결을 변경하지 않는다.
  if (
    s?.provider === 'zealman' &&
    s.adapter?.type === 'zealman-workflow' &&
    zealmanWorkflowById(s.workflowId || '') &&
    isAutodlHost(s.baseUrl || '')
  ) {
    const videos = (settings?.videos || []).map((profile) => normalizeStoredVideoEndpoint(profile))
    s = videos.find(
      (profile) =>
        profile.provider === 'zealman' &&
        profile.workflowId === s?.workflowId &&
        !isAutodlHost(profile.baseUrl || '')
    ) || videos.find(
      (profile) =>
        profile.provider === 'zealman' &&
        Boolean(zealmanWorkflowById(profile.workflowId || '')) &&
        !isAutodlHost(profile.baseUrl || '')
    ) || s
  }
  const nativeComfy = s?.adapter?.type === 'comfyui-prompt'
  const comfyBaseUrl = (s?.baseUrl || '').trim().replace(/\/+$/, '')
  if (nativeComfy && (!comfyBaseUrl || isAutodlHost(comfyBaseUrl))) {
    throw new Error('ComfyUI 워크플로의 서버 주소가 올바르지 않아요. ComfyUI 연결에서 API 주소를 다시 입력하세요.')
  }
  return {
    ltxHostOverride: isLtxDesktop(s) ? s?.ltxHostOverride : undefined,
    baseUrl: isLtxDesktop(s) ? comfyBaseUrl : nativeComfy ? comfyBaseUrl : migrateVideoBaseUrl(s?.baseUrl || d.baseUrl),
    apiKey: nativeComfy ? videoKeyForProfile(s, '') : videoKeyForProfile(s, d.apiKey),
    workflowId: nativeComfy ? (s?.workflowId || 'comfyui-local') : migrateVideoWorkflowId(s?.workflowId || d.workflowId),
    promptStyle: getVideoPromptStyle(),
    adapter: s?.adapter,
    provider: s?.provider,
    options: s?.options,
    name: s && 'name' in s ? String((s as { name?: string }).name || '') : '',
    zealmanBaseUrl: settings?.zealmanBaseUrl || ''
  }
}

export function getMusicConfig() {
  const d = envDefaults().music
  const s = pick()?.music
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model
  }
}

export function getRemakeImageModel() {
  return envDefaults().remakeImageModel
}

/** 설정에서 선택한 이미지 모델을 쓰고 영상 재현에 설정이 없으면 GPT Image를 사용한다. */
export function imageModelForProject(pipelineMode?: string) {
  const image = pick()?.image
  if (image) return image.model?.trim() || undefined
  return pipelineMode === 'remake' ? getRemakeImageModel() : undefined
}
