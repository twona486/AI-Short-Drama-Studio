/**
 * 프로젝트와 소재를 저장하는 IndexedDB
 *
 * 객체 저장소 네 개를 사용한다.
 * projects는 대용량 파일을 제외한 프로젝트 메타데이터를 저장한다.
 * assets는 ID별 소재 Blob을 저장한다.
 * thumbs는 썸네일을 저장한다.
 * scripts는 대본 메타데이터와 Markdown 본문을 저장한다.
 */

import { toRaw } from 'vue'
import type { Asset, Project, ScriptDoc } from '@/types'

/** IndexedDB에 저장하기 전에 Vue 프록시를 일반 객체로 변환한다. */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

const DB_NAME = 'ai-cut-db'
const DB_VERSION = 2

export type StoreName = 'projects' | 'assets' | 'thumbs' | 'scripts'

let _db: IDBDatabase | null = null

export function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('thumbs')) {
        db.createObjectStore('thumbs', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('scripts')) {
        db.createObjectStore('scripts', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      _db = req.result
      resolve(_db)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value as any)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(id)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function del(store: StoreName, id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function list<T>(store: StoreName): Promise<T[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

// 상위 저장 API

export async function saveProject(project: Project): Promise<void> {
  await put('projects', toPlain(project))
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return get<Project>('projects', id)
}

export async function listProjects(): Promise<Project[]> {
  const all = await list<Project>('projects')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProject(id: string): Promise<void> {
  await del('projects', id)
}

/** 소재를 저장한다. */
export async function saveAsset(
  asset: Asset,
  blob: Blob,
  thumbBlob?: Blob
): Promise<void> {
  await put('assets', { ...toPlain(asset), blob })
  if (thumbBlob) {
    await put('thumbs', { id: asset.id, blob: thumbBlob })
  }
}

export async function loadAssetBlob(id: string): Promise<Blob | undefined> {
  const data = await get<{ blob: Blob }>('assets', id)
  return data?.blob
}

export async function loadAsset(id: string): Promise<Asset | undefined> {
  return get<Asset>('assets', id)
}

export async function loadThumbBlob(id: string): Promise<Blob | undefined> {
  const data = await get<{ blob: Blob }>('thumbs', id)
  return data?.blob
}

export async function saveThumb(id: string, blob: Blob): Promise<void> {
  await put('thumbs', { id, blob })
}

export async function deleteAsset(id: string): Promise<void> {
  await del('assets', id)
  await del('thumbs', id)
}

export async function listAssets(): Promise<Asset[]> {
  const all = await list<Asset>('assets')
  return all.filter((a) => !a.library).sort((a, b) => b.createdAt - a.createdAt)
}

export async function listLibraryAssets(): Promise<Asset[]> {
  const all = await list<Asset>('assets')
  return all.filter((a) => a.library).sort((a, b) => b.createdAt - a.createdAt)
}

// 웹 대본 라이브러리

interface ScriptRecord {
  id: string
  meta: ScriptDoc
  markdown: string
}

export async function listScripts(): Promise<ScriptDoc[]> {
  const rows = await list<ScriptRecord>('scripts')
  return rows
    .map((row) => row?.meta)
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export async function getScriptRecord(id: string): Promise<ScriptRecord | undefined> {
  return get<ScriptRecord>('scripts', id)
}

export async function putScriptRecord(meta: ScriptDoc, markdown: string): Promise<void> {
  await put('scripts', { id: meta.id, meta: toPlain(meta), markdown })
}

export async function putScriptText(id: string, markdown: string): Promise<void> {
  const existing = await get<ScriptRecord>('scripts', id)
  if (!existing) return
  await put('scripts', { ...existing, markdown })
}

export async function getScriptText(id: string): Promise<string> {
  const row = await get<ScriptRecord>('scripts', id)
  return row?.markdown ?? ''
}

export async function delScript(id: string): Promise<void> {
  await del('scripts', id)
}

/** 저장소 사용량을 추정한다. */
export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate()
    return {
      usage: e.usage ?? 0,
      quota: e.quota ?? 0
    }
  }
  return { usage: 0, quota: 0 }
}
