import { isLtxDesktop } from '@/services/ai/ltxDesktopOptions'
import { t } from '@/i18n'
/**
 * AI 모드, 모델 연결, UI 환경설정을 관리한다.
 * 데스크톱에서는 사용자가 선택한 폴더의 SQLite에 저장한다.
 * 웹에서는 localStorage를 사용한다.
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { AUTODL_BASE_URL, AUTODL_WORKFLOWS } from '@/services/ai/autodl'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from '@/services/ai/env'
import { isManualImageChoice } from '@/services/ai/providers'
import { desktop, isDesktop } from '@/services/desktop'
import { stillModeForVideoModel, type VideoGenModel, type VideoStillMode } from '@/types/canvas'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import { isAutodlHost, normalizeStoredVideoEndpoint, type AdapterConfig } from '@/services/ai/adapters'
import { normalizeModelNodeOptions, type ModelNodeOptions } from '@/services/ai/modelOptions'
import { GENERAL_STORY_SKILL_ID, normalizeStorySkillId, storySkillById } from '@/skills/storyStyles'
import ko from '@/locales/ko'
import zh from '@/locales/zh'
import { ZEALMAN_WORKFLOWS, zealmanImageWorkflowById } from '@/services/ai/zealman'

export type { AdapterConfig }

const STORAGE_KEY = 'ai-cut:settings'
const SETTINGS_KV_KEY = 'settings'
const LEGACY_SETTINGS_FILE = 'settings.json'

export type { VideoPromptStyle }

export type AIMode = 'mock' | 'real'

export type SetupKind = 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'music'

export interface ServiceEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  /** 연결을 구성하면 모델 목록에서 선택할 수 있다. */
  models: string[]
  /** 설정 페이지에서 선택한 연결 방식 ID. 예를 들어 deepseek, dashscope, custom. */
  provider?: string
  /** 사용자 지정 어댑터. openai-compatible, openai-images, http-custom 또는 comfyui 계열. */
  adapter?: AdapterConfig
  /** 문서에 명시된 노드 옵션. 예를 들어 이미지 해상도 1K 또는 2K. */
  options?: ModelNodeOptions
}

/** 주소, API 키, 모델 목록을 저장한 연결 프로필. */
export interface NamedEndpoint extends ServiceEndpoint {
  id: string
  name: string
}

export interface LlmProfile extends NamedEndpoint {}

export interface TtsEndpoint extends ServiceEndpoint {
  voice: string
}

export interface TtsProfile extends TtsEndpoint {
  id: string
  name: string
}

export interface VideoEndpoint {
  baseUrl: string
  apiKey: string
  workflowId: string
  /**
   * scene-narrative는 이미지에 있는 사람을 식별하고 동작을 서술하는 기본 방식이다.
   * formatted는 인물과 배경 참조로 영상을 만들며 Aesthetic / SHOT 구조를 적용한다.
   */
  promptStyle: VideoPromptStyle
  provider?: string
  /**
   * 영상 참조 이미지 방식. H3와 AutoDL은 기본적으로 identity, 완샹 등은 keyframe을 사용한다.
   * 영상 생성 전에 캔버스에 키프레임을 배치할지 이 값으로 결정한다.
   */
  stillMode: VideoStillMode
  /** 사용자 지정 어댑터. AutoDL은 comfyui-workflow, 자체 서버는 comfyui-prompt이며 http-custom도 지원한다. */
  adapter?: AdapterConfig
  /** 음성 켜기, 종료 프레임 필수 여부 등 문서에서 정의한 옵션. */
  options?: ModelNodeOptions
}

export interface VideoProfile extends VideoEndpoint {
  id: string
  name: string
}

export interface AppSettings {
  theme: 'dark' | 'light'
  aiMode: AIMode
  debug: boolean
  defaultAspectRatio: string
  autoSaveInterval: number
  llm: ServiceEndpoint
  llms: LlmProfile[]
  activeLlmId: string
  vision: ServiceEndpoint
  visions: NamedEndpoint[]
  activeVisionId: string
  /** 끄면 주소와 키가 있어도 이미지 이해 모델에 이미지를 보내지 않는다. */
  visionEnabled: boolean
  image: ServiceEndpoint
  images: NamedEndpoint[]
  activeImageId: string
  tts: TtsEndpoint
  ttsProfiles: TtsProfile[]
  activeTtsId: string
  video: VideoEndpoint
  videos: VideoProfile[]
  activeVideoId: string
  /**
   * 창작 환경설정의 기본 영상 모델. 내장 워크플로는 h3, h3-v5, wan-prime이다.
   * 비어 있으면 activeVideoId를 사용한다. 노드에서 선택한 모델이 우선한다.
   */
  defaultVideoModel?: VideoGenModel
  /** Zealman 미러는 AutoDL 등 다른 영상 프로필과 주소를 공유하지 않는다. */
  zealmanBaseUrl: string
  /** H3 내장 워크플로가 공유하는 AutoDL 토큰. 한 곳에서만 입력한다. */
  autodlToken: string
  music: ServiceEndpoint
  musics: NamedEndpoint[]
  activeMusicId: string
  /** 사용자가 가져온 연출 매뉴얼이다. 스킬 메뉴에서 내 스킬을 선택하면 사용한다. */
  directorSkill: DirectorSkillDoc | null
  /**
   * 캔버스 에이전트가 현재 사용하는 스토리보드 스킬이다.
   * storyboard-director는 기본, custom은 directorSkill을 사용한다. 나머지는 내장 방식이나 장르다.
   */
  activeStorySkillId: string
  storyStyleId: string
  storyGenreId: string
  /** 내장 숏드라마 대사 참고 유형 */
  scriptReferenceType: string
}

