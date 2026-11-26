import type { Shot, Subject } from '@/types'
import { effectiveShotAudioMode, isVideoVoiceMode } from '@/utils/shot'
import { spokenTextOnly } from './dialogue'

const SPEECH_DIRECTION = /\b(?:says?|speaks?|speaking|spoken|talks?|talking|asks?|replies|whispers?|shouts?|utters?|dialogue|narrat\w*|voice[- ]?over|lip[- ]?sync)\b|말한다|말해요|말하며|대사|내레이션/i

function oneLine(text?: string) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

function spokenLines(text: string) {
  return text.split(/\r?\n/).flatMap((line) => {
    const labeled = line.trim().match(/^([^:：\n]{1,20})[:：]\s*(.+)$/)
    const words = (labeled?.[2] ?? line).trim().replace(/^["“「『](.*)["”」』]$/u, '$1')
    return spokenTextOnly(words) ? [{ speaker: labeled?.[1].trim(), words }] : []
  })
}

function withoutSpeech(text: string | undefined, spoken: string[]) {
  let cleaned = (text || '').replace(/<d(?:\s[^>]*)?>[\s\S]*?<\/d\s*>/gi, '')
  for (const words of spoken) cleaned = cleaned.replaceAll(words, '')
  return cleaned
    .split(/\r?\n|(?<=[.!?。！？])\s+(?=[A-Z가-힣])/u)
    .filter((sentence) => !SPEECH_DIRECTION.test(sentence))
    .join(' ')
}

export function ltxShotSpeechTooFast(shot: Shot | undefined, seconds: number) {
  if (!shot || seconds <= 0 || !isVideoVoiceMode(effectiveShotAudioMode(shot))) return false
  const syllables = spokenLines(shot.voiceover || '').reduce((count, line) =>
    count + (line.words.match(/[\p{L}\p{N}]/gu)?.length || 0), 0)
  return syllables > seconds * 5
}

export function ltxShotPrompt(shot: Shot, speakerVoice?: string) {
  const mode = effectiveShotAudioMode(shot)
  const lines = spokenLines(shot.voiceover || '')
  const spoken = lines.map(({ words }) => words)
  const motion = oneLine(withoutSpeech(shot.compiledVideoPrompt, spoken)) ||
    oneLine(withoutSpeech(shot.videoPrompt, spoken)) || oneLine(withoutSpeech(shot.visualPrompt, spoken)) ||
    'Animate the starting frame with natural motion and preserve the framing, lighting, and character appearance.'
  const environmentalSound = oneLine(withoutSpeech(shot.audioDescription, spoken))
  const ambience = environmentalSound
    ? `Environmental sound: ${environmentalSound}`
    : 'Use natural environmental sound.'
  if (!isVideoVoiceMode(mode) || !lines.length) {
    return `${motion} ${ambience} Keep mouths at rest, with no speaking or lip-sync. Use no speech, ambient sound only.`
  }
  const delivery = oneLine(speakerVoice || shot.speakerHint) || 'Use a natural, clear conversational tone.'
  const dialogue = lines.map(({ speaker, words }) => {
    const language = /[가-힣]/u.test(words) ? ' in Korean' : ' in the original language'
    if (mode === 'h3-voiceover') return `An off-screen narrator says${language}: "${words}".`
    return `${speaker || 'The character'} says${language}: "${words}".`
  }).join(' ')
  const mouth = mode === 'h3-voiceover' ? 'The visible characters keep their mouths at rest.'
    : 'Synchronize only the speaking character’s mouth to each line.'
  return `${motion} ${dialogue} ${mouth} Voice direction: ${delivery} ${ambience} Keep any background music subtle and below the dialogue.`
}


export function ltxLipSyncSpeaker(subject?: Subject, name?: string) {
  const appearance = oneLine(subject?.description).split(/[.!?。！？](?:\s|$)|[;；]/u)
    .map((detail) => detail.trim())
    .filter((detail) => detail && !/(?:\b(?:beat|silent|silence|speech|speaks?|speaking|dialogue|mouth|lips?|talks?|talking|quiet|mute|still|motionless|camera|shot)\b|침묵|말없이|입을|대사|카메라|샷)/i.test(detail))
    .join(', ').trim().slice(0, 160)
  const identity = oneLine(subject?.name ?? name).replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 32)
  return identity ? `The speaker named ${identity}${appearance ? ` (${appearance})` : ''}` : 'The featured speaker'
}

export function ltxLipSyncPrompt(speaker: string, focusedFrame: boolean) {
  // A2V uses the input audio for timing and the first frame for appearance.
  const target = focusedFrame ? `${speaker}, centered in a medium close-up,` : speaker
  return `${target} looks toward the camera and speaks naturally with clear, visible mouth movements that follow the supplied audio. Keep the camera steady in a single continuous take and preserve the opening lighting and appearance.`
}

export function ltxLipSyncFramePrompt(speaker: string, scene?: string) {
  const location = oneLine(scene).slice(0, 100)
  return [`A single cinematic medium close-up of one person. ${speaker} is centered, facing the camera at eye level, framed from chest to head. The face is large, sharp and evenly lit, with the entire mouth visible.`,
    location && `Set the portrait in ${location}, with the background softly out of focus.`,
    'Preserve the character’s appearance and wardrobe from the character reference. Keep other people outside the frame.']
    .filter(Boolean).join(' ')
}
