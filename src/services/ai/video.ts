/**
 * AI 视频生成（AutoDL.art ComfyUI 工作流 API）
 *
 *   POST {base}/api/v1/comfyui/comfyui_workflow/{workflow_id}
 *   GET  {base}/api/v1/comfyui/comfyui_workflow/result/{task_id}
 *
 * 参考图：prompt、duration、resolution、ref_image_0..8
 * 数字人音画同步：只传 audio_duration、ref_audio_0、ref_image_0、resolution
 * 工作流：minimax_h3_lightx2v_v5_15s / minimax_h3_lightx2v_v5 / minimax_h3_image_audio_to_video / minimax_h3_b99_002
 */

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
import { normalizeVideoResolution, videoMaxSeconds } from '@/types'
import { abortableDelay, controlledSignal, isTimeoutAbort, throwIfAborted } from './abort'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import { blobFromPath, desktop, isDesktop } from '@/services/desktop'
import { isLandscapeAspect } from '@/utils/aspect'
import { toDigitalHumanWav } from '@/services/ffmpeg'
import { normalizeZealmanBaseUrl, zealmanWorkflowById } from './zealman'

export interface VideoGenInput {
  /** 第一张参考图：角色设计图 / 场景图 / 故事看板之一，不是人物+场景配图 */
  imageBlob?: Blob
  /** 其余参考图，按角色设计图 → 场景图 → 故事看板的顺序 */
  referenceImages?: Blob[]
  /**
   * 发给出视频接口的提示词。promptAsIs 为真时不再编译/拼接。
   */
  prompt: string
  /** 框里的全文原样发送，不再套 H3 模板 */
  promptAsIs?: boolean
  /**
   * 项目级整体氛围（中文，1-2 段）
   * 会拼到 visualPrompt 前面
   */
  aesthetic?: string
  /**
   * 音效描述（中文短句，比如"雨声、灯火燃烧声"）
   * 写入 H3【声音设计】
   */
  audioDescription?: string
  /**
   * 口播/台词原文。人物名前缀会被剥离，只有正文进入 <d>[语言] 原词</d>。
   */
  voiceover?: string
  /** dialogue=H3 对口型；voiceover=H3 画外口播；none=不让 H3 生成人声 */
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  /** 说话人音色/身份提示（不含台词） */
  speakerHint?: string
  /** 说话角色的音色描述（中文，来自人物节点 voicePrompt），出镜对白与画外音都会带上 */
  speakerVoice?: string
  /** H3 官方多图提示词中的实际人物、场景与图片职责。 */
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
  width: number
  height: number
  /** 比例标签（写到 prompt 最前面 [16:9] 这种） */
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  /** 0-1，仅 mock 使用 */
  strength?: number
  signal?: AbortSignal
  promptStyle?: VideoPromptStyle
  /** 图生视频节点模型。默认 H3 15s；h3-v5 为 10 秒 1080p */
  videoModel?: VideoGenModel
  /** 锁定设置中的视频接入，生成时不能回落到另一个供应商。 */
  videoProfileId?: string
  /** h3-v5 可选 1080p */
  videoResolution?: VideoResolution
  /** H3：参考图生成或首尾帧。默认参考图。 */
  h3GenMode?: H3VideoGenMode
  /** 首尾帧模式的尾帧图 */
  lastFrameBlob?: Blob
  /** 文档有音频开关时，把节点上的有声/无声发给接口 */
  generateAudio?: boolean
  /** 数字人口播：与画面同步的口播音频 */
  audioBlob?: Blob
  /** 走 MiniMax H3 图+音频同步工作流 */
  audioSync?: boolean
  /** H3 任务类型。多图人设/场景/看板用 R2VA；单张首帧用 I2VA。 */
  mode?: 'I2VA' | 'T2VA' | 'R2VA' | 'FL2VA' | 'L2VA'
  /** 已提交的 AutoDL 工作流 task_id；传入后跳过提交，直接恢复轮询。 */
  resumeTaskId?: string
  /** 新任务提交成功后立即回传 task_id，调用方应持久化用于断点恢复。 */
  onTaskSubmitted?: (taskId: string) => void | Promise<void>
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

/** 从 workflow results 里挑真正的视频，绝不回落到预览图 */
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
      // OSS 签名链经常没有 .mp4 后缀
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

/** 确认下载内容是视频容器，避免把预览 PNG/JPEG 存成「视频」 */
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
  // 魔数不明时，若 hint 是 video/* 仍放行（少数代理剥掉头）
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

/** Blob → data:base64 字符串 */
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

/** 桌面端走主进程 net.fetch，绕开渲染进程 CORS；浏览器仍用 fetch */
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
      throw new Error('剧流 Studio를 완전히 종료한 뒤 다시 시작하세요. 데스크톱 앱에 새 AutoDL 연결이 필요합니다.')
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
      throw new Error('剧流 Studio를 완전히 종료한 뒤 다시 시작하세요. 데스크톱 앱에 새 Bailian 연결이 필요합니다.')
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
  // 各工作流的 resolution 枚举以 AutoDL 目录声明为准（2026-10-20 核对）：
  // 首尾帧 b99_002 只有 736p 三档；普通工作流是 480p/768p(/1080p) + 竖/横/(1:1)。
  const isFl2va = input.h3GenMode === 'fl2va'
  const quality = isFl2va
    ? '736p'
    : input.videoModel === 'h3-v5' && normalizeVideoResolution(input.videoResolution, 'h3-v5') === '1080p'
      ? '1080p'
      : '768p'
  const ratio = String(input.aspectRatio || '')
  if (ratio === '9:16') return `${quality}竖`
  // 数字人口播工作流没有 (1:1) 档，1:1 退化成横
  if (ratio === '1:1' && !input.audioSync) return `${quality}(1:1)`
  if (isLandscapeAspect(ratio) || ratio === '1:1') return `${quality}横`
  const landscape = (input.width || 0) >= (input.height || 0)
  return landscape ? `${quality}横` : `${quality}竖`
}

