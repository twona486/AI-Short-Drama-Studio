import { nearestVideoDuration, videoDurationCapability } from './videoDuration'
import { isLtxDesktop, isLtxTask, ltxDesktopResolution, LTX_DESKTOP_MODELS, LTX_DESKTOP_WORKFLOW, ltxDesktopError, type LtxDesktopOperation, type LtxDesktopReply } from './ltxDesktopOptions'
/**
 * AutoDL.art ComfyUI 워크플로를 이용한 AI 영상 생성
 *
 *   POST {base}/api/v1/comfyui/comfyui_workflow/{workflow_id}
 *   GET  {base}/api/v1/comfyui/comfyui_workflow/result/{task_id}
 *
 * 참조 이미지에는 prompt, duration, resolution, ref_image_0..8을 사용한다.
 * 디지털 휴먼 립싱크에는 audio_duration, ref_audio_0, ref_image_0, resolution만 보낸다.
 * 워크플로 ID는 minimax_h3_lightx2v_v5_15s, minimax_h3_lightx2v_v5, minimax_h3_image_audio_to_video, minimax_h3_b99_002다.
 */

import { t as translate, uiPunctuation } from '@/i18n'
import { LTX_DEFAULT_MODEL, LTX_MODELS, ltxDuration, type LtxReply } from './ltxOptions'
import { ltxRequestBody, pollLtxJob, waitForLtxRead } from './ltxJob'
import { getAIMode } from './client'
import { comfyPromptGenerate, httpCustomMediaGenerate, isApimartHost, resolveVideoAdapter } from './adapters'
import { apimartGenerateVideo, isApimartEndpoint } from './apimart'
import { autodlVideoProfileId, getVideoConfig, getVideoPromptStyle, getTtsConfig } from './runtime'
import { generateMockVideo } from './mock'
import { composeH3VideoPrompt, ensureFl2vaLead, isRef2VA, type H3ImageSlot } from './h3Prompt'
import {
  VIDEO_AUTODL_ROOT,
  VIDEO_DEFAULT_WORKFLOW_ID,
  VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
  VIDEO_FL2VA_WORKFLOW_ID,
  VIDEO_H3_V5_10S_WORKFLOW_ID,
  migrateVideoBaseUrl,
  migrateVideoWorkflowId
} from './env'
import type { AspectRatio, H3VideoGenMode, Shot, VideoGenModel, VideoResolution } from '@/types'
import { normalizeVideoResolution } from '@/types'
import { pickDocVideoResolution, videoResolutionApiValue, videoResolutionChoices } from '@/services/ai/modelOptions'
import { abortableDelay, controlledSignal, isTimeoutAbort, throwIfAborted } from './abort'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import { blobFromPath, desktop, isDesktop } from '@/services/desktop'
import { isLandscapeAspect } from '@/utils/aspect'
import { toDigitalHumanWav } from '@/services/ffmpeg'
import { normalizeZealmanBaseUrl, zealmanWorkflowById } from './zealman'

export interface VideoGenInput {
  /** 첫 참조는 캐릭터 설정 이미지, 장면 이미지, 스토리 개요판 중 하나다. */
  imageBlob?: Blob
  /** 나머지 참조는 캐릭터 설정 이미지, 장면 이미지, 개요판 순으로 제공한다. */
  referenceImages?: Blob[]
  /**
   * 영상 API에 보낼 프롬프트다. promptAsIs가 참이면 컴파일하거나 결합하지 않는다.
   */
  prompt: string
  /** 입력란의 전문을 H3 템플릿 없이 보낸다. */
  promptAsIs?: boolean
  /**
   * 프로젝트 전체 분위기(1~2단락)
   * visualPrompt 앞에 추가한다.
   */
  aesthetic?: string
  /**
   * 비나 불꽃 소리 등 효과음을 설명한다.
   * H3 소리 설계에 사용한다.
   */
  audioDescription?: string
  /**
   * 화자 접두사를 빼고 원문과 언어 태그를 d 태그에 넣는다.
   */
  voiceover?: string
  /** dialogue는 립싱크, voiceover는 화면 밖 음성, none은 인물 음성 없음이다. */
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  /** 대사를 제외한 화자 음색 및 신원 설명 */
  speakerHint?: string
  /** 캐릭터 노드의 voicePrompt를 화면 속 대사와 화면 밖 음성에 모두 쓴다. */
  speakerVoice?: string
  /** 공식 H3 참조 형식의 인물, 장면, 이미지 역할 */
  speakerName?: string
  sceneName?: string
  sceneDescription?: string
  sceneLighting?: string
  sceneAnchor?: string
  shotTitle?: string
  imageAssignments?: string[]
  imageSlots?: H3ImageSlot[]
  onScreenNames?: string[]
  duration: number
  /** 연속 촬영 계획에서 검증한 길이 상한이다. 값이 없으면 기존 연결의 규칙을 사용한다. */
  durationLimit?: number
  width: number
  height: number
  /** 프롬프트 앞에 붙이는 화면 비율 태그(예를 들어 [16:9]) */
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  /** 데모 모드에서만 쓰는 0~1 값 */
  strength?: number
  signal?: AbortSignal
  promptStyle?: VideoPromptStyle
  /** 기본은 H3 15초다. h3-v5는 10초 영상으로 1080p를 지원한다. */
  videoModel?: VideoGenModel
  /** 영상 연결을 고정하고 다른 공급자 연동으로 전환하지 않는다. */
  videoProfileId?: string
  /** h3-v5는 1080p를 선택할 수 있다. */
  videoResolution?: VideoResolution
  /** H3는 기본으로 참조 이미지를 사용하며 시작·끝 프레임도 지원한다. */
  h3GenMode?: H3VideoGenMode
  /** 시작·끝 프레임 모드의 끝 이미지 */
  lastFrameBlob?: Blob
  /** 공급자가 지원하면 노드의 오디오 사용 여부를 API에 보낸다. */
  generateAudio?: boolean
  /** 디지털 휴먼의 화면에 동기화할 내레이션 오디오 */
  audioBlob?: Blob
  /** MiniMax H3 이미지와 오디오 립싱크 워크플로를 사용한다. */
  audioSync?: boolean
  /** 인물, 장면, 개요판을 함께 보내면 R2VA를, 시작 프레임 하나면 I2VA를 사용한다. */
  mode?: 'I2VA' | 'T2VA' | 'R2VA' | 'FL2VA' | 'L2VA'
  /** 기존 원격 작업 ID가 있으면 제출을 건너뛰고 조회를 재개한다. */
  resumeTaskId?: string
  /** 제출 즉시 task_id를 전달한다. 호출자는 재개를 위해 저장한다. */
  onTaskSubmitted?: (taskId: string) => void | Promise<void>
  onTaskTerminalFailure?: () => void | Promise<void>
}

export interface VideoGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
  duration: number
}

const log = (msg: string) =>
  console.log('%c[video]', 'color:#ec4899;font-weight:600', msg)

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i
const MAX_REF_IMAGES = 9