export interface DirectorSkillDoc {
  name: string
  filename: string
  body: string
  importedAt: number
}

export const TTS_PRESETS = ['qwen-audio-3.0-tts-flash', 'qwen3-tts-flash']

export const MUSIC_PRESETS = ['music-3.0']

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

export function uniqueProfileName(existing: string[], base: string): string {
  const names = new Set(existing)
  if (!names.has(base)) return base
  let i = 2
  while (names.has(`${base} ${i}`)) i += 1
  return `${base} ${i}`
}

export function endpointReady(ep?: {
  baseUrl?: string
  apiKey?: string
  model?: string
  workflowId?: string
  adapter?: AdapterConfig
  provider?: string
}) {
  if (!ep) return false
  const adapterType = ep.adapter?.type
  const localComfy =
    adapterType === 'comfyui-prompt' ||
    adapterType === 'zealman-workflow' ||
    (/localhost|127\.0\.0\.1/i.test(ep.baseUrl || '') && ep.provider === 'custom')
  const hasEndpoint = Boolean(ep.baseUrl?.trim() && (ep.apiKey?.trim() || localComfy))
  const hasModel = Boolean(ep.model?.trim() || ep.workflowId?.trim() || adapterType === 'comfyui-prompt')
  return hasEndpoint && hasModel
}

export function isLlmConfigured(cfg: AppSettings) {
  return endpointReady(cfg.llm)
}

/** 에이전트와 대본 작성에서 선택할 수 있는 연결별 모델 목록. */
export function namedModelGroups(list: NamedEndpoint[] | TtsProfile[]) {
  return (list ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    models: uniq([p.model, ...(p.models ?? [])])
  }))
}

export function llmModelGroups(llms: LlmProfile[]) {
  return namedModelGroups(llms)
}

export function llmChoiceKey(profileId: string, model: string) {
  return `${profileId}::${model}`
}

export function parseLlmChoiceKey(key: string): { profileId: string; model: string } | null {
  const i = key.indexOf('::')
  if (i <= 0) return null
  return { profileId: key.slice(0, i), model: key.slice(i + 2) }
}

function newId(prefix = 'cfg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function asEndpoint(ep: ServiceEndpoint): ServiceEndpoint {
  return {
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
    models: uniq(ep.models ?? []),
    provider: ep.provider,
    adapter: ep.adapter,
    options: normalizeModelNodeOptions(ep.options)
  }
}

function asTts(ep: TtsEndpoint): TtsEndpoint {
  return {
    ...asEndpoint(ep),
    voice: ep.voice || 'longanhuan_v3.6'
  }
}

function asVideo(ep: VideoEndpoint): VideoEndpoint {
  return {
    baseUrl: (ep.baseUrl || '').trim(),
    apiKey: ep.apiKey || '',
    workflowId: (ep.workflowId || '').trim(),
    promptStyle: ep.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
    provider: ep.provider,
    stillMode: stillModeForVideoModel('h3', ep),
    adapter: ep.adapter,
    options: normalizeModelNodeOptions(ep.options)
  }
}

function profileFromEndpoint(ep: ServiceEndpoint, name: string, id?: string): NamedEndpoint {
  return {
    id: id || newId('svc'),
    name,
    ...asEndpoint(ep)
  }
}

function ttsFromEndpoint(ep: TtsEndpoint, name: string, id?: string): TtsProfile {
  return {
    id: id || newId('tts'),
    name,
    ...asTts(ep)
  }
}

function videoFromEndpoint(ep: VideoEndpoint, name: string, id?: string): VideoProfile {
  return {
    id: id || newId('vid'),
    name,
    ...asVideo(ep)
  }
}

function endpoint(
  baseUrl: string,
  apiKey: string,
  model: string,
  presets: string[]
): ServiceEndpoint {
  return {
    baseUrl,
    apiKey,
    model,
    models: uniq([model, ...presets])
  }
}

function hydrateNamed(
  saved: unknown,
  fallback: ServiceEndpoint,
  defaultName: string,
  savedActiveId?: string,
  prefix = 'svc'
): { list: NamedEndpoint[]; activeId: string; active: ServiceEndpoint } {
  const savedList = Array.isArray(saved)
    ? saved.filter((p): p is NamedEndpoint => Boolean(p && p.id && p.name))
    : []
  const list = savedList.length
    ? savedList.map((p) =>
        profileFromEndpoint(
          {
            ...fallback,
            ...p,
            models: uniq([...(p.models ?? []), ...(p.model ? [p.model] : [])])
          },
          p.name,
          p.id
        )
      )
    : [profileFromEndpoint(fallback, defaultName, newId(prefix))]
  const activeId = list.some((p) => p.id === savedActiveId) ? (savedActiveId as string) : list[0].id
  const active = list.find((p) => p.id === activeId) || list[0]
  return { list, activeId: active.id, active: asEndpoint(active) }
}

function hydrateTts(
  saved: unknown,
  fallback: TtsEndpoint,
  savedActiveId?: string
): { list: TtsProfile[]; activeId: string; active: TtsEndpoint } {
  const savedList = Array.isArray(saved)
    ? saved.filter((p): p is TtsProfile => Boolean(p && p.id && p.name))
    : []
  const list = savedList.length
    ? savedList.map((p) =>
        ttsFromEndpoint(
          {
            ...fallback,
            ...p,
            models: uniq([...(p.models ?? []), ...(p.model ? [p.model] : [])])
          },
          p.name,
          p.id
        )
      )
    : [ttsFromEndpoint(fallback, t('settings.defaults.tts'))]
  const activeId = list.some((p) => p.id === savedActiveId) ? (savedActiveId as string) : list[0].id
  const active = list.find((p) => p.id === activeId) || list[0]
  return { list, activeId: active.id, active: asTts(active) }
}

