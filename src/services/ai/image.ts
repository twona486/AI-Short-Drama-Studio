/**
 * OpenAI 호환 Images API를 이용한 AI 이미지 생성
 *
 * 이미지 생성 및 편집 요청 형식
 *   POST /images/generations
 *   텍스트→이미지에서는 image를 생략한다.
 *   이미지 편집에서는 URL 또는 데이터 URL을 image 배열에 넣고 sequential_image_generation을 disabled로 설정한다.
 *
 * 응답은 접두사 없는 b64_json을 우선하며 URL도 지원한다.
 */

import { getAIMode } from './client'
import { getImageConfig } from './runtime'
import { generateMockImage } from './mock'
import {
  httpCustomImageGenerate,
  comfyPromptGenerate,
  resolveImageAdapter
} from './adapters'
import { apimartGenerateImage, isRelayImageEndpoint } from './apimart'
import { autodlRequest } from './video'
import {
  normalizeZealmanBaseUrl,
  zealmanImageWorkflowById,
  ZEALMAN_IMAGE_WORKFLOWS
} from './zealman'
import type { VisualStyle, AspectRatio } from '@/types'
import { abortableDelay, throwIfAborted } from './abort'

export interface ImageGenInput {
  prompt: string
  style: VisualStyle
  width: number
  height: number
  /** 프롬프트 앞에 16:9나 9:16 같은 화면 비율 태그를 붙인다. */
  aspectRatio?: AspectRatio
  n?: number
  /** 이미지 편집 및 합성에 참조를 최대 10장 제공한다. 일반적으로 캐릭터와 장면 이미지 1~3장을 쓴다. */
  referenceImages?: Blob[]
  /** 참조마다 프롬프트에 넣을 역할 설명 */
  referenceLabels?: string[]
  /** 설정의 이미지 모델을 재정의한다. 예를 들어 영상 재현은 gpt-image-1을 사용한다. */
  model?: string
  /** 서비스가 허용하는 1k, 2k, 4k 출력 옵션 */
  resolution?: string
  signal?: AbortSignal
}

export interface ImageGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
}

const log = (msg: string) =>
  console.log('%c[image]', 'color:#f59e0b;font-weight:600', msg)

function imageConfig(modelOverride?: string) {
  const cfg = getImageConfig()
  return {
    ...cfg,
    model: modelOverride?.trim() || cfg.model
  }
}

async function realCustomOrComfy(input: ImageGenInput): Promise<ImageGenOutput> {
  const cfg = imageConfig(input.model)
  const adapterType = resolveImageAdapter(cfg)
  const prompt = withGptImageQuality(buildPrompt(input, Boolean(input.referenceImages?.length)), cfg.model)
  if (adapterType === 'http-custom') {
    log(`→ 사용자 지정 HTTP 이미지 생성 · ${cfg.model}`)
    const imageUrls: string[] = []
    for (const blob of input.referenceImages || []) {
      imageUrls.push(await blobToDataUri(blob))
    }
    const { blob, mimeType } = await httpCustomImageGenerate({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      prompt,
      adapter: cfg.adapter,
      extraBody: {
        ...(imageUrls.length ? { image: imageUrls, image_urls: imageUrls } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        n: 1
      },
      signal: input.signal
    })
    return { blob, mimeType, prompt: input.prompt }
  }
  if (adapterType === 'comfyui-prompt' || adapterType === 'comfyui-workflow') {
    log(`→ ComfyUI 이미지 생성 · ${adapterType}`)
    let imageDataUrl: string | undefined
    if (input.referenceImages?.[0]) {
      imageDataUrl = await blobToDataUri(input.referenceImages[0])
    }
    const { blob, mimeType } = await comfyPromptGenerate({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      prompt,
      imageDataUrl,
      adapter: cfg.adapter,
      signal: input.signal,
      kind: 'image'
    })
    return { blob, mimeType, prompt: input.prompt }
  }
  throw new Error(`[image] 알 수 없는 어댑터 ${adapterType}`)
}

function isSeedreamModel(model: string): boolean {
  return /^seedream-/i.test(model)
}

function isGptImageModel(model: string): boolean {
  return /gpt[-_]?image|dall-e|dalle/i.test(model)
}

const GPT_IMAGE_QUALITY_SUFFIX = 'Reduce noise, speckling, and smearing. Use smooth colors and a clean finish.'

function withGptImageQuality(prompt: string, model: string): string {
  const base = String(prompt || '').trim()
  if (!isGptImageModel(model)) return base
  if (!base) return GPT_IMAGE_QUALITY_SUFFIX
  if (base.includes(GPT_IMAGE_QUALITY_SUFFIX)) return base
  return `${base} ${GPT_IMAGE_QUALITY_SUFFIX}`
}

/** 이미지 API 응답을 Blob으로 변환한다. b64_json을 우선 사용한다. */
async function imageResponseToBlob(
  data: any,
  apiKey?: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; mimeType: string }> {
  const item = data.data?.[0]
  if (!item) {
    throw new Error('이미지 API 응답에 data[0]이 없습니다.')
  }

  // Seedream과 호환 공급자의 b64_json 응답을 처리한다.
  if (item.b64_json) {
    const raw = String(item.b64_json).replace(/\s/g, '')
    const bytes = atob(raw)
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    // 4.5와 4.0은 JPEG를 반환하지만 5.0은 PNG도 가능하므로 파일 서명을 검사한다.
    const mime =
      arr[0] === 0x89 && arr[1] === 0x50
        ? 'image/png'
        : arr[0] === 0xff && arr[1] === 0xd8
          ? 'image/jpeg'
          : 'image/jpeg'
    return { blob: new Blob([arr], { type: mime }), mimeType: mime }
  }

  // URL 응답을 처리한다.
  if (item.url) {
    const r = await fetch(item.url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal
    })
    if (!r.ok) throw new Error(`이미지 다운로드에 실패했습니다. ${r.status}`)
    const blob = await r.blob()
    return { blob, mimeType: blob.type || 'image/jpeg' }
  }

  // 최상위 b64_json 응답을 처리한다.
  if (data.b64_json) {
    const bytes = atob(String(data.b64_json).replace(/\s/g, ''))
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    return { blob: new Blob([arr], { type: 'image/jpeg' }), mimeType: 'image/jpeg' }
  }

  throw new Error(
    `이미지 응답에 b64_json과 url이 없어 해석할 수 없습니다.\n원본 응답 ${JSON.stringify(data).slice(0, 200)}`
  )
}

