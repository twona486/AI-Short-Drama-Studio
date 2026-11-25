import { lookup } from 'node:dns/promises'
import { isIPv4 } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { validLtxImage } from './ltx'
import {
  LTX_DESKTOP_DURATIONS,
  LTX_DESKTOP_MODELS,
  type LtxDesktopReply,
  type LtxDesktopRequest
} from '../src/services/ai/ltxDesktopOptions'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const SIGNED_VIDEO = /^\/api\/assets\/[A-Za-z0-9_-]{1,128}\/bytes\?[^#\s]{1,1024}$/

function tailscaleIPv4(address: string) {
  return isIPv4(address) && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)
}

function privateIPv4(address: string) {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return tailscaleIPv4(address) || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function desktopOrigin(raw: string): URL {
  const value = raw.trim()
  const absolute = value.includes('://') ? value : `http://${value}`
  const url = new URL(absolute)
  const named = url.hostname === 'localhost' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|ts\.net)$/i.test(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || (!named && !privateIPv4(url.hostname))) throw new Error('Invalid LAN address')
  if (!url.port && !/:\d+(?:[/?#]|$)/.test(absolute.slice(absolute.indexOf('://') + 3))) url.port = '41955'
  return url
}

async function pinAddress(url: URL): Promise<string> {
  if (privateIPv4(url.hostname)) return url.hostname
  if (url.hostname === 'localhost') return '127.0.0.1'
  const records = await lookup(url.hostname, { all: true, family: 4 })
  const allowed = url.hostname.endsWith('.ts.net') ? tailscaleIPv4 : privateIPv4
  if (!records.length || records.some(({ address }) => !allowed(address))) {
    throw new Error('LAN host did not resolve to private IPv4')
  }
  return records[0].address
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
    if (op.kind === 'submit') {
      if (!validLtxImage(op.first) || (op.last !== undefined && !validLtxImage(op.last)) ||
        !LTX_DESKTOP_MODELS.includes(op.model) || typeof op.prompt !== 'string' || op.prompt.length > 5000 ||
        !LTX_DESKTOP_DURATIONS.includes(op.duration) || !['720p', '1080p'].includes(op.resolution) ||
        !['16:9', '9:16'].includes(op.aspect)) return { kind: 'invalid' }
      const specs = await json('/api/generate/models-specs')
      const local = Array.isArray(specs.downloaded_local_models) ? specs.downloaded_local_models : []
      const offering = local.find((entry: any) => entry?.model === op.model)
      const grid = offering?.spec?.aspect_specs?.[op.aspect]?.supported_resolutions_durations ||
        offering?.spec?.supported_resolutions_durations
      if (!offering || offering.spec?.capabilities?.i2v === false ||
        !grid?.[op.resolution]?.fps_to_durations?.['24']?.includes(op.duration)) return { kind: 'unsupported' }

      const upload = async (image: string) => {
        const [meta, bytes] = image.split(',')
        const mime = meta.slice(5, -7)
        const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice(6)
        const form = new FormData()
        form.set('file', new Blob([Uint8Array.from(Buffer.from(bytes, 'base64'))], { type: mime }), `frame.${ext}`)
        const multipart = new Request(origin, { method: 'POST', body: form })
        const asset = JSON.parse((await raw('/api/assets/upload', {
          method: 'POST', token, body: new Uint8Array(await multipart.arrayBuffer()),
          contentType: multipart.headers.get('content-type') || undefined
        })).toString('utf8'))
        if (typeof asset?.id !== 'string' || !ID.test(asset.id)) throw new Error('Invalid asset ID')
        return { assetId: asset.id }
      }
      const startFrame = await upload(op.first)
      const endFrame = op.last ? await upload(op.last) : undefined
      const job = await json('/api/generations/image-to-video', {
        contract_version: 1,
        params: { model: offering.model, prompt: op.prompt, aspectRatio: op.aspect, duration: op.duration, resolution: op.resolution, fps: 24 },
        inputs: { startFrame, endFrame }
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
