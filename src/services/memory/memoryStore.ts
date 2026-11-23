/**
 * 에이전트의 로컬 기억 저장 시스템
 *
 * 두 가지 범위에서 기억을 관리한다.
 * global은 모든 프로젝트에서 사용자 선호, 습관 및 장기 정보를 공유한다.
 * project는 현재 프로젝트 ID에 연결한 약속이나 줄거리 메모를 저장한다.
 *
 * 저장 방식
 * 데스크톱은 저장소 루트의 app.db에 있는 SQLite KV 테이블을 사용한다.
 * 브라우저는 localStorage를 사용한다.
 *
 * UI와 에이전트는 동일한 비동기 읽기 및 쓰기 API를 사용한다.
 */
import { desktop, isDesktop } from '@/services/desktop'
import { useProjectStore } from '@/stores'

export type MemoryKind = 'preference' | 'fact' | 'note'
export type MemoryScope = 'global' | 'project'

export interface AgentMemoryEntry {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  content: string
  pinned?: boolean
  createdAt: number
  updatedAt: number
}

const GLOBAL_KEY = 'agent-memory:v1:global'
const PROJECT_KEY_PREFIX = 'agent-memory:v1:project:'
const MAX_PER_KEY = 60
const MAX_CONTENT_LEN = 240
/** 모델에 제공하는 범위별 최대 기억 수 */
const PROMPT_LIMIT_PER_SCOPE = 20

function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function projectKey(projectId: string) {
  return `${PROJECT_KEY_PREFIX}${projectId}`
}

function currentProjectId(): string | null {
  return useProjectStore().current?.id ?? null
}

