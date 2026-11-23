/** 대본 이어 쓰기는 기존 장면을 보존하고 새 장면을 추가한다. */

function sceneBreakdownBlock(md: string): string {
  const m = md.match(/^##[ \t]*(?:分场|장면 목록|장면 구성|Scenes|Scene breakdown)[ \t]*$/im)
  if (!m || m.index == null) return ''
  const from = m.index
  const rest = md.slice(from + m[0].length)
  const next = rest.search(/\n##\s+/)
  return next >= 0 ? md.slice(from, from + m[0].length + next) : md.slice(from)
}

/** 번호가 붙은 장면 제목을 찾는다. 인물과 배경 설정은 제외한다. */
export function playSceneHeadings(md: string): string[] {
  const text = md || ''
  const chapter = [...text.matchAll(/^##\s+((?:场景\s*[一二三四五六七八九十百0-9]|장면\s*\d+|scene\s+\d+)[^\n]*)\s*$/gim)].map((m) =>
    m[1].trim()
  )
  const numbered = [...sceneBreakdownBlock(text).matchAll(/^###[ \t]+([^\n]+)$/gm)].map((m) => m[1].trim())
  const loose = [...text.matchAll(/^###\s+((?:第\s*\d+\s*场|장면\s*\d+|scene\s+\d+)[^\n]*)\s*$/gim)].map((m) => m[1].trim())
  return [...new Set([...chapter, ...numbered, ...loose])]
}

export function countAddedPlayScenes(before: string, after: string): number {
  const prev = new Set(playSceneHeadings(before))
  return playSceneHeadings(after).filter((h) => !prev.has(h)).length
}

/**
 * 원본 대본에 이어 쓰기 결과를 반영한다.
 * 기존 장면을 보존한 전체 결과를 우선한다. 새 장면만 있으면 원본 뒤에 붙인다.
 */
export function mergeContinuedPlay(original: string, generated: string): string {
  const orig = (original || '').trim()
  const gen = (generated || '').trim()
  if (!orig) return gen
  if (!gen) throw new Error('이어 쓴 대본이 비어 있어요.')

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
    return `${orig.replace(/\s*$/, '')}\n\n## 장면 ${n} | 이어지는 이야기\n\n${gen}\n`
  }

  if (gen.length > orig.length && (added.length > 0 || genHeads.length >= origHeads.length)) {
    return gen
  }

  throw new Error('새 장면이 없어요. 「아버지가 귀가한 뒤의 이야기로 두 장면을 이어 써 주세요」처럼 원하는 전개를 적어 주세요.')
}
