/**
 * 데스크톱 로컬 디렉터리 저장소
 *
 * 사용자가 선택한 저장 디렉터리의 프로젝트별 하위 디렉터리
 *   project.json
 *   assets/manifest.json
 *   assets/images|videos|audio/<id>.<ext>
 *   thumbs/<id>.jpg
 */

import { toRaw } from 'vue'
import type { Asset, Project } from '@/types'
import { desktop, isDesktop, blobFromPath, bufferFromBlob } from '@/services/desktop'
import { localizeProject } from './defaultNames'
import { withFileQueue } from './fileQueue'

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

function extOf(asset: Pick<Asset, 'kind' | 'mimeType' | 'filename'>): string {
  const fromName = asset.filename?.split('.').pop()?.toLowerCase()
  if (fromName && fromName.length <= 5) return fromName
  if (asset.mimeType.includes('png')) return 'png'
  if (asset.mimeType.includes('webp')) return 'webp'
  if (asset.mimeType.includes('jpeg') || asset.mimeType.includes('jpg')) return 'jpg'
  if (asset.mimeType.includes('webm')) return 'webm'
  if (asset.mimeType.includes('mp4')) return 'mp4'
  if (asset.mimeType.includes('wav')) return 'wav'
  if (asset.mimeType.includes('mpeg') || asset.mimeType.includes('mp3')) return 'mp3'
  return asset.kind === 'image' ? 'png' : asset.kind === 'video' ? 'mp4' : 'mp3'
}

function kindFolder(kind: Asset['kind']): string {
  return kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audio'
}

let activeDir: string | null = null
let assetCache: Asset[] = []

export function setActiveProjectDir(dir: string | null) {
  activeDir = dir
}

export function getActiveProjectDir(): string | null {
  return activeDir
}

async function manifestPath(dir: string) {
  return desktop().join(dir, 'assets', 'manifest.json')
}

