import type { OpenAiTtsRequest, OpenAiTtsReply } from '../src/services/ai/openAiTts'
import type { DrawThingsDesktopRequest, DrawThingsReply, DrawThingsProgress } from '../src/services/ai/drawThingsOptions'
import type { LtxDesktopRequest, LtxDesktopReply } from '../src/services/ai/ltxDesktopOptions'
import type { LtxRequest, LtxReply } from '../src/services/ai/ltxOptions'
import { contextBridge, ipcRenderer } from 'electron'

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
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; text: string; dataBase64?: string; contentType?: string }>
  cancelProviderFetch: (requestId: string) => void
  llmFetch: (opts: {
    url: string
    authorization?: string
    body?: string
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; text: string }>
  dashscopeFetch: (opts: {
    url: string
    method?: string
    authorization?: string
    extraHeaders?: Record<string, string>
    body?: string
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; text: string }>
  downloadToTemp: (url: string) => Promise<string>
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

const api: DesktopAPI = {
  isDesktop: true,
  setLocale: (locale) => ipcRenderer.invoke('desktop:setLocale', locale),
  confirmAction: (message, locale) => ipcRenderer.invoke('desktop:confirmAction', message, locale),
  platform: process.platform,
  getRoot: () => ipcRenderer.invoke('desktop:getRoot'),
  setRoot: (root) => ipcRenderer.invoke('desktop:setRoot', root),
  getVersion: () => ipcRenderer.invoke('desktop:getVersion'),
  ensureProjectDir: (name, id) => ipcRenderer.invoke('desktop:ensureProjectDir', name, id),
  listProjectDirs: () => ipcRenderer.invoke('desktop:listProjectDirs'),
  readText: (filePath) => ipcRenderer.invoke('desktop:readText', filePath),
  writeText: (filePath, text, atomic) => ipcRenderer.invoke('desktop:writeText', filePath, text, atomic),
  readBuffer: (filePath) => ipcRenderer.invoke('desktop:readBuffer', filePath),
  writeBuffer: (filePath, data) => ipcRenderer.invoke('desktop:writeBuffer', filePath, data),
  exists: (filePath) => ipcRenderer.invoke('desktop:exists', filePath),
  remove: (filePath) => ipcRenderer.invoke('desktop:remove', filePath),
  join: (...parts) => ipcRenderer.invoke('desktop:join', parts),
  pickFiles: (filters) => ipcRenderer.invoke('desktop:pickFiles', filters),
  importLocalFiles: (opts) => ipcRenderer.invoke('desktop:importLocalFiles', opts),
  requestFileAccess: () => ipcRenderer.invoke('desktop:requestFileAccess'),
  openWindowsSecurity: () => ipcRenderer.invoke('desktop:openWindowsSecurity'),
  saveTextFile: (opts) => ipcRenderer.invoke('desktop:saveTextFile', opts),
  pickDirectory: () => ipcRenderer.invoke('desktop:pickDirectory'),
  openPath: (filePath) => ipcRenderer.invoke('desktop:openPath', filePath),
  openAiTts: (request) => ipcRenderer.invoke('desktop:openAiTts', request),
  ltxDesktopRequest: (request) => ipcRenderer.invoke('desktop:ltxDesktopRequest', request),
  drawThingsRequest: (request) => ipcRenderer.invoke('desktop:drawThingsRequest', request),
  protectDrawThingsSecret: (secret) => ipcRenderer.invoke('desktop:protectDrawThingsSecret', secret),
  cancelDrawThings: (id) => ipcRenderer.send('desktop:cancelDrawThings', id),
  onDrawThingsProgress: (id, callback) => {
    const channel = 'desktop:drawThingsProgress'
    const listener = (_event: Electron.IpcRendererEvent, activeId: string, progress: DrawThingsProgress) => {
      if (id === activeId) callback(progress)
    }
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },
  ltxRequest: (request) => ipcRenderer.invoke('desktop:ltxRequest', request),
  autodlFetch: (opts) => ipcRenderer.invoke('desktop:autodlFetch', opts),
  cancelProviderFetch: (requestId) => ipcRenderer.send('desktop:cancelProviderFetch', requestId),
  llmFetch: (opts) => ipcRenderer.invoke('desktop:llmFetch', opts),
  dashscopeFetch: (opts) => ipcRenderer.invoke('desktop:dashscopeFetch', opts),
  downloadToTemp: (url) => ipcRenderer.invoke('desktop:downloadToTemp', url),
  dbPath: () => ipcRenderer.invoke('desktop:dbPath'),
  backupSettings: (raw) => ipcRenderer.invoke('desktop:backupSettings', raw),
  kvGet: (key) => ipcRenderer.invoke('desktop:kvGet', key),
  kvSet: (key, value) => ipcRenderer.invoke('desktop:kvSet', key, value),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximized: (cb) => {
    const handler = (_e: unknown, v: boolean) => cb(v)
    ipcRenderer.on('window:maximized', handler)
    return () => ipcRenderer.removeListener('window:maximized', handler)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