/** AutoDL 토큰이 있으면 추가된 기본 워크플로를 연결 목록에 보완한다. */
function ensureBuiltinAutodlWorkflows(list: VideoProfile[]): VideoProfile[] {
  const donor = list.find((profile) => isAutodlVideoProfile(profile) && String(profile.apiKey || '').trim())
  const token = String(donor?.apiKey || '').trim()
  if (!token) return list
  const missing = AUTODL_WORKFLOWS.filter(
    (workflow) => !list.some((profile) => isAutodlVideoProfile(profile) && profile.workflowId === workflow.id)
  )
  if (!missing.length) return list
  return [
    ...list,
    ...missing.map((workflow) =>
      videoFromEndpoint(
        {
          baseUrl: donor?.baseUrl || AUTODL_BASE_URL,
          apiKey: token,
          workflowId: workflow.id,
          promptStyle: 'scene-narrative',
          provider: 'autodl',
          stillMode: 'identity',
          adapter: { type: 'comfyui-workflow' }
        },
        workflow.name
      )
    )
  ]
}

function isAutodlVideoProfile(profile: { provider?: string; baseUrl?: string; adapter?: AdapterConfig; workflowId?: string }): boolean {
  const normalized = normalizeStoredVideoEndpoint(profile)
  return normalized.provider === 'autodl' || isAutodlHost(normalized.baseUrl || '')
}

/** AutoDL 토큰은 AutoDL 연결에만 둔다. 다른 공급업체에 같은 토큰이 저장돼 있으면 불러올 때 제거한다. */
function isolateVideoKeys(list: VideoProfile[]): VideoProfile[] {
  const autodlKeys = new Set(
    list
      .filter((profile) => isAutodlVideoProfile(profile))
      .map((profile) => String(profile.apiKey || '').trim())
      .filter(Boolean)
  )
  if (!autodlKeys.size) return list
  return list.map((profile) => {
    const key = String(profile.apiKey || '').trim()
    if (!isAutodlVideoProfile(profile) && key && autodlKeys.has(key)) {
      return { ...profile, apiKey: '' }
    }
    return profile
  })
}

function isManualVideoProfile(profile: VideoProfile): boolean {
  return profile.provider === 'dashscope' || /dashscope\.aliyuncs\.com/i.test(profile.baseUrl)
}

function hydrateVideo(
  saved: unknown,
  fallback: VideoEndpoint,
  savedActiveId?: string
): { list: VideoProfile[]; activeId: string; active: VideoEndpoint } {
  const savedList = Array.isArray(saved)
    ? saved.filter((p): p is VideoProfile => Boolean(p && p.id && p.name))
    : []
  const list = savedList.length
    ? savedList.map((p) => {
        // 현재 연결에만 기본값을 보완한다. 다른 연결은 Zealman 어댑터를 상속하지 않는다.
        // AutoDL 요청을 Zealman 미러로 잘못 제출하지 않도록 한다.
        const isActive = p.id === savedActiveId
        return videoFromEndpoint(
          normalizeStoredVideoEndpoint({
            baseUrl: p.baseUrl || (isActive ? fallback.baseUrl : ''),
            apiKey: p.apiKey ?? (isActive ? fallback.apiKey : ''),
            workflowId: p.workflowId || (isActive ? fallback.workflowId : ''),
            promptStyle: p.promptStyle || fallback.promptStyle,
            provider: p.provider ?? (isActive ? fallback.provider : undefined),
            stillMode: p.stillMode,
            options: p.options,
            adapter: p.adapter ?? (isActive ? fallback.adapter : undefined)
          }),
          p.name,
          p.id
        )
      })
    : [videoFromEndpoint(normalizeStoredVideoEndpoint(fallback), t('settings.defaults.video'))]
  const isolated = ensureBuiltinAutodlWorkflows(isolateVideoKeys(list))
  const active = isolated.find((p) => p.id === savedActiveId) ||
    isolated.find((p) => !isManualVideoProfile(p)) || isolated[0]
  const activeId = active.id
  return { list: isolated, activeId: active.id, active: asVideo(active) }
}

function normalizeDirectorSkill(raw: unknown): DirectorSkillDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const body = String((raw as DirectorSkillDoc).body || '').trim().slice(0, 24_000)
  if (body.length < 20) return null
  return {
    name: String((raw as DirectorSkillDoc).name || t('directorSkill.defaultName')).trim().slice(0, 80) || t('directorSkill.defaultName'),
    filename: String((raw as DirectorSkillDoc).filename || '').slice(0, 180),
    body,
    importedAt: Number((raw as DirectorSkillDoc).importedAt) || Date.now()
  }
}

