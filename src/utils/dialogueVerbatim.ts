/** 명시된 인물 표지만 읽는다. 지원하지 않는 대본 형식에서는 화자를 추측하지 않는다. */
function cues(text: string, names: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const lines = text.replace(/\*\*/g, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^([^：:\n]{1,24})[：:]\s*(.*)$/)
    if (!match || !names.includes(match[1].trim())) continue
    let body = match[2].trim()
    if (!body) {
      let next = i + 1
      while (next < lines.length && !lines[next].trim()) next++
      if (next < lines.length && /^[「“『]/.test(lines[next].trim())) body = lines[next].trim()
    }
    body = body.replace(/^[（(][^）)]*[）)]\s*/, '').replace(/[\s「」“”『』]/g, '')
    if (body) result.set(match[1].trim(), (result.get(match[1].trim()) || '') + body)
  }
  return result
}

export function dialogueVerbatimIssues(source: string, shots: Array<{ voiceover?: string }>, names: string[]): string[] {
  const original = cues(source, names)
  const assigned = cues(shots.map((shot) => shot.voiceover || '').join('\n'), names)
  const issues: string[] = []
  for (const [name, words] of original) {
    if (assigned.get(name) !== words) issues.push(`필수 수정 · ${name}의 대사가 대본과 달라요. 원문과 순서를 복원하고 화자를 유지하세요. 길이가 부족하면 샷을 나눠 주세요.`)
  }
  return issues
}
