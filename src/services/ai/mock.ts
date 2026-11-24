/**
 * API 키 없이 전체 과정을 실행하는 데모 구현
 *
 * 이미지는 Canvas에 그리며 프롬프트에 따라 색상과 모양을 바꾼다.
 * 영상은 MediaRecorder로 Canvas를 녹화해 짧은 애니메이션을 만든다.
 * 언어 모델 대신 키워드 규칙으로 데모 스토리보드를 만든다.
 */

import type { LLMRequest, LLMResponse } from './client'
import { messageText } from './client'
import type { Shot, VisualStyle } from '@/types'

/** 동일한 입력에 동일한 값을 반환하는 해시 함수 */
function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

/** 텍스트에서 재현 가능한 의사 난수 색상을 생성한다. */
function colorFromText(s: string, sat = 70, light = 55): string {
  const h = hashCode(s) % 360
  return `hsl(${h}, ${sat}%, ${light}%)`
}

/** 스타일별 CSS 필터 */
export function styleToFilter(style: VisualStyle): string {
  switch (style) {
    case 'cinematic':
      return 'contrast(1.15) saturate(1.05) brightness(0.92) hue-rotate(-5deg)'
    case 'anime':
      return 'saturate(1.4) contrast(1.1) brightness(1.05)'
    case 'oil-painting':
      return 'saturate(1.2) contrast(0.95) blur(0.4px)'
    case '3d-render':
      return 'saturate(1.15) contrast(1.08) brightness(1.02)'
    case 'photorealistic':
      return 'contrast(1.05) saturate(1.1)'
    case 'watercolor':
      return 'saturate(0.9) contrast(0.95) brightness(1.05) blur(0.2px)'
    case 'pixel-art':
      return 'contrast(1.3) saturate(1.3)'
    case 'ink-wash':
      return 'grayscale(0.5) contrast(1.2) brightness(0.95)'
    default:
      return 'none'
  }
}

// ============== LLM mock ==============

export async function mockLLM(req: LLMRequest): Promise<LLMResponse> {
  // 네트워크 지연을 재현한다.
  await new Promise((r) => setTimeout(r, 600 + Math.random() * 800))

  const userMsg = messageText(req.messages[req.messages.length - 1]?.content ?? '')
  const isStoryboard = /分镜|스토리보드|storyboard/i.test(userMsg)

  if (isStoryboard) {
    return {
      content: JSON.stringify(mockStoryboardFromPrompt(userMsg)),
      model: 'mock-llm'
    }
  }

  return {
    content: `[데모] 요청을 받았습니다. ${userMsg.slice(0, 60)}...`,
    model: 'mock-llm'
  }
}

