/**
 * 공식 공급자만 기본 제공한다. 중계 및 통합 서비스는 사용자 지정 연결을 사용한다.
 * 언어 및 비전 모델은 OpenAI 호환 /chat/completions 경로를 사용한다.
 */

import { t } from '@/i18n'

export interface ProviderPreset {
  id: string
  name: string
  hint: string
  baseUrl: string
  models: string[]
  defaultModel: string
  keyPlaceholder?: string
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
    id: 'deepseek',
    name: 'DeepSeek',
    get hint() { return t('provider.hint.deepSeek') },
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-v4-flash'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    get hint() { return t('provider.hint.openAi') },
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini'
  },
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.qwen') },
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'],
    defaultModel: 'qwen-plus'
  },
  {
    id: 'volcengine',
    get name() { return t('provider.name.volcengine') },
    get hint() { return t('provider.hint.doubao') },
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k'],
    defaultModel: 'doubao-1-5-pro-32k'
  },
  {
    id: 'moonshot',
    get name() { return t('provider.name.moonshot') },
    get hint() { return t('provider.hint.kimi') },
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-turbo-preview', 'moonshot-v1-auto', 'moonshot-v1-128k'],
    defaultModel: 'kimi-k2-turbo-preview'
  },
  {
    id: 'zhipu',
    get name() { return t('provider.name.zhipu') },
    get hint() { return t('provider.hint.glm') },
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4-flash'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    get hint() { return t('provider.hint.miniMax') },
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-Text-01', 'MiniMax-M1'],
    defaultModel: 'MiniMax-Text-01'
  },
  CUSTOM_PROVIDER
]

export const VISION_PROVIDERS: ProviderPreset[] = [
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.qwenVision') },
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-vl-max', 'qwen-vl-plus', 'qwen3-vl-plus'],
    defaultModel: 'qwen-vl-max'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    get hint() { return t('provider.hint.openAiVision') },
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4.1'],
    defaultModel: 'gpt-4o'
  },
  {
    id: 'volcengine',
    get name() { return t('provider.name.volcengine') },
    get hint() { return t('provider.hint.doubaoVision') },
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-1-5-vision-pro-32k', 'doubao-seed-1-6-vision-250815'],
    defaultModel: 'doubao-1-5-vision-pro-32k'
  },
  {
    id: 'zhipu',
    get name() { return t('provider.name.zhipu') },
    get hint() { return t('provider.hint.glmVision') },
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5v', 'glm-4v-plus'],
    defaultModel: 'glm-4v-plus'
  },
  CUSTOM_PROVIDER
]

export const IMAGE_PROVIDERS: ProviderPreset[] = [
  {
    id: 'volcengine',
    get name() { return t('provider.name.volcengine') },
    get hint() { return t('provider.hint.seedream') },
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'],
    defaultModel: 'doubao-seedream-4-0-250828'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    get hint() { return t('provider.hint.openAiImage') },
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-image-1', 'dall-e-3'],
    defaultModel: 'gpt-image-1'
  },
  {
    id: 'dashscope',
    get name() { return t('provider.name.dashscope') },
    get hint() { return t('provider.hint.qwenImage') },
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-image-plus', 'wan2.5-t2i-preview'],
    defaultModel: 'qwen-image-plus'
  },
  {
    id: 'zhipu',
    get name() { return t('provider.name.zhipu') },
    get hint() { return t('provider.hint.cogview') },
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['cogview-4', 'cogview-3-flash'],
    defaultModel: 'cogview-4'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    get hint() { return t('provider.hint.miniMaxImage') },
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['image-01'],
    defaultModel: 'image-01'
  },
  {
    id: 'apimart',
    name: 'APIMart',
    get hint() { return t('provider.hint.apimartImage') },
    baseUrl: 'https://api.aishuch.com',
    models: ['gpt-image-2', 'gpt-image-2-ext', 'seedream-4.5'],
    defaultModel: 'gpt-image-2',
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
    id: 'autodl',
    get name() { return t('provider.name.autodl') },
    get hint() { return t('provider.hint.autoDlVideo') },
    baseUrl: 'https://autodl.art',
    models: ['minimax_h3_lightx2v_v5_15s', 'minimax_h3_lightx2v_v5'],
    defaultModel: 'minimax_h3_lightx2v_v5_15s',
    keyPlaceholder: 'AutoDL Token'
  },
  {
    id: 'dashscope',
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

export function applyProviderPreset(
  current: { baseUrl: string; model: string; models: string[] },
  preset: ProviderPreset
): { provider: string; baseUrl: string; model: string; models: string[] } {
  const keepUrl = preset.id === 'custom'
  const model = (keepUrl ? current.model : current.model || preset.defaultModel).trim()
  // 프리셋은 제안 목록이다. 설정 모델 이름은 현재 연결과 호출자가 지정한 값에서만 가져온다.
  const models = uniq([...(model ? [model] : []), ...current.models])
  return {
    provider: preset.id,
    baseUrl: keepUrl ? current.baseUrl : preset.baseUrl || current.baseUrl,
    model,
    models
  }
}
