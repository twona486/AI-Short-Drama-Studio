import { requestOpenAiTts } from './openai-tts'
import type { OpenAiTtsRequest } from '../src/services/ai/openAiTts'
import { requestLtxDesktop } from './ltx-desktop'
import type { LtxDesktopRequest } from '../src/services/ai/ltxDesktopOptions'
/// <reference types="vite-plugin-electron/electron-env" />
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  Menu,
  net,
  session
} from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { requestLtx } from './ltx'
import type { LtxRequest } from '../src/services/ai/ltxOptions'
import ko from '../src/locales/ko'
import zh from '../src/locales/zh'
import { migrateUserData, ROOT_PREF_FILE, USER_DATA_NAME, readStorageRootPreference } from './user-data'
import { closeAppDb, getDbPath, kvGet, kvSet, openAppDb } from './sqlite'

let nativeLocale: 'ko' | 'zh' = 'ko'

function nativeText(key: keyof typeof ko.electron, fields: Record<string, string | number> = {}) {
  const messages = nativeLocale === 'zh' ? zh.electron : ko.electron
  return messages[key].replace(/\{(\w+)\}/g, (placeholder, field: string) =>
    Object.hasOwn(fields, field) ? String(fields[field]) : placeholder
  )
}

function installApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const item = (role: Electron.MenuItemConstructorOptions['role'], label: keyof typeof ko.electron) => ({
    role,
    label: nativeText(label, { app: USER_DATA_NAME })
  })
  const separator = { type: 'separator' as const }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: USER_DATA_NAME,
      submenu: [
        item('about', 'menuAbout'), separator,
        item('hide', 'menuHide'), item('hideOthers', 'menuHideOthers'), item('unhide', 'menuShowAll'), separator,
        item('quit', 'menuQuit')
      ]
    },
    { label: nativeText('menuFile'), submenu: [item('close', 'menuClose')] },
    {
      label: nativeText('menuEdit'),
      submenu: [
        item('undo', 'menuUndo'), item('redo', 'menuRedo'), separator,
        item('cut', 'menuCut'), item('copy', 'menuCopy'), item('paste', 'menuPaste'),
        item('pasteAndMatchStyle', 'menuPastePlain'), item('selectAll', 'menuSelectAll')
      ]
    },
    {
      label: nativeText('menuView'),
      submenu: [
        item('resetZoom', 'menuActualSize'), item('zoomIn', 'menuZoomIn'), item('zoomOut', 'menuZoomOut'), separator,
        item('togglefullscreen', 'menuFullScreen')
      ]
    },
    {
      label: nativeText('menuWindow'),
      role: 'window',
      submenu: [item('minimize', 'menuMinimize'), item('zoom', 'menuZoomWindow')]
    }
  ]))
}

const mainDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * 사용자 지정 영상 워크플로는 여러 제공업체의 임시 CDN에서 결과를 가져온다.
 * 고정 도메인 목록 대신 로컬 및 사설망 주소를 차단해 다운로드 IPC의 SSRF를 막는다.
 * 공용 HTTPS 영상 주소는 허용한다.
 */
function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')) {
    return true
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  // IPv4 매핑 IPv6의 예는 ::ffff:127.0.0.1이다.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  const ipv4 = mapped?.[1] ?? (isIP(normalized) === 4 ? normalized : '')
  if (!ipv4) return false
  const octets = ipv4.split('.').map(Number)
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}

async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(nativeText('invalidVideoUrl'))
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(nativeText('requirePublicHttps'))
  }
  const host = parsed.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(nativeText('rejectPrivateHost'))
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(nativeText('rejectPrivateHost'))
    return parsed
  }
  let addresses: Awaited<ReturnType<typeof lookup>>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error(nativeText('lookupFailed', { host }))
  }
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
    throw new Error(nativeText('rejectPrivateResolution'))
  }
  return parsed
}

