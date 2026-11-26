import type { VideoGenModel } from '@/types/canvas'
import { LTX_DESKTOP_MODELS, LTX_DESKTOP_WORKFLOW, ltxDurationOptions, videoDurationOptions } from './index'
import { VIDEO_FL2VA_WORKFLOW_ID } from '../env'
import { autodlWorkflowById } from '../autodl'
import { zealmanWorkflowById } from '../zealman'
import { isLtxProfile, LTX_DEFAULT_MODEL, LTX_MODELS } from '../ltxOptions'
import { isLtxDesktop } from '../ltxDesktopOptions'

export type VideoVoiceSupport = 'supported' | 'unsupported'

export type VideoDurationProfile = {
  provider?: string
  workflowId?: string
  baseUrl?: string
  options?: { videoAudio?: boolean }
}

export function videoDurationCapability(input: {
  model?: VideoGenModel
  profile?: VideoDurationProfile | null
  resolution?: string
  durationLimit?: number
  startEndFrames?: boolean
} = {}) {
  const { model = 'h3', profile, resolution, durationLimit } = input
  const workflowId = profile?.workflowId || ''
  const autoDl = Boolean(profile && (profile.provider === 'autodl' || /(?:^|\/)autodl\.art(?=[:/]|$)/i.test(profile.baseUrl || '') ||
    autodlWorkflowById(workflowId)))
  const id = autoDl && input.startEndFrames ? VIDEO_FL2VA_WORKFLOW_ID : workflowId
  let durations = videoDurationOptions(model)
  if (model === 'h3') {
    const workflow = autodlWorkflowById(id) || zealmanWorkflowById(id)
    if (isLtxProfile(profile ?? undefined)) {
      const desktop = isLtxDesktop(profile ?? undefined)
      const fallback = desktop ? LTX_DESKTOP_WORKFLOW : LTX_DEFAULT_MODEL
      const models = desktop ? LTX_DESKTOP_MODELS : LTX_MODELS
      durations = ltxDurationOptions(models.includes(id) ? id : fallback, resolution)
    } else if (/grok-imagine-1\.5/i.test(id)) {
      durations = durations.filter((seconds) => seconds >= 6)
    } else if (durationLimit === 30 && /seedance[\s._-]*2[._-]*5|wan[\s._-]*3[._-]*0/i.test(id)) {
      durations = Array.from({ length: 25 }, (_, i) => i + 6)
    } else if (workflow) {
      durations = durations.filter((seconds) => seconds <= workflow.maxDuration)
    }
  }
  let voice: VideoVoiceSupport = 'unsupported'
  if (model === 'h3-v5' || model === 'wan-prime') voice = 'supported'
  else if (profile?.options?.videoAudio === false) voice = 'unsupported'
  else if (profile?.provider === 'ltx' || profile?.provider === 'ltx-desktop') voice = 'supported'
  else if (profile?.options?.videoAudio === true || autoDl || zealmanWorkflowById(workflowId) ||
    /grok-imagine-1\.5/i.test(workflowId)) voice = 'supported'
  const audioToVideo = model === 'h3' && isLtxDesktop(profile ?? undefined) &&
    (!workflowId || LTX_DESKTOP_MODELS.includes(workflowId))
  return { durations, max: durations[durations.length - 1], voice, audioToVideo }
}

export function nearestVideoDuration(raw: number, durations: number[]): number {
  return durations.reduce((best, seconds) =>
    Math.abs(seconds - raw) < Math.abs(best - raw) ? seconds : best
  )
}

export function shotDurationWarning(duration: number | undefined, max: number) {
  return duration !== undefined && duration > max
}
