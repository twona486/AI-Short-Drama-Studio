/**
 * 공식 공급자만 기본 제공한다. 중계 및 통합 서비스는 사용자 지정 연결을 사용한다.
 * 언어 및 비전 모델은 OpenAI 호환 /chat/completions 경로를 사용한다.
 */

import { t } from '@/i18n'
import { OPENAI_BASE_URL, OPENAI_CHAT_MODELS, OPENAI_DEFAULT_CHAT_MODEL } from './openAiChat'
import { OPENAI_DEFAULT_IMAGE_MODEL, OPENAI_IMAGE_MODELS } from './openAiImage'
import { LTX_DESKTOP_PROVIDER, LTX_DESKTOP_MODELS, LTX_DESKTOP_WORKFLOW } from './ltxDesktopOptions'
import { LTX_BASE_URL, LTX_DEFAULT_MODEL, LTX_MODELS } from './ltxOptions'
import { isApimartHost } from './adapters'
import { DRAW_THINGS_MODELS, DRAW_THINGS_PROVIDER, DRAW_THINGS_URL } from './drawThingsOptions'

export interface ProviderPreset {
  id: string
  name: string
  hint: string
  baseUrl: string
  models: string[]
  defaultModel: string
  keyPlaceholder?: string
  showModelSuggestions?: boolean
  noApiKey?: boolean
  includeModelsByDefault?: boolean
}

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

export const CUSTOM_PROVIDER: ProviderPreset = {
  id: 'custom',
  get name() { return t('provider.name.custom') },
    get hint() { return t('provider.hint.custom') },
  baseUrl: '',
  models: [],
  defaultModel: '',
  get keyPlaceholder() { return t('provider.keyPlaceholder') }
}

export const LLM_PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    get hint() { return t('provider.hint.openAi') },
    baseUrl: OPENAI_BASE_URL,
    models: OPENAI_CHAT_MODELS,
    defaultModel: OPENAI_DEFAULT_CHAT_MODEL
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    get hint() { return t('provider.hint.deepSeek') },
    showModelSuggestions: false,
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-v4-flash'
  },
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.qwen') },
    showModelSuggestions: false,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'],
    defaultModel: 'qwen-plus'
  },
  {
    id: 'volcengine',
    get name() { return t('provider.name.volcengine') },
    get hint() { return t('provider.hint.doubao') },
    showModelSuggestions: false,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k'],
    defaultModel: 'doubao-1-5-pro-32k'
  },
  {
    id: 'moonshot',
    get name() { return t('provider.name.moonshot') },
    get hint() { return t('provider.hint.kimi') },
    showModelSuggestions: false,
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-turbo-preview', 'moonshot-v1-auto', 'moonshot-v1-128k'],
    defaultModel: 'kimi-k2-turbo-preview'
  },
  {
    id: 'zhipu',
    get name() { return t('provider.name.zhipu') },
    get hint() { return t('provider.hint.glm') },
    showModelSuggestions: false,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4-flash'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    get hint() { return t('provider.hint.miniMax') },
    showModelSuggestions: false,
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-Text-01', 'MiniMax-M1'],
    defaultModel: 'MiniMax-Text-01'
  },
  CUSTOM_PROVIDER
]

export const VISION_PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    get hint() { return t('provider.hint.openAiVision') },
    baseUrl: OPENAI_BASE_URL,
    models: OPENAI_CHAT_MODELS,
    defaultModel: OPENAI_DEFAULT_CHAT_MODEL
  },
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.qwenVision') },
    showModelSuggestions: false,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-vl-max', 'qwen-vl-plus', 'qwen3-vl-plus'],
    defaultModel: 'qwen-vl-max'
  },
  {
    id: 'volcengine',
    get name() { return t('provider.name.volcengine') },
    get hint() { return t('provider.hint.doubaoVision') },
    showModelSuggestions: false,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-1-5-vision-pro-32k', 'doubao-seed-1-6-vision-250815'],
    defaultModel: 'doubao-1-5-vision-pro-32k'
  },
  {
    id: 'zhipu',
    get name() { return t('provider.name.zhipu') },
    get hint() { return t('provider.hint.glmVision') },
    showModelSuggestions: false,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5v', 'glm-4v-plus'],
    defaultModel: 'glm-4v-plus'
  },
  CUSTOM_PROVIDER
]

export const IMAGE_PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    get hint() { return t('provider.hint.openAiImage') },
    baseUrl: OPENAI_BASE_URL,
    models: OPENAI_IMAGE_MODELS,
    defaultModel: OPENAI_DEFAULT_IMAGE_MODEL
  },
  {
    id: DRAW_THINGS_PROVIDER,
    get name() { return t('drawThings.name') },
    get hint() { return t('drawThings.setup') },
    baseUrl: DRAW_THINGS_URL,
    models: DRAW_THINGS_MODELS,
    defaultModel: DRAW_THINGS_MODELS[0],
    noApiKey: true,
    includeModelsByDefault: true
  },
  {
    id: 'volcengine',
    get name() { return t('provider.name.volcengine') },
    get hint() { return t('provider.hint.seedream') },
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    showModelSuggestions: false,
    models: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'],
    defaultModel: ''
  },
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.qwenImage') },
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    showModelSuggestions: false,
    models: ['qwen-image-plus', 'wan2.5-t2i-preview'],
    defaultModel: ''
  },
  {
    id: 'zhipu',
    get name() { return t('provider.name.zhipu') },
    get hint() { return t('provider.hint.cogview') },
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    showModelSuggestions: false,
    models: ['cogview-4', 'cogview-3-flash'],
    defaultModel: ''
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    get hint() { return t('provider.hint.miniMaxImage') },
    baseUrl: 'https://api.minimaxi.com/v1',
    showModelSuggestions: false,
    models: ['image-01'],
    defaultModel: ''
  },
  {
    id: 'apimart',
    name: 'APIMart',
    get hint() { return t('provider.hint.apimartImage') },
    baseUrl: 'https://api.aishuch.com',
    showModelSuggestions: false,
    models: ['gpt-image-2', 'gpt-image-2-ext', 'seedream-4.5'],
    defaultModel: '',
    keyPlaceholder: 'APIMart API Key'
  },
  CUSTOM_PROVIDER
]

