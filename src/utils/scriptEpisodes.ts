/**
 * 대본 Markdown과 회차 목록을 양방향으로 변환한다.
 *
 * 제목 구조는 다음과 같다.
 * - # 제목은 전체 대본의 제목이다. 최대 하나를 사용한다.
 * - ## 제목마다 새 회차가 시작된다. 다음 2단계 제목 직전까지 앞 회차에 포함한다.
 * - 첫 번째 2단계 제목 앞의 내용은 회차에 속하지 않는 머리말로 보존한다.
 */

import { t as translate } from '@/i18n'
import type { ScriptEpisode } from '@/types'

export interface ParsedScriptDoc {
  title: string
  preamble: string
  episodes: Array<{ title: string; content: string }>
}

export function normalizeScriptText(md: string): string {
  return (md || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

export function countWords(text: string): number {
  return (text || '').replace(/\s/g, '').length
}

/** 본문을 대본 제목, 머리말, 회차별 제목과 본문으로 분리한다. */
export function parseScriptDoc(md: string): ParsedScriptDoc {
  const lines = normalizeScriptText(md).split('\n')
  let title = ''
  const preambleLines: string[] = []
  const episodes: Array<{ title: string; content: string[] }> = []
  let current: { title: string; content: string[] } | null = null
  let sawTitle = false

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/)
    if (h1 && !sawTitle) {
      title = h1[1].trim()
      sawTitle = true
      continue
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      if (current) episodes.push(current)
      current = { title: h2[1].trim(), content: [] }
      continue
    }
    if (current) current.content.push(line)
    else preambleLines.push(line)
  }
  if (current) episodes.push(current)

  const preamble = preambleLines.join('\n').trim()
  const cleaned = episodes.map((ep) => ({
    title: ep.title,
    content: ep.content.join('\n').trim()
  }))

  // 2단계 제목이 없으면 전체를 첫 회차로 처리한다.
  if (!cleaned.length) {
    return {
      title,
      preamble: '',
      episodes: [{ title: translate('scripts.defaultEpisodeTitle', { p0: 1 }), content: preamble }]
    }
  }
  return { title, preamble, episodes: cleaned }
}

export function serializeScriptDoc(parsed: ParsedScriptDoc): string {
  const chunks: string[] = []
  if (parsed.title.trim()) chunks.push(`# ${parsed.title.trim()}\n`)
  if (parsed.preamble.trim()) chunks.push(`${parsed.preamble.trim()}\n`)
  for (const ep of parsed.episodes) {
    chunks.push(`## ${ep.title.trim() || translate('scripts.untitledEpisode')}\n`)
    const body = (ep.content || '').trim()
    if (body) chunks.push(`${body}\n`)
  }
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** 화면에 표시할 ID와 글자 수를 회차에 붙인다. */
export function toEpisodes(parsed: ParsedScriptDoc, docId: string): ScriptEpisode[] {
  return parsed.episodes.map((ep, index) => ({
    id: `${docId}#${index}`,
    index,
    title: ep.title,
    content: ep.content,
    wordCount: countWords(ep.content)
  }))
}

/** 다음 회차의 기본 제목을 만든다. */
export function nextEpisodeTitle(parsed: ParsedScriptDoc): string {
  const n = parsed.episodes.length + 1
  return translate('scripts.defaultEpisodeTitle', { p0: n })
}

export const NEW_EPISODE_BODY = `장면 1 · 장소 · 밤 · 밖
(이번 장면 0자 · 약 0초 · 0샷)

등장　인물　소품　환경음
`

/** 회차를 추가한 Markdown과 새 회차의 인덱스를 반환한다. */
export function appendEpisode(md: string, title?: string): { markdown: string; index: number } {
  const parsed = parseScriptDoc(md)
  parsed.episodes.push({
    title: title?.trim() || nextEpisodeTitle(parsed),
    content: translate('scripts.newEpisodeBody')
  })
  return { markdown: serializeScriptDoc(parsed), index: parsed.episodes.length - 1 }
}

/** 지정한 위치에 새 회차를 삽입한다. */
export function insertEpisode(
  md: string,
  at: number,
  title?: string
): { markdown: string; index: number } {
  const parsed = parseScriptDoc(md)
  const pos = Math.max(0, Math.min(parsed.episodes.length, at))
  parsed.episodes.splice(pos, 0, {
    title: title?.trim() || translate('scripts.defaultEpisodeTitle', { p0: pos + 1 }),
    content: translate('scripts.newEpisodeBody')
  })
  return { markdown: serializeScriptDoc(parsed), index: pos }
}

/** 최소 한 회차를 남기고 지정한 회차를 삭제한다. */
export function removeEpisode(md: string, index: number): { markdown: string; removed: boolean } {
  const parsed = parseScriptDoc(md)
  if (parsed.episodes.length <= 1) return { markdown: md, removed: false }
  if (index < 0 || index >= parsed.episodes.length) return { markdown: md, removed: false }
  parsed.episodes.splice(index, 1)
  return { markdown: serializeScriptDoc(parsed), removed: true }
}

/** 회차의 제목이나 본문을 수정한다. */
export function updateEpisode(
  md: string,
  index: number,
  patch: { title?: string; content?: string }
): string {
  const parsed = parseScriptDoc(md)
  const ep = parsed.episodes[index]
  if (!ep) return md
  if (patch.title !== undefined) ep.title = patch.title.trim() || ep.title
  if (patch.content !== undefined) ep.content = patch.content
  return serializeScriptDoc(parsed)
}

/** 회차를 위나 아래로 이동한다. */
export function moveEpisode(md: string, from: number, to: number): string {
  const parsed = parseScriptDoc(md)
  if (from === to) return md
  if (from < 0 || from >= parsed.episodes.length) return md
  const target = Math.max(0, Math.min(parsed.episodes.length - 1, to))
  const [item] = parsed.episodes.splice(from, 1)
  parsed.episodes.splice(target, 0, item)
  return serializeScriptDoc(parsed)
}

/** 각 회차를 유효한 파일명의 Markdown으로 내보낸다. */
export function episodeMarkdown(title: string, content: string): string {
  const heading = title.trim() || translate('scripts.untitledEpisode')
  const body = (content || '').trim()
  return `# ${heading}\n\n${body}\n`
}
