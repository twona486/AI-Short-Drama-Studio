/** 도우미가 모델 문서에서 추출한 옵션만 노드에 표시한다. */

export type DocImageResolution = '1k' | '2k' | '4k'

export interface ModelNodeOptions {
  /** 문서에서 지원하는 출력 해상도 옵션. 예를 들어 1K 또는 2K다. */
  imageResolutions?: DocImageResolution[]
  /** 모델 문서에 오디오 설정이 있으면 true다. */
  videoAudio?: boolean
  /** 모델 문서에서 끝 프레임이 필수인 경우 true다. */
  lastFrameRequired?: boolean
  /** 모델의 오디오 요청 필드명. 기본값은 audio다. */
  audioField?: string
}

const RESOLUTION_ORDER: DocImageResolution[] = ['1k', '2k', '4k']

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
  const out: ModelNodeOptions = {}
  if (imageResolutions.length) out.imageResolutions = imageResolutions
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
