import { elevenLabsRequest } from './elevenLabsDesktop'
import { isElevenLabsTts } from './elevenLabsTts'
/**
 * OpenAI 호환 API, 사용자 지정 HTTP, AutoDL 및 기본 ComfyUI를 연결하는 어댑터
 * 설정의 adapter.type에 따라 연결 방식을 선택한다.
 */

import { t as translate, uiPunctuation } from '@/i18n'
import { consumeProviderFile, desktop, isDesktop, providerRequest } from '@/services/desktop'
import {
  applyComfyInputs,
  comfyRoleLabel,
  guessInputMap,
  fitComfyReferenceImages,
  isMediaRole,
  missingRoles,
  sanitizeInputMap,
  validateInputMap,
  type ComfyInputMap,
  type ComfyInjectValues,
  type ComfyInputRole
} from './comfyInputMap'
import { zealmanWorkflowById } from './zealman'
import { isLtxDesktop, ltxDesktopError } from './ltxDesktopOptions'
import { providerVideoResolution } from './modelOptions'
import { adaptOpenAiChatBody, isOfficialOpenAi, OPENAI_DEFAULT_CHAT_MODEL } from './openAiChat'
import { throwIfAborted } from './abort'
import { DRAW_THINGS_PROVIDER } from './drawThingsOptions'
import { checkDrawThings } from './drawThingsConnection'

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}


export type AdapterType =
  | 'openai-compatible'
  | 'openai-images'
  | 'http-custom'
  | 'comfyui-workflow'
  | 'zealman-workflow'
  | 'comfyui-prompt'

export interface AdapterConfig {
  /** 어댑터 유형. 값이 없으면 공급자나 URL로 추정한다. */
  type?: AdapterType
  /** baseUrl에 상대적인 요청 경로. 예를 들어 /images/generations 또는 /prompt다. */
  path?: string
  /** 작업 조회 경로. /history/{id}처럼 {id}를 포함할 수 있다. */
  pollPath?: string
  /** 설정 화면과 문서에서 쓰는 pollPath 별칭 */
  pollUrl?: string
  /** 제출 응답의 작업 ID 경로. 예를 들어 data.id다. */
  taskIdJsonPath?: string
  /** 조회 응답에서 상태나 중간 결과를 읽을 경로 */
  pollJsonPath?: string
  /** JSON 결과 URL의 점으로 구분한 경로. 예를 들어 data.0.url이다. */
  resultJsonPath?: string
  /** 인증 헤더 이름. 기본값은 Authorization이다. */
  authHeader?: string
  /** 인증 값 접두사. 기본값은 Bearer다. ComfyUI나 AutoDL은 빈 문자열도 허용한다. */
  authPrefix?: string
  /** API 형식의 ComfyUI 워크플로 JSON 문자열 */
  workflowTemplate?: string
  /**
   * 프롬프트, 참조 이미지, 인수를 전달할 노드 및 입력 필드의 매핑
   * 연결을 저장할 때 도우미가 매핑을 만들고 생성 시 그 위치에 값을 넣는다.
   */
  inputMap?: ComfyInputMap
  /** 추가 요청 헤더 */
  headers?: Record<string, string>
}

export type EndpointLike = {
  encryptedElevenLabsKey?: string
  drawThingsSharedSecret?: string
  baseUrl?: string
  ltxHostOverride?: string
  apiKey?: string
  model?: string
  workflowId?: string
  provider?: string
  adapter?: AdapterConfig
}

function trimSlash(url: string) {
  return (url || '').replace(/\/+$/, '')
}

export function isAutodlHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'autodl.art' || host.endsWith('.autodl.art')
  } catch {
    return /autodl\.art/i.test(url)
  }
}

export function isApimartHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'apimart.ai' ||
      host.endsWith('.apimart.ai') ||
      host === 'aiuxu.com' ||
      host.endsWith('.aiuxu.com') ||
      host === 'aishuch.com' ||
      host.endsWith('.aishuch.com')
    )
  } catch {
    return /apimart\.ai|aiuxu\.com|aishuch\.com/i.test(url)
  }
}

/** 공식 도메인과 /v1/tasks/{id}를 설정한 게이트웨이는 같은 비동기 생성 프로토콜을 사용한다. */
export function usesApimartProtocol(baseUrl: string, adapter?: AdapterConfig): boolean {
  if (isApimartHost(baseUrl)) return true
  const poll = `${adapter?.pollPath || ''} ${adapter?.pollUrl || ''}`
  const path = adapter?.path || ''
  return /\/tasks\/\{id\}/i.test(poll) && /generations/i.test(path)
}

export function isLocalComfyHost(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url)
  }
}

/** 이미지 어댑터 유형을 추정한다. */
export function resolveImageAdapter(ep: EndpointLike): AdapterType {
  if (isApimartHost(ep.baseUrl || '') || ep.provider === 'apimart') return 'http-custom'
  const t = ep.adapter?.type
  if (t === 'http-custom' || t === 'comfyui-prompt' || t === 'openai-images' || t === 'comfyui-workflow') {
    return t
  }
  // zealman-workflow로 선언된 연결만 Zealman 이미지 워크플로를 사용한다.
  if (t === 'zealman-workflow' && ep.provider === 'zealman') return 'zealman-workflow'
  if (t === 'openai-compatible') return 'openai-images'
  if (isAutodlHost(ep.baseUrl || '')) return 'comfyui-workflow'
  return 'openai-images'
}

/**
 * 저장한 별도 AutoDL 연결에는 활성 Zealman 연결의 설정을 적용하지 않는다.
 * autodl.art 주소이고 U01 또는 U02 워크플로가 아니면 남아 있는 zealman-workflow 어댑터를 제거한다.
 */
export function normalizeStoredVideoEndpoint<T extends EndpointLike>(ep: T): T {
  const zealmanWorkflow = Boolean(zealmanWorkflowById(ep.workflowId || ''))
  const autodlHost = isAutodlHost(ep.baseUrl || '')
  const leakedZealmanAdapter = ep.adapter?.type === 'zealman-workflow' && !zealmanWorkflow
  if ((autodlHost || ep.provider === 'autodl') && !zealmanWorkflow && (leakedZealmanAdapter || ep.provider === 'zealman')) {
    return {
      ...ep,
      provider: 'autodl',
      adapter: leakedZealmanAdapter ? undefined : ep.adapter
    }
  }
  return ep
}

