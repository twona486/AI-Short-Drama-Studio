export function storyboardDurationInstruction(durations: number[]) {
  const max = durations.at(-1)
  return `The active video connection allows at most ${max} seconds per shot. Use only these shot durations in seconds: ${durations.join(', ')}. Split longer action, dialogue, and narration into consecutive shots before writing the JSON. Fit all original spoken words within each shot at a natural pace (about four non-space characters per second), preserving speaker, words, and order.`
}

function splitSpeech(text: string, limit: number): string[] {
  const chunks: string[] = []
  for (const line of text.split('\n').filter((line) => line.trim())) {
    const prefix = line.match(/^[^:：\n]{1,20}[:：]\s*/)?.[0] ?? ''
    let remaining = Array.from(line.slice(prefix.length).trim())
    while (remaining.length) {
      let count = 0
      let end = 0
      let boundary = 0
      while (end < remaining.length && count < limit) {
        const char = remaining[end++]
        if (!/\s/u.test(char)) count++
        if (/[\s.!?。！？,，]/u.test(char)) boundary = end
      }
      if (end < remaining.length && boundary >= end / 2) end = boundary
      chunks.push(prefix + remaining.slice(0, end).join('').trim())
      remaining = remaining.slice(end)
      while (remaining.length && /\s/u.test(remaining[0])) remaining.shift()
    }
  }
  return chunks
}

export function splitStoryboardDuration<T extends { title: string; duration: number; voiceover: string; videoPrompt?: string }>(
  shot: T,
  durations: number[]
): T[] {
  const max = durations.at(-1)!
  const speechSize = (text: string) => Array.from(text.replace(/^[^:：\n]{1,20}[:：]\s*/gm, '').replace(/\s/gu, '')).length
  const min = durations.find((seconds) => seconds >= 5) ?? durations[0]
  const wanted = Math.max(shot.duration, Math.ceil(speechSize(shot.voiceover) / 4))
  if (wanted <= max) {
    const duration = durations.find((seconds) => seconds >= Math.max(min, wanted)) ?? max
    return [{ ...shot, duration }]
  }
  const speech = speechSize(shot.voiceover) > max * 4
    ? splitSpeech(shot.voiceover, max * 4) : [shot.voiceover]
  const count = Math.max(speech.length, Math.ceil(wanted / max))
  return Array.from({ length: count }, (_, index) => {
    const voiceover = speech[index] ?? ''
    const wantedPart = Math.max(min, Math.ceil(wanted / count), Math.ceil(speechSize(voiceover) / 4))
    return {
      ...shot,
      title: `${shot.title} (${index + 1}/${count})`,
      duration: durations.find((seconds) => seconds >= wantedPart) ?? max,
      voiceover,
      videoPrompt: `${(shot.videoPrompt || '').replace(/<d(?:\s[^>]*)?>[\s\S]*?<\/d>/gi, '').trim()}\nShow only segment ${index + 1} of ${count} of this continuous action. Preserve continuity and use only the supplied dialogue for this segment.`
    }
  })
}
