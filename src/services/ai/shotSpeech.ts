import type { Project, Shot } from '@/types'
import { OPENAI_TTS_VOICES, recommendOpenAiVoice } from './openAiTts'

function bareSpeakerName(label: string): string {
  return label.replace(/[（(][^）)]*[）)]$/, '').trim()
}

export function shotSpeakerSubject(shot: Shot, project: Project) {
  const prefix = shot.voiceover?.match(/^([^：:\n]{1,32})[：:]/)?.[1]
  const speaker = prefix && bareSpeakerName(prefix)
  const subjects = project.subjects ?? []
  if (!speaker) return undefined
  return subjects.find((subject) => subject.name.trim() === speaker)
    ?? subjects.find((subject) => {
      const name = subject.name.trim()
      return name && (speaker.includes(name) || name.includes(speaker))
    })
}

export function openAiShotSpeech(shot: Shot, project: Project, matchShotDuration = true) {
  const speaker = shotSpeakerSubject(shot, project)
  const text = (shot.voiceover || '').replace(/^([^：:\n]{1,32})[：:][ \t]*/gm, (prefix, label: string) => {
    const name = bareSpeakerName(label)
    return /^(?:내레이션|해설|대사|화면 밖 음성|narrator|voiceover)$/i.test(name) ||
      project.subjects?.some((subject) => subject.name.trim() === name) ? '' : prefix
  })
  const tag = speaker?.voicePrompt?.trim() || shot.speakerVoice?.trim()
  const configured = speaker?.openAiTtsVoice
  return {
    text,
    voice: configured && OPENAI_TTS_VOICES.includes(configured)
      ? configured
      : recommendOpenAiVoice(speaker ? speaker.voicePrompt : tag) || project.settings.ttsVoice,
    instruction: [
      tag,
      shot.ttsInstruction?.trim(),
      matchShotDuration && `Aim for ${shot.duration} seconds while keeping the entire line and a natural pace.`
    ].filter(Boolean).join('\n')
  }
}


export function openAiLipSyncLines(shot: Shot, project: Project) {
  const turns: Array<{ label?: string; name?: string; text: string }> = []
  for (const line of shot.voiceover.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    const prefix = line.match(/^([^：:\n]{1,32})([：:])([ \t]*)(.*)$/)
    const label = prefix?.[1]
    const name = label && bareSpeakerName(label)
    const known = name && (/^(?:내레이션|해설|대사|화면 밖 음성|narrator|voiceover)$/i.test(name) ||
      shotSpeakerSubject({ ...shot, voiceover: line }, project))
    const explicitSpeaker = known || (name && prefix?.[3] && /^[\p{L}][\p{L} .'-]*$/u.test(name))
    const previous = turns.at(-1)
    if (!previous || (explicitSpeaker && name !== previous.name)) {
      turns.push(explicitSpeaker ? { label, name, text: prefix![4] } : { text: line })
    } else {
      previous.text += '\n' + (explicitSpeaker ? prefix![4] : line)
    }
  }
  return turns.filter(({ text }) => text.trim()).map(({ label, text }) => {
    const voiceover = label ? `${label}: ${text}` : text
    const speech = openAiShotSpeech({ ...shot, voiceover, speakerVoice: turns.length === 1 ? shot.speakerVoice : undefined }, project, false)
    return { ...speech, text: text.trim() }
  })
}
