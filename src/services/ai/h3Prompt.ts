/** MiniMax H3 프롬프트의 기본 형식은 integrated_multimodal_description과 내부 샷 표식이다. 대사는 d 태그에만 넣는다. */

import type { AspectRatio, Shot } from '@/types'
import { englishOrOmit, h3NameMap, h3UniqueName } from '@/utils/h3Names'
import { normalizeCameraMovement, stripFrameLead, type VideoPromptStyle } from '@/utils/shotPrompt'
import {
  isPlaceholderSpokenLine,
  looksLikeShotDirection,
  spokenTextOnly,
  stripSpokenStageDirection
} from './dialogue'
import { normalizeForSpeech } from './tts'
import { callLLM, getAIMode } from './client'
import { importedDirectorForH3 } from '@/services/settings/directorSkill'
import { parseJsonRobust, stripReasoningLeak } from '@/utils/jsonRepair'

export interface H3ImageSlot {
  index: number
  kind: 'character' | 'scene' | 'prop' | 'board' | 'extra'
  name: string
  sourceName?: string
  job: string
}

export interface H3PromptInput {
  /** 노드의 연출 내용 또는 사용자가 작성한 공식 형식 전문 */
  prompt: string
  aesthetic?: string
  audioDescription?: string
  voiceover?: string
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  speakerHint?: string
  /**
   * 캐릭터 노드의 voicePrompt에 저장된 화자 음색
   * 대사의 원문과 음색 설명을 구분하고 음색은 화자 뒤에 배치한다.
   */
  speakerVoice?: string
  /**
   * 이 샷에 등장하는 캐릭터의 voicePrompt
   * 프롬프트 시작 부분에서 참조 이미지와 캐릭터를 연결한 직후에 넣는다.
   */
  voiceRoster?: string
  speakerName?: string
  /** 실제로 화면에 등장하는 인물은 화면 밖 내레이션 중에 입을 다문다. */
  onScreenNames?: string[]
  sceneName?: string
  sceneDescription?: string
  sceneLighting?: string
  sceneAnchor?: string
  shotTitle?: string
  imageAssignments?: string[]
  /** 제출 순서에 따른 이미지 슬롯. 캐릭터, 장면, 스토리 개요판을 구분한다. */
  imageSlots?: H3ImageSlot[]
  duration: number
  width?: number
  height?: number
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  shotSize?: string
  blocking?: string
  eyeline?: string
  continuity?: string
  purpose?: string
  mode?: 'I2VA' | 'T2VA' | 'R2VA' | 'FL2VA' | 'L2VA'
  promptStyle?: VideoPromptStyle
  /** true이면 세 구역으로 줄이고 공식 여섯 구역과 프레임 정렬 문구를 추가하지 않는다. */
  forceIntegrated?: boolean
  signal?: AbortSignal
}

type LabeledSlot = {
  kind: 'character' | 'scene' | 'prop' | 'board' | 'extra'
  picture: number
  subject?: number
  name: string
  sourceName?: string
}

/** 카메라 움직임의 유형, 이동 폭, 속도를 동작 문장에 넣는다. */
const CAMERA_EN: Record<NonNullable<Shot['cameraMovement']>, string> = {
  push: 'The camera pushes in with small amplitude at slow speed',
  pull: 'The camera pulls out with small amplitude at slow speed',
  pan: 'The camera pans right with small amplitude at slow speed',
  tilt: 'The camera tilts up with small amplitude at slow speed',
  static: 'The camera holds a static shot',
  orbit: 'The camera moves in an arc around the subject with small amplitude at slow speed'
}

export function detectDialogueLanguage(text: string): string {
  const value = text.trim()
  if (/[぀-ヿ]/.test(value)) return 'Japanese'
  if (/[가-힣]/.test(value)) return 'Korean'
  if (/[㐀-鿿]/.test(value)) return 'Chinese'
  return 'English'
}

/** Keep Korean dialogue in its own language tag and preserve the existing Chinese format. */
export function h3SpokenTag(spoken: string): string {
  const line = sanitizeDialogue(spoken)
  if (!line) return ''
  const language = detectDialogueLanguage(line) === 'Korean' ? 'Korean' : 'Chinese'
  return `<d>[${language}] ${line}</d>`
}

export function isOfficialH3Prompt(text: string): boolean {
  if (isMessyH3Prompt(text) || isH3FillTemplate(text)) return false
  const hasSound = /overall_soundscape\s*:/i.test(text)
  const hasI2va = /integrated_multimodal_description\s*:/i.test(text)
  const hasR2va = /subject_definitions\s*:/i.test(text) && /detailed_description\s*:/i.test(text)
  return hasSound && (hasI2va || hasR2va)
}

/** 공식 FL2VA의 첫 줄은 첫 이미지를 시작 시점에, 두 번째 이미지를 끝에 맞춘다. */
export function ensureFl2vaLead(prompt: string, duration: number): string {
  const body = String(prompt || '').trim()
  if (/aligns with the 0\.00-second mark/i.test(body) && /Picture 2/i.test(body)) return body
  const end = Math.max(1, Number(duration) || 5).toFixed(2)
  const lead = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the ${end}-second mark of the target video.`
  return body ? `${lead}\n\n${body}` : lead
}

/** 공식 L2VA의 첫 줄은 유일한 참조 이미지를 영상 끝에 맞춘다. */
export function ensureL2vaLead(prompt: string, duration: number): string {
  const body = String(prompt || '').trim()
  if (/<Picture 1> \(from \[Shot \d+\]\) aligns with the \d+\.\d{2}-second mark/i.test(body)) return body
  const shots = [...body.matchAll(/\[Shot\s*(\d+)\]/gi)].map((item) => Number(item[1]))
  const last = shots.length ? Math.max(...shots) : 1
  const end = Math.max(1, Number(duration) || 5).toFixed(2)
  const lead = `How the reference pictures align with the target video — <Picture 1> (from [Shot ${last}]) aligns with the ${end}-second mark of the target video.`
  return body ? `${lead}\n\n${body}` : lead
}

/** 슬롯과 일반 문구만 있고 현재 샷의 구체적 동작이 없는 템플릿 */
export function isH3FillTemplate(text: string): boolean {
  const t = String(text || '')
  return (
    /hands, clothing and the air in the place start to move/i.test(t) ||
    /brows, eyes and mouth show a specific emotion, not a blank stare/i.test(t) ||
    /the core action completes, residual breath and eye motion remain/i.test(t) ||
    /Play the following director notes/i.test(t)
  )
}

/** 멀티모달 참조 형식은 공식 여섯 구역이 모두 있어야 한다. */
export function isCompleteRef2VA(text: string): boolean {
  const t = String(text || '')
  return (
    /subject_definitions\s*:/i.test(t) &&
    /summary\s*:/i.test(t) &&
    /retention_analysis\s*:/i.test(t) &&
    /detailed_description\s*:/i.test(t) &&
    /overall_soundscape\s*:/i.test(t) &&
    /non_diegetic_music\s*:/i.test(t)
  )
}

/** 영문 템플릿에 현장 기록을 그대로 넣었거나 공식 여섯 구역이 빠진 원고를 찾는다. */
export function isMessyH3Prompt(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (/Play the following director notes/i.test(t)) return true
  if (/subject_definitions\s*:/i.test(t) && !isCompleteRef2VA(t)) return true
  if (/the place named in the director notes/i.test(t)) return true
  return /[㐀-鿿]/.test(stripAllowedCjk(t))
}

/** <d> 대사와 【】로 표시한 극 중 화면 문구는 원문을 보존한다. */
function stripAllowedCjk(text: string): string {
  return String(text || '').replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>|【[^】\n]+】/gi, '')
}

function cjkOutsideSpokenTags(text: string): boolean {
  return /[㐀-鿿]/.test(stripAllowedCjk(text))
}

/** 본문은 영어로 작성하고 대사와 명시된 극 중 화면 문구는 원문을 보존한다. */
export function stripCjkOutsideSpokenTags(text: string): string {
  const held: string[] = []
  const mask = (block: string) => {
    held.push(block)
    return `__H3KEEP${held.length - 1}__`
  }
  const masked = String(text || '').replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>|【[^】\n]+】/gi, mask)
  const cleaned = masked
    .replace(/[\u3400-\u9fff]+/g, '')
    .replace(/[「」『』]/g, '')
    .replace(/[，。！？、；：（）]/g, ' ')
    .replace(/This shot is titled\s*\./gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.replace(/__H3KEEP(\d+)__/g, (_, i) => held[Number(i)] || '')
}

function looksLikeSpokenDialogue(text: string): boolean {
  const line = String(text || '').trim()
  if (!line || isPlaceholderSpokenLine(line) || looksLikeShotDirection(line)) return false
  if (line.length > 48) return false
  if (line.length >= 40 && !/[！？!?]/.test(line)) return false
  if (/图\s*\d+|Camera language|Performance direction|时长|画风|场记|integrated_multimodal|Reference pictures/i.test(line)) {
    return false
  }
  return /[\u3400-\u9fff]/.test(line)
}

function sanitizeDialogue(text: string): string {
  const spoken = spokenTextOnly(text)
  const source = detectDialogueLanguage(spoken) === 'Korean' ? spoken : normalizeForSpeech(spoken)
  const line = stripSpokenStageDirection(
    source
      .replace(/<\/?d>/gi, '')
      .replace(/\[[^\]]{0,120}\]/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
  if (!line || isPlaceholderSpokenLine(line) || looksLikeShotDirection(line)) return ''
  if (!looksLikeSpokenDialogue(line)) return ''
  return line
}

/** 공식 형식의 대사 태그에서 현장 기록을 없애고 화자와 입 모양 안내는 괄호에 둔다. */
export function sanitizeDTagContents(text: string): string {
  return String(text || '')
    .replace(/<d>\s*(\[[^\]]*\])?\s*([\s\S]*?)<\/d>/gi, (_, bracket, inner) => {
      const line = sanitizeDialogue(inner)
      if (!line) return ''
      const meta = String(bracket || '').trim()
      if (detectDialogueLanguage(line) === 'Korean') return `<d>[Korean] ${line}</d>`
      if (/^\[Chinese\b/i.test(meta) && /,/.test(meta)) return `<d>${meta} ${line}</d>`
      return `<d>[Chinese] ${line}</d>`
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 대사를 줄별로 나누고 화자 이름을 제외한 원문만 태그에 넣는다. */
export function spokenCueLines(voiceover: string): string[] {
  return String(voiceover || '')
    .split(/\r?\n/)
    .map((line) => sanitizeDialogue(line))
    .filter((line) => line && !isPlaceholderSpokenLine(line) && !looksLikeShotDirection(line))
}

export function formatH3Timestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000))
  const m = Math.floor(totalMs / 60_000)
  const rest = totalMs % 60_000
  const s = Math.floor(rest / 1000)
  const ms = rest % 1000
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 한 영상에 들어가는 내부 샷의 구간을 나타낸다. */
export function h3InternalShotPlan(
  duration: number,
  spokenCount = 0
): Array<{ index: number; at?: string; beat: string }> {
  const total = Math.max(5, Math.min(10, Number(duration) || 5))
  const want = spokenCount >= 3 ? 3 : spokenCount === 2 ? 2 : total >= 8 ? 3 : total >= 6 ? 2 : 1
  const count = Math.min(3, Math.max(1, want))
  if (count === 1) return [{ index: 1, beat: total.toFixed(2) }]
  if (count === 2) {
    const cut = Math.min(3, Math.max(2, Math.round(total / 2)))
    return [
      { index: 1, beat: cut.toFixed(2) },
      { index: 2, at: formatH3Timestamp(cut), beat: (total - cut).toFixed(2) }
    ]
  }
  return [
    { index: 1, beat: '3.00' },
    { index: 2, at: formatH3Timestamp(3), beat: '3.00' },
    { index: 3, at: formatH3Timestamp(6), beat: Math.max(1, total - 6).toFixed(2) }
  ]
}

function describeInternalShotPlan(duration: number, spokenCount: number): string {
  const plan = h3InternalShotPlan(duration, spokenCount)
  return plan
    .map((item, i, all) => {
      const last = i === all.length - 1
      const finish = last
        ? ` End this last beat with: The action develops continuously and finishes naturally within ${item.beat} seconds.`
        : ''
      if (item.index === 1) {
        return `[Shot 1] no timestamp; this beat is about ${item.beat}s.${finish}`
      }
      return `[Shot ${item.index}] At ${item.at}, ...; this beat is about ${item.beat}s.${finish}`
    })
    .join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractField(text: string, name: string): string {
  const re = new RegExp(
    `${name}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\\s*:|$)`,
    'i'
  )
  return (text.match(re)?.[1] || '').trim()
}

function durationText(input: H3PromptInput): string {
  return Math.max(4, Math.min(15, Number(input.duration) || 5)).toFixed(2)
}

function styleLead(aesthetic?: string): string {
  const a = aesthetic || ''
  if (/动漫|二次元|anime|2d/i.test(a)) return '2D-animated, cinematic'
  if (/3d|三维|cg/i.test(a)) return '3D CG, cinematic'
  if (/水彩|watercolor/i.test(a)) return 'watercolor, cinematic'
  return 'Cinematic, live-action'
}

function cameraBeatEn(
  movement: NonNullable<Shot['cameraMovement']>,
  index: number,
  total: number
): string {
  switch (movement) {
    case 'push':
      if (index === 0) return 'The camera starts slightly wider, then begins a slow small-amplitude push-in.'
      if (index === total - 1) return 'The push-in eases to a stop on a closer frame; no extra zoom.'
      return 'The camera continues the same slow small-amplitude push-in on one axis.'
    case 'pull':
      if (index === 0) return 'The camera starts closer, then begins a slow small-amplitude pull-out.'
      if (index === total - 1) return 'The pull-out eases to a stop, revealing more of the place.'
      return 'The camera continues the same slow small-amplitude pull-out on one axis.'
    case 'pan':
      if (index === 0) return 'The camera holds the opening frame, then begins a slow pan right with small amplitude at slow speed.'
      if (index === total - 1) return 'The pan eases to a stop on the end frame.'
      return 'The camera continues the same slow pan; no whip pan.'
    case 'tilt':
      if (index === 0) return 'The camera holds the opening frame, then begins a slow tilt up with small amplitude at slow speed.'
      if (index === total - 1) return 'The tilt eases to a stop on the end frame.'
      return 'The camera continues the same slow tilt.'
    case 'orbit':
      if (index === 0) return 'The camera begins a small-amplitude slow arc around the subject.'
      if (index === total - 1) return 'The arc eases to a stop; do not travel more than a short arc.'
      return 'The camera continues the same small-amplitude slow arc, axis unchanged.'
    default:
      return 'The camera holds a static shot with only subtle natural sway; no pan, tilt, or zoom.'
  }
}

export function buildH3ImageSlots(
  entries: Array<{ kind: 'character' | 'scene' | 'prop' | 'board' | 'extra' | 'keyframe'; name?: string }>
): H3ImageSlot[] {
  const map = h3NameMap(entries.filter((entry) => entry.kind === 'character').map((entry) => entry.name))
  let place = 0
  let extra = 0
  return entries.map((entry, i) => {
    const index = i + 1
    if (entry.kind === 'character') {
      const name = (entry.name && map[entry.name]) || h3UniqueName(entry.name, index, 'person')
      return {
        index,
        kind: 'character',
        name,
        sourceName: entry.name,
        job: `<Subject identity from Picture ${index}> ${name} is the person in <Picture ${index}>. Lock only this person's face, hair, body, age and outfit. Do not generate a four-view grid or extra people.`
      }
    }
    if (entry.kind === 'prop') {
      const name = entry.name || `prop ${index}`
      return {
        index,
        kind: 'prop',
        name,
        sourceName: entry.name,
        job: `<Picture ${index}> is the recurring prop ${name}. Lock shape, material, color and wear. Multi-angle reference only, not a first frame.`
      }
    }
    if (entry.kind === 'scene') {
      place += 1
      const name = h3UniqueName(entry.name, place, 'place')
      return {
        index,
        kind: 'scene',
        name,
        sourceName: entry.name,
        job: `${name} is the location in <Picture ${index}>. Lock only space, materials, weather and light. Use ONE unified place. Do not generate a four-panel grid.`
      }
    }
    if (entry.kind === 'keyframe') {
      return {
        index,
        kind: 'board' as const,
        name: 'the four-panel keyframe',
        sourceName: entry.name,
        job: `<Picture ${index}> is a 2x2 four-panel keyframe for [Shot 1] (exactly 4 cells). Action order only. Never copy the grid, borders, or play four stills as a slideshow.`
      }
    }
    if (entry.kind === 'extra') {
      extra += 1
      return {
        index,
        kind: 'extra',
        name: `user reference ${extra}`,
        sourceName: entry.name,
        job: `<Picture ${index}> is an additional user reference. Match people, clothing, product, setting or style from this image. Do not treat it as another first frame, a grid, or a slideshow.`
      }
    }
    return {
      index,
      kind: 'board',
      name: 'the storyboard',
      job: `<Picture ${index}> is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order. Never copy panels, borders, sketches, or a slideshow of stills.`
    }
  })
}