async function kvRead(key: string): Promise<string | null> {
  try {
    if (isDesktop()) return await desktop().kvGet(key)
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

async function kvWrite(key: string, value: string): Promise<void> {
  try {
    if (isDesktop()) {
      await desktop().kvSet(key, value)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    /* 저장 오류가 발생해도 대화를 계속한다. */
  }
}

async function readEntries(key: string): Promise<AgentMemoryEntry[]> {
  const raw = await kvRead(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is AgentMemoryEntry =>
        item && typeof item.content === 'string' && typeof item.id === 'string'
    )
  } catch {
    return []
  }
}

async function writeEntries(key: string, entries: AgentMemoryEntry[]): Promise<void> {
  await kvWrite(key, JSON.stringify(entries.slice(-MAX_PER_KEY)))
}

function keyForScope(scope: MemoryScope, projectId: string | null): string | null {
  if (scope === 'global') return GLOBAL_KEY
  return projectId ? projectKey(projectId) : null
}

/** 범위가 없으면 전역과 현재 프로젝트의 기억을 합친다. 고정 항목과 최신 항목이 먼저 온다. */
export async function listMemories(scope?: MemoryScope): Promise<AgentMemoryEntry[]> {
  const pid = currentProjectId()
  const scopes: MemoryScope[] = scope ? [scope] : ['global', 'project']
  const all: AgentMemoryEntry[] = []
  for (const s of scopes) {
    const key = keyForScope(s, pid)
    if (!key) continue
    all.push(...(await readEntries(key)))
  }
  return all.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt)
}

function normalize(text: string) {
  return text.replace(/\s+/g, '').toLowerCase()
}

export async function rememberMemory(
  content: string,
  opts: { kind?: MemoryKind; scope?: MemoryScope; pinned?: boolean } = {}
): Promise<AgentMemoryEntry | null> {
  const text = content.trim().slice(0, MAX_CONTENT_LEN)
  if (!text) return null
  const scope = opts.scope ?? 'global'
  const key = keyForScope(scope, currentProjectId())
  if (!key) return null
  const entries = await readEntries(key)
  const dup = entries.find((item) => normalize(item.content) === normalize(text))
  if (dup) {
    dup.updatedAt = Date.now()
    if (opts.kind) dup.kind = opts.kind
    if (opts.pinned !== undefined) dup.pinned = opts.pinned
    await writeEntries(key, entries)
    return dup
  }
  const entry: AgentMemoryEntry = {
    id: newId(),
    scope,
    kind: opts.kind ?? 'fact',
    content: text,
    pinned: opts.pinned,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  entries.push(entry)
  await writeEntries(key, entries)
  return entry
}

/** ID로 정확히 일치하거나 키워드가 처음으로 일치하는 기억을 삭제하고 반환한다. */
export async function forgetMemory(idOrKeyword: string, scope?: MemoryScope): Promise<string | null> {
  const pid = currentProjectId()
  const scopes: MemoryScope[] = scope ? [scope] : ['global', 'project']
  const needle = normalize(idOrKeyword)
  for (const s of scopes) {
    const key = keyForScope(s, pid)
    if (!key) continue
    const entries = await readEntries(key)
    const idx = entries.findIndex(
      (item) => item.id === idOrKeyword || normalize(item.content).includes(needle)
    )
    if (idx >= 0) {
      const [removed] = entries.splice(idx, 1)
      await writeEntries(key, entries)
      return removed.content
    }
  }
  return null
}

export async function clearMemories(scope: MemoryScope): Promise<void> {
  const key = keyForScope(scope, currentProjectId())
  if (key) await writeEntries(key, [])
}

export async function togglePinMemory(id: string): Promise<void> {
  const pid = currentProjectId()
  for (const s of ['global', 'project'] as MemoryScope[]) {
    const key = keyForScope(s, pid)
    if (!key) continue
    const entries = await readEntries(key)
    const hit = entries.find((item) => item.id === id)
    if (hit) {
      hit.pinned = !hit.pinned
      hit.updatedAt = Date.now()
      await writeEntries(key, entries)
      return
    }
  }
}

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'Preference',
  fact: 'Fact',
  note: 'Note'
}

/** 기억을 모델 컨텍스트에 넣을 텍스트로 만든다. 없으면 빈 문자열을 반환한다. */
export async function memoryContextPrompt(): Promise<string> {
  const entries = await listMemories()
  if (!entries.length) return ''
  const global = entries.filter((e) => e.scope === 'global').slice(0, PROMPT_LIMIT_PER_SCOPE)
  const proj = entries.filter((e) => e.scope === 'project').slice(0, PROMPT_LIMIT_PER_SCOPE)
  const fmt = (list: AgentMemoryEntry[]) =>
    list.map((e) => `- [${KIND_LABEL[e.kind]}] ${e.content}`).join('\n')
  const parts: string[] = []
  if (global.length) parts.push(`【Long-term user memory】\n${fmt(global)}`)
  if (proj.length) parts.push(`【Project memory】\n${fmt(proj)}`)
  return parts.join('\n\n')
}

/**
 * 사용자가 명시적으로 기억해 달라고 한 요청을 해석한다.
 * 기억할 본문과 추정 유형을 반환하거나 기억 요청이 아니면 null을 반환한다.
 */
export function parseRememberRequest(
  text: string
): { content: string; kind: MemoryKind; scope: MemoryScope } | null {
  const t = text.trim()
  let m = t.match(/^(?:帮我|请|你)?记(?:住|一下|下来)[：:，,]?\s*(.+)$/)
  if (!m) m = t.match(/^(?:以后|今后)(?:都|要)?(.+)$/)
  if (!m) m = t.match(/^(.+?)\s*기억해\s*(?:줘|주세요)[.!。！]*$/)
  if (!m) m = t.match(/^기억해\s*(?:줘|주세요)\s*[:：,，]?\s*(.+)$/)
  if (!m) return null
  let content = m[1].trim().replace(/[。！!]+$/, '')
  if (content.length < 2) return null
  let scope: MemoryScope = 'global'
  if (/^(?:在|对)?(?:这个|本|当前)项目[里中内]?[，,：:]/.test(content)) {
    scope = 'project'
    content = content.replace(/^(?:在|对)?(?:这个|本|当前)项目[里中内]?[，,：:]?\s*/, '')
  }
  const projectPrefix = /^(?:이|현재)\s*프로젝트(?:에서|에)\s+/
  if (projectPrefix.test(content)) {
    scope = 'project'
    content = content.replace(projectPrefix, '')
    if (content.length < 2) return null
  }
  const kind: MemoryKind = /喜欢|偏好|习惯|不要|别|总是|一律|默认|선호|좋아|기본/.test(content)
    ? 'preference'
    : 'fact'
  return { content, kind, scope }
}

/** 명시적인 기억 삭제 요청에서 대상 키워드를 반환한다. */
export function parseForgetRequest(text: string): string | null {
  const m = text
    .trim()
    .match(/^(?:帮我|请)?(?:忘掉|忘记|别记(?:住|了)|删除(?:这条|那条)?记忆)[：:，,]?\s*(.*)$/)
  if (!m) return null
  return m[1].trim().replace(/[。！!]+$/, '')
}