/**
 * Electron net.fetch는 응답 헤더를 Web Headers로 변환한다.
 * 일부 CDN이 Content-Disposition에 비 ASCII 파일명을 직접 넣으면
 * undici의 ByteString TypeError가 발생해 메인 프로세스에서 처리되지 않을 수 있다.
 * Node HTTPS 스트림으로 이 변환을 피하고 리디렉션마다 공용 주소를 확인한다.
 */
async function downloadPublicVideo(
  rawUrl: string,
  dest: string,
  redirectsLeft = 5
): Promise<void> {
  const parsed = await assertPublicHttpsUrl(rawUrl)
  await new Promise<void>((resolve, reject) => {
    const req = https.get(
      parsed,
      {
        headers: {
          Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1',
          'User-Agent': 'AI-Cut-Desktop/1.0'
        },
        timeout: 180_000
      },
      (res) => {
        const status = res.statusCode || 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(nativeText('redirectLimit')))
            return
          }
          const next = new URL(location, parsed).toString()
          downloadPublicVideo(next, dest, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(nativeText('downloadFailed', { status })))
          return
        }

        const contentType = String(res.headers['content-type'] || '').toLowerCase()
        if (
          contentType &&
          !contentType.startsWith('video/') &&
          !contentType.includes('application/octet-stream') &&
          !contentType.includes('binary/octet-stream')
        ) {
          res.resume()
          reject(new Error(nativeText('unexpectedContent', { type: contentType })))
          return
        }

        pipeline(res, createWriteStream(dest)).then(resolve, reject)
      }
    )
    req.once('timeout', () => req.destroy(new Error(nativeText('downloadTimeout'))))
    req.once('error', reject)
  })
}

function resolvePreload() {
  for (const name of ['preload.cjs', 'preload.js', 'preload.mjs']) {
    const p = path.join(mainDir, name)
    if (existsSync(p)) return p
  }
  return path.join(mainDir, 'preload.js')
}

function mimeOf(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.svg':
      return 'image/svg+xml'
    case '.ico':
      return 'image/x-icon'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    default:
      return 'application/octet-stream'
  }
}

