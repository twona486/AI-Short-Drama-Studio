export const LTX_DESKTOP_PROVIDER = 'ltx-desktop'
export const LTX_DESKTOP_URL_PLACEHOLDER = 'http://<호스트>:41955'
export const LTX_DESKTOP_WORKFLOW = 'ltx-2.3-fast'
export const LTX_DESKTOP_MODELS = [LTX_DESKTOP_WORKFLOW, 'ltx-2.5-fast']
export const LTX_DESKTOP_LOW_RESOLUTIONS = ['270p', '360p', '540p'] as const
export const LTX_DESKTOP_RESOLUTIONS = [...LTX_DESKTOP_LOW_RESOLUTIONS, '720p', '1080p'] as const
export type LtxDesktopResolution = typeof LTX_DESKTOP_RESOLUTIONS[number]

export function ltxDesktopResolution(value?: string): LtxDesktopResolution {
  return LTX_DESKTOP_RESOLUTIONS.find((resolution) => resolution === value) ?? '720p'
}

export const LTX_DESKTOP_DURATIONS = [2, 3, 4, 5, 6, 8, 10, 20]
export const LTX_DESKTOP_AUDIO_RESOLUTIONS: readonly LtxDesktopResolution[] = ['540p', '720p', '1080p']

export function ltxDesktopAudioResolution(value?: string): LtxDesktopResolution {
  return LTX_DESKTOP_AUDIO_RESOLUTIONS.find((resolution) => resolution === value) ?? '540p'
}

export function ltxDesktopModel(workflowId?: string) {
  return workflowId && LTX_DESKTOP_MODELS.includes(workflowId) ? workflowId : LTX_DESKTOP_WORKFLOW
}

export function ltxDesktopAudioMax(resolution?: string) {
  return resolution === '1080p' ? 10 : 20
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
  hostOverride?: string
  token?: string
  operation: LtxDesktopOperation
}

export type LtxDesktopReply =
  | { kind: 'paired'; token: string }
  | { kind: 'ready' }
  | { kind: 'submitted'; id: string }
  | { kind: 'pending' | 'processing'; percent?: number; remainingSeconds?: number }
  | { kind: 'completed'; path: string }
  | { kind: 'video'; data: ArrayBuffer }
  | { kind: 'failed'; code: string }
  | { kind: 'http'; status: number }
  | { kind: 'unsafeAddress' | 'offline' | 'invalid' | 'unsupported' | 'invalidHostOverride' }

export function ltxDesktopError(reply: LtxDesktopReply, pairing = false) {
  if (reply.kind === 'invalidHostOverride') return 'ltxDesktop.hostOverrideError'
  if (reply.kind === 'invalid' && pairing) return 'ltxDesktop.codeError'
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
