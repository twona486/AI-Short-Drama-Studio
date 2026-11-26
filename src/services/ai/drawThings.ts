import { t } from '@/i18n'
import { checkDrawThings, drawThingsApi, drawThingsReplyMessage } from './drawThingsConnection'
import { useSettingsStore } from '@/stores/settings'
import { throwIfAborted } from './abort'
import { prepareMediaPrompt } from './mediaPrompt'
import { drawThingsInputError, drawThingsSize, isDrawThingsGrpc, type DrawThingsReply } from './drawThingsOptions'
import type { ImageGenInput, ImageGenOutput } from './image'

const catalogRequests = new Map<string, ReturnType<typeof checkDrawThings>>()

export function refreshDrawThingsModels(profileId: string, baseUrl: string, encryptedSharedSecret?: string) {
  const key = JSON.stringify([profileId, baseUrl, encryptedSharedSecret])
  const existing = catalogRequests.get(key)
  if (existing) return existing
  const settings = useSettingsStore()
  const request = checkDrawThings(baseUrl, encryptedSharedSecret).then((result) => {
    if (result.ok) settings.setDrawThingsServerModels(profileId, baseUrl, encryptedSharedSecret, result.models)
    return result
  }).finally(() => catalogRequests.delete(key))
  catalogRequests.set(key, request)
  return request
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
  config: { baseUrl: string; model: string; drawThingsSharedSecret?: string; drawThingsServerModels?: string[] },
  input: ImageGenInput, onProgress?: (message: string) => void
): Promise<ImageGenOutput> {
  const { baseUrl, model, drawThingsSharedSecret } = config
  const { signal } = input
  throwIfAborted(signal)
  const grpc = isDrawThingsGrpc(baseUrl)
  const settings = useSettingsStore()
  const profileId = settings.config.activeImageId
  if (grpc && !model && config.drawThingsServerModels !== undefined) {
    throw new Error(t(config.drawThingsServerModels.length ? 'drawThings.modelUnavailable' : 'drawThings.noInstalledModels'))
  }
  if (grpc && config.drawThingsServerModels && !config.drawThingsServerModels.includes(model)) {
    const refreshed = await refreshDrawThingsModels(profileId, baseUrl, drawThingsSharedSecret)
    throwIfAborted(signal)
    if (!refreshed.ok) throw new Error(refreshed.detail)
    if (refreshed.models && !refreshed.models.includes(model)) {
      throw new Error(drawThingsReplyMessage(refreshed.incompleteModels?.includes(model)
        ? { kind: 'modelIncomplete', models: refreshed.models, missingComponents: refreshed.missingComponents }
        : { kind: 'modelUnavailable', models: refreshed.models }))
    }
  }
  const references = input.referenceImages || []
  const problem = drawThingsInputError(model, references.length, grpc)
  if (problem) throw new Error(t(problem))
  const api = drawThingsApi()
  const prompt = await prepareMediaPrompt('image', input.prompt, signal)
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
      baseUrl, kind: 'generate', id, model, prompt, width, height, reference, referencePixels,
      encryptedSharedSecret: grpc ? drawThingsSharedSecret : undefined
    }).catch(() => { throw new Error(t('drawThings.offline')) })
    const cancelled = new Promise<DrawThingsReply>((resolve) => {
      cancel = () => {
        api.cancelDrawThings(id)
        resolve({ kind: 'cancelled' })
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
    const reply = await Promise.race([pending, cancelled])
    if (reply.kind === 'cancelled') throw new DOMException(drawThingsReplyMessage(reply), 'AbortError')
    throwIfAborted(signal)
    if (reply.kind === 'modelUnavailable' || reply.kind === 'modelIncomplete') {
      settings.setDrawThingsServerModels(profileId, baseUrl, drawThingsSharedSecret, reply.models)
    }
    if (reply.kind === 'pixels') {
      const blob = await pixelsToPng(reply)
      throwIfAborted(signal)
      return { blob, mimeType: 'image/png', prompt: input.prompt }
    }
    if (reply.kind !== 'image') throw new Error(drawThingsReplyMessage(reply))
    return { blob: new Blob([reply.data], { type: reply.mimeType }), mimeType: reply.mimeType, prompt: input.prompt }
  } finally {
    off()
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}
