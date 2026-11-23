/**
 * FFmpeg.wasm 包装
 *
 * 加载策略（按优先级）：
 *   1. 本地 /ffmpeg/*  （完全离线，推荐国内用户）
 *   2. jsDelivr CDN   （比 unpkg 稳）
 *   3. unpkg CDN      （兜底）
 *
 * 注意：浏览器需要 cross-origin isolation（COOP/COEP headers）
 * 才会启用 SharedArrayBuffer。Vite 配置里已经设置。
 *
 * 实现：直接给 ffmpeg.load() 传 URL，不用 toBlobURL。
 * 这样 ffmpeg 内部 worker 会自己去 fetch，比 toBlobURL 链路更短、更稳。
 */

import { t } from "@/i18n"
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
// 用 Vite ?url import 拿到本地 core 文件的 URL
// 之前放 public/ 被 Vite 禁止从 source code 引用（"cannot be imported from source code"）
// 移到 src/assets/ 用 ?url 解决
import coreJsUrl from '@ffmpeg/core?url'
import coreWasmUrl from '@ffmpeg/core/wasm?url'

let _ffmpeg: FFmpeg | null = null
let _loading: Promise<FFmpeg> | null = null

const CORE_VERSION = '0.12.10'

/** 多个 CDN 源，按顺序尝试
 * 注意：用 ESM 版 ffmpeg-core，因为 @ffmpeg/ffmpeg 0.12.10 强制 module worker
 *       module worker 不支持 importScripts（UMD 用），必须用 ESM 版才能 dynamic import
 */
