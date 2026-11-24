/**
 * FFmpeg.wasm 래퍼
 *
 * 코어를 불러오는 순서
 *   1. 로컬 코어(오프라인)
 *   2. jsDelivr CDN
 *   3. unpkg CDN(대체 경로)
 *
 * 브라우저의 SharedArrayBuffer를 사용하려면 교차 출처 격리가 필요하다.
 * Vite 설정에 COOP 및 COEP 헤더가 있다.
 *
 * ffmpeg.load()에 URL을 직접 전달한다.
 * FFmpeg 워커가 URL에서 직접 코어 파일을 가져온다.
 */

import { t } from "@/i18n"
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
// Vite의 ?url 가져오기로 로컬 코어 파일 URL을 구한다.
// Vite는 소스에서 public 디렉터리의 파일을 가져올 수 없다.
// src/assets 디렉터리의 파일에 ?url을 사용한다.
import coreJsUrl from '@ffmpeg/core?url'
import coreWasmUrl from '@ffmpeg/core/wasm?url'

let _ffmpeg: FFmpeg | null = null
let _loading: Promise<FFmpeg> | null = null

const CORE_VERSION = '0.12.10'

/** 여러 CDN을 순서대로 확인한다.
 * FFmpeg 0.12.10 모듈 워커에는 ESM 코어를 사용한다.
 *       모듈 워커는 UMD의 importScripts 대신 동적 import를 쓴다.
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

/** HEAD로 URL에 접근할 수 있는지 확인한다. 밀리초 또는 -1을 반환한다. */
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

/** 응답이 가장 빠른 소스를 선택한다. */
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

/** FFmpeg 싱글턴을 반환하거나 초기화한다. */
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

    // 브라우저 지원 여부를 확인한다.
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
      // HEAD 응답과 MIME 유형을 먼저 검사해 구체적인 오류를 반환한다.
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

      // ffmpeg.load()에 URL을 직접 전달한다.
      //    FFmpeg.wasm 0.12 이상에서 워커가 URL을 직접 가져온다.
      //    ESM 코어와 모듈 워커는 동적 import로 연결한다.
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

/** 코어가 로드됐는지 확인한다. */
export function isFFmpegReady(): boolean {
  return _ffmpeg !== null
}

/** 소스를 변경한 뒤 다시 시도할 수 있도록 초기화 상태를 제거한다. */
export function resetFFmpeg() {
  if (_ffmpeg) {
    try {
      _ffmpeg.terminate()
    } catch {}
  }
  _ffmpeg = null
  _loading = null
}

/** FFmpeg 가상 파일 시스템에 쓴다. */
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

/** 다시 내보낼 때 메모리가 부족하지 않도록 임시 파일을 가능한 한 정리한다. */
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

/** FFmpeg 가상 파일 시스템에서 읽는다. */
export async function readFile(ffmpeg: FFmpeg, name: string): Promise<Uint8Array> {
  const data = await ffmpeg.readFile(name)
  // 브라우저의 Uint8Array와 Node의 문자열 반환값을 동일하게 처리한다.
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  return data as Uint8Array
}

/** Uint8Array를 MIME 유형이 있는 Blob으로 변환한다. */
export function toBlob(data: Uint8Array, mime: string): Blob {
  // SharedArrayBuffer 유형 충돌을 피하도록 ArrayBuffer 기반 배열에 복사한다.
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  return new Blob([buf], { type: mime })
}

/** 공용 fetchFile 함수 */
export { fetchFile }
