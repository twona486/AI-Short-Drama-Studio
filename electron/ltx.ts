import { LTX_BASE_URL, LTX_MODELS, ltxDurationOptions } from '../src/services/ai/ltxOptions'

import type { LtxRequest, LtxReply } from '../src/services/ai/ltxOptions'

const JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/
const IMAGE_URI = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export function validLtxImage(uri: unknown): uri is string {
  return typeof uri === 'string' && uri.length <= 7_000_000 && IMAGE_URI.test(uri)
}

export async function requestLtx(fetcher: typeof fetch, request: LtxRequest): Promise<LtxReply> {
  if (!request || typeof request.apiKey !== 'string' || !request.apiKey.trim()) return { kind: 'invalid' }
  let url = LTX_BASE_URL + '/v2/image-to-video'
  const headers = { Authorization: `Bearer ${request.apiKey.trim()}`, 'Content-Type': 'application/json' }
  let body: string | undefined
  if ('body' in request) {
    const input = request.body
    if (!input || !validLtxImage(input.image_uri) ||
      (input.last_frame_uri !== undefined && !validLtxImage(input.last_frame_uri)) ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || [...input.prompt].length > 5000 ||
      !LTX_MODELS.includes(input.model) || !ltxDurationOptions(input.model).includes(input.duration) ||
      !['1280x720', '720x1280', '1920x1080', '1080x1920'].includes(input.resolution) ||
      input.fps !== 24 || typeof input.generate_audio !== 'boolean') return { kind: 'invalid' }
    const { image_uri, last_frame_uri, prompt, model, duration, resolution, fps, generate_audio } = input
    body = JSON.stringify({ image_uri, last_frame_uri, prompt, model, duration, resolution, fps, generate_audio })
  } else {
    if (typeof request.jobId !== 'string' || !JOB_ID.test(request.jobId)) return { kind: 'invalid' }
    url += '/' + request.jobId
  }
  try {
    const response = await fetcher(url, {
      method: body ? 'POST' : 'GET', headers, body,
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      const delay = retryAfter && (/^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - Date.now())
      return { kind: 'http', status: response.status, retryAfterMs: delay && delay > 0 ? delay : undefined }
    }
    const data = await response.json()
    if (body) {
      return typeof data?.id === 'string' && JOB_ID.test(data.id)
        ? { kind: 'submitted', id: data.id } : { kind: 'invalid' }
    }
    switch (data?.status) {
      case 'pending': return { kind: 'pending' }
      case 'processing': return { kind: 'processing' }
      case 'completed':
        return typeof data.result?.video_url === 'string' && data.result.video_url.startsWith('https://')
          ? { kind: 'completed', url: data.result.video_url } : { kind: 'invalid' }
      case 'failed':
        return { kind: 'failed', reason: data.error?.type === 'insufficient_funds_error' ? 'funds'
          : data.error?.type === 'content_filtered_error' ? 'filtered' : 'failed' }
      default: return { kind: 'invalid' }
    }
  } catch {
    return { kind: 'network' }
  }
}
