import { t } from '@/i18n'
import type { AspectRatio } from '@/types'

export const OPENAI_DEFAULT_IMAGE_MODEL = 'gpt-image-2.6-sunburst'
export const OPENAI_IMAGE_MODELS = [OPENAI_DEFAULT_IMAGE_MODEL, 'gpt-image-2.6-flare']
export const OPENAI_IMAGE_TIMEOUT_MS = 600_000
import { IMAGE_REFERENCE_LIMITS } from './capabilities/index'

export const OPENAI_IMAGE_MAX_REFERENCES = IMAGE_REFERENCE_LIMITS.openAi

// 파일당 API 제한보다 낮게 잡아 멀티파트와 Electron IPC의 전체 크기도 제한한다.
const REFERENCE_BUDGET = 48_000_000
const REFERENCE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg'
}

const WIDE_IMAGE_SIZES: Record<AspectRatio, string> = {
  '16:9': '1536x864',
  '9:16': '864x1536',
  '1:1': '1024x1024',
  '4:3': '1280x960',
  '21:9': '1792x768'
}

export function isOpenAiImageModel(model: string) {
  return /^(gpt-image-|chatgpt-image-latest$)/i.test(model)
}

function imageSize(model: string, ratio: AspectRatio | undefined, width: number, height: number) {
  const inferred = width === height ? '1:1' : width > height ? '16:9' : '9:16'
  const shape = ratio && Object.hasOwn(WIDE_IMAGE_SIZES, ratio) ? ratio : inferred
  if (/^gpt-image-2(?:[.-]|$)/i.test(model)) return WIDE_IMAGE_SIZES[shape]
  if (shape === '1:1') return '1024x1024'
  return shape === '9:16' ? '1024x1536' : '1536x1024'
}

async function resizeReference(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error()
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const resized = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.88))
    if (!resized) throw new Error()
    return resized
  } finally {
    bitmap.close()
  }
}

export async function openAiImageRequest(input: {
  model: string
  prompt: string
  aspectRatio?: AspectRatio
  width: number
  height: number
  n?: number
  referenceImages?: Blob[]
  signal?: AbortSignal
}) {
  const fields = {
    model: input.model,
    prompt: input.prompt,
    size: imageSize(input.model, input.aspectRatio, input.width, input.height),
    quality: 'medium',
    output_format: 'png',
    background: 'auto',
    n: input.n ?? 1
  }
  const refs = input.referenceImages ?? []
  if (!refs.length) {
    return { path: '/images/generations', body: JSON.stringify(fields) }
  }
  if (refs.length > OPENAI_IMAGE_MAX_REFERENCES) {
    throw new Error(t('aiError.imageTooManyReferences', { count: OPENAI_IMAGE_MAX_REFERENCES }))
  }
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.append(name, String(value))
  const sharingBudget = refs.reduce((total, blob) => total + blob.size, 0) > REFERENCE_BUDGET ||
    refs.some((blob) => !Object.hasOwn(REFERENCE_EXTENSIONS, blob.type))
  const perReferenceBudget = sharingBudget
    ? Math.floor(REFERENCE_BUDGET / refs.length)
    : REFERENCE_BUDGET
  for (const [index, source] of refs.entries()) {
    input.signal?.throwIfAborted()
    let blob = source
    if (blob.size > perReferenceBudget || !Object.hasOwn(REFERENCE_EXTENSIONS, blob.type)) {
      try {
        blob = await resizeReference(blob)
      } catch {
        throw new Error(t('aiError.imageReferenceUnreadable', { number: index + 1 }))
      }
    }
    if (!blob.size || blob.size > perReferenceBudget) {
      throw new Error(t('aiError.imageReferenceSize', { number: index + 1 }))
    }
    form.append('image[]', blob, `ref_${index + 1}.${REFERENCE_EXTENSIONS[blob.type]}`)
  }
  return { path: '/images/edits', form }
}

export function parseOpenAiImage(data: { data?: { b64_json?: string }[] }) {
  const base64 = data?.data?.[0]?.b64_json
  if (typeof base64 === 'string' && base64.trim()) {
    try {
      const binary = atob(base64)
      if (binary.startsWith('\x89PNG\r\n\x1a\n')) {
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const mimeType = 'image/png'
        return { blob: new Blob([bytes], { type: mimeType }), mimeType }
      }
    } catch {
      // 잘못된 base64 응답은 동일한 이미지 응답 오류로 표시한다.
    }
  }
  throw new Error(t('aiError.imageInvalidResponse'))
}
