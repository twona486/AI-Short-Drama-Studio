import type { VideoGenModel } from '../../../types/canvas'

export const IMAGE_REFERENCE_LIMITS = {
  openAi: 16,
  drawThingsHttp: 1,
  drawThingsGrpc: 4
} as const

const VIDEO_LIMITS = {
  h3: { min: 1, max: 15, references: 9 },
  'h3-v5': { min: 1, max: 10, references: 9 },
  'wan-prime': { min: 2, max: 30, references: 9 }
} satisfies Record<VideoGenModel, { min: number; max: number; references: number }>

export const videoMinSeconds = (model: VideoGenModel) => VIDEO_LIMITS[model].min
export const videoMaxSeconds = (model: VideoGenModel) => VIDEO_LIMITS[model].max
export const videoMaxRefImages = (model: VideoGenModel = 'h3') => VIDEO_LIMITS[model].references

export function videoDurationOptions(model: VideoGenModel): number[] {
  const { min, max } = VIDEO_LIMITS[model]
  return Array.from({ length: max - min + 1 }, (_, i) => min + i)
}

export const LTX_DESKTOP_WORKFLOW = 'ltx-2.3-fast'
export const LTX_DESKTOP_MODELS = [LTX_DESKTOP_WORKFLOW, 'ltx-2.5-fast']
const LTX_DESKTOP_LOW_RESOLUTIONS = ['270p', '360p', '540p'] as const
export const LTX_DESKTOP_RESOLUTIONS = [...LTX_DESKTOP_LOW_RESOLUTIONS, '720p', '1080p'] as const
type LtxDesktopResolution = typeof LTX_DESKTOP_RESOLUTIONS[number]
export const LTX_DESKTOP_AUDIO_RESOLUTIONS: readonly LtxDesktopResolution[] = ['540p', '720p', '1080p']
export const LTX_DESKTOP_MIN_AUDIO_SECONDS = 2

export function ltxDesktopAudioMax(resolution?: string) {
  return resolution === '1080p' ? 10 : 20
}

export function ltxDesktopAdvertisedAudioMax(resolution: LtxDesktopResolution, durations: unknown) {
  if (!LTX_DESKTOP_AUDIO_RESOLUTIONS.includes(resolution) || !Array.isArray(durations)) return 0
  const advertised = durations.filter((seconds): seconds is number =>
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= LTX_DESKTOP_MIN_AUDIO_SECONDS)
  return Math.min(ltxDesktopAudioMax(resolution), Math.max(0, ...advertised))
}

export function ltxDurationOptions(model?: string, resolution?: string) {
  if (LTX_DESKTOP_MODELS.includes(model || '')) {
    const durations = [2, 3, 4, 5, 6, 8, 10]
    // Desktop advertises 20 seconds at lower resolutions, subject to hardware preflight.
    if (LTX_DESKTOP_LOW_RESOLUTIONS.some((tier) => tier === resolution)) durations.push(20)
    return durations
  }
  return model?.endsWith('-pro') ? [6, 8, 10] : [6, 8, 10, 12, 14, 16, 18, 20]
}