function buildDefaults(): AppSettings {
  const env = envDefaults()
  const llm = endpoint(env.llm.baseUrl, env.llm.apiKey, env.llm.model, [])
  const first = profileFromEndpoint(llm, t('settings.defaults.llm'), newId('llm'))
  const vision = endpoint(env.vision.baseUrl, env.vision.apiKey, env.vision.model, [])
  const visionFirst = profileFromEndpoint(vision, t('settings.defaults.vision'), newId('vis'))
  const image = endpoint(env.image.baseUrl, env.image.apiKey, env.image.model, [])
  const imageFirst = profileFromEndpoint(image, t('settings.defaults.image'), newId('img'))
  const tts: TtsEndpoint = {
    ...endpoint(env.tts.baseUrl, env.tts.apiKey, env.tts.model, TTS_PRESETS),
    voice: env.tts.voice
  }
  const ttsFirst = ttsFromEndpoint(tts, t('settings.defaults.tts'))
  const video: VideoEndpoint = {
    baseUrl: env.video.baseUrl,
    apiKey: env.video.apiKey,
    workflowId: env.video.workflowId,
    promptStyle: 'scene-narrative',
    stillMode: 'identity'
  }
  const videoFirst = videoFromEndpoint(video, t('settings.defaults.video'))
  const music = endpoint(env.music.baseUrl, env.music.apiKey, env.music.model, MUSIC_PRESETS)
  const musicFirst = profileFromEndpoint(music, t('settings.defaults.music'), newId('mus'))
  return {
    theme: 'dark',
    aiMode: 'real',
    debug: false,
    defaultAspectRatio: '16:9',
    autoSaveInterval: 0,
    llm: asEndpoint(first),
    llms: [first],
    activeLlmId: first.id,
    vision: asEndpoint(visionFirst),
    visions: [visionFirst],
    activeVisionId: visionFirst.id,
    visionEnabled: false,
    image: asEndpoint(imageFirst),
    images: [imageFirst],
    activeImageId: imageFirst.id,
    tts: asTts(ttsFirst),
    ttsProfiles: [ttsFirst],
    activeTtsId: ttsFirst.id,
    video: asVideo(videoFirst),
    videos: [videoFirst],
    activeVideoId: videoFirst.id,
    defaultVideoModel: undefined,
    zealmanBaseUrl: '',
    autodlToken: '',
    music: asEndpoint(musicFirst),
    musics: [musicFirst],
    activeMusicId: musicFirst.id,
    directorSkill: null,
    activeStorySkillId: GENERAL_STORY_SKILL_ID,
    storyStyleId: GENERAL_STORY_SKILL_ID,
    storyGenreId: GENERAL_STORY_SKILL_ID,
    scriptReferenceType: 'auto'
  }
}

function resolveStoryPreference(value: unknown, legacy: unknown, group: 'style' | 'genre', hasCustom: boolean): string {
  const id = typeof value === 'string' && value ? value : typeof legacy === 'string' ? legacy : ''
  if (group === 'style' && id === 'custom' && hasCustom) return id
  return storySkillById(id)?.group === group ? id : GENERAL_STORY_SKILL_ID
}

function savedChatEndpoint(saved: ServiceEndpoint | undefined, defaults: ServiceEndpoint): ServiceEndpoint {
  if (!saved) return defaults
  const model = saved.model ?? ''
  return { ...saved, apiKey: saved.apiKey ?? '', model, models: uniq([model, ...(saved.models ?? [])]) }
}

function fallbackImageProfile(profiles: NamedEndpoint[], defaults: NamedEndpoint) {
  const existing = profiles.find((profile) => profile.model && !isManualImageChoice(profile))
  if (existing) return existing
  profiles.push(defaults)
  return defaults
}

function savedChatProfiles(list: NamedEndpoint[] | undefined) {
  return Array.isArray(list) ? list.map((profile) => profile && { ...profile, apiKey: profile.apiKey ?? '' }) : []
}

function migrateDefaultNames(settings: Partial<AppSettings>): boolean {
  let changed = false
  function rename(entry: { name: string }, koreanName: string) {
    entry.name = koreanName
    changed = true
  }

  const lists = [
    ['llm', settings.llms], ['vision', settings.visions], ['image', settings.images],
    ['tts', settings.ttsProfiles], ['video', settings.videos], ['music', settings.musics]
  ] as const
  for (const [kind, profiles] of lists) {
    if (!Array.isArray(profiles)) continue
    for (const profile of profiles) {
      if (profile?.id && profile.name === zh.settings.defaults[kind]) {
        rename(profile, ko.settings.defaults[kind])
      } else if (profile?.adapter?.type === 'comfyui-prompt' && profile.name === zh.comfySettings.defaultName) {
        rename(profile, ko.comfySettings.defaultName)
      }
    }
  }

  if (Array.isArray(settings.videos)) {
    for (const profile of settings.videos) {
      if (profile?.provider === 'zealman' && typeof profile.workflowId === 'string') {
        const workflow = ZEALMAN_WORKFLOWS.find((item) => item.id === profile.workflowId)
        if (workflow && profile.name === workflow.name) {
          rename(profile, t(workflow.displayNameKey, {}, { locale: 'ko' }))
        }
      } else if (profile && (profile.provider === 'autodl' || isAutodlHost(profile.baseUrl || ''))) {
        const workflow = AUTODL_WORKFLOWS.find((item) => item.id === profile.workflowId)
        if (workflow?.legacyName && profile.name === workflow.legacyName) rename(profile, workflow.name)
      }
    }
  }
  if (Array.isArray(settings.images)) {
    for (const profile of settings.images) {
      if (profile?.provider !== 'zealman' || typeof profile.model !== 'string') continue
      const workflow = zealmanImageWorkflowById(profile.model)
      if (workflow && profile.name === zh.zealmanSettings.imageProfileName.replace('{p0}', workflow.name)) {
        const label = t(workflow.displayNameKey, {}, { locale: 'ko' })
        rename(profile, t('zealmanSettings.imageProfileName', { p0: label }, { locale: 'ko' }))
      }
    }
  }
  if (settings.directorSkill?.name === zh.directorSkill.defaultName) {
    rename(settings.directorSkill, ko.directorSkill.defaultName)
  }
  return changed
}

