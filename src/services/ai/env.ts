/** 개발 기본값은 Vite .env에서 읽으며 설치 빌드에는 포함하지 않는다. */

function envStr(key: string, fallback = ''): string {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  const s = typeof v === 'string' ? v.trim() : ''
  return s || fallback
}

export const VIDEO_AUTODL_ROOT = 'https://autodl.art'
export const VIDEO_DEFAULT_WORKFLOW_ID = 'minimax_h3_lightx2v_v5_15s'
/** 1080p를 선택할 수 있는 H3 v5 10초 워크플로 */
export const VIDEO_H3_V5_10S_WORKFLOW_ID = 'minimax_h3_lightx2v_v5'
/** H3 시작·끝 프레임 워크플로 */
export const VIDEO_FL2VA_WORKFLOW_ID = 'minimax_h3_b99_002'
/** 디지털 휴먼의 이미지와 음성 립싱크 */
export const VIDEO_DIGITAL_HUMAN_WORKFLOW_ID = 'minimax_h3_image_audio_to_video'
/** H3의 다중 이미지와 오디오 참조, 화질 개선 옵션 */
export const VIDEO_H3_MULTI_AUDIO_WORKFLOW_ID = 'minimax_h3_zm_u24'

export function isLegacyVideoConfig(value: string): boolean {
  return /seetacloud|:8443|\/api\/workflow|U09-API|U06-API|9图版|light2v-1|lightx2v_no_pic/i.test(value)
}

export function migrateVideoBaseUrl(url: string): string {
  const raw = (url || '').trim().replace(/\/+$/, '')
  if (!raw || isLegacyVideoConfig(raw) || /minimaxi\.com/i.test(raw)) return VIDEO_AUTODL_ROOT
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    u.pathname = u.pathname.replace(/\/api\/v1(?:\/comfyui)?\/?$/i, '') || '/'
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host}${path === '/' ? '' : path}`
  } catch {
    return raw.replace(/\/api\/v1(?:\/comfyui)?$/i, '') || VIDEO_AUTODL_ROOT
  }
}

export function migrateVideoWorkflowId(id: string): string {
  const raw = (id || '').trim()
  if (!raw || isLegacyVideoConfig(raw)) return VIDEO_DEFAULT_WORKFLOW_ID
  if (
    raw === 'minimax_h3_image_audio_to_video_v2_15s' ||
    raw === 'MiniMax-Hailuo-2.3'
  ) {
    return VIDEO_DEFAULT_WORKFLOW_ID
  }
  return raw
}

export function envRealMode(): boolean {
  const flag = envStr('VITE_AI_REAL_MODE', 'false').toLowerCase()
  return flag === 'true' || flag === '1'
}

export function envDefaults() {
  return {
    realMode: envRealMode(),
    llm: {
      baseUrl: envStr('VITE_LLM_BASE_URL', 'https://api.deepseek.com'),
      apiKey: envStr('VITE_LLM_API_KEY'),
      model: envStr('VITE_LLM_MODEL', 'deepseek-v4-flash')
    },
    vision: {
      baseUrl: envStr(
        'VITE_VISION_BASE_URL',
        envStr('VITE_IMAGE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1')
      ),
      apiKey: envStr('VITE_VISION_API_KEY') || envStr('VITE_IMAGE_API_KEY'),
      model: envStr('VITE_VISION_MODEL', 'qwen-vl-max')
    },
    remakeVisionModel: envStr('VITE_REMAKE_VISION_MODEL', 'qwen-vl-max'),
    remakeImageModel: envStr('VITE_REMAKE_IMAGE_MODEL', 'gpt-image-1'),
    image: {
      baseUrl: envStr('VITE_IMAGE_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3'),
      apiKey: envStr('VITE_IMAGE_API_KEY'),
      model: envStr('VITE_IMAGE_MODEL', 'doubao-seedream-4-0-250828')
    },
    tts: {
      baseUrl: envStr('VITE_TTS_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
      apiKey: envStr('VITE_TTS_API_KEY'),
      model: envStr('VITE_TTS_MODEL', 'qwen-audio-3.0-tts-flash'),
      voice: envStr('VITE_TTS_VOICE', 'longanhuan_v3.6')
    },
    video: {
      baseUrl: migrateVideoBaseUrl(envStr('VITE_VIDEO_BASE_URL', VIDEO_AUTODL_ROOT)),
      apiKey: envStr('VITE_VIDEO_API_KEY'),
      workflowId: migrateVideoWorkflowId(envStr('VITE_VIDEO_WORKFLOW_ID', 'MiniMax-Hailuo-2.3'))
    },
    music: {
      baseUrl: envStr('VITE_MUSIC_BASE_URL', 'https://api.minimaxi.com/v1'),
      apiKey: envStr('VITE_MUSIC_API_KEY'),
      model: envStr('VITE_MUSIC_MODEL', 'music-3.0')
    }
  }
}