function resultUrl(r: any): string {
  const candidates = [
    r?.url,
    r?.video_url,
    r?.videoUrl,
    r?.file_url,
    r?.fileUrl,
    r?.download_url,
    r?.downloadUrl,
    r?.oss_url,
    r?.signed_url,
    r?.output_url,
    r?.src,
    r?.path,
    r?.filename
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return ''
}

/** 워크플로 결과에서 영상만 선택한다. 미리보기 이미지는 제외한다. */
function pickWorkflowVideoResult(
  results: any[]
): { url: string; type?: string } | null {
  const scored = results
    .map((r) => {
      const url = resultUrl(r)
      if (!url) return null
      const type = String(r?.type ?? r?.raw?.type ?? '').toLowerCase()
      const blobText = JSON.stringify(r).toLowerCase()
      let score = 0
      if (VIDEO_EXT_RE.test(url)) score += 100
      if (IMAGE_EXT_RE.test(url)) score -= 100
      if (/video/.test(type)) score += 60
      if (type === 'image' && !VIDEO_EXT_RE.test(url)) score -= 30
      if (/mp4|webm|mov|video/.test(blobText) && !IMAGE_EXT_RE.test(url)) score += 20
      // OSS 서명 URL에는 .mp4 확장자가 없을 수 있다.
      if (!IMAGE_EXT_RE.test(url) && !VIDEO_EXT_RE.test(url) && /^https?:\/\//i.test(url)) {
        score += /video/.test(type) ? 20 : 10
      }
      return { url, type, score }
    })
    .filter(Boolean) as { url: string; type?: string; score: number }[]

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 40 || !/^https?:\/\//i.test(best.url)) return null
  if (IMAGE_EXT_RE.test(best.url) && best.score < 50) return null
  return { url: best.url, type: best.type }
}

function guessVideoMimeFromUrl(url: string): string | undefined {
  if (/\.webm(?:$|[?#])/i.test(url)) return 'video/webm'
  if (/\.mov(?:$|[?#])/i.test(url)) return 'video/quicktime'
  if (/\.(mp4|m4v)(?:$|[?#])/i.test(url)) return 'video/mp4'
  return undefined
}

function isImageMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return true
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true
  // WEBP (RIFF....WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return true
  return false
}

function isVideoMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const ascii = (n: number, m: number) =>
    String.fromCharCode(...bytes.subarray(n, m))
  // ISO BMFF / MP4 / MOV
  if (ascii(4, 8) === 'ftyp') return true
  // WebM / Matroska
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return true
  // RIFF AVI
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return true
  return false
}

/** 다운로드한 파일이 영상 컨테이너인지 확인해 미리보기 이미지 저장을 막는다. */
async function assertVideoBlob(blob: Blob, mimeHint?: string): Promise<Blob> {
  if (blob.size < 1024) {
    throw new Error(`[video] 다운로드한 파일이 너무 작아 유효한 영상으로 볼 수 없습니다(${blob.size}바이트).`)
  }
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
  if (isImageMagic(head)) {
    throw new Error(
      '[video] 이미지(PNG/JPEG/WebP)가 다운로드됐습니다. ComfyUI 워크플로에서 MP4를 출력하는지 확인하세요.'
    )
  }
  const hint = (mimeHint || blob.type || '').toLowerCase()
  if (hint.startsWith('image/')) {
    throw new Error(`[video] 서버가 이미지 Content-Type(${hint})을 반환했습니다.`)
  }
  let mime = hint && hint.startsWith('video/') ? hint : ''
  if (isVideoMagic(head)) {
    if (!mime) {
      mime =
        head[0] === 0x1a ? 'video/webm' : asciiHintMp4(head) ? 'video/mp4' : 'video/mp4'
    }
    return blob.type === mime ? blob : blob.slice(0, blob.size, mime)
  }
  // 파일 서명이 불분명해도 프록시가 헤더를 생략할 수 있으므로 video/* 힌트가 있으면 허용한다.
  if (mime.startsWith('video/')) {
    return blob.type === mime ? blob : blob.slice(0, blob.size, mime)
  }
  throw new Error(
    `[video] 영상 파일의 형식을 인식할 수 없습니다(type=${blob.type || mimeHint || 'unknown'}, size=${blob.size}). 미리보기 프레임일 수 있습니다.`
  )
}

function asciiHintMp4(bytes: Uint8Array): boolean {
  return String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp'
}

/** Blob을 base64 데이터 URL로 변환한다. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'))
    reader.readAsDataURL(blob)
  })
}

async function blobToTypedDataUrl(blob: Blob, mime: string): Promise<string> {
  const url = await blobToDataUrl(blob)
  const comma = url.indexOf(',')
  const b64 = comma >= 0 ? url.slice(comma + 1) : url
  return `data:${mime};base64,${b64}`
}

/** Keep a three-reference JSON request below common proxy body limits. */
async function blobToVideoImageDataUrl(blob: Blob): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob)
    const maxEdge = 1600
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas context unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    return await blobToDataUrl(compressed || blob)
  } catch {
    return await blobToDataUrl(blob)
  }
}

function workflowApiRoot(baseUrl: string): string {
  const raw = migrateVideoBaseUrl(baseUrl).replace(/\/+$/, '')
  if (/\/api\/v1\/comfyui$/i.test(raw)) return raw
  const origin = raw.replace(/\/api\/v1$/i, '')
  return `${origin}/api/v1/comfyui`
}

function authHeaders(apiKey: string, jsonBody = true): Record<string, string> {
  const token = apiKey.trim()
  const headers: Record<string, string> = {}
  if (jsonBody) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = token
  return headers
}

type AutodlHttpResult = {
  ok: boolean
  status: number
  text: () => Promise<string>
}

/** 데스크톱은 메인 프로세스의 net.fetch를 사용하고 브라우저는 fetch를 사용한다. */
export async function autodlRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
  timeoutMs = 120_000
): Promise<AutodlHttpResult> {
  throwIfAborted(init.signal)
  if (isDesktop()) {
    const api = desktop()
    if (typeof api.autodlFetch !== 'function') {
      throw new Error('AI Short Drama Studio를 완전히 종료한 뒤 다시 시작하세요. 데스크톱 앱에 새 AutoDL 연결이 필요합니다.')
    }
    const headers = init.headers || {}
    const res = await api.autodlFetch({
      url,
      method: init.method || 'GET',
      authorization: headers.Authorization || '',
      extraHeaders: headers,
      body: init.body,
      timeoutMs
    })
    throwIfAborted(init.signal)
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text
    }
  }
  const resp = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  })
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text()
  }
}

const WAN_PRIME_MODEL = 'wan3.0-video-prime'

function dashscopeApiRoot(baseUrl: string): string {
  let u = (baseUrl || '').replace(/\/+$/, '')
  u = u.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(u)) return u
  if (/^https?:\/\//i.test(u) && !/\/api\//i.test(u)) return `${u}/api/v1`
  return u || 'https://dashscope.aliyuncs.com/api/v1'
}

function wanRatio(ar?: AspectRatio): string {
  if (ar === '16:9' || ar === '9:16' || ar === '1:1' || ar === '4:3') return ar
  return 'adaptive'
}

async function dashscopeRequest(
  url: string,
  init: {
    method?: string
    extraHeaders?: Record<string, string>
    body?: string
    signal?: AbortSignal
    authorization: string
  },
  timeoutMs = 120_000
): Promise<AutodlHttpResult> {
  throwIfAborted(init.signal)
  if (isDesktop()) {
    const api = desktop()
    if (typeof api.dashscopeFetch !== 'function') {
      throw new Error('AI Short Drama Studio를 완전히 종료한 뒤 다시 시작하세요. 데스크톱 앱에 새 Bailian 연결이 필요합니다.')
    }
    const res = await api.dashscopeFetch({
      url,
      method: init.method || 'GET',
      authorization: init.authorization,
      extraHeaders: init.extraHeaders,
      body: init.body,
      timeoutMs
    })
    throwIfAborted(init.signal)
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: init.authorization,
    ...(init.extraHeaders || {})
  }
  if ((init.method || 'GET').toUpperCase() === 'POST') headers['Content-Type'] = 'application/json'
  const resp = await fetch(url, {
    method: init.method,
    headers,
    body: init.body,
    signal: init.signal
  })
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text()
  }
}

function autodlResolution(input: VideoGenInput): string {
  // 해상도 값은 AutoDL 워크플로 카탈로그를 따른다.
  // b99_002는 736p만 쓴다. 일반 워크플로는 480p, 768p, 일부 1080p와 화면 방향을 조합한다.
  const isFl2va = input.h3GenMode === 'fl2va'
  const quality = isFl2va
    ? '736p'
    : input.videoModel === 'h3-v5' && normalizeVideoResolution(input.videoResolution, 'h3-v5') === '1080p'
      ? '1080p'
      : '768p'
  const ratio = String(input.aspectRatio || '')
  if (ratio === '9:16') return `${quality}竖`
  // 디지털 휴먼 워크플로에 정사각형 옵션이 없어 가로 형식으로 처리한다.
  if (ratio === '1:1' && !input.audioSync) return `${quality}(1:1)`
  if (isLandscapeAspect(ratio) || ratio === '1:1') return `${quality}横`
  const landscape = (input.width || 0) >= (input.height || 0)
  return landscape ? `${quality}横` : `${quality}竖`
}