/** 영상 어댑터를 추정한다. provider가 custom인 타사 HTTP 연결을 ComfyUI로 오인하지 않는다. */
export function resolveVideoAdapter(ep: EndpointLike): AdapterType {
  const normalized = normalizeStoredVideoEndpoint(ep)
  const url = normalized.baseUrl || ''
  if (isApimartHost(url) || normalized.provider === 'apimart') return 'http-custom'
  const t = normalized.adapter?.type
  const zealmanWorkflow = Boolean(zealmanWorkflowById(normalized.workflowId || ''))
  if (normalized.provider === 'zealman' && t === 'zealman-workflow' && zealmanWorkflow) return 'zealman-workflow'
  if (t === 'http-custom' || t === 'comfyui-prompt' || t === 'comfyui-workflow') return t
  if (t === 'zealman-workflow' && normalized.provider === 'zealman') return 'zealman-workflow'
  if (isAutodlHost(url) || normalized.provider === 'autodl') return 'comfyui-workflow'
  if (isLocalComfyHost(url) || /comfyui/i.test(url)) return 'comfyui-prompt'
  if (normalized.provider === 'custom' && /^https?:\/\//i.test(url)) return 'http-custom'
  // 이전 설정과 호환하도록 기본은 AutoDL 방식이다.
  return 'comfyui-workflow'
}

function withAuthSeparator(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed) return ''
  if (/^bearer$/i.test(trimmed)) return 'Bearer '
  if (/^(token|basic)$/i.test(trimmed)) return `${trimmed} `
  return /\s$/.test(prefix) ? prefix : prefix
}

