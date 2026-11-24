/** 剧本续写：保留已有分场，只往后加。 */
import { t } from '@/i18n'

function fenChangBlock(md: string): string {
  const m = md.match(/^##\s*(?:分场|장면 구성|Scene breakdown)\s*$/im)
  if (!m || m.index == null) return ''
  const from = m.index
  const rest = md.slice(from + m[0].length)
  const next = rest.search(/\n##\s+/)
  return next >= 0 ? md.slice(from, from + m[0].length + next) : md.slice(from)
}

/** 戏剧场次标题：章节「场景一｜…」或旧稿「第 N 场」。不含人物/环境设定节。 */
export function playSceneHeadings(md: string): string[] {
  const text = md || ''
  const chapter = [...text.matchAll(/^##[ \t]+((?:场景[一二三四五六七八九十百0-9]|(?:장면|Scene)[ \t]+\d+)[^\n]*)$/gim)].map((m) =>
    m[1].trim()
  )
  const numbered = [...fenChangBlock(text).matchAll(/^###\s+(.+)\s*$/gm)].map((m) => m[1].trim())
  const loose = [...text.matchAll(/^###[ \t]+((?:第\s*\d+\s*场|(?:장면|Scene)[ \t]+\d+)[^\n]*)$/gim)].map((m) => m[1].trim())
  return [...new Set([...chapter, ...numbered, ...loose])]
}

export function countAddedPlayScenes(before: string, after: string): number {
  const prev = new Set(playSceneHeadings(before))
  return playSceneHeadings(after).filter((h) => !prev.has(h)).length
}

/**
 * 把模型续写结果和原稿合成完整剧本。
 * 优先用「保留旧场 + 新增场」的完整稿；若模型只吐了新场，则接到原文后面。
 */
export function mergeContinuedPlay(original: string, generated: string): string {
  const orig = (original || '').trim()
  const gen = (generated || '').trim()
  if (!orig) return gen
  if (!gen) throw new Error(t('scriptContinuation.empty'))

  const origHeads = playSceneHeadings(orig)
  const genHeads = playSceneHeadings(gen)
  const kept = origHeads.filter((h) => genHeads.includes(h))
  const added = genHeads.filter((h) => !origHeads.includes(h))

  if (added.length > 0 && kept.length >= Math.max(1, origHeads.length - 1) && gen.length >= orig.length * 0.8) {
    return gen
  }

  if (added.length > 0 && kept.length === 0) {
    return `${orig.replace(/\s*$/, '')}\n\n${gen}\n`
  }

  if (!genHeads.length && gen.length > 40 && !gen.includes(orig.slice(0, 80))) {
    const n = origHeads.length + 1
    return `${orig.replace(/\s*$/, '')}\n\n## ${t('scriptContinuation.heading', { number: n })}\n\n${gen}\n`
  }

  if (gen.length > orig.length && (added.length > 0 || genHeads.length >= origHeads.length)) {
    return gen
  }

  throw new Error(t('scriptContinuation.noNewScenes'))
}
