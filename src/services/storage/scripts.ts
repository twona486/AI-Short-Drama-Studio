/**
 * 대본 라이브러리 저장소
 *
 * 데스크톱은 사용자가 선택한 디렉터리의 _scripts에 저장한다.
 *   index.json은 대본 메타데이터 목록이다.
 *   각 대본은 ID별 Markdown 파일로 저장한다.
 * 브라우저에서는 IndexedDB scripts 저장소에 본문을 직접 저장한다.
 */

import { toRaw } from 'vue'
import type { ScriptDoc } from '@/types'
import { desktop, isDesktop } from '@/services/desktop'
import * as idb from './idb'

const SCRIPTS_FOLDER = '_scripts'
const INDEX_FILE = 'index.json'

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

async function scriptsDir(): Promise<string> {
  const root = await desktop().getRoot()
  return desktop().join(root, SCRIPTS_FOLDER)
}

async function indexPath(dir: string) {
  return desktop().join(dir, INDEX_FILE)
}

async function ensureDir(dir: string) {
  await desktop().writeText(await desktop().join(dir, '.keep'), '')
}

export async function listScriptDocs(): Promise<ScriptDoc[]> {
  if (!isDesktop()) return idb.listScripts()
  const dir = await scriptsDir()
  const p = await indexPath(dir)
  if (!(await desktop().exists(p))) return []
  try {
    const parsed = JSON.parse(await desktop().readText(p))
    const list = Array.isArray(parsed) ? (parsed as ScriptDoc[]) : []
    return list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  } catch {
    return []
  }
}

/** 데스크톱의 메타데이터 목록을 쓴다. */
export async function saveScriptMeta(doc: ScriptDoc): Promise<void> {
  if (!isDesktop()) return
  const dir = await scriptsDir()
  await ensureDir(dir)
  const list = await listScriptDocs()
  const idx = list.findIndex((item) => item.id === doc.id)
  if (idx >= 0) list[idx] = doc
  else list.unshift(doc)
  await desktop().writeText(await indexPath(dir), JSON.stringify(toPlain(list), null, 2))
}

/** Markdown 본문을 쓰고 _scripts 기준 상대 경로를 반환한다. */
export async function saveScriptMarkdown(
  id: string,
  markdown: string
): Promise<string | undefined> {
  if (!isDesktop()) {
    await idb.putScriptText(id, markdown)
    return undefined
  }
  const dir = await scriptsDir()
  await ensureDir(dir)
  const rel = `${id}.md`
  const abs = await desktop().join(dir, rel)
  await desktop().writeText(abs, markdown)
  return rel
}

/** 메타데이터와 본문을 저장하고 저장된 대본을 반환한다. */
export async function saveScript(doc: ScriptDoc, markdown: string): Promise<ScriptDoc> {
  if (!isDesktop()) {
    await idb.putScriptRecord(doc, markdown)
    return { ...doc }
  }
  const rel = await saveScriptMarkdown(doc.id, markdown)
  const stored: ScriptDoc = { ...doc, fileRelPath: rel }
  await saveScriptMeta(stored)
  return stored
}

export async function loadScriptMarkdown(id: string): Promise<string> {
  if (!isDesktop()) return idb.getScriptText(id)
  const dir = await scriptsDir()
  const abs = await desktop().join(dir, `${id}.md`)
  if (!(await desktop().exists(abs))) return ''
  return desktop().readText(abs)
}

export async function deleteScriptDoc(id: string): Promise<void> {
  if (!isDesktop()) {
    await idb.delScript(id)
    return
  }
  const dir = await scriptsDir()
  await desktop().remove(await desktop().join(dir, `${id}.md`))
  const list = await listScriptDocs()
  await desktop().writeText(
    await indexPath(dir),
    JSON.stringify(
      toPlain(list.filter((item) => item.id !== id)),
      null,
      2
    )
  )
}

/** 파일 탐색기에서 열 대본의 절대 경로 */
export async function scriptAbsPath(id: string): Promise<string | undefined> {
  if (!isDesktop()) return undefined
  const dir = await scriptsDir()
  const abs = await desktop().join(dir, `${id}.md`)
  return (await desktop().exists(abs)) ? abs : undefined
}

export async function scriptsDirPath(): Promise<string | undefined> {
  if (!isDesktop()) return undefined
  return scriptsDir()
}
