import { LTX_DESKTOP_AUDIO_RESOLUTIONS, LTX_DESKTOP_MODELS, LTX_DESKTOP_RESOLUTIONS, LTX_DESKTOP_WORKFLOW } from './capabilities/index'
export { LTX_DESKTOP_AUDIO_RESOLUTIONS, LTX_DESKTOP_MODELS, LTX_DESKTOP_RESOLUTIONS, LTX_DESKTOP_WORKFLOW, ltxDesktopAudioMax } from './capabilities/index'

export const LTX_DESKTOP_PROVIDER = 'ltx-desktop'
export type LtxDesktopResolution = typeof LTX_DESKTOP_RESOLUTIONS[number]

export function ltxDesktopResolution(value?: string): LtxDesktopResolution {
  return LTX_DESKTOP_RESOLUTIONS.find((resolution) => resolution === value) ?? '720p'
}

export function ltxDesktopAudioResolution(value?: string): LtxDesktopResolution {
  return LTX_DESKTOP_AUDIO_RESOLUTIONS.find((resolution) => resolution === value) ?? '540p'
}

export function ltxDesktopModel(workflowId?: string) {
  return workflowId && LTX_DESKTOP_MODELS.includes(workflowId) ? workflowId : LTX_DESKTOP_WORKFLOW
}

export function isLtxDesktop(profile?: { provider?: string }) {
  return profile?.provider === LTX_DESKTOP_PROVIDER
}

export function isLtxTask(taskId?: string) {
  return taskId?.startsWith('ltx:') || taskId?.startsWith('ltx-desktop:')
}

type LtxDesktopVideoSettings = {
  model: string
  resolution: LtxDesktopResolution
  aspect: '16:9' | '9:16'
}

export type LtxDesktopOperation =
  | { kind: 'pair'; code: string }
  | { kind: 'check' }
  | (LtxDesktopVideoSettings & (
      | { kind: 'submit'; first: string; last?: string; duration: number; prompt: string }
      | { kind: 'submitAudio'; first?: string; audio: ArrayBuffer; prompt: string }
      | { kind: 'checkAudio' }
    ))
  | { kind: 'status' | 'cancel'; id: string }
  | { kind: 'download'; path: string }

export type LtxDesktopRequest = {
  baseUrl: string
  requestId?: string
  hostOverride?: string
  token?: string
  operation: LtxDesktopOperation
}

export type LtxDesktopReply =
  | { kind: 'paired'; token: string }
  | { kind: 'ready'; maxAudioSeconds?: number }
  | { kind: 'submitted'; id: string }
  | { kind: 'pending' | 'processing'; percent?: number; remainingSeconds?: number }
  | { kind: 'completed'; path: string }
  | { kind: 'video'; path: string }
  | { kind: 'failed'; code: string }
  | { kind: 'http'; status: number }
  | { kind: 'unsafeAddress' | 'offline' | 'invalidResponse' | 'fileError' | 'invalid' | 'unsupported' | 'invalidHostOverride' }

export function ltxDesktopError(reply: LtxDesktopReply, pairing = false) {
  if (reply.kind === 'invalidHostOverride') return 'ltxDesktop.hostOverrideError'
  if (reply.kind === 'invalid' && pairing) return 'ltxDesktop.codeError'
  if (reply.kind === 'invalidResponse') return 'ltxDesktop.invalidResponse'
  if (reply.kind === 'fileError') return 'ltxDesktop.fileError'
  if (reply.kind === 'offline') return 'ltxDesktop.offline'
  if (reply.kind === 'unsafeAddress') return 'ltxDesktop.addressError'
  if (reply.kind === 'unsupported') return 'ltxDesktop.unsupported'
  if (reply.kind === 'failed') return reply.code === 'cancelled' ? 'ltxDesktop.cancelled' : 'ltxDesktop.failed'
  if (reply.kind === 'http') {
    if (pairing && [400, 401, 404, 409, 410, 422].includes(reply.status)) return 'ltxDesktop.codeError'
    if (reply.status === 401) return 'ltxDesktop.unpaired'
    if (reply.status === 404) return 'ltxDesktop.notFound'
    if (reply.status === 429) return 'ltxDesktop.rateLimit'
  }
  return 'ltxDesktop.failed'
}

// Explicitly stopping a Desktop job also requests cancellation at the provider.
export class LtxStopRequest extends DOMException {
  constructor(message: string) {
    super(message, 'AbortError')
  }
}