function slotsOf(input: H3PromptInput): H3ImageSlot[] {
  if (input.imageSlots?.length) return input.imageSlots
  const assigns = input.imageAssignments ?? []
  if (!assigns.length) return []
  return assigns.map((text, i) => {
    const index = i + 1
    const cleaned = String(text || '').trim()
    if (/storyboard/i.test(cleaned)) {
      return { index, kind: 'board' as const, name: 'the storyboard', job: cleaned }
    }
    if (/recurring prop|PROP SHEET|multi-angle prop/i.test(cleaned)) {
      return { index, kind: 'prop' as const, name: `Prop ${index}`, job: cleaned }
    }
    if (/scene plate|location|SCENE PLATE/i.test(cleaned)) {
      return { index, kind: 'scene' as const, name: `Place ${index}`, job: cleaned }
    }
    return { index, kind: 'character' as const, name: `Person ${index}`, job: cleaned }
  })
}

function labeledSlots(input: H3PromptInput): LabeledSlot[] {
  let subject = 0
  return slotsOf(input).map((slot) => {
    if (slot.kind === 'board' || slot.kind === 'extra' || slot.kind === 'prop') {
      return { kind: slot.kind, picture: slot.index, name: slot.name, sourceName: slot.sourceName }
    }
    subject += 1
    return {
      kind: slot.kind,
      picture: slot.index,
      subject,
      name: slot.name,
      sourceName: slot.sourceName
    }
  })
}

/** 캐릭터, 장면, 개요판을 함께 제공하면 Ref2VA를 쓴다. 한 이미지가 시작 프레임이면 I2VA를 쓴다. */
export function isRef2VA(input?: H3PromptInput): boolean {
  if (!input) return false
  if (input.mode === 'T2VA' || input.mode === 'I2VA' || input.mode === 'FL2VA' || input.mode === 'L2VA') return false
  if (input.mode === 'R2VA') return true
  const slots = slotsOf(input)
  if (slots.some((slot) => slot.kind === 'board')) return true
  return slots.filter((slot) => slot.kind === 'character' || slot.kind === 'scene').length >= 2
}

function pictureRoster(input: H3PromptInput): string {
  return pictureIdentityBlock(input)
}

function identityLabel(slot: LabeledSlot): string {
  const en = String(slot.name || '').trim()
  if (en && !/[㐀-鿿]/.test(en)) return en
  if (slot.kind === 'scene') return `Place ${slot.picture}`
  if (slot.kind === 'character') return `Person ${slot.picture}`
  if (slot.kind === 'prop') return `Prop ${slot.picture}`
  return `reference ${slot.picture}`
}

/** 말하는 순서와 무관하게 캐릭터 식별자를 해당 이미지에 고정한다. */
export function pictureIdentityBlock(input: H3PromptInput): string {
  const slots = labeledSlots(input)
  if (!slots.length) return ''
  const lines = ['Speaker lock (these labels are the pictures):']
  let speaker = 0
  for (const slot of slots) {
    const who = identityLabel(slot)
    if (slot.kind === 'prop') {
      lines.push(
        `(P${slot.picture}) is ${who} / <Picture ${slot.picture}>. Lock shape, material, color and wear. Multi-angle reference only, not the first frame.`
      )
      continue
    }
    if (slot.kind === 'character') {
      speaker += 1
      lines.push(
        `(S${speaker}) is ${who} / <Picture ${slot.picture}>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.`
      )
      continue
    }
    if (slot.kind === 'scene') {
      lines.push(`<Picture ${slot.picture}> is the location ${who}. Lock space, materials, weather and light. One unified place.`)
      continue
    }
    if (slot.kind === 'board') {
      lines.push(
        `<Picture ${slot.picture}> is a storyboard or keyframe for blocking and order only. Never show the grid, panels or labels on screen.`
      )
      continue
    }
    if (slot.name === 'start frame') {
      lines.push(`<Picture ${slot.picture}> is the actual first frame at 0.00 seconds. Continue from this pose, wardrobe, light and set. Later pictures lock identity or location only and are not first frames.`)
      continue
    }
    lines.push(`<Picture ${slot.picture}> is additional reference ${who}. Match people, clothing, product, setting or style from this image.`)
  }
  if (speaker >= 2) {
    lines.push(
      'Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.'
    )
  } else if (speaker === 1) {
    lines.push('Only (S1) may speak. Every other mouth stays completely closed.')
  }
  return lines.join('\n')
}

export function promptHasPictureIdentity(text: string, count: number): boolean {
  if (count <= 0) return true
  const src = String(text || '')
  for (let i = 1; i <= count; i++) {
      const hit = new RegExp(
      `(?:图\\s*${i}\\s*[/：:=是]|\\(S\\d+\\)\\s+is\\b[^\\n]*<Picture\\s*${i}>|<Picture\\s*${i}>\\s+is\\b|<Subject\\s*\\d+>[^\\n]*<Picture\\s*${i}>)`,
      'i'
    ).test(src)
    if (!hit) return false
  }
  return true
}

/** 모델 응답의 인물 매핑을 코드에서 생성한 매핑으로 교체한다. */
export function ensurePictureIdentity(prompt: string, input: H3PromptInput): string {
  const src0 = String(prompt || '').trim()
  if (
    input.mode === 'I2VA' ||
    input.mode === 'FL2VA' ||
    input.mode === 'L2VA' ||
    input.mode === 'T2VA' ||
    /aligns with the \d+\.\d{2}-second mark/i.test(src0) ||
    /at 0\.00 seconds into the target video/i.test(src0)
  ) {
    return src0
  }
  const block = pictureIdentityBlock(input)
  if (!block) return String(prompt || '').trim()
  let src = String(prompt || '').trim()
  // 기존 참조 이미지 블록을 제거한 뒤 확정한 이미지 매핑을 삽입한다.
  src = src
    .replace(/Reference pictures\s*\([^)]*\)\s*:[\s\S]*?(?=\n\s*\[Shot\s*\d+\]|\n\s*(?:镜头|景别与运镜|画面与动作依据)\s*[：:]|\n\s*Camera language\s*:|\n\s*overall_soundscape\s*:|$)/i, '')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\n\s*\[Shot\s*\d+\]|\n\s*Camera language\s*:|\n\s*overall_soundscape\s*:|$)/i, '')
    .replace(/(?:^|\n)(?:图\s*\d+\s*[/：:=是][^\n]*\n)+/g, '\n')
    .replace(/(?:^|\n)\(S\d+\)\s+is\b[^\n]*\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (/subject_definitions\s*:/i.test(src) && /detailed_description\s*:/i.test(src)) {
    const defs = subjectDefinitions(input)
    if (defs && /subject_definitions\s*:[\s\S]*?(?=\n\s*summary\s*:)/i.test(src)) {
      return src.replace(/subject_definitions\s*:[\s\S]*?(?=\n\s*summary\s*:)/i, `subject_definitions:\n${defs}\n\n`)
    }
    return src
  }
  if (/integrated_multimodal_description\s*:/i.test(src)) {
    return src.replace(/(integrated_multimodal_description\s*:\s*)/i, `$1${block}\n\n`)
  }
  return `${block}\n\n${src}`
}

