import type { OpenAiTtsRequest, OpenAiTtsReply } from './ai/openAiTts'
import type { DrawThingsDesktopRequest, DrawThingsReply, DrawThingsProgress } from './ai/drawThingsOptions'
import type { LtxDesktopRequest, LtxDesktopReply } from './ai/ltxDesktopOptions'
import type { LtxRequest, LtxReply } from './ai/ltxOptions'
import { t } from '@/i18n'
export type DesktopAPI = {
  isDesktop: true
  setLocale: (locale: 'ko' | 'zh') => Promise<void>
  confirmAction: (message: string, locale: 'ko' | 'zh') => Promise<boolean>
  platform: string
  getRoot: () => Promise<string>
  setRoot: (root: string) => Promise<string>
  getVersion: () => Promise<string>
  ensureProjectDir: (name: string, id: string) => Promise<string>
  listProjectDirs: () => Promise<string[]>
  readText: (filePath: string) => Promise<string>
  writeText: (filePath: string, text: string, atomic?: boolean) => Promise<void>
  readBuffer: (filePath: string) => Promise<ArrayBuffer>
  writeBuffer: (filePath: string, data: ArrayBuffer) => Promise<void>
  exists: (filePath: string) => Promise<boolean>
  remove: (filePath: string) => Promise<void>
  join: (...parts: string[]) => Promise<string>
  pickFiles: (filters?: { name: string; extensions: string[] }[]) => Promise<string[]>
  importLocalFiles: (opts?: {
    kind?: 'image' | 'audio' | 'video' | 'media'
    multiple?: boolean
  }) => Promise<Array<{ name: string; mime: string; data: ArrayBuffer }>>
  requestFileAccess: () => Promise<boolean>
  openWindowsSecurity: () => Promise<void>
  saveTextFile: (opts: {
    defaultName: string
    text: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  pickDirectory: () => Promise<string | null>
  openPath: (filePath: string) => Promise<string>
  openAiTts: (request: OpenAiTtsRequest) => Promise<OpenAiTtsReply>
  ltxDesktopRequest: (request: LtxDesktopRequest) => Promise<LtxDesktopReply>
  drawThingsRequest: (request: DrawThingsDesktopRequest) => Promise<DrawThingsReply>
  protectDrawThingsSecret: (secret: string) => Promise<string | null>
  cancelDrawThings: (id: string) => void
  onDrawThingsProgress: (id: string, callback: (progress: DrawThingsProgress) => void) => () => void
  ltxRequest: (request: LtxRequest) => Promise<LtxReply>
  autodlFetch: (opts: {
    url: string
    method?: string
    authorization?: string
    extraHeaders?: Record<string, string>
    body?: string
    bodyBase64?: string
    bodyBytes?: ArrayBuffer
    requestId?: string
    contentType?: string
    binary?: boolean
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; text: string; filePath?: string; contentType?: string }>
  cancelProviderFetch: (requestId: string) => void
  llmFetch: (opts: {
    url: string
    authorization?: string
    body?: string
    requestId?: string
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; text: string }>
  dashscopeFetch: (opts: {
    url: string
    method?: string
    authorization?: string
    extraHeaders?: Record<string, string>
    body?: string
    requestId?: string
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; text: string }>
  downloadToTemp: (url: string, requestId?: string) => Promise<string>
  dbPath: () => Promise<string>
  backupSettings: (raw: string) => Promise<string>
  kvGet: (key: string) => Promise<string | null>
  kvSet: (key: string, value: string) => Promise<void>
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  closeWindow: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximized: (cb: (v: boolean) => void) => () => void
}

declare global {
  interface Window {
    desktop?: DesktopAPI
  }
}

export function isDesktop(): boolean {
  return Boolean(window.desktop?.isDesktop)
}

export function desktop(): DesktopAPI {
  if (!window.desktop) throw new Error(t('desktop.required'))
  return window.desktop
}

export async function providerRequest<T>(
  signal: AbortSignal | undefined,
  request: (requestId?: string) => Promise<T>,
  discard?: (value: T) => Promise<void>
): Promise<T> {
  signal?.throwIfAborted()
  const requestId = signal ? crypto.randomUUID() : undefined
  const cancel = () => { if (requestId) desktop().cancelProviderFetch?.(requestId) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await request(requestId)
    if (signal?.aborted) {
      await discard?.(result)
      signal.throwIfAborted()
    }
    return result
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export async function consumeProviderFile(path: string, signal?: AbortSignal): Promise<Blob> {
  try {
    const response = await fetch(assetFileUrl(path), { signal })
    if (!response.ok) throw new Error(t('aiError.generationFailed'))
    return await response.blob()
  } finally {
    await desktop().remove(path).catch(() => {})
  }
}

export function assetFileUrl(absPath: string): string {
  return `aicuts://local/?path=${encodeURIComponent(absPath)}`
}

export async function blobFromPath(absPath: string): Promise<Blob> {
  if (isDesktop()) {
    const buf = await desktop().readBuffer(absPath)
    const ext = absPath.split('.').pop()?.toLowerCase()
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'mp4'
              ? 'video/mp4'
              : ext === 'webm'
                ? 'video/webm'
                : ext === 'mp3'
                  ? 'audio/mpeg'
                  : ext === 'wav'
                    ? 'audio/wav'
                    : 'application/octet-stream'
    return new Blob([buf], { type: mime })
  }
  const res = await fetch(assetFileUrl(absPath))
  return res.blob()
}

export async function bufferFromBlob(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer()
}
