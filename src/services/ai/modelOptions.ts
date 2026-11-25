/** 도우미가 모델 문서에서 추출한 옵션만 노드에 표시한다. */

import type { VideoGenModel } from '@/types/canvas'

export type DocImageResolution = '1k' | '2k' | '4k'
export type DocVideoResolution = '480p' | '720p' | '768p' | '1080p'

export interface ModelNodeOptions {
  /** 문서에서 지원하는 출력 해상도 옵션. 예를 들어 1K 또는 2K다. */
  imageResolutions?: DocImageResolution[]
  /** 공식 문서에 명시된 영상 해상도 값. 예: 480P, 720P, 1080P */
  videoResolutions?: DocVideoResolution[]
  /** 모델 문서에 오디오 설정이 있으면 true다. */
  videoAudio?: boolean
  /** 모델 문서에서 끝 프레임이 필수인 경우 true다. */
  lastFrameRequired?: boolean
  /** 모델의 오디오 요청 필드명. 기본값은 audio다. */
  audioField?: string
}

const RESOLUTION_ORDER: DocImageResolution[] = ['1k', '2k', '4k']
const VIDEO_RESOLUTION_ORDER: DocVideoResolution[] = ['480p', '720p', '768p', '1080p']

export function normalizeDocImageResolution(value: unknown): DocImageResolution | undefined {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '')
  if (raw === '1k' || raw === '1') return '1k'
  if (raw === '2k' || raw === '2') return '2k'
  if (raw === '4k' || raw === '4') return '4k'
  return undefined
}

export function normalizeDocVideoResolution(value: unknown): DocVideoResolution | undefined {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '')
  if (raw === '480p' || raw === '480') return '480p'
  if (raw === '720p' || raw === '720') return '720p'
  if (raw === '768p' || raw === '768') return '768p'
  if (raw === '1080p' || raw === '1080') return '1080p'
  return undefined
}

export function docVideoResolutionLabel(value: DocVideoResolution): string {
  return value.replace(/p$/, 'P')
}

/** Wan API에는 480P, 720P, 1080P를 사용한다. H3 워크플로의 768p 표기는 유지한다. */
export function videoResolutionApiValue(value: DocVideoResolution): string {
  if (value === '768p') return '768p'
  return docVideoResolutionLabel(value)
}

export function normalizeAudioField(value: unknown): string | undefined {
  const field = String(value || '').trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return undefined
  if (!/audio/i.test(field)) return undefined
  return field
}

export function normalizeModelNodeOptions(raw: unknown): ModelNodeOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const listed = Array.isArray(src.imageResolutions) ? src.imageResolutions : []
  const imageResolutions = RESOLUTION_ORDER.filter((tier) =>
    listed.some((item) => normalizeDocImageResolution(item) === tier)
  )
  const listedVideo = Array.isArray(src.videoResolutions) ? src.videoResolutions : []
  const videoResolutions = VIDEO_RESOLUTION_ORDER.filter((tier) =>
    listedVideo.some((item) => normalizeDocVideoResolution(item) === tier)
  )
  const out: ModelNodeOptions = {}
  if (imageResolutions.length) out.imageResolutions = imageResolutions
  if (videoResolutions.length) out.videoResolutions = videoResolutions
  if (src.videoAudio === true) out.videoAudio = true
  if (src.lastFrameRequired === true) out.lastFrameRequired = true
  const audioField = normalizeAudioField(src.audioField)
  if (out.videoAudio && audioField) out.audioField = audioField
  return Object.keys(out).length ? out : undefined
}

export function pickDocImageResolution(
  value: unknown,
  choices: DocImageResolution[] | undefined
): DocImageResolution | undefined {
  if (!choices?.length) return undefined
  const picked = normalizeDocImageResolution(value)
  if (picked && choices.includes(picked)) return picked
  return choices[0]
}

export function docImageResolutionLabel(value: DocImageResolution): string {
  if (value === '1k') return '1K'
  if (value === '4k') return '4K'
  return '2K'
}

function profileMentionsWan(profile?: { name?: string; workflowId?: string } | null): boolean {
  return /wan/i.test(`${profile?.name || ''} ${profile?.workflowId || ''}`)
}

/** 문서가 지정한 해상도를 표시한다. 옵션이 없는 Wan 모델은 Wan 3.0 문서의 480P, 720P, 1080P를 사용한다. */
export function videoResolutionChoices(input: {
  model?: VideoGenModel
  profile?: { provider?: string; name?: string; model?: string; workflowId?: string; options?: ModelNodeOptions } | null
}): DocVideoResolution[] {
  if (['ltx', 'ltx-desktop'].includes(input.profile?.provider || '')) return ['720p', '1080p']
  if (/grok/i.test(`${input.profile?.name || ''} ${input.profile?.model || ''} ${input.profile?.workflowId || ''}`)) return ['480p', '720p', '1080p']
  const listed = input.profile?.options?.videoResolutions
  if (listed?.length) return [...listed]
  if (input.model === 'wan-prime' || profileMentionsWan(input.profile)) return ['480p', '720p', '1080p']
  if (input.model === 'h3-v5') return ['768p', '1080p']
  return []
}

/** Grok does not accept the 768p tier used by H3 workflows. */
export function providerVideoResolution(model: string, raw?: string): DocVideoResolution {
  const picked = normalizeDocVideoResolution(raw) || '720p'
  return /grok/i.test(model) && picked === '768p' ? '720p' : picked
}

export function pickDocVideoResolution(
  value: unknown,
  choices: DocVideoResolution[] | undefined
): DocVideoResolution | undefined {
  if (!choices?.length) return undefined
  const picked = normalizeDocVideoResolution(value)
  if (picked && choices.includes(picked)) return picked
  if (choices.includes('720p')) return '720p'
  if (choices.includes('768p')) return '768p'
  return choices[0]
}
