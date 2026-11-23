import { t } from '@/i18n'
/**
 * 에셋 스토어.
 *
 * 에셋 메타데이터와 런타임 blob URL 캐시를 관리한다.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  saveAsset,
  loadAssetBlob,
  listAssets,
  deleteAsset,
  loadThumbBlob,
  saveThumb,
  assetAbsPath
} from '@/services/storage'
import { isDesktop, assetFileUrl } from '@/services/desktop'
import {
  probeMedia,
  extractVideoThumbnail,
  ensurePlayableBlob,
  isMostlyDarkImage
} from '@/services/ffmpeg'
import type { Asset, ID } from '@/types'

export const useAssetsStore = defineStore('assets', () => {
  const all = ref<Asset[]>([])
  const urlCache = new Map<ID, string>()
  const thumbCache = new Map<ID, string>()

  const images = computed(() => all.value.filter((a) => a.kind === 'image'))
  const videos = computed(() => all.value.filter((a) => a.kind === 'video'))

  /** 에셋 목록을 새로 고친다. */
  async function refresh() {
    all.value = await listAssets()
  }

  /** AI로 생성하거나 업로드한 에셋을 추가한다. */
  async function add(
    blob: Blob,
    kind: Asset['kind'],
    source: Asset['source'],
    options: {
      filename?: string
      prompt?: string
      projectId?: string
      shotId?: string
    } = {}
  ): Promise<Asset> {
    const typed = await ensurePlayableBlob(blob, kind)
    const info = await probeMedia(typed)
    const id = `${kind}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`
    const base = {
      id,
      kind,
      mimeType: typed.type || guessMime(kind),
      filename: options.filename ?? `${kind}_${id}`,
      size: typed.size,
      createdAt: Date.now(),
      source,
      prompt: options.prompt,
      projectId: options.projectId,
      shotId: options.shotId
    }
    let asset: Asset
    let thumbBlob: Blob | undefined
    if (kind === 'image') {
      asset = { ...base, kind: 'image', width: info.width, height: info.height }
    } else if (kind === 'video') {
      // 미리보기 이미지를 영상 에셋으로 저장하지 않는다.
      const head = new Uint8Array(await typed.slice(0, 16).arrayBuffer())
      const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      const isPng =
        head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
      const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46
      if (isJpeg || isPng || isGif || (typed.type || '').startsWith('image/')) {
        throw new Error(
          t('assets.imageInsteadOfVideo')
        )
      }
      // 길이가 0초로 읽혀도 다운로드가 끝난 MP4는 보존한다.
      if (
        typed.size < 80_000 &&
        info.duration != null &&
        Number.isFinite(info.duration) &&
        info.duration < 0.2
      ) {
        throw new Error(
          t('assets.invalidVideoDuration', { seconds: info.duration.toFixed(2) })
        )
      }
      thumbBlob = await extractVideoThumbnail(typed).catch(() => undefined)
      asset = {
        ...base,
        kind: 'video',
        width: info.width,
        height: info.height,
        duration: info.duration ?? 0,
        fps: 30,
        hasAudio: info.hasAudio ?? false
      }
    } else {
      asset = { ...base, kind: 'audio', duration: info.duration ?? 0 }
    }
    await saveAsset(asset, typed, thumbBlob)
    all.value = [asset, ...all.value.filter((item) => item.id !== asset.id)]
    return asset
  }

  function guessMime(kind: Asset['kind']): string {
    return kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg'
  }

  /** 재생 URL을 반환한다. 영상과 오디오는 전체 blob을 사용해 Range가 없는 프로토콜에서도 끝까지 재생한다. */
  async function getUrl(id: ID): Promise<string | undefined> {
    const meta = all.value.find((a) => a.id === id)
    const asBlob =
      meta?.kind === 'video' ||
      meta?.kind === 'audio' ||
      id.startsWith('video_') ||
      id.startsWith('audio_')
    const cached = urlCache.get(id)
    if (cached && !(asBlob && cached.startsWith('aicuts:'))) return cached
    if (cached) urlCache.delete(id)
    if (isDesktop() && !asBlob) {
      const abs = await assetAbsPath(id)
      if (abs) {
        const url = assetFileUrl(abs)
        urlCache.set(id, url)
        return url
      }
    }
    const blob = await loadAssetBlob(id)
    if (!blob) return undefined
    const typed = await ensurePlayableBlob(blob, meta?.kind, meta?.mimeType)
    const url = URL.createObjectURL(typed)
    urlCache.set(id, url)
    return url
  }

  /** 썸네일 URL을 반환한다. */
  async function getThumbUrl(id: ID): Promise<string | undefined> {
    if (thumbCache.has(id)) return thumbCache.get(id)
    const blob = await loadThumbBlob(id)
    if (!blob) return undefined
    const url = URL.createObjectURL(blob)
    thumbCache.set(id, url)
    return url
  }

  /** 썸네일이 없거나 검은 화면이면 프레임을 추출해 저장한다. */
  async function ensureThumb(id: ID): Promise<string | undefined> {
    const stored = await loadThumbBlob(id)
    if (stored && stored.size >= 80) {
      const dark = await isMostlyDarkImage(stored).catch(() => false)
      if (!dark) {
        if (thumbCache.has(id)) return thumbCache.get(id)
        const url = URL.createObjectURL(stored)
        thumbCache.set(id, url)
        return url
      }
      if (thumbCache.has(id)) {
        URL.revokeObjectURL(thumbCache.get(id)!)
        thumbCache.delete(id)
      }
    }
    const blob = await loadAssetBlob(id)
    if (!blob) return undefined
    const thumb = await extractVideoThumbnail(blob).catch(() => undefined)
    if (!thumb || thumb.size < 80) return undefined
    await saveThumb(id, thumb)
    if (thumbCache.has(id)) URL.revokeObjectURL(thumbCache.get(id)!)
    const url = URL.createObjectURL(thumb)
    thumbCache.set(id, url)
    return url
  }

  /** FFmpeg 처리에 필요한 원본 blob을 반환한다. */
  async function getBlob(id: ID): Promise<Blob | undefined> {
    return loadAssetBlob(id)
  }

  /** 메모리에 불러온 메타데이터를 즉시 반환한다. */
  function getMeta(id: ID): Asset | undefined {
    return all.value.find((a) => a.id === id)
  }

  /** 리소스 라이브러리 등의 에셋을 현재 프로젝트에 추가한다. 이미 있으면 그대로 반환한다. */
  async function adopt(
    id: ID,
    kind: Asset['kind'],
    options: { projectId?: string; shotId?: string } = {}
  ): Promise<Asset> {
    const existing = getMeta(id)
    if (existing && existing.kind === kind) return existing
    let blob = await getBlob(id)
    let meta = existing
    if (!blob) {
      const { useLibraryStore } = await import('./library')
      const library = useLibraryStore()
      blob = await library.getBlob(id)
      meta = library.getMeta(id)
    }
    if (!blob) throw new Error(t('common.assetReadFailed'))
    return add(blob, kind, meta?.source || 'uploaded', {
      filename: meta?.filename,
      prompt: meta?.prompt,
      projectId: options.projectId,
      shotId: options.shotId
    })
  }

  async function remove(id: ID) {
    await deleteAsset(id)
    if (urlCache.has(id) && urlCache.get(id)!.startsWith('blob:')) {
      URL.revokeObjectURL(urlCache.get(id)!)
    }
    urlCache.delete(id)
    if (thumbCache.has(id) && thumbCache.get(id)!.startsWith('blob:')) {
      URL.revokeObjectURL(thumbCache.get(id)!)
    }
    thumbCache.delete(id)
    await refresh()
  }

  /** 생성한 URL을 모두 해제한다. */
  function cleanup() {
    for (const url of urlCache.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    }
    for (const url of thumbCache.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    }
    urlCache.clear()
    thumbCache.clear()
  }

  return {
    all,
    images,
    videos,
    refresh,
    add,
    getUrl,
    getThumbUrl,
    ensureThumb,
    getBlob,
    getMeta,
    remove,
    adopt,
    cleanup
  }
})