/** 프롬프트의 원고와 키워드로 데모 스토리보드를 만든다. */
export function mockStoryboardFromPrompt(userMsg: string) {
  // 원고를 추출한다. 일반적으로 """ 사이에 있다.
  const match = userMsg.match(/"""\s*([\s\S]*?)\s*"""/)
  const script = match?.[1]?.trim() || userMsg.slice(0, 200)

  // 문장 단위로 나눈다.
  const sentences = script
    .split(/[。！？!?\n]+|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4)

  const styleMatch = userMsg.match(/style:\s*(\w[\w-]*)/i)
  const style = (styleMatch?.[1] as VisualStyle) || 'cinematic'
  const durationMatch = userMsg.match(/duration:\s*(\d+(?:\.\d+)?)/i)
  const duration = durationMatch ? Number(durationMatch[1]) : 3

  // 키워드별 화면 묘사
  const keywords: Record<string, string> = {
    '城市|도시|city': 'Modern skyline, neon lighting, and city architecture',
    '山|산봉우리|mountain': 'Dramatic mountain peaks under mist and clouds',
    '海|바다|ocean': 'Waves on the shore at a golden sunset',
    '森林|숲|forest': 'Dense forest with sun filtering through the trees',
    '人物|인물|character': 'Character portrait with an expressive gaze and soft light',
    '科技|기술|technology': 'Futuristic technology and holographic interfaces',
    '产品|제품|product': 'Product close-up with clean studio light and simple framing',
    '食物|음식|food': 'Food close-up with steam and warm light',
    '旅行|여행|travel': 'Evocative travel destination in golden-hour light',
    '运动|운동|sports': 'Energetic athletic movement with slight motion blur',
    '动物|동물|animal': 'Sharp close-up of an animal in its habitat',
    '花卉|꽃|flowers': 'Colorful macro flowers with a blurred background'
  }
  const sizes = ['전경', '중경', '근경', '클로즈업'] as const

  const shots: Array<Omit<Shot, 'id' | 'status'>> = sentences
    .slice(0, 12)
    .map((s, i) => {
      // 문장의 키워드에 맞는 화면 묘사를 고른다.
      let visual = ''
      for (const [k, v] of Object.entries(keywords)) {
        if (k.split('|').some((keyword) => s.toLowerCase().includes(keyword))) {
          visual = v
          break
        }
      }
      if (!visual) {
        // 일치하는 키워드가 없으면 해시로 묘사를 고른다.
        const opts = [
          'Establishing shot with dramatic light',
          'Close-up with shallow focus and soft background',
          'Wide landscape during golden hour',
          'Dynamic, energetic movement',
          'Minimal framing with ample negative space'
        ]
        visual = opts[hashCode(s) % opts.length]
      }

      const purposes = ['상황 설정', '진행', '반응', '공개'] as const
      const styleGuide =
        style === 'anime'
          ? 'Japanese cel animation with clear lines and bright eye highlights'
          : style === 'ink-wash'
            ? 'Chinese ink wash with layered tones and negative space'
            : style === '3d-render'
              ? '3D rendering with PBR surfaces and global illumination'
              : style === 'oil-painting'
                ? 'Classical oil impasto and canvas texture'
                : style === 'watercolor'
                  ? 'Watercolor washes with transparent layers and paper grain'
                  : style === 'pixel-art'
                    ? 'Retro pixel art with a limited palette and sharp grid'
                    : style === 'photorealistic'
                      ? 'Realistic photography with natural light and believable materials'
                      : 'Film color grading and dramatic contrast'
      return {
        index: i,
        title: s.slice(0, 8),
        visualPrompt: `[${styleGuide}] ${visual}. Story context: ${s}. Show readable depth, materials, pose, expression, and coherent action. Use the ${['wide shot', 'medium shot', 'close shot', 'close-up'][i % sizes.length]} and let the camera serve the story. Match light and color to the tone. High detail and production-quality finish.`,
        videoPrompt: `Show the action described in the source: ${s}. Someone says 「${s}」. The camera follows the action.`,
        audioDescription: '환경음과 잔잔한 배경음악',
        voiceover: s,
        duration: Math.min(
          10,
          Math.max(5, Math.round(duration + (s.replace(/\s+/g, '').length / 20) + (i % 3) - 1))
        ),
        cameraMovement: (['push', 'pull', 'pan', 'static'] as const)[
          i % 4
        ],
        purpose: purposes[i % purposes.length],
        shotSize: sizes[i % sizes.length],
        blocking: '장면의 주요 기준물 가까이 서서 이야기의 초점을 향한다.',
        eyeline: '현재 샷의 이야기 중심을 본다.',
        continuity: `이전 샷의 끝 상태 → 현재 샷의 변화: ${s.slice(0, 12)} → 다음 샷으로 이어지는 상태`,
        propFocus: '주요 소품의 상태를 유지한다.'
      }
    })

  if (shots.length === 0) {
    // 원고가 없으면 기본 샷 네 개를 반환한다.
    return {
      aesthetic: `전체 분위기\n\n${style} 스타일. 영화적 구도와 극적인 명암을 사용한다.`,
      styleBrief: `리듬과 시각적 인상을 강조한 ${style} 단편`,
      colorPalette: '따뜻한 주조색과 차가운 보조색의 대비',
      lightingNote: '영화적 측광으로 밝은 부분과 그림자가 또렷하다.',
      shots: [1, 2, 3, 4].map((i) => ({
        index: i - 1,
        title: `샷 ${i}`,
        visualPrompt: `Abstract ${style} location with warm light and cinematic atmosphere. Shot ${i}.`,
        videoPrompt: `For shot ${i}, follow the people through the complete action and spoken lines.`,
        audioDescription: '환경음과 배경음악',
        voiceover: ['지우: 마당에 비가 내리기 시작했어요.', '지우: 창문을 닫아 줄래요?', '지우: 잠깐만요. 우산부터 가져올게요.', '지우: 좋아요. 여기서 기다릴게요.'][i - 1],
        duration: Math.min(10, Math.max(5, duration + ((i - 1) % 3))),
        cameraMovement: 'static' as const,
        subjectIds: ['sub_1'],
        sceneId: 'scn_1',
        purpose: i === 1 ? '상황 설정' : i === 4 ? '공개' : '진행',
        shotSize: sizes[(i - 1) % sizes.length],
        blocking: '주요 기준물을 기준으로 서서 이야기의 중심을 향한다.',
        eyeline: '이야기의 중심을 본다.',
        continuity: `앞 샷과 연결 → 현재 샷의 변화 → 다음 샷으로 이어지는 상태`,
        propFocus: '주요 소품의 상태를 유지한다.'
      })),
      subjects: [
        {
          id: 'sub_1',
          name: '지우',
          kind: 'person' as const,
          description: '전체 영상에서 주인공의 얼굴, 헤어스타일과 의상을 유지한다.',
          role: '주인공',
          stateVariants: 'none'
        }
      ],
      scenes: [
        {
          id: 'scn_1',
          name: '주요 장면',
          description: '전체 영상에서 주 장면과 조명을 유지한다.',
          mainAnchor: '장면의 주요 시각 기준물',
          lighting: '영화적 측광'
        }
      ]
    }
  }

  return { shots }
}