function unwrapTaskPayload(json: any): any {
  // data 자체가 결과 배열인 경우 작업 객체로 해석하지 않는다.
  if (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) return json.data
  return json
}

function taskIdOf(json: any): string {
  const data = unwrapTaskPayload(json)
  return String(data?.task_id ?? data?.taskId ?? json?.task_id ?? '').trim()
}

function taskStatusOf(json: any): string {
  const data = unwrapTaskPayload(json)
  return String(data?.status ?? data?.state ?? json?.status ?? json?.state ?? '').trim().toUpperCase()
}

function taskErrorOf(json: any): string {
  const data = unwrapTaskPayload(json)
  return String(data?.message ?? data?.error ?? json?.msg ?? json?.message ?? '').trim()
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function harvestMediaItems(value: unknown, out: any[] = [], depth = 0): any[] {
  if (value == null || depth > 8) return out
  const parsed = parseMaybeJson(value)
  if (typeof parsed === 'string') {
    const url = parsed.trim()
    if (/^https?:\/\//i.test(url)) out.push({ url })
    return out
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) harvestMediaItems(item, out, depth + 1)
    return out
  }
  if (typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>
    if (rec.url || rec.video_url || rec.videoUrl || rec.filename || rec.file_url || rec.download_url || rec.oss_url) {
      out.push(rec)
    }
    for (const nested of Object.values(rec)) harvestMediaItems(nested, out, depth + 1)
  }
  return out
}

function collectWorkflowResults(json: any): any[] {
  const data = unwrapTaskPayload(json)
  const buckets = [data?.results, json?.results, json?.data, data, json]
  const seen = new Set<string>()
  const out: any[] = []
  for (const bucket of buckets) {
    for (const item of harvestMediaItems(bucket)) {
      const url = resultUrl(item)
      const key = url || JSON.stringify(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

function classifyTaskStatus(raw: string): 'queued' | 'running' | 'success' | 'failed' | 'unknown' {
  const s = String(raw || '').trim().toUpperCase()
  if (/^(QUEUED|PENDING|WAITING|QUEUE|WAIT)$/.test(s)) return 'queued'
  if (/^(RUNNING|PROCESSING|IN_PROGRESS|STARTED|EXECUTING)$/.test(s)) return 'running'
  if (/^(SUCCESS|COMPLETED|SUCCEEDED|DONE|FINISH|FINISHED|OK)$/.test(s)) return 'success'
  if (/^(FAILED|ERROR|CANCELLED|CANCELED|FAIL)$/.test(s)) return 'failed'
  return 'unknown'
}

async function fetchVideoBytes(
  videoUrl: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; mime: string }> {
  const fallbackMime = guessVideoMimeFromUrl(videoUrl) || 'video/mp4'
  throwIfAborted(signal)

  if (isDesktop() && typeof desktop().downloadToTemp === 'function') {
    const dest = await desktop().downloadToTemp(videoUrl)
    try {
      const blob = await blobFromPath(dest)
      return { blob, mime: blob.type || fallbackMime }
    } finally {
      try {
        await desktop().remove(dest)
      } catch {
        /* ignore */
      }
    }
  }

  const vResp = await fetch(videoUrl, { signal })
  if (!vResp.ok) throw new Error(`영상 다운로드에 실패했습니다. ${vResp.status} ${videoUrl}`)
  return {
    blob: await vResp.blob(),
    mime: vResp.headers.get('content-type') || fallbackMime
  }
}

async function downloadGeneratedVideo(
  videoUrl: string,
  signal: AbortSignal | undefined,
  prompt: string,
  duration: number,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  log(`→ 영상 다운로드  ${videoUrl}`)
  onProgress?.('영상을 다운로드하는 중…')
  const dl = controlledSignal(signal, 10 * 60_000)
  try {
    const { blob: rawBlob, mime: mimeHint } = await fetchVideoBytes(videoUrl, dl.signal)
    onProgress?.('영상 파일을 확인하는 중…')
    const blob = await assertVideoBlob(rawBlob, mimeHint)
    log(`✓ 영상 다운로드 완료 (${(blob.size / 1024 / 1024).toFixed(2)} MB, ${blob.type})`)
    return {
      blob,
      mimeType: blob.type || 'video/mp4',
      prompt,
      duration
    }
  } catch (error: any) {
    if (isTimeoutAbort(error, dl.signal)) {
      throw new Error(`[video] 다운로드 시간이 초과됐습니다. ${videoUrl}`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    dl.cleanup()
  }
}

/** AutoDL.art ComfyUI 워크플로를 제출하고 결과를 조회한다. */
async function realWorkflowVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  const baseUrl = migrateVideoBaseUrl(cfg.baseUrl || VIDEO_AUTODL_ROOT)
  const apiKey = cfg.apiKey
  const isFl2va = input.h3GenMode === 'fl2va'
  const isAudioSync = input.audioSync === true
  const workflowId = isFl2va
    ? VIDEO_FL2VA_WORKFLOW_ID
    : isAudioSync
      ? VIDEO_DIGITAL_HUMAN_WORKFLOW_ID
      : input.videoModel === 'h3-v5'
        ? VIDEO_H3_V5_10S_WORKFLOW_ID
        : migrateVideoWorkflowId(cfg.workflowId || VIDEO_DEFAULT_WORKFLOW_ID)
  const root = workflowApiRoot(baseUrl)
  throwIfAborted(input.signal)

  if (!apiKey) {
    throw new Error(translate('providerErrors.videoAutodlToken'))
  }

  const allBlobs = isFl2va
    ? [input.imageBlob, input.lastFrameBlob].filter((b): b is Blob => !!b)
    : isAudioSync
      ? [input.imageBlob].filter((b): b is Blob => !!b)
      : [input.imageBlob, ...(input.referenceImages ?? [])].filter((b): b is Blob => !!b).slice(0, MAX_REF_IMAGES)

  if (isFl2va && allBlobs.length < 2) {
    throw new Error('[video] 시작·끝 프레임 모드에는 시작 프레임과 끝 프레임이 각각 필요합니다.')
  }
  if (isAudioSync && !input.audioBlob) {
    throw new Error('[video] 디지털 휴먼 내레이션에는 대사에 맞는 오디오를 업로드해야 합니다.')
  }
  if (allBlobs.length === 0) {
    throw new Error('[video] 사용 가능한 이미지가 없습니다.')
  }

  onProgress?.('참조 이미지를 준비하는 중…')
  const dataUrls: string[] = []
  for (const blob of allBlobs) {
    dataUrls.push(await blobToVideoImageDataUrl(blob))
  }
  const referencePayloadMb = dataUrls.reduce((sum, value) => sum + value.length, 0) / 1024 / 1024
  onProgress?.(`참조 이미지 ${dataUrls.length}장 준비 완료 / 약 ${referencePayloadMb.toFixed(1)} MB`)

  const { durations, max: MAX_DUR } = videoDurationCapability({ profile: { workflowId } })
  const MIN_DUR = durations[0]
  const targetDuration = nearestVideoDuration(input.duration || 5, durations)
  if (targetDuration !== input.duration) {
    onProgress?.(`API 제한 ${MIN_DUR}–${MAX_DUR}초에 맞춰 영상 길이를 ${targetDuration}초로 조정했습니다.`)
  }

  let finalPrompt = isAudioSync ? (input.prompt || input.voiceover || 'Digital human narration').trim() : buildPrompt(input)
  if (finalPrompt.length > 10000) {
    finalPrompt = finalPrompt.slice(0, 10000)
    onProgress?.('프롬프트가 10,000자를 넘어 잘랐습니다.')
  }

  const resolution = autodlResolution(input)
  let audioDuration = Math.max(5, Math.min(15, targetDuration))
  let body: Record<string, string | number>
  if (isAudioSync && input.audioBlob) {
    onProgress?.('내레이션 오디오를 준비하는 중…')
    const prepared = await toDigitalHumanWav(input.audioBlob, onProgress)
    const audioUrl = await blobToTypedDataUrl(prepared.blob, 'audio/wav')
    audioDuration = Math.max(5, Math.min(15, prepared.duration || targetDuration))
    // 이 워크플로는 네 필드만 받으며 5~15초 WAV 또는 MP3를 요구한다.
    body = {
      audio_duration: audioDuration,
      ref_audio_0: audioUrl,
      ref_image_0: dataUrls[0],
      resolution
    }
    onProgress?.(`내레이션 오디오 준비 완료. ${audioDuration}초 WAV, 약 ${(audioUrl.length / 1024 / 1024).toFixed(1)} MB`)
  } else {
    body = {
      prompt: finalPrompt,
      duration: targetDuration,
      resolution
    }
    if (isFl2va) {
      // b99_002 프레임 입력은 first_frame과 last_frame이다. prompt, duration, resolution, seed를 함께 보낸다.
      // ref_image_*를 더 보내면 공급자에서 정의되지 않은 인수로 거부한다.
      body.first_frame = dataUrls[0]
      body.last_frame = dataUrls[1]
    } else {
      dataUrls.forEach((url, index) => {
        body[`ref_image_${index}`] = url
      })
    }
  }
  let taskId = String(input.resumeTaskId || '').trim()
  if (taskId) {
    onProgress?.(`기존 작업(${taskId})을 다시 확인하는 중…`)
    log(`↻ 기존 작업 재조회  ${taskId}`)
  } else {
    onProgress?.(
      isAudioSync
        ? `디지털 휴먼 내레이션 작업을 제출하는 중(${resolution}, ${audioDuration}초)…`
        : isFl2va
          ? `시작·끝 프레임 작업을 제출하는 중(${input.aspectRatio || resolution})…`
          : `생성 작업을 제출하는 중(${input.aspectRatio || resolution}, 참조 이미지 ${dataUrls.length}장)…`
    )
    const submitCtl = controlledSignal(input.signal, 10 * 60_000)
    let submitResp: AutodlHttpResult
    try {
      submitResp = await autodlRequest(
        `${root}/comfyui_workflow/${encodeURIComponent(workflowId)}`,
        {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify(body),
          signal: submitCtl.signal
        },
        10 * 60_000
      )
    } catch (error: any) {
      if (isTimeoutAbort(error, submitCtl.signal)) {
        throw new Error(
          `영상 생성 요청이 10분을 넘었어요. 참조 이미지가 약 ${referencePayloadMb.toFixed(1)}MB예요. 네트워크를 확인하거나 이미지 크기를 줄여 주세요.`
        )
      }
      throw new Error(
        `[video] AutoDL에 연결할 수 없습니다. ${error?.message || String(error)}(참조 이미지 약 ${referencePayloadMb.toFixed(1)}MB)`
      )
    } finally {
      submitCtl.cleanup()
    }

    const submitText = await submitResp.text()
    let submitData: any = null
    try {
      submitData = submitText ? JSON.parse(submitText) : null
    } catch {
      submitData = null
    }
    if (!submitResp.ok) {
      const hint = submitResp.status === 413 ? '(요청 본문이 너무 큽니다. 참조 이미지 크기를 줄이세요.)' : ''
      throw new Error(`[video] 작업 제출에 실패했습니다. ${submitResp.status}${hint}${uiPunctuation.colon}${submitText.slice(0, 1200)}`)
    }
    const submitCode = String(submitData?.code ?? '')
    taskId = taskIdOf(submitData)
    if (submitCode && !/^success$/i.test(submitCode) && !taskId) {
      throw new Error(`[video] 작업 제출에 실패했어요.${uiPunctuation.colon}${submitData?.msg || submitCode}\n${submitText.slice(0, 400)}`)
    }
    if (!taskId) {
      throw new Error(`[video] 제출 응답에 task_id가 없습니다.\n원본 응답 ${submitText.slice(0, 400)}`)
    }
    await input.onTaskSubmitted?.(taskId)
    onProgress?.(`작업 제출 완료 (${taskId})`)
    log(`✓ 작업 제출 완료: ${taskId}`)
  }

  const start = Date.now()
  // 작업이 15분 넘게 대기할 수 있으므로 최대 30분 동안 조회하고 취소를 허용한다.
  // 스마트 내레이션은 구간별로 저장하므로 취소나 시간 초과 후 재개할 수 있다.
  const deadline = start + 30 * 60 * 1000
  /** AutoDL에서 SUCCESS를 반환한 뒤 결과 목록에 MP4가 나타날 수 있다. */
  const EMPTY_SUCCESS_GRACE_MS = 120_000
  let successEmptySince = 0
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    await abortableDelay(1000, input.signal)
    throwIfAborted(input.signal)
    const elapsed = Math.round((Date.now() - start) / 1000)
    onProgress?.(`대기열에 있거나 생성 중 ${elapsed}s`)

    let pollResp: AutodlHttpResult
    try {
      pollResp = await autodlRequest(
        `${root}/comfyui_workflow/result/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: authHeaders(apiKey, false),
          signal: input.signal
        },
        30_000
      )
    } catch (error: any) {
      onProgress?.(`조회가 중단되어 다시 시도하는 중… ${elapsed}s`)
      log(`상태 조회 네트워크 오류 #${attempt}: ${error?.message || error}`)
      continue
    }
    if (pollResp.status === 401 || pollResp.status === 403) {
      throw new Error(`[video] 상태 조회가 거부됐습니다(${pollResp.status}). 설정에서 AutoDL 토큰을 확인하세요.`)
    }
    const pollText = await pollResp.text()
    let pollData: any = null
    try {
      pollData = pollText ? JSON.parse(pollText) : null
    } catch {
      onProgress?.(`생성 중… ${elapsed}s(아직 JSON 응답이 도착하지 않음)`)
      continue
    }
    if (!pollData) {
      onProgress?.(`생성 중… ${elapsed}s`)
      continue
    }
    const status = taskStatusOf(pollData)
    const phase = classifyTaskStatus(status)
    const data = unwrapTaskPayload(pollData)
    const durationSec = Number(data?.duration) || elapsed
    const results = collectWorkflowResults(pollData)
    const picked = pickWorkflowVideoResult(results)
    if (attempt === 1 || attempt % 5 === 0 || (phase === 'success' && !picked)) {
      log(`상태 조회 #${attempt} (${elapsed}s) status=${status || '-'} results=${results.length}: ${pollText.slice(0, 280)}`)
    }
    if (picked) {
      log(`✓ 영상 주소 확인 (${phase || 'no-status'}): ${picked.url}`)
      onProgress?.('영상을 다운로드하는 중…')
      return await downloadGeneratedVideo(picked.url, input.signal, finalPrompt, targetDuration, onProgress)
    }
    if (phase === 'queued') {
      successEmptySince = 0
      onProgress?.(`대기 중… ${elapsed}s`)
      continue
    }
    if (phase === 'running') {
      successEmptySince = 0
      onProgress?.(`생성 중… ${durationSec}s`)
      continue
    }
    if (phase === 'failed') {
      throw new Error(`[video] 생성에 실패했습니다. ${taskErrorOf(pollData) || status}`)
    }
    if (phase === 'success') {
      if (!successEmptySince) successEmptySince = Date.now()
      const waited = Date.now() - successEmptySince
      if (waited < EMPTY_SUCCESS_GRACE_MS) {
        onProgress?.(`작업이 완료됐습니다. 영상 주소를 기다리는 중… ${Math.ceil((EMPTY_SUCCESS_GRACE_MS - waited) / 1000)}s`)
        continue
      }
      throw new Error(
        `[video] AutoDL이 작업을 완료로 표시했지만 results가 비어 있어 영상 다운로드 주소가 없습니다.task_id=${taskId}\n` +
          `워크플로가 ${durationSec || elapsed}초 실행됐습니다. 결과 파일이 아직 조회 응답에 반영되지 않았거나 워크플로가 MP4를 출력하지 않았을 수 있습니다.\n` +
          `생성을 다시 클릭하면 기존 작업을 계속 조회합니다. 계속 실패하면 이 task_id로 AutoDL 콘솔에서 실제 영상 생성 여부를 확인하세요.\n` +
          pollText.slice(0, 500)
      )
    }
    onProgress?.(`생성 중… ${elapsed}s${status ? uiPunctuation.parenthetical(status) : ''}`)
  }

  throw new Error(`[video] 영상 생성 시간이 30분을 초과했어요.${uiPunctuation.comma}task_id=${taskId}`)
}

/** Bailian wan3.0-video-prime는 이미지 한 장을 시작 프레임으로, 여러 장을 reference_image로 사용한다. 해상도는 노드의 480P, 720P, 1080P 선택을 따른다. */
async function realWanVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const tts = getTtsConfig()
  const apiRoot = dashscopeApiRoot(tts.baseUrl)
  const apiKey = tts.apiKey.trim()
  throwIfAborted(input.signal)
  if (!apiKey) {
    throw new Error(translate('providerErrors.videoDashscopeKey'))
  }

  const allBlobs = [input.imageBlob, ...(input.referenceImages ?? [])]
    .filter((b): b is Blob => !!b)
    .slice(0, 10)
  if (!allBlobs.length) {
    throw new Error('[video] 사용 가능한 이미지가 없습니다.')
  }

  onProgress?.('참조 이미지를 준비하는 중…')
  const urls: string[] = []
  for (const blob of allBlobs) {
    urls.push(await blobToVideoImageDataUrl(blob))
  }
  // 이미지가 두 장 이상이면 reference_image를 사용하고 first_frame 및 last_frame과 섞지 않는다.
  const media =
    urls.length === 1
      ? [{ type: 'first_frame', url: urls[0] }]
      : urls.map((url) => ({ type: 'reference_image', url }))

  const targetDuration = nearestVideoDuration(input.duration || 5, videoDurationCapability({ model: 'wan-prime' }).durations)
  let prompt = String(input.prompt || '').trim()
  if (!prompt) throw new Error('[video] 먼저 프롬프트를 작성하세요.')
  if (prompt.length > 20000) prompt = prompt.slice(0, 20000)

  const wanChoices = videoResolutionChoices({ model: 'wan-prime' })
  const wanTier = pickDocVideoResolution(input.videoResolution, wanChoices) || '720p'
  const wanQuality = videoResolutionApiValue(wanTier)
  const body = {
    model: WAN_PRIME_MODEL,
    input: { prompt, media },
    parameters: {
      resolution: wanQuality,
      ratio: wanRatio(input.aspectRatio),
      duration: targetDuration,
      prompt_extend: true,
      watermark: false,
      audio: true
    }
  }

  const modeLabel = media[0]?.type === 'first_frame' ? '시작 프레임' : `통합 참조 ${media.length}장`
  onProgress?.(`Wan에 작업을 요청하는 중… (${wanQuality}, ${modeLabel}, ${targetDuration}초)`)
  const auth = `Bearer ${apiKey}`
  const submitCtl = controlledSignal(input.signal, 10 * 60_000)
  let submitResp: AutodlHttpResult
  try {
    submitResp = await dashscopeRequest(
      `${apiRoot}/services/aigc/video-generation/video-synthesis`,
      {
        method: 'POST',
        authorization: auth,
        extraHeaders: { 'X-DashScope-Async': 'enable' },
        body: JSON.stringify(body),
        signal: submitCtl.signal
      },
      10 * 60_000
    )
  } catch (error: any) {
    if (isTimeoutAbort(error, submitCtl.signal)) {
      throw new Error('Wan 요청이 10분을 넘었어요. 네트워크를 확인하거나 참조 이미지 크기를 줄여 주세요.')
    }
    throw new Error(`[video] Bailian에 연결할 수 없습니다. ${error?.message || String(error)}`)
  } finally {
    submitCtl.cleanup()
  }

  const submitText = await submitResp.text()
  let submitData: any = null
  try {
    submitData = submitText ? JSON.parse(submitText) : null
  } catch {
    submitData = null
  }
  if (!submitResp.ok || submitData?.code) {
    throw new Error(
      `[video] Wan 작업 제출에 실패했습니다. ${submitData?.code || submitResp.status}：${
        submitData?.message || submitText.slice(0, 800)
      }`
    )
  }
  const taskId = String(submitData?.output?.task_id || submitData?.task_id || '').trim()
  if (!taskId) {
    throw new Error(`[video] Wan 제출 응답에 task_id가 없습니다.\n${submitText.slice(0, 400)}`)
  }
  onProgress?.(`작업 제출 완료 (${taskId})`)
  log(`✓ Wan 작업 제출 완료  ${taskId}`)

  const start = Date.now()
  const deadline = start + 15 * 60 * 1000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    await abortableDelay(3000, input.signal)
    throwIfAborted(input.signal)
    const elapsed = Math.round((Date.now() - start) / 1000)
    onProgress?.(`Wan이 영상을 생성하는 중 ${elapsed}s`)

    let pollResp: AutodlHttpResult
    try {
      pollResp = await dashscopeRequest(
        `${apiRoot}/tasks/${encodeURIComponent(taskId)}`,
        { method: 'GET', authorization: auth, signal: input.signal },
        30_000
      )
    } catch (error: any) {
      onProgress?.(`조회가 중단되어 다시 시도하는 중… ${elapsed}s`)
      log(`Wan 상태 조회 네트워크 오류 #${attempt}: ${error?.message || error}`)
      continue
    }
    const pollText = await pollResp.text()
    let pollData: any = null
    try {
      pollData = pollText ? JSON.parse(pollText) : null
    } catch {
      continue
    }
    const status = String(pollData?.output?.task_status || pollData?.task_status || '').toUpperCase()
    const videoUrl = String(pollData?.output?.video_url || pollData?.video_url || '').trim()
    if (attempt === 1 || attempt % 5 === 0) {
      log(`Wan 상태 조회 #${attempt} (${elapsed}s) status=${status || '-'} ${pollText.slice(0, 240)}`)
    }
    if (videoUrl) {
      log(`✓ Wan 영상 주소 확인  ${videoUrl}`)
      return await downloadGeneratedVideo(videoUrl, input.signal, prompt, targetDuration, onProgress)
    }
    if (status === 'PENDING') {
      onProgress?.(`대기 중… ${elapsed}s`)
      continue
    }
    if (status === 'RUNNING') {
      onProgress?.(`생성 중… ${elapsed}s`)
      continue
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(
        `[video] Wan 작업에 실패했습니다. ${pollData?.output?.message || pollData?.message || status}`
      )
    }
    if (status === 'UNKNOWN') {
      throw new Error('[video] Wan 작업이 만료됐습니다. 다시 생성하세요.')
    }
    if (status === 'SUCCEEDED' && !videoUrl) {
      throw new Error(`[video] Wan 작업이 완료됐지만 영상 주소가 없습니다.\n${pollText.slice(0, 800)}`)
    }
  }

  throw new Error(`[video] Wan 생성 시간이 15분을 초과했어요.${uiPunctuation.comma}task_id=${taskId}`)
}

/** 미리보기와 실제 생성이 같은 ComfyUI 및 MiniMax H3 프롬프트를 사용한다.
 *
 * H3의 다중 참조는 공식 Ref2VA 여섯 구역을, 시작 이미지 하나는 I2VA를 사용한다.
 * Wan은 H3 형식으로 바꾸지 않고 사용자 프롬프트를 보낸다.
 */
export function composeVideoPrompt(input: VideoGenInput): string {
  return buildPrompt(input)
}

function inferH3Mode(input: VideoGenInput): 'I2VA' | 'T2VA' | 'R2VA' | 'FL2VA' | 'L2VA' {
  if (input.h3GenMode === 'fl2va') return 'FL2VA'
  if (input.mode === 'FL2VA' || input.mode === 'L2VA' || input.mode === 'I2VA' || input.mode === 'T2VA') {
    return input.mode
  }
  if (
    input.h3GenMode === 'reference' ||
    input.mode === 'R2VA' ||
    isRef2VA({
      prompt: input.prompt,
      duration: input.duration,
      imageSlots: input.imageSlots,
      imageAssignments: input.imageAssignments
    })
  ) {
    return 'R2VA'
  }
  if (input.imageBlob || input.referenceImages?.length) return 'I2VA'
  return 'T2VA'
}

function buildPrompt(input: VideoGenInput): string {
  // promptAsIs는 모든 모드에서 입력란 원문을 그대로 보낸다.
  if (input.promptAsIs) return input.prompt
  const raw =
    input.videoModel === 'wan-prime'
      ? input.prompt
      : composeH3VideoPrompt({
          prompt: input.prompt,
          aesthetic: input.aesthetic,
          audioDescription: input.audioDescription,
          voiceover: input.voiceover,
          voiceMode: input.voiceMode,
          speakerHint: input.speakerHint,
          speakerVoice: input.speakerVoice,
          speakerName: input.speakerName,
          sceneName: input.sceneName,
          sceneDescription: input.sceneDescription,
          sceneLighting: input.sceneLighting,
          sceneAnchor: input.sceneAnchor,
          shotTitle: input.shotTitle,
          imageAssignments: input.imageAssignments,
          imageSlots: input.imageSlots,
          onScreenNames: input.onScreenNames,
          duration: input.duration,
          width: input.width,
          height: input.height,
          aspectRatio: input.aspectRatio,
          cameraMovement: input.cameraMovement,
          mode: inferH3Mode(input),
          promptStyle: input.promptStyle ?? getVideoPromptStyle()
        })
  if (input.h3GenMode === 'fl2va' && input.videoModel !== 'wan-prime') {
    return ensureFl2vaLead(raw, input.duration)
  }
  return raw
}

async function realApimartVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  if (!cfg.apiKey) {
    throw new Error(translate('providerErrors.videoApimartKey'))
  }
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('[video] 영상 설명을 입력하세요.')
  const images: Blob[] = []
  if (input.imageBlob) images.push(input.imageBlob)
  for (const blob of input.referenceImages || []) images.push(blob)
  if (input.lastFrameBlob) images.push(input.lastFrameBlob)
  onProgress?.('APIMart에서 영상을 생성하는 중…')
  const { blob, mimeType, duration } = await apimartGenerateVideo({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.workflowId,
    prompt,
    aspectRatio: input.aspectRatio,
    width: input.width,
    height: input.height,
    duration: input.duration,
    resolution: input.videoResolution,
    durationLimit: input.durationLimit,
    generateAudio: input.generateAudio,
    audioField: cfg.options?.audioField,
    images,
    signal: input.signal,
    onProgress,
    onTaskSubmitted: input.onTaskSubmitted,
    resumeTaskId: input.resumeTaskId
  })
  return { blob, mimeType, prompt, duration }
}

async function realHttpCustomVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  if (!cfg.baseUrl) throw new Error('[video] 사용자 지정 영상 API 주소가 없습니다.')
  const modelName = String(cfg.workflowId || '').trim()
  if (isApimartHost(cfg.baseUrl) && !modelName) {
    throw new Error('[video] APIMart 영상 연결의 워크플로 ID에 MiniMax-H3 같은 모델 이름을 입력하세요.')
  }
  const prompt = buildPrompt(input)
  const resolutionChoices = videoResolutionChoices({
    model: input.videoModel,
    profile: { name: cfg.name, workflowId: cfg.workflowId, options: cfg.options }
  })
  const pickedResolution = pickDocVideoResolution(input.videoResolution, resolutionChoices)
  onProgress?.('사용자 지정 HTTP API에서 영상을 생성하는 중…')
  const images: string[] = []
  if (input.imageBlob) images.push(await blobToDataUrl(input.imageBlob))
  for (const blob of input.referenceImages || []) {
    images.push(await blobToDataUrl(blob))
  }
  const lastFrame = input.lastFrameBlob ? await blobToDataUrl(input.lastFrameBlob) : undefined
  const { blob, mimeType } = await httpCustomMediaGenerate({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: modelName || 'video',
    prompt,
    adapter: cfg.adapter,
    extraBody: {
      ...(images[0] ? { image: images[0] } : {}),
      ...(images.length ? { images } : {}),
      ...(lastFrame ? { last_frame: lastFrame } : {}),
      duration: input.duration,
      aspect_ratio: input.aspectRatio && String(input.aspectRatio) !== 'auto' ? input.aspectRatio : '16:9',
      width: input.width,
      height: input.height,
      ...(pickedResolution ? { resolution: videoResolutionApiValue(pickedResolution) } : {}),
      ...(typeof input.generateAudio === 'boolean'
        ? { [cfg.options?.audioField || 'audio']: input.generateAudio }
        : {})
    },
    signal: input.signal,
    kind: 'video',
    onProgress
  })
  return { blob, mimeType, prompt, duration: input.duration }
}

async function realZealmanVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  const configuredRoot = String(cfg.zealmanBaseUrl || cfg.baseUrl || '').trim()
  const root = normalizeZealmanBaseUrl(configuredRoot) || configuredRoot.replace(/\/+$/, '')
  const workflow = zealmanWorkflowById(cfg.workflowId || '')
  if (!root) throw new Error('[video] 먼저 설정 → Zealman 미러에서 Base URL을 입력하세요.')
  if (/^https?:\/\/([^/]+\.)?autodl\.art(?::\d+)?$/i.test(root)) {
    throw new Error('[video] Zealman 미러에 AutoDL 주소가 설정돼 있습니다. 설정 → Zealman 미러에서 SeetaCloud Base URL을 입력하고 ‘설정 적용’을 클릭하세요.')
  }
  if (!workflow) throw new Error(`[video] 인식할 수 없는 Zealman 워크플로 ${cfg.workflowId || '없음'}`)

  if (workflow.mode !== 'fl2va' && [input.imageBlob, ...(input.referenceImages || [])].filter(Boolean).length > workflow.maxImages) {
    throw new Error(`이 워크플로는 참조 이미지 ${workflow.maxImages}장까지 사용할 수 있어요. 참조 이미지를 줄인 뒤 다시 생성하세요.`)
  }
  const blobs = workflow.mode === 'fl2va'
    ? [input.imageBlob, input.lastFrameBlob].filter((item): item is Blob => Boolean(item))
    : [input.imageBlob, ...(input.referenceImages || [])]
        .filter((item): item is Blob => Boolean(item))
        .slice(0, workflow.maxImages)
  if (workflow.mode === 'fl2va' && blobs.length < 2) throw new Error('[video] Zealman 시작·끝 프레임 워크플로에는 시작 프레임과 끝 프레임이 각각 필요합니다.')
  if (!blobs.length) throw new Error('[video] Zealman 워크플로에 사용할 수 있는 참조 이미지가 없습니다.')

  onProgress?.(`Zealman ${workflow.mode === 'fl2va' ? '시작·끝 프레임' : '다중 참조 이미지'} 워크플로를 준비하는 중…`)
  const images: string[] = []
  for (const blob of blobs) images.push(await blobToVideoImageDataUrl(blob))
  const prompt = buildPrompt(input).slice(0, 10000)
  const duration = Math.max(1, Math.min(workflow.maxDuration, Math.round(input.duration) || 5))
  const width = Math.max(256, Math.round(input.width) || 864)
  const height = Math.max(256, Math.round(input.height) || 480)
  const inputValues: Record<string, string | number> = {
    [workflow.stepsKey]: 12,
    [workflow.promptKey]: prompt,
    [workflow.durationKey]: duration,
    [workflow.widthKey]: width,
    [workflow.heightKey]: height
  }
  workflow.imageKeys.forEach((key, index) => {
    if (images[index]) inputValues[key] = images[index]
  })

  let promptId = String(input.resumeTaskId || '').trim()
  if (!promptId) {
    onProgress?.('Zealman 생성 작업을 제출하는 중…')
    const submitUrl = `${root}/api/workflow/generate`
    const submitBody = JSON.stringify({ workflow_id: workflow.id, input_values: inputValues })
    const postSubmit = (url: string) => autodlRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: submitBody,
        signal: input.signal
      }, 10 * 60_000)
    let finalSubmitUrl = submitUrl
    let response = await postSubmit(finalSubmitUrl)
    let text = await response.text()
    // 일부 Zealman 및 Nginx 환경은 끝 슬래시를 구분한다. 405이면 다른 형식으로 한 번 재시도한다.
    if (response.status === 405) {
      finalSubmitUrl = `${submitUrl}/`
      onProgress?.('미러 API가 끝에 슬래시가 없는 경로를 거부했습니다. 호환 경로로 다시 시도하는 중…')
      response = await postSubmit(finalSubmitUrl)
      text = await response.text()
    }
    if (!response.ok) {
      throw new Error(
        `[video] Zealman 작업 제출에 실패했습니다. HTTP ${response.status}\n요청 주소 ${finalSubmitUrl}\n${text.slice(0, 800)}`
      )
    }
    let data: any
    try { data = JSON.parse(text) } catch { throw new Error(`[video] Zealman 작업이 제출됐지만 응답이 JSON 형식이 아닙니다.\n요청 주소 ${finalSubmitUrl}\n${text.slice(0, 500)}`) }
    if (data?.success === false) throw new Error(`[video] Zealman 작업 제출에 실패했습니다. ${data?.error || text.slice(0, 800)}`)
    promptId = String(data?.prompt_id || '').trim()
    if (!promptId) throw new Error('[video] Zealman 응답에 prompt_id가 없습니다.')
    await input.onTaskSubmitted?.(promptId)
  }

  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    throwIfAborted(input.signal)
    onProgress?.(`Zealman에서 영상을 생성하는 중… (${promptId.slice(0, 8)})`)
    const response = await autodlRequest(
      `${root}/api/workflow/result?prompt_id=${encodeURIComponent(promptId)}`,
      { method: 'GET', signal: input.signal },
      60_000
    )
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = null }
    if (!response.ok || data?.success === false) throw new Error(`[video] Zealman 상태 조회에 실패했습니다. ${data?.error || text.slice(0, 800)}`)
    if (data?.pending === false) {
      const result = Array.isArray(data.results)
        ? data.results.find((item: any) => item?.type === 'video' && item?.url)
        : null
      if (!result?.url) throw new Error('[video] Zealman 작업이 완료됐지만 영상 파일을 반환하지 않았습니다.')
      const videoUrl = new URL(String(result.url), `${root}/`).toString()
      onProgress?.('Zealman이 생성한 영상을 다운로드하는 중…')
      const { blob: rawBlob, mime: mimeHint } = await fetchVideoBytes(videoUrl, input.signal)
      const blob = await assertVideoBlob(rawBlob, mimeHint)
      return { blob, mimeType: blob.type || 'video/mp4', prompt, duration }
    }
    await abortableDelay(1500, input.signal)
  }
  throw new Error('[video] Zealman 생성 시간이 30분을 넘어 상태 조회를 중단했습니다.')
}

