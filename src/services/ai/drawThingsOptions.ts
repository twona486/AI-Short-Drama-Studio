import { IMAGE_REFERENCE_LIMITS } from './capabilities/index'
import type { AspectRatio } from '../../types/project'

export const DRAW_THINGS_PROVIDER = 'draw-things'
export const DRAW_THINGS_PORT = '7860'
export const DRAW_THINGS_URL = `http://127.0.0.1:${DRAW_THINGS_PORT}`
export const DRAW_THINGS_GRPC_PORT = '7859'
export const DRAW_THINGS_MAX_REFERENCES = IMAGE_REFERENCE_LIMITS.drawThingsGrpc
export const DRAW_THINGS_MAX_SECRET_BYTES = 4096
export const isDrawThingsGrpc = (url: string) => /^grpc:\/\//i.test(url.trim())

// Draw Things의 configs.json에 있는 권장 설정과 기본 체크포인트.
const PRESETS = [
  {
    file: 'qwen_image_2.1_q8p.ckpt', name: 'Qwen Image 2.1', family: /^qwen_image_2[._]1(?:_(?:q\d+p|i\d+x|bf16|f16|fp16))*\.ckpt$/i,
    steps: 40, cfg_scale: 1, sampler_name: 'DDIM Trailing', shift: 1,
    resolution_dependent_shift: true, references: { min: 0, max: DRAW_THINGS_MAX_REFERENCES }
  },
  {
    file: 'qwen_image_edit_2511_q8p.ckpt', name: 'Qwen Image Edit 2511', family: /^qwen_image_edit_2511(?:_(?:q\d+p|i\d+x|bf16|f16|fp16))*\.ckpt$/i,
    steps: 30, cfg_scale: 4, sampler_name: 'UniPC Trailing', shift: 2,
    resolution_dependent_shift: false, references: { min: 1, max: DRAW_THINGS_MAX_REFERENCES }
  },
  {
    file: 'flux_2_klein_4b_q8p.ckpt', name: 'FLUX.2 [klein] 4B', family: /^flux_2_klein_4b(?:_(?:q\d+p|i\d+x|bf16|f16|fp16))*\.ckpt$/i,
    steps: 4, cfg_scale: 1, sampler_name: 'DDIM Trailing', shift: 3,
    resolution_dependent_shift: false, references: { min: 0, max: DRAW_THINGS_MAX_REFERENCES }
  }
] as const

export const DRAW_THINGS_MODELS = PRESETS.map(({ file }) => file)

export function drawThingsPreset(model: string) {
  return PRESETS.find(({ family, name }) => model === name || (/^[a-z0-9_.-]+\.ckpt$/i.test(model) && family.test(model)))
}

export function drawThingsModelLabel(model: string, nonCommercialLabel: string) {
  const preset = drawThingsPreset(model)
  if (!preset) return model
  const variant = model.match(/_(q\d+p|i\d+x|[bf]+16)\.ckpt$/i)?.[1]
  const label = variant ? `${preset.name} · ${variant}` : model
  return preset.name === 'Qwen Image 2.1' ? `${label} · ${nonCommercialLabel}` : label
}

export function drawThingsReferenceCapability(model: string, grpc = false): { min: number; max: number } | undefined {
  const references = drawThingsPreset(model)?.references
  if (!references) return undefined
  return { min: references.min, max: Math.min(references.max, grpc ? DRAW_THINGS_MAX_REFERENCES : IMAGE_REFERENCE_LIMITS.drawThingsHttp) }
}

export function drawThingsInputError(model: string, count: number, grpc = false) {
  const capability = drawThingsReferenceCapability(model, grpc)
  if (!capability) return 'drawThings.unsupportedModel'
  if (count > 0 && capability.max === 0) return 'drawThings.textOnly'
  if (count > capability.max) return grpc ? 'drawThings.referenceLimit' : 'drawThings.multipleReferences'
  if (count < capability.min) return 'drawThings.referenceRequired'
}

export function drawThingsEditAlternative(models: string[], current: string, count: number, grpc: boolean) {
  const candidates = models.filter(model => {
    const capability = drawThingsReferenceCapability(model, grpc)
    return model !== current && capability && count > 0 && !drawThingsInputError(model, count, grpc)
  })
  return candidates.find(model => drawThingsReferenceCapability(model, grpc)?.min) ?? candidates[0]
}

const sizes: Record<AspectRatio, readonly [number, number]> = {
  '1:1': [1024, 1024],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '4:3': [1152, 896],
  '21:9': [1536, 640]
}

export function drawThingsSize(aspectRatio: AspectRatio | undefined, width: number, height: number) {
  if (aspectRatio && sizes[aspectRatio]) return sizes[aspectRatio]
  const ratio = width > 0 && height > 0 ? width / height : 1
  return Object.values(sizes).reduce((best, candidate) => (
    Math.abs(Math.log(candidate[0] / candidate[1] / ratio)) < Math.abs(Math.log(best[0] / best[1] / ratio))
      ? candidate : best
  ))
}

export type DrawThingsRequest = { baseUrl: string; sharedSecret?: string } & (
  | { kind: 'check' }
  | {
      kind: 'generate'; id: string
      model: string; prompt: string; width: number; height: number
      reference?: string; referencePixels?: ArrayBuffer[]
    })

export type DrawThingsReply =
  | { kind: 'ready'; models?: string[]; unverifiedModels?: string[]; incompleteModels?: string[]; missingComponents?: string[] }
  | { kind: 'modelUnavailable'; models: string[] }
  | { kind: 'modelIncomplete'; models: string[]; missingComponents?: string[] }
  | { kind: 'image'; data: ArrayBuffer; mimeType: 'image/png' | 'image/jpeg' }
  | { kind: 'pixels'; data: ArrayBuffer; width: number; height: number }
  | { kind: 'http'; status: number }
  | { kind: 'unsafeAddress' | 'offline' | 'timeout' | 'invalidResponse' | 'missingModel' | 'invalidRequest' | 'cancelled' | 'grpcSecret' | 'grpcCompression' | 'referenceTooLarge' }

export type DrawThingsDesktopRequest = { encryptedSharedSecret?: string } & (
  | Omit<Extract<DrawThingsRequest, { kind: 'check' }>, 'sharedSecret'>
  | Omit<Extract<DrawThingsRequest, { kind: 'generate' }>, 'sharedSecret'>
)

export type DrawThingsProgress = { step: number; total: number } | { warning: 'unverifiedModel' } | undefined

export class DrawThingsStopRequest extends DOMException {
  constructor(message: string) {
    super(message, 'AbortError')
  }
}