/**
 * Seedream 크기는 프리셋 또는 정확한 너비와 높이로 지정한다.
 * seedream-4.5에서 정확한 크기의 최소값은 약 3,686,400픽셀이다.
 * 전체 픽셀 수는 최대 4096×4096이며 화면 비율은 1:16에서 16:1 사이다.
 */
const SEEDREAM_MIN_PIXELS = 3_686_400
const SEEDREAM_MAX_PIXELS = 4096 * 4096

function even(n: number): number {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v + 1
}

function scaleToPixelBudget(
  w: number,
  h: number,
  minPixels: number,
  maxPixels: number
): { width: number; height: number } {
  let width = even(w)
  let height = even(h)
  let pixels = width * height
  if (pixels < minPixels) {
    const scale = Math.sqrt(minPixels / pixels)
    width = even(width * scale)
    height = even(height * scale)
    pixels = width * height
  }
  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels)
    width = even(width * scale)
    height = even(height * scale)
  }
  return { width, height }
}

function pickSeedreamSize(ar?: AspectRatio, w?: number, h?: number): string {
  // 프로젝트 크기를 유지하면서 최소 픽셀 수에 맞게 확대한다.
  if (w && h && w > 0 && h > 0) {
    const { width, height } = scaleToPixelBudget(
      w,
      h,
      SEEDREAM_MIN_PIXELS,
      SEEDREAM_MAX_PIXELS
    )
    const ratio = width / height
    if (ratio >= 1 / 16 && ratio <= 16) return `${width}x${height}`
  }

  // 화면 비율과 최소 픽셀 수를 만족하는 일반 크기를 사용한다.
  switch (ar) {
    case '16:9':
      return '2560x1440'
    case '9:16':
      return '1440x2560'
    case '1:1':
      return '2048x2048'
    case '4:3':
      return '2304x1728'
    case '21:9':
      return '3360x1440'
    default:
      return '2560x1440'
  }
}

/** 이전 OpenAI 호환 및 gpt-image 크기의 대체값 */
function pickLegacySize(ar?: AspectRatio, w?: number, h?: number): string {
  if (ar === '16:9') return '1792x1024'
  if (ar === '9:16') return '1024x1792'
  if (ar === '1:1') return '1024x1024'
  if (ar === '4:3') return '1536x1024'
  if (ar === '21:9') return '1792x768'
  if (w && h) {
    if (h > w) return '1024x1792'
    if (Math.abs(w - h) < 100) return '1024x1024'
    return '1792x1024'
  }
  return '1024x1024'
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('참조 이미지를 base64로 변환하지 못했습니다.'))
    reader.readAsDataURL(blob)
  })
}

