import { t } from '@/i18n'
import { desktop, isDesktop } from '@/services/desktop'
import { throwIfAborted } from './abort'
import { drawThingsInputError, drawThingsSize, isDrawThingsGrpc, type DrawThingsReply } from './drawThingsOptions'
import type { ImageGenInput, ImageGenOutput } from './image'

function drawThingsApi() {
  if (!isDesktop() || !desktop().drawThingsRequest) throw new Error(t('drawThings.desktopOnly'))
  return desktop()
}

function replyMessage(reply: DrawThingsReply) {
  return t(`drawThings.${reply.kind}`, reply.kind === 'http' ? { status: reply.status } : {})
}

export async function checkDrawThings(baseUrl: string) {
  try {
    const reply = await drawThingsApi().drawThingsRequest({ kind: 'check', baseUrl })
    return {
      ok: reply.kind === 'ready', detail: replyMessage(reply),
      models: reply.kind === 'ready' ? reply.models : undefined
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : t('drawThings.offline') }
  }
}

function imageCanvas(width: number, height: number, transparent: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: transparent })
  if (!context) throw new Error()
  return { canvas, context }
}

async function prepareReference(blob: Blob, width: number, height: number) {
  try {
    const bitmap = await createImageBitmap(blob)
    try {
      // HTTP img2img는 참조 파일의 크기가 요청한 출력 크기와 정확히 같아야 한다.
      const { canvas, context } = imageCanvas(width, height, false)
      const scale = Math.min(width / bitmap.width, height / bitmap.height)
      const w = bitmap.width * scale
      const h = bitmap.height * scale
      context.fillStyle = '#808080'
      context.fillRect(0, 0, width, height)
      context.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h)
      return { canvas, context }
    } finally {
      bitmap.close()
    }
  } catch {
    throw new Error(t('drawThings.invalidReference'))
  }
}

async function pixelsToPng(reply: Extract<DrawThingsReply, { kind: 'pixels' }>) {
  try {
    const { width, height, data } = reply
    const { canvas, context } = imageCanvas(width, height, true)
    context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error()
    return blob
  } catch {
    throw new Error(t('drawThings.invalidResponse'))
  }
}

export async function generateDrawThings(
  baseUrl: string, model: string, input: ImageGenInput, onProgress?: (message: string) => void
): Promise<ImageGenOutput> {
  const { signal } = input
  throwIfAborted(signal)
  const grpc = isDrawThingsGrpc(baseUrl)
  const references = input.referenceImages || []
  const problem = drawThingsInputError(model, references.length, grpc)
  if (problem) throw new Error(t(problem))
  const api = drawThingsApi()
  const [width, height] = drawThingsSize(input.aspectRatio, input.width, input.height)
  let reference: string | undefined
  let referencePixels: ArrayBuffer[] | undefined
  if (grpc) {
    referencePixels = []
    for (const blob of references) {
      throwIfAborted(signal)
      const { context } = await prepareReference(blob, width, height)
      referencePixels.push(context.getImageData(0, 0, width, height).data.buffer)
    }
  } else if (references[0]) {
    const { canvas } = await prepareReference(references[0], width, height)
    reference = canvas.toDataURL('image/jpeg', 0.95).split(',')[1]
  }
  const id = crypto.randomUUID()
  const off = api.onDrawThingsProgress(id, (progress) => {
    onProgress?.(progress ? t('drawThings.sampling', progress) : t('drawThings.generating'))
  })
  let cancel: (() => void) | undefined
  try {
    onProgress?.(t('drawThings.queued'))
    throwIfAborted(signal)
    const pending = api.drawThingsRequest({
      baseUrl, kind: 'generate', id, model, prompt: input.prompt, width, height, reference, referencePixels
    })
    const cancelled = new Promise<DrawThingsReply>((resolve) => {
      cancel = () => {
        api.cancelDrawThings(id)
        resolve({ kind: 'cancelled' })
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
    const reply = await Promise.race([pending, cancelled])
    if (reply.kind === 'cancelled') throw new DOMException(replyMessage(reply), 'AbortError')
    throwIfAborted(signal)
    if (reply.kind === 'pixels') {
      const blob = await pixelsToPng(reply)
      throwIfAborted(signal)
      return { blob, mimeType: 'image/png', prompt: input.prompt }
    }
    if (reply.kind !== 'image') throw new Error(replyMessage(reply))
    return { blob: new Blob([reply.data], { type: reply.mimeType }), mimeType: reply.mimeType, prompt: input.prompt }
  } finally {
    off()
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}
