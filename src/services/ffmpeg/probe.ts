/**
 * 브라우저에서 FFmpeg 없이 영상과 이미지의 메타데이터를 확인한다.
 */

export interface MediaInfo {
  width: number
  height: number
  duration?: number
  hasAudio?: boolean
}

export async function probeMedia(blob: Blob): Promise<MediaInfo> {
  const typed = playableMediaBlob(blob)
  const url = URL.createObjectURL(typed)
  try {
    if (typed.type.startsWith('image/')) {
      const img = await loadImage(url)
      return { width: img.naturalWidth, height: img.naturalHeight }
    } else if (typed.type.startsWith('video/')) {
      try {
        return await probeVideo(url)
      } catch {
        return { width: 0, height: 0, duration: undefined, hasAudio: false }
      }
    } else if (typed.type.startsWith('audio/')) {
      return await probeAudio(url)
    }
    try {
      return await probeVideo(url)
    } catch {
      throw new Error('지원하지 않는 미디어 유형 ' + (typed.type || '(empty)'))
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

function probeVideo(url: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('영상 메타데이터를 읽지 못했어요.'))
    }, 8000)
    const cleanup = () => {
      window.clearTimeout(timer)
      v.onloadedmetadata = null
      v.onerror = null
      v.removeAttribute('src')
      v.load()
    }
    v.onloadedmetadata = () => {
      const info = {
        width: v.videoWidth,
        height: v.videoHeight,
        duration: v.duration,
        hasAudio: false
      }
      cleanup()
      resolve(info)
    }
    v.onerror = () => {
      cleanup()
      reject(new Error('영상 메타데이터를 읽지 못했어요.'))
    }
    v.src = url
  })
}

function probeAudio(url: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = () => {
      resolve({
        width: 0,
        height: 0,
        duration: a.duration
      })
    }
    a.onerror = () => reject(new Error('오디오 메타데이터를 읽지 못했어요.'))
    a.src = url
  })
}

/** IndexedDB에서 MIME 유형이 빠지면 브라우저가 미디어 재생을 거부할 수 있다. */
export function playableMediaBlob(
  blob: Blob,
  kind?: 'image' | 'video' | 'audio',
  mimeType?: string
): Blob {
  const raw = (blob.type || mimeType || '').toLowerCase()
  if (raw && raw !== 'application/octet-stream') return blob
  const fallback =
    kind === 'video' || raw.startsWith('video')
      ? 'video/mp4'
      : kind === 'audio' || raw.startsWith('audio')
        ? 'audio/mpeg'
        : kind === 'image' || raw.startsWith('image')
          ? 'image/png'
          : mimeType || blob.type
  if (!fallback) return blob
  return blob.slice(0, blob.size, fallback)
}

function sniffContainerMime(bytes: Uint8Array, kind?: 'image' | 'video' | 'audio'): string | undefined {
  if (bytes.length < 12) return undefined
  const ascii = (n: number, m: number) => String.fromCharCode(...bytes.subarray(n, m))
  // 이미지를 먼저 식별해 MIME 유형이 없는 JPEG를 MP4로 인식하지 않게 한다.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    ascii(0, 4) === 'RIFF' &&
    ascii(8, 12) === 'WEBP'
  )
    return 'image/webp'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav'
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (ascii(0, 4) === 'OggS') return kind === 'video' ? 'video/ogg' : 'audio/ogg'
  if (ascii(4, 8) === 'ftyp') return kind === 'audio' ? 'audio/mp4' : 'video/mp4'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm'
  }
  return undefined
}

/** 파일 헤더로 MIME 유형을 확인해 WAV와 이미지가 잘못 분류되지 않게 한다. */
export async function ensurePlayableBlob(
  blob: Blob,
  kind?: 'image' | 'video' | 'audio',
  mimeType?: string
): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const sniffed = sniffContainerMime(head, kind)
  if (sniffed) {
    if (kind === 'video' && sniffed.startsWith('image/')) {
      // 실제 유형을 복구하고 오류 처리는 호출자에게 맡긴다.
      return blob.slice(0, blob.size, sniffed)
    }
    if (sniffed !== blob.type) return blob.slice(0, blob.size, sniffed)
    return blob
  }
  const typed = playableMediaBlob(blob, kind, mimeType)
  return typed
}