/**
 * 인물 매핑 직후에 캐릭터별 음색을 명시한다.
 * 코드에서 음색을 삽입하고 이전 원고의 불완전한 음색 단락을 제거한다.
 */
export function ensureVoiceRoster(prompt: string, roster: string): string {
  const block = String(roster || '').trim()
  if (!block) return String(prompt || '')
  const src = String(prompt || '')
    .replace(/人物声音[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!src) return block
  const lines = src.split('\n')
  let last = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*图\s*\d+\s*[/：:=是]/.test(line) || /^\s*\(S\d+\)\s+is\b/.test(line) || /^\s*<Picture\s+\d+>\s+is\b/i.test(line)) {
      last = i
      continue
    }
    // 빈 줄이나 본문이 시작되면 이미지 매핑 구역을 끝낸다.
    if (last >= 0 && (!line.trim() || /^\[Shot\s*\d+\]/i.test(line))) break
  }
  if (last >= 0) {
    lines.splice(last + 1, 0, '', block)
    return lines.join('\n').replace(/\n{3,}/g, '\n\n')
  }
  return `${block}\n\n${src}`
}

function onScreenEnglish(input: H3PromptInput): string[] {
  const fromSlots = slotsOf(input)
    .filter((slot) => slot.kind === 'character')
    .map((slot) => slot.name)
  if (fromSlots.length) return fromSlots
  const map = h3NameMap(input.onScreenNames ?? [])
  return (input.onScreenNames ?? []).map((name) => map[name]).filter(Boolean)
}

function characterPeople(input: H3PromptInput): LabeledSlot[] {
  return labeledSlots(input).filter((slot) => slot.kind === 'character')
}

function bareSpeakerName(raw?: string): string {
  return String(raw || '')
    .replace(/[（(][^）)]{0,16}[）)]/g, '')
    .replace(/[「」]/g, '')
    .trim()
}

/** 첫 번째 캐릭터 이미지는 첫 번째 식별자에 고정하며 발화 순서로 다시 번호를 붙이지 않는다. */
function matchedSpeakerCode(input: H3PromptInput, raw?: string): string | undefined {
  const people = characterPeople(input)
  const wanted = [bareSpeakerName(raw)].filter(Boolean)
  for (const name of wanted) {
    const hit = people.findIndex((slot) => {
      const src = bareSpeakerName(slot.sourceName)
      const en = bareSpeakerName(slot.name)
      return src === name || en === name || (!!src && (name.includes(src) || src.includes(name)))
    })
    if (hit >= 0) return `S${hit + 1}`
  }
  return undefined
}

function speakerCode(input: H3PromptInput, raw?: string): string {
  return matchedSpeakerCode(input, raw) || matchedSpeakerCode(input, input.speakerName) || 'S1'
}

function quietOthers(input: H3PromptInput, code: string): string {
  const others = characterPeople(input)
    .map((_, index) => `S${index + 1}`)
    .filter((id) => id !== code)
  if (!others.length) return `Only (${code}) speaks. Every other mouth stays completely closed.`
  const rest = others.map((id) => `(${id})`).join(' and ')
  const verb = others.length === 1 ? 'keeps' : 'keep'
  const voice = others.length === 1 ? 'makes' : 'make'
  return `Only (${code}) speaks in this shot. ${rest} ${verb} their lips completely closed and ${voice} no voice.`
}

function dialogueBlocks(input: H3PromptInput, lines: string[]): string {
  if (!lines.length || input.voiceMode === 'none') return ''
  const cues = dialogueCuesForPrompt(input)
  const voiceTag = englishOrOmit(String(input.speakerVoice || '').trim().replace(/[；;]+$/, ''))
  if (input.voiceMode === 'voiceover') {
    const spoken = lines
      .map((line, i) => {
        const cue = cues[i]
        const code = speakerCode(input, cue?.speaker)
        return `(${code})${voiceTag ? `, voice: ${voiceTag}` : ''} says in an off-screen voiceover: ${h3SpokenTag(line)} ${quietOthers(input, code)}`
      })
      .join('\n\n')
    return `${spoken} The words inside the d tag are being called from off-screen; nobody on screen mouths them.`
  }
  const hint = englishOrOmit(input.speakerHint?.replace(/^\[|\]$/g, ''))
  return lines
    .map((line, i) => {
      const cue = cues[i]
      const code = speakerCode(input, cue?.speaker)
      const extra = [i === 0 && voiceTag ? `voice: ${voiceTag}` : '', i === 0 ? hint : ''].filter(Boolean).join(', ')
      const lead = extra ? `(${code}), ${extra},` : `(${code})`
      return `${lead} says: ${h3SpokenTag(line)} ${quietOthers(input, code)}`
    })
    .join('\n\n')
}