function parseSettings(raw: string | null, saveMigrated?: (settings: Partial<AppSettings>) => void): AppSettings {
  const defaults = buildDefaults()
  if (!raw) return defaults
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    if (migrateDefaultNames(parsed)) saveMigrated?.(parsed)
    const llmSnap = savedChatEndpoint(parsed.llm, defaults.llm)
    const visionSnap = savedChatEndpoint(parsed.vision, defaults.vision)
    const llm = hydrateNamed(savedChatProfiles(parsed.llms), llmSnap, t('settings.defaults.llm'), parsed.activeLlmId, 'llm')
    const vision = hydrateNamed(savedChatProfiles(parsed.visions), visionSnap, t('settings.defaults.vision'), parsed.activeVisionId, 'vis')
    const imageProfiles = savedChatProfiles(parsed.images).map((profile) => profile && ({
      ...profile,
      baseUrl: profile.baseUrl ?? '',
      model: profile.model ?? '',
      provider: profile.provider,
      adapter: profile.adapter,
      options: profile.options
    }))
    const image = hydrateNamed(
      imageProfiles,
      savedChatEndpoint(parsed.image, defaults.image),
      t('settings.defaults.image'),
      parsed.activeImageId,
      'img'
    )
    // 프로필을 쓰기 전의 단일 연결과 마지막으로 저장된 선택은 유지한다.
    if (imageProfiles.some((profile) => profile?.id && profile.name) &&
        !image.list.some((profile) => profile.id === parsed.activeImageId)) {
      const saved = parsed.image
      const previous = saved && image.list.find((profile) =>
        profile.baseUrl === saved.baseUrl && profile.model === saved.model && profile.apiKey === saved.apiKey
      )
      const next = previous || fallbackImageProfile(image.list, defaults.images[0])
      image.activeId = next.id
      image.active = asEndpoint(next)
    }
    const tts = hydrateTts(
      parsed.ttsProfiles,
      {
        ...defaults.tts,
        ...parsed.tts,
        models: uniq([...(parsed.tts?.models ?? []), ...defaults.tts.models])
      },
      parsed.activeTtsId
    )
    const video = hydrateVideo(
      parsed.videos,
      {
        ...defaults.video,
        ...parsed.video,
        baseUrl: parsed.video?.adapter?.type === 'comfyui-prompt'
          ? (parsed.video.baseUrl || '').trim()
          : migrateVideoBaseUrl(parsed.video?.baseUrl || defaults.video.baseUrl),
        apiKey: parsed.video?.adapter?.type === 'comfyui-prompt' ? (parsed.video.apiKey || '') : (parsed.video?.apiKey || defaults.video.apiKey),
        workflowId: parsed.video?.adapter?.type === 'comfyui-prompt'
          ? (parsed.video.workflowId || 'comfyui-local')
          : migrateVideoWorkflowId(parsed.video?.workflowId || defaults.video.workflowId),
        promptStyle:
          parsed.video?.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
        stillMode: stillModeForVideoModel('h3', {
          stillMode: parsed.video?.stillMode,
          workflowId: parsed.video?.workflowId,
          provider: parsed.video?.provider
        })
      },
      parsed.activeVideoId
    )
    const zealmanBaseUrl = String(
      parsed.zealmanBaseUrl ||
      video.list.find((profile) => profile.provider === 'zealman' && !/autodl\.art/i.test(profile.baseUrl || ''))?.baseUrl ||
      ''
    ).trim().replace(/\/+$/, '')
    const autodlToken = String(
      parsed.autodlToken ||
      video.list.find((profile) => isAutodlVideoProfile(profile))?.apiKey ||
      ''
    ).trim()
    const music = hydrateNamed(
      parsed.musics,
      {
        ...defaults.music,
        ...parsed.music,
        models: uniq([...(parsed.music?.models ?? []), ...defaults.music.models])
      },
      t('settings.defaults.music'),
      parsed.activeMusicId,
      'mus'
    )

    return {
      ...defaults,
      ...parsed,
      theme: 'dark',
      aiMode: 'real',
      llm: llm.active,
      llms: llm.list,
      activeLlmId: llm.activeId,
      vision: vision.active,
      visions: vision.list,
      activeVisionId: vision.activeId,
      visionEnabled: parsed.visionEnabled === true,
      image: image.active,
      images: image.list,
      activeImageId: image.activeId,
      tts: tts.active,
      ttsProfiles: tts.list,
      activeTtsId: tts.activeId,
      video: video.active,
      videos: video.list,
      activeVideoId: video.activeId,
      defaultVideoModel:
        parsed.defaultVideoModel === 'h3' ||
        parsed.defaultVideoModel === 'h3-v5' ||
        parsed.defaultVideoModel === 'wan-prime'
          ? parsed.defaultVideoModel
          : undefined,
      zealmanBaseUrl,
      autodlToken,
      music: music.active,
      musics: music.list,
      activeMusicId: music.activeId,
      directorSkill: normalizeDirectorSkill(parsed.directorSkill),
      storyStyleId: resolveStoryPreference(parsed.storyStyleId, parsed.activeStorySkillId, 'style', Boolean(normalizeDirectorSkill(parsed.directorSkill))),
      storyGenreId: resolveStoryPreference(parsed.storyGenreId, parsed.activeStorySkillId, 'genre', Boolean(normalizeDirectorSkill(parsed.directorSkill))),
      scriptReferenceType: typeof parsed.scriptReferenceType === 'string' ? parsed.scriptReferenceType : 'auto',
      activeStorySkillId: normalizeStorySkillId(
        parsed.activeStorySkillId,
        Boolean(normalizeDirectorSkill(parsed.directorSkill))
      )
    }
  } catch {
    return defaults
  }
}