function unwrapTaskPayload(json: any): any {
  // data 有时直接就是 results 数组；数组也是 object，不能当任务对象拆。
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
  const dl = controlledSignal(signal, 120_000)
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

/** 提交到 AutoDL.art ComfyUI 工作流并轮询结果 */
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
    throw new Error('[video] AutoDL 토큰이 없습니다. 설정에서 이미지→영상 토큰을 입력하세요.')
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

  const MIN_DUR = 1
  const MAX_DUR = isAudioSync ? 15 : videoMaxSeconds(input.videoModel || 'h3')
  const targetDuration = Math.max(MIN_DUR, Math.min(MAX_DUR, Math.round(input.duration) || 5))
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
    // 该工作流只认这 4 个字段；时长必须 5–15，音频必须是 WAV/MP3
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
      // b99_002 首尾帧工作流只声明 first_frame/last_frame（另加 prompt/duration/resolution/seed），
      // 多传 ref_image_* 会被网关以「存在未定义的参数」直接打回，不要双写。
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
    const submitCtl = controlledSignal(input.signal, 120_000)
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
        120_000
      )
    } catch (error: any) {
      if (isTimeoutAbort(error, submitCtl.signal)) {
        throw new Error(
          `[video] 작업 제출 시간이 120초를 초과했습니다. 참조 이미지는 약 ${referencePayloadMb.toFixed(1)}MB입니다. 네트워크를 확인하거나 참조 이미지 크기를 줄이세요.`
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
      throw new Error(`[video] 작업 제출에 실패했습니다. ${submitResp.status}${hint}：${submitText.slice(0, 1200)}`)
    }
    const submitCode = String(submitData?.code ?? '')
    taskId = taskIdOf(submitData)
    if (submitCode && !/^success$/i.test(submitCode) && !taskId) {
      throw new Error(`[video] 작업 제출에 실패했습니다.：${submitData?.msg || submitCode}\n${submitText.slice(0, 400)}`)
    }
    if (!taskId) {
      throw new Error(`[video] 제출 응답에 task_id가 없습니다.\n원본 응답 ${submitText.slice(0, 400)}`)
    }
    await input.onTaskSubmitted?.(taskId)
    onProgress?.(`작업 제출 완료 (${taskId})`)
    log(`✓ 작업 제출 완료: ${taskId}`)
  }

  const start = Date.now()
  // 旺时任务可能在队列中超过 15 分钟。保留到 30 分钟，并允许调用方随时 abort；
  // 智能口播会逐段落库，因此取消或超时后可以从已完成段继续。
  const deadline = start + 30 * 60 * 1000
  /** AutoDL 常先标 SUCCESS 再把 mp4 写进 results（ComfyUI 落盘有竞态）。 */
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
    onProgress?.(`생성 중… ${elapsed}s${status ? `（${status}）` : ''}`)
  }

  throw new Error(`[video] 영상 생성 시간이 30분을 초과했습니다.，task_id=${taskId}`)
}