async function realComfyNativeVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  if (!cfg.baseUrl) throw new Error('[video] 자체 호스팅 ComfyUI 주소가 없습니다.')
  onProgress?.('자체 호스팅 ComfyUI에서 영상을 생성하는 중…')
  const prompt = buildPrompt(input)
  let imageDataUrl: string | undefined
  if (input.imageBlob) imageDataUrl = await blobToDataUrl(input.imageBlob)
  let imageEndDataUrl: string | undefined
  if (input.lastFrameBlob) imageEndDataUrl = await blobToDataUrl(input.lastFrameBlob)
  let audioDataUrl: string | undefined
  if (input.audioBlob) audioDataUrl = await blobToDataUrl(input.audioBlob)
  if (!cfg.adapter?.workflowTemplate?.trim()) {
    throw new Error(
      '[video] 자체 호스팅 ComfyUI 연결의 adapter.workflowTemplate에 ComfyUI의 Save (API Format)으로 내보낸 JSON을 붙여 넣으세요. 연결 도우미로 시작 프레임과 프롬프트에 해당하는 노드를 매핑하세요. AutoDL 클라우드에는 comfyui-workflow 어댑터를 사용하세요.'
    )
  }
  const { blob, mimeType } = await comfyPromptGenerate({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    prompt,
    imageDataUrl,
    referenceImageDataUrls: await Promise.all((input.referenceImages || []).map(blobToDataUrl)),
    imageEndDataUrl,
    audioDataUrl,
    adapter: cfg.adapter,
    duration: input.duration,
    width: input.width,
    height: input.height,
    signal: input.signal,
    kind: 'video',
    onProgress,
    resumeTaskId: input.resumeTaskId,
    onTaskSubmitted: input.onTaskSubmitted
  })
  return { blob, mimeType, prompt, duration: input.duration }
}