export function buildAuthHeader(
  apiKey: string,
  adapter?: AdapterConfig
): Record<string, string> {
  let token = (apiKey || '').trim().replace(/^\uFEFF/, '').replace(/^['"]+|['"]+$/g, '')
  token = token.replace(/^bearer\s+/i, '').trim()
  if (!token) return {}
  const name = (adapter?.authHeader || 'Authorization').trim() || 'Authorization'
  const prefix = withAuthSeparator(
    adapter?.authPrefix === undefined || adapter?.authPrefix === null
      ? name.toLowerCase() === 'authorization'
        ? 'Bearer '
        : ''
      : String(adapter.authPrefix)
  )
  const prefixText = prefix && !token.toLowerCase().startsWith(prefix.trim().toLowerCase()) ? prefix : ''
  return { [name]: `${prefixText}${token}` }
}

export function getByJsonPath(data: unknown, path?: string): unknown {
  if (!path || !path.trim()) return undefined
  const parts = path
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let cur: any = data
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

/** 중첩 객체에서 미디어 URL로 보이는 첫 문자열을 찾는다. */
export function findFirstMediaUrl(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null
  if (typeof value === 'string') {
    const s = value.trim()
    if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findFirstMediaUrl(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['url', 'video_url', 'image_url', 'file_url', 'output', 'result']) {
      if (key in obj) {
        const hit = findFirstMediaUrl(obj[key], depth + 1)
        if (hit) return hit
      }
    }
    for (const v of Object.values(obj)) {
      const hit = findFirstMediaUrl(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export type ProxyHttpResult = {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<any>
  blob: () => Promise<Blob>
}

/**
 * 데스크톱에서 AutoDL 및 로컬 ComfyUI는 메인 프로세스로 호출하고 다른 HTTPS 요청은 직접 처리한다.
 * 브라우저에서는 fetch를 사용한다.
 */
export async function providerHttp(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    bodyBase64?: string
    form?: FormData
    contentType?: string
    signal?: AbortSignal
    timeoutMs?: number
    binary?: boolean
  } = {}
): Promise<ProxyHttpResult> {
  throwIfAborted(init.signal)
  const method = (init.method || 'GET').toUpperCase()
  const timeoutMs = init.timeoutMs ?? 60_000
  // 데스크톱 메인 프로세스에서 CORS 제한을 피하고 /view 바이너리를 읽는다.
  const preferProxy = isDesktop()

  if (preferProxy) {
    const api = desktop()
    if (typeof api.autodlFetch !== 'function') {
      throw new Error('AI Short Drama Studio를 완전히 종료하고 다시 시작하세요. 데스크톱 앱에 업데이트된 요청 경로가 필요합니다.')
    }
    const headers = init.headers || {}
    const auth =
      headers.Authorization ||
      headers.authorization ||
      Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ||
      ''
    const multipart = init.form ? new Response(init.form) : undefined
    const bodyBytes = await multipart?.arrayBuffer()
    throwIfAborted(init.signal)
    const res = await providerRequest(init.signal, (requestId) => api.autodlFetch({
      binary: init.binary,
      url,
      method,
      authorization: String(auth || ''),
      extraHeaders: Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')
      ),
      body: init.bodyBase64 || bodyBytes ? undefined : init.body,
      bodyBytes,
      requestId,
      bodyBase64: init.bodyBase64,
      contentType: multipart?.headers.get('content-type') || init.contentType,
      timeoutMs
    }), async (reply) => {
      if (reply.filePath) await api.remove(reply.filePath).catch(() => {})
    })
    const blob = res.filePath ? await consumeProviderFile(res.filePath, init.signal) : undefined
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text,
      json: async () => JSON.parse(res.text || '{}'),
      blob: async () => blob && blob.type === res.contentType ? blob : new Blob(
        [blob ?? res.text ?? ''], { type: res.contentType || 'application/octet-stream' }
      )
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort)
  try {
    const headers = { ...(init.headers || {}) }
    let body: BodyInit | undefined = init.form ?? init.body
    if (init.bodyBase64) {
      const binary = atob(init.bodyBase64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      body = bytes
      if (init.contentType) headers['Content-Type'] = init.contentType
    }
    const resp = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    })
    const bytes = await resp.arrayBuffer()
    const text = new TextDecoder().decode(bytes)
    return {
      ok: resp.ok,
      status: resp.status,
      text: async () => text,
      json: async () => {
        try {
          return JSON.parse(text || '{}')
        } catch {
          throw new Error(`응답이 JSON 형식이 아닙니다. ${text.slice(0, 120)}`)
        }
      },
      blob: async () => new Blob([bytes], { type: resp.headers.get('content-type') || 'application/octet-stream' })
    }
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
}

function joinUrl(baseUrl: string, path?: string) {
  const base = trimSlash(baseUrl)
  if (!path) return base
  if (/^https?:\/\//i.test(path)) return path
  return `${base}/${String(path).replace(/^\//, '')}`
}

function resolvePollTemplate(adapter?: AdapterConfig) {
  return (adapter?.pollUrl || adapter?.pollPath || '').trim()
}

function extractTaskId(data: any, adapter?: AdapterConfig): string {
  const fromPath = adapter?.taskIdJsonPath
    ? getByJsonPath(data, adapter.taskIdJsonPath)
    : undefined
  const first = Array.isArray(data?.data) ? data.data[0] : undefined
  const raw =
    fromPath ??
    data?.id ??
    data?.task_id ??
    data?.taskId ??
    data?.request_id ??
    first?.task_id ??
    first?.id ??
    getByJsonPath(data, 'data.0.task_id') ??
    getByJsonPath(data, 'data.id') ??
    getByJsonPath(data, 'data.task_id') ??
    getByJsonPath(data, 'output.task_id')
  return String(raw || '').trim()
}

async function mediaFromValue(
  picked: unknown,
  signal?: AbortSignal,
  fallbackMime = 'application/octet-stream'
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (typeof picked !== 'string' || !picked.trim()) return null
  const value = picked.trim()
  if (value.startsWith('data:')) {
    const m = value.match(/^data:([^;]+);base64,(.+)$/i)
    if (!m) throw new Error('데이터 URI를 해석할 수 없습니다.')
    const bin = atob(m[2].replace(/\s/g, ''))
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return { blob: new Blob([arr], { type: m[1] }), mimeType: m[1] }
  }
  if (/^https?:\/\//i.test(value)) {
    const r = await fetch(value, { signal })
    if (!r.ok) throw new Error(`결과를 다운로드하지 못했습니다. ${r.status}`)
    const blob = await r.blob()
    return { blob, mimeType: blob.type || fallbackMime }
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 256) {
    const raw = value.replace(/\s/g, '')
    const bin = atob(raw)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const mime =
      arr[0] === 0x89 && arr[1] === 0x50
        ? 'image/png'
        : arr[0] === 0xff && arr[1] === 0xd8
          ? 'image/jpeg'
          : arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70
            ? 'video/mp4'
            : fallbackMime
    return { blob: new Blob([arr], { type: mime }), mimeType: mime }
  }
  return null
}

async function mediaFromUnknown(
  picked: unknown,
  signal?: AbortSignal,
  fallbackMime = 'application/octet-stream'
): Promise<{ blob: Blob; mimeType: string } | null> {
  const direct = await mediaFromValue(picked, signal, fallbackMime)
  if (direct) return direct
  const url = findFirstMediaUrl(picked)
  if (!url || url === picked) return null
  return mediaFromValue(url, signal, fallbackMime)
}

function apimartSubmitPath(baseUrl: string, kind: 'image' | 'video'): string {
  const rooted = /\/v1$/i.test(trimSlash(baseUrl))
  const leaf = kind === 'video' ? 'videos/generations' : 'images/generations'
  return rooted ? `/${leaf}` : `/v1/${leaf}`
}

function apimartPollPath(baseUrl: string): string {
  return /\/v1$/i.test(trimSlash(baseUrl)) ? '/tasks/{id}?language=zh' : '/v1/tasks/{id}?language=zh'
}

function isGenericMediaPath(path: string | undefined, kind: 'image' | 'video'): boolean {
  const value = String(path || '').trim().replace(/^\//, '').toLowerCase()
  if (!value) return true
  if (kind === 'image') return value === 'images/generations' || value === 'v1/images/generations'
  return value === 'videos/generations' || value === 'v1/videos/generations'
}

/** APIMart에 생성 작업을 POST한 뒤 GET /v1/tasks/{id}로 조회한다. */
function apimartAdapterDefaults(
  baseUrl: string,
  adapter: AdapterConfig | undefined,
  kind: 'image' | 'video'
): AdapterConfig {
  const current = adapter || {}
  if (!usesApimartProtocol(baseUrl, current)) return current
  return {
    ...current,
    type: 'http-custom',
    path: isGenericMediaPath(current.path, kind) ? apimartSubmitPath(baseUrl, kind) : current.path,
    pollPath: current.pollPath || current.pollUrl || apimartPollPath(baseUrl),
    taskIdJsonPath: current.taskIdJsonPath || 'data.0.task_id',
    pollJsonPath: current.pollJsonPath || 'data.status',
    resultJsonPath: current.resultJsonPath || (kind === 'video' ? 'data.result.videos' : 'data.result.images'),
    authHeader: current.authHeader || 'Authorization',
    authPrefix: current.authPrefix ?? 'Bearer '
  }
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
}

function requestBodyForProvider(
  baseUrl: string,
  adapter: AdapterConfig | undefined,
  kind: 'image' | 'video',
  model: string,
  prompt: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  if (!usesApimartProtocol(baseUrl, adapter)) {
    return { model, prompt, ...(extra || {}) }
  }
  const source = extra || {}
  const listed = [...stringList(source.image_urls), ...stringList(source.images)]
  const images = listed.length ? listed : stringList(source.image)
  const body: Record<string, unknown> = { model, prompt }
  if (source.duration != null) body.duration = source.duration
  const rawRatio = source.aspect_ratio || source.aspectRatio || source.size
  const ratio = !rawRatio || rawRatio === 'auto' ? '16:9' : String(rawRatio)
  if (kind === 'video') {
    body.size = ratio
    body.aspect_ratio = ratio
    const seconds = Math.round(Number(source.duration) || 6)
    body.duration = /grok-imagine-1\.5/i.test(model) ? Math.min(15, Math.max(6, seconds || 6)) : seconds
    body.resolution = providerVideoResolution(model, String(source.resolution || ''))
    if (images.length) body.image_urls = images.slice(0, 7)
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'boolean' && /audio/i.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        body[key] = value
      }
    }
    return body
  }
  body.n = Math.max(1, Math.round(Number(source.n) || 1))
  body.size = ratio || source.size || '1:1'
  const tier = String(source.resolution || '2k').toLowerCase()
  body.resolution = tier.includes('4k') ? '4k' : tier === '1k' ? '1k' : '2k'
  if (images.length) {
    const refs = images.slice(0, 15)
    body.image = refs
    body.image_urls = refs
  }
  return body
}

/** 사용자 지정 HTTP 연결은 JSON을 POST한다. 필요하면 pollUrl/{id}를 조회하고 resultJsonPath에서 미디어를 읽는다. */
export async function httpCustomMediaGenerate(opts: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  adapter?: AdapterConfig
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
  kind?: 'image' | 'video'
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  const kind = opts.kind || 'image'
  const adapter = apimartAdapterDefaults(opts.baseUrl, opts.adapter, kind)
  const fallbackMime = kind === 'video' ? 'video/mp4' : 'image/png'
  const path = adapter.path || (kind === 'video' ? '/v1/videos/generations' : '/images/generations')
  const url = joinUrl(opts.baseUrl, path)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...buildAuthHeader(opts.apiKey, adapter),
    ...(adapter.headers || {})
  }
  const body = requestBodyForProvider(opts.baseUrl, adapter, kind, opts.model, opts.prompt, opts.extraBody)
  opts.onProgress?.('사용자 지정 API에 제출하는 중…')
  const res = await providerHttp(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
    timeoutMs: kind === 'video' ? 10 * 60_000 : 180_000
  })
  if (!res.ok) {
    const text = await res.text()
    const hint = res.status === 401 && usesApimartProtocol(url, adapter)
      ? '\n인증 헤더는 Bearer 뒤에 공백을 두고 키를 붙여야 합니다. 연결의 접두사와 키 사이에 공백이 있는지 확인하세요.'
      : ''
    throw new Error(`[${kind}] 사용자 지정 API 요청에 실패했습니다. ${res.status}\n요청 주소 ${url}\n${text.slice(0, 500)}${hint}`)
  }
  let data = await res.json()

  const pollTpl = resolvePollTemplate(adapter)
  if (pollTpl) {
    const taskId = extractTaskId(data, adapter)
    if (!taskId) {
      throw new Error(
        `[${kind}] 상태 조회를 설정했지만 제출 응답에 작업 ID가 없습니다. adapter.taskIdJsonPath를 설정하세요. 응답 일부 ${JSON.stringify(data).slice(0, 240)}`
      )
    }
    const started = Date.now()
    const timeoutMs = kind === 'video' ? 15 * 60_000 : 6 * 60_000
    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) throw new DOMException(translate('providerRequestErrors.aborted'), 'AbortError')
      await new Promise((r) => setTimeout(r, 1500))
      const pollUrl = /^https?:\/\//i.test(pollTpl)
        ? pollTpl.replace(/\{id\}/g, encodeURIComponent(taskId))
        : joinUrl(opts.baseUrl, pollTpl.replace(/\{id\}/g, encodeURIComponent(taskId)))
      opts.onProgress?.('작업 상태를 조회하는 중…')
      const poll = await providerHttp(pollUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...buildAuthHeader(opts.apiKey, adapter),
          ...(adapter.headers || {})
        },
        signal: opts.signal,
        timeoutMs: 60_000
      })
      if (!poll.ok) {
        if (poll.status === 401 || poll.status === 403) {
          throw new Error(`[${kind}] 작업 조회가 거부됐습니다. ${poll.status}\n요청 주소 ${pollUrl}\n${(await poll.text()).slice(0, 400)}`)
        }
        continue
      }
      data = await poll.json()
      const statusRaw = adapter.pollJsonPath
        ? getByJsonPath(data, adapter.pollJsonPath)
        : data?.status || data?.state || getByJsonPath(data, 'data.status')
      const status = String(statusRaw || '').toLowerCase()
      if (/fail|error|cancel/.test(status)) {
        const message =
          getByJsonPath(data, 'data.error.message') ||
          data?.error?.message ||
          data?.message ||
          statusRaw
        throw new Error(`[${kind}] 작업에 실패했습니다. ${String(message).slice(0, 300)}`)
      }
      const waiting = /^(pending|processing|submitted|queued|running|in_progress)$/.test(status)
      if (waiting) continue
      const picked =
        (adapter.resultJsonPath ? getByJsonPath(data, adapter.resultJsonPath) : undefined) ??
        findFirstMediaUrl(data)
      const media = await mediaFromUnknown(picked, opts.signal, fallbackMime)
      if (media) return media
      if (/^(completed|success|succeeded|succeed)$/.test(status)) {
        throw new Error(`[${kind}] 작업이 완료됐지만 응답에 미디어 주소가 없습니다. 응답 일부 ${JSON.stringify(data).slice(0, 240)}`)
      }
    }
    throw new Error(`[${kind}] 사용자 지정 API 상태 조회 시간이 초과됐습니다.`)
  }

  const picked =
    (adapter.resultJsonPath ? getByJsonPath(data, adapter.resultJsonPath) : undefined) ??
    getByJsonPath(data, 'data.0.b64_json') ??
    getByJsonPath(data, 'data.0.url') ??
    findFirstMediaUrl(data)
  const media = await mediaFromUnknown(picked, opts.signal, fallbackMime)
  if (media) return media
  throw new Error(
    `[${kind}] 사용자 지정 API 응답에서 미디어를 찾지 못했습니다. adapter.resultJsonPath를 설정하세요. 응답 일부 ${JSON.stringify(data).slice(0, 240)}`
  )
}