/** 큰 참조를 JPEG 데이터 URI로 압축해 요청 크기를 줄인다. */
async function blobToChatImageDataUri(
  blob: Blob,
  maxEdge = 1536,
  quality = 0.88
): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return blobToDataUri(blob)
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return blobToDataUri(blob)
  }
}

function buildPrompt(input: ImageGenInput, _withRefs: boolean): string {
  const model = imageConfig(input.model).model
  return withGptImageQuality(input.prompt, model)
}

/** Seedream은 /images/generations를 호출하고 b64_json을 우선 요청한다. */
async function realSeedream(input: ImageGenInput): Promise<ImageGenOutput> {
  const { baseUrl, apiKey, model } = imageConfig(input.model)
  if (!baseUrl || !apiKey) {
    throw new Error('[image] VITE_IMAGE_BASE_URL 또는 VITE_IMAGE_API_KEY가 설정되지 않았습니다.')
  }

  const refs = (input.referenceImages ?? []).slice(0, 10)
  const withRefs = refs.length > 0
  const fullPrompt = buildPrompt(input, withRefs)
  const size = pickSeedreamSize(input.aspectRatio, input.width, input.height)

  const body: Record<string, unknown> = {
    model,
    prompt: fullPrompt,
    size,
    response_format: 'b64_json',
    watermark: false
  }

  if (withRefs) {
    const images: string[] = []
    for (const blob of refs) {
      images.push(await blobToChatImageDataUri(blob))
    }
    body.image = images
    body.sequential_image_generation = 'disabled'
    log(`→ Seedream 참조 이미지 ${images.length}장 합성 · ${model} · ${size}`)
  } else {
    log(`→ Seedream 텍스트→이미지 · ${model} · ${size}`)
  }

  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: input.signal
  })

  if (!resp.ok) {
    throw new Error(`[image] 이미지 생성에 실패했습니다. ${resp.status} ${await resp.text()}`)
  }

  const data = await resp.json()
  const { blob, mimeType } = await imageResponseToBlob(data, apiKey, input.signal)
  log(`✓ ${(blob.size / 1024).toFixed(1)} KB (${mimeType})`)
  return { blob, mimeType, prompt: input.prompt }
}

/** 이전 gpt-image 텍스트→이미지 경로 */
async function realLegacyGenerate(input: ImageGenInput): Promise<ImageGenOutput> {
  const { baseUrl, apiKey, model } = imageConfig(input.model)
  if (!baseUrl || !apiKey) {
    throw new Error('[image] VITE_IMAGE_BASE_URL 또는 VITE_IMAGE_API_KEY가 설정되지 않았습니다.')
  }

  const fullPrompt = buildPrompt(input, false)
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: fullPrompt,
      n: input.n ?? 1,
      size: pickLegacySize(input.aspectRatio, input.width, input.height),
      response_format: 'b64_json'
    }),
    signal: input.signal
  })

  if (!resp.ok) {
    throw new Error(`[image] 텍스트→이미지 생성에 실패했습니다. ${resp.status} ${await resp.text()}`)
  }

  const data = await resp.json()
  const { blob, mimeType } = await imageResponseToBlob(data, apiKey, input.signal)
  return { blob, mimeType, prompt: input.prompt }
}

/** 이전 gpt-image 편집의 멀티파트 경로 */
async function realLegacyEdit(input: ImageGenInput): Promise<ImageGenOutput> {
  const { baseUrl, apiKey, model } = imageConfig(input.model)
  if (!baseUrl || !apiKey) {
    throw new Error('[image] VITE_IMAGE_BASE_URL 또는 VITE_IMAGE_API_KEY가 설정되지 않았습니다.')
  }
  if (!input.referenceImages?.length) {
    throw new Error('이미지 편집 모드에는 referenceImages가 필요합니다.')
  }

  const fullPrompt = buildPrompt(input, true)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', fullPrompt)
  form.append('size', pickLegacySize(input.aspectRatio, input.width, input.height))
  form.append('response_format', 'b64_json')

  const refs = input.referenceImages.slice(0, 4)
  for (let i = 0; i < refs.length; i++) {
    const blob = refs[i]
    const ext = blob.type.includes('png')
      ? 'png'
      : blob.type.includes('webp')
        ? 'webp'
        : 'jpg'
    form.append('image[]', blob, `ref_${i}.${ext}`)
  }

  const resp = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: input.signal
  })

  if (!resp.ok) {
    throw new Error(`[image] 이미지 편집에 실패했습니다. ${resp.status} ${await resp.text()}`)
  }

  const data = await resp.json()
  const { blob, mimeType } = await imageResponseToBlob(data, apiKey, input.signal)
  return { blob, mimeType, prompt: input.prompt }
}

