import { lanOrigin, pinAddress, tailscaleIPv4 } from './lan-origin'
import { isIPv4 } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { validLtxImage } from './ltx'
import { lipSyncDuration, lipSyncPcm } from '../src/services/ai/lipSyncWav'
import { ltxDurationOptions } from '../src/services/ai/ltxOptions'
import {
  LTX_DESKTOP_RESOLUTIONS,
  LTX_DESKTOP_AUDIO_RESOLUTIONS,
  ltxDesktopAudioMax,
  LTX_DESKTOP_MODELS,
  type LtxDesktopReply,
  type LtxDesktopRequest
} from '../src/services/ai/ltxDesktopOptions'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const SIGNED_VIDEO = /^\/api\/assets\/[A-Za-z0-9_-]{1,128}\/bytes\?[^#\s]{1,1024}$/

export function desktopOrigin(raw: string) {
  return lanOrigin(raw, '41955')
}

export function desktopHostHeader(origin: URL, address: string, override?: string) {
  if (override !== undefined && typeof override !== 'string') throw new Error('Invalid Host header')
  const value = override?.trim()
  if (value) {
    const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(value)
    if (!match || value.length > 253 || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
      throw new Error('Invalid Host header')
    }
    return value
  }
  const port = origin.port || (origin.protocol === 'https:' ? '443' : '80')
  const host = tailscaleIPv4(address) || origin.hostname.endsWith('.ts.net') ? 'localhost' : address
  return `${host}:${port}`
}

function requestBytes(origin: URL, address: string, hostHeader: string, path: string, config: {
  method?: 'GET' | 'POST'
  token?: string
  body?: Uint8Array
  contentType?: string
  video?: boolean
} = {}) {
  const maxBytes = config.video ? 256 * 1024 * 1024 : 8 * 1024 * 1024
  const secure = origin.protocol === 'https:'
  const transport = secure ? https : http
  const port = origin.port || (secure ? '443' : '80')
  return new Promise<{ status: number; data: Buffer }>((resolve, reject) => {
    const headers: Record<string, string | number> = { Host: hostHeader }
    if (config.token) headers.Authorization = `Bearer ${config.token}`
    if (config.contentType) headers['Content-Type'] = config.contentType
    if (config.body) headers['Content-Length'] = config.body.byteLength
    const req = transport.request({
      hostname: address, servername: isIPv4(origin.hostname) ? undefined : origin.hostname,
      headers, method: config.method || 'GET', port, path,
      signal: AbortSignal.timeout(config.video ? 180_000 : 30_000)
    }, async (res) => {
      try {
        const status = res.statusCode || 500
        if (status < 200 || status >= 300) {
          res.destroy()
          resolve({ status, data: Buffer.alloc(0) })
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of res) {
          length += chunk.length
          if (length > maxBytes) throw new Error('Response too large')
          chunks.push(chunk)
        }
        resolve({ status, data: Buffer.concat(chunks, length) })
      } catch (error) {
        reject(error)
      }
    })
    req.once('error', reject)
    req.end(config.body)
  })
}

class HttpFailure extends Error {
  constructor(readonly status: number) { super() }
}

export async function requestLtxDesktop(request: LtxDesktopRequest): Promise<LtxDesktopReply> {
  let origin: URL
  try {
    origin = desktopOrigin(request.baseUrl)
  } catch {
    return { kind: 'unsafeAddress' }
  }

  try {
    const address = await pinAddress(origin)
    let hostHeader: string
    try {
      hostHeader = desktopHostHeader(origin, address, request.hostOverride)
    } catch {
      return { kind: 'invalidHostOverride' }
    }
    const op = request.operation
    const token = request.token
    const raw = async (path: string, config?: Parameters<typeof requestBytes>[4]) => {
      const response = await requestBytes(origin, address, hostHeader, path, config)
      if (response.status < 200 || response.status >= 300) throw new HttpFailure(response.status)
      return response.data
    }
    const json = async (path: string, body?: object) => JSON.parse(
      (await raw(path, {
        method: body ? 'POST' : 'GET', token,
        body: body ? Buffer.from(JSON.stringify(body)) : undefined,
        contentType: body ? 'application/json' : undefined
      })).toString('utf8')
    )
    if (op.kind === 'pair') {
      if (typeof op.code !== 'string' || !op.code || op.code.length > 2048) return { kind: 'invalid' }
      let code = op.code
      if (code.includes('://')) {
        try {
          const link = new URL(code)
          if (!['http:', 'https:'].includes(link.protocol) || link.pathname !== '/pairing') return { kind: 'invalid' }
          code = link.searchParams.get('t') || ''
        } catch {
          return { kind: 'invalid' }
        }
      }
      if (!code || code.length > 128) return { kind: 'invalid' }
      const paired = await json('/api/pairing/exchange', { code })
      return typeof paired?.token === 'string' && paired.token.length >= 16
        ? { kind: 'paired', token: paired.token } : { kind: 'invalid' }
    }
    if (!token || typeof token !== 'string' || token.length > 512) return { kind: 'http', status: 401 }
    if (op.kind === 'check') {
      await json('/api/session')
      return { kind: 'ready' }
    }
    if (op.kind === 'submit' || op.kind === 'submitAudio' || op.kind === 'checkAudio') {
      if (!LTX_DESKTOP_MODELS.includes(op.model) || !LTX_DESKTOP_RESOLUTIONS.includes(op.resolution) ||
        !['16:9', '9:16'].includes(op.aspect)) return { kind: 'invalid' }
      if (op.kind !== 'checkAudio' && (typeof op.prompt !== 'string' || op.prompt.length > 5000)) return { kind: 'invalid' }
      if (op.kind === 'submit' && (!validLtxImage(op.first) || (op.last !== undefined && !validLtxImage(op.last)) ||
        !ltxDurationOptions(op.model, op.resolution).includes(op.duration))) return { kind: 'invalid' }
      let audioDuration = 0
      if (op.kind === 'submitAudio') {
        if (!(op.audio instanceof ArrayBuffer) || op.audio.byteLength > 960_044 ||
          (op.first !== undefined && !validLtxImage(op.first))) return { kind: 'invalid' }
        try {
          audioDuration = lipSyncDuration(lipSyncPcm(op.audio))
        } catch {
          return { kind: 'invalid' }
        }
        if (audioDuration < 2 || audioDuration > ltxDesktopAudioMax(op.resolution) || !op.prompt.trim()) {
          return { kind: 'invalid' }
        }
      }

      const specs = await json('/api/generate/models-specs')
      const local = Array.isArray(specs.downloaded_local_models) ? specs.downloaded_local_models : []
      const offering = local.find((entry: any) => entry?.model === op.model)
      const spec = offering?.spec
      const aspectSpec = spec?.aspect_specs?.[op.aspect]
      if (op.kind === 'submit') {
        const grid = aspectSpec?.supported_resolutions_durations ?? spec?.supported_resolutions_durations
        if (!offering || spec?.capabilities?.i2v === false ||
          !grid?.[op.resolution]?.fps_to_durations?.['24']?.includes(op.duration)) return { kind: 'unsupported' }
      } else {
        const grid = aspectSpec?.a2v_supported_resolutions_durations ?? spec?.a2v_supported_resolutions_durations
        const durations = grid?.[op.resolution]?.fps_to_durations?.['24']
        if (!LTX_DESKTOP_AUDIO_RESOLUTIONS.includes(op.resolution) || spec?.capabilities?.a2v !== true ||
          !Array.isArray(durations) || !durations.some((seconds: number) => seconds >= Math.max(2, audioDuration))) {
          return { kind: 'unsupported' }
        }
        if (op.kind === 'checkAudio') return { kind: 'ready' }
      }

      const upload = async (bytes: ArrayBuffer, mime: string, filename: string, expectedKind?: string) => {
        const form = new FormData()
        form.set('file', new Blob([bytes], { type: mime }), filename)
        const multipart = new Request(origin, { method: 'POST', body: form })
        const asset = JSON.parse((await raw('/api/assets/upload', {
          method: 'POST', token, body: new Uint8Array(await multipart.arrayBuffer()),
          contentType: multipart.headers.get('content-type') || undefined
        })).toString('utf8'))
        if (typeof asset?.id !== 'string' || !ID.test(asset.id) || (expectedKind && asset.media_kind !== expectedKind)) throw new Error('Invalid asset ID')
        return { assetId: asset.id }
      }
      const uploadFrame = (image: string) => {
        const [meta, bytes] = image.split(',')
        const mime = meta.slice(5, -7)
        const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice(6)
        return upload(Uint8Array.from(Buffer.from(bytes, 'base64')).buffer, mime, `frame.${ext}`)
      }
      const audio = op.kind === 'submitAudio' ? await upload(op.audio, 'audio/wav', 'dialogue.wav', 'audio') : undefined
      const startFrame = op.first ? await uploadFrame(op.first) : undefined
      const params = { model: op.model, prompt: op.prompt, aspectRatio: op.aspect, resolution: op.resolution, fps: 24 }
      const job = op.kind === 'submitAudio'
        ? await json('/api/generations/audio-to-video', {
          contract_version: 1, params, inputs: { audio, startFrame }
        })
        : await json('/api/generations/image-to-video', {
          contract_version: 1, params: { ...params, duration: op.duration },
          inputs: { startFrame, endFrame: op.last ? await uploadFrame(op.last) : undefined }
        })
      return typeof job?.id === 'string' && ID.test(job.id)
        ? { kind: 'submitted', id: job.id } : { kind: 'invalid' }
    }
    if (op.kind === 'download') {
      if (typeof op.path !== 'string' || !SIGNED_VIDEO.test(op.path)) return { kind: 'invalid' }
      const data = await raw(op.path, { video: true })
      if (data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp') return { kind: 'invalid' }
      return { kind: 'video', data: Uint8Array.from(data).buffer }
    }
    if (op.kind !== 'status' && op.kind !== 'cancel') return { kind: 'invalid' }
    if (typeof op.id !== 'string' || !ID.test(op.id)) return { kind: 'invalid' }
    const jobPath = '/api/generations/' + op.id
    const job = op.kind === 'cancel' ? await json(jobPath + '/cancel', {}) : await json(jobPath)
    if (job?.id !== op.id) return { kind: 'invalid' }
    if (job.status === 'queued') return { kind: 'pending' }
    if (job.status === 'running' || job.status === 'cancelling') {
      if (op.kind === 'cancel') return { kind: 'processing' }
      const queue = await json('/api/generation-queue').catch(() => undefined)
      const entry = Array.isArray(queue?.active) && queue.active.find((item: any) => item?.generation?.id === op.id)
      const progress = entry?.progress
      return {
        kind: 'processing',
        percent: Number.isFinite(progress?.progress) ? Math.max(0, Math.min(100, progress.progress)) : undefined,
        remainingSeconds: Number.isFinite(progress?.remainingSeconds) ? Math.max(0, Math.ceil(progress.remainingSeconds)) : undefined
      }
    }
    if (job.status === 'failed' || job.status === 'cancelled') return { kind: 'failed', code: job.status }
    if (job.status === 'succeeded' && Array.isArray(job.outputs)) {
      const output = job.outputs.find((asset: any) => asset?.media_kind === 'video' && asset.mime_type === 'video/mp4')
      if (typeof output?.bytes_url === 'string' && SIGNED_VIDEO.test(output.bytes_url)) {
        return { kind: 'completed', path: output.bytes_url }
      }
    }
    return { kind: 'invalid' }
  } catch (error) {
    return error instanceof HttpFailure ? { kind: 'http', status: error.status } : { kind: 'offline' }
  }
}