/** 대사가 없을 때는 말하기, 입술, 대사 등을 언급하지 않는다. H3는 부정문도 말하기 지시로 해석해 영어 대사를 만들 수 있다. */
function stripSilentSpeechPriming(text: string): string {
  return text
    .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/No dialogue\.?\s*(No lips moving\.?)?/gi, '')
    .replace(/No one speaks in this range\.?\s*(Mouths stay closed\.?)?/gi, '')
    .replace(/Each spoken line belongs to exactly one \(S#\) and one time range\.?\s*/gi, '')
    .replace(/Listeners keep their lips closed\.?\s*/gi, '')
    .replace(/One person speaks at a time\.?\s*/gi, '')
    .replace(/No voices and no music\.?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripDialogueMentions(text: string): string {
  return text
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/[^.]{0,120}\(S1\)[\s\S]{0,260}?(?:says in an off-screen voiceover|says):[\s\S]*?(?:closed\.|silently\.)/gi, '')
    .replace(/No dialogue\.?\s*(No lips moving\.?)?/gi, '')
    .replace(/On-screen lips remain completely closed\.?/gi, '')
    .replace(/while (?:his|her|their) lips remain completely closed\.?/gi, '')
    .replace(/Every on-screen person keeps the mouth completely closed\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripSpokenLeaks(text: string, spoken: string): string {
  let next = text.replace(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*[\s\S]*?<\/d>/gi, '')
  const lines = spokenCueLines(spoken)
  const all = lines.length ? lines : spoken ? [sanitizeDialogue(spoken)].filter(Boolean) : []
  if (!all.length) return next.replace(/\s{2,}/g, ' ').trim()
  for (const line of all) {
    const quoted = (chunk: string) => {
      const inner = chunk.slice(1, -1)
      return inner.includes(line) || line.includes(inner) ? '' : chunk
    }
    next = next
      .replace(/[“「][^”」]*[”」]/g, quoted)
      .replace(/"(?:[^"\\]|\\.)*"/g, (chunk) => (/[㐀-鿿]/.test(chunk) ? quoted(chunk) : chunk))
    if (line.length >= 4) {
      next = next.replace(new RegExp(escapeRegExp(line), 'g'), '')
    }
  }
  return next
    .replace(/(?:台词|对白|旁白|口播)\s*[：:]\s*[^：:\n]{0,16}\s*[：:]\s*(?=\n|$|Location facts)/gi, '')
    .replace(/\s*Location facts\s*:[^\n]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripSpokenLeaksOutsideTags(text: string, voiceover: string): string {
  const held: string[] = []
  const masked = text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, (block) => {
    held.push(block)
    return `__H3D${held.length - 1}__`
  })
  return stripSpokenLeaks(masked, voiceover).replace(/__H3D(\d+)__/g, (_, i) => held[Number(i)] || '')
}

function stripUnofficialBeatHeadings(text: string): string {
  return text
    .replace(/\bFrom\s+\d+(?:\.\d+)?s?\s+to\s+\d+(?:\.\d+)?s:\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function subjectDefinitions(input: H3PromptInput): string {
  const lines: string[] = []
  for (const slot of labeledSlots(input)) {
    const pic = `<Picture ${slot.picture}>`
    if (slot.kind === 'board') {
      lines.push(
        `${pic} is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order.`
      )
      continue
    }
    if (slot.kind === 'prop') {
      lines.push(
        `${pic} is the recurring prop ${identityLabel(slot)} (P${slot.picture}). Lock shape, material, color and wear. Multi-angle reference only, not the first frame.`
      )
      continue
    }
    if (slot.kind === 'extra') {
      lines.push(
        `${pic} is an additional user reference. Match people, clothing, product, setting or style from this image. Do not copy a grid or treat it as another first frame.`
      )
      continue
    }
    if (slot.kind === 'scene') {
      const extra = englishOrOmit(input.sceneLighting)
      lines.push(
        extra
          ? `<Subject ${slot.subject}> is ${identityLabel(slot)} in ${pic}, a unified location with ${extra}.`
          : `<Subject ${slot.subject}> is ${identityLabel(slot)} in ${pic}, the location for [Shot 1].`
      )
      continue
    }
    lines.push(
      `<Subject ${slot.subject}> is ${identityLabel(slot)} (S${slot.subject}) in ${pic}. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.`
    )
  }
  return lines.join('\n')
}

function summaryBlock(input: H3PromptInput): string {
  const labeled = labeledSlots(input)
  const people = labeled.filter((slot) => slot.kind === 'character')
  const place = labeled.find((slot) => slot.kind === 'scene')
  const board = labeled.find((slot) => slot.kind === 'board')
  const who = people.map((slot) => `<Subject ${slot.subject}>`).join(' and ') || 'the referenced people'
  const where = place ? `<Subject ${place.subject}>` : 'the referenced location'
  const boardLine = board
    ? ` <Picture ${board.picture}> is a storyboard reference for [Shot 1] only.`
    : ''
  const extraCount = labeled.filter((slot) => slot.kind === 'extra').length
  const extraLine = extraCount
    ? ` Also lock ${extraCount} additional user reference image${extraCount > 1 ? 's' : ''}.`
    : ''
  const propSlots = labeled.filter((slot) => slot.kind === 'prop')
  const propLine = propSlots.length
    ? ` Recurring props stay on ${propSlots.map((slot) => `<Picture ${slot.picture}>`).join(', ')}.`
    : ''
  return `[reference generation] The target video is one continuous [Shot 1] of ${who} in ${where}.${boardLine}${propLine}${extraLine} Character sheets lock identity only. Prop sheets lock the object only. The location plate locks space and light only. The storyboard never appears on screen.`
}

function retentionAnalysis(input: H3PromptInput): string {
  return labeledSlots(input)
    .map((slot) => {
      if (slot.kind === 'board') {
        return `<Picture ${slot.picture}> (storyboard for [Shot 1]): weak_reference - viewpoint, blocking and order only; the panel grid never appears on screen.`
      }
      if (slot.kind === 'prop') {
        return `<Picture ${slot.picture}> (recurring prop (P${slot.picture})): fully_preserved - shape, material, color and wear from this multi-angle sheet.`
      }
      if (slot.kind === 'extra') {
        return `<Picture ${slot.picture}> (additional user reference): fully_preserved - people, clothing, product, setting or style from this image.`
      }
      if (slot.kind === 'scene') {
        return `<Subject ${slot.subject}> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture ${slot.picture}>.`
      }
      return `<Subject ${slot.subject}> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture ${slot.picture}>.`
    })
    .join('\n')
}

function useSixSection(input?: H3PromptInput): boolean {
  if (!input || input.forceIntegrated === true) return false
  if (input.mode === 'FL2VA' || input.mode === 'L2VA' || input.mode === 'I2VA' || input.mode === 'T2VA') {
    return false
  }
  if (input.mode === 'R2VA') return true
  return isRef2VA(input)
}

function visualShotBody(desc: string): string {
  const text = String(desc || '').trim()
  const cut = text.search(/\[Shot\s*1\]/i)
  return (cut >= 0 ? text.slice(cut) : text).trim()
}

/** 공식 멀티모달 참조는 여섯 구역이며 인물 매핑 후 샷 본문이 시작된다. */
function assembleRef2VA(desc: string, sound: string, music: string, input: H3PromptInput): string {
  let body = sanitizeDTagContents(stripCjkOutsideSpokenTags(visualShotBody(desc)))
  body = ensureVoiceRoster(body, input.voiceRoster || '')
  const defs = subjectDefinitions(input).trim() || 'No separate reference subject. Generate from the written shot only.'
  return `subject_definitions:
${defs}

summary:
${summaryBlock(input).trim()}

retention_analysis:
${retentionAnalysis(input).trim()}

detailed_description:
${body}

overall_soundscape:
${stripCjkOutsideSpokenTags(sound.trim())}

non_diegetic_music:
${music.trim() || 'N/A'}`
}

function assembleByMode(desc: string, sound: string, music = 'N/A', input?: H3PromptInput): string {
  if (input && useSixSection(input)) return assembleRef2VA(desc, sound, music, input)
  let text = assembleOfficial(desc, sound, music, input)
  if (!input || input.forceIntegrated === true) return text
  if (input.mode === 'FL2VA') return ensureFl2vaLead(text, input.duration || 5)
  if (input.mode === 'L2VA') return ensureL2vaLead(text, input.duration || 5)
  return text
}

function assembleOfficial(desc: string, sound: string, music = 'N/A', input?: H3PromptInput): string {
  let body = stripCjkOutsideSpokenTags(desc.trim())
  if (input) {
    const keyframe = input.mode === 'I2VA' || input.mode === 'FL2VA' || input.mode === 'L2VA'
    if (!keyframe) body = ensurePictureIdentity(body, input)
    body = ensureVoiceRoster(body, input.voiceRoster || '')
  }
  if (input?.mode === 'I2VA') {
    const block = pictureIdentityBlock(input)
    if (block) {
      body = body
        .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\n\s*\[Shot\s*\d+\]|\n\s*Camera language\s*:|\n\s*overall_soundscape\s*:|$)/i, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      body = `${block}\n\n${body}`
    }
  }
  const extraJobs = input
    ? slotsOf(input)
        .filter((slot) => slot.kind === 'extra' && slot.index > 1)
        .map((slot) => slot.job)
        .join('\n')
    : ''
  const alignment =
    input &&
    input.mode === 'I2VA' &&
    !input.forceIntegrated &&
    slotsOf(input).length &&
    !/\[Shot\s*[2-9]\]/i.test(body)
      ? `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.${extraJobs ? `\n${extraJobs}` : ''}\n\n`
      : ''
  return stripCjkOutsideSpokenTags(`${alignment}integrated_multimodal_description:
${sanitizeDTagContents(body)}

overall_soundscape:
${stripCjkOutsideSpokenTags(sound.trim())}

non_diegetic_music:
${(music.trim() || 'N/A')}`)
}

function finishLine(input: H3PromptInput): string {
  return `The action develops continuously and finishes naturally within ${durationText(input)} seconds.`
}

function ensureOfficialBody(desc: string, input: H3PromptInput): string {
  const cleaned = stripUnofficialBeatHeadings(desc)
  const match = cleaned.match(/^([\s\S]*?)(\[Shot\s*1\][\s\S]*)$/i)
  const style = (match?.[1] || '').trim()
  const shot = (match?.[2] || cleaned).trim()
  let body = shot.replace(/^\[Shot\s*1\]\s*/i, '').trim()
  const lead = styleLead(input.aesthetic)
  if (!/\b(cinematic|live-action|2d-animated|3d cg|watercolor)/i.test(`${style}\n${body}`)) {
    body = `${lead}, ${body}`
  }
  return `[Shot 1] ${body}`
}

function ensureSpokenTags(text: string, lines: string[]): string {
  if (!lines.length) return sanitizeDTagContents(text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '').trim())
  const tags = lines.map((line) => h3SpokenTag(line)).filter(Boolean)
  if (!tags.length) return sanitizeDTagContents(text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '').trim())
  const existing = [...text.matchAll(/<d>\s*(\[[^\]]*\])?\s*([\s\S]*?)<\/d>/gi)]
  const taggedText = existing.map((m) => sanitizeDialogue(m[2] || ''))
  const exactMatch =
    taggedText.length === lines.length &&
    lines.every((line, i) => taggedText[i] === line)
  if (exactMatch) {
    return sanitizeDTagContents(text)
  }
  // 확정한 대사와 다르면 기존 대사 태그를 지우고 원문으로 다시 작성한다.
  let cleaned = text.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '').trim()
  const extra = tags.join('\n\n')
  if (/\[\d{2}:\d{2}\.\d{3}\s*[–-]/i.test(cleaned)) {
    // 첫 시간 구간 뒤에 삽입한다.
    const rebuilt = cleaned.replace(
      /(\[\d{2}:\d{2}\.\d{3}\s*[–-][^\]]+\][\s\S]*?)(?=\n\s*\[\d{2}:\d{2}\.\d{3}|\n\s*Camera language\s*:|$)/i,
      (chunk) => `${chunk.trim()}\n\n${extra}\n`
    )
    if (rebuilt !== cleaned) return sanitizeDTagContents(rebuilt)
  }
  if (/\[Shot\s*2\]/i.test(cleaned)) {
    return sanitizeDTagContents(cleaned.replace(/\[Shot\s*2\]/i, `${extra}\n\n[Shot 2]`))
  }
  if (/Camera language\s*:/i.test(cleaned)) {
    return sanitizeDTagContents(cleaned.replace(/Camera language\s*:/i, `${extra}\n\nCamera language:`))
  }
  return sanitizeDTagContents(`${cleaned}\n\n${extra}`.trim())
}

function extractQuotedSpeech(text: string): string[] {
  const out: string[] = []
  for (const match of String(text || '').matchAll(/[“「"'‘]([^”」"'’\n]{1,40})[”」"'’]/g)) {
    const line = sanitizeDialogue(match[1] || '')
    if (line && looksLikeSpokenDialogue(line) && !out.includes(line)) out.push(line)
  }
  return out
}

/** 대사 태그, 인용문, 대사 필드, 발화 동작에서만 대사를 추출한다. */
export function extractSpokenFromNotes(text: string): string[] {
  const raw = String(text || '')
  if (!raw.trim()) return []
  const fromTags = [...raw.matchAll(/<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/gi)]
    .map((m) => sanitizeDialogue(m[1] || ''))
    .filter((line) => line && !isPlaceholderSpokenLine(line) && looksLikeSpokenDialogue(line))
  if (fromTags.length) return [...new Set(fromTags)]

  const out = extractQuotedSpeech(raw)
  for (const match of raw.matchAll(/(?:^|\n)[ \t]*(?:台词|对白|口播|旁白|대사|내레이션|화면 밖 음성|dialogue|narration|voiceover)\s*[：:][ \t]*(.+)$/gim)) {
    const body = String(match[1] || '').trim()
    if (looksLikeShotDirection(body)) continue
    const line = sanitizeDialogue(body)
    if (line && !isPlaceholderSpokenLine(line) && !out.includes(line)) out.push(line)
  }
  for (const match of raw.matchAll(
    /(?:^|\n)[ \t]*([\u3400-\u9fff가-힣]{1,8})(?:[（(][^）)\n]{0,16}[）)])?\s*[：:][ \t]*([^\n]+)/g
  )) {
    const label = String(match[1] || '').trim()
    if (/^(?:场景|音效|镜头|景别|时长|画风|站位|地点|道具|场记|画面|动作|运镜|机位|构图|环境|光影|备注|说明|장면|효과음|샷|길이|스타일|장소|소품|현장기록|화면|동작|구도|환경|조명|비고|설명)$/.test(label)) {
      continue
    }
    const line = sanitizeDialogue(match[2] || '')
    if (line && looksLikeSpokenDialogue(line) && !out.includes(line)) out.push(line)
  }
  for (const match of raw.matchAll(
    /(?:喊出|喊道|叫道|叫着|轻声说|小声说|小声喊)\s*[“「"'‘]([\u3400-\u9fff，。！？!?、]{1,24})[”」"'’]/g
  )) {
    const line = sanitizeDialogue(match[1] || '')
    if (line && !out.includes(line)) out.push(line)
  }
  return out
}

export function nodeTextHasSpeech(text: string): boolean {
  const t = String(text || '')
  if (extractSpokenFromNotes(t).length) return true
  if (/没有台词|无对白|不说话|无口播|대사 없음|대사가 없|내레이션 없음|말하지 않|No dialogue|No narration/i.test(t)) return false
  if (/<d\s*>/i.test(t) && !/<d>\s*\[[^\]]+\]\s*(?:无|没有|无对白|없음|대사 없음|none|N\/A)\s*<\/d>/i.test(t)) return true
  return /(?:喊出|喊道|叫道|叫着|轻声说|小声说|小声喊)/.test(t)
}

export function nodeTextForbidsSpeech(text: string): boolean {
  const t = String(text || '')
  if (extractSpokenFromNotes(t).length) return false
  return /没有台词|无对白|不说话|无口播|대사 없음|대사가 없|내레이션 없음|말하지 않|No dialogue|No narration/i.test(t)
}

function spokenLinesForPrompt(input: H3PromptInput): string[] {
  // 내레이션 필드에 내용이 있으면 해당 필드만 대사 원문으로 사용한다.
  // 인물 소개의 욕망이나 변화 같은 설정 문구는 대사로 추출하지 않는다.
  if (input.voiceMode === 'none') return []
  const labeled = labeledVoiceoverCues(input.voiceover || '')
  if (labeled.length) return labeled.map((cue) => cue.text)
  const fromVo = spokenCueLines(input.voiceover || '')
  if (fromVo.length) return fromVo
  const fromNotes = extractSpokenFromNotes(
    String(input.prompt || '')
      .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
      .replace(/【(?:节点当前提示词|本镜场记|分镜字段|口播栏)[^】]*】/g, '')
  )
  const merged: string[] = []
  for (const line of [...fromVo, ...fromNotes]) {
    if (line && looksLikeSpokenDialogue(line) && !looksLikeShotDirection(line) && !merged.includes(line)) {
      merged.push(line)
    }
  }
  return merged
}

function isStructuredShotBody(text: string): boolean {
  return (
    /\[Shot\s*1\]/i.test(text) ||
    /\[\d{2}:\d{2}\.\d{3}\s*[–-]/i.test(text) ||
    /Camera language\s*:/i.test(text) ||
    /Performance direction\s*:/i.test(text)
  )
}

function applyDialogue(desc: string, input: H3PromptInput): string {
  // 확정한 대사가 없으면 무대사로 처리하고 모델이 추가한 대사 태그를 제거한다.
  const wanted = spokenLinesForPrompt(input)
  if (isStructuredShotBody(desc)) {
    let body = desc.trim()
    if (wanted.length) {
      const owned = dialogueCuesForPrompt(input).filter((cue) => wanted.includes(cue.text))
      const turnIssue = dialogueTurnIssue(body, owned.length ? owned : wanted.map((text) => ({ text })))
      const spokenTurns = [...body.matchAll(/\(S(\d+)\)[^<\n]{0,160}\b(?:says?|asks?|shouts?|replies?|exclaims?|yells?|whispers?)\b[\s\S]{0,80}<d>/gi)]
      const codesMatch = wanted.every((line, index) => {
        const cue = owned[index]
        const code = speakerCode(input, cue?.speaker).replace(/^S/, '')
        return spokenTurns[index]?.[1] === code
      })
      if (turnIssue || !codesMatch || !/<d>\s*\[/i.test(body)) {
        body = `${body.replace(/(?:\(S\d+\)[^\n<]{0,120}\b(?:says?|asks?|replies?|shouts?|whispers?)\b[^\n<]{0,40})?<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '').replace(/\(S\d+\)\s+(?:says?|asks?|replies?|shouts?|whispers?)\s*:\s*(?=\(S\d+\)|$)/gi, '').trim()}\n\n${dialogueBlocks(input, wanted)}`.trim()
      } else {
        body = ensureSpokenTags(body, wanted)
      }
    } else {
      body = sanitizeDTagContents(
        body
          .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
          .replace(/\bNo dialogue\.?\s*(No lips moving\.?)?/gi, '')
      )
      body = stripSilentSpeechPriming(body)
    }
    return body
  }
  const shaped = ensureOfficialBody(desc, input)
  const match = shaped.match(/^([\s\S]*?)(\[Shot\s*1\][\s\S]*)$/i)
  let body = (match?.[2] || shaped).replace(/^\[Shot\s*1\]\s*/i, '').trim()
  if (wanted.length) {
    const hasTags = /<d>\s*\[/.test(body)
    if (!hasTags) {
      const cleaned = stripDialogueMentions(stripSpokenLeaks(body, wanted.join('\n')))
      const next = /no dialogue/i.test(cleaned)
        ? cleaned.replace(/no dialogue\.?\s*(no lips moving\.?)?/i, dialogueBlocks(input, wanted))
        : `${cleaned} ${dialogueBlocks(input, wanted)}`.trim()
      body = next
    } else {
      body = stripSpokenLeaksOutsideTags(body, wanted.join('\n'))
    }
    body = ensureSpokenTags(body, wanted)
    body = body.replace(/No dialogue\.?\s*(No lips moving\.?)?/gi, '').trim()
  } else {
    const cleaned = stripDialogueMentions(stripSpokenLeaks(body, ''))
      .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
      .replace(/[^.]{0,80}\(S\d+\)[^.]{0,60}says(?: in an off-screen voiceover)?:\s*/gi, '')
      .trim()
    body = stripSilentSpeechPriming(cleaned)
  }
  if (!/finishes naturally within/i.test(body)) {
    body = `${body} ${finishLine(input)}`
  }
  return `[Shot 1] ${sanitizeDTagContents(body)}`
}

function defaultSoundscape(input: H3PromptInput, spoken: string): string {
  const audio = String(input.audioDescription || '').trim()
  const notes = String(input.prompt || '')
  const mapped = [mapAmbience(audio), /[㐀-鿿]/.test(notes) ? mapAmbience(notes) : '']
    .flatMap((part) => part.split(/[;；]/))
    .map((part) => part.trim())
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join('; ')
  const raw = audio
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(/(?:人声|旁白|台词|对白)\s*[：:][^\n]*/g, '')
    .trim()
  const english = mapped || (raw && !/[㐀-鿿]/.test(raw) && raw.length < 180 ? raw : '')
  const base = english
    ? `${english.replace(/\.?$/, '')}, synchronized with the picture.`
    : 'Quiet room tone, cloth, footsteps and handled objects, synchronized with the picture.'
  if (!spoken || input.voiceMode === 'none') {
    return base
  }
  return `${base} Only the speaking (S#) is heard, and only the words inside the d tag. No music.`
}

function subjectPhrase(slot: LabeledSlot): string {
  return slot.subject ? `<Subject ${slot.subject}>` : slot.name
}

function shotSizeEn(raw?: string): string {
  const t = String(raw || '')
  if (/特写|클로즈업/.test(t)) return 'close-up'
  if (/中近|중근경/.test(t)) return 'medium close-up'
  if (/近景|근경/.test(t)) return 'close-up'
  if (/中全|全景|중원경|전경/.test(t)) return 'medium-wide shot'
  if (/中景|중경/.test(t)) return 'medium shot'
  if (/大远|대원경/.test(t)) return 'extreme wide shot'
  if (/远景|원경/.test(t)) return 'wide shot'
  if (/medium close-up|close-up|wide shot|medium shot|medium-wide/i.test(t)) {
    return t.replace(/[㐀-鿿].*$/, '').trim() || 'medium shot'
  }
  return 'medium shot'
}

function angleEn(raw?: string): string {
  const t = String(raw || '')
  if (/过肩|오버숄더|over.the.shoulder/i.test(t)) return 'over-the-shoulder'
  if (/俯|하이 앵글|high angle/i.test(t)) return 'slight high angle'
  if (/仰|로우 앵글|low angle/i.test(t)) return 'slight low angle'
  if (/45|侧/.test(t)) return 'framed from a slight side angle'
  return 'framed from a slight three-quarter angle'
}

function mapNotePhrases(text: string | undefined, rules: Array<[RegExp, string]>): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (!/[㐀-鿿]/.test(raw)) return raw
  const hits: string[] = []
  for (const [re, en] of rules) {
    if (re.test(raw) && !hits.includes(en)) hits.push(en)
  }
  return hits.join('; ')
}

function mapCinemaNotes(text?: string): string {
  return mapNotePhrases(text, [
    [/特写/, 'tight close-up'],
    [/中近/, 'medium close-up'],
    [/近景/, 'close shot'],
    [/中全|全身/, 'full-length medium-wide'],
    [/全景/, 'wide full shot of the place'],
    [/远景|大远/, 'wide establishing view'],
    [/中景/, 'medium shot'],
    [/过肩/, 'over-the-shoulder framing'],
    [/俯拍|俯视/, 'slight high angle'],
    [/仰拍|仰视/, 'slight low angle'],
    [/侧对|四分之三|3\s*\/\s*4/, 'three-quarter bodies, not square to camera'],
    [/不看镜头|禁止看镜头|别看镜头/, 'gaze stays inside the scene, never into the lens'],
    [/回头|侧头/, 'a glance or turn toward the other person'],
    [/低头/, 'eyes drop'],
    [/对峙|对视/, 'a charged look held between them'],
    [/紧张|慌/, 'tension in the jaw and shoulders'],
    [/害怕|惊/, 'a held, frightened breath'],
    [/怒|冷/, 'a cold, controlled face'],
    [/笑|温柔/, 'a restrained human expression, not a blank stare'],
    [/推近|缓推|慢推/, 'a slow small-amplitude push-in'],
    [/拉开|缓拉|慢拉/, 'a slow small-amplitude pull-out'],
    [/固定|静止|锁死/, 'locked-off camera with only subtle sway']
  ])
}

function mapAmbience(text?: string): string {
  return mapNotePhrases(text, [
    [/雨/, 'rain on surfaces'],
    [/风/, 'light wind in the space'],
    [/脚步|走/, 'footsteps'],
    [/门/, 'wood or a door shifting'],
    [/水|溪|河/, 'water movement'],
    [/虫|蝉/, 'insects'],
    [/车|街/, 'distant street'],
    [/火|柴/, 'fire crackle'],
    [/薯片|咔嚓|咀嚼|零食/, 'crisp chip crunch'],
    [/靠垫|翻找|哗啦/, 'cushion and fabric rustle'],
    [/拖鞋/, 'slipper scuff'],
    [/衣|布|织物/, 'cloth rustle'],
    [/呼吸|鼻息/, 'close breath'],
    [/房间|室内|屋/, 'interior room tone'],
    [/田|稻|村|室外/, 'open outdoor air and foliage']
  ])
}

function purposeEn(raw?: string): string {
  const t = String(raw || '')
  if (/钩子|开场|建立|도입|상황 설정|hook|opening/.test(t)) return 'This beat establishes the space and the first visible tension.'
  if (/对峙|冲突|대치|갈등|conflict/.test(t)) return 'This beat holds a confrontation; bodies stay charged, not idle.'
  if (/反应|반응|reaction/.test(t)) return 'This beat is a reaction: face and breath change with what just happened.'
  if (/揭示|공개|드러남|reveal/.test(t)) return 'This beat reveals new information through look and body, not exposition.'
  if (/转场|전환|transition/.test(t)) return 'This beat bridges the moment; motion and eyeline carry us forward.'
  if (/收口|结束|마무리|ending/.test(t)) return 'This beat lands the scene; hold the last expression and let the frame breathe.'
  return ''
}

function compositionEn(aspect?: string): string {
  if (aspect === '9:16') return 'vertical portrait composition, subject weighted in the upper third, clear headroom'
  if (aspect === '1:1') return 'square composition with the subject held on a stable central axis'
  return 'landscape composition with readable foreground, midground and background depth'
}

function shotFrame(input: H3PromptInput) {
  const ratio = input.aspectRatio || '16:9'
  const lighting = englishOrOmit(input.sceneLighting) || 'available light'
  const movement = normalizeCameraMovement(input.cameraMovement)
  const labeled = labeledSlots(input)
  const people = labeled.filter((slot) => slot.kind === 'character')
  const place = labeled.find((slot) => slot.kind === 'scene')
  const who = people.length
    ? people.map((slot, i) => `${identityLabel(slot)} (S${i + 1})`).join(' and ')
    : 'the on-screen people'
  const where = place
    ? identityLabel(place)
    : englishOrOmit(input.sceneName) || 'the location'
  const extras = labeled.filter((slot) => slot.kind === 'extra')
  const extraHint = extras.length
    ? ` Extra refs ${extras.map((slot) => `<Picture ${slot.picture}>`).join(' and ')} lock identity or setting only.`
    : ''
  const size = shotSizeEn(input.shotSize)
  const angle = angleEn(input.shotSize)
  return { ratio, lighting, movement, who, where, extraHint, size, angle }
}

function descriptionFromNotes(input: H3PromptInput): string {
  const roster = pictureIdentityBlock(input)
  const { lighting, who, where, extraHint, size, angle } = shotFrame(input)
  const notedMove = `${input.prompt || ''}\n${input.blocking || ''}`
  const movement =
    normalizeCameraMovement(input.cameraMovement) !== 'static'
      ? normalizeCameraMovement(input.cameraMovement)
      : /慢推|缓推|推近|推进/.test(notedMove)
        ? 'push'
        : /慢拉|拉远|拉开/.test(notedMove)
          ? 'pull'
          : /上摇|俯仰|틸트|tilt/i.test(notedMove)
            ? 'tilt'
            : /横摇|摇镜|横移/.test(notedMove)
              ? 'pan'
              : 'static'
  const total = Number(durationText(input))
  const t0 = formatH3Timestamp(0)
  const tOpen = formatH3Timestamp(Math.min(1.2, Math.max(0.8, total * 0.2)))
  const tHold = formatH3Timestamp(Math.max(total - 0.8, total * 0.85))
  const tEnd = formatH3Timestamp(total)
  const angleBit = angle ? `, ${angle}` : ''
  const openCam = cameraBeatEn(movement, 0, 3)
  const midCam = cameraBeatEn(movement, 1, 3)
  const endCam = cameraBeatEn(movement, 2, 3)
  const blocking =
    mapCinemaNotes(input.blocking) ||
    'Bodies sit in a three-quarter stance with clear near/far depth, not a lineup facing the lens.'
  const eyes =
    mapCinemaNotes(input.eyeline) ||
    'Gaze stays on the other person or the object of attention inside the scene, never into the lens.'
  const action =
    mapCinemaNotes(input.continuity) ||
    'Bodies, props and eyelines change across the clip, and the last pose is different from the first.'
  const mood = mapCinemaNotes(input.speakerHint) || purposeEn(input.purpose)
  const moodBit = mood ? ` ${mood}` : ''
  const lines = spokenLinesForPrompt(input)
  const plan = h3InternalShotPlan(total, lines.length)
  const beats = plan
    .map((shot, index) => {
      const start = index === 0 ? t0 : shot.at || tOpen
      const end = index === plan.length - 1 ? tEnd : plan[index + 1]?.at || tHold
      const line = lines[index]
      const code = line ? speakerCode(input, dialogueCuesForPrompt(input).find((cue) => cue.text === line)?.speaker) : ''
      const speech = line
        ? `(${code || 'S1'}) says: ${h3SpokenTag(line)} ${quietOthers(input, code || 'S1')}`
        : ''
      if (index === 0) {
        return `[${start}–${end}]\n${openCam} ${who} in ${where}. ${blocking} ${eyes.replace(/\.$/, '.')}${moodBit} ${speech}`.trim()
      }
      if (index === plan.length - 1) {
        return `[${start}–${end}]\n${endCam} ${action} The action develops continuously and finishes naturally within ${total.toFixed(0)} seconds. ${speech}`.trim()
      }
      return `[${start}–${end}]\n${midCam} ${action} Lighting stays ${lighting}.${extraHint} ${speech}`.trim()
    })
    .join('\n\n')
  const speechRule = lines.length
    ? 'Each spoken line belongs to exactly one (S#) and one time range. Listeners keep their lips closed.'
    : 'Visible action and ambient sound only.'
  const performance = lines.length
    ? 'Keep faces, hair and clothes locked to the speaker pictures. One person speaks at a time. No subtitles, no visible text, no extra people.'
    : 'Keep the pictured identity locked to the reference pictures. No subtitles, no visible text, no extra people.'
  const body = `[Shot 1] ${styleLead(input.aesthetic)}, ${size}${angleBit}, ${compositionEn(input.aspectRatio)}. Clean low-noise digital cinema image, natural skin texture. ${who} in ${where}. One ${total.toFixed(0)}-second clip. ${speechRule}

${beats}

Camera language:
${size}. ${openCam} Then ${midCam} Then ${endCam}

Performance direction:
${performance}`
  return roster ? `${roster}\n\n${body}` : body
}

/** 빈 대사, 불완전한 형식, 이미지 매핑 누락을 감지해 프롬프트를 다시 작성한다. */
export function compiledH3PromptNeedsRebuild(text: string | undefined): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (isLifelessH3Prompt(t)) return true
  if (/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*(?:无|没有|无对白|无台词|없음|대사 없음|none|N\/A)\s*<\/d>/i.test(t)) {
    return true
  }
  if (/says(?: in an off-screen voiceover)?:\s*<d>\s*\[Chinese\]\s*无\s*<\/d>/i.test(t)) return true
  if (/Person 1 \(S1\) in Place 1\.\s*The camera holds a static shot\.\s*Gaze stays on the scene/i.test(t)) {
    return true
  }
  // 인물 목록만 있거나 내부 샷 또는 인물 식별자 매핑이 빠진 초안을 찾는다.
  if (/integrated_multimodal_description\s*:/i.test(t) && !/\[Shot\s*1\]/i.test(t)) return true
  if (/subject_definitions\s*:/i.test(t) && !/\[Shot\s*1\]/i.test(t)) return true
  if (/is this person's character design/i.test(t) && !/\(S1\)\s+is\b/.test(t)) return true
  return false
}

/** 한자 설명을 정리한 뒤 장면 연출 없이 인물 목록만 남는지 확인한다. */
function shotProseTooThin(desc: string): boolean {
  if (!/\[Shot\s*1\]/i.test(desc)) return true
  const prose = stripCjkOutsideSpokenTags(desc)
    .replace(/<d>[\s\S]*?<\/d>/gi, ' ')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\[Shot\s*1\])/i, ' ')
  const words = prose.match(/[A-Za-z]{4,}/g) || []
  return words.length < 35
}

function fallbackDescription(input: H3PromptInput, _spoken: string): string {
  return descriptionFromNotes(input)
}

function isGenericActionDump(desc: string): boolean {
  return (
    /action, blocking and chronology come from the storyboard/i.test(desc) ||
    /people match the character design sheets/i.test(desc) ||
    /Play the following director notes/i.test(desc) ||
    isH3FillTemplate(desc) ||
    cjkOutsideSpokenTags(desc)
  )
}

type DialogueCue = { text: string; speaker?: string }

/** 대사를 정리하기 전에 각 줄의 화자를 기록한다. 줄바꿈이나 문장부호 뒤에 바로 다음 화자가 나오는 경우를 지원한다. */
function labeledVoiceoverCues(value: string): DialogueCue[] {
  const raw = String(value || '').replace(/\r\n?/g, '\n')
  const pattern = /(?:^|\n|(?<=[。！？!?]))\s*(?:\*\*)?([\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9 _-]{0,11})(?:[（(][^）)\n]{0,16}[）)])?\s*[：:](?:\*\*)?\s*/g
  const matches = [...raw.matchAll(pattern)].filter((match) =>
    !/^(?:场景|音效|镜头|景别|时长|画风|站位|地点|道具|场记|画面|动作|运镜|机位|构图|环境|光影|备注|说明|台词|对白|口播)$/.test(match[1].trim())
  )
  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : raw.length
    return { speaker: match[1].trim(), text: sanitizeDialogue(raw.slice(start, end).trim()) }
  }).filter((cue) => Boolean(cue.text))
}

