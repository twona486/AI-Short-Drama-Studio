/**
 * AI 服务通用 client
 */

export type { AIMode } from '@/stores/settings'
export { getAIMode } from './runtime'

import { t as translate } from '@/i18n'
import { desktop, isDesktop } from '@/services/desktop'
import { parseJsonRobust } from '@/utils/jsonRepair'
import { mockLLM } from './mock'
import { getAIMode, getLlmConfig, getVisionConfig } from './runtime'

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LLMContentPart[]
}

export interface LLMRequest {
  messages: LLMMessage[]
  provider?: 'llm' | 'vision'
  /** 覆盖设置页模型，例如视频复刻用 qwen3.8-max */
  model?: string
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  /** 豆包会先思考再回答。只要正文时关掉，直接返回文本。 */
  disableThinking?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export interface LLMResponse {
  content: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export function messageText(content: LLMMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function flattenText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === 'string' ? part : flattenText((part as any)?.text ?? (part as any)?.content)
      )
      .filter(Boolean)
      .join('\n')
  }
  if (typeof value === 'object') {
    return flattenText((value as any).text ?? (value as any).content)
  }
  return String(value)
}

function hasJsonObject(text: string) {
  return /[{｛]/.test(text)
}

function isValidJsonOutput(text: string): boolean {
  if (!text.trim()) return false
  try {
    parseJsonRobust(text)
    return true
  } catch {
    return false
  }
}

function looksLikeShotList(text: string) {
  return /镜头\s*\d+\s*[：:]/.test(text) && /画面[：:]/.test(text)
}

/** 推理模型常把正文放进 reasoning_content；必须优先用带 JSON 的字段，不能把思考过程当成答案。 */
function pickMessageContent(message: any): string {
  const content = flattenText(message?.content).trim()
  const reasoning = flattenText(
    message?.reasoning_content ?? message?.reasoning ?? message?.reasoningContent
  ).trim()
  if (hasJsonObject(content)) return content
  if (hasJsonObject(reasoning)) return reasoning
  if (looksLikeShotList(reasoning) && !looksLikeShotList(content)) return reasoning
  return content || reasoning
}

function hasImageParts(messages: LLMMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  )
}

function isRetryableNetwork(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /Failed to fetch|NetworkError|ERR_NETWORK|ERR_CONNECTION|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|net::ERR|socket hang up|fetch failed|连不上语言模型/i.test(
    msg
  )
}

