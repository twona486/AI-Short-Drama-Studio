import type { Project, Shot, Subject } from '@/types'
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

function shotSpeechText(shot: Shot, project: Project) {
  return (shot.voiceover || '').replace(/^([^：:\n]{1,32})[：:][ \t]*/gm, (prefix, label: string) => {
    const name = bareSpeakerName(label)
    return /^(?:내레이션|해설|대사|화면 밖 음성|narrator|voiceover)$/i.test(name) ||
      project.subjects?.some((subject) => subject.name.trim() === name) ? '' : prefix
  })
}

export function elevenLabsShotSpeech(shot: Shot, project: Project, subject?: Subject) {
  const speaker = subject ?? shotSpeakerSubject(shot, project) ??
    (shot.subjectIds?.length === 1 ? project.subjects?.find(({ id }) => id === shot.subjectIds?.[0]) : undefined)
  const clean = (value: Shot) => shotSpeechText(value, project).replace(
    /^[ \t]*([^：:\n]{1,32})[：:][ \t]+/gm, (prefix, label: string) =>
      /^[\p{L}][\p{L} .’-]*$/u.test(bareSpeakerName(label)) ? '' : prefix
  ).trim()
  const sameSpeaker = (adjacent: Shot) => speaker && (
    shotSpeakerSubject(adjacent, project)?.id === speaker.id ||
    (!/^[^：:\n]{1,32}[：:]/.test(adjacent.voiceover) && adjacent.subjectIds?.length === 1 && adjacent.subjectIds[0] === speaker.id)
  )
  const index = project.shots.findIndex(({ id }) => id === shot.id)
  const sameScene = (adjacent?: Shot) => adjacent && (!shot.sceneId || !adjacent.sceneId || adjacent.sceneId === shot.sceneId)
    ? adjacent : undefined
  const before = index > 0 ? sameScene(project.shots[index - 1]) : undefined
  const after = index >= 0 ? sameScene(project.shots[index + 1]) : undefined
  const scene = project.scenes?.find(({ id }) => id === shot.sceneId)
  return {
    text: clean(shot),
    voice: speaker?.elevenLabsVoiceId,
    speakerId: speaker?.id,
    instruction: shot.ttsInstruction,
    delivery: {
      voiceDescription: speaker?.voicePrompt?.trim() || shot.speakerVoice,
      scene: [scene?.name, scene?.description, shot.visualPrompt].filter(Boolean).join('\n'),
      previousDialogue: before?.voiceover,
      nextDialogue: after?.voiceover,
      previousText: before && sameSpeaker(before) ? clean(before) : undefined,
      nextText: after && sameSpeaker(after) ? clean(after) : undefined
    }
  }
}

export function openAiShotSpeech(shot: Shot, project: Project, matchShotDuration = true) {
  const speaker = shotSpeakerSubject(shot, project)
  const text = shotSpeechText(shot, project)
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
  const knownNames = (project.subjects ?? []).map(({ name }) => name.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const inlineLabel = knownNames.length
    ? new RegExp(`[ \t]+(?=(?:${knownNames.join('|')})(?:[（(][^）)\n]*[）)])?[ \t]*[:：])`, 'g')
    : undefined
  const dialogue = inlineLabel ? shot.voiceover.replace(inlineLabel, '\n') : shot.voiceover
  for (const line of dialogue.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
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
    const speaker = label ? shotSpeakerSubject({ ...shot, voiceover }, project) : undefined
    return { ...speech, text: text.trim(), speaker, speakerName: speaker?.name ?? (label && bareSpeakerName(label)) }
  })
}
