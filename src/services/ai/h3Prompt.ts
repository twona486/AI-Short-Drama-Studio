/** MiniMax H3 提示词：分镜默认 integrated_multimodal_description + 内部 [Shot N]；台词只进 <d>。 */

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
import { parseJsonRobust } from '@/utils/jsonRepair'

export interface H3ImageSlot {
  index: number
  kind: 'character' | 'scene' | 'prop' | 'board' | 'extra'
  name: string
  sourceName?: string
  job: string
}

export interface H3PromptInput {
  /** 中文内容表现，或用户已写好的官方全文。 */
  prompt: string
  aesthetic?: string
  audioDescription?: string
  voiceover?: string
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  speakerHint?: string
  /**
   * 说话角色的音色描述（中文，来自人物节点 voicePrompt）。
   * 台词本身是中文，所以这里不进 englishOrOmit，直接跟在说话人后面。
   */
  speakerVoice?: string
  /**
   * 本镜出场人物各自的声音描述（中文，来自人物卡 voicePrompt）。
   * 必须写在提示词最开头，紧跟「图几是谁」，否则会被正文中文清洗一起抹掉。
   */
  voiceRoster?: string
  speakerName?: string
  /** 画面里实际出镜的人，画外音时必须闭嘴。 */
  onScreenNames?: string[]
  sceneName?: string
  sceneDescription?: string
  sceneLighting?: string
  sceneAnchor?: string
  shotTitle?: string
  imageAssignments?: string[]
  /** 按提交顺序的图槽：图1是谁、哪张是场景、哪张是看板。 */
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
  /** 为 true 时压成三段 integrated，不按官方模式加对齐句或六段。 */
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

/** 官方运镜三维：类型 + amplitude + speed，写成句内动作。 */
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

/** 官方 FL2VA 首行：Picture 1=0.00s，Picture 2=片尾。 */
export function ensureFl2vaLead(prompt: string, duration: number): string {
  const body = String(prompt || '').trim()
  if (/aligns with the 0\.00-second mark/i.test(body) && /Picture 2/i.test(body)) return body
  const end = Math.max(1, Number(duration) || 5).toFixed(2)
  const lead = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the ${end}-second mark of the target video.`
  return body ? `${lead}\n\n${body}` : lead
}

/** 官方 L2VA 首行：唯一参考图对齐成片结尾。 */
export function ensureL2vaLead(prompt: string, duration: number): string {
  const body = String(prompt || '').trim()
  if (/<Picture 1> \(from \[Shot \d+\]\) aligns with the \d+\.\d{2}-second mark/i.test(body)) return body
  const shots = [...body.matchAll(/\[Shot\s*(\d+)\]/gi)].map((item) => Number(item[1]))
  const last = shots.length ? Math.max(...shots) : 1
  const end = Math.max(1, Number(duration) || 5).toFixed(2)
  const lead = `How the reference pictures align with the target video — <Picture 1> (from [Shot ${last}]) aligns with the ${end}-second mark of the target video.`
  return body ? `${lead}\n\n${body}` : lead
}

/** 只有槽位和套话、没有这一镜具体戏的空模板 */
export function isH3FillTemplate(text: string): boolean {
  const t = String(text || '')
  return (
    /hands, clothing and the air in the place start to move/i.test(t) ||
    /brows, eyes and mouth show a specific emotion, not a blank stare/i.test(t) ||
    /the core action completes, residual breath and eye motion remain/i.test(t) ||
    /Play the following director notes/i.test(t)
  )
}

/** 官方多模态参考：六段齐了才算成稿。缺段的 subject_definitions 仍是脏稿。 */
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

/** 把中文场记原样塞进英文模板、或六段写残的脏稿。完整 Ref2VA 可以发给 H3。 */
export function isMessyH3Prompt(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (/Play the following director notes/i.test(t)) return true
  if (/subject_definitions\s*:/i.test(t) && !isCompleteRef2VA(t)) return true
  if (/the place named in the director notes/i.test(t)) return true
  return /[㐀-鿿]/.test(stripAllowedCjk(t))
}

/**
 * 允许留在英文正文里的中文：台词 <d>、图号身份、被《》式书名号包的人名，
 * 以及开头那块「人物声音」（音色是中文，删了人物就没有声音了）。
 */
function stripAllowedCjk(text: string): string {
  return String(text || '')
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/图\s*\d+\s*[是：:=]*/g, '')
    .replace(/「[^」]{1,24}」/g, '')
    .replace(/人物声音[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*/g, '')
}

function cjkOutsideSpokenTags(text: string): boolean {
  return /[㐀-鿿]/.test(stripAllowedCjk(text))
}

/** 正文里的汉字一律删掉；只保留 <d> 里的台词、图号/「人名」身份锁定和人物声音块。 */
export function stripCjkOutsideSpokenTags(text: string): string {
  const held: string[] = []
  const mask = (block: string) => {
    held.push(block)
    return `__H3KEEP${held.length - 1}__`
  }
  const masked = String(text || '')
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, mask)
    .replace(/图\s*\d+\s*[是：:=]*/g, mask)
    .replace(/「[^」]{1,24}」/g, mask)
    // 音色是中文：整块护住，否则会被下面的汉字清理删成空壳
    .replace(/人物声音[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*/g, mask)
    .replace(/voice\s*:\s*[^\n,]*/gi, mask)
  const cleaned = masked
    .replace(/[\u3400-\u9fff]+/g, '')
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
  if (detectDialogueLanguage(line) === 'Korean') return true
  if (line.length <= 4 && !/[。！？!?，、]/.test(line)) return false
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

/** 已写成官方稿时，把 <d> 里的场记清掉；标本格式的说话人/口型提示保留在括号里。 */
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

/** 按行拆对白，去掉「人物名：」后只留要进 <d> 的原词。场记/时长轴/图号不能当台词。 */
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

/** 一条成片内部的 [Shot 1/2/3] 时间切分，不是画布上的多个分镜节点。 */
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

/** 人设/场景/看板多图参考走 Ref2VA；单张作为成片第一帧才走 I2VA。 */
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
  const source = String(slot.sourceName || '').trim()
  const en = String(slot.name || '').trim()
  const zh = source && /[㐀-鿿]/.test(source) ? `「${source}」` : ''
  if (zh && (!en || /^Person\s+\d+$/i.test(en) || /^Place\s+\d+$/i.test(en))) return zh
  if (zh) return `${en}${zh}`
  if (source && source !== en) return `${en}「${source}」`
  return en || `reference ${slot.picture}`
}

/** 人物图用 (S1)(S2) 固定绑到对应 Picture。S 号跟人物走，不跟台词顺序走。 */
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

/** 用代码写死的图1/图2/图3 身份块覆盖模型稿；不依赖模型自觉写。 */
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
  // 清掉旧的 Reference pictures / 残缺图号段，再强制插入权威映射
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
 * 人物声音必须紧跟「图几是谁」写清楚：谁的声音是什么样，开口就按这个来。
 * 用代码插入，不依赖模型自觉，也不让旧稿里残缺的音色段落留在正文中间。
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
    // 图号块结束（遇到空行或正文起手）就停，别把正文里的图号也算进来
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

/** (S1) 永远是第一张人物图，不按台词先后重新编号。 */
function speakerCode(input: H3PromptInput, raw?: string): string {
  const people = characterPeople(input)
  const wanted = [bareSpeakerName(raw), bareSpeakerName(input.speakerName)].filter(Boolean)
  for (const name of wanted) {
    const hit = people.findIndex((slot) => {
      const src = bareSpeakerName(slot.sourceName)
      const en = bareSpeakerName(slot.name)
      return src === name || en === name || (!!src && (name.includes(src) || src.includes(name)))
    })
    if (hit >= 0) return `S${hit + 1}`
  }
  return 'S1'
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
  if (!lines.length || input.voiceMode === 'none') return 'No dialogue. No lips moving.'
  const cues = dialogueCuesForPrompt(input)
  const voiceTag = String(input.speakerVoice || '').trim().replace(/[；;]+$/, '')
  if (input.voiceMode === 'voiceover') {
    const spoken = lines
      .map((line, i) => {
        const cue = cues.find((item) => item.text === line) || cues[i]
        const code = speakerCode(input, cue?.speaker)
        return `(${code})${voiceTag ? `, voice: ${voiceTag}` : ''} says in an off-screen voiceover: ${h3SpokenTag(line)} ${quietOthers(input, code)}`
      })
      .join('\n\n')
    return `${spoken} The words inside the d tag are being called from off-screen; nobody on screen mouths them.`
  }
  const hint = englishOrOmit(input.speakerHint?.replace(/^\[|\]$/g, ''))
  return lines
    .map((line, i) => {
      const cue = cues.find((item) => item.text === line) || cues[i]
      const code = speakerCode(input, cue?.speaker)
      const extra = [i === 0 && voiceTag ? `voice: ${voiceTag}` : '', i === 0 ? hint : ''].filter(Boolean).join(', ')
      const lead = extra ? `(${code}), ${extra},` : `(${code})`
      return `${lead} says: ${h3SpokenTag(line)} ${quietOthers(input, code)}`
    })
    .join('\n\n')
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

/** 多模态参考：官方六段。人物绑定写在 subject_definitions，镜头正文从 [Shot 1] 开始。 */
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
  // 与可信台词不一致时：清空旧 <d>，再按可信列表重写，避免场记残留
  let cleaned = text.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '').trim()
  const extra = tags.join('\n\n')
  if (/\[\d{2}:\d{2}\.\d{3}\s*[–-]/i.test(cleaned)) {
    // 插到第一个时间轴段落后
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

/** 从节点原文里抠台词：只认 d 标签、引号、「台词/对白」行、喊出「…」。整段场记绝不拆成台词。 */
export function extractSpokenFromNotes(text: string): string[] {
  const raw = String(text || '')
  if (!raw.trim()) return []
  const fromTags = [...raw.matchAll(/<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/gi)]
    .map((m) => sanitizeDialogue(m[1] || ''))
    .filter((line) => line && !isPlaceholderSpokenLine(line) && looksLikeSpokenDialogue(line))
  if (fromTags.length) return [...new Set(fromTags)]

  const out = extractQuotedSpeech(raw)
  for (const match of raw.matchAll(/(?:^|\n)\s*(?:台词|对白|口播|旁白)\s*[：:]\s*(.+)$/gm)) {
    const body = String(match[1] || '').trim()
    if (looksLikeShotDirection(body)) continue
    const line = sanitizeDialogue(body)
    if (line && /[㐀-鿿]/.test(line) && !out.includes(line)) out.push(line)
  }
  for (const match of raw.matchAll(
    /(?:^|\n)\s*([\u3400-\u9fff]{1,8})(?:[（(][^）)\n]{0,16}[）)])?\s*[：:]\s*([^\n]+)/g
  )) {
    const label = String(match[1] || '').trim()
    if (/^(?:场景|音效|镜头|景别|时长|画风|站位|地点|道具|场记|画面|动作|运镜|机位|构图|环境|光影|备注|说明)$/.test(label)) {
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
  if (/没有台词|无对白|不说话|无口播|No dialogue/i.test(t)) return false
  if (/<d\s*>/i.test(t) && !/<d>\s*\[[^\]]+\]\s*(?:无|没有|无对白|none|N\/A)\s*<\/d>/i.test(t)) return true
  return /(?:喊出|喊道|叫道|叫着|轻声说|小声说|小声喊)/.test(t)
}

export function nodeTextForbidsSpeech(text: string): boolean {
  const t = String(text || '')
  if (extractSpokenFromNotes(t).length) return false
  return /没有台词|无对白|不说话|无口播|No dialogue/i.test(t)
}

function spokenLinesForPrompt(input: H3PromptInput): string[] {
  // 口播栏一旦有内容，它就是唯一台词来源。人物小传里的「欲望」「弧光」等引号
  // 不是对白，不能再从整包场记中二次抽取。
  if (input.voiceMode === 'none') return []
  const fromVo = spokenCueLines(input.voiceover || '')
  if (fromVo.length) return [...new Set(fromVo)]
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
  // 可信台词：口播栏 / 引号 / 「台词：」。没有就强制无对白，丢掉模型胡写的 <d>。
  const wanted = spokenLinesForPrompt(input)
  if (isStructuredShotBody(desc)) {
    let body = desc.trim()
    if (wanted.length) {
      const owned = dialogueCuesForPrompt(input).filter((cue) => wanted.includes(cue.text))
      const turnIssue = dialogueTurnIssue(body, owned.length ? owned : wanted.map((text) => ({ text })))
      const spokenTurns = [...body.matchAll(/\(S(\d+)\)[^<\n]{0,160}\b(?:says?|asks?|shouts?|replies?|exclaims?|yells?|whispers?)\b[\s\S]{0,80}<d>/gi)]
      const codesMatch = wanted.every((line, index) => {
        const cue = owned.find((item) => item.text === line) || owned[index]
        const code = speakerCode(input, cue?.speaker).replace(/^S/, '')
        return spokenTurns[index]?.[1] === code
      })
      if (turnIssue || !codesMatch || !/<d>\s*\[/i.test(body)) {
        body = `${body.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '').trim()}\n\n${dialogueBlocks(input, wanted)}`.trim()
      } else {
        body = ensureSpokenTags(body, wanted)
      }
    } else {
      body = sanitizeDTagContents(
        body
          .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
          .replace(/\bNo dialogue\.?\s*(No lips moving\.?)?/gi, '')
      )
      if (!/no dialogue/i.test(body)) body = `${body}\n\nNo dialogue. No lips moving.`.trim()
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
    body = /no dialogue/i.test(cleaned) ? cleaned : `${cleaned} No dialogue. No lips moving.`.trim()
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
    return `${base} No voices and no music.`
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
  if (/过肩/.test(t)) return 'over-the-shoulder'
  if (/俯/.test(t)) return 'slight high angle'
  if (/仰/.test(t)) return 'slight low angle'
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
  if (/钩子|开场|建立/.test(t)) return 'This beat establishes the space and the first visible tension.'
  if (/对峙|冲突/.test(t)) return 'This beat holds a confrontation; bodies stay charged, not idle.'
  if (/反应/.test(t)) return 'This beat is a reaction: face and breath change with what just happened.'
  if (/揭示/.test(t)) return 'This beat reveals new information through look and body, not exposition.'
  if (/转场/.test(t)) return 'This beat bridges the moment; motion and eyeline carry us forward.'
  if (/收口|结束/.test(t)) return 'This beat lands the scene; hold the last expression and let the frame breathe.'
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
          : /上摇|俯仰/.test(notedMove)
            ? 'tilt'
            : /横摇|摇镜|横移/.test(notedMove)
              ? 'pan'
              : 'static'
  const total = Number(durationText(input))
  const t0 = formatH3Timestamp(0)
  const tOpen = formatH3Timestamp(Math.min(1.2, Math.max(0.8, total * 0.2)))
  const tHold = formatH3Timestamp(Math.max(total - 0.8, total * 0.85))
  const tEnd = formatH3Timestamp(total)
  const lastBeat = Math.max(0.8, total - Number((total * 0.85).toFixed(2))).toFixed(2)
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
        : 'No one speaks in this range. Mouths stay closed.'
      if (index === 0) {
        return `[${start}–${end}]\n${openCam} ${who} in ${where}. ${blocking} ${eyes.replace(/\.$/, '.')}${moodBit} ${speech}`.trim()
      }
      if (index === plan.length - 1) {
        return `[${start}–${end}]\n${endCam} ${action} The action develops continuously and finishes naturally within ${lastBeat} seconds. ${speech}`.trim()
      }
      return `[${start}–${end}]\n${midCam} ${action} Lighting stays ${lighting}.${extraHint} ${speech}`.trim()
    })
    .join('\n\n')
  const body = `[Shot 1] ${styleLead(input.aesthetic)}, ${size}${angleBit}, ${compositionEn(input.aspectRatio)}. Clean low-noise digital cinema image, natural skin texture. ${who} in ${where}. One ${total.toFixed(0)}-second clip. Each spoken line belongs to exactly one (S#) and one time range. Listeners keep their lips closed.

${beats}

Camera language:
${size}. ${openCam} Then ${midCam} Then ${endCam}

Performance direction:
Keep faces, hair and clothes locked to the speaker pictures. One person speaks at a time. No subtitles, no visible text, no extra people.`
  return roster ? `${roster}\n\n${body}` : body
}

/** 空台词套话、脏稿或缺图号身份时，打开节点/出视频要重写。 */
export function compiledH3PromptNeedsRebuild(text: string | undefined): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (isLifelessH3Prompt(t)) return true
  if (/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*(?:无|没有|无对白|无台词|none|N\/A)\s*<\/d>/i.test(t)) {
    return true
  }
  if (/says(?: in an off-screen voiceover)?:\s*<d>\s*\[Chinese\]\s*无\s*<\/d>/i.test(t)) return true
  if (/Person 1 \(S1\) in Place 1\.\s*The camera holds a static shot\.\s*Gaze stays on the scene/i.test(t)) {
    return true
  }
  // 只有人物名单、没有 [Shot 1] 的空壳，或还在用旧的「图1 是人设」而没有 (S1) 绑定
  if (/integrated_multimodal_description\s*:/i.test(t) && !/\[Shot\s*1\]/i.test(t)) return true
  if (/subject_definitions\s*:/i.test(t) && !/\[Shot\s*1\]/i.test(t)) return true
  if (/is this person's character design/i.test(t) && !/\(S1\)\s+is\b/.test(t)) return true
  return false
}

/** 中文场面被清掉以后，如果正文里几乎没有英文镜头，就不能只剩人物名单。 */
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

/** 保留“谁说哪句”。旧逻辑只保留台词文字，多角色时模型无法建立独占口型。 */
function dialogueCuesForPrompt(input: H3PromptInput): DialogueCue[] {
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
  if (tags.length !== expected.length) return `台词标签数量应为 ${expected.length}，实际为 ${tags.length}`
  for (let i = 0; i < tags.length; i += 1) {
    const index = tags[i].index || 0
    const lead = desc.slice(Math.max(0, index - 260), index)
    if (!/\(S\d+\)[^.\n]{0,180}\b(?:says?|asks?|shouts?|replies?|exclaims?|yells?|whispers?)\b[^.\n]{0,120}[:，,]?\s*$/i.test(lead)) {
      return `第 ${i + 1} 句台词没有紧邻的唯一说话人 (S#) 和说话动作`
    }
  }
  return ''
}

