import { t } from '@/i18n'
import zh from '@/locales/zh'

/** 완성 대본과 노드 추출의 긴 JSON 응답에는 2분 이상 걸릴 수 있다. */
export const PLAY_LLM_TIMEOUT_MS = 480_000

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('작업을 취소했어요.', 'AbortError')
}

function errName(e: unknown) {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name?: string }).name || '') : ''
}

function errMessage(e: unknown) {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e ?? '')
}

/** Chrome의 fetch 취소 오류는 signal.reason으로 취소와 시간 초과를 구분한다. */
export function isAbortError(e: unknown): boolean {
  const name = errName(e)
  if (name === 'AbortError' || name === 'TimeoutError') return true
  return /aborted a request|operation was aborted|任务已取消|작업을 취소했어요|The user aborted/i.test(errMessage(e))
}

export function isTimeoutAbort(e: unknown, signal?: AbortSignal): boolean {
  const reason = signal?.reason
  if (errName(reason) === 'TimeoutError' || /请求超过/.test(errMessage(reason))) return true
  if (errName(e) === 'TimeoutError') return true
  return /请求超过|模型超过 \d+ 秒/.test(errMessage(e))
}

export function llmAbortError(e: unknown, signal?: AbortSignal, timeoutMs = 120_000): Error {
  if (isTimeoutAbort(e, signal)) {
    const sec = Math.max(1, Math.round(timeoutMs / 1000))
    return new DOMException(t('aiError.timeout', { seconds: sec }), 'TimeoutError')
  }
  if (signal?.aborted || isAbortError(e)) {
    return new DOMException('작업을 취소했어요.', 'AbortError')
  }
  return e instanceof Error ? e : new Error(errMessage(e))
}

export function friendlyAiError(e: unknown): string {
  if (isAbortError(e) && !isTimeoutAbort(e)) return t('common.cancelled')
  const message = errMessage(e)
  if (message === zh.common.reviewScript) return t('common.reviewScript')
  const timeout = /^模型超过 (\d+) 秒还没写完。/.exec(message)
  if (timeout) return t('aiError.timeout', { seconds: Number(timeout[1]) })
  return message || t('common.generateFailed')
}

export function shouldToastAiError(e: unknown): boolean {
  return !(isAbortError(e) && !isTimeoutAbort(e))
}

export function controlledSignal(parent?: AbortSignal, timeoutMs = 120_000) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? new DOMException('작업을 취소했어요.', 'AbortError'))
  parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException(`요청 시간이 ${Math.round(timeoutMs / 1000)}초를 초과했어요.`, 'TimeoutError')),
    timeoutMs
  )
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    }
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  let abortHandler: (() => void) | undefined
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    abortHandler = () => {
      clearTimeout(timer)
      reject(new DOMException('작업을 취소했어요.', 'AbortError'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
  }).finally(() => {
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
  })
}
