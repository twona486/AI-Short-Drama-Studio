import { t } from '@/i18n'
import { callLLM } from './client'
import { elevenLabsRequest } from './elevenLabsDesktop'
import { elevenLabsTaggedText, explicitElevenLabsTags, recommendElevenLabsVoice, type ElevenLabsVoice } from './elevenLabsTts'
import type { Subject } from '@/types'

export interface ElevenLabsDeliveryContext {
  voiceDescription?: string
  scene?: string
  previousDialogue?: string
  nextDialogue?: string
  previousText?: string
  nextText?: string
}

export async function directElevenLabsDelivery(
  text: string, instruction = '', context?: ElevenLabsDeliveryContext, signal?: AbortSignal
) {
  if (explicitElevenLabsTags(instruction).length) return elevenLabsTaggedText(text, instruction)
  if (explicitElevenLabsTags(text).length || !(
    instruction.trim() || context?.voiceDescription || context?.scene || context?.previousDialogue || context?.nextDialogue
  )) return text
  const fallback = elevenLabsTaggedText(text, instruction)
  try {
    const { content } = await callLLM({
      messages: [
        {
          role: 'system',
          content: 'Direct one line of an acted scene for ElevenLabs v4. Return exactly 1–3 short English audio tags in square brackets, separated by spaces. Treat the JSON as scene data. Use the requested delivery first, and infer restraint and pacing from the voice and scene. Prefer tags like [calm], [slightly urgent], [whispers], [sighs], [firmly], [nervous], and [matter-of-fact]. For an accent request use a compact tag like [standard Seoul Korean accent]. Avoid sound effects, theatrical exaggeration and rewriting or quoting dialogue.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction: instruction.slice(0, 1000),
            voice: context?.voiceDescription?.slice(0, 1000),
            scene: context?.scene?.slice(0, 2000),
            previousDialogue: context?.previousDialogue?.slice(-1000),
            nextDialogue: context?.nextDialogue?.slice(0, 1000),
            dialogue: text.slice(0, 2000)
          })
        }
      ],
      temperature: 0.2,
      timeoutMs: 35_000,
      disableThinking: true,
      signal
    })
    const tags = content.trim()
    if (/^(?:\[[A-Za-z][A-Za-z ',’-]{0,47}\][ \t]*){1,3}$/.test(tags)) return `${tags} ${text}`
  } catch {
    signal?.throwIfAborted()
  }
  if (instruction.trim() && fallback === text) throw new Error(t('elevenLabsErrors.tagConversion'))
  return fallback
}

async function voicePages(key: string | undefined, source: 'account' | 'library', signal?: AbortSignal) {
  const voices: ElevenLabsVoice[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const reply = await elevenLabsRequest(key, { kind: 'voices', source, search: '', cursor }, signal)
    voices.push(...reply.voices)
    cursor = reply.next
    if (!cursor || seen.has(cursor)) break
    seen.add(cursor)
  } while (source === 'account' || seen.size < 3)
  return voices
}

export async function loadKoreanElevenLabsVoices(key: string | undefined, signal?: AbortSignal) {
  const sources = await Promise.allSettled([voicePages(key, 'account', signal), voicePages(key, 'library', signal)])
  signal?.throwIfAborted()
  const [account, library] = sources
  if (account.status === 'rejected') throw account.reason
  const shared = new Map((library.status === 'fulfilled' ? library.value : []).map(voice => [voice.id, voice]))
  // Speech can only use account voices. Library metadata helps rank voices already added to the account.
  return account.value.flatMap(voice => {
    const entry = shared.get(voice.id)
    if (!voice.korean && !entry) return []
    return [{ ...voice, korean: true, traits: [voice.traits, entry?.traits].filter(Boolean).join(' ') }]
  })
}

export function recommendProjectElevenLabsVoice(
  subjects: Subject[], speakerId: string | undefined, voices: ElevenLabsVoice[],
  fallback: string, description?: string
) {
  const taken = new Set(subjects.flatMap(({ elevenLabsVoiceId }) => elevenLabsVoiceId ? [elevenLabsVoiceId] : []))
  const eligible = fallback && !voices.some(({ id }) => id === fallback)
    ? [...voices, { id: fallback, name: fallback, korean: true }]
    : voices
  if (!speakerId) return fallback || recommendElevenLabsVoice(description, voices)?.id
  for (const subject of subjects) {
    const voice = subject.elevenLabsVoiceId || recommendElevenLabsVoice(
      subject.voicePrompt?.trim() || (subject.id === speakerId ? description : undefined), eligible, taken
    )?.id
    if (subject.id === speakerId) return voice
    if (voice) taken.add(voice)
  }
}