/** 百炼 wan3.0-video-prime：单张首帧，多张走全能参考（reference_image），固定 720P */
async function realWanVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const tts = getTtsConfig()
  const apiRoot = dashscopeApiRoot(tts.baseUrl)
  const apiKey = tts.apiKey.trim()
  throwIfAborted(input.signal)
  if (!apiKey) {
    throw new Error('[video] Bailian 토큰이 없습니다. 설정에서 내레이션 TTS의 DashScope 키를 입력하세요.')
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
  // 单张：严格首帧生视频。两张及以上：全能参考（不能和 first_frame/last_frame 混用）
  const media =
    urls.length === 1
      ? [{ type: 'first_frame', url: urls[0] }]
      : urls.map((url) => ({ type: 'reference_image', url }))

  const targetDuration = Math.max(2, Math.min(30, Math.round(input.duration) || 5))
  let prompt = String(input.prompt || '').trim()
  if (!prompt) throw new Error('[video] 먼저 프롬프트를 작성하세요.')
  if (prompt.length > 20000) prompt = prompt.slice(0, 20000)

  const body = {
    model: WAN_PRIME_MODEL,
    input: { prompt, media },
    parameters: {
      resolution: '720P',
      ratio: wanRatio(input.aspectRatio),
      duration: targetDuration,
      prompt_extend: true,
      watermark: false,
      audio: true
    }
  }

  const modeLabel = media[0]?.type === 'first_frame' ? '시작 프레임' : `멀티모달 참조 ${media.length}개`
  onProgress?.(`Wan 작업을 제출하는 중(720P, ${modeLabel}, ${targetDuration}초)…`)
  const auth = `Bearer ${apiKey}`
  const submitCtl = controlledSignal(input.signal, 120_000)
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
      120_000
    )
  } catch (error: any) {
    if (isTimeoutAbort(error, submitCtl.signal)) {
      throw new Error('[video] Wan 작업 제출 시간이 120초를 초과했습니다. 네트워크를 확인하거나 참조 이미지 크기를 줄이세요.')
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

  throw new Error(`[video] Wan 생성 시간이 15분을 초과했습니다.，task_id=${taskId}`)
}

/** 拼最终喂给 ComfyUI / MiniMax H3 的视频提示词（页面预览 / 实际生成共用）
 *
 * 选 H3 时：多图人设/场景/看板走官方 Ref2VA 六段；单张首帧走 I2VA。
 * 选万相时原样使用用户提示词，不套 H3 格式。
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
  // promptAsIs 是不可绕过的用户契约：任何模式都必须逐字发送输入框内容。
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
    throw new Error('[video] APIMart 영상 연결에 전용 API 키가 없습니다. 이 연결에는 APIMart 키가 필요합니다.')
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
      }, 180_000)
    let finalSubmitUrl = submitUrl
    let response = await postSubmit(finalSubmitUrl)
    let text = await response.text()
    // 部分 Zealman/Nginx 部署对结尾斜杠采用严格路由；405 时换一种形式重试一次。
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
    imageEndDataUrl,
    audioDataUrl,
    adapter: cfg.adapter,
    signal: input.signal,
    kind: 'video',
    onProgress
  })
  return { blob, mimeType, prompt, duration: input.duration }
}

export async function generateVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const mode = getAIMode()
  if (mode === 'real') {
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
    // 真实模式失败不再静默回退 mock，避免把「假动画/静态图」当成成品视频
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
    // 三条都要成立才走镜像：接入声明是 Zealman、适配器是 zealman-workflow、工作流 id 是内置 U 系列。
    // 10 秒 H3 固定是 AutoDL 工作流，不能因为当前激活项是 Zealman 就改道。
    if (
      request.videoModel !== 'h3-v5' &&
      vcfg.provider === 'zealman' &&
      adapterType === 'zealman-workflow' &&
      zealmanWorkflowById(vcfg.workflowId || '')
    ) {
      return await realZealmanVideo(request, onProgress)
    }
    if (request.videoModel === 'h3-v5' && vcfg.provider === 'zealman') {
      throw new Error('[video] 10초 H3는 AutoDL 워크플로를 사용합니다. 사용 가능한 AutoDL 연결이 없습니다. 설정에서 AutoDL 컴퓨팅 연결을 저장하세요.')
    }
    if (adapterType === 'comfyui-prompt') {
      return await realComfyNativeVideo(request, onProgress)
    }
    if (adapterType === 'http-custom') {
      return await realHttpCustomVideo(request, onProgress)
    }
    return await realWorkflowVideo(request, onProgress)
  }

  // mock：只需要一张图（多张也只用第一张）
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
