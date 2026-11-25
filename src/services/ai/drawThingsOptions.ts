import type { AspectRatio } from '../../types/project'

export const DRAW_THINGS_PROVIDER = 'draw-things'
export const DRAW_THINGS_PORT = '7860'
export const DRAW_THINGS_URL = `http://127.0.0.1:${DRAW_THINGS_PORT}`
export const DRAW_THINGS_GRPC_PORT = '7859'
export const DRAW_THINGS_MAX_REFERENCES = 4
export const DRAW_THINGS_MAX_SECRET_BYTES = 4096
export const isDrawThingsGrpc = (url: string) => /^grpc:\/\//i.test(url.trim())

// Draw Things의 configs.json에 있는 권장 설정과 기본 체크포인트.
const PRESETS = [
  {
    file: 'qwen_image_2.1_q8p.ckpt', name: 'Qwen Image 2.1', family: /^qwen_image_2\.1_(?!turbo)/i,
    steps: 40, cfg_scale: 1, sampler_name: 'DDIM Trailing', shift: 1,
    resolution_dependent_shift: true, mode: 'text'
  },
  {
    file: 'qwen_image_edit_2511_q6p.ckpt', name: 'Qwen Image Edit 2511', family: /^qwen_image_edit_2511_/i,
    steps: 30, cfg_scale: 4, sampler_name: 'UniPC Trailing', shift: 2,
    resolution_dependent_shift: false, mode: 'edit'
  },
  {
    file: 'flux_2_klein_4b_q6p.ckpt', name: 'FLUX.2 [klein] 4B', family: /^flux_2_klein_4b_(?!base)/i,
    steps: 4, cfg_scale: 1, sampler_name: 'DDIM Trailing', shift: 3,
    resolution_dependent_shift: false, mode: 'both'
  }
] as const

export const DRAW_THINGS_MODELS = PRESETS.map(({ file }) => file)

export function drawThingsPreset(model: string) {
  return PRESETS.find(({ family, name }) => model === name || (/^[a-z0-9_.-]+\.ckpt$/i.test(model) && family.test(model)))
}

export function drawThingsModelLabel(model: string) {
  const preset = drawThingsPreset(model)
  return preset?.file === model ? preset.name : model
}

export function drawThingsInputError(model: string, count: number, grpc = false) {
  const preset = drawThingsPreset(model)
  if (!preset) return 'drawThings.unsupportedModel'
  if (!grpc && count > 1) return 'drawThings.multipleReferences'
  if (count > DRAW_THINGS_MAX_REFERENCES) return 'drawThings.referenceLimit'
  if (count && preset.mode === 'text') return 'drawThings.textOnly'
  if (!count && preset.mode === 'edit') return 'drawThings.referenceRequired'
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
  | { kind: 'ready'; models?: string[] }
  | { kind: 'image'; data: ArrayBuffer; mimeType: 'image/png' | 'image/jpeg' }
  | { kind: 'pixels'; data: ArrayBuffer; width: number; height: number }
  | { kind: 'http'; status: number }
  | { kind: 'unsafeAddress' | 'offline' | 'timeout' | 'invalidResponse' | 'missingModel' | 'invalidRequest' | 'cancelled' | 'grpcSecret' | 'grpcCompression' | 'referenceTooLarge' }

export type DrawThingsDesktopRequest = { encryptedSharedSecret?: string } & (
  | Omit<Extract<DrawThingsRequest, { kind: 'check' }>, 'sharedSecret'>
  | Omit<Extract<DrawThingsRequest, { kind: 'generate' }>, 'sharedSecret'>
)

export type DrawThingsProgress = { step: number; total: number } | undefined
