import type { Shot } from '@/types'
import { effectiveShotAudioMode, isVideoVoiceMode } from '@/utils/shot'
import { withVideoReferenceBlock } from '@/utils/videoReferenceBlock'
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


export function ltxLipSyncPrompt(shot: Shot) {
  const spoken = spokenLines(shot.voiceover || '').map(({ words }) => words)
  const scene = oneLine(withoutSpeech(shot.visualPrompt, spoken))
  const compiled = withVideoReferenceBlock(shot.compiledVideoPrompt || '', [])
  const visualBody = compiled.match(/integrated_multimodal_description:\s*([\s\S]*?)(?=\n\s*overall_soundscape:|$)/i)?.[1] ?? compiled
  const motion = oneLine(withoutSpeech(visualBody, spoken)) || oneLine(withoutSpeech(shot.videoPrompt, spoken))
  const camera = {
    push: 'The camera slowly pushes in.',
    pull: 'The camera slowly pulls back.',
    pan: 'The camera pans smoothly.',
    tilt: 'The camera tilts smoothly.',
    static: 'The camera holds steady.',
    orbit: 'The camera moves smoothly around the subject.'
  }[shot.cameraMovement]
  // LTX Desktop v1.3.3의 A2V 예제처럼 전사 대신 화면의 동작과 표정을 묘사한다.
  return [scene, motion, camera,
    'Maintain the starting frame’s character appearance and lighting. Show natural eye movements and subtle expressions. Synchronize visible mouth movements to the supplied audio.']
    .filter(Boolean).join(' ')
}
