/**
 * 런타임 AI 설정은 저장된 설정을 우선하고 없으면 .env를 사용한다.
 */

import { useSettingsStore } from '@/stores'
import { isAutodlHost, normalizeStoredVideoEndpoint } from './adapters'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from './env'
import { zealmanWorkflowById } from './zealman'
import type { AIMode } from '@/stores/settings'
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

export function getLlmConfig() {
  const d = envDefaults().llm
  const s = pick()?.llm
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model,
    adapter: s?.adapter,
    provider: s?.provider
  }
}

export function getVisionConfig() {
  const d = envDefaults().vision
  const s = pick()?.vision
  const selectedModel = s?.model || d.model
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    // 이전 비전 설정을 프로젝트의 Qwen3-VL 설정으로 마이그레이션한다.
    model: /^(qwen3\.7|qwen-vl-)/i.test(selectedModel) ? 'qwen3-vl-plus' : selectedModel,
    adapter: s?.adapter,
    provider: s?.provider
  }
}

export function getImageConfig() {
  const d = envDefaults().image
  const s = pick()?.image
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model,
    adapter: s?.adapter,
    provider: s?.provider,
    options: s?.options
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
  return {
    baseUrl: migrateVideoBaseUrl(s?.baseUrl || d.baseUrl),
    apiKey: videoKeyForProfile(s, d.apiKey),
    workflowId: migrateVideoWorkflowId(s?.workflowId || d.workflowId),
    promptStyle: getVideoPromptStyle(),
    adapter: s?.adapter,
    provider: s?.provider,
    options: s?.options,
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

export function getRemakeVisionModel() {
  return envDefaults().remakeVisionModel || 'qwen-vl-max'
}

export function getRemakeImageModel() {
  return envDefaults().remakeImageModel || 'gpt-image-1'
}

/** 설정에서 선택한 이미지 모델을 쓰고 영상 재현에 설정이 없으면 GPT Image를 사용한다. */
export function imageModelForProject(pipelineMode?: string) {
  const selected = pick()?.image?.model?.trim()
  if (selected) return selected
  return pipelineMode === 'remake' ? getRemakeImageModel() : undefined
}
