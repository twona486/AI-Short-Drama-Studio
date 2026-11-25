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

export function openAiShotSpeech(shot: Shot, project: Project) {
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
      `Aim for ${shot.duration} seconds while keeping the entire line and a natural pace.`
    ].filter(Boolean).join('\n')
  }
}
