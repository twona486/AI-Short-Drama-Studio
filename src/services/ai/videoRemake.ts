/**
 * 视频复刻：抽帧 → Qwen3.8-Max 理解镜头 → 写成剧本/分镜
 * 配音一律后期 TTS；合成视频不让 H3 出人声。
 */

import { callLLM, blobToChatImageUrl, getAIMode, type LLMContentPart } from './client'
import { getRemakeVisionModel, getVisionConfig } from './runtime'
import { normalizeStoryboard, storyboardToShots } from './storyboard'
import type { StoryboardResult } from './storyboard'
import type { VisualStyle } from '@/types'

export interface RemakeAnalysisShot {
  title: string
  start?: number
  duration?: number
  shotSize?: string
  cameraMovement?: string
  action?: string
  visualPrompt?: string
  videoPrompt?: string
  voiceover?: string
  audioDescription?: string
  purpose?: string
}

export interface RemakeAnalysis {
  topic: string
  aesthetic?: string
  summary?: string
  subjects?: Array<{ name: string; kind?: string; description?: string; role?: string }>
  scenes?: Array<{ name: string; description?: string; lighting?: string; mainAnchor?: string }>
  shots: RemakeAnalysisShot[]
  playMarkdown: string
  result: StoryboardResult
}

function parseJsonLoose(text: string): any {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('모델이 JSON을 반환하지 않았습니다.')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    const repaired = text
      .slice(start, end + 1)
      .replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(repaired)
  }
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  const t = Math.max(0, time)
  if (Math.abs(video.currentTime - t) < 0.05 && video.readyState >= 2) return
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      window.clearTimeout(timer)
      resolve()
    }
    const fail = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      window.clearTimeout(timer)
      reject(new Error('프레임 추출에 실패했습니다.'))
    }
    const timer = window.setTimeout(done, 2500)
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    video.currentTime = t
  })
}

export async function extractVideoFrames(
  blob: Blob,
  count = 10
): Promise<{ frames: Blob[]; duration: number }> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.style.cssText =
    'position:fixed;left:-9999px;width:4px;height:4px;opacity:0;pointer-events:none'
  document.body.appendChild(video)
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('업로드한 영상을 읽을 수 없습니다.'))
    })
    video.src = url
    await loaded
    try {
      await video.play()
      video.pause()
    } catch {
      /* 有的浏览器不允许自动播放，seek 仍然可用 */
    }
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('프레임을 추출할 수 없습니다.')
    const frames: Blob[] = []
    const n = Math.max(4, Math.min(12, count))
    for (let i = 0; i < n; i++) {
      const t = Math.min(duration - 0.08, Math.max(0, ((i + 0.5) / n) * duration))
      await seekVideo(video, t)
      canvas.width = video.videoWidth || 720
      canvas.height = video.videoHeight || 1280
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('프레임 인코딩에 실패했습니다.'))),
          'image/jpeg',
          0.82
        )
      })
      frames.push(frame)
    }
    return { frames, duration }
  } finally {
    video.remove()
    URL.revokeObjectURL(url)
  }
}

function playMarkdownFromRaw(raw: any): string {
  const topic = String(raw?.topic || '영상 재현').trim()
  const lines = [`# ${topic}`, '', '## 故事梗概', '', String(raw?.summary || raw?.aesthetic || topic), '']
  const subjects = Array.isArray(raw?.subjects) ? raw.subjects : []
  if (subjects.length) {
    lines.push('## 人物', '')
    for (const s of subjects) {
      lines.push(`### ${s?.name || '캐릭터'}`)
      lines.push('')
      lines.push(String(s?.description || '영상 전체에서 외모와 의상을 유지합니다.'))
      lines.push('')
    }
  }
  const scenes = Array.isArray(raw?.scenes) ? raw.scenes : []
  if (scenes.length) {
    lines.push('## 场景', '')
    for (const s of scenes) {
      lines.push(`### ${s?.name || '장면'}`)
      lines.push('')
      lines.push(String(s?.description || ''))
      lines.push('')
    }
  }
  const shots = Array.isArray(raw?.shots) ? raw.shots : []
  lines.push('## 分场', '')
  shots.forEach((s: any, i: number) => {
    lines.push(`### 第 ${i + 1} 场　${s?.title || `샷 ${i + 1}`}`)
    lines.push('')
    lines.push(`**口播**　${s?.voiceover?.trim() || '无'}`)
    lines.push('')
    lines.push(`**画面**　${s?.visualPrompt || s?.action || ''}`)
    lines.push('')
    lines.push(`**声音**　${s?.audioDescription || '환경음'}`)
    lines.push('')
    lines.push(`**时长**　约 ${Math.round(Number(s?.duration) || 5)} 秒`)
    lines.push('')
  })
  return lines.join('\n')
}

