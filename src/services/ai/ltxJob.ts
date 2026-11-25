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

/** Stop waiting on IPC while an in-flight read finishes and cleans up in the background. */
export async function waitForLtxRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read()
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([read(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
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
  const deadline = Date.now() + 30 * 60_000
  let delay = 5000 + Math.random() * 1000
  let failures = 0
  while (Date.now() + delay < deadline) {
    await options.wait(delay)
    const reply = await options.status()
    if (reply.kind === 'pending' || reply.kind === 'processing') {
      options.progress(reply.kind)
      failures = 0
      delay = 5000 + Math.random() * 1000
      continue
    }
    if (reply.kind === 'completed') {
      options.progress('downloading')
      try {
        return await options.download(reply.url)
      } catch {
        options.signal?.throwIfAborted()
        // Query the completed job again to refresh its signed URL.
      }
    } else if (reply.kind !== 'network' &&
      !(reply.kind === 'http' && (reply.status === 429 || reply.status >= 500))) {
      return await options.failure(reply)
    }
    failures += 1
    delay = Math.max(Math.min(60_000, 5000 * 2 ** failures),
      reply.kind === 'http' ? reply.retryAfterMs || 0 : 0)
  }
  return options.timeout()
}