const CDN_SOURCES = [
  {
    name: t('ffmpegClient.local'),
    base: '(vite ?url)',
    urls: {
      js: coreJsUrl,
      wasm: coreWasmUrl
    }
  },
  {
    name: 'jsDelivr',
    base: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    urls: {
      js: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.js`,
      wasm: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`
    }
  },
  {
    name: 'unpkg',
    base: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    urls: {
      js: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.js`,
      wasm: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`
    }
  },
  {
    name: t('ffmpegClient.mirror'),
    base: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm`,
    urls: {
      js: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm/ffmpeg-core.js`,
      wasm: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm/ffmpeg-core.wasm`
    }
  }
]

/** 测一个 URL 是否能访问（用 HEAD），返回 ms 耗时或 -1 */
async function probeUrl(url: string, timeout = 8000): Promise<number> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const t0 = performance.now()
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: ctl.signal,
      cache: 'no-store'
    })
    clearTimeout(timer)
    if (resp.ok) return performance.now() - t0
    return -1
  } catch {
    clearTimeout(timer)
    return -1
  }
}

/** 选最快的源 */
async function pickBestSource(onLog?: (msg: string) => void): Promise<typeof CDN_SOURCES[0] | null> {
  for (const src of CDN_SOURCES) {
    const ms = await probeUrl(src.urls.js)
    if (ms > 0) {
      onLog?.(t('ffmpegClient.sourceAvailable', { source: src.name, elapsed: Math.round(ms) }))
      return src
    } else {
      onLog?.(t('ffmpegClient.sourceUnavailable', { source: src.name }))
    }
  }
  return null
}

/** 获取或初始化 FFmpeg（单例） */
export async function getFFmpeg(
  onProgress?: (msg: string) => void
): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg
  if (_loading) return _loading

  _loading = (async () => {
    const log = (msg: string) => {
      console.log('[FFmpeg]', msg)
      onProgress?.(msg)
    }

    // 检查浏览器支持
    if (typeof SharedArrayBuffer === 'undefined') {
      if (window.desktop?.isDesktop) {
        throw new Error(
          t('ffmpegClient.desktopSharedBuffer')
        )
      }
      throw new Error(
        t('ffmpegClient.browserSharedBuffer')
      )
    }
    if (!self.crossOriginIsolated) {
      if (window.desktop?.isDesktop) {
        throw new Error(
          t('ffmpegClient.desktopIsolation')
        )
      }
      throw new Error(
        t('ffmpegClient.browserIsolation')
      )
    }

    const ffmpeg = new FFmpeg()

    ffmpeg.on('log', ({ message }) => {
      if (
        message.includes('frame=') ||
        message.includes('error') ||
        message.includes('Error') ||
        message.includes('Conversion')
      ) {
        log(message.slice(0, 200))
      }
    })
    ffmpeg.on('progress', ({ progress }) => {
      if (progress > 0) {
        log(t('ffmpegClient.progress', { percent: Math.round(progress * 100) }))
      }
    })

    log(t('ffmpegClient.checkingSources'))
    const src = await pickBestSource(log)
    if (!src) {
      throw new Error(t('ffmpegClient.noSource'))
    }
    log(t('ffmpegClient.sourceSelected', { source: src.name }))

    try {
      // 1) 先 HEAD 探活 + 检查 MIME，明确报错
      log(t('ffmpegClient.checkJs', { url: src.urls.js }))
      const headJs = await fetch(src.urls.js, { method: 'HEAD' })
      log(`  → ${headJs.status} ${headJs.statusText}, type=${headJs.headers.get('content-type')}`)
      if (!headJs.ok) {
        throw new Error(
          t('ffmpegClient.jsUnavailable', { status: headJs.status, detail: headJs.statusText }) +
            `URL: ${src.urls.js}\n` +
            (headJs.status === 404
              ? t('ffmpegClient.coreMissing')
              : '')
        )
      }

      log(t('ffmpegClient.checkWasm', { url: src.urls.wasm }))
      const headWasm = await fetch(src.urls.wasm, { method: 'HEAD' })
      log(`  → ${headWasm.status} ${headWasm.statusText}, type=${headWasm.headers.get('content-type')}`)
      if (!headWasm.ok) {
        throw new Error(
          t('ffmpegClient.wasmUnavailable', { status: headWasm.status, detail: headWasm.statusText, url: src.urls.wasm })
        )
      }
      const wasmMime = headWasm.headers.get('content-type') || ''
      if (wasmMime && !wasmMime.includes('wasm') && !wasmMime.includes('octet')) {
        throw new Error(t('ffmpegClient.invalidMime', { mime: wasmMime }))
      }

      // 2) 直接传 URL 给 ffmpeg.load()，不用 toBlobURL
      //    ffmpeg.wasm 0.12+ 接受 string URL，内部 worker 会自己 fetch
      //    ESM core + module worker + dynamic import(.default) 这条链路是通的
      log(t('ffmpegClient.directUrl'))

      log(t('ffmpegClient.initializing'))
      await ffmpeg.load({
        coreURL: src.urls.js,
        wasmURL: src.urls.wasm
      })
      log(t('ffmpegClient.ready'))
      _ffmpeg = ffmpeg
      return ffmpeg
    } catch (e: any) {
      throw new Error(t('ffmpegClient.loadFailed', { source: src.name, error: e.message }))
    }
  })().catch((e) => {
    _loading = null
    throw e
  })

  return _loading
}

/** 是否已加载 */
export function isFFmpegReady(): boolean {
  return _ffmpeg !== null
}

/** 强制重置（用于切换源后重试） */
export function resetFFmpeg() {
  if (_ffmpeg) {
    try {
      _ffmpeg.terminate()
    } catch {}
  }
  _ffmpeg = null
  _loading = null
}

/** 写文件到 FFmpeg 虚拟 FS */
export async function writeFile(
  ffmpeg: FFmpeg,
  name: string,
  data: Blob | File | Uint8Array | string
) {
  let payload: Uint8Array | string
  if (typeof data === 'string') {
    payload = data
  } else if (data instanceof Uint8Array) {
    payload = new Uint8Array(data)
  } else {
    const raw = await fetchFile(data)
    payload = new Uint8Array(raw)
  }
  await ffmpeg.writeFile(name, payload)
}

/** 尽量清掉 MEMFS 里的中间文件，避免二次导出撑爆虚拟磁盘 */
export async function clearFS(ffmpeg: FFmpeg) {
  try {
    const entries = await ffmpeg.listDir('/')
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.isDir) continue
      try {
        await ffmpeg.deleteFile(entry.name)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** 从 FFmpeg 虚拟 FS 读文件 */
export async function readFile(ffmpeg: FFmpeg, name: string): Promise<Uint8Array> {
  const data = await ffmpeg.readFile(name)
  // ffmpeg.readFile 在 web 上返回 Uint8Array，node 上返回 string；统一处理
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  return data as Uint8Array
}

/** 把 Uint8Array 包装成 Blob（带 MIME） */
export function toBlob(data: Uint8Array, mime: string): Blob {
  // 复制成 ArrayBuffer-backed Uint8Array，避免 SharedArrayBuffer 类型冲突
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  return new Blob([buf], { type: mime })
}

/** 公共 fetchFile */
export { fetchFile }
