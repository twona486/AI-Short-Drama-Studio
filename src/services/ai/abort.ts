import { t } from '@/i18n'

/** 완성 대본과 노드 추출의 긴 JSON 응답에는 2분 이상 걸릴 수 있다. */
export const PLAY_LLM_TIMEOUT_MS = 480_000

export function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted()
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
  return name === 'AbortError' || name === 'TimeoutError'
}

export function isTimeoutAbort(e: unknown, signal?: AbortSignal): boolean {
  return errName(signal?.reason) === 'TimeoutError' || errName(e) === 'TimeoutError'
}

export function llmAbortError(e: unknown, signal?: AbortSignal, timeoutMs = 120_000): Error {
  if (isTimeoutAbort(e, signal)) {
    const sec = Math.max(1, Math.round(timeoutMs / 1000))
    return new DOMException(t('aiError.requestTimeout', { seconds: sec }), 'TimeoutError')
  }
  if (signal?.aborted || isAbortError(e)) {
    return new DOMException(t('providerRequestErrors.aborted'), 'AbortError')
  }
  return e instanceof Error ? e : new Error(errMessage(e))
}

export function friendlyAiError(e: unknown): string {
  if (isAbortError(e) && !isTimeoutAbort(e)) return t('providerRequestErrors.aborted')
  return errMessage(e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim() || t('aiError.generationFailed')
}

export function shouldToastAiError(e: unknown): boolean {
  return !(isAbortError(e) && !isTimeoutAbort(e))
}

export function controlledSignal(parent?: AbortSignal, timeoutMs = 120_000) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? new DOMException(t('providerRequestErrors.aborted'), 'AbortError'))
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException(t('aiError.requestTimeout', { seconds: Math.round(timeoutMs / 1000) }), 'TimeoutError')),
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
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
  }).finally(() => {
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
  })
}