/** 어떤 화자가 어떤 대사를 말하는지 연결해 인물별 입 모양을 만들 수 있게 한다. */
function dialogueCuesForPrompt(input: H3PromptInput): DialogueCue[] {
  const labeled = labeledVoiceoverCues(input.voiceover || '')
  if (labeled.length) return labeled
  const wanted = spokenLinesForPrompt(input)
  const raw = `${input.voiceover || ''}\n${input.prompt || ''}`
  return wanted.map((text) => {
    const escaped = escapeRegExp(text)
    const name = `(?:「([^」]{1,24})」|([\\u3400-\\u9fff가-힣A-Za-z][\\u3400-\\u9fff가-힣A-Za-z0-9 _-]{0,12})(?:[（(][^）)\\n]{0,16}[）)])?)`
    const tagged = raw.match(
      new RegExp(`${name}\\s*(?:说|说道|问|喊|叫|答|says?y?|asks?|shouts?|replies?)?\\s*[：:]?\\s*(?:<d>\\s*\\[[^\\]]*\\]\\s*)?${escaped}`, 'i')
    )
    const line = raw.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*[：:]\\s*${escaped}`, 'im'))
    const speaker = String(tagged?.[1] || tagged?.[2] || line?.[1] || line?.[2] || '').trim()
    return { text, speaker: speaker || undefined }
  })
}

function dialogueTurnIssue(desc: string, expected: DialogueCue[]): string {
  if (!expected.length) return ''
  const tags = [...String(desc || '').matchAll(/<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/gi)]
  if (tags.length !== expected.length) return `Expected ${expected.length} dialogue tags but found ${tags.length}.`
  for (let i = 0; i < tags.length; i += 1) {
    if (sanitizeDialogue(tags[i][1] || '') !== expected[i].text) return `${i + 1}번째 대사가 대본 원문이나 순서와 달라요.`
    const index = tags[i].index || 0
    const lead = desc.slice(Math.max(0, index - 260), index)
    if (!/\(S\d+\)[^.\n]{0,180}\b(?:says?|asks?|shouts?|replies?|exclaims?|yells?|whispers?)\b[^.\n]{0,120}[:，,]?\s*$/i.test(lead)) {
      return `Line ${i + 1} needs exactly one speaker (S#) and a speech verb immediately before the tag.`
    }
  }
  return ''
}

function assertDialogueOwnership(input: H3PromptInput): void {
  if (input.voiceMode === 'none' || input.voiceMode === 'voiceover') return
  const voice = String(input.voiceover || '').trim()
  if (!voice) return
  const cues = labeledVoiceoverCues(voice)
  const people = characterPeople(input)
  const distinct = [...new Set(cues.map((cue) => bareSpeakerName(cue.speaker)).filter(Boolean))]
  if (distinct.length > 1) {
    const missing = distinct.filter((name) => !matchedSpeakerCode(input, name))
    if (missing.length) throw new Error(`대사의 화자를 참조 이미지와 연결할 수 없어요. (${missing.join(', ')}) 샷에 인물을 추가하고 참조 이미지를 연결한 뒤 다시 최적화하세요.`)
  } else if (!cues.length && people.length > 1 && !matchedSpeakerCode(input, input.speakerName)) {
    throw new Error('여러 인물이 나오지만 대사에 화자가 없어요. 각 줄을 ‘인물 이름: 대사’로 적은 뒤 다시 최적화하세요.')
  }
}

/** 이전 템플릿의 일반 문구만 사용한 프롬프트를 식별한다. */
export function isLifelessH3Prompt(text: string | undefined): boolean {
  const t = String(text || '')
  if (!t.trim()) return true
  const repeatedStatic = (t.match(/camera holds a static shot/gi) || []).length >= 2
  const genericTimeline =
    /Begin with the opening frame[\s\S]*Faces show a specific reaction[\s\S]*Hold the last expression and let the frame breathe/i.test(t)
  const restrainedConflict =
    /no pan, tilt, or zoom/i.test(t) && /restrained camera move|push-in|pull-out|pan right|tilt up|arc around/i.test(t)
  const genericPerformance =
    /Play the emotional change of this beat in order[\s\S]*Avoid calm exposition/i.test(t)
  return isH3FillTemplate(t) || (repeatedStatic && genericTimeline) || genericPerformance || restrainedConflict
}

export interface H3PromptValidation {
  valid: boolean
  issues: string[]
}

export function validateH3Prompt(prompt: string, expectedDialogue?: string): H3PromptValidation {
  const issues: string[] = []
  const hasI2va = /integrated_multimodal_description\s*:/i.test(prompt)
  const hasR2va = /subject_definitions\s*:/i.test(prompt) && /detailed_description\s*:/i.test(prompt)
  if (!hasI2va && !hasR2va) issues.push('detailed_description 또는 integrated_multimodal_description이 없습니다.')
  if (hasR2va) {
    if (!/summary\s*:/i.test(prompt)) issues.push('Ref2VA에 summary가 없습니다.')
    if (!/retention_analysis\s*:/i.test(prompt)) issues.push('Ref2VA에 retention_analysis가 없습니다.')
    if (!/\[reference generation\]/i.test(prompt)) issues.push('summary는 [reference generation]으로 시작해야 합니다.')
  }
  if (
    hasI2va &&
    /<Picture\s*1>/i.test(prompt) &&
    !/\[Shot\s*[2-9]\]/i.test(prompt) &&
    !/at 0\.00 seconds into the target video/i.test(prompt) &&
    !/aligns with the \d+\.\d{2}-second mark/i.test(prompt) &&
    !/Identity reference only, not the first frame/i.test(prompt) &&
    !/图\s*1\s*[/：:=是]/i.test(prompt)
  ) {
    issues.push('I2VA에 시작 프레임 정렬 문장이 없습니다. For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
  }
  if (!/overall_soundscape\s*:/i.test(prompt)) issues.push('overall_soundscape가 없습니다.')
  if (!/non_diegetic_music\s*:/i.test(prompt)) issues.push('non_diegetic_music이 없습니다.')
  if (isLifelessH3Prompt(prompt)) {
    issues.push('샷이 기계적으로 등분됐거나 카메라 고정과 움직임이 충돌합니다. 이야기 속 동작에 맞게 샷을 구성하세요.')
  }
  if (!/\[Shot\s*1\]/i.test(prompt)) issues.push('본문은 [Shot 1]로 시작하고 첫 샷에는 타임스탬프를 넣지 마세요.')
  if (/\[Shot\s*1\][^\n]*At\s+\d{2}:\d{2}/i.test(prompt)) {
    issues.push('[Shot 1]에는 타임스탬프를 넣지 마세요. 이후 샷부터 [Shot 2] At 00:03.000 형식을 사용하세요.')
  }
  if (/from\s+\d+(?:\.\d+)?s?\s+to\s+\d+(?:\.\d+)?s/i.test(prompt)) {
    issues.push('H3 본문에서 From 0.00s to … 형식을 사용하지 마세요. 첫 화면, 동작의 시작과 전개, 마무리를 이어서 쓰세요.')
  }
  if (/【环境光影】|【画面演进】|【角色声音签名】/.test(prompt)) {
    issues.push('H3가 인식하지 못하는 중국어 섹션이 들어 있습니다.')
  }
  if (/\bThis shot is\s*\./i.test(prompt)) issues.push('샷 제목이 불완전한 문장인 This shot is.로 남았습니다.')
  if (/\bLocation facts\s*:/i.test(prompt)) issues.push('장면 정보가 Location facts에 중복으로 추가됐습니다.')
  if (/(?:台词|对白|旁白|口播)\s*[：:]\s*[^：:\n]{0,16}\s*[：:]\s*(?:$|\n|Location facts)/i.test(prompt)) {
    issues.push('본문에 빈 대사 태그가 있습니다. 대사는 d 태그 안에만 넣으세요.')
  }

  const expectedLines = spokenCueLines(expectedDialogue || '')
  const expectedJoined = expectedLines.join(' ') || sanitizeDialogue(expectedDialogue || '')
  const tagged = [...prompt.matchAll(/<d>\s*\[(Chinese|English|Japanese|Korean)(?:,[^\]]*)?\]\s*([\s\S]*?)<\/d>/gi)].map((m) => ({
    language: m[1].toLowerCase(),
    line: m[2].replace(/\s+/g, ' ').trim()
  }))
  if (expectedJoined) {
    const wanted = expectedLines.length ? expectedLines : [expectedJoined]
    const hasIncorrectTag = wanted.some((line) => {
      const language = detectDialogueLanguage(line) === 'Korean' ? 'korean' : 'chinese'
      return !tagged.some((tag) => tag.line === line && tag.language === language)
    })
    if (hasIncorrectTag) {
      issues.push('대사는 원문을 그대로 유지하고 대사 언어에 맞는 <d> 태그에 넣으세요.')
    }
    if (tagged.some((tag) => !wanted.includes(tag.line))) {
      issues.push('d 태그에 읽지 않아야 할 내용이 들어 있습니다.')
    }
    const outsideTags = prompt.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    if (wanted.some((line) => line.length >= 4 && outsideTags.includes(line))) {
      issues.push('대사 원문이 d 태그 밖에서 반복됩니다.')
    }
  } else if (tagged.length) {
    issues.push('대사 없는 샷에는 <d> 태그를 넣지 마세요.')
  }
  return { valid: issues.length === 0, issues }
}

function resolvePromptInput(input: H3PromptInput, source: string): H3PromptInput {
  if (input.mode) return input
  if (isCompleteRef2VA(source) || /subject_definitions\s*:/i.test(source)) return { ...input, mode: 'R2VA' }
  if (/aligns with the 0\.00-second mark/i.test(source) && /Picture 2/i.test(source)) return { ...input, mode: 'FL2VA' }
  if (/<Picture 1> \(from \[Shot \d+\]\) aligns with the/i.test(source)) return { ...input, mode: 'L2VA' }
  if (/at 0\.00 seconds into the target video/i.test(source)) return { ...input, mode: 'I2VA' }
  return input
}

/** 멀티모달 참조는 여섯 구역을 쓰고 나머지 공식 모드는 세 구역과 필요한 정렬 문구를 쓴다. */
export function composeH3VideoPrompt(input: H3PromptInput): string {
  const source = stripFrameLead(input.prompt || '')
  const resolved = resolvePromptInput(input, source)
  assertDialogueOwnership(resolved)
  const spoken = spokenLinesForPrompt(resolved).join(' ')

  if (isOfficialH3Prompt(source) && !isH3FillTemplate(source) && !isMessyH3Prompt(source)) {
    const desc = applyDialogue(
      extractField(source, 'detailed_description') ||
        extractField(source, 'integrated_multimodal_description') ||
        source,
      resolved
    )
    const sound = extractField(source, 'overall_soundscape') || defaultSoundscape(resolved, spoken)
    const music = extractField(source, 'non_diegetic_music') || 'N/A'
    return assembleByMode(desc, sound, music, resolved)
  }

  if (isStructuredShotBody(source) && !isMessyH3Prompt(source)) {
    const desc = applyDialogue(
      extractField(source, 'integrated_multimodal_description') || source,
      resolved
    )
    const sound = extractField(source, 'overall_soundscape') || defaultSoundscape(resolved, spoken)
    const music = extractField(source, 'non_diegetic_music') || 'N/A'
    return assembleByMode(desc, sound, music, resolved)
  }

  const desc = applyDialogue(descriptionFromNotes(resolved), resolved)
  return assembleByMode(desc, defaultSoundscape(resolved, spoken), 'N/A', resolved)
}

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

type H3PromptJson = {
  detailed_description?: string
  integrated_multimodal_description?: string
  overall_soundscape?: string
}

function extractPossiblyTruncatedJsonString(text: string, field: string): string {
  const source = stripJsonFence(text)
  const match = new RegExp(`"${field}"\\s*:\\s*"`, 'i').exec(source)
  if (!match) return ''
  const start = match.index + match[0].length
  let escaped = false
  let raw = ''
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (!escaped && char === '"') break
    raw += char
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
  }
  if (raw.endsWith('\\')) raw = raw.slice(0, -1)
  try {
    return JSON.parse(`"${raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`)
  } catch {
    return raw
      .replace(/\\([^"\\/bfnrtu])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim()
  }
}

function parseH3PromptJson(content: string): { parsed: H3PromptJson; truncated: boolean } {
  try {
    return { parsed: parseJsonRobust(content) as H3PromptJson, truncated: false }
  } catch (error) {
    const parsed: H3PromptJson = {
      integrated_multimodal_description: extractPossiblyTruncatedJsonString(
        content,
        'integrated_multimodal_description'
      ),
      detailed_description: extractPossiblyTruncatedJsonString(content, 'detailed_description'),
      overall_soundscape: extractPossiblyTruncatedJsonString(content, 'overall_soundscape')
    }
    if (parsed.integrated_multimodal_description || parsed.detailed_description) {
      return { parsed, truncated: true }
    }
    throw error
  }
}

/**
 * API 자체 오류는 최적화를 중단한다. 모델의 JSON, 표현, 연출 형식 문제는
 * 로컬 컴파일러로 보완해 제출 가능한 프롬프트를 반환한다.
 */
function isLLMRequestFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /(?:\b401\b|\b403\b|\b408\b|\b409\b|\b429\b|\b5\d\d\b|鉴权|Authentication|api.?key|rate.?limit|限流|余额|timeout|timed out|网络|network|fetch failed|ECONN|ENOTFOUND|socket)/i.test(
    message
  )
}

function cleanH3Field(text: string): string {
  return stripReasoningLeak(text).trim()
}

/** 현장 기록을 H3 공식 영문 형식과 내부 샷으로 변환한다. 실패하면 기본 템플릿을 사용한다. */
export async function compileH3OfficialPrompt(input: H3PromptInput): Promise<string> {
  const resolved: H3PromptInput = { ...input, forceIntegrated: input.forceIntegrated === true }
  assertDialogueOwnership(resolved)
  const source = stripFrameLead(resolved.prompt || '')
  if (getAIMode() === 'mock') {
    return composeH3VideoPrompt(resolved)
  }
  if (isOfficialH3Prompt(source) && !input.forceIntegrated) {
    return composeH3VideoPrompt(resolved)
  }

  const cueLines = spokenLinesForPrompt(resolved)
  const dialogueCues = dialogueCuesForPrompt(resolved)
  const camera = CAMERA_EN[normalizeCameraMovement(resolved.cameraMovement)]
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          // H3 영상 연출은 영어로 쓰고 대사는 원문 언어와 화자 번호를 유지한다.
          content: `You write MiniMax / Seedance shot-video prompts. Write final generation prose in English. Preserve spoken lines verbatim in their original language, using [Korean] for Korean dialogue and [Chinese] for Chinese dialogue. Do not translate on-screen text that the user requires in Korean (한국어). Output JSON only:
{"integrated_multimodal_description":"...","overall_soundscape":"..."}

This is ONE generated clip. The field format is fixed, but the filmmaking is NOT a fill-in template. Read the dramatic event first, then author the shot around its unique action and emotional causality.

Required output structure:
1) START by copying the speaker lock verbatim. (S1) is permanently the first character picture, (S2) the second. Never renumber S by dialogue order, and never write a bare picture number or "this person's character design" instead of (S#).
(S1) is Person 1 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is Person 2 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location Place 1. Lock space, materials, weather and light.
Only one (S#) speaks at a time. Everyone else keeps their lips completely closed.
These images are identity/location locks, NOT first frames. Do not write "Picture 1 is the first frame" or "Picture 1 aligns with 0.00 seconds".

2) After the speaker lock, write [Shot 1]. Add [Shot 2] At 00:SS.mmm and [Shot 3] only when a cut, reframe, reveal, impact, or change of dramatic focus genuinely earns them. A quiet reaction may remain one shot; a doorway-to-desk action, supernatural reveal, chase, fight, or large-scale effect usually needs changing framing. Never divide time into automatic opening/middle/hold slots.

3) Build a visible cause-and-effect chain specific to this scene: opening physical state -> trigger -> immediate bodily response -> purposeful action -> visible result -> final continuity state. Name the actual door, switch, key ring, statue, wardrobe, rain-streaked window, weapon, debris, or other story prop. Make the environment respond where appropriate: light flickers, fabric trails, rain reflections shift, dust lifts, furniture jolts, or sound changes. Every sentence must describe something filmable.

4) Camera movement must be motivated by what the audience needs to discover. State where the camera begins, what action or reveal makes it move, what foreground/background parallax or focus change occurs, and where it lands. The supplied camera family is only a preference, not a command. Static is valid only when stillness creates tension; do not repeat a static-camera sentence in every beat. Never combine “no pan, tilt, or zoom” with a push, pull, pan, tilt, or arc.

5) Direct performance through observable behavior and progression, not emotion labels: weight in the steps, a delayed glance, fingers missing the switch, breath catching, shoulders releasing, jaw tightening, or attention shifting to a sound. Derive the exact emotion from this beat; never turn every expression of anger into “cold and controlled,” and never use generic instructions such as “faces show a specific reaction,” “play the emotional change,” or “hold the last expression and let the frame breathe.”

6) Treat each reference character according to the state described in the scene: living body, carved statue, portrait, reflection, shadow, off-screen voice, hidden presence, or absent identity reference. A character reference does NOT prove that a full living person is physically present. Do not duplicate a referenced identity as both a person and a prop unless the action explicitly shows a transformation.

7) Dialogue ONLY inside <d>. Each trusted line is spoken once, by its own (S#), in its own time range. Never let two people talk at once, and never let a second person repeat the line. Use exactly:
(S1) says: <d>[Korean] 제 말을 들어 주세요.</d> Only (S1) speaks in this shot. (S2) keeps their lips completely closed and makes no voice.
The tag contains ONLY the spoken words. Never put continuity notes, timestamps, style, picture labels, or Camera language into <d>. A bare <d> tag is forbidden. The listener stays in the blocking with a closed mouth. Do not split a clip merely because its dialogue is fast when the user's timing explicitly fits it.

Timeline writing standard:
- Use the user's timing when supplied; otherwise divide the full duration according to action and dialogue, never into generic equal thirds.
- Preserve the source's shot sizes, camera positions, focus changes, movement start and end points, visible action steps, and motivated transitions. Do not flatten a detailed source into a plot summary or replace its specific direction with a generic camera move. Write enough filmable sentences to carry those details per time range.
- Preserve spatial blocking throughout: who is foreground/background, left/right, seated/standing, and exactly whom each person looks at. Nobody looks into the camera unless the story explicitly demands it.
- Expressions must evolve from a visible trigger: eyes refocus, brows tighten or release, jaw sets, breath catches, a hand hesitates, weight shifts. Avoid abstract emotion labels without behavior.
- Use at most one primary camera move per range. Motivate it through a hand movement, eyeline, reveal or emotional turn; state where it starts and where it lands. Keep screen direction and axis continuous unless an explicit cut is needed.
- Mention only story-relevant wardrobe, props, light and environmental motion. Do not repeat complete character-sheet descriptions in every beat.
- Every range must advance the event. No idle posing, no generic “clothes and air move,” and no slideshow-like sequence of reference images.

Rules:
- Subject universe lock: the source material and the reference pictures contain the ONLY subjects that may appear. Never add any character, animal, object, or plot event that is not present in them. Never resolve idioms, fables, or cultural associations literally (for example, a rabbit must NEVER gain a tortoise, a race, or any storybook framing unless the source says so). When the source is sparse, animate exactly the referenced subject(s) doing exactly what was asked, inside the referenced setting and style — do not invent narrative context to fill the runtime.
- Preserve the user's event. Expand only what is already explicitly implied by the script, and never invent a different incident or new characters.
- STYLE LOCK: when reference pictures are supplied, their art style is authoritative. Match the reference pictures' rendering (medium, palette, texture, character design) exactly. Ignore the Style line above if it conflicts; never switch the referenced subject to a different medium such as live-action, CG, or a generic "cinematic" look.
- Write direct, decisive filmmaking prose like a director describing the finished moving image. The format is a container, not a prose template.
- English for action, camera, light, names, places and performance. Preserve the original language inside <d> dialogue and for exact visible diegetic text. Do not use Chinese names as subject labels in action prose. Write the actual blocking in English: who is left/right, what they hold, what a prop does over time.
- In action prose, call people (S1), (S2) exactly as the speaker lock defines them. Do not invent a new S number per line. Do not anonymize a known character as “the man.” Recurring props keep the (P#) and <Picture N> written in the lock. When a hand touches that object, name that picture.
- Spoken lines already extracted below are the ONLY dialogue. If the list is empty, do not write dialogue, speech, lips, mouths, voices, or the words "no dialogue". H3 treats those words as a cue to invent English lines. Describe only visible action and ambient sound. NEVER invent speech from scene notes, timestamps, style, or the speaker lock. Never put a placeholder meaning “none” or director notes inside a d tag.
- MUST COPY the speaker-lock block below verbatim at the start of integrated_multimodal_description. Do not invent, omit, or reorder (S1)/(S2)/<Picture N>. If that lock says Picture 1 is the first frame, keep it that way: (S1) is the first character sheet, not Picture 1, and the location plate stays the scene picture named in the lock.
- overall_soundscape names the script's real sounds (chip crunch, cushion rustle, room tone). Do not write a generic sentence such as "close breath stay synchronized with the picture. Spoken words appear only inside the d tag."
- Delivery format is chosen by the app, not by you. Write the shot body only. Multimodal reference (R2VA) is wrapped into six sections: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. First-frame (I2VA), first-and-last-frame (FL2VA), last-frame (L2VA) and text-only (T2VA) stay three fields, with the official alignment line added outside your JSON. Do not emit those headers yourself.
- Do not show grids, four-view sheets, storyboards, collage, or added subtitles. Story-required HUD panels, system alerts and countdowns are diegetic text: place exact literals inside 【】 to preserve their original language and order. Describe when and where the panel appears, how long it remains, and keep it clear of the main action; never turn it into dialogue unless specified as audio.
- End the visual description once with: The complete action develops continuously and finishes naturally within ${durationText(resolved)} seconds.
- overall_soundscape must follow the visible chronology and name the exact synchronized sounds of each action. English ambience and physical sounds only; spoken words are represented by their d tags and should not be quoted again. No music.
- non_diegetic_music is always N/A.
Before returning JSON, silently reject and rewrite your draft if it contains generic time slots, repeated static-camera instructions, camera contradictions, a reference identity shown in the wrong physical form, unmotivated close-ups, idle posing, or sound effects unrelated to visible actions.`
        },
        {
          role: 'user',
          content: `${importedDirectorForH3()}Style: ${resolved.aesthetic || 'Cinematic'} (when reference pictures are supplied, their art style overrides this line)
Duration: ${durationText(resolved)}s
Aspect: ${resolved.aspectRatio || '16:9'} (${String(resolved.aspectRatio || '16:9') === '9:16' ? 'vertical portrait, taller than wide' : String(resolved.aspectRatio || '16:9') === '1:1' ? 'square' : 'horizontal landscape, wider than tall'})
Camera preference (override it when the event needs a motivated reframe or cut): ${camera}
Scene / light: ${[englishOrOmit(resolved.sceneLighting), englishOrOmit(resolved.sceneAnchor), englishOrOmit(resolved.sceneDescription)].filter(Boolean).join(' / ') || 'from director notes'}
Available character identity references. (S1) stays (S1) for the whole clip. Do not assume every one is a living body in this beat; infer the actual visible form from the scene:
${characterPeople(resolved).map((slot, i) => `(S${i + 1}) = ${identityLabel(slot)} = <Picture ${slot.picture}>`).join('\n') || onScreenEnglish(resolved).map((name, i) => `(S${i + 1}) = ${name}`).join('\n') || '(from director notes)'}
MUST COPY this speaker lock verbatim (identity/location lock, not first frames):
${pictureRoster(resolved) || 'no extra pictures'}
${slotsOf(resolved).some((slot) => slot.index === 1 && slot.name === 'start frame') ? 'Picture 1 is the first frame of this clip. Do not assign Picture 1 to a person. (S1) is the first character sheet, which is a later picture. The location plate is the scene picture named in the lock.' : ''}
Voice mode: ${cueLines.length ? resolved.voiceMode || 'dialogue' : 'none — no trusted spoken lines; do NOT invent dialogue'}
Character voice (this speaker's own timbre, kept verbatim as delivery inside each <d> bracket; do not reinterpret or translate it away): ${resolved.speakerVoice || '(not set — infer a natural timbre that fits the character)'}
Spoken lines already extracted (quotes, dialogue, or narration fields only; director notes are NOT speech):
${cueLines.length ? cueLines.map((line, i) => `${i + 1}. ${line}`).join('\n') : '(none — do not mention dialogue, speech, lips, mouths, or voices)'}
Dialogue ownership recovered from the source (each item is one exclusive turn; preserve this order):
${dialogueCues.length ? dialogueCues.map((cue, i) => `${i + 1}. (${speakerCode(resolved, cue.speaker)}) speaker=${cue.speaker || 'unassigned'} | words=${cue.text}`).join('\n') : '(none)'}
Sound notes: ${englishOrOmit(resolved.audioDescription) || '(from the node text)'}
NODE MATERIAL TO DIRECT (source of truth for event, props, blocking and continuity; continuity notes, duration, and visual style are not speech):
${source || '(perform the beat in this location)'}`
        }
      ],
      jsonMode: true,
      temperature: 0.62,
      maxTokens: 4800,
      timeoutMs: 240_000,
      signal: resolved.signal
    })
    const firstResult = parseH3PromptJson(resp.content)
    let parsed = firstResult.parsed
    let desc = cleanH3Field(
      String(parsed.integrated_multimodal_description || parsed.detailed_description || '')
    )
    if (/overall_soundscape\s*:/i.test(desc)) {
      desc = cleanH3Field(
        extractField(desc, 'integrated_multimodal_description') ||
          extractField(desc, 'detailed_description') ||
          desc
      )
    }
    let sound = cleanH3Field(String(parsed.overall_soundscape || ''))
    const firstDialogueIssue = dialogueTurnIssue(desc, dialogueCues)
    if (
      firstResult.truncated ||
      !desc ||
      isGenericActionDump(desc) ||
      isLifelessH3Prompt(desc) ||
      firstDialogueIssue
    ) {
      const repair = await callLLM({
        messages: [
          {
            role: 'system',
            // H3 초안의 구조와 연출을 고치면서 대사 원문을 보존한다.
            content: `Rewrite a rejected shot-video prompt as JSON only. Write final generation prose in English and preserve all spoken lines verbatim. Use [Korean] for Korean dialogue and [Chinese] for Chinese dialogue. Output schema: {"integrated_multimodal_description":"...","overall_soundscape":"..."}.
The rejected draft was lifeless because it used a reusable timing template, repeated static-camera instructions, or failed to preserve the actual event.
Write the moving image itself. Preserve the exact speaker lock and trusted dialogue. (S1) is the first character picture for the whole clip. Subject universe lock: only subjects present in the source material and reference pictures may appear — never add new characters, animals, or plot events, and never turn idioms or fables into literal content. The visual style must match the reference pictures exactly. Build a concrete cause-and-effect action chain with named props, motivated camera changes, observable performance, environmental reaction, and a visible final state. Give each spoken line its own time range. Never create generic opening/middle/hold slots. Never treat a statue, portrait, reflection, hidden presence, or off-screen identity as a living body. English action prose. Chinese only inside trusted <d> dialogue, never in names or 「」. A Chinese scene body will be deleted.

Dialogue is exclusive turn-taking. Immediately before every <d>, write the stable (S#) and says/asks/replies. Form: (S1) says: <d>[Korean] 제 말을 들어 주세요.</d> Only (S1) speaks in this shot. (S2) keeps their lips completely closed. Bare <d> tags are forbidden. Do not split the clip merely because the delivery is fast.

Rebuild the prompt as a detailed cinematic timeline, not an outline. Preserve source timing, shot sizes, camera positions, focus, movement start and landing, motivated cuts and visible action steps. For each range explain the starting posture, specific movement, environmental feedback and landing image. Preserve any exact diegetic on-screen text in 【】, with its placement and timing; it is not dialogue. Preserve foreground/background and left/right positions, keep the camera axis continuous, and use only story-relevant props, light and environmental motion. Every range must visibly advance the event. End once with the full ${durationText(resolved)}-second completion sentence.`
          },
          {
            role: 'user',
            content: `${importedDirectorForH3()}Speaker lock (copy verbatim):
${pictureRoster(resolved) || 'no extra pictures'}

Trusted dialogue:
${cueLines.length ? cueLines.join('\n') : '(none — do not mention dialogue, speech, lips, mouths, or voices)'}

Required dialogue ownership and order:
${dialogueCues.length ? dialogueCues.map((cue, i) => `${i + 1}. (${speakerCode(resolved, cue.speaker)}) speaker=${cue.speaker || 'unassigned'} | words=${cue.text}`).join('\n') : '(none)'}

Rejected-draft dialogue defect:
${firstResult.truncated ? 'The previous JSON response was cut off mid-string. Reconstruct the complete shot; do not merely close the broken sentence.' : firstDialogueIssue || '(none; repair the visual-action defect)'}

Original scene material:
${source}

Rejected draft (diagnose it silently; do not imitate its structure):
${desc || '(empty)'}`
          }
        ],
        jsonMode: true,
        temperature: 0.72,
        maxTokens: 4800,
        timeoutMs: 240_000,
        signal: resolved.signal
      })
      const repairResult = parseH3PromptJson(repair.content)
      if (repairResult.truncated) return composeH3VideoPrompt(resolved)
      parsed = repairResult.parsed
      desc = cleanH3Field(
        String(parsed.integrated_multimodal_description || parsed.detailed_description || '')
      )
      sound = cleanH3Field(String(parsed.overall_soundscape || ''))
    }
    // 품질 규칙은 한 번의 수정 요청을 유도하는 데 사용한다.
    // 두 번째 원고에 본문이 있으면 규칙 기반 정리 단계에 전달한다.
    if (!desc) return composeH3VideoPrompt(resolved)
    // 대사는 cueLines 또는 voiceover에서 가져온다. 모델이 추가한 태그로 대사 모드를 바꾸지 않는다.
    const trusted = spokenLinesForPrompt(resolved)
    const resolvedWithSpeech: H3PromptInput = {
      ...resolved,
      voiceMode: trusted.length
        ? resolved.voiceMode === 'none'
          ? 'dialogue'
          : resolved.voiceMode || 'dialogue'
        : 'none',
      voiceover: trusted.length ? resolved.voiceover || trusted.join('\n') : ''
    }
    let shaped = applyDialogue(desc, resolvedWithSpeech)
    if (shotProseTooThin(shaped)) {
      shaped = applyDialogue(descriptionFromNotes(resolvedWithSpeech), resolvedWithSpeech)
    }
    const spoken = trusted.join(' ')
    const assembled = assembleByMode(
      shaped,
      sound || defaultSoundscape(resolvedWithSpeech, spoken),
      'N/A',
      resolvedWithSpeech
    )
    return assembled
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (!isLLMRequestFailure(error)) return composeH3VideoPrompt(resolved)
    const reason = error instanceof Error ? error.message : String(error || '')
    throw new Error(`사용 가능한 영상 샷 프롬프트를 생성하지 못했습니다. ${reason || '다시 시도하세요.'}`)
  }
}
