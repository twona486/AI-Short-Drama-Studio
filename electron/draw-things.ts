import http from 'node:http'
import https from 'node:https'
import { isIPv4 } from 'node:net'
import { lanOrigin, pinAddress } from './lan-origin'
import { drawThingsGrpcTimeouts, grpcReferencesFit, requestDrawThingsGrpc } from './draw-things-grpc'
import {
  DRAW_THINGS_GRPC_PORT, DRAW_THINGS_MAX_SECRET_BYTES, DRAW_THINGS_PORT, drawThingsInputError, drawThingsPreset, isDrawThingsGrpc,
  type DrawThingsRequest, type DrawThingsReply, type DrawThingsProgress
} from '../src/services/ai/drawThingsOptions'

class HttpFailure extends Error {
  constructor(readonly status: number, detail: string) { super(detail) }
}

const MAX_RESPONSE = 24 * 1024 * 1024
const MAX_REFERENCE = 12 * 1024 * 1024
const validId = (id: unknown) => typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id)

async function requestJson(origin: URL, address: string, path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const secure = origin.protocol === 'https:'
  const port = origin.port || (secure ? '443' : '80')
  const payload = body ? JSON.stringify(body) : undefined
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      hostname: address,
      servername: isIPv4(origin.hostname) ? undefined : origin.hostname,
      port, path, signal, method: payload ? 'POST' : 'GET',
      headers: {
        Host: origin.host,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, async (res) => {
      try {
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of res) {
          length += chunk.length
          if (length > (body ? MAX_RESPONSE : 128 * 1024)) throw new SyntaxError('Response too large')
          chunks.push(chunk)
        }
        const status = res.statusCode || 500
        const raw = Buffer.concat(chunks, length).toString('utf8')
        if (status < 200 || status >= 300) throw new HttpFailure(status, raw)
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.once('error', reject)
    req.end(payload)
  })
}