function loadFromLocal(): AppSettings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY), writeLocal)
  } catch {
    return buildDefaults()
  }
}

function writeLocal(v: Partial<AppSettings>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
  } catch {
    /* quota / private mode */
  }
}

async function settingsFilePath(): Promise<string> {
  const api = desktop()
  return api.join(await api.getRoot(), LEGACY_SETTINGS_FILE)
}

let writeChain: Promise<void> = Promise.resolve()
let queued: AppSettings | null = null

async function persistToDisk(v: AppSettings) {
  if (!isDesktop()) return
  const api = desktop()
  if (typeof api.kvSet === 'function') {
    await api.kvSet(SETTINGS_KV_KEY, JSON.stringify(v))
  } else {
    const file = await settingsFilePath()
    await api.writeText(file, JSON.stringify(v, null, 2))
  }
}

function writeDisk(v: AppSettings) {
  queued = v
  writeChain = writeChain.catch(() => {}).then(async () => {
    if (!queued) return
    try {
      while (queued) {
        const snap = queued
        queued = null
        await persistToDisk(snap)
      }
    } catch (e) {
      console.warn('[settings] Could not write to local database', e)
      throw e
    }
  })
  return writeChain
}

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppSettings>(loadFromLocal())
  const persistPath = ref('')
  const diskReady = ref(false)
  const lastSavedAt = ref(0)
  let skipDisk = false
  let hydratePromise: Promise<void> | null = null
  let pendingDisk: AppSettings | null = null
  let userEdited = false

  function touch() {
    userEdited = true
  }

  watch(
    config,
    (v) => {
      writeLocal(v)
      if (skipDisk) return
      if (!diskReady.value) {
        pendingDisk = v
        return
      }
      void writeDisk(v).then(() => {
        lastSavedAt.value = Date.now()
      }).catch(() => {})
    },
    { deep: true }
  )

  async function ensureHydrated() {
    if (diskReady.value) return
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      if (!isDesktop()) {
        diskReady.value = true
        return
      }
      try {
        const api = desktop()
        persistPath.value = typeof api.dbPath === 'function' ? await api.dbPath() : await settingsFilePath()
        let raw: string | null = null
        if (typeof api.kvGet === 'function') raw = await api.kvGet(SETTINGS_KV_KEY)
        if (!raw) {
          const file = await settingsFilePath()
          if (await api.exists(file)) raw = await api.readText(file)
        }
        if (raw) {
          skipDisk = true
          if (!userEdited) {
            config.value = parseSettings(raw)
            writeLocal(config.value)
          }
          skipDisk = false
          await writeDisk(config.value)
          lastSavedAt.value = Date.now()
        } else {
          await writeDisk(config.value)
          lastSavedAt.value = Date.now()
        }
      } catch (e) {
        console.warn('[settings] Could not read local database', e)
      } finally {
        diskReady.value = true
        const extra = pendingDisk
        pendingDisk = null
        if (extra) await writeDisk(extra)
      }
    })().finally(() => {
      hydratePromise = null
    })
    return hydratePromise
  }

  void ensureHydrated()

  if (typeof window !== 'undefined') {
    const flushOnLeave = () => {
      writeLocal(config.value)
      if (diskReady.value) void writeDisk(config.value)
    }
    window.addEventListener('beforeunload', flushOnLeave)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnLeave()
    })
  }

  async function flush() {
    writeLocal(config.value)
    await writeDisk(config.value)
    lastSavedAt.value = Date.now()
  }

  function update(patch: Partial<AppSettings>) {
    touch()
    config.value = { ...config.value, ...patch }
  }

  function syncLlm(next: LlmProfile, list?: LlmProfile[]) {
    touch()
    const llms = (list ?? config.value.llms).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, llms, activeLlmId: next.id, llm: asEndpoint(next) }
  }

  function syncVision(next: NamedEndpoint, list?: NamedEndpoint[]) {
    touch()
    const visions = (list ?? config.value.visions).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, visions, activeVisionId: next.id, vision: asEndpoint(next) }
  }

  function syncImage(next: NamedEndpoint, list?: NamedEndpoint[]) {
    touch()
    const images = (list ?? config.value.images).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, images, activeImageId: next.id, image: asEndpoint(next) }
  }

  function syncTts(next: TtsProfile, list?: TtsProfile[]) {
    touch()
    const ttsProfiles = (list ?? config.value.ttsProfiles).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, ttsProfiles, activeTtsId: next.id, tts: asTts(next) }
  }

  function syncVideo(next: VideoProfile, list?: VideoProfile[]) {
    touch()
    const videos = (list ?? config.value.videos).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, videos, activeVideoId: next.id, video: asVideo(next) }
  }

  function syncMusic(next: NamedEndpoint, list?: NamedEndpoint[]) {
    touch()
    const musics = (list ?? config.value.musics).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, musics, activeMusicId: next.id, music: asEndpoint(next) }
  }

  function patchLlm(patch: Partial<LlmProfile>) {
    const id = config.value.activeLlmId
    const cur =
      config.value.llms.find((p) => p.id === id) || profileFromEndpoint(config.value.llm, t('settings.defaults.llm'), id)
    syncLlm({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addLlm(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncLlm(profile, [...config.value.llms, profile])
    return profile.id
  }

  function selectLlm(id: string) {
    const profile = config.value.llms.find((p) => p.id === id)
    if (profile) syncLlm(profile)
  }

  function selectLlmModel(profileId: string, model: string) {
    const profile = config.value.llms.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncLlm({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeLlm(id: string) {
    if (config.value.llms.length <= 1) return
    const llms = config.value.llms.filter((p) => p.id !== id)
    const next = llms.find((p) => p.id === config.value.activeLlmId) || llms[0]
    syncLlm(next, llms)
  }

  function renameLlm(name: string) {
    const n = name.trim()
    if (!n) return
    patchLlm({ name: n })
  }

  function patchVision(patch: Partial<NamedEndpoint>) {
    const id = config.value.activeVisionId
    const cur =
      config.value.visions.find((p) => p.id === id) ||
      profileFromEndpoint(config.value.vision, t('settings.defaults.vision'), id)
    syncVision({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addVision(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncVision(profile, [...config.value.visions, profile])
    return profile.id
  }

  function selectVision(id: string) {
    const profile = config.value.visions.find((p) => p.id === id)
    if (profile) syncVision(profile)
  }

  function selectVisionModel(profileId: string, model: string) {
    const profile = config.value.visions.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncVision({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeVision(id: string) {
    if (config.value.visions.length <= 1) return
    const visions = config.value.visions.filter((p) => p.id !== id)
    const next = visions.find((p) => p.id === config.value.activeVisionId) || visions[0]
    syncVision(next, visions)
  }

  function renameVision(name: string) {
    const n = name.trim()
    if (!n) return
    patchVision({ name: n })
  }

  function patchImage(patch: Partial<NamedEndpoint>) {
    const id = config.value.activeImageId
    const cur =
      config.value.images.find((p) => p.id === id) ||
      profileFromEndpoint(config.value.image, t('settings.defaults.image'), id)
    syncImage({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addImage(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
    options?: ModelNodeOptions
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter,
        options: seed.options
      },
      seed.name
    )
    syncImage(profile, [...config.value.images, profile])
    return profile.id
  }

  function selectImage(id: string) {
    const profile = config.value.images.find((p) => p.id === id)
    if (profile) syncImage(profile)
  }

  function selectImageModel(profileId: string, model: string) {
    const profile = config.value.images.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncImage({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeImage(id: string, allowLast = false) {
    if (config.value.images.length <= 1 && !allowLast) return
    const images = config.value.images.filter((p) => p.id !== id)
    const next = images.find((p) => p.id === config.value.activeImageId) ||
      fallbackImageProfile(images, buildDefaults().images[0])
    syncImage(next, images)
  }

  function renameImage(name: string) {
    const n = name.trim()
    if (!n) return
    patchImage({ name: n })
  }

  function patchTts(patch: Partial<TtsProfile>) {
    const id = config.value.activeTtsId
    const cur =
      config.value.ttsProfiles.find((p) => p.id === id) || ttsFromEndpoint(config.value.tts, t('settings.defaults.tts'), id)
    syncTts({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addTts(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    voice?: string
    adapter?: AdapterConfig
  }) {
    const profile = ttsFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        voice: seed.voice || config.value.tts.voice || 'longanhuan_v3.6',
        adapter: seed.adapter
      },
      seed.name
    )
    syncTts(profile, [...config.value.ttsProfiles, profile])
    return profile.id
  }

  function selectTts(id: string) {
    const profile = config.value.ttsProfiles.find((p) => p.id === id)
    if (profile) syncTts(profile)
  }

  function selectTtsModel(profileId: string, model: string) {
    const profile = config.value.ttsProfiles.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncTts({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeTts(id: string) {
    if (config.value.ttsProfiles.length <= 1) return
    const ttsProfiles = config.value.ttsProfiles.filter((p) => p.id !== id)
    const next = ttsProfiles.find((p) => p.id === config.value.activeTtsId) || ttsProfiles[0]
    syncTts(next, ttsProfiles)
  }

  function renameTts(name: string) {
    const n = name.trim()
    if (!n) return
    patchTts({ name: n })
  }

  function patchVideo(patch: Partial<VideoProfile>) {
    const id = config.value.activeVideoId
    const cur =
      config.value.videos.find((p) => p.id === id) || videoFromEndpoint(config.value.video, t('settings.defaults.video'), id)
    const next = { ...cur, ...patch }
    if ((isLtxDesktop(cur) || isLtxDesktop(next)) &&
      (next.baseUrl !== cur.baseUrl || next.provider !== cur.provider)) next.apiKey = ''
    if (patch.apiKey !== undefined && !isAutodlVideoProfile(next)) {
      const incoming = String(patch.apiKey || '').trim()
      const belongsToAutodl = config.value.videos.some(
        (profile) =>
          profile.id !== id &&
          isAutodlVideoProfile(profile) &&
          String(profile.apiKey || '').trim() === incoming &&
          Boolean(incoming)
      )
      if (belongsToAutodl) next.apiKey = ''
    }
    syncVideo(next)
  }

  function setZealmanBaseUrl(baseUrl: string) {
    touch()
    config.value = { ...config.value, zealmanBaseUrl: baseUrl.trim().replace(/\/+$/, '') }
  }

  function setAutodlToken(token: string) {
    touch()
    config.value = { ...config.value, autodlToken: token.trim() }
  }

  function addVideo(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    workflowId: string
    promptStyle?: VideoPromptStyle
    provider?: string
    stillMode?: VideoStillMode
    adapter?: AdapterConfig
    options?: ModelNodeOptions
  }) {
    const profile = videoFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        workflowId: seed.workflowId,
        promptStyle: seed.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
        provider: seed.provider,
        stillMode: stillModeForVideoModel('h3', seed),
        adapter: seed.adapter,
        options: seed.options
      },
      seed.name
    )
    syncVideo(profile, [...config.value.videos, profile])
    return profile.id
  }

  function selectVideo(id: string) {
    const profile = config.value.videos.find((p) => p.id === id)
    if (profile) syncVideo(profile)
  }

  /** 기본 영상 모델로 내장 워크플로를 선택한다. undefined면 구성된 연결을 따른다. */
  function selectStorySkill(id: string) {
    const next = normalizeStorySkillId(id, Boolean(config.value.directorSkill))
    const group = storySkillById(next)?.group
    touch()
    if (group === 'genre') config.value = { ...config.value, activeStorySkillId: next, storyGenreId: next }
    else config.value = { ...config.value, activeStorySkillId: next, storyStyleId: next }
  }

  function selectVideoModelDefault(model?: VideoGenModel) {
    if (config.value.defaultVideoModel === model) return
    config.value = { ...config.value, defaultVideoModel: model }
  }

  function removeVideo(id: string, allowLast = false) {
    if (config.value.videos.length <= 1 && !allowLast) return
    const videos = config.value.videos.filter((p) => p.id !== id)
    if (!videos.length) videos.push(buildDefaults().videos[0])
    const next = videos.find((p) => p.id === config.value.activeVideoId) ||
      videos.find((p) => !isManualVideoProfile(p)) ||
      buildDefaults().videos[0]
    if (!videos.some((p) => p.id === next.id)) videos.unshift(next)
    syncVideo(next, videos)
  }

  function renameVideo(name: string) {
    const n = name.trim()
    if (!n) return
    patchVideo({ name: n })
  }

  function patchMusic(patch: Partial<NamedEndpoint>) {
    const id = config.value.activeMusicId
    const cur =
      config.value.musics.find((p) => p.id === id) ||
      profileFromEndpoint(config.value.music, t('settings.defaults.music'), id)
    syncMusic({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addMusic(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncMusic(profile, [...config.value.musics, profile])
    return profile.id
  }

  function selectMusic(id: string) {
    const profile = config.value.musics.find((p) => p.id === id)
    if (profile) syncMusic(profile)
  }

  function selectMusicModel(profileId: string, model: string) {
    const profile = config.value.musics.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncMusic({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeMusic(id: string) {
    if (config.value.musics.length <= 1) return
    const musics = config.value.musics.filter((p) => p.id !== id)
    const next = musics.find((p) => p.id === config.value.activeMusicId) || musics[0]
    syncMusic(next, musics)
  }

  function renameMusic(name: string) {
    const n = name.trim()
    if (!n) return
    patchMusic({ name: n })
  }

  function addModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const n = name.trim()
    if (!n) return
    if (kind === 'llm') {
      patchLlm({ models: uniq([...config.value.llm.models, n]), model: n })
      return
    }
    if (kind === 'vision') {
      patchVision({ models: uniq([...config.value.vision.models, n]), model: n })
      return
    }
    if (kind === 'image') {
      patchImage({ models: uniq([...config.value.image.models, n]), model: n })
      return
    }
    if (kind === 'tts') {
      patchTts({ models: uniq([...config.value.tts.models, n]), model: n })
      return
    }
    patchMusic({ models: uniq([...config.value.music.models, n]), model: n })
  }

  function removeModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const drop = (models: string[], current: string) => {
      const next = models.filter((m) => m !== name)
      if (!next.length) return null
      return { models: next, model: current === name ? next[0] : current }
    }
    if (kind === 'llm') {
      const next = drop(config.value.llm.models, config.value.llm.model)
      if (next) patchLlm(next)
      return
    }
    if (kind === 'vision') {
      const next = drop(config.value.vision.models, config.value.vision.model)
      if (next) patchVision(next)
      return
    }
    if (kind === 'image') {
      const current = config.value.image
      const next = drop(current.models, current.model)
      if (next) patchImage({
        models: next.models,
        model: current.model === name
          ? next.models.find((model) => !isManualImageChoice({ ...current, model })) || ''
          : current.model
      })
      return
    }
    if (kind === 'tts') {
      const next = drop(config.value.tts.models, config.value.tts.model)
      if (next) patchTts(next)
      return
    }
    const next = drop(config.value.music.models, config.value.music.model)
    if (next) patchMusic(next)
  }

  return {
    config,
    persistPath,
    diskReady,
    lastSavedAt,
    ensureHydrated,
    flush,
    update,
    patchLlm,
    addLlm,
    selectLlm,
    selectLlmModel,
    removeLlm,
    renameLlm,
    patchVision,
    addVision,
    selectVision,
    selectVisionModel,
    removeVision,
    renameVision,
    patchImage,
    addImage,
    selectImage,
    selectImageModel,
    removeImage,
    renameImage,
    patchTts,
    addTts,
    selectTts,
    selectTtsModel,
    removeTts,
    renameTts,
    patchVideo,
    setZealmanBaseUrl,
    setAutodlToken,
    addVideo,
    selectVideo,
    selectStorySkill,
    selectVideoModelDefault,
    removeVideo,
    renameVideo,
    patchMusic,
    addMusic,
    selectMusic,
    selectMusicModel,
    removeMusic,
    renameMusic,
    addModel,
    removeModel
  }
})