/** Zealman 이미지 요청은 설정된 주소의 /api/workflow/generate로 제출하고 /api/workflow/result로 조회한다. */
async function realZealmanImage(
  input: ImageGenInput,
  onProgress?: (msg: string) => void
): Promise<ImageGenOutput> {
  const cfg = imageConfig(input.model)
  const root = normalizeZealmanBaseUrl(String(cfg.baseUrl || '').trim())
  if (!root) throw new Error('[image] Zealman에서 이미지를 생성하려면 설정 → Zealman 미러에서 Base URL을 입력하세요.')
  const workflow = zealmanImageWorkflowById(cfg.model) || ZEALMAN_IMAGE_WORKFLOWS[0]
  const prompt = buildPrompt(input, Boolean(input.referenceImages?.length)).slice(0, 10000)
  const width = Math.max(256, Math.round(input.width) || workflow.defaultWidth)
  const height = Math.max(256, Math.round(input.height) || workflow.defaultHeight)
  const inputValues: Record<string, string | number> = {
    [workflow.promptKey]: prompt,
    [workflow.negativeKey]: workflow.defaultNegative,
    [workflow.seedKey]: Math.floor(Math.random() * 2_147_483_647),
    [workflow.widthKey]: width,
    [workflow.heightKey]: height
  }
  onProgress?.(`Zealman 이미지 작업을 제출하고 있어요(${workflow.displayName})…`)
  const submitUrl = `${root}/api/workflow/generate`
  const submitBody = JSON.stringify({ workflow_id: workflow.id, input_values: inputValues })
  const postSubmit = (url: string) =>
    autodlRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: submitBody,
        signal: input.signal
      },
      180_000
    )
  let response = await postSubmit(submitUrl)
  let text = await response.text()
  // 일부 Zealman 및 Nginx 환경은 끝 슬래시를 구분해 405이면 다른 형식으로 한 번 재시도한다.
  if (response.status === 405) {
    response = await postSubmit(`${submitUrl}/`)
    text = await response.text()
  }
  if (!response.ok) {
    throw new Error(`[image] Zealman 작업 제출에 실패했습니다. HTTP ${response.status}\n${text.slice(0, 800)}`)
  }
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('[image] Zealman 작업이 제출됐지만 응답이 JSON 형식이 아닙니다.')
  }
  if (data?.success === false) throw new Error(`[image] Zealman 작업 제출에 실패했습니다.：${data?.error || text.slice(0, 800)}`)
  const promptId = String(data?.prompt_id || '').trim()
  if (!promptId) throw new Error('[image] Zealman 응답에 prompt_id가 없습니다.')

  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    throwIfAborted(input.signal)
    onProgress?.('Zealman에서 이미지를 생성하는 중…')
    const poll = await autodlRequest(
      `${root}/api/workflow/result?prompt_id=${encodeURIComponent(promptId)}`,
      { method: 'GET', signal: input.signal },
      60_000
    )
    const pollText = await poll.text()
    let pollData: any
    try {
      pollData = JSON.parse(pollText)
    } catch {
      pollData = null
    }
    if (!poll.ok || pollData?.success === false) {
      throw new Error(`[image] Zealman 상태 조회에 실패했습니다. ${pollData?.error || pollText.slice(0, 800)}`)
    }
    if (pollData?.pending === false) {
      const result = Array.isArray(pollData.results)
        ? pollData.results.find((item: any) => item?.type === 'image' && item?.url)
        : null
      if (!result?.url) throw new Error('[image] Zealman 작업이 완료됐지만 이미지를 반환하지 않았습니다.')
      const imageUrl = new URL(String(result.url), `${root}/`).toString()
      onProgress?.('Zealman이 생성한 이미지를 다운로드하는 중…')
      const dl = await fetch(imageUrl, { signal: input.signal })
      if (!dl.ok) throw new Error(`[image] Zealman 이미지 다운로드에 실패했습니다. HTTP ${dl.status}`)
      const blob = await dl.blob()
      return { blob, mimeType: blob.type || 'image/png', prompt }
    }
    await abortableDelay(1500, input.signal)
  }
  throw new Error('[image] Zealman 생성 시간이 15분을 넘어 상태 조회를 중단했습니다.')
}

