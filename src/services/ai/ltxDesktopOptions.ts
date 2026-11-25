export const LTX_DESKTOP_PROVIDER = 'ltx-desktop'
export const LTX_DESKTOP_DEFAULT_URL = 'http://Mac-Studio-M5-Ultra.local:41955'
export const LTX_DESKTOP_WORKFLOW = 'ltx-2.3-fast'
export const LTX_DESKTOP_MODELS = [LTX_DESKTOP_WORKFLOW, 'ltx-2.5-fast']
export const LTX_DESKTOP_DURATIONS = [2, 3, 4, 5, 6, 8, 10, 20]

export function isLtxDesktop(profile?: { provider?: string }) {
  return profile?.provider === LTX_DESKTOP_PROVIDER
}

export function isLtxTask(taskId?: string) {
  return taskId?.startsWith('ltx:') || taskId?.startsWith('ltx-desktop:')
}

export type LtxDesktopOperation =
  | { kind: 'pair'; code: string }
  | { kind: 'check' }
  | { kind: 'submit'; first: string; last?: string; model: string; prompt: string; duration: number; resolution: '720p' | '1080p'; aspect: '16:9' | '9:16' }
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