async function ltxImageUri(blob: Blob) {
  const direct = /^(image\/(?:png|jpeg|webp))$/.test(blob.type) && blob.size <= 5_249_970
  const uri = await (direct ? blobToDataUrl(blob) : blobToVideoImageDataUrl(blob))
  if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(uri) || uri.length > 7_000_000) {
    throw new Error(translate('ltx.imageFormat'))
  }
  return uri
}

async function realLtxVideo(
  input: VideoGenInput,
  cfg: ReturnType<typeof getVideoConfig>,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const error = (key: string): never => { throw new Error(translate(`ltx.${key}`)) }
  if (!isDesktop() || !desktop().ltxRequest) return error('desktopOnly')
  const apiKey = cfg.apiKey
  if (!apiKey) return error('missingKey')
  const model = LTX_MODELS.includes(cfg.workflowId) ? cfg.workflowId : LTX_DEFAULT_MODEL
  const duration = ltxDuration(input.duration, model, input.videoResolution)
  const prompt = input.prompt.trim()
  const progress = (status: string) => onProgress?.(translate(`ltx.${status}`))
  const failure = async (reply: LtxReply): Promise<never> => {
    if (reply.kind === 'failed' || (reply.kind === 'http' && reply.status === 404)) {
      await input.onTaskTerminalFailure?.()
      return error(reply.kind === 'failed' ? reply.reason : 'expired')
    }
    if (reply.kind === 'http' && reply.status === 429) return error('queueFull')
    if (reply.kind === 'http' && [401, 403].includes(reply.status)) return error('invalidKey')
    return error('requestFailed')
  }
  let jobId = input.resumeTaskId?.startsWith('ltx:') ? input.resumeTaskId.slice(4) : undefined
  if (!jobId) {
    if (input.audioSync) return error('audioSync')
    if (!input.imageBlob) return error('missingFrame')
    if (!prompt || [...prompt].length > 5000) return error('prompt')
    if (input.aspectRatio && input.aspectRatio !== '16:9' && input.aspectRatio !== '9:16') return error('aspect')
    const body = ltxRequestBody({
      first: await ltxImageUri(input.imageBlob),
      last: input.lastFrameBlob ? await ltxImageUri(input.lastFrameBlob) : undefined,
      prompt, model, duration,
      resolution: input.videoResolution === '1080p' ? '1080p' : '720p',
      portrait: input.aspectRatio ? input.aspectRatio === '9:16' : input.height > input.width,
      audio: input.generateAudio
    })
    throwIfAborted(input.signal)
    progress('submitting')
    const submitted = await desktop().ltxRequest({ apiKey, body })
    if (submitted.kind !== 'submitted') {
      if (submitted.kind === 'http' && [400, 401, 403, 413, 429].includes(submitted.status)) {
        await input.onTaskTerminalFailure?.()
      }
      return failure(submitted)
    }
    jobId = submitted.id
    // Save accepted jobs even when the user stopped waiting during submission.
    await input.onTaskSubmitted?.(`ltx:${jobId}`)
  }
  const acceptedId = jobId
  progress('pending')
  const blob = await pollLtxJob({
    signal: input.signal,
    status: () => waitForLtxRead(() => desktop().ltxRequest({ apiKey, jobId: acceptedId }), input.signal),
    download: (url) => waitForLtxRead(async () => {
      const result = await fetchVideoBytes(url, input.signal)
      return assertVideoBlob(result.blob)
    }, input.signal),
    wait: (ms) => abortableDelay(ms, input.signal),
    progress,
    timeout: () => error('timeout'),
    failure
  })
  throwIfAborted(input.signal)
  return { blob, mimeType: blob.type, prompt, duration }
}