async function send(
  request: DrawThingsRequest,
  cancel: AbortSignal,
  progress: (progress: DrawThingsProgress) => void,
  grpcTimeouts: typeof drawThingsGrpcTimeouts
): Promise<DrawThingsReply> {
  if (typeof request.baseUrl !== 'string') return { kind: 'unsafeAddress' }
  const grpc = isDrawThingsGrpc(request.baseUrl)
  if (grpc && request.sharedSecret !== undefined &&
    (typeof request.sharedSecret !== 'string' || Buffer.byteLength(request.sharedSecret) > DRAW_THINGS_MAX_SECRET_BYTES)) {
    return { kind: 'invalidRequest' }
  }
  let origin: URL
  let address: string
  try {
    const url = grpc ? request.baseUrl.trim().replace(/^grpc:\/\//i, 'http://') : request.baseUrl
    origin = lanOrigin(url, grpc ? DRAW_THINGS_GRPC_PORT : DRAW_THINGS_PORT)
    address = await pinAddress(origin)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { kind: code && /^(?:ENOTFOUND|EAI_AGAIN)$/.test(code) ? 'offline' : 'unsafeAddress' }
  }
  const signal = AbortSignal.timeout(request.kind === 'check' ? 8000 : 20 * 60_000)
  try {
    if (request.kind === 'check') {
      if (grpc) return await requestDrawThingsGrpc(address, origin.port || '80', request, cancel, progress, grpcTimeouts)
      const settings = await requestJson(origin, address, '/sdapi/v1/options', signal) as Record<string, unknown> | null
      return settings && typeof settings.width === 'number' && typeof settings.height === 'number'
        ? { kind: 'ready' } : { kind: 'invalidResponse' }
    }
    const { width, height, model, prompt, reference, referencePixels } = request
    const preset = typeof model === 'string' && drawThingsPreset(model)
    if (grpc && (!Array.isArray(referencePixels) || reference !== undefined)) return { kind: 'invalidRequest' }
    if (!grpc && referencePixels !== undefined) return { kind: 'invalidRequest' }
    const count = referencePixels?.length ?? (reference === undefined ? 0 : 1)
    if (!preset || model.length > 256 || drawThingsInputError(model, count, grpc) ||
      typeof prompt !== 'string' || !prompt.trim() || prompt.length > 40_000 ||
      ![width, height].every((dimension) => Number.isInteger(dimension) && dimension >= 128 && dimension <= 2048 && dimension % 64 === 0) ||
      (reference !== undefined && (typeof reference !== 'string' || !reference || reference.length > MAX_REFERENCE ||
        !/^[a-z\d+/]+={0,2}$/i.test(reference) || reference.length % 4 !== 0))) return { kind: 'invalidRequest' }
    if (grpc) {
      if (!grpcReferencesFit(width, height, count)) return { kind: 'referenceTooLarge' }
      if (!referencePixels?.every((pixels) => pixels instanceof ArrayBuffer && pixels.byteLength === width * height * 4)) {
        return { kind: 'invalidRequest' }
      }
      return await requestDrawThingsGrpc(address, origin.port || '80', request, cancel, progress, grpcTimeouts)
    }

    const { steps, cfg_scale, sampler_name, shift, resolution_dependent_shift } = preset
    const path = reference ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img'
    const result = await requestJson(origin, address, path, signal, {
      model, prompt, width, height, steps, cfg_scale, sampler_name, shift, resolution_dependent_shift,
      seed: -1, batch_size: 1, batch_count: 1, hires_fix: false, upscaler: null, refiner_model: null,
      negative_prompt: preset.references.min > 0 ? ' ' : '', controls: [], loras: [], tea_cache: false,
      ...(reference ? { strength: 1, init_images: [reference] } : {})
    }) as { images?: unknown[] } | null
    const encoded = Array.isArray(result?.images) ? result.images[0] : undefined
    if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || !/^[a-z\d+/]+={0,2}$/i.test(encoded)) {
      return { kind: 'invalidResponse' }
    }
    const bytes = Buffer.from(encoded, 'base64')
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (!png && !jpeg) return { kind: 'invalidResponse' }
    const data = Uint8Array.from(bytes).buffer
    return { kind: 'image', data, mimeType: png ? 'image/png' : 'image/jpeg' }
  } catch (error) {
    if (signal.aborted) return { kind: 'timeout' }
    if (error instanceof HttpFailure) {
      if (error.status === 422 && /missing (?:files|file)|unrecognized model name/i.test(error.message)) {
        return { kind: 'missingModel' }
      }
      return { kind: 'http', status: error.status }
    }
    return { kind: error instanceof SyntaxError ? 'invalidResponse' : 'offline' }
  }
}

type Job = {
  owner: number
  request: Extract<DrawThingsRequest, { kind: 'generate' }>
  onProgress: (progress: DrawThingsProgress) => void
  resolve: (reply: DrawThingsReply) => void
  controller: AbortController
}

export function createDrawThingsQueue(grpcTimeouts = drawThingsGrpcTimeouts) {
  const pending: Job[] = []
  let active: Job | undefined

  async function drain() {
    if (active) return
    try {
      while ((active = pending.shift())) {
        const job = active
        job.onProgress(undefined)
        job.resolve(await send(job.request, job.controller.signal, job.onProgress, grpcTimeouts))
      }
    } finally {
      active = undefined
    }
  }

  return {
    request(owner: number, request: DrawThingsRequest, onProgress: (progress: DrawThingsProgress) => void = () => {}): Promise<DrawThingsReply> {
      const controller = new AbortController()
      if (request?.kind === 'check') return send(request, controller.signal, onProgress, grpcTimeouts)
      if (request?.kind !== 'generate' || !validId(request.id)) return Promise.resolve({ kind: 'invalidRequest' })
      return new Promise((resolve) => {
        pending.push({ owner, request, onProgress, resolve, controller })
        void drain()
      })
    },
    cancel(owner: number, id?: string) {
      // HTTP에는 중단 API가 없다. 실행 중인 요청의 응답을 받은 후 다음 요청을 시작한다.
      if (active?.owner === owner && (id === undefined || active.request.id === id) &&
        typeof active.request.baseUrl === 'string' && isDrawThingsGrpc(active.request.baseUrl)) {
        active.controller.abort()
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].owner !== owner || (id !== undefined && pending[i].request.id !== id)) continue
        const [job] = pending.splice(i, 1)
        job.resolve({ kind: 'cancelled' })
      }
    }
  }
}