function mockRemakeRaw(topic: string): any {
  return {
    topic: topic || '제품 숏폼 영상 재현',
    summary: '참조 영상의 샷 리듬에 맞춰 상품 소개 영상을 재현하고 화면 속 상품을 사용자의 제품으로 바꿉니다.',
    aesthetic: '상업용 숏폼 영상. 제품 클로즈업을 선명하게 잡고 고른 조명을 사용합니다.',
    subjects: [
      {
        name: '화면에 등장하는 주인공',
        kind: 'person',
        description: '영상 내내 동일한 인물의 의상과 헤어스타일을 유지합니다.',
        role: '주인공'
      }
    ],
    scenes: [
      {
        name: '주요 장면',
        description: '참조 영상의 주요 촬영 환경',
        lighting: '자연광 또는 부드러운 상단 조명'
      }
    ],
    shots: [
      {
        title: '시선을 끄는 시작',
        duration: 5,
        shotSize: '근경',
        cameraMovement: 'push',
        visualPrompt: '产品被拿到镜头前，包装与 logo 必须与用户产品图完全一致。',
        videoPrompt: '主角把用户产品拿到镜头前，包装和 logo 始终清晰，说完开场那句。',
        voiceover: '아직도 평범한 제품을 쓰세요?',
        audioDescription: '옷감이 스치는 소리와 약한 배경음',
        purpose: '钩子'
      },
      {
        title: '기능 시연',
        duration: 6,
        shotSize: '중경',
        cameraMovement: 'static',
        visualPrompt: '主角使用用户产品，动作清楚，背景简洁。',
        videoPrompt: '主角使用用户产品，动作清楚，把这一步做完并说完功能那句。',
        voiceover: '이 단계가 핵심이에요.',
        audioDescription: '제품을 조작하는 소리와 배경음',
        purpose: '说明'
      },
      {
        title: '마무리 클로즈업',
        duration: 5,
        shotSize: '클로즈업',
        cameraMovement: 'push',
        visualPrompt: '用户产品包装特写，logo 清晰。',
        videoPrompt: '镜头推到用户产品包装特写，logo 清楚，说完收口那句。',
        voiceover: '이 제품으로 바꿔 보세요.',
        audioDescription: '테이블 위에 가볍게 내려놓는 소리',
        purpose: '收口'
      }
    ]
  }
}