export async function generateImage(
  input: ImageGenInput,
  onProgress?: (msg: string) => void
): Promise<ImageGenOutput> {
  onProgress?.('이미지 생성을 준비하는 중…')
  const model = imageConfig(input.model).model

  if (getAIMode() === 'real') {
    const cfg = imageConfig(input.model)
    const adapterType = resolveImageAdapter(cfg)
    if (adapterType === 'zealman-workflow') {
      onProgress?.('Zealman에서 이미지를 생성하는 중…')
      return await realZealmanImage(input, onProgress)
    }
    if (
      adapterType !== 'comfyui-prompt' &&
      adapterType !== 'comfyui-workflow' &&
      (isRelayImageEndpoint(cfg.baseUrl, cfg.provider) || adapterType === 'http-custom')
    ) {
      const prompt = withGptImageQuality(buildPrompt(input, Boolean(input.referenceImages?.length)), cfg.model)
      onProgress?.(input.referenceImages?.length ? '중계 API에서 이미지→이미지를 생성하는 중…' : '중계 API에서 텍스트→이미지를 생성하는 중…')
      const { blob, mimeType } = await apimartGenerateImage({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        prompt,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution || cfg.options?.imageResolutions?.[0],
        n: input.n,
        referenceImages: input.referenceImages,
        signal: input.signal,
        onProgress
      })
      return { blob, mimeType, prompt }
    }
    if (adapterType === 'comfyui-prompt' || adapterType === 'comfyui-workflow') {
      onProgress?.('ComfyUI에서 이미지를 생성하는 중…')
      return await realCustomOrComfy(input)
    }
    if (isSeedreamModel(model)) {
      onProgress?.(
        input.referenceImages?.length
          ? `참조 이미지 ${input.referenceImages.length}장을 합성하는 중…`
          : '텍스트→이미지를 생성하는 중…'
      )
      return await realSeedream(input)
    }
    if (input.referenceImages && input.referenceImages.length > 0) {
      onProgress?.(`이미지→이미지 생성 중(참조 이미지 ${input.referenceImages.length}장)…`)
      return await realLegacyEdit(input)
    }
    onProgress?.('텍스트→이미지를 생성하는 중…')
    return await realLegacyGenerate(input)
  }

  if (input.referenceImages && input.referenceImages.length > 0) {
    onProgress?.('(데모) 참조 이미지를 합성하는 중…')
    await abortableDelay(600, input.signal)
    return await generateMockWithReferences(input)
  }

  await abortableDelay(600, input.signal)
  const blob = await generateMockImage(
    input.prompt,
    input.width,
    input.height,
    input.style
  )
  return { blob, mimeType: 'image/png', prompt: input.prompt }
}

/** 데모에서는 참조 이미지를 합치고 필터를 적용한다. */
async function generateMockWithReferences(
  input: ImageGenInput
): Promise<ImageGenOutput> {
  const canvas = document.createElement('canvas')
  canvas.width = input.width
  canvas.height = input.height
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, input.width, input.height)

  const refs = input.referenceImages!
  const thumbSize =
    Math.min(input.width, input.height) / Math.max(2, Math.sqrt(refs.length))
  for (let i = 0; i < refs.length; i++) {
    try {
      const bitmap = await createImageBitmap(refs[i])
      const col = i % Math.ceil(Math.sqrt(refs.length))
      const row = Math.floor(i / Math.ceil(Math.sqrt(refs.length)))
      const x = col * thumbSize + thumbSize / 2 - thumbSize / 4
      const y = row * thumbSize + thumbSize / 2 - thumbSize / 4
      ctx.globalAlpha = 0.6
      ctx.drawImage(bitmap, x, y, thumbSize / 2, thumbSize / 2)
      ctx.globalAlpha = 1
    } catch {
      /* ignore */
    }
  }

  const { styleToFilter } = await import('./mock')
  ctx.filter = styleToFilter(input.style)
  ctx.drawImage(canvas, 0, 0)
  ctx.filter = 'none'

  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = `bold ${Math.round(input.width * 0.025)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(
    `[데모] 참조 이미지 ${refs.length}장 + ${input.prompt.slice(0, 30)}`,
    input.width / 2,
    input.height - 40
  )

  return await new Promise<ImageGenOutput>((resolve) =>
    canvas.toBlob((b) =>
      resolve({ blob: b!, mimeType: 'image/png', prompt: input.prompt })
    )
  )
}
