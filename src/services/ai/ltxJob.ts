import type { LtxBody, LtxReply } from './ltxOptions'

export function ltxRequestBody(input: {
  first: string
  last?: string
  prompt: string
  model: string
  duration: number
  resolution: '720p' | '1080p'
  portrait: boolean
  audio?: boolean
}): LtxBody {
  const [width, height] = input.resolution === '1080p' ? [1920, 1080] : [1280, 720]
  return {
    image_uri: input.first,
    last_frame_uri: input.last,
    prompt: input.prompt.trim(),
    model: input.model,
    duration: input.duration,
    resolution: input.portrait ? `${height}x${width}` : `${width}x${height}`,
    fps: 24,
    generate_audio: input.audio ?? true
  }
}

type PollStep<T> =
  | { kind: 'waiting' }
  | { kind: 'retry'; retryAfterMs?: number }
  | { kind: 'done'; value: T }

export async function pollLtx<T>(options: {
  intervalMs: number
  jitterMs?: number
  deadlineMs: number
  wait: (ms: number) => Promise<void>
  step: () => Promise<PollStep<T>>
  timeout: () => never
}): Promise<T> {
  const deadline = Date.now() + options.deadlineMs
  const nextInterval = () => options.intervalMs + Math.random() * (options.jitterMs ?? 0)
  let delay = nextInterval()
  let failures = 0
  while (Date.now() + delay < deadline) {
    await options.wait(delay)
    const step = await options.step()
    if (step.kind === 'done') return step.value
    if (step.kind === 'waiting') {
      failures = 0
      delay = nextInterval()
    } else {
      failures += 1
      delay = Math.max(Math.min(60_000, options.intervalMs * 2 ** failures), step.retryAfterMs ?? 0)
    }
  }
  return options.timeout()
}

export function isTransientLtxHttp(status: number) {
  return status === 429 || status >= 500
}

export async function pollLtxJob<T>(options: {
  status: () => Promise<LtxReply>
  download: (url: string) => Promise<T>
  wait: (ms: number) => Promise<void>
  progress: (status: 'pending' | 'processing' | 'downloading') => void
  signal?: AbortSignal
  timeout: () => never
  failure: (reply: LtxReply) => Promise<never>
}): Promise<T> {
  return pollLtx<T>({
    intervalMs: 5000,
    jitterMs: 1000,
    deadlineMs: 30 * 60_000,
    wait: options.wait,
    timeout: options.timeout,
    async step() {
      const reply = await options.status()
      if (reply.kind === 'pending' || reply.kind === 'processing') {
        options.progress(reply.kind)
        return { kind: 'waiting' }
      }
      if (reply.kind === 'completed') {
        options.progress('downloading')
        try {
          return { kind: 'done', value: await options.download(reply.url) }
        } catch {
          options.signal?.throwIfAborted()
          // Query again to refresh the signed URL.
          return { kind: 'retry' }
        }
      }
      if (reply.kind === 'network') return { kind: 'retry' }
      if (reply.kind === 'http' && isTransientLtxHttp(reply.status)) {
        return { kind: 'retry', retryAfterMs: reply.retryAfterMs }
      }
      return options.failure(reply)
    }
  })
}