export async function analyzeRemakeVideo(
  input: {
    videoBlob: Blob
    topic?: string
    aspectRatio: string
    style: VisualStyle
    productCount: number
    signal?: AbortSignal
    onProgress?: (msg: string) => void
  }
): Promise<RemakeAnalysis> {
  const topic = input.topic?.trim() || '영상 재현'
  input.onProgress?.('참조 영상에서 키프레임을 추출하는 중…')
  const { frames, duration } = await extractVideoFrames(input.videoBlob, 10)

  let raw: any
  if (getAIMode() !== 'real') {
    input.onProgress?.('데모 모드에서 참조 영상의 리듬에 맞춰 대본을 작성하는 중…')
    raw = mockRemakeRaw(topic)
  } else {
    input.onProgress?.(`영상의 샷을 분석하는 중(${frames.length}프레임)…`)
    const parts: LLMContentPart[] = [
      {
        type: 'text',
        text: `당신은 짧은 영상의 스토리보드 감독입니다. 참조 영상의 키프레임을 시간 순서로 제공합니다. 전체 길이는 약 ${duration.toFixed(1)}초, 화면 비율은 ${input.aspectRatio}입니다.
내용, 샷마다 화면 크기·카메라 움직임·동작, 들리는 내레이션, 현장 환경음, 출연 캐릭터와 장면을 파악하세요.
그다음 재현할 수 있는 스토리보드 대본을 쓰세요. 상품 외형에 원본 영상의 브랜드를 복사하지 마세요. 나중에 사용자가 업로드한 제품 이미지 ${input.productCount}장으로 바꾸므로 모델용 프롬프트에는 「用户产品」으로만 쓰세요.

Write titles and user-facing descriptions in Korean (한국어). Write image and video generation direction in English. Preserve verbatim narration from the reference and any requested Korean on-screen text. Return JSON only.
{
  "topic": "<짧은 제목>",
  "summary": "<한두 문단의 줄거리>",
  "aesthetic": "<영상 전체의 화면 분위기>",
  "subjects": [{ "name": "", "kind": "person|animal|other", "description": "", "role": "" }],
  "scenes": [{ "name": "", "description": "", "lighting": "", "mainAnchor": "" }],
  "shots": [{
    "title": "<3-8자>",
    "duration": 5,
    "shotSize": "",
    "cameraMovement": "push|pull|pan|tilt|static|orbit",
    "purpose": "钩子|说明|反应|揭示|收口",
    "visualPrompt": "<Filmable English description using the user's product>",
    "videoPrompt": "<English direction with character expressions, action, environmental reactions, original dialogue, and camera motion. Do not repeat visualPrompt.>",
    "voiceover": "<이 샷에서 들리는 내레이션 원문. 없으면 빈 문자열>",
    "audioDescription": "<환경음을 짧은 문장으로 묘사>",
    "audioMode": "tts"
  }]
}
내레이션은 샷에 맞춰 나누고 원본에 없는 효능이나 약속을 만들지 마세요. 샷마다 duration은 5–10초의 정수로 쓰세요. 모든 더빙은 후반 작업에서 합성하므로 audioMode는 tts로, 내레이션이 없으면 none으로 지정하세요. 영상 생성에는 사람 음성을 넣지 마세요.`
      }
    ]
    for (let i = 0; i < frames.length; i++) {
      parts.push({
        type: 'image_url',
        image_url: { url: await blobToChatImageUrl(frames[i], 960, 0.78) }
      })
    }
    const primary = getRemakeVisionModel()
    const fallback = getVisionConfig().model
    const models = fallback && fallback !== primary ? [primary, fallback] : [primary]
    let lastErr: unknown
    let respContent = ''
    for (const model of models) {
      try {
        input.onProgress?.('샷을 분석하는 중…')
        const resp = await callLLM({
          provider: 'vision',
          model,
          messages: [
            {
              role: 'system',
              content: 'Return valid JSON only. Analyze the shot language and produce a filmable storyboard. Write descriptions for the user in Korean (한국어), generation prompts in English, and leave all dubbing to postproduction TTS.'
            },
            { role: 'user', content: parts }
          ],
          jsonMode: true,
          temperature: 0.2,
          maxTokens: 8192,
          timeoutMs: 180_000,
          signal: input.signal
        })
        respContent = resp.content
        lastErr = null
        break
      } catch (e: any) {
        lastErr = e
        const msg = String(e?.message || e)
        const canFallback =
          model !== models[models.length - 1] &&
          /does not support.*image|image.*not supported|Unexpected item type in content|不支持图片/i.test(
            msg
          )
        if (!canFallback) throw e
        input.onProgress?.('현재 모델이 이미지를 지원하지 않아 다른 모델을 사용하는 중…')
      }
    }
    if (lastErr) throw lastErr
    raw = parseJsonLoose(respContent)
  }

  if (!Array.isArray(raw?.shots) || !raw.shots.length) {
    throw new Error('영상 분석 결과에 스토리보드가 없습니다.')
  }
  raw.topic = String(raw.topic || topic).trim() || topic
  for (const s of raw.shots) {
    s.audioMode = String(s?.voiceover || '').trim() ? 'tts' : 'none'
  }
  const result = normalizeStoryboard(raw, {
    style: input.style,
    topic: raw.topic,
    content: String(raw.summary || '')
  })
  for (const shot of result.shots) {
    shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
  }
  const playMarkdown = playMarkdownFromRaw(raw)
  return {
    topic: raw.topic,
    aesthetic: raw.aesthetic,
    summary: raw.summary,
    subjects: raw.subjects,
    scenes: raw.scenes,
    shots: raw.shots,
    playMarkdown,
    result
  }
}

export function remakeShotsFromAnalysis(analysis: RemakeAnalysis) {
  const shots = storyboardToShots(analysis.result)
  for (const shot of shots) {
    shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
  }
  return shots
}