/** 영상의 전 구간을 재생할 수 있도록 Range 요청에 206으로 응답한다. */
function fileRangeResponse(filePath: string, request: Request) {
  if (!existsSync(filePath)) return new Response('not found', { status: 404 })
  const size = statSync(filePath).size
  const mime = mimeOf(filePath)
  const range = request.headers.get('range')
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!m) return new Response('invalid range', { status: 416 })
    const start = m[1] ? Number(m[1]) : 0
    const end = m[2] ? Number(m[2]) : size - 1
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start >= size ||
      start > end
    ) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }
    const clampedEnd = Math.min(end, size - 1)
    const stream = createReadStream(filePath, { start, end: clampedEnd })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${clampedEnd}/${size}`,
        'Content-Length': String(clampedEnd - start + 1)
      }
    })
  }
  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size)
    }
  })
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aicut-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  },
  {
    scheme: 'aicuts',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
}

function appAssetResponse(request: Request) {
  const distRoot = path.resolve(mainDir, '../dist')
  let pathname = '/index.html'
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname || '/index.html')
  } catch {
    return new Response('bad request', { status: 400 })
  }
  if (pathname === '/') pathname = '/index.html'

  const filePath = path.resolve(distRoot, `.${pathname}`)
  if (!isSameOrNested(distRoot, filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response('not found', { status: 404, headers: ISOLATION_HEADERS })
  }

  const headers = {
    ...ISOLATION_HEADERS,
    'Content-Type': mimeOf(filePath),
    'Content-Length': String(statSync(filePath).size)
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers
  })
}

const ROOT_NAME = 'AI-Cut'
let activeRoot = ''

function defaultRoot() {
  return path.join(app.getPath('documents'), ROOT_NAME)
}

function rootPreferencePath() {
  return path.join(app.getPath('userData'), ROOT_PREF_FILE)
}

async function saveStorageRoot(root: string) {
  await ensureDir(path.dirname(rootPreferencePath()))
  await fs.writeFile(
    rootPreferencePath(),
    JSON.stringify({ root: path.normalize(root) }, null, 2),
    'utf8'
  )
}

function currentRoot() {
  return activeRoot || defaultRoot()
}

function isSameOrNested(parent: string, child: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function copyMissingRootContents(source: string, target: string) {
  if (!existsSync(source)) return
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(source, entry.name)
    const dest = path.join(target, entry.name)
    if (existsSync(dest)) continue
    await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: false })
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

function isLockError(err: unknown) {
  const code = (err as { code?: string } | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EAGAIN'
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function copyWithRetry(src: string, dest: string) {
  let last: unknown
  for (let i = 0; i < 5; i++) {
    try {
      await fs.copyFile(src, dest)
      return
    } catch (err) {
      last = err
      if (!isLockError(err)) throw err
      await sleep(180 * (i + 1))
    }
  }
  throw last
}

async function readWithRetry(filePath: string) {
  let last: unknown
  for (let i = 0; i < 5; i++) {
    try {
      return await fs.readFile(filePath)
    } catch (err) {
      last = err
      if (!isLockError(err)) throw err
      await sleep(180 * (i + 1))
    }
  }
  throw last
}

function slugName(name: string, id: string) {
  const s = (name || 'project')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48)
  return `${s}_${id}`
}

function resolveAppIcon() {
  const names =
    process.platform === 'win32' ? ['logo.ico', 'logo.png'] : ['logo.png', 'icon.png']
  const dirs = [
    process.resourcesPath,
    path.join(mainDir, '..'),
    path.join(mainDir, '../..'),
    process.cwd()
  ]
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const p = path.join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: ko.common.appName,
    icon: resolveAppIcon(),
    backgroundColor: '#101012',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://www.bilibili.com/video/BV1o6n66fE5p/') {
      void shell.openExternal(url).catch(() => undefined)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  const sendMax = () => {
    win.webContents.send('window:maximized', win.isMaximized())
  }
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadURL('aicut-app://app/index.html')
  }
  win.webContents.on('did-finish-load', () => {
    console.log('[electron] preload', resolvePreload(), 'desktop api via preload.cjs')
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.on('close', () => {
    try {
      session.defaultSession.flushStorageData()
    } catch {
      /* ignore */
    }
  })
}

if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  const appData = app.getPath('appData')
  // electron-builder는 패키지에서 build.productName을 제거하므로 프로필 경로를 지정한다.
  const userData = path.join(appData, USER_DATA_NAME)
  try {
    migrateUserData(appData, userData)
  } catch (error) {
    console.error('[userData] 이전 버전의 설정을 복사하지 못했습니다.', error)
  }
  try {
    mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
  } catch (error) {
    console.error('[userData] 새 프로필 경로를 설정하지 못했습니다.', error)
  }
}

app.whenReady().then(async () => {
  installApplicationMenu()
  const root = readStorageRootPreference(rootPreferencePath()) ?? defaultRoot()
  activeRoot = root
  await ensureDir(root)
  await openAppDb(root)

  protocol.handle('aicut-app', appAssetResponse)

  protocol.handle('aicuts', (request) => {
    try {
      const u = new URL(request.url)
      const filePath = u.searchParams.get('path')
      if (!filePath) return new Response('missing path', { status: 400 })
      return fileRangeResponse(filePath, request)
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })

  ipcMain.handle('desktop:setLocale', (event, locale: unknown) => {
    const next = locale === 'zh' ? 'zh' : 'ko'
    if (nativeLocale !== next) {
      nativeLocale = next
      installApplicationMenu()
    }
    BrowserWindow.fromWebContents(event.sender)?.setTitle(USER_DATA_NAME)
  })

  const confirming = new Set<number>()
  ipcMain.handle('desktop:confirmAction', async (event, message: unknown, locale: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || typeof message !== 'string' || confirming.has(win.id)) return false
    const windowId = win.id
    const { common } = locale === 'zh' ? zh : ko
    confirming.add(windowId)
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'question',
        message,
        buttons: [common.cancel, common.ok],
        cancelId: 0,
        defaultId: 0,
        noLink: true
      })
      return result.response === 1
    } finally {
      confirming.delete(windowId)
    }
  })

  ipcMain.handle('desktop:getRoot', async () => {
    const root = currentRoot()
    await ensureDir(root)
    return root
  })

  ipcMain.handle('desktop:setRoot', async (_e, requestedRoot: string) => {
    const nextRoot = path.resolve(String(requestedRoot || '').trim())
    const previousRoot = currentRoot()
    if (!requestedRoot || !path.isAbsolute(nextRoot)) {
      throw new Error(nativeText('absolutePathRequired'))
    }
    if (nextRoot === path.parse(nextRoot).root) {
      throw new Error(nativeText('rejectDiskRoot'))
    }
    if (
      path.resolve(previousRoot) !== nextRoot &&
      (isSameOrNested(previousRoot, nextRoot) || isSameOrNested(nextRoot, previousRoot))
    ) {
      throw new Error(nativeText('rejectNestedRoot'))
    }
    if (path.resolve(previousRoot) === nextRoot) return nextRoot

    await ensureDir(nextRoot)
    closeAppDb()
    try {
      // 대상에 기존 데이터가 있으면 덮어쓰지 않는다. 비어 있으면 현재 데이터베이스, 프로젝트, 에셋을 옮긴다.
      await copyMissingRootContents(previousRoot, nextRoot)
      await openAppDb(nextRoot)
      activeRoot = nextRoot
      await saveStorageRoot(nextRoot)
      return nextRoot
    } catch (error) {
      activeRoot = previousRoot
      await openAppDb(previousRoot)
      throw error
    }
  })

  ipcMain.handle('desktop:dbPath', () => getDbPath() || path.join(currentRoot(), 'app.db'))
  ipcMain.handle('desktop:getVersion', () => app.getVersion())
  ipcMain.handle('desktop:kvGet', (_e, key: string) => kvGet(String(key || '')))
  ipcMain.handle('desktop:kvSet', (_e, key: string, value: string) => {
    kvSet(String(key || ''), String(value ?? ''))
  })

  ipcMain.handle('desktop:ensureProjectDir', async (_e, name: string, id: string) => {
    const dir = path.join(currentRoot(), slugName(name, id))
    await ensureDir(path.join(dir, 'assets', 'images'))
    await ensureDir(path.join(dir, 'assets', 'videos'))
    await ensureDir(path.join(dir, 'assets', 'audio'))
    await ensureDir(path.join(dir, 'thumbs'))
    return dir
  })

  ipcMain.handle('desktop:listProjectDirs', async () => {
    const root = currentRoot()
    await ensureDir(root)
    const names = await fs.readdir(root, { withFileTypes: true })
    const out: string[] = []
    for (const d of names) {
      if (!d.isDirectory()) continue
      const jsonPath = path.join(root, d.name, 'project.json')
      if (existsSync(jsonPath)) out.push(path.join(root, d.name))
    }
    return out
  })

  ipcMain.handle('desktop:readText', async (_e, filePath: string) => {
    return fs.readFile(filePath, 'utf8')
  })

  ipcMain.handle('desktop:writeText', async (_e, filePath: string, text: string, atomic?: boolean) => {
    await ensureDir(path.dirname(filePath))
    if (!atomic) return fs.writeFile(filePath, text, 'utf8')
    const stat = await fs.lstat(filePath).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    const target = stat?.isSymbolicLink() ? await fs.realpath(filePath) : filePath
    const mode = stat?.isSymbolicLink() ? (await fs.stat(target)).mode : stat?.mode
    const temp = path.join(path.dirname(target), `.write-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode })
      if (mode !== undefined) await fs.chmod(temp, mode)
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true })
    }
  })

  ipcMain.handle('desktop:readBuffer', async (_e, filePath: string) => {
    const buf = await fs.readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('desktop:writeBuffer', async (_e, filePath: string, data: ArrayBuffer) => {
    await ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, Buffer.from(data))
  })

  ipcMain.handle('desktop:exists', async (_e, filePath: string) => existsSync(filePath))

  ipcMain.handle('desktop:remove', async (_e, filePath: string) => {
    await fs.rm(filePath, { recursive: true, force: true })
  })

  ipcMain.handle('desktop:join', (_e, parts: string[]) => path.join(...parts))

  ipcMain.handle('desktop:pickFiles', async (_e, filters?: Electron.FileFilter[]) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined, {
      title: nativeText('pickFilesTitle'),
      buttonLabel: nativeText('dialogOpen'),
      properties: ['openFile', 'multiSelections'],
      filters: filters ?? [{ name: nativeText('media'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mp3', 'wav'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(
    'desktop:importLocalFiles',
    async (
      _e,
      opts?: { kind?: 'image' | 'audio' | 'video' | 'media'; multiple?: boolean }
    ) => {
      const kind = opts?.kind || 'image'
      const filters =
        kind === 'image'
          ? [{ name: nativeText('image'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
          : kind === 'audio'
            ? [{ name: nativeText('audio'), extensions: ['mp3', 'wav', 'm4a', 'aac'] }]
            : kind === 'video'
              ? [{ name: nativeText('video'), extensions: ['mp4', 'mov', 'webm', 'mkv'] }]
              : [
                  {
                    name: nativeText('media'),
                    extensions: [
                      'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
                      'mp4', 'mov', 'webm', 'mkv',
                      'mp3', 'wav', 'm4a', 'aac'
                    ]
                  }
                ]
      const win = BrowserWindow.getFocusedWindow()
      const res = await dialog.showOpenDialog(win ?? undefined, {
        title: nativeText('importFilesTitle'),
        buttonLabel: nativeText('dialogImport'),
        properties: opts?.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
        filters
      })
      if (res.canceled || !res.filePaths.length) return []

      const inbox = path.join(currentRoot(), 'inbox')
      await ensureDir(inbox)
      const out: Array<{ name: string; mime: string; data: ArrayBuffer }> = []
      for (const src of res.filePaths) {
        const safe = path.basename(src).replace(/[<>:"/\\|?*]/g, '_')
        const dest = path.join(inbox, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safe}`)
        try {
          await copyWithRetry(src, dest)
          const buf = await readWithRetry(dest)
          out.push({
            name: path.basename(src),
            mime: mimeOf(src),
            data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          })
        } catch {
          throw new Error(
            nativeText('fileReadBlocked', { file: path.basename(src) })
          )
        } finally {
          await fs.unlink(dest).catch(() => {})
        }
      }
      return out
    }
  )

  ipcMain.handle('desktop:openWindowsSecurity', async () => {
    try {
      await shell.openExternal('ms-settings:windowsdefender')
    } catch {
      await shell.openExternal('windowsdefender:')
    }
  })

  ipcMain.handle('desktop:requestFileAccess', async () => {
    if (process.platform !== 'win32') {
      throw new Error(nativeText('windowsOnly'))
    }
    const root = currentRoot()
    const exe = process.execPath
    const exeDir = path.dirname(exe)
    const exeName = path.basename(exe)
    const scriptPath = path.join(os.tmpdir(), `aicuts-allow-${Date.now()}.ps1`)
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    await fs.writeFile(
      scriptPath,
      [
        `Add-MpPreference -ExclusionPath ${q(root)}`,
        `Add-MpPreference -ExclusionPath ${q(exeDir)}`,
        `Add-MpPreference -ExclusionProcess ${q(exeName)}`
      ].join('\r\n'),
      'utf8'
    )
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-WindowStyle',
            'Hidden',
            '-Command',
            `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${q(scriptPath)}`
          ],
          { windowsHide: true }
        )
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(nativeText('fileAccessCancelled')))
        })
      })
    } finally {
      await fs.unlink(scriptPath).catch(() => {})
    }
    return true
  })

  ipcMain.handle('desktop:saveTextFile', async (_e, opts?: {
    defaultName?: string
    text?: string
    filters?: Electron.FileFilter[]
  }) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showSaveDialog(win ?? undefined, {
      title: nativeText('saveFileTitle'),
      buttonLabel: nativeText('dialogSave'),
      defaultPath: String(opts?.defaultName || 'script.md'),
      filters: opts?.filters ?? [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, String(opts?.text || ''), 'utf8')
    return res.filePath
  })

  ipcMain.handle('desktop:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined, {
      title: nativeText('pickDirectoryTitle'),
      buttonLabel: nativeText('dialogChoose'),
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('desktop:openPath', async (_e, filePath: string) => {
    return shell.openPath(filePath)
  })

  function isAllowedProviderFetch(parsed: URL) {
    // 사용자가 저장한 모델 주소에 CORS 제한 없이 접근할 수 있도록 메인 프로세스에서 요청한다.
    // 사용자가 운영하는 클라우드 ComfyUI도 연결할 수 있도록 공급업체나 localhost로 제한하지 않는다.
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    )
  }

  const providerRequests = new Map<string, AbortController>()
  ipcMain.on('desktop:cancelProviderFetch', (event, requestId: string) => {
    providerRequests.get(`${event.sender.id}:${requestId}`)?.abort()
  })
  ipcMain.handle('desktop:openAiTts', async (event, request: OpenAiTtsRequest) => {
    const id = `${event.sender.id}:${request?.requestId}`
    const controller = new AbortController()
    const abort = () => controller.abort()
    providerRequests.set(id, controller)
    event.sender.once('destroyed', abort)
    try {
      return await requestOpenAiTts(request, controller.signal)
    } finally {
      event.sender.removeListener('destroyed', abort)
      providerRequests.delete(id)
    }
  })
  ipcMain.handle('desktop:autodlFetch', async (event, opts?: {
    url?: string
    method?: string
    authorization?: string
    extraHeaders?: Record<string, string>
    body?: string
    bodyBase64?: string
    bodyBytes?: ArrayBuffer
    requestId?: string
    contentType?: string
    timeoutMs?: number
  }) => {
    const url = String(opts?.url || '')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('invalid url')
    }
    if (!isAllowedProviderFetch(parsed)) throw new Error(nativeText('comfyProtocol'))
    const method = String(opts?.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') throw new Error(nativeText('comfyMethod'))
    const timeoutMs = Math.min(600000, Math.max(5000, Number(opts?.timeoutMs) || 120000))
    const controller = new AbortController()
    const requestKey = opts?.requestId ? `${event.sender.id}:${opts.requestId}` : undefined
    if (requestKey) providerRequests.set(requestKey, controller)
    const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      for (const [name, value] of Object.entries(opts?.extraHeaders || {})) {
        if (!/^[a-z0-9-]+$/i.test(name) || /^(host|content-length|connection|cookie|origin|referer)$/i.test(name)) continue
        headers[name] = String(value)
      }
      const token = String(opts?.authorization || '').trim()
      if (token) headers.Authorization = token
      const requestType = String(opts?.contentType || '').trim()
      if (method === 'POST') headers['Content-Type'] = requestType || 'application/json'
      let rawBody: string | Buffer | undefined
      if (method === 'POST') {
        if (opts?.bodyBytes) rawBody = Buffer.from(opts.bodyBytes)
        else if (opts?.bodyBase64) rawBody = Buffer.from(opts.bodyBase64, 'base64')
        else rawBody = String(opts?.body || '')
      }
      const res = await net.fetch(url, {
        method,
        headers,
        body: rawBody,
        signal: controller.signal
      })
      const contentType = res.headers.get('content-type') || ''
      const bytes = Buffer.from(await res.arrayBuffer())
      const textual = /json|text|xml|javascript|x-www-form-urlencoded/i.test(contentType)
      return {
        status: res.status,
        ok: res.ok,
        text: textual ? bytes.toString('utf8') : '',
        dataBase64: textual ? undefined : bytes.toString('base64'),
        contentType
      }
    } catch (err: any) {
      if (controller.signal.reason?.name === 'TimeoutError') {
        throw new Error(nativeText('autoDlTimeout', { seconds: Math.round(timeoutMs / 1000) }))
      }
      throw err
    } finally {
      if (requestKey) providerRequests.delete(requestKey)
      clearTimeout(timer)
    }
  })

  // 긴 LLM 응답에서 Chromium의 HTTP/2 연결이 일찍 끊길 수 있어 Node의 HTTP/1.1을 사용한다.
  const readLlmText = (
    target: URL,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
    signal: AbortSignal
  ) => new Promise<{ status: number; ok: boolean; text: string }>((resolve, reject) => {
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      run()
    }
    if (signal.aborted) {
      finish(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      return
    }
    const secure = target.protocol === 'https:'
    const lib = (secure ? https : http) as typeof https
    const agent = new lib.Agent({ keepAlive: false })
    const reqHeaders = { ...headers }
    if (method === 'POST') reqHeaders['Content-Length'] = String(Buffer.byteLength(body || ''))
    let broken = false
    const fail = (err: unknown) => {
      broken = true
      agent.destroy()
      finish(() => reject(err))
    }
    const req = lib.request(target, { method, headers: reqHeaders, agent, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer | string) => {
        if (broken) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buf.length
        if (size > 32 * 1024 * 1024) {
          fail(new Error(nativeText('llmResponseTooLarge')))
          req.destroy()
          return
        }
        chunks.push(buf)
      })
      res.on('end', () => {
        if (broken) return
        agent.destroy()
        const status = res.statusCode || 0
        finish(() => resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') }))
      })
      res.on('error', (err) => fail(err))
    })
    const onAbort = () => {
      req.destroy()
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('timeout', () => {
      const err = new Error('timeout') as NodeJS.ErrnoException
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      fail(err)
    })
    if (method === 'POST') req.write(body || '')
    req.end()
  })

  ipcMain.handle('desktop:llmFetch', async (_e, opts?: {
    url?: string
    authorization?: string
    body?: string
    timeoutMs?: number
  }) => {
    const url = String(opts?.url || '')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('invalid url')
    }
    if (parsed.protocol !== 'https:') {
      const host = parsed.hostname.toLowerCase()
      const localHttp =
        parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')
      if (!localHttp) throw new Error(nativeText('llmProtocol'))
    }
    const isModels = /\/models\/?$/i.test(parsed.pathname)
    const isChat = parsed.pathname.includes('/chat/completions')
    if (!isModels && !isChat) {
      throw new Error(nativeText('llmEndpoint'))
    }
    const method = isModels ? 'GET' : 'POST'
    const body = String(opts?.body || '')
    if (method === 'POST' && body.length > 32 * 1024 * 1024) {
      throw new Error(nativeText('llmRequestTooLarge'))
    }
    const timeoutMs = Math.min(900000, Math.max(5000, Number(opts?.timeoutMs) || 120000))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json'
      }
      if (method === 'POST') headers['Content-Type'] = 'application/json'
      const token = String(opts?.authorization || '').trim()
      if (token) headers.Authorization = token
      return await readLlmText(parsed, method, headers, method === 'POST' ? body : undefined, timeoutMs, controller.signal)
    } catch (err: any) {
      if (controller.signal.aborted || err?.code === 'ETIMEDOUT' || err?.name === 'AbortError') {
        throw new Error(nativeText('llmTimeout', { seconds: Math.round(timeoutMs / 1000) }))
      }
      const code = String(err?.code || '')
      const msg = err instanceof Error ? err.message : String(err ?? '')
      const reason = code || msg || nativeText('unknownNetworkError')
      if (/ECONNRESET|EPIPE|ECONNABORTED|socket hang up|EAI_AGAIN/i.test(`${code} ${msg}`)) {
        throw new Error(nativeText('llmConnectionInterrupted', { reason }))
      }
      if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(`${code} ${msg}`)) {
        throw new Error(nativeText('llmEndpointUnreachable', { reason }))
      }
      throw new Error(msg || nativeText('llmConnectionFailed'))
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('desktop:dashscopeFetch', async (_e, opts?: {
    url?: string
    method?: string
    authorization?: string
    extraHeaders?: Record<string, string>
    body?: string
    timeoutMs?: number
  }) => {
    const url = String(opts?.url || '')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('invalid url')
    }
    const host = parsed.hostname.toLowerCase()
    const pathName = parsed.pathname
    const allowedHost =
      host === 'dashscope.aliyuncs.com' ||
      host.endsWith('.dashscope.aliyuncs.com') ||
      host.endsWith('.maas.aliyuncs.com')
    const allowedPath =
      pathName.includes('/services/aigc/video-generation/') ||
      /\/api\/v1\/tasks\/[^/]+$/.test(pathName)
    if (parsed.protocol !== 'https:' || !allowedHost || !allowedPath) {
      throw new Error(nativeText('bailianEndpoint'))
    }
    const method = String(opts?.method || 'GET').toUpperCase()
    const timeoutMs = Math.min(600000, Math.max(5000, Number(opts?.timeoutMs) || 120000))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      const token = String(opts?.authorization || '').trim()
      if (token) headers.Authorization = token
      if (method === 'POST') headers['Content-Type'] = 'application/json'
      for (const [k, v] of Object.entries(opts?.extraHeaders || {})) {
        const key = String(k || '').trim()
        if (!key || /^authorization$/i.test(key) || /^host$/i.test(key)) continue
        headers[key] = String(v ?? '')
      }
      const res = await net.fetch(url, {
        method,
        headers,
        body: method === 'POST' ? String(opts?.body || '') : undefined,
        signal: controller.signal
      })
      const text = await res.text()
      return { status: res.status, ok: res.ok, text }
    } catch (err: any) {
      if (controller.signal.aborted) {
        throw new Error(nativeText('bailianTimeout', { seconds: Math.round(timeoutMs / 1000) }))
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('desktop:ltxDesktopRequest', (_event, request: LtxDesktopRequest) => requestLtxDesktop(request))

  ipcMain.handle('desktop:ltxRequest', (_event, request: LtxRequest) =>
    requestLtx((url, options) => net.fetch(url, options), request)
  )

  ipcMain.handle('desktop:downloadToTemp', async (_e, url: string) => {
    const target = String(url || '')
    const dest = path.join(
      os.tmpdir(),
      `aicuts-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`
    )
    try {
      await downloadPublicVideo(target, dest)
      return dest
    } catch (error) {
      try {
        await fs.unlink(dest)
      } catch {
        /* ignore incomplete temp file */
      }
      throw error
    }
  })

  function senderWin(e: Electron.IpcMainInvokeEvent) {
    return BrowserWindow.fromWebContents(e.sender)
  }

  ipcMain.handle('window:minimize', (e) => {
    senderWin(e)?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = senderWin(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    senderWin(e)?.close()
  })
  ipcMain.handle('window:isMaximized', (e) => senderWin(e)?.isMaximized() ?? false)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  console.error('[electron] startup failed', err)
})

app.on('before-quit', () => {
  closeAppDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
