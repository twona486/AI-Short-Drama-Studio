export const LTX_BASE_URL = 'https://api.ltx.io'
export const LTX_DEFAULT_MODEL = 'ltx-2-3-fast'
export const LTX_MODELS = [LTX_DEFAULT_MODEL, 'ltx-2-3-pro', 'ltx-2-5-fast', 'ltx-2-5-pro']

export function isLtxProfile(profile?: { provider?: string; baseUrl?: string }) {
  return profile?.provider === 'ltx'
}

export function ltxDurationOptions(model?: string) {
  return model?.endsWith('-pro') ? [6, 8, 10] : [6, 8, 10, 12, 14, 16, 18, 20]
}

export function ltxDuration(raw: number, model?: string) {
  return ltxDurationOptions(model).reduce((best, option) =>
    Math.abs(option - raw) < Math.abs(best - raw) ? option : best
  )
}

export function ltxCost(model: string, resolution: string, duration: number) {
  const rates = [[3, 6], [4, 8], [9, 13], [12, 17]]
  const rate = rates[LTX_MODELS.indexOf(model)] ?? rates[0]
  return (rate[resolution === '1080p' ? 1 : 0] * duration / 100).toFixed(2)
}

export type LtxBody = {
  image_uri: string
  last_frame_uri?: string
  prompt: string
  model: string
  duration: number
  resolution: string
  fps: 24
  generate_audio: boolean
}

export type LtxRequest =
  | { apiKey: string; body: LtxBody }
  | { apiKey: string; jobId: string }

export type LtxReply =
  | { kind: 'submitted'; id: string }
  | { kind: 'pending' | 'processing' }
  | { kind: 'completed'; url: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'http'; status: number; retryAfterMs?: number }
  | { kind: 'network' | 'invalid' }
