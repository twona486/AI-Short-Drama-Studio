import { t } from '@/i18n'
import zh from '@/locales/zh'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  listLibraryAssets,
  saveLibraryAsset,
  loadLibraryAssetBlob,
  deleteLibraryAsset,
  loadAssetBlob,
  listLibraryFolders,
  saveLibraryFolders,
  updateLibraryAssetMeta
} from '@/services/storage'
import { isDesktop, assetFileUrl } from '@/services/desktop'
import { libraryAssetAbsPath } from '@/services/storage'
import { probeMedia, ensurePlayableBlob } from '@/services/ffmpeg'
import type { Asset, ID, LibraryFolder } from '@/types'

/** 분류되지 않은 공용 에셋에 사용하는 화면 ID. */
export const LIBRARY_PUBLIC_ID = 'public'

type LibraryCategory = keyof typeof zh.library.category
// 기존 자동 분류 폴더의 저장 값과 이전 호출자의 인자를 보존한다.
type LegacyLibraryCategory = '角色' | '场景' | '道具' | '其他'

export const useLibraryStore = defineStore('library', () => {
  const all = ref<Asset[]>([])
  const folders = ref<LibraryFolder[]>([])
  const urlCache = new Map<ID, string>()
  const ensureFolderJobs = new Map<string, Promise<LibraryFolder>>()

  async function refresh() {
    const [assets, list] = await Promise.all([listLibraryAssets(), listLibraryFolders()])
    all.value = assets
    folders.value = list.sort((a, b) => a.createdAt - b.createdAt)
  }

  function inFolder(folderId: string | null): Asset[] {
    if (!folderId || folderId === LIBRARY_PUBLIC_ID) {
      return all.value.filter((a) => !a.folderId)
    }
    return all.value.filter((a) => a.folderId === folderId)
  }

  function folderCount(folderId: string | null): number {
    return inFolder(folderId).length
  }

  function folderName(folderId?: string): string {
    const name = folders.value.find((f) => f.id === folderId)?.name
    if (!name) return t('common.publicAssets')
    const category = Object.entries(zh.library.category).find(([, label]) => label === name)
    return category ? t(`library.category.${category[0]}`) : name
  }

  async function add(
    blob: Blob,
    source: Asset['source'],
    options: { filename?: string; prompt?: string; folderId?: string } = {}
  ): Promise<Asset> {
    const typed = await ensurePlayableBlob(blob, 'image')
    const info = await probeMedia(typed)
    const id = `image_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const folderId =
      options.folderId && options.folderId !== LIBRARY_PUBLIC_ID ? options.folderId : undefined
    const asset: Asset = {
      id,
      kind: 'image',
      mimeType: typed.type || 'image/png',
      filename: options.filename ?? `library_${id}`,
      size: typed.size,
      createdAt: Date.now(),
      source,
      prompt: options.prompt,
      library: true,
      folderId,
      width: info.width,
      height: info.height
    }
    await saveLibraryAsset(asset, typed)
    await refresh()
    return asset
  }

  async function publishFrom(
    assetId: ID,
    meta?: { filename?: string; prompt?: string }
  ): Promise<Asset> {
    const blob = await loadAssetBlob(assetId)
    if (!blob) throw new Error(t('library.imageUnreadable'))
    return add(blob, 'ai-generated', {
      filename: meta?.filename,
      prompt: meta?.prompt
    })
  }

  async function getUrl(id: ID): Promise<string | undefined> {
    const cached = urlCache.get(id)
    if (cached) return cached
    if (isDesktop()) {
      const abs = await libraryAssetAbsPath(id)
      if (abs) {
        const url = assetFileUrl(abs)
        urlCache.set(id, url)
        return url
      }
    }
    const blob = await loadLibraryAssetBlob(id)
    if (!blob) return undefined
    const url = URL.createObjectURL(blob)
    urlCache.set(id, url)
    return url
  }

  async function getBlob(id: ID): Promise<Blob | undefined> {
    return loadLibraryAssetBlob(id)
  }

  function getMeta(id: ID): Asset | undefined {
    return all.value.find((a) => a.id === id)
  }

  async function remove(id: ID) {
    await deleteLibraryAsset(id)
    const url = urlCache.get(id)
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    urlCache.delete(id)
    await refresh()
  }

  function assertFolderName(name: string, exceptId?: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error(t('library.folderNameRequired'))
    if ([t('common.publicAssets'), zh.common.publicAssets, '公共资产库'].includes(trimmed)) {
      throw new Error(t('library.reservedName'))
    }
    if (folders.value.some((f) => f.name === trimmed && f.id !== exceptId)) {
      throw new Error(t('library.duplicateName'))
    }
    return trimmed
  }

  async function createFolder(name: string): Promise<LibraryFolder> {
    const trimmed = assertFolderName(name)
    const folder: LibraryFolder = {
      id: `folder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      name: trimmed,
      createdAt: Date.now()
    }
    folders.value = [...folders.value, folder]
    await saveLibraryFolders(folders.value)
    return folder
  }

  /** 노드 결과 자동 보관용이다. 동시 생성 중에도 분류별 폴더를 한 번만 만든다. */
  async function ensureFolder(name: string): Promise<LibraryFolder> {
    const trimmed = name.trim()
    const current = folders.value.find((folder) => folder.name === trimmed)
    if (current) return current
    const pending = ensureFolderJobs.get(trimmed)
    if (pending) return pending
    const job = (async () => {
      await refresh()
      return folders.value.find((folder) => folder.name === trimmed) || createFolder(trimmed)
    })()
    ensureFolderJobs.set(trimmed, job)
    try {
      return await job
    } finally {
      ensureFolderJobs.delete(trimmed)
    }
  }

  async function addCategorized(
    blob: Blob,
    category: LibraryCategory | LegacyLibraryCategory,
    source: Asset['source'],
    options: { filename?: string; prompt?: string } = {}
  ): Promise<Asset> {
    const legacyName = zh.library.category[category as LibraryCategory] ?? category
    const folder = await ensureFolder(legacyName)
    return add(blob, source, { ...options, folderId: folder.id })
  }

  async function renameFolder(id: string, name: string): Promise<void> {
    const trimmed = assertFolderName(name, id)
    const next = folders.value.map((f) => (f.id === id ? { ...f, name: trimmed } : f))
    if (!next.some((f) => f.id === id)) throw new Error(t('library.folderMissing'))
    folders.value = next
    await saveLibraryFolders(folders.value)
  }

  async function deleteFolder(id: string): Promise<void> {
    const ids = all.value.filter((a) => a.folderId === id).map((a) => a.id)
    for (const assetId of ids) {
      await updateLibraryAssetMeta(assetId, { folderId: null })
    }
    folders.value = folders.value.filter((f) => f.id !== id)
    await saveLibraryFolders(folders.value)
    await refresh()
  }

  async function moveToFolder(ids: ID[], folderId: string | null): Promise<void> {
    const target =
      !folderId || folderId === LIBRARY_PUBLIC_ID ? null : folderId
    for (const id of ids) {
      await updateLibraryAssetMeta(id, { folderId: target })
    }
    await refresh()
  }

  return {
    all,
    folders,
    refresh,
    add,
    publishFrom,
    getUrl,
    getBlob,
    getMeta,
    remove,
    inFolder,
    folderCount,
    folderName,
    createFolder,
    ensureFolder,
    addCategorized,
    renameFolder,
    deleteFolder,
    moveToFolder
  }
})