// ============== 이미지 데모 ==============

/**
 * 코드로 이미지 자리표시자(PNG Blob)를 생성한다.
 * 프롬프트에 따라 색상, 모양, 필터를 선택해 Canvas에 그린다.
 */
export async function generateMockImage(
  prompt: string,
  width: number,
  height: number,
  style: VisualStyle
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const filter = styleToFilter(style)

  // 화면 밖 캔버스에 그린다.
  const off = document.createElement('canvas')
  off.width = width
  off.height = height
  const offCtx = off.getContext('2d')!

  // 배경 그라디언트
  const seed = hashCode(prompt)
  const c1 = colorFromText(prompt + 'bg', 70, 40)
  const c2 = colorFromText(prompt + 'fg', 80, 65)
  const grad = offCtx.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, c1)
  grad.addColorStop(1, c2)
  offCtx.fillStyle = grad
  offCtx.fillRect(0, 0, width, height)

  // 임의의 도형
  const rng = mulberry32(seed)
  for (let i = 0; i < 6; i++) {
    const x = rng() * width
    const y = rng() * height
    const r = 50 + rng() * 200
    const g = offCtx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, colorFromText(prompt + i, 90, 70))
    g.addColorStop(1, 'transparent')
    offCtx.fillStyle = g
    offCtx.beginPath()
    offCtx.arc(x, y, r, 0, Math.PI * 2)
    offCtx.fill()
  }

  // 중앙 원
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) * 0.25
  const radial = offCtx.createRadialGradient(
    cx - radius * 0.3,
    cy - radius * 0.3,
    radius * 0.1,
    cx,
    cy,
    radius
  )
  radial.addColorStop(0, 'rgba(255,255,255,0.95)')
  radial.addColorStop(0.4, colorFromText(prompt + 'main', 90, 70))
  radial.addColorStop(1, colorFromText(prompt + 'main', 90, 30))
  offCtx.fillStyle = radial
  offCtx.beginPath()
  offCtx.arc(cx, cy, radius, 0, Math.PI * 2)
  offCtx.fill()

  // 기본 캔버스에 필터를 적용한다.
  ctx.filter = filter
  ctx.drawImage(off, 0, 0)
  ctx.filter = 'none'

  // 텍스트
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `bold ${Math.round(width * 0.025)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(prompt.slice(0, 40), width / 2, height - 40)

  return await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), 'image/png')
  )
}

/** 시드로 재현하는 의사 난수(0 이상 1 미만) */
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ============== 영상 데모 ==============

/**
 * MediaRecorder로 짧은 WebM 애니메이션을 만든다.
 * 이미지→영상의 움직임을 재현한다.
 */
export async function generateMockVideo(
  imageBlob: Blob,
  prompt: string,
  durationSec: number,
  width: number,
  height: number,
  cameraMovement: 'push' | 'pull' | 'pan' | 'tilt' | 'static' | 'orbit' = 'push'
): Promise<Blob> {
  const bitmap = await createImageBitmap(imageBlob)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  const stream = canvas.captureStream(30)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 4_000_000
  })

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
  })

  recorder.start()

  const startTime = performance.now()
  const totalMs = durationSec * 1000

  return new Promise<Blob>((resolve) => {
    const draw = () => {
      const elapsed = performance.now() - startTime
      const t = Math.min(elapsed / totalMs, 1)

      // 켄 번스 효과
      let scale = 1
      let offsetX = 0
      let offsetY = 0
      let rotation = 0
      switch (cameraMovement) {
        case 'push':
          scale = 1 + t * 0.15
          break
        case 'pull':
          scale = 1.15 - t * 0.15
          break
        case 'pan':
          offsetX = -t * width * 0.1
          break
        case 'tilt':
          offsetY = t * height * 0.1
          break
        case 'orbit':
          rotation = t * 0.1
          break
        case 'static':
        default:
          break
      }

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.save()
      ctx.translate(width / 2, height / 2)
      ctx.rotate(rotation)
      ctx.scale(scale, scale)
      ctx.translate(-width / 2 + offsetX, -height / 2 + offsetY)

      // 종횡비를 유지한다.
      const ratio = Math.max(width / bitmap.width, height / bitmap.height)
      const dw = bitmap.width * ratio
      const dh = bitmap.height * ratio
      ctx.drawImage(bitmap, (width - dw) / 2, (height - dh) / 2, dw, dh)
      ctx.restore()

      // 자막
      if (t < 0.95) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.font = `bold ${Math.round(width * 0.035)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(
          `[${cameraMovement}] ${prompt.slice(0, 30)}`,
          width / 2,
          height - 30
        )
      }

      if (t < 1) {
        requestAnimationFrame(draw)
      } else {
        recorder.stop()
      }
    }
    requestAnimationFrame(draw)

    done.then(resolve)
  })
}