export async function httpCustomImageGenerate(opts: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  adapter?: AdapterConfig
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  return httpCustomMediaGenerate({ ...opts, kind: 'image' })
}


function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]+)?(;base64)?,/i.exec(dataUrl)
  if (!m) throw new Error('데이터 URL이 아니므로 업로드할 수 없습니다.')
  const head = m[0]
  const mime = m[1] || 'image/png'
  if (m[2]) {
    const bin = atob(dataUrl.slice(head.length))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, mime }
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(dataUrl.slice(head.length))), mime }
}

function extOfMime(mime: string): string {
  if (/jpe?g/i.test(mime)) return 'jpg'
  if (/webp/i.test(mime)) return 'webp'
  if (/gif/i.test(mime)) return 'gif'
  if (/mp4|webm/i.test(mime)) return 'mp4'
  if (/wav/i.test(mime)) return 'wav'
  if (/mpeg|mp3/i.test(mime)) return 'mp3'
  return 'png'
}

function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; mime: string; bytes: Uint8Array },
  fileField = 'image'
): { bodyBase64: string; contentType: string } {
  const boundary = `----aicust${Date.now().toString(36)}`
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const push = (s: string) => parts.push(enc.encode(s))
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
  }
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`
  )
  parts.push(file.bytes)
  push(`\r\n--${boundary}--\r\n`)
  const total = parts.reduce((n, p) => n + p.length, 0)
  const body = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    body.set(p, off)
    off += p.length
  }
  return { bodyBase64: bytesToBase64(body), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * 참조 이미지, 끝 프레임, 오디오를 먼저 ComfyUI에 업로드하고 반환된 파일명을 노드에 넣는다.
 * LoadImage는 data URL 대신 ComfyUI 입력 디렉터리의 파일명을 받는다.
 */
async function uploadComfyMedia(opts: {
  baseUrl: string
  dataUrl: string
  apiKey?: string
  adapter?: AdapterConfig
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<string> {
  const { bytes, mime } = dataUrlToBytes(opts.dataUrl)
  const name = `aicust-${crypto.randomUUID()}.${extOfMime(mime)}`
  const { bodyBase64, contentType } = buildMultipart({ type: 'input', overwrite: 'false' }, { name, mime, bytes }, 'image')
  opts.onProgress?.('ComfyUI에 참조 이미지를 업로드하는 중…')
  const base = trimSlash(opts.baseUrl).replace(/\/upload\/image$/i, '')
  const upload = (path: string) => providerHttp(joinUrl(base, path), {
    method: 'POST',
    headers: buildAuthHeader(opts.apiKey || '', {
      ...opts.adapter,
      authPrefix: opts.adapter?.authPrefix ?? (opts.apiKey ? 'Bearer ' : '')
    }),
    bodyBase64,
    contentType,
    signal: opts.signal,
    timeoutMs: 120_000
  })
  let path = '/upload/image'
  let res = await upload(path)
  if ((res.status === 404 || res.status === 405) && !/\/api$/i.test(base)) {
    path = '/api/upload/image'
    opts.onProgress?.(translate('comfyMapping.uploadRetry'))
    res = await upload(path)
  }
  const text = await res.text()
  if (!res.ok) {
    const target = new URL(joinUrl(base, path))
    throw new Error(translate('comfyMapping.uploadFailed', { url: target.origin + target.pathname, status: res.status }))
  }
  let json: any = {}
  try {
    json = JSON.parse(text || '{}')
  } catch {
    /* 일부 게이트웨이는 파일명을 일반 텍스트로 반환한다. */
  }
  const plain = text.trim()
  const filename = String(json.name || json.filename || (/^[^<>\r\n{}]+\.[a-z0-9]{2,8}$/i.test(plain) ? plain : '')).trim()
  if (!filename) throw new Error(`[comfyui] 업로드는 완료됐지만 파일 이름을 반환하지 않았습니다. ${text.slice(0, 160)}`)
  return [String(json.subfolder || '').trim(), filename].filter(Boolean).join('/')
}

/** 이전 템플릿의 플레이스홀더를 지원한다. 없으면 입력 매핑을 사용한다. */
function fillWorkflowTemplate(template: string, vars: Record<string, string>): any {
  let raw = template
  for (const [k, v] of Object.entries(vars)) {
    raw = raw.split(`{{${k}}}`).join(v.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
  }
  return JSON.parse(raw)
}

/** 기본 ComfyUI는 /prompt로 제출하고 /history/{id}로 조회한 뒤 /view에서 결과를 가져온다. */
export async function comfyPromptGenerate(opts: {
  baseUrl: string
  apiKey?: string
  prompt: string
  negative?: string
  imageDataUrl?: string
  referenceImageDataUrls?: string[]
  /** 시작·끝 프레임 워크플로의 끝 이미지 */
  imageEndDataUrl?: string
  /** 부분 다시 그리기용 마스크 */
  maskDataUrl?: string
  /** 디지털 휴먼 내레이션 오디오 */
  audioDataUrl?: string
  seed?: number
  width?: number
  height?: number
  /** 매핑에 따라 초 단위 길이나 프레임 수로 해석한다. */
  duration?: number
  fps?: number
  adapter?: AdapterConfig
  signal?: AbortSignal
  kind?: 'image' | 'video'
  onProgress?: (msg: string) => void
  /** Optional checkpoint: resume polling without uploading/submitting again. */
  resumeTaskId?: string
  onTaskSubmitted?: (id: string) => void | Promise<void>
}): Promise<{ blob: Blob; mimeType: string }> {
  const base = trimSlash(opts.baseUrl).replace(/\/upload\/image$/i, '')
  const adapter = opts.adapter || {}
  const submitPath = adapter.path || '/prompt'
  const pollPath = adapter.pollPath || '/history/{id}'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...buildAuthHeader(opts.apiKey || '', {
      ...adapter,
      // 로컬 ComfyUI 연결에서는 Bearer 접두사가 없는 경우가 많다.
      authPrefix: adapter.authPrefix ?? (opts.apiKey ? 'Bearer ' : '')
    }),
    ...(adapter.headers || {})
  }

  let promptId = opts.resumeTaskId?.trim() || ''
  if (!promptId) {
  if (!adapter.workflowTemplate?.trim()) {
    throw new Error(
      '[comfyui] adapter.workflowTemplate이 없습니다. 설정의 ‘어댑터’에 Comfy API 형식의 워크플로 JSON을 붙여 넣고 도우미로 입력 매핑을 분석하세요.'
    )
  }
  // 이전 플레이스홀더를 교체한다. 이미지에는 업로드한 파일명을 넣는다.
  const hasPlaceholders = /\{\{(prompt|negative|image)\}\}/.test(adapter.workflowTemplate)
  let payload: any
  if (hasPlaceholders) {
    let uploadedName = ''
    if (opts.imageDataUrl) {
      try {
        uploadedName = await uploadComfyMedia({
          baseUrl: base,
          dataUrl: opts.imageDataUrl,
          apiKey: opts.apiKey,
          adapter,
          signal: opts.signal,
          onProgress: opts.onProgress
        })
      } catch (e: any) {
        throw new Error(`[comfyui] 참조 이미지 업로드에 실패했습니다. ${e?.message || e}`)
      }
    }
    payload = fillWorkflowTemplate(adapter.workflowTemplate, {
      prompt: opts.prompt,
      negative: opts.negative || '',
      image: uploadedName
    })
  } else {
    payload = JSON.parse(adapter.workflowTemplate)
  }
  if (!payload.prompt && !payload.client_id) {
    // 템플릿 자체가 노드 맵인 경우도 처리한다.
    payload = { prompt: payload }
  }
  if (!payload.client_id) {
    payload.client_id = `ai-cut-${Date.now().toString(36)}`
  }

  // 연결 검증 때 얻은 매핑에 따라 값을 넣고 매핑이 없으면 규칙으로 위치를 찾는다.
  let inputMap = adapter.inputMap
  if (!inputMap || !inputMap.bindings?.length) {
    inputMap = guessInputMap(payload)
  }
  inputMap = validateInputMap(payload, inputMap)
  const outputRates = [...new Set(Object.values(payload.prompt || {}).flatMap((node: any) =>
    /VideoCombine|SaveVideo/i.test(node?.class_type || '') && typeof node.inputs?.frame_rate === 'number' && node.inputs.frame_rate > 0 ? [node.inputs.frame_rate as number] : []
  ))]
  const fps = opts.fps || (outputRates.length === 1 ? outputRates[0] : undefined)
  const knownDuration = guessInputMap(payload).bindings.find((b) => b.role === 'length')
  if (knownDuration && !inputMap.bindings.some((b) => b.role === 'length' && b.durationUnit)) {
    inputMap = { ...inputMap, bindings: [...inputMap.bindings.filter((b) => b.role !== 'length'), knownDuration] }
  }
  if (opts.kind === 'video' && opts.duration && !inputMap.bindings.some((b) => b.role === 'length' && (b.durationUnit === 'seconds' || (b.durationUnit === 'frames' && fps)))) {
    throw new Error(translate('comfyMapping.durationMappingMissing'))
  }
  const mediaSources: Partial<Record<ComfyInputRole, string>> = {
    image: opts.imageDataUrl,
    imageEnd: opts.imageEndDataUrl,
    mask: opts.maskDataUrl,
    audio: opts.audioDataUrl
  }
  const uploaded: Partial<Record<ComfyInputRole, string>> = {}
  const uploadedImages: Record<string, string> = {}
  const imageSources = [opts.imageDataUrl, ...(opts.referenceImageDataUrls || [])].filter(Boolean) as string[]
  if (opts.kind === 'video') inputMap = fitComfyReferenceImages(payload, inputMap, imageSources.length)
  const imageBindings = inputMap.bindings.filter(b => b.role === 'image')
  if (opts.kind === 'video' && imageSources.length > imageBindings.length) {
    throw new Error(translate('comfyMapping.referenceCapacity', { count: imageSources.length, slots: imageBindings.length }))
  }
  // Replace supplied slots in order and leave defaults in the remaining slots.
  const suppliedImageBindings = imageBindings.slice(0, imageSources.length)
  const imageInputs = inputMap.bindings.filter(b => b.role === 'image' || b.role === 'imageEnd' || b.role === 'mask')
  if (new Set(imageInputs.map(b => JSON.stringify([b.nodeId, b.field]))).size !== imageInputs.length) {
    throw new Error(translate('comfyMapping.duplicateImageBinding'))
  }
  for (const b of inputMap.bindings) {
    if (!isMediaRole(b.role)) continue
    const src = b.role === 'image' ? imageSources[imageBindings.indexOf(b)] : mediaSources[b.role]
    if (!src) continue
    const mode = b.mediaMode || 'upload'
    if (mode !== 'upload') {
      if (b.role === 'image') uploadedImages[`${b.nodeId}:${b.field}`] = src
      continue
    }
    if (b.role !== 'image' && uploaded[b.role]) continue
    try {
      const file = await uploadComfyMedia({
        baseUrl: base,
        dataUrl: src,
        apiKey: opts.apiKey,
        adapter,
        signal: opts.signal,
        onProgress: opts.onProgress
      })
      if (b.role === 'image') uploadedImages[`${b.nodeId}:${b.field}`] = file
      else uploaded[b.role] = file
    } catch (e: any) {
      throw new Error(
        `[comfyui] ${comfyRoleLabel(b.role)} 업로드에 실패했습니다. ${e?.message || e} 이 워크플로는 먼저 ComfyUI의 input 디렉터리에 자료를 업로드해야 합니다.`
      )
    }
  }
  const values: ComfyInjectValues = {
    prompt: opts.prompt,
    negative: opts.negative || '',
    image: opts.imageDataUrl,
    imageEnd: opts.imageEndDataUrl,
    mask: opts.maskDataUrl,
    audio: opts.audioDataUrl,
    ...(opts.seed != null ? { seed: opts.seed } : {}),
    ...(opts.width ? { width: opts.width } : {}),
    ...(opts.height ? { height: opts.height } : {}),
    ...(opts.width && opts.height ? { megapixels: opts.width * opts.height / 1_000_000 } : {}),
    ...(opts.duration ? { length: opts.duration } : {}),
    ...(fps ? { fps } : {}),
    uploaded,
    uploadedImages
  }
  const { writes, skipped } = applyComfyInputs(payload, inputMap, values)
  if (suppliedImageBindings.some(b => {
    const expected = uploadedImages[`${b.nodeId}:${b.field}`]
    return !expected || payload.prompt?.[b.nodeId]?.inputs?.[b.field] !== expected
  })) throw new Error(translate('comfyMapping.incompleteImageBindings'))
  if (suppliedImageBindings.length) opts.onProgress?.(translate('comfyMapping.checkedReferences', { count: suppliedImageBindings.length }))
  const retainedImageCount = imageBindings.length - suppliedImageBindings.length
  if (retainedImageCount) opts.onProgress?.(translate('comfyMapping.keptDefaultImages', { count: retainedImageCount }))
  if (!writes.length) {
    const miss = missingRoles(inputMap)
    throw new Error(
      `[comfyui] 이번 실행의 입력이 워크플로에 전달되지 않았습니다(${skipped.slice(0, 2).join('；') || '매핑이 비어 있음'}). ` +
        `${miss.includes('prompt') ? '매핑에 긍정 프롬프트 노드가 없습니다. ' : ''}` +
        '연결의 ‘도우미로 워크플로 분석’을 눌러 입력 매핑을 다시 만드세요.'
    )
  }
  opts.onProgress?.(`입력 전달 완료 ${writes.slice(0, 3).join(uiPunctuation.listSeparator)}`)

  opts.onProgress?.('ComfyUI 대기열에 제출하는 중…')
  const submitUrl = joinUrl(base, submitPath)
  const submit = await providerHttp(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
    timeoutMs: opts.kind === 'video' ? 10 * 60_000 : 120_000
  })
  if (!submit.ok) {
    throw new Error(
      `[comfyui] 제출에 실패했습니다. ${submit.status} ${await submit.text()}\n자체 호스팅 ComfyUI라면 연결의 adapter.workflowTemplate에 /prompt JSON 전문을 입력하세요.`
    )
  }
  const submitJson = await submit.json()
  promptId =
    String(submitJson.prompt_id || submitJson.promptId || submitJson.task_id || getByJsonPath(submitJson, 'data.prompt_id') || '').trim()
  if (!promptId) {
    throw new Error(`[comfyui] 제출은 완료됐지만 prompt_id가 없습니다. ${JSON.stringify(submitJson).slice(0, 200)}`)
  }
  await opts.onTaskSubmitted?.(promptId)
  }

  const started = Date.now()
  // Allow up to 30 minutes for local video generation.
  const timeoutMs = opts.kind === 'video' ? 30 * 60_000 : 6 * 60_000
  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) throw new DOMException(translate('providerRequestErrors.aborted'), 'AbortError')
    await new Promise((r) => setTimeout(r, 1500))
    const pollUrl = joinUrl(base, pollPath.replace(/\{id\}/g, encodeURIComponent(promptId)))
    const poll = await providerHttp(pollUrl, {
      method: 'GET',
      headers,
      signal: opts.signal,
      timeoutMs: 60_000
    })
    if (!poll.ok) continue
    const hist = await poll.json()
    const entry = hist?.[promptId] || hist?.data || hist
    if (!entry || (typeof entry === 'object' && !entry.outputs && !entry.status)) continue

    const statusStr = String(entry?.status?.status_str || entry?.status || '').toLowerCase()
    if (/error|fail/.test(statusStr)) {
      throw new Error(`[comfyui] 작업에 실패했습니다. ${JSON.stringify(entry.status || entry).slice(0, 240)}`)
    }

    const outputs = entry.outputs || entry
    const foundOutputs: Array<{ filename: string; subfolder?: string; type?: string }> = []
    const visit = (node: any) => {
      if (!node || foundOutputs.length) return
      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }
      if (typeof node !== 'object') return
      if (node.filename && (node.type === 'output' || !node.type || node.subfolder != null)) {
        foundOutputs.push({
          filename: String(node.filename),
          subfolder: node.subfolder ? String(node.subfolder) : '',
          type: node.type ? String(node.type) : 'output'
        })
        return
      }
      for (const v of Object.values(node)) visit(v)
    }
    visit(outputs)
    const fileMeta = foundOutputs[0] || null

    const direct =
      (adapter.resultJsonPath ? getByJsonPath(entry, adapter.resultJsonPath) : null) ||
      findFirstMediaUrl(entry)
    if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) {
      const r = await providerHttp(direct, {
        method: 'GET',
        headers: buildAuthHeader(opts.apiKey || '', adapter),
        signal: opts.signal,
        timeoutMs: 180_000,
        binary: true
      })
      if (!r.ok) throw new Error(`[comfyui] 다운로드에 실패했습니다. ${r.status}`)
      const blob = await r.blob()
      return {
        blob,
        mimeType: blob.type || (opts.kind === 'video' ? 'video/mp4' : 'image/png')
      }
    }

    if (fileMeta) {
      const q = new URLSearchParams({
        filename: fileMeta.filename,
        subfolder: fileMeta.subfolder || '',
        type: fileMeta.type || 'output'
      })
      const viewUrl = `${base}/view?${q.toString()}`
      opts.onProgress?.('ComfyUI 결과를 다운로드하는 중…')
      const view = await providerHttp(viewUrl, {
        method: 'GET',
        headers: buildAuthHeader(opts.apiKey || '', adapter),
        signal: opts.signal,
        timeoutMs: 180_000,
        binary: true
      })
      if (!view.ok) {
        throw new Error(`[comfyui]  /view 요청에 실패했습니다. ${view.status}`)
      }
      const blob = await view.blob()
      const name = fileMeta.filename.toLowerCase()
      const mime =
        blob.type ||
        (name.endsWith('.mp4')
          ? 'video/mp4'
          : name.endsWith('.webm')
            ? 'video/webm'
            : name.endsWith('.jpg') || name.endsWith('.jpeg')
              ? 'image/jpeg'
              : 'image/png')
      return { blob, mimeType: mime }
    }
    opts.onProgress?.('ComfyUI에서 생성하는 중…')
  }
  throw new Error(opts.kind === 'video' ? translate('comfyMapping.videoWaitTimeout') : translate('comfyMapping.waitTimeout'))
}

export interface ConnectionTestResult {
  ok: boolean
  detail: string
}

/** 최소 요청으로 연결을 확인한다. */
export async function testEndpointConnection(
  kind: 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'music',
  ep: EndpointLike
): Promise<ConnectionTestResult> {
  if (kind === 'image' && ep.provider === DRAW_THINGS_PROVIDER) return checkDrawThings(ep.baseUrl || '', ep.drawThingsSharedSecret)
  const base = trimSlash(ep.baseUrl || '')
  if (!base) return { ok: false, detail: 'API 주소가 없습니다.' }

  try {
    if (kind === 'tts' && isElevenLabsTts({ ...ep, baseUrl: base })) {
      const { creditsRemaining } = await elevenLabsRequest(ep.encryptedElevenLabsKey, {
        kind: 'connection', model: ep.model || ''
      })
      return {
        ok: true,
        detail: creditsRemaining === undefined ? translate('elevenLabs.connected')
          : translate('elevenLabs.connectedCredits', { count: creditsRemaining.toLocaleString() })
      }
    }
    if (kind === 'video' && isLtxDesktop(ep)) {
      if (!isDesktop() || !desktop().ltxDesktopRequest) {
        return { ok: false, detail: translate('ltx.desktopOnly') }
      }
      const reply = await desktop().ltxDesktopRequest({
        baseUrl: base, hostOverride: ep.ltxHostOverride, token: ep.apiKey, operation: { kind: 'check' }
      })
      return {
        ok: reply.kind === 'ready',
        detail: translate(reply.kind === 'ready' ? 'ltxDesktop.ready' : ltxDesktopError(reply))
      }
    }
    if (kind === 'llm' || kind === 'vision') {
      const auth = buildAuthHeader(ep.apiKey || '', ep.adapter)
      const authValue = Object.values(auth)[0] || ''
      const modelsUrl = `${base}/models`
      // 브라우저나 CORS 제한 없는 로컬 연결에서는 /models를 먼저 시도한다.
      try {
        const r = await fetch(modelsUrl, {
          headers: { Accept: 'application/json', ...auth },
          signal: timeoutSignal(12_000)
        })
        if (r.ok) return { ok: true, detail: `연결 확인（GET ${modelsUrl} → ${r.status}）` }
        if (r.status === 401 || r.status === 403) {
          return { ok: false, detail: `주소에는 연결할 수 있지만 인증에 실패했습니다.（${r.status}）` }
        }
      } catch {
        /* CORS 또는 네트워크 오류가 발생하면 데스크톱 llmFetch를 사용한다. */
      }
      // 데스크톱에서는 먼저 /models를 조회하고 실패하면 최소 chat/completions 요청을 보낸다.
      if (isDesktop()) {
        const api = desktop()
        if (typeof api.llmFetch !== 'function') {
          return { ok: false, detail: '데스크톱 앱에 llmFetch가 없습니다. 앱을 다시 시작하세요.' }
        }
        try {
          const modelsRes = await api.llmFetch({
            url: modelsUrl,
            authorization: String(authValue || ''),
            body: '',
            timeoutMs: 15_000
          })
          if (modelsRes.ok) {
            return { ok: true, detail: `연결 확인（GET /models → ${modelsRes.status}，데스크톱 경로에서 /models를 확인）` }
          }
        } catch {
          /* 이전 메인 프로세스가 chat/completions만 허용할 수 있어 다음 경로로 이어간다. */
        }
        const chatUrl = `${base}/chat/completions`
        try {
          const res = await api.llmFetch({
            url: chatUrl,
            authorization: String(authValue || ''),
            body: JSON.stringify(adaptOpenAiChatBody(base, {
              model: ep.model || (isOfficialOpenAi(base) ? OPENAI_DEFAULT_CHAT_MODEL : 'gpt-4o-mini'),
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: isOfficialOpenAi(base) ? 16 : 1,
              temperature: 0
            })),
            timeoutMs: 25_000
          })
          if (res.ok) return { ok: true, detail: `연결 확인（POST chat/completions → ${res.status}，데스크톱 경로）` }
          return {
            ok: false,
            detail: `chat/completions 응답 ${res.status} ${String(res.text || '').slice(0, 160)}`
          }
        } catch (e: any) {
          return { ok: false, detail: `데스크톱 경로 확인에 실패했습니다. ${e?.message || e}` }
        }
      }
      return { ok: false, detail: `${modelsUrl}에 접근할 수 없습니다. CORS에 의해 차단됐을 수 있습니다. 메인 프로세스 경로를 사용하려면 설치된 데스크톱 앱을 사용하세요.` }
    }

    if (kind === 'image') {
      const adapterType = resolveImageAdapter(ep)
      if (adapterType === 'comfyui-prompt' || adapterType === 'comfyui-workflow') {
        const statsUrl = isAutodlHost(base)
          ? `${base.replace(/\/+$/, '')}/api/v1/comfyui/system_stats`.replace(
              /\/api\/v1\/comfyui\/api\/v1\/comfyui/,
              '/api/v1/comfyui'
            )
          : `${base}/system_stats`
        // autodl may not have system_stats — try and fall back
        const tryUrls = isAutodlHost(base)
          ? [`${trimSlash(base)}/api/v1/comfyui/system_stats`, `${trimSlash(base)}/`]
          : [`${base}/system_stats`, `${base}/object_info`, `${base}/`]
        for (const u of tryUrls) {
          try {
            const res = await providerHttp(u, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                ...buildAuthHeader(ep.apiKey || '', {
                  ...ep.adapter,
                  authPrefix: ep.adapter?.authPrefix ?? (isAutodlHost(base) ? '' : 'Bearer ')
                })
              },
              timeoutMs: 15_000
            })
            if (res.ok || res.status === 401 || res.status === 403) {
              return {
                ok: res.ok || res.status === 401 || res.status === 403,
                detail: res.ok
                  ? `연결 확인（GET ${u} → ${res.status}）`
                  : `주소에는 연결할 수 있지만 인증에 실패했습니다.（${res.status}） 토큰을 확인하세요.`
              }
            }
          } catch {
            /* try next */
          }
        }
        return { ok: false, detail: 'ComfyUI 연결 확인에 실패했습니다. system_stats 또는 루트 경로에 접근할 수 없습니다.' }
      }
      const url = `${base}/models`
      try {
        const r = await fetch(url, {
          headers: {
            Accept: 'application/json',
            ...buildAuthHeader(ep.apiKey || '', ep.adapter)
          },
          signal: timeoutSignal(15_000)
        })
        if (r.ok) return { ok: true, detail: `연결 확인（GET ${url} → ${r.status}）` }
        if (r.status === 401 || r.status === 403) {
          return { ok: false, detail: `주소에는 연결할 수 있지만 인증에 실패했습니다.（${r.status}）` }
        }
        // 일부 중계 API에서 /models를 지원하지 않으면 추가 검색 없이 연결 가능 상태로 표시한다.
        return {
          ok: r.status < 500,
          detail: `/models 응답 ${r.status}. API에 모델 목록이 없으면 이 응답을 무시하고 이미지 생성을 시도할 수 있습니다.`
        }
      } catch (e: any) {
        return { ok: false, detail: `연결 확인에 실패했습니다. ${e?.message || e}` }
      }
    }

    if (kind === 'video') {
      const adapterType = resolveVideoAdapter(ep)
      if (adapterType === 'comfyui-prompt' || isLocalComfyHost(base)) {
        const res = await providerHttp(`${base}/system_stats`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...buildAuthHeader(ep.apiKey || '', ep.adapter)
          },
          timeoutMs: 15_000
        })
        if (res.ok) return { ok: true, detail: `연결 확인（GET /system_stats → ${res.status}）` }
        return { ok: false, detail: `/system_stats 응답 ${res.status} ${await res.text().then((t) => t.slice(0, 120))}` }
      }
      // 인증을 붙여 AutoDL 연결을 점검한다. 상태 확인 URL이 없으면 URL과 토큰 값을 검증한다.
      if (!ep.apiKey?.trim()) return { ok: false, detail: translate('providerErrors.autodlToken') }
      if (!ep.workflowId?.trim() && adapterType === 'comfyui-workflow') {
        return { ok: false, detail: '워크플로 ID(workflowId)가 없습니다.' }
      }
      const root = isAutodlHost(base)
        ? `${trimSlash(base.replace(/\/api\/v1$/i, ''))}/api/v1/comfyui`
        : `${trimSlash(base)}/api/v1/comfyui`
      try {
        const res = await providerHttp(`${root}/system_stats`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...buildAuthHeader(ep.apiKey || '', {
              ...ep.adapter,
              authPrefix: ep.adapter?.authPrefix ?? ''
            })
          },
          timeoutMs: 15_000
        })
        if (res.ok) return { ok: true, detail: `연결 확인（${res.status}）` }
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          return {
            ok: true,
            detail: `주소와 인증 경로에 연결할 수 있습니다(${res.status}). AutoDL에 system_stats가 없을 수 있으며 현재 설정으로 워크플로를 제출할 수 있습니다.`
          }
        }
        return { ok: false, detail: `연결 확인 응답 ${res.status}` }
      } catch (e: any) {
        return {
          ok: Boolean(ep.apiKey && base),
          detail: `HTTP 연결 확인을 완료하지 못했습니다(${e?.message || e}). 주소와 토큰이 입력된 것을 확인했습니다.`
        }
      }
    }

    if (kind === 'tts' || kind === 'music') {
      if (!ep.apiKey?.trim()) return { ok: false, detail: translate('providerErrors.apiKey') }
      return { ok: true, detail: '주소와 API 키 필드를 확인했습니다. 이 유형에는 공통으로 쓸 수 있는 간단한 연결 확인 엔드포인트가 없습니다.' }
    }

    return { ok: false, detail: `지원하지 않는 유형 ${kind}` }
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) }
  }
}

export function normalizeAdapterInput(raw: unknown): AdapterConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const type = String(o.type || '').trim() as AdapterType
  const allowed: AdapterType[] = [
    'openai-compatible',
    'openai-images',
    'http-custom',
    'comfyui-workflow',
    'comfyui-prompt'
  ]
  const adapter: AdapterConfig = {}
  if (allowed.includes(type)) adapter.type = type
  if (o.path != null) adapter.path = String(o.path)
  if (o.pollPath != null) adapter.pollPath = String(o.pollPath)
  if (o.pollUrl != null) adapter.pollUrl = String(o.pollUrl)
  if (o.taskIdJsonPath != null) adapter.taskIdJsonPath = String(o.taskIdJsonPath)
  if (o.pollJsonPath != null) adapter.pollJsonPath = String(o.pollJsonPath)
  if (o.resultJsonPath != null) adapter.resultJsonPath = String(o.resultJsonPath)
  if (o.authHeader != null) adapter.authHeader = String(o.authHeader)
  if (o.authPrefix != null) adapter.authPrefix = String(o.authPrefix)
  if (o.workflowTemplate != null) adapter.workflowTemplate = String(o.workflowTemplate)
  const map = sanitizeInputMap(o.inputMap)
  if (map) adapter.inputMap = map
  if (o.headers && typeof o.headers === 'object') {
    adapter.headers = Object.fromEntries(
      Object.entries(o.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    )
  }
  return Object.keys(adapter).length ? adapter : undefined
}