async function realLtxDesktopVideo(
  input: VideoGenInput,
  cfg: ReturnType<typeof getVideoConfig>,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  if (!isDesktop() || !desktop().ltxDesktopRequest) throw new Error(translate('ltx.desktopOnly'))
  if (!cfg.apiKey) throw new Error(translate('ltxDesktop.unpaired'))
  const request = (operation: LtxDesktopOperation) =>
    desktop().ltxDesktopRequest({ baseUrl: cfg.baseUrl, hostOverride: cfg.ltxHostOverride, token: cfg.apiKey, operation })
  const fail = (reply: LtxDesktopReply): never => {
    throw new Error(translate(ltxDesktopError(reply)))
  }
  const prompt = input.prompt.trim()
  const model = LTX_DESKTOP_MODELS.includes(cfg.workflowId) ? cfg.workflowId : LTX_DESKTOP_WORKFLOW
  const resolution = ltxDesktopResolution(input.videoResolution)
  const duration = ltxDuration(input.duration, model, resolution)
  let id = input.resumeTaskId?.startsWith('ltx-desktop:') ? input.resumeTaskId.slice('ltx-desktop:'.length) : undefined

  try {
    if (!id) {
      if (input.audioSync) throw new Error(translate('ltx.audioSync'))
      if (!input.imageBlob) throw new Error(translate('ltx.missingFrame'))
      if (input.aspectRatio && input.aspectRatio !== '16:9' && input.aspectRatio !== '9:16') {
        throw new Error(translate('ltx.aspect'))
      }
      const first = await ltxImageUri(input.imageBlob)
      const last = input.lastFrameBlob ? await ltxImageUri(input.lastFrameBlob) : undefined
      throwIfAborted(input.signal)
      onProgress?.(translate('ltxDesktop.submitting'))
      const reply = await request({
        kind: 'submit', first, last, model, prompt, duration,
        resolution,
        aspect: input.aspectRatio || (input.height > input.width ? '9:16' : '16:9')
      })
      if (reply.kind !== 'submitted') return fail(reply)
      id = reply.id
      await input.onTaskSubmitted?.(`ltx-desktop:${id}`)
    }

    const jobId = id
    const deadline = Date.now() + 60 * 60_000
    let expiredDownloads = 0
    while (Date.now() < deadline) {
      await abortableDelay(3000, input.signal)
      const reply = await waitForLtxRead(() => request({ kind: 'status', id: jobId }), input.signal)
      if (reply.kind === 'pending') onProgress?.(translate('ltxDesktop.queued'))
      else if (reply.kind === 'processing') {
        const status = reply.percent === undefined ? translate('ltxDesktop.processing')
          : translate('ltxDesktop.percent', { percent: reply.percent })
        const eta = reply.remainingSeconds === undefined ? ''
          : translate('ltxDesktop.eta', { seconds: reply.remainingSeconds })
        onProgress?.([status, eta].filter(Boolean).join(' · '))
      } else if (reply.kind === 'completed') {
        onProgress?.(translate('ltx.downloading'))
        const download = await waitForLtxRead(() => request({ kind: 'download', path: reply.path }), input.signal)
        if (download.kind === 'http' && download.status === 403 && expiredDownloads++ < 2) continue
        if (download.kind !== 'video') return fail(download)
        const blob = await assertVideoBlob(new Blob([download.data]), undefined)
        return { blob, mimeType: blob.type, prompt, duration }
      } else {
        if (reply.kind === 'failed' || (reply.kind === 'http' && reply.status === 404)) {
          await input.onTaskTerminalFailure?.()
        }
        return fail(reply)
      }
    }
    throw new Error(translate('ltx.timeout'))
  } catch (error) {
    const reason = input.signal?.reason
    if (id && reason instanceof DOMException && reason.message === translate('ltx.stopped')) {
      const reply = await request({ kind: 'cancel', id })
      if (reply.kind === 'failed' && reply.code === 'cancelled') await input.onTaskTerminalFailure?.()
      else if (!['processing', 'completed'].includes(reply.kind)) throw new Error(translate('ltxDesktop.cancelFailed'))
    }
    throw error
  }
}