function shouldRetryHttp(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

function llmHttpError(status: number, detail: string, baseUrl: string, provider?: string): Error {
  let host = baseUrl
  try { host = new URL(baseUrl).host } catch { /* keep configured URL */ }
  const source = provider === 'vision' ? '비전 모델' : '언어 모델'
  if (status === 401) {
    return new Error(`[${source}] 인증에 실패했어요(401, ${host}). API 키가 유효하거나 만료되지 않았는지, 이 주소에서 발급한 키인지 확인해 주세요.${detail ? `\n${detail}` : ''}`)
  }
  return new Error(`[LLM] ${status} ${detail}`)
}

function friendlyNetworkError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (/连不上语言模型/.test(msg)) return e instanceof Error ? e : new Error(msg)
  return new Error('언어 모델에 연결하지 못했어요. 네트워크와 브라우저 설정을 확인한 뒤 다시 시도해 주세요.')
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('작업을 취소했어요.', 'AbortError')
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('작업을 취소했어요.', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

type LlmHttpResult = {
  ok: boolean
  status: number
  errText: string
  json: () => Promise<any>
}

/** 把图片压成 JPEG data URL，避免多模态请求过大（最多约 1280 边） */
export async function blobToChatImageUrl(
  blob: Blob,
  maxEdge = 1280,
  quality = 0.82
): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('제품 이미지를 압축할 수 없습니다.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', quality)
}

/** LLM 通用调用（OpenAI 兼容 /chat/completions） */
export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  if (getAIMode() === 'mock') {
    return mockLLM(req)
  }

  const { abortableDelay, controlledSignal, isAbortError, llmAbortError, throwIfAborted } =
    await import('./abort')
  const timeoutMs = req.timeoutMs ?? 120_000
  const control = controlledSignal(req.signal, timeoutMs)
  const { baseUrl, apiKey, model: cfgModel } =
    req.provider === 'vision' ? getVisionConfig() : getLlmConfig()
  const model = req.model?.trim() || cfgModel

  if (!baseUrl || !apiKey) {
    throw new Error(translate(req.provider === 'vision' ? 'providerErrors.visionConfig' : 'providerErrors.llmConfig'))
  }

  const withImages = hasImageParts(req.messages)
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? (withImages ? 8192 : 4000)
  }
  if (req.jsonMode) {
    body.response_format = { type: 'json_object' }
  }
  if (req.disableThinking && /volces\.com|doubao/i.test(`${baseUrl} ${model}`)) {
    body.thinking = { type: 'disabled' }
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`

  const postOnce = async (
    payload: Record<string, unknown>,
    signal = control.signal
  ): Promise<LlmHttpResult> => {
    const payloadBody = JSON.stringify(payload)
    const authorization = `Bearer ${apiKey}`
    if (isDesktop() && typeof desktop().llmFetch === 'function') {
      const res = await withAbort(
        desktop().llmFetch({
          url,
          authorization,
          body: payloadBody,
          timeoutMs
        }),
        signal
      )
      return {
        ok: res.ok,
        status: res.status,
        errText: res.ok ? '' : res.text,
        json: async () => JSON.parse(res.text || '{}')
      }
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization
      },
      body: payloadBody,
      signal
    })
    const errText = resp.ok ? '' : await resp.text()
    return { ok: resp.ok, status: resp.status, errText, json: () => resp.json() }
  }

  const post = async (
    payload: Record<string, unknown>,
    signal = control.signal
  ): Promise<LlmHttpResult> => {
    let last: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted(signal)
      try {
        const result = await postOnce(payload, signal)
        if (result.ok || !shouldRetryHttp(result.status) || attempt === 2) return result
        last = new Error(`[LLM] ${result.status} ${result.errText}`)
      } catch (e) {
        last = e
        if (isAbortError(e) || !isRetryableNetwork(e) || attempt === 2) throw e
      }
      await abortableDelay(700 * (attempt + 1), signal)
    }
    throw last instanceof Error ? last : new Error(String(last ?? '언어 모델 요청에 실패했어요.'))
  }

  try {
    let { ok, status, errText, json } = await post(body)
    if (
      !ok &&
      body.response_format &&
      (/response_format|json_object/i.test(errText) ||
        (req.provider === 'vision' && withImages && status === 400))
    ) {
      delete body.response_format
      ;({ ok, status, errText, json } = await post(body))
    }
    if (
      !ok &&
      req.provider === 'vision' &&
      withImages &&
      /Unexpected item type in content|does not support.*image|image.*not supported/i.test(errText)
    ) {
      throw new Error(
        `현재 비전 모델은 이미지 입력을 지원하지 않아요. 설정에서 이미지 입력을 지원하는 모델을 선택해 주세요.`
      )
    }
    if (!ok && body.thinking && /thinking|unknown|unexpected|extra|invalid/i.test(errText)) {
      delete body.thinking
      ;({ ok, status, errText, json } = await post(body))
    }
    if (!ok) throw llmHttpError(status, errText, baseUrl, req.provider)
    let data = await json()
    let content = pickMessageContent(data.choices?.[0]?.message)
    if (!content.trim() && body.response_format) {
      delete body.response_format
      ;({ ok, status, errText, json } = await post(body))
      if (!ok) throw llmHttpError(status, errText, baseUrl, req.provider)
      data = await json()
      content = pickMessageContent(data.choices?.[0]?.message)
    }
    if (req.jsonMode && !isValidJsonOutput(content)) {
      const followControl = controlledSignal(req.signal, Math.min(timeoutMs, 240_000))
      try {
        const follow = {
          ...body,
          temperature: 0,
          max_tokens: Math.min(
            12_000,
            Math.max(Math.ceil((Number(body.max_tokens) || 4000) * 1.5), 6000)
          ),
          messages: [
            ...req.messages,
            ...(content.trim() ? ([{ role: 'assistant', content }] as LLMMessage[]) : []),
            {
              role: 'user',
              content:
                'The previous response contained reasoning without JSON. Return only one JSON object with no explanation or reasoning. Start with { and end with }.'
            }
          ]
        }
        ;({ ok, status, errText, json } = await post(follow, followControl.signal))
        if (ok) {
          data = await json()
          const next = pickMessageContent(data.choices?.[0]?.message)
          if (next.trim()) content = next
        }
      } finally {
        followControl.cleanup()
      }
    }
    return {
      content,
      model: data.model ?? model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          }
        : undefined
    }
  } catch (e) {
    if (control.signal.aborted || isAbortError(e)) {
      throw llmAbortError(e, control.signal, timeoutMs)
    }
    if (isRetryableNetwork(e)) throw friendlyNetworkError(e)
    throw e
  } finally {
    control.cleanup()
  }
}