export async function isMostlyDarkImage(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(img, 0, 0, 32, 32)
    const data = ctx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] + data[i + 1] + data[i + 2]
    }
    return sum / (32 * 32 * 3) < 18
  } finally {
    URL.revokeObjectURL(url)
  }
}

function canvasIsDark(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const sampleW = Math.min(48, w)
  const sampleH = Math.min(48, h)
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i] + data[i + 1] + data[i + 2]
  }
  return sum / ((data.length / 4) * 3) < 18
}

function seekTo(v: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('seek timeout')), 4000)
    const done = () => {
      window.clearTimeout(timer)
      v.removeEventListener('seeked', done)
      resolve()
    }
    v.addEventListener('seeked', done)
    v.currentTime = time
  })
}

/** 영상 도입부의 검은 화면을 피해 표지 프레임을 추출한다. */
export async function extractVideoThumbnail(blob: Blob): Promise<Blob> {
  const typed = playableMediaBlob(blob, 'video')
  const url = URL.createObjectURL(typed)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('영상 메타데이터 읽기 시간이 초과됐어요.')), 10000)
      v.onloadedmetadata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      v.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('영상을 불러오지 못했어요.'))
      }
    })
    try {
      await v.play()
      v.pause()
    } catch {
      /* 자동 재생이 차단돼도 시간 위치 이동은 계속한다. */
    }
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1
    const candidates = [
      Math.min(1.0, dur * 0.25),
      Math.min(2.0, dur * 0.4),
      dur * 0.5,
      Math.min(0.4, dur * 0.1),
      Math.max(0.08, dur - 0.35)
    ]
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('커버 이미지를 만들 수 없습니다.')
    let lastJpeg: Blob | null = null
    for (const t of candidates) {
      const target = Math.min(Math.max(0.04, t), Math.max(0.04, dur - 0.05))
      try {
        await seekTo(v, target)
      } catch {
        continue
      }
      if (!v.videoWidth) continue
      const w = 480
      const ratio = v.videoWidth / v.videoHeight || 16 / 9
      canvas.width = w
      canvas.height = Math.max(1, Math.round(w / ratio))
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('표지 이미지가 비어 있어요.'))), 'image/jpeg', 0.82)
      })
      lastJpeg = jpeg
      if (!canvasIsDark(ctx, canvas.width, canvas.height)) return jpeg
    }
    if (lastJpeg) return lastJpeg
    throw new Error('커버 이미지를 만들 수 없습니다.')
  } finally {
    v.pause()
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}

/** 영상의 끝 프레임을 추출해 다음 샷의 시작 프레임에 쓴다. */
export async function extractVideoLastFrame(blob: Blob, options?: { preserveEnding?: boolean }): Promise<Blob> {
  const typed = playableMediaBlob(blob, 'video')
  const url = URL.createObjectURL(typed)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('영상 메타데이터 읽기 시간이 초과됐어요.')), 10000)
      v.onloadedmetadata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      v.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('영상을 불러오지 못했어요.'))
      }
    })
    try {
      await v.play()
      v.pause()
    } catch {
      /* 자동 재생이 차단돼도 시간 위치 이동은 계속한다. */
    }
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('끝 프레임을 만들 수 없습니다.')
    // 인코딩 잡음을 피하려고 마지막 지점에서 반 프레임 앞도 확인해 검지 않은 프레임을 선택한다.
    const candidates = options?.preserveEnding
      ? [Math.max(0, dur - 0.001), Math.max(0, dur - 0.025)]
      : [Math.max(0.04, dur - 0.08), Math.max(0.04, dur - 0.25)]
    let lastJpeg: Blob | null = null
    for (const t of candidates) {
      try {
        await seekTo(v, t)
      } catch {
        continue
      }
      if (!v.videoWidth) continue
      const w = Math.min(1280, v.videoWidth)
      const ratio = v.videoWidth / v.videoHeight || 16 / 9
      canvas.width = Math.max(1, Math.round(w))
      canvas.height = Math.max(1, Math.round(w / ratio))
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('끝 프레임이 비어 있어요.'))), 'image/jpeg', 0.9)
      })
      lastJpeg = jpeg
      if (options?.preserveEnding || !canvasIsDark(ctx, canvas.width, canvas.height)) return jpeg
    }
    if (lastJpeg) return lastJpeg
    throw new Error('끝 프레임을 만들 수 없습니다.')
  } finally {
    v.pause()
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}