export async function generateVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const mode = getAIMode()
  if (mode === 'real') {
    const resumeLtx = isLtxTask(input.resumeTaskId)
    if (resumeLtx || (input.videoModel !== 'h3-v5' && input.videoModel !== 'wan-prime')) {
      const cfg = getVideoConfig(input.videoProfileId)
      if (isLtxDesktop(cfg) && (!resumeLtx || input.resumeTaskId?.startsWith('ltx-desktop:'))) {
        return realLtxDesktopVideo(input, cfg, onProgress)
      }
      if (cfg.provider === 'ltx' && (!resumeLtx || input.resumeTaskId?.startsWith('ltx:'))) {
        return realLtxVideo(input, cfg, onProgress)
      }
      if (resumeLtx) throw new Error(translate('ltx.profileChanged'))
    }
    if (input.audioSync) {
      if (!input.imageBlob || !input.audioBlob) {
        throw new Error('[video] 디지털 휴먼 내레이션에는 캐릭터 참조 이미지와 해당 오디오가 필요합니다.')
      }
    } else if (input.h3GenMode === 'fl2va') {
      const requireLast = getVideoConfig(input.videoProfileId).options?.lastFrameRequired === true
      if (!input.imageBlob || (requireLast && !input.lastFrameBlob)) {
        throw new Error(
          requireLast
            ? '[video] 이 영상 모델에는 시작 프레임과 끝 프레임이 각각 필요합니다.'
            : '[video] 시작·끝 프레임 모드에서 시작 프레임이 필요합니다.'
        )
      }
    } else if (!input.imageBlob) {
      const peekId = input.videoModel === 'h3-v5' ? autodlVideoProfileId() || input.videoProfileId : input.videoProfileId
      const peek = getVideoConfig(peekId)
      if (!isApimartEndpoint(peek.baseUrl, peek.provider)) {
        throw new Error('[video] 실제 생성 모드에는 참조 이미지가 한 장 이상 필요합니다.')
      }
    }
    // 실제 생성이 실패하면 데모 영상을 반환하지 않는다.
    if (input.videoModel === 'wan-prime') {
      return await realWanVideo(input, onProgress)
    }
    const request = input.videoModel === 'h3-v5'
      ? { ...input, videoProfileId: autodlVideoProfileId() || input.videoProfileId }
      : input
    const vcfg = getVideoConfig(request.videoProfileId)
    if (isApimartEndpoint(vcfg.baseUrl, vcfg.provider)) {
      return await realApimartVideo(request, onProgress)
    }
    const adapterType = resolveVideoAdapter(vcfg)
    // Zealman 연결과 zealman-workflow 어댑터 및 내장 U 시리즈 ID가 모두 필요하다.
    // 10초 H3는 활성 Zealman 연결과 관계없이 AutoDL 워크플로를 사용한다.
    if (
      request.videoModel !== 'h3-v5' &&
      vcfg.provider === 'zealman' &&
      adapterType === 'zealman-workflow' &&
      zealmanWorkflowById(vcfg.workflowId || '')
    ) {
      return await realZealmanVideo(request, onProgress)
    }
    if (request.videoModel === 'h3-v5' && vcfg.provider === 'zealman') {
      throw new Error(translate('providerErrors.h3AutodlConfig'))
    }
    if (adapterType === 'comfyui-prompt') {
      return await realComfyNativeVideo(request, onProgress)
    }
    if (adapterType === 'http-custom') {
      return await realHttpCustomVideo(request, onProgress)
    }
    return await realWorkflowVideo(request, onProgress)
  }

  // 데모 영상은 첫 이미지만 사용한다.
  onProgress?.('데모 영상을 생성하는 중…')
  let imageBlob = input.imageBlob
  if (!imageBlob) {
    const { generateMockImage } = await import('./mock')
    imageBlob = await generateMockImage(
      input.prompt,
      input.width,
      input.height,
      'cinematic'
    )
  }
  const blob = await generateMockVideo(
    imageBlob,
    input.prompt,
    input.duration,
    input.width,
    input.height,
    input.cameraMovement
  )
  return { blob, mimeType: 'video/webm', prompt: buildPrompt(input), duration: input.duration }
}