async function loadManifest(dir: string): Promise<Asset[]> {
  const p = await manifestPath(dir)
  if (!(await desktop().exists(p))) return []
  try {
    const text = await desktop().readText(p)
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function saveManifest(dir: string, list: Asset[]) {
  const p = await manifestPath(dir)
  await desktop().writeText(p, JSON.stringify(toPlain(list), null, 2))
}

export async function saveProject(project: Project): Promise<void> {
  if (!isDesktop()) throw new Error('파일 시스템 저장소는 데스크톱 앱에서 사용할 수 있습니다.')
  const dir = project.folderPath || activeDir
  if (!dir) throw new Error('프로젝트 폴더 경로가 없습니다.')
  const jsonPath = await desktop().join(dir, 'project.json')
  const plain = { ...toPlain(project), defaultNamesLocalized: true }
  await withFileQueue(jsonPath, () => desktop().writeText(jsonPath, JSON.stringify(plain, null, 2), true))
  activeDir = dir
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const all = await listProjects()
  const hit = all.find((p) => p.id === id)
  if (!hit?.folderPath) return hit
  activeDir = hit.folderPath
  assetCache = await loadManifest(hit.folderPath)
  return hit
}

export async function loadProjectFromDir(dir: string): Promise<Project | undefined> {
  const p = await readProject(dir)
  if (!p) return undefined
  activeDir = dir
  assetCache = await loadManifest(dir)
  return p
}

async function readProject(dir: string, skipUnreadable = false): Promise<Project | undefined> {
  const jsonPath = await desktop().join(dir, 'project.json')
  return withFileQueue(jsonPath, async () => {
    let project: Project
    try {
      if (!(await desktop().exists(jsonPath))) return undefined
      project = JSON.parse(await desktop().readText(jsonPath))
    } catch (error) {
      if (skipUnreadable) return undefined
      throw error
    }
    if (typeof project?.name !== 'string') return undefined
    if (!project.defaultNamesLocalized) {
      localizeProject(project)
      await desktop().writeText(jsonPath, JSON.stringify(project, null, 2), true)
    }
    return { ...project, folderPath: dir }
  })
}

export async function listProjects(): Promise<Project[]> {
  if (!isDesktop()) return []
  const dirs = await desktop().listProjectDirs()
  const out: Project[] = []
  for (const dir of dirs) {
    const p = await readProject(dir, true)
    if (p) out.push(p)
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export async function deleteProject(id: string): Promise<void> {
  const all = await listProjects()
  const hit = all.find((p) => p.id === id)
  if (hit?.folderPath) await desktop().remove(hit.folderPath)
  if (activeDir === hit?.folderPath) {
    activeDir = null
    assetCache = []
  }
}

let saveAssetChain: Promise<void> = Promise.resolve()

export async function saveAsset(asset: Asset, blob: Blob, thumbBlob?: Blob): Promise<void> {
  const run = async () => {
    const dir = activeDir
    if (!dir) throw new Error('열려 있는 프로젝트 폴더가 없어 자료를 저장할 수 없습니다.')
    const ext = extOf(asset)
    const rel = `assets/${kindFolder(asset.kind)}/${asset.id}.${ext}`
    const abs = await desktop().join(dir, rel)
    await desktop().writeBuffer(abs, await bufferFromBlob(blob))
    const stored: Asset = { ...toPlain(asset), fileRelPath: rel }
    if (thumbBlob) {
      const tRel = `thumbs/${asset.id}.jpg`
      const tAbs = await desktop().join(dir, tRel)
      await desktop().writeBuffer(tAbs, await bufferFromBlob(thumbBlob))
    }
    const list = await loadManifest(dir)
    const idx = list.findIndex((a) => a.id === asset.id)
    if (idx >= 0) list[idx] = stored
    else list.unshift(stored)
    await saveManifest(dir, list)
    assetCache = list
  }
  const next = saveAssetChain.then(run, run)
  saveAssetChain = next.catch(() => undefined)
  return next
}

export async function loadAssetBlob(id: string): Promise<Blob | undefined> {
  const dir = activeDir
  if (!dir) return undefined
  const list = assetCache.length ? assetCache : await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (!meta?.fileRelPath) return undefined
  const abs = await desktop().join(dir, meta.fileRelPath)
  if (!(await desktop().exists(abs))) return undefined
  return blobFromPath(abs)
}

export async function loadAsset(id: string): Promise<Asset | undefined> {
  const list = await listAssets()
  return list.find((a) => a.id === id)
}

export async function loadThumbBlob(id: string): Promise<Blob | undefined> {
  const dir = activeDir
  if (!dir) return undefined
  const abs = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  if (!(await desktop().exists(abs))) return undefined
  return blobFromPath(abs)
}

export async function saveThumb(id: string, blob: Blob): Promise<void> {
  const dir = activeDir
  if (!dir) return
  const abs = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  await desktop().writeBuffer(abs, await bufferFromBlob(blob))
}

export async function deleteAsset(id: string): Promise<void> {
  const dir = activeDir
  if (!dir) return
  const list = await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (meta?.fileRelPath) {
    const abs = await desktop().join(dir, meta.fileRelPath)
    await desktop().remove(abs)
  }
  const thumb = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  await desktop().remove(thumb)
  const next = list.filter((a) => a.id !== id)
  await saveManifest(dir, next)
  assetCache = next
}

export async function listAssets(): Promise<Asset[]> {
  if (!activeDir) return []
  assetCache = await loadManifest(activeDir)
  return [...assetCache].sort((a, b) => b.createdAt - a.createdAt)
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  return { usage: 0, quota: 0 }
}

export async function assetAbsPath(id: string): Promise<string | undefined> {
  const dir = activeDir
  if (!dir) return undefined
  return assetAbsPathInDir(dir, id)
}

/** 현재 프로젝트를 바꾸지 않고 지정한 디렉터리 기준으로 홈 화면 표지 파일 경로를 구한다. */
export async function assetAbsPathInDir(
  dir: string,
  id: string
): Promise<string | undefined> {
  const list = await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (!meta?.fileRelPath) return undefined
  const abs = await desktop().join(dir, meta.fileRelPath)
  if (!(await desktop().exists(abs))) return undefined
  return abs
}