/** 识别旧版“按模板填词”的无生机成片稿。 */
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

/** 按官方模式出最终提示词：多模态参考六段，首帧/首尾帧/尾帧/纯文本走三段加对齐句。中文场记不得进正文。 */
export function composeH3VideoPrompt(input: H3PromptInput): string {
  const source = stripFrameLead(input.prompt || '')
  const resolved = resolvePromptInput(input, source)
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
 * 只有真正的接口故障才应中断优化。模型偶发的 JSON、措辞或导演格式问题
 * 都可以由本地编译器降级成可提交稿，不能让用户因为质量启发式规则而卡住。
 */
function isLLMRequestFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /(?:\b401\b|\b403\b|\b408\b|\b409\b|\b429\b|\b5\d\d\b|鉴权|Authentication|api.?key|rate.?limit|限流|余额|timeout|timed out|网络|network|fetch failed|ECONN|ENOTFOUND|socket)/i.test(
    message
  )
}

/** 把中文场记编译成 H3 官方英文：integrated_multimodal_description + 内部切镜；失败则回退模板。 */
export async function compileH3OfficialPrompt(input: H3PromptInput): Promise<string> {
  const resolved: H3PromptInput = { ...input, forceIntegrated: input.forceIntegrated === true }
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
          content: `MiniMax / Seedance용 샷 영상 프롬프트를 작성하세요. JSON만 출력하세요.
{"integrated_multimodal_description":"...","overall_soundscape":"..."}

생성할 클립은 한 개입니다. 필드 형식을 지키면서 장면을 상투적인 틀로 채우지 마세요. 먼저 극적 사건을 읽고 그 사건 고유의 동작과 감정의 인과관계에 맞게 샷을 구성하세요.

필수 출력 구조
1) 화자와 참조 이미지의 대응 블록을 원문 그대로 복사해 시작하세요. (S1)은 언제나 첫 번째 캐릭터 이미지, (S2)는 두 번째 이미지입니다. 대사 순서에 따라 번호를 바꾸거나 (S#) 대신 图1 또는 “this person's character design”을 쓰지 마세요.
(S1) is 「中文名」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「中文名」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「场景名」. Lock space, materials, weather and light.
Only one (S#) speaks at a time. Everyone else keeps their lips completely closed.
이 이미지는 인물과 장소를 고정하는 참조입니다. “Picture 1 is the first frame” 또는 “Picture 1 aligns with 0.00 seconds”라고 쓰지 마세요.

2) 대응 블록 뒤에 [Shot 1]을 쓰세요. 컷, 구도 변경, 드러남, 충격, 극적 초점의 변화가 실제로 필요할 때만 [Shot 2] At 00:SS.mmm과 [Shot 3]을 추가하세요. 조용한 반응은 한 샷으로 유지할 수 있습니다. 문에서 책상으로 이동하는 동작, 초자연적 존재의 등장, 추격, 격투, 대규모 효과에는 대개 구도 변화가 필요합니다. 시작, 중간, 유지 구간으로 기계적으로 나누지 마세요.

3) 이 장면에 고유하고 눈에 보이는 인과관계를 만드세요. 시작 시 물리적 상태 -> 계기 -> 즉각적인 신체 반응 -> 목적이 있는 동작 -> 보이는 결과 -> 다음 샷으로 이어질 최종 상태 순입니다. 실제 문, 스위치, 열쇠고리, 조각상, 옷장, 빗물이 흘러내리는 창문, 무기, 잔해, 그 밖의 소품을 명시하세요. 필요하면 빛이 깜빡이거나 천이 끌리거나 비에 젖은 곳의 반사가 움직이거나 먼지가 일거나 가구가 흔들리거나 소리가 달라지도록 환경의 반응을 쓰세요. 모든 문장은 촬영할 수 있는 것을 묘사해야 합니다.

4) 카메라는 관객이 새로 알아차릴 내용에 따라 움직여야 합니다. 어디에서 시작하고 어떤 동작이나 발견 때문에 움직이며 전경과 배경의 시차나 초점이 어떻게 바뀌고 어디에 도달하는지 쓰세요. 제공된 카메라 움직임 유형은 선호 사항입니다. 정지는 정적이 긴장을 만들 때만 쓰고, 모든 박자마다 카메라 고정 문구를 반복하지 마세요. “no pan, tilt, or zoom”을 전진, 후진, 팬, 틸트 또는 아크 이동과 함께 쓰지 마세요.

5) 감정의 이름 대신 눈에 보이는 행동과 변화를 통해 연기를 지시하세요. 무게가 실린 걸음, 한 박자 늦은 시선, 스위치를 빗나가는 손끝, 멎는 호흡, 풀리는 어깨, 악무는 턱, 소리를 향해 옮겨 가는 주의가 그 예입니다. 해당 박자에서 구체적인 감정을 이끌어 내세요. 분노를 매번 “cold and controlled”로 쓰거나 “faces show a specific reaction”, “play the emotional change”, “hold the last expression and let the frame breathe” 같은 일반적인 지시를 쓰지 마세요.

6) 참조 인물마다 장면에 명시된 상태를 따르세요. 살아 있는 인물, 조각상, 초상화, 반사, 그림자, 화면 밖 음성, 숨은 존재, 화면에 없는 인물을 위한 참조 중 무엇인지 구분하세요. 인물 참조가 있다고 해서 그 인물이 살아 있는 몸으로 현장에 있는 것은 아닙니다. 동작에서 변신이 명시되지 않았다면 같은 인물을 사람과 소품으로 중복 등장시키지 마세요.

7) 대사는 <d> 안에만 넣으세요. 신뢰할 수 있는 각 대사를 지정된 (S#)이 자기 구간에서 한 번만 말합니다. 두 사람이 동시에 말하거나 다른 인물이 같은 대사를 반복하지 않게 하세요. 다음 형식을 사용하고, 한국어 대사는 [Korean], 중국어 대사는 [Chinese]로 표시하세요. 대사는 번역하지 마세요.
(S1) says: <d>[Chinese] 原词</d> Only (S1) speaks in this shot. (S2) keeps their lips completely closed and makes no voice.
태그에는 실제 발화만 넣으세요. 현장 기록, 타임스탬프, 스타일, 이미지 라벨, 카메라 지시를 <d>에 넣지 마세요. 화자 표시가 없는 <d> 태그를 쓰지 마세요. 듣는 사람은 배치된 위치에서 입을 다뭅니다. 사용자가 시간을 명시했고 대사가 그 안에 들어가면 말이 빠르다는 이유만으로 클립을 나누지 마세요.

타임라인 작성 기준
- 사용자가 시간을 지정했으면 따르세요. 지정하지 않았다면 전체 길이를 동작과 대사에 맞춰 나누고 세 등분하지 마세요.
- 구간마다 촬영할 수 있는 문장 2–4개를 쓰세요. 개요보다는 구체적이고 대본 문단보다는 짧고 명확하게 쓰세요.
- 인물이 전경인지 배경인지, 왼쪽인지 오른쪽인지, 앉아 있는지 서 있는지, 정확히 누구를 보는지 끝까지 유지하세요. 이야기가 명시적으로 요구할 때만 카메라를 보게 하세요.
- 표정은 보이는 계기로 바뀌어야 합니다. 시선이 다시 초점을 맞추고, 눈썹에 힘이 들어가거나 풀리고, 턱이 굳고, 숨이 멎고, 손이 머뭇거리거나, 체중이 이동하는 식입니다. 행동 없이 감정의 이름만 쓰지 마세요.
- 구간당 주요 카메라 움직임은 최대 한 가지입니다. 손동작, 시선, 뜻밖의 발견이나 감정 전환으로 동기를 만들고 시작점과 도착점을 쓰세요. 명시적인 컷이 필요한 경우를 제외하고 화면 방향과 축을 유지하세요.
- 이야기와 관련된 의상, 소품, 빛, 환경의 움직임만 언급하세요. 박자마다 전체 캐릭터 설정을 반복하지 마세요.
- 모든 구간에서 사건이 진행되어야 합니다. 의미 없는 포즈, ‘옷과 공기가 움직인다’ 같은 포괄적 문구, 참조 이미지를 슬라이드처럼 나열하는 구성을 피하세요.

규칙
- 원본 자료와 참조 이미지에 있는 대상만 등장시킬 수 있습니다. 여기에 없는 인물, 동물, 물건, 사건을 추가하지 마세요. 관용구, 우화, 문화적 연상을 문자 그대로 구현하지 마세요. 예를 들어 원문에 없는 거북이, 경주, 동화 같은 연출을 토끼에 붙이지 마세요. 원본이 간결하면 참조 속 대상이 참조 장소와 스타일에서 요청받은 행동만 하도록 연출하세요. 영상 길이를 채우려고 서사를 만들지 마세요.
- 사용자가 지정한 사건을 보존하세요. 대본이 명확히 암시하는 내용만 확장하고 다른 사건이나 새 인물을 만들지 마세요.
- 참조 이미지가 있으면 그 그림체가 기준입니다. 표현 매체, 색상, 질감, 캐릭터 디자인을 정확히 맞추세요. 위 Style 항목이 충돌하면 무시하세요. 대상의 표현 매체를 실사, CG, 상투적인 영화풍 등으로 바꾸지 마세요.
- 완성된 움직이는 화면을 설명하는 감독처럼 직접적이고 단호하게 쓰세요. 출력 형식은 글을 담는 구조이며 문장을 반복하는 틀이 아닙니다.
- 생성 모델로 전달하는 동작, 카메라, 조명, 연기는 영어로 쓰세요. 중국어는 <d> 내부와 화자 대응 블록의 「원문 이름」 안에서만 허용합니다. 다른 중국어는 삭제되어 장면 설명을 중국어로 쓰면 인물 목록만 남게 됩니다. 누가 왼쪽이나 오른쪽에 있는지, 무엇을 들고 있는지, 소품이 시간에 따라 어떻게 바뀌는지 영어로 쓰세요.
- 동작 문장 속 인물은 대응 블록에 정의한 (S1), (S2)로 정확히 부르세요. 문장마다 새 S 번호를 만들거나 아는 인물을 “the man”으로 뭉뚱그리지 마세요. 반복 소품은 대응 블록의 (P#)와 <Picture N>을 유지하고 손이 소품을 만질 때 해당 이미지를 명시하세요.
- 아래에서 추출한 발화만 대사로 쓰세요. 목록이 비어 있으면 No dialogue. No lips moving.이라고 쓰세요. 현장 기록, 타임스탬프, 스타일이나 화자 대응 블록에서 발화를 만들지 마세요. d 태그 안에 无나 감독 메모를 넣지 마세요.
- integrated_multimodal_description의 첫머리에 아래 화자 대응 블록을 원문 그대로 복사하세요. (S1)/(S2)/<Picture N>을 만들거나 빼거나 순서를 바꾸지 마세요.
- overall_soundscape에는 대본의 실제 소리를 쓰세요. 과자가 부서지는 소리, 쿠션이 스치는 소리, 실내 잔향처럼 구체적으로 쓰세요. “close breath stay synchronized with the picture. Spoken words appear only inside the d tag.”처럼 일반적인 문장은 쓰지 마세요.
- 전달 형식은 앱이 선택합니다. 샷 본문만 쓰세요. 멀티모달 참조(R2VA)는 subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music 여섯 부분으로 감싸집니다. 시작 프레임(I2VA), 시작·끝 프레임(FL2VA), 끝 프레임(L2VA), 텍스트 전용(T2VA)은 세 필드를 유지하며 공식 정렬 문구가 JSON 바깥에 붙습니다. 해당 제목을 출력하지 마세요.
- 화면에 격자, 4면 설정 이미지, 스토리보드, 콜라주, 캡션, 자막, 라벨을 표시하지 마세요.
- 시각 설명의 끝에 다음 문장을 한 번 쓰세요. The complete action develops continuously and finishes naturally within ${durationText(resolved)} seconds.
- overall_soundscape는 화면의 시간 순서를 따르며 각 동작과 정확히 동기화된 소리를 명시하세요. 환경음과 물리적인 소리만 영어로 쓰세요. 대사는 d 태그에 있으므로 다시 인용하지 마세요. 음악을 추가하지 마세요.
- non_diegetic_music은 항상 N/A입니다.
JSON을 반환하기 전에 초안에 상투적인 시간 구간, 반복되는 카메라 고정 지시, 카메라 지시의 모순, 잘못된 물리적 형태로 나타난 참조 인물, 이유 없는 클로즈업, 의미 없는 포즈, 보이는 움직임과 무관한 효과음이 있으면 조용히 폐기하고 다시 작성하세요.`
        },
        {
          role: 'user',
          content: `${importedDirectorForH3()}Style: ${resolved.aesthetic || 'Cinematic'} (when reference pictures are supplied, their art style overrides this line)
Duration: ${durationText(resolved)}s
Aspect: ${resolved.aspectRatio || '16:9'} (${String(resolved.aspectRatio || '16:9') === '9:16' ? 'vertical portrait, taller than wide' : String(resolved.aspectRatio || '16:9') === '1:1' ? 'square' : 'horizontal landscape, wider than tall'})
Camera preference (override it when the event needs a motivated reframe or cut): ${camera}
Scene / light: ${[englishOrOmit(resolved.sceneLighting), englishOrOmit(resolved.sceneAnchor), englishOrOmit(resolved.sceneDescription)].filter(Boolean).join(' / ') || 'from director notes'}
Available character identity references. (S1) stays (S1) for the whole clip. Do not assume every one is a living body in this beat; infer the actual visible form from the scene:
${characterPeople(resolved).map((slot, i) => `(S${i + 1}) = ${slot.sourceName || slot.name} = <Picture ${slot.picture}>`).join('\n') || onScreenEnglish(resolved).map((name, i) => `(S${i + 1}) = ${name}`).join('\n') || '(from director notes)'}
MUST COPY this speaker lock verbatim (identity/location lock, not first frames):
${pictureRoster(resolved) || 'no extra pictures'}
Voice mode: ${cueLines.length ? resolved.voiceMode || 'dialogue' : 'none — no trusted spoken lines; do NOT invent dialogue'}
Character voice (this speaker's own timbre, kept verbatim as delivery inside each <d> bracket; do not reinterpret or translate it away): ${resolved.speakerVoice || '(not set — infer a natural timbre that fits the character)'}
Spoken lines already extracted (quotes / 台词 / 口播栏 only; director notes are NOT speech):
${cueLines.length ? cueLines.map((line, i) => `${i + 1}. ${line}`).join('\n') : '(none — write No dialogue. No lips moving.)'}
Dialogue ownership recovered from the source (each item is one exclusive turn; preserve this order):
${dialogueCues.length ? dialogueCues.map((cue, i) => `${i + 1}. (${speakerCode(resolved, cue.speaker)}) speaker=${cue.speaker || 'unassigned'} | words=${cue.text}`).join('\n') : '(none)'}
Sound notes: ${englishOrOmit(resolved.audioDescription) || '(from the node text)'}
NODE MATERIAL TO DIRECT (source of truth for event, props, blocking and continuity; 场记/时长/画风 are not speech):
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
    let desc = String(parsed.integrated_multimodal_description || parsed.detailed_description || '').trim()
    if (/overall_soundscape\s*:/i.test(desc)) {
      desc =
        extractField(desc, 'integrated_multimodal_description') ||
        extractField(desc, 'detailed_description') ||
        desc
    }
    let sound = String(parsed.overall_soundscape || '').trim()
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
            content: `거절된 샷 영상 프롬프트를 다시 작성하고 JSON만 출력하세요. {"integrated_multimodal_description":"...","overall_soundscape":"..."}.
이전 초안은 반복 가능한 타이밍 틀을 사용했거나 카메라 고정 지시를 반복했거나 실제 사건을 보존하지 못해 생동감이 없었습니다.
움직이는 화면 자체를 쓰세요. 화자 대응 블록과 신뢰할 수 있는 대사 원문을 보존하세요. (S1)은 클립 전체에서 첫 번째 캐릭터 이미지입니다. 원본 자료와 참조 이미지에 있는 대상만 등장시킬 수 있습니다. 인물, 동물, 사건을 추가하지 말고 관용구나 우화를 문자 그대로 구현하지 마세요. 참조 이미지와 시각 스타일을 정확하게 맞추세요. 이름을 명시한 소품, 동기 있는 카메라 변화, 관찰 가능한 연기, 환경의 반응과 눈에 보이는 최종 상태로 구체적인 인과관계를 구성하세요. 각 대사에 별도의 시간 구간을 배정하세요. 시작, 중간, 유지로 기계적으로 나누지 마세요. 조각상, 초상화, 반사, 숨은 존재, 화면 밖 인물을 살아 있는 몸으로 표현하지 마세요. 생성 모델에 전달할 동작 서술은 영어로 쓰세요. 중국어는 「이름」과 신뢰할 수 있는 <d> 대사 안에서만 허용됩니다. 중국어 장면 본문은 삭제됩니다.

한 번에 한 사람만 말하게 하세요. 모든 <d> 바로 앞에 고정된 (S#)와 says/asks/replies를 붙이세요. 형식은 다음과 같습니다. (S1) says: <d>[Chinese] 原词</d> Only (S1) speaks in this shot. (S2) keeps their lips completely closed. 한국어 대사는 [Korean]으로 표시하고 대사 원문을 유지하세요. 화자 표시 없는 <d>를 쓰지 마세요. 대사가 빠르다는 이유만으로 클립을 나누지 마세요.

프롬프트를 간결한 영화 타임라인으로 다시 구성하세요. 네 줄짜리 개요나 빽빽한 대본 문단으로 쓰지 마세요. 구간마다 촬영 가능한 문장 2–4개를 쓰고 구도나 동기가 있는 카메라 이동 한 가지, 인물의 동작과 시선, 계기에 따른 표정 변화, 듣는 인물의 배치와 반응, 대사가 있다면 그 대사를 포함하세요. 전경과 배경, 왼쪽과 오른쪽의 위치 및 카메라 축을 유지하고 아무도 렌즈를 응시하지 않게 하세요. 이야기에 필요한 소품, 조명, 환경의 움직임만 사용하세요. 모든 구간에서 눈에 보이게 사건을 진행하세요. ${durationText(resolved)}초 안에 동작이 끝난다는 전체 마무리 문장을 마지막에 한 번 쓰세요.`
          },
          {
            role: 'user',
            content: `${importedDirectorForH3()}Speaker lock (copy verbatim):
${pictureRoster(resolved) || 'no extra pictures'}

Trusted dialogue:
${cueLines.length ? cueLines.join('\n') : '(none; no dialogue and no lips moving)'}

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
      desc = String(parsed.integrated_multimodal_description || parsed.detailed_description || '').trim()
      sound = String(parsed.overall_soundscape || '').trim()
    }
    // 第二稿不再被质量启发式规则硬拦截。它们适合触发一次修稿，但不适合
    // 判定用户完全无法继续；模型稿只要有正文，就交给后面的确定性清洗器。
    if (!desc) return composeH3VideoPrompt(resolved)
    // 台词以入口 cueLines / voiceover 为准；禁止因模型乱写 <d> 就强行改成 dialogue
    const trusted = spokenLinesForPrompt(resolved)
    const resolvedWithSpeech: H3PromptInput = {
      ...resolved,
      voiceMode: trusted.length
        ? resolved.voiceMode === 'none'
          ? 'dialogue'
          : resolved.voiceMode || 'dialogue'
        : 'none',
      voiceover: trusted.length ? trusted.join('\n') : ''
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
    throw new Error(`사용 가능한 영상 샷 프롬프트를 생성하지 못했습니다. ${reason || '请重试'}`)
  }
}