export const TTS_PROVIDERS: ProviderPreset[] = [
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.dashScopeTts') },
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['qwen-audio-3.0-tts-flash', 'qwen3-tts-flash'],
    defaultModel: 'qwen-audio-3.0-tts-flash'
  },
  CUSTOM_PROVIDER
]

export const MUSIC_PROVIDERS: ProviderPreset[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    get hint() { return t('provider.hint.miniMaxMusic') },
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['music-3.0'],
    defaultModel: 'music-3.0'
  },
  CUSTOM_PROVIDER
]

export const VIDEO_PROVIDERS: ProviderPreset[] = [
  {
    id: LTX_DESKTOP_PROVIDER,
    get name() { return t('ltxDesktop.name') },
    get hint() { return t('ltxDesktop.hint') },
    baseUrl: '',
    models: LTX_DESKTOP_MODELS,
    defaultModel: LTX_DESKTOP_WORKFLOW
  },
  {
    id: 'ltx',
    get name() { return t('ltx.cloudName') },
    get hint() { return t('ltx.hint') },
    baseUrl: LTX_BASE_URL,
    models: LTX_MODELS,
    defaultModel: LTX_DEFAULT_MODEL,
    keyPlaceholder: 'LTX API Key'
  },
  {
    id: 'autodl',
    get name() { return t('provider.name.autodl') },
    get hint() { return t('provider.hint.autoDlVideo') },
    baseUrl: 'https://autodl.art',
    models: ['minimax_h3_lightx2v_v5_15s', 'minimax_h3_lightx2v_v5', 'minimax_h3_zm_u24'],
    defaultModel: 'minimax_h3_lightx2v_v5_15s',
    keyPlaceholder: 'AutoDL Token'
  },
  {
    id: 'dashscope',
    showModelSuggestions: false,
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.dashScopeVideo') },
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['wan2.6-t2v', 'wan2.5-t2v-preview'],
    defaultModel: 'wan2.6-t2v'
  },
  {
    id: 'apimart',
    name: 'APIMart',
    get hint() { return t('provider.hint.apimartVideo') },
    baseUrl: 'https://api.aishuch.com',
    models: ['grok-imagine-1.5-video-ext'],
    defaultModel: 'grok-imagine-1.5-video-ext',
    keyPlaceholder: 'APIMart API Key'
  },
  CUSTOM_PROVIDER
]

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase()
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase()
  }
}

export function matchProviderId(baseUrl: string, presets: ProviderPreset[]): string {
  const host = hostOf(baseUrl)
  if (!host) return 'custom'
  const found = presets.find((p) => p.id !== 'custom' && p.baseUrl && hostOf(p.baseUrl) === host)
  return found?.id || 'custom'
}

export function findProvider(id: string, presets: ProviderPreset[]): ProviderPreset {
  return presets.find((p) => p.id === id) || CUSTOM_PROVIDER
}

export function isManualImageChoice(endpoint: { provider?: string; baseUrl: string; model: string }) {
  const matched = matchProviderId(endpoint.baseUrl, IMAGE_PROVIDERS)
  return isApimartHost(endpoint.baseUrl) || IMAGE_PROVIDERS.some((preset) =>
    preset.showModelSuggestions === false &&
    (preset.id === endpoint.provider || preset.id === matched)
  ) || /^(doubao-seedream|seedream|qwen-image|cogview|wan[\d.]*-.*(?:t2i|i2i)|image-01)/i.test(endpoint.model)
}

export function suggestedPresetModels(preset: ProviderPreset, configured: string[]): string[] {
  if (preset.showModelSuggestions === false) return []
  return preset.models.filter((model) => model && !configured.includes(model))
}

export function applyProviderPreset(
  current: { baseUrl: string; model: string; models: string[] },
  preset: ProviderPreset
): { provider: string; baseUrl: string; model: string; models: string[]; apiKey?: string } {
  const keepUrl = preset.id === 'custom'
  const model = (keepUrl ? current.model : current.model || preset.defaultModel).trim()
  // 프리셋은 제안 목록이다. 설정 모델 이름은 현재 연결과 호출자가 지정한 값에서만 가져온다.
  const models = uniq([model, ...current.models, ...(preset.includeModelsByDefault ? preset.models : [])])
  return {
    provider: preset.id,
    ...(preset.noApiKey ? { apiKey: '' } : {}),
    baseUrl: keepUrl ? current.baseUrl : preset.baseUrl || current.baseUrl,
    model,
    models
  }
}
