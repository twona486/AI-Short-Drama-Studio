/**
 * 分镜生成服务
 *
 * 输入：文案 + 主题 + 风格 + 镜头时长
 * 输出：StoryboardResult（含导演式策划字段）
 *
 * 走真实 LLM，以现场短视频编导身份拆能拍的镜头；
 * 失败/未配置则走演示数据
 */

import { callLLM, getAIMode, type LLMMessage, type LLMContentPart } from './client'
import { PLAY_LLM_TIMEOUT_MS, isAbortError, isTimeoutAbort, throwIfAborted } from './abort'
import { mockStoryboardFromPrompt } from './mock'
import type { Scene, Script, Shot, ShotAudioMode, StoryProp, Subject, VisualStyle } from '@/types'
import { directorPlaybookText, importedDirectorPrefix } from '@/services/settings/directorSkill'
import { getLlmConfig, getVideoPromptStyle } from './runtime'
import {
  buildStyleBriefForLLM,
  extractUserMediumPhrase,
  lookFromTexts,
  promptMentionsStyle,
  resolveVisualStyle,
  styleLabel,
  VISUAL_STYLE_GUIDE
} from '@/utils/visualStyle'
import { normalizeCameraMovement, synthesizeVideoPerformance, isVideoPerformanceTemplate, videoPerformanceIssue, videoPerformanceSpec, videoPromptJsonHint } from '@/utils/shotPrompt'
import { extractJsonText, parseJsonRobust } from '@/utils/jsonRepair'
import { boundSubjectIds, inferSubjectsFromText, shotCastText, subjectMatchKeys } from '@/utils/consistency'
import { sceneConflictsWithShot, shotMentionsScene } from '@/utils/shotPlace'
import { isPlaceholderSpokenLine } from './dialogue'
import { mergeContinuedPlay } from '@/utils/playContinue'
import {
  extractPlayDirectives,
  extractSceneSlice,
  extractLocationsFromPlay,
  extractPlayForSceneStage,
  extractSubjectsFromPlay,
  keepRecurringProps,
  propsListedInPlay,
  isFieldLabelName,
  looksLikeFilmChapterPlay
} from '@/utils/scriptMarkdown'

export interface StoryboardInput {
  topic: string
  content: string
  style: VisualStyle
  shotDuration: number
  /** 当前所选视频模型允许的单镜最长时长。导演应优先在此范围内完成连续动作。 */
  maxShotDuration?: number
  aspectRatio: string
  /** 文案关键词（若有） */
  keywords?: string[]
  /** 产品/主题参考图（data URL 或公网 URL），最多 5 张，电商带货时以产品为准 */
  productImages?: string[]
  /**
   * extract：content 已是完整剧本，只提炼人物/场景/分镜节点
   * full：兼容旧的一步到位（尽量少用）
   */
  mode?: 'extract' | 'full'
  /** write：从草稿写完整剧本；continue：保留已有场次往后加 */
  playMode?: 'write' | 'continue'
  /** 续写方向，例如「再写两场，写父亲回家之后」 */
  continueHint?: string
  /** 覆盖设置页当前主 LLM，须是设置里已保存的模型名 */
  model?: string
  signal?: AbortSignal
  /** 提炼模式分阶段交付；每完成一步立即持久化，后续失败不回滚。 */
  onExtractStage?: (
    stage: 'subjects' | 'scenes' | 'shots',
    partial: StoryboardResult,
    meta?: { partial?: boolean; completed?: number; total?: number }
  ) => void | Promise<void>
  /** 失败重试时从未完成的阶段继续，避免重复提炼已落库内容。 */
  extractStartAt?: 'subjects' | 'scenes' | 'shots'
  /** 一次用户操作只完成一个阶段。 */
  extractStopAfter?: 'subjects' | 'scenes' | 'shots'
  existingSubjects?: Subject[]
  existingScenes?: Scene[]
  /** 原创电影章节：按场次/蒙太奇拆，不压成短视频口播表。 */
  workflowMode?: Script['workflowMode']
  /** 用户导入的成稿：只按原文切镜头，禁止改写对白和情节。 */
  verbatim?: boolean
  /**
   * 用户要的成片总时长（秒）。这是分镜数量的硬预算：
   * 剧本和分镜都按它反推规模，避免「要 40 秒却拆出 20 镜」。
   */
  targetDurationSec?: number
  /**
   * 断点续跑：按工作包序号给已完成的分镜结果，执行时直接跳过这些小组，不再调模型。
   * 数组须与 buildShotWorkBatches 对同一份剧本的切分一致（剧本文本没变时天然一致）。
   */
  resumeBatchShots?: Array<Record<string, unknown>[] | undefined>
  /** 每个小组真实完成（含跳过）时回调，供调用方写断点标记。 */
  onBatchDone?: (index: number, shots: Record<string, unknown>[], model?: string) => void
}

function isFilmChapterInput(input: Pick<StoryboardInput, 'workflowMode' | 'content'>): boolean {
  return input.workflowMode === 'film-chapter' || looksLikeFilmChapterPlay(input.content || '')
}

function shotDurationLimit(input: Pick<StoryboardInput, 'maxShotDuration'>): number {
  return Math.max(5, Math.min(30, Math.round(Number(input.maxShotDuration) || 15)))
}

/** 成片总时长允许比用户要求多 10 秒或少 10 秒。超出这个窗口必须打回。 */
export const DURATION_TOLERANCE_SEC = 10
const MIN_SHOT_SEC = 5
const DURATION_REPAIR_ROUNDS = 2

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

function cnSmallNumber(raw: string): number {
  const text = raw.replace(/\s+/g, '')
  if (!text) return 0
  if (text === '十') return 10
  if (text.startsWith('十')) return 10 + (CN_DIGIT[text.slice(1)] || 0)
  const ten = text.indexOf('十')
  if (ten >= 0) {
    const high = CN_DIGIT[text.slice(0, ten)] || 1
    const low = text.slice(ten + 1)
    return high * 10 + (low ? CN_DIGIT[low] || 0 : 0)
  }
  return CN_DIGIT[text] || 0
}

function acceptDuration(seconds: number): number {
  const n = Math.round(seconds)
  return n >= 10 && n <= 1800 ? n : 0
}

/** 从一小段里读出秒数：30秒、30s、1分20秒、1.5分钟、三十秒、半分钟。 */
function secondsFromPhrase(phrase: string): number {
  const text = phrase.replace(/\s+/g, '')
  if (!text) return 0
  if (text.includes('半分钟')) return 30
  const minSec = text.match(/(\d+)(?:分|분)(\d+)(?:秒|초)/)
  if (minSec) return acceptDuration(Number(minSec[1]) * 60 + Number(minSec[2]))
  const minutes = text.match(/(\d+(?:\.\d+)?)(?:分钟|분)/)
  if (minutes) return acceptDuration(Number(minutes[1]) * 60)
  const seconds = text.match(/(\d+)(?:秒|秒钟|초|s)/i)
  if (seconds) return acceptDuration(Number(seconds[1]))
  const cnMin = text.match(/([一二两三四五六七八九十]+|半)分钟/)
  if (cnMin) {
    if (cnMin[1] === '半') return 30
    return acceptDuration(cnSmallNumber(cnMin[1]) * 60)
  }
  const cnSec = text.match(/([一二两三四五六七八九十]+)秒/)
  if (cnSec) return acceptDuration(cnSmallNumber(cnSec[1]))
  return 0
}

const DURATION_PHRASE =
  '((?:半分钟)|(?:\\d+\\s*(?:分|분)\\s*\\d+\\s*(?:秒|초))|(?:\\d+(?:\\.\\d+)?\\s*(?:分钟|분))|(?:\\d+\\s*(?:秒|秒钟|초|s))|(?:[一二两三四五六七八九十]+\\s*分钟)|(?:[一二两三四五六七八九十]+\\s*秒))'

function labeledDuration(text: string): number {
  const primary = new RegExp(
    `(?:总时长|成片时长|目标成片|成片|全片|整片|总共|一共|控制在|做成|拍成|建议时长|目标时长|视频时长)\\s*[:：是为]?\\s*(?:约|大概|大约)?\\s*${DURATION_PHRASE}`,
    'gi'
  )
  let hit: RegExpExecArray | null
  while ((hit = primary.exec(text))) {
    const n = secondsFromPhrase(hit[1] || '')
    if (n) return n
  }
  const filmed = text.match(
    new RegExp(`${DURATION_PHRASE}\\s*(?:左右|以内|정도|이내|짜리)?\\s*(?:的)?\\s*(?:短剧|短片|视频|成片|短电影|숏드라마|단편|영상)`, 'i')
  )
  if (filmed) {
    const n = secondsFromPhrase(filmed[1])
    if (n) return n
  }
  const secondary = new RegExp(`时长\\s*[:：]?\\s*(?:约|大概|大约)?\\s*${DURATION_PHRASE}`, 'gi')
  while ((hit = secondary.exec(text))) {
    const prefix = text.slice(Math.max(0, hit.index - 2), hit.index)
    if (prefix === '单镜' || prefix === '每镜') continue
    const n = secondsFromPhrase(hit[1] || '')
    if (n) return n
  }
  return 0
}

function bareDuration(text: string): number {
  if (text.length > 600) return 0
  const hit = text.match(new RegExp(DURATION_PHRASE, 'i'))
  return hit ? secondsFromPhrase(hit[1] || hit[0]) : 0
}

/** 从用户原话里认「约 40 秒 / 40s / 30S / 1 分钟 / 三十秒」这类目标总时长。认不出返回 0。 */
export function extractTargetDurationSec(...texts: Array<string | undefined | null>): number {
  for (const text of texts) {
    const raw = String(text || '').trim()
    if (!raw) continue
    const labeled = labeledDuration(raw)
    if (labeled) return labeled
    const bare = bareDuration(raw)
    if (bare) return bare
  }
  return 0
}

export function totalShotDuration(shots: Array<{ duration?: number }>): number {
  return shots.reduce((sum, shot) => sum + Math.max(0, Math.round(Number(shot.duration) || 0)), 0)
}

/** 总时长不在目标 ±10 秒内时返回必须打回的原因；合格返回空字符串。 */
export function durationWindowIssue(totalSec: number, targetSec: number): string {
  const target = Math.round(Number(targetSec) || 0)
  if (target < 10) return ''
  const total = Math.round(totalSec)
  if (Math.abs(total - target) <= DURATION_TOLERANCE_SEC) return ''
  const lo = target - DURATION_TOLERANCE_SEC
  const hi = target + DURATION_TOLERANCE_SEC
  const delta = total - target
  return `심각: 완성 영상이 ${total}초로 목표 ${target}초의 허용 구간인 ${lo}–${hi}초(±${DURATION_TOLERANCE_SEC}초)를 벗어났습니다. 현재 ${Math.abs(delta)}초 ${delta > 0 ? '초과했습니다' : '부족합니다'}. 샷을 재구성해 전체 duration 합을 허용 구간에 맞추세요. 길면 같은 장소와 캐릭터가 이어지는 샷을 합쳐 줄이고, 짧으면 기존 샷을 늘리세요. 시간을 맞추기 위해 핵심 줄거리를 삭제하지 마세요.`
}

/**
 * 按模型单镜上限把成片时长切成小组。
 * 30 秒、单镜最长 15 秒 → [15, 15]，两个小组各出 15 秒。
 */
export function durationSlices(targetSec: number | undefined, maxShotSec?: number): number[] {
  const target = Math.round(Number(targetSec) || 0)
  if (target < 10) return []
  const maxShot = Math.max(MIN_SHOT_SEC, Math.min(30, Math.round(Number(maxShotSec) || 15)))
  const slices: number[] = []
  let left = target
  while (left > 0) {
    const take = Math.min(maxShot, left)
    slices.push(take)
    left -= take
  }
  if (slices.length >= 2 && slices[slices.length - 1] < MIN_SHOT_SEC) {
    const tail = slices.pop() || 0
    const prev = slices[slices.length - 1]
    if (prev + tail <= maxShot) slices[slices.length - 1] = prev + tail
    else slices.push(MIN_SHOT_SEC)
  }
  return slices
}

/**
 * 目标总时长 → 分镜小组数。一组对应用模型最长的一镜。
 * 30 秒、最长 15 秒 → 2 组，不是按 5 秒一镜拆成 8 组。
 */
export function shotBudgetFromDuration(targetSec: number | undefined, maxShotSec?: number): number {
  return durationSlices(targetSec, maxShotSec).length
}

function isLongFormPlay(input: Pick<StoryboardInput, 'workflowMode' | 'content'>, play = ''): boolean {
  const text = play || input.content || ''
  if (input.workflowMode === 'film-chapter') return true
  if (/建议时长[：:\s]*\d+\s*[—\-～~]?\s*\d*\s*分钟/.test(text)) return true
  const scenes = [...text.matchAll(/^##\s+场景[一二三四五六七八九十百0-9]/gm)]
  return scenes.length >= 5
}

export interface StoryboardShot {
  /** 简短标题（3-8 字） */
  title: string
  /**
   * 详细视觉描述（中文，5-8 句）
   * 必须含：场景主锚与光线、角色站位朝向、动作、景别运镜、道具焦点、气氛
   */
  visualPrompt: string
  /** 视频内容表现：谁做什么、说什么、镜头怎么走（中文，禁止复用 visualPrompt） */
  videoPrompt?: string
  /** 音效描述（中文短句） */
  audioDescription: string
  /** 口播文案（中文） */
  voiceover: string
  audioMode?: ShotAudioMode
  speakerHint?: string
  /**
   * 本镜说话角色的音色描述。从人物节点的 voicePrompt 自动绑定，
   * 生成视频和后期配音时都会带上，保证同一角色全片一个声线。
   */
  speakerVoice?: string
  /** 时长（秒，5-10） */
  duration: number
  /** 镜头运动 */
  cameraMovement: Shot['cameraMovement']
  /** 本镜出场主体 id（对应 subjects[].id） */
  subjectIds?: string[]
  /** 本镜场景 id（对应 scenes[].id） */
  sceneId?: string
  purpose?: string
  shotSize?: string
  blocking?: string
  eyeline?: string
  continuity?: string
  propFocus?: string
}

export interface StoryboardResult {
  /** 项目级整体氛围（中文，1-2 段） */
  aesthetic?: string
  h3Aesthetic?: string
  styleBrief?: string
  colorPalette?: string
  lightingNote?: string
  /** 整片锁定的主体（人物/动物），后续先出人设图 */
  subjects?: Subject[]
  /** 剧本里至少出现两次的道具，后续出多角度图 */
  props?: StoryProp[]
  /** 整片锁定的场景底板 */
  scenes?: Scene[]
  shots: StoryboardShot[]
}

export type StoryboardSource = 'real' | 'mock' | 'mock-fallback'

export interface StoryboardRunResult {
  result: StoryboardResult
  source: StoryboardSource
  error?: string
  model?: string
}

const log = (msg: string) =>
  console.log('%c[storyboard]', 'color:#7c3aed;font-weight:600', msg)

/**
 * 从主题 + 文案中抽出用户自己写的画风/美学指令（最高优先级）
 * 主题整段一律视为画风圣经；文案开头与含画风词的句子一并保留。
 */
export function extractUserStyleAuthority(
  topic: string,
  content: string,
  keywords?: string[]
): string {
  const parts: string[] = []
  const t = topic.trim()
  // 主题整段保留：用户常在主题里写清画风/美学
  if (t) parts.push(t)

  const styleCue =
    /风格|画风|美学|视觉|调色|氛围|质感|电影|动画|动漫|二次元|写实|摄影|渲染|油画|水彩|像素|水墨|赛博|蒸汽|复古|胶片|手绘|插画|国风|武侠|奇幻|暗黑|明亮|赛璐璐|厚涂|扁平|3d|C4D|Blender|真人|纪实|灯笼|汉服|商业|广告|grain|cinematic|anime|wuxia|hanfu|aesthetic|lighting|mist|commercial/i

  const contentLines = content
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)

  // 文案前 2 行常含画风/设定，优先纳入
  for (const line of contentLines.slice(0, 2)) {
    if (!parts.includes(line)) parts.push(line)
  }

  const sentences = content
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && styleCue.test(s))
  for (const s of sentences.slice(0, 10)) {
    if (!parts.includes(s)) parts.push(s)
  }

  const kws = (keywords ?? []).map((k) => k.trim()).filter(Boolean)
  if (kws.length) parts.push(`关键词：${kws.join('、')}`)

  return parts.join('\n')
}

function buildStylePriorityBlock(input: StoryboardInput): string {
  const userAuth = extractUserStyleAuthority(input.topic, input.content, input.keywords)
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const fallback = buildStyleBriefForLLM(look.style)
  const mediumPhrase = extractUserMediumPhrase(input.topic, input.content, ...(input.keywords ?? []))

  if (mediumPhrase) {
    return `[Use the user's specified style]
The user supplied a visual style. Show it through visible objects instead of a separate technical paragraph.

User-supplied style wording (mention it once): 「${mediumPhrase}」

Original topic and style
"""
${userAuth}
"""

Write every visualPrompt as filmable shot description in English.
1. Describe visible ground, buildings, water, plants, sky, and props from near to far.
2. Show movement in water, wind, fabric, smoke, and dust. Explicitly describe stillness when appropriate.
3. State where light comes from and where the shadows fall.
4. Specify the person's clothes, hands and feet, orientation, objects in hand, and present action.
5. Mention ${mediumPhrase} naturally once and attach techniques to visible objects. Do not start with just ${mediumPhrase} and a blocking list or end with generic style boilerplate.
${
  look.matched
    ? `6. Follow these requirements when depicting physical objects in this medium: ${VISUAL_STYLE_GUIDE[look.matched].mustInclude}。${VISUAL_STYLE_GUIDE[look.matched].avoid}`
    : `6. Describe objects with the materials and texture of ${mediumPhrase}. Do not impose the dropdown's style.`
}`
  }

  if (userAuth) {
    return `[Follow the user's look]
Original topic: preserve its mood; no medium was specified.
"""
${userAuth}
"""

Use the dropdown medium (current selection: ${styleLabel(input.style)} / ${input.style}）：
${fallback}`
  }

  return `[Visual style] Use the dropdown style when the premise does not specify one.
${fallback}`
}

export { repairJsonLocally } from '@/utils/jsonRepair'

function robustParseJson(content: string): any {
  return parseJsonRobust(content)
}

function resolvePlayModel(input: Pick<StoryboardInput, 'model'>): string | undefined {
  const model = input.model?.trim()
  return model || undefined
}

/** 本地无法修复时，让主模型只修 JSON 语法，再进入业务质量验收。 */
async function parseJsonWithModelRepair(
  content: string,
  input: Pick<StoryboardInput, 'signal' | 'model'>,
  label: string
): Promise<any> {
  try {
    return robustParseJson(content)
  } catch (parseError) {
    log(`⚠ ${label} JSON 语法异常，调用结构修复：${(parseError as Error).message.split('\n')[0]}`)
    const jsonCandidate = (() => {
      try {
        return extractJsonText(content)
      } catch {
        return content.trim()
      }
    })()
    if (!jsonCandidate) {
      throw new Error(`${label} JSON 자동 복구에 실패했습니다. 복구할 내용이 없습니다.\n첫 오류 ${(parseError as Error).message}`)
    }
    let repairedContent = ''
    try {
      const repaired = await callLLM({
        messages: [
          {
            role: 'system',
            content: `Repair JSON syntax only: commas, quotes, escapes, brackets, and truncated containers. Preserve existing keys, values, array order, and wording. Do not polish, translate, summarize, or add facts. If the end is truncated, keep complete array items only and close the containers. Return one valid JSON object.`
          },
          { role: 'user', content: jsonCandidate }
        ],
        model: resolvePlayModel(input),
        temperature: 0,
        jsonMode: true,
        maxTokens: 24576,
        signal: input.signal,
        timeoutMs: PLAY_LLM_TIMEOUT_MS
      })
      repairedContent = repaired.content || ''
    } catch (llmError) {
      log(`⚠ ${label} 模型修复调用失败：${(llmError as Error).message}`)
    }
    if (repairedContent.trim()) {
      try {
        return robustParseJson(repairedContent)
      } catch (repairError) {
        log(`⚠ ${label} 模型修复结果仍无法解析：${(repairError as Error).message.split('\n')[0]}`)
      }
    }
    throw new Error(
      `${label} JSON 자동 복구에 실패했습니다. ${(parseError as Error).message}`
    )
  }
}

const QUALITY_REPAIR_ROUNDS = 3

// 이야기 범위·인과·샷 간 연속성 검수 규칙.
const NARRATIVE_CONTINUITY_RULES = `
Narrative continuity requirements:
1. Begin by determining the requested opening, ending, duration, and events for this video or episode. Follow the user's episode or excerpt boundary. For a complete short film or adaptation, include the full central conflict and key characters. Excerpt only when asked. Do not continue another episode, reveal a consequence beyond the stopping point, or expand unrelated worldbuilding.
2. End at any point the user specifies, including the onset of a change, during a transition, on arrival, on seeing a stranger, or another suspense point. An open ending does not constitute a gap. Establish the current state without explaining the next events.
3. Within the boundary, start each scene or shot from the visible result of the preceding beat. Leave a clear visible state for the next beat. Show how someone arrived, became acquainted, or was prompted to explain rather than asking viewers to infer those facts.
4. For major changes in place, era, identity, relationships, goals, or physical state, cover only the causal chain within this video's ending. Select necessary beats from warning signs → change → impact → immediate reaction → observation or verification → first contact. You may stop partway, but show a visible transition between beats that you do depict.
5. Give central time travel, accidents, transformations, discoveries, reunions, betrayals, or fight outbreaks screen time proportional to their importance. Follow the user's explicit direction to treat something as background or skip it.
6. Give explanatory lines a trigger in the current story. If the user asks to begin with explanation, recap, or an established relationship, follow that format without adding backstory.
7. Check every adjacent pair for position, pose, orientation, handheld objects, injury, emotion, knowledge, and environmental time. The next opening must connect to the previous ending. Use a visible transition for changes in time or location when the user permits it.
8. Do not replace important visible processes with narration or invent facts to bridge gaps.`

// 화자와 화면 속 인물의 배치·시선·반응 규칙.
const SPEAKER_STAGING_RULES = `
On-screen dialogue and blocking:
1. Make the speaker's lips legible. They can stand to the side or in the background, or kneel; they need not face the lens or stand at the center.
2. Include every visible person's foreground or background position, body orientation, and eyeline in blocking / eyeline / videoPrompt. Missing blocking can make the generator pose the cast toward the lens.
3. A foreground listener should face sideways or away and look toward the speaker or what the speaker points to. Do not have the listener look into the camera.
4. A dialogue exchange in one space can stay in one shot. Split videoPrompt from time zero to the end into 2–5 real beats, identifying the only speaker and the other characters' reactions in each beat. A sequence of 2–4 short lines from one speaker can stay together.
5. Use the “character name: line” format in voiceover. In every videoPrompt beat, describe everyone's position, eyeline, and nonverbal reaction rather than adding a generic “do not look at the camera.” Preserve spoken lines verbatim.`

async function auditStoryboardNarrative(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string
): Promise<string[]> {
  try {
    const compact = parsed.shots.map((shot, index) => ({
      index: index + 1,
      title: shot.title,
      purpose: shot.purpose,
      sceneId: shot.sceneId,
      blocking: shot.blocking,
      continuity: shot.continuity,
      videoPrompt: shot.videoPrompt,
      voiceover: shot.voiceover,
      duration: shot.duration
    }))
    const response = await callLLM({
      messages: [
        {
          role: 'system',
          content: `Audit film continuity. Report only real breaks that would make an ordinary viewer wonder how the story reached this point. Ignore wording and aesthetic details.${NARRATIVE_CONTINUITY_RULES}
Determine the narrative boundary from the original request, then check adjacent shots inside it. For a first episode, excerpt, trailer, or suspense ending, omitting subsequent events is not a fault. Check only jumps between adjacent beats that are already shown. Write the QA comments in Korean (한국어). Return JSON only: {"issues":["1→2번 샷 사이에 …가 빠졌습니다."]}. Return {"issues":[]} when there are no substantial issues. Give at most six items, each naming the adjacent shots or missing transition within the boundary.`
        },
        {
          role: 'user',
          content: `사용자 원래 요청\n${input.topic}\n${input.content}\n\n검수할 스토리보드\n${JSON.stringify(compact)}`
        }
      ],
      model,
      temperature: 0.1,
      jsonMode: true,
      maxTokens: 2400,
      signal: input.signal,
      timeoutMs: 30_000
    })
    const raw = parseJsonRobust(response.content)
    return (Array.isArray(raw?.issues) ? raw.issues : [])
      .map((issue: unknown) => String(issue || '').trim())
      .filter(Boolean)
      .slice(0, 6)
  } catch (error) {
    log(`⚠ 叙事连续性审查不可用，保留结构质检结果：${(error as Error).message}`)
    return []
  }
}

async function ensureNarrativeContinuity(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  let current = parsed
  for (let round = 0; round < 2; round++) {
    const issues = await auditStoryboardNarrative(current, input, model)
    if (!issues.length) return current
    onProgress?.(`이야기가 끊기는 부분을 찾아 관련 샷을 재배치하는 중（${round + 1}/2）…`)
    log(`⚠ 叙事连续性未通过 ${round + 1}/2：${issues.join('；')}`)
    current = await repairStoryboardOnce(
      current,
      input,
      model,
      issues.map((issue) => `심각: 이야기 연속성 단절 ${issue}`)
    )
    current = await ensureStoryboardQuality(current, input, model, onProgress)
  }
  const remaining = await auditStoryboardNarrative(current, input, model)
  if (remaining.length) {
    throw new Error(`샷을 두 차례 자동으로 부분 수정했지만 이야기 연속성 검수를 통과하지 못했습니다. ${remaining.join('；')}`)
  }
  return current
}

/**
 * Creative extraction must deliver an editable draft quickly. Run one lightweight audit and
 * at most one consolidated repair; subjective quality findings never block a structurally
 * usable storyboard from reaching the canvas.
 */
async function polishStoryboardOnce(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  const structural = storyboardQualityIssues(parsed, input)
  onProgress?.('샷 연결과 대사별 화자를 확인하는 중…')
  const narrative = await auditStoryboardNarrative(parsed, input, model)
  const issues = [...structural, ...narrative.map((issue) => `叙事承接：${issue}`)].slice(0, 16)
  if (!issues.length) return parsed

  onProgress?.('개선할 항목을 모아 한 번 수정한 뒤 초안을 제공하는 중…')
  try {
    const repaired = await repairStoryboardOnce(parsed, input, model, issues)
    const remaining = storyboardQualityIssues(repaired, input)
    if (remaining.length) {
      log(`⚠ 修订后仍有非阻断问题，交付可编辑稿：${remaining.join('；')}`)
      onProgress?.(`편집 가능한 스토리보드를 생성했습니다. 캔버스에서 ${remaining.length}개 항목을 더 조정할 수 있습니다.`)
    }
    return repaired.shots.length ? repaired : parsed
  } catch (error) {
    log(`⚠ 合并修订失败，交付首稿：${(error as Error).message}`)
    onProgress?.('자동 수정을 완료하지 못해 편집 가능한 첫 초안을 보존했습니다.')
    return parsed
  }
}

async function repairStoryboardOnce(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  issues: string[]
): Promise<StoryboardResult> {
  const extractHint =
    input.mode === 'extract'
      ? '입력은 완성 대본이므로 추출 결과만 수정하세요. 내레이션의 의미를 바꾸거나 새 이야기를 만들지 마세요. 캐릭터 절의 각 ### 항목을 기록하세요. ‘형’처럼 기존 캐릭터를 부르는 말이면 해당 인물의 name/role/description에 넣고, 캐릭터 목록에 별도로 있는 인물은 개별 기록을 만드세요. 사망한 인물은 유품, 초상화 또는 회상으로 보여 줄 수 있습니다. 살아 있는 상대역은 대치나 눈에 보이는 압박을 담은 샷이 필요합니다. 기록한 인물마다 본인, 유품, 초상화 또는 눈에 보이는 압박으로 적어도 한 샷에 등장시켜 subjectIds에 연결하고 visualPrompt / videoPrompt에 이름을 쓰세요. 화면 중앙에 서지 않는다는 이유로 아버지, 형 또는 상대역을 목록에서 빼지 마세요. 캐릭터 카드를 만들고 스토리보드에서 행인이나 ‘어떤 남자’로 바꾸지 마세요.'
      : '등장인물마다 subjects에 개별 기록을 만들고 한 명의 ‘주인공’으로 합치지 마세요.'
  const repairTargetSec =
    Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  const repairShotCap = shotBudgetFromDuration(repairTargetSec, input.maxShotDuration)
  const durationBlock = repairTargetSec
    ? `\n【成片时长硬约束】用户要的是 ${repairTargetSec} 秒成片，允许 ${repairTargetSec - DURATION_TOLERANCE_SEC}–${repairTargetSec + DURATION_TOLERANCE_SEC} 秒，多 1 秒或少 1 秒超出这个窗口都不合格。全片镜头数不得超过 ${repairShotCap} 个。超了就把相邻、同地点、同组人物的镜头合并成长镜头（靠运镜与画内调度表达，不靠切镜），而不是删掉关键剧情；每镜 duration 在 ${MIN_SHOT_SEC}–${shotDurationLimit(input)} 秒内，全部镜头 duration 相加必须落在允许窗口里。`
    : ''
  const repair = await callLLM({
    messages: [
      {
        role: 'system',
          content: `${importedDirectorPrefix()}You are the supervising editor for the short film. The previous JSON failed review. Re-extract it and fix all listed issues before returning it.${durationBlock} Do not add products, characters, numbers, or facts the user did not mention. Restore only processes already shown or clearly implied within this request. Do not write consequences beyond its boundary.\n${extractHint}\n${NARRATIVE_CONTINUITY_RULES}\n${SPEAKER_STAGING_RULES}\nWhen a major event has been compressed away or adjacent shots do not connect, split, insert, or reorder shots near the gap to show the missing process and reactions within the episode. Keep unrelated shots and the user's suspenseful stopping point. Each added shot needs continuity in the form of a specific preceding ending → visible change → specific state for the next shot.\nUse a distinct 3–8-character title per shot, never a generic "Shot". Divide original text by meaning across voiceover. Default to h3-dialogue and use h3-voiceover only for explicit narration. Keep 2–4 consecutive short lines of one intent together in a 7–10-second shot where possible. Reserve a single line for short reactions or transitions. Do not exceed duration*4 characters. Use "Character name: line" for speaker identification; H3 removes the prefix.\nChoose framing based on action, spatial relations, setting, and emotion. Use close framing when the expression matters and the environment can be omitted. Use medium or group framing for handoffs, arguments, questions and answers, interpersonal distance, environmental pressure, or group reactions. Do not make every speaker a close-up; identify the one speaker and others' reactions.\nWrite user-facing titles, descriptions, and newly authored dialogue in Korean (한국어). Write visualPrompt, videoPrompt, and h3Aesthetic in English for generation. Preserve supplied lines and explicitly requested Korean on-screen text. Make visualPrompt a visible still frame with setting, clothing, and light, and keep it distinct from videoPrompt. h3Aesthetic covers material, lighting, color, and cinematography, without tag lists.\n${videoPerformanceSpec(getVideoPromptStyle())}\nReturn one complete, valid JSON object.`
      },
      {
        role: 'user',
        content: `사용자 원문 또는 대본\n${input.content}\n\n主题：${input.topic || '（未填）'}\n\n검수를 통과하지 못한 항목(모두 수정)\n- ${issues.join('\n- ')}\n\n수정할 JSON\n${JSON.stringify(parsed)}`
      }
    ],
    model,
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 14000,
    signal: input.signal,
    timeoutMs: 75_000
  })
  return normalizeStoryboard(await parseJsonWithModelRepair(repair.content, input, '质量修订稿'), {
    style: input.style,
    topic: input.topic,
    content: input.content,
    keywords: input.keywords,
    maxShotDuration: input.maxShotDuration
  })
}

/** 验收不通过就打回重提炼，不直接停流水线。 */
async function ensureStoryboardQuality(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  let current = parsed
  for (let round = 0; round <= QUALITY_REPAIR_ROUNDS; round++) {
    const issues = storyboardQualityIssues(current, input)
    if (!issues.length) return current
    const severe = issues.filter((issue) => issue.startsWith('심각:'))
    if (round > 0 && !severe.length) {
      log(`⚠ 仍有非阻断问题，继续使用：${issues.join('；')}`)
      return current
    }
    if (round === QUALITY_REPAIR_ROUNDS) {
      throw new Error(
        `${QUALITY_REPAIR_ROUNDS}차례 재추출했지만 대본 품질 검수를 통과하지 못했습니다. ${issues.join('；')}`
      )
    }
    const n = round + 1
    log(`⚠ 质量未通过，打回重提炼 ${n}/${QUALITY_REPAIR_ROUNDS}：${issues.join('；')}`)
    onProgress?.(`검수를 통과하지 못해 다시 추출하는 중（${n}/${QUALITY_REPAIR_ROUNDS}）…`)
    current = await repairStoryboardOnce(current, input, model, issues)
  }
  return current
}

const SHOT_OUTLINE_TIMEOUT_MS = 60_000
const FILM_SHOT_OUTLINE_TIMEOUT_MS = 180_000
const SHOT_EXPAND_TIMEOUT_MS = 45_000
const SHOT_EXPAND_CONCURRENCY = 5
const SHOT_BATCH_CONCURRENCY = 3
const SHOTS_PER_BATCH = 3
const SHOT_BATCH_MAX_CHARS = 1100
const SHOT_BATCH_MAX_PARAGRAPHS = 4

interface ShotOutline {
  title: string
  shotSize?: string
  visualPrompt: string
  videoPrompt?: string
  omitNote?: string
  duration?: number
  audioDescription?: string
  voiceover?: string
  audioMode?: ShotAudioMode
  subjectNames?: string[]
  sceneName?: string
}

interface ShotWorkBatch {
  index: number
  label: string
  excerpt: string
  previousHint?: string
  nextHint?: string
}

function splitLongStoryBeat(text: string, maxChars: number): string[] {
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]
  const pieces = clean
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const out: string[] = []
  let current = ''
  for (const piece of pieces.length ? pieces : [clean]) {
    if (piece.length > maxChars) {
      if (current) out.push(current)
      current = ''
      for (let offset = 0; offset < piece.length; offset += maxChars) {
        out.push(piece.slice(offset, offset + maxChars))
      }
      continue
    }
    const next = current ? `${current}\n${piece}` : piece
    if (next.length > maxChars && current) {
      out.push(current)
      current = piece
    } else {
      current = next
    }
  }
  if (current) out.push(current)
  return out
}

function collapseShotBatches(
  drafts: Array<{ label: string; excerpt: string }>,
  wanted: number
): Array<{ label: string; excerpt: string }> {
  const out = drafts.map((draft) => ({ ...draft }))
  if (wanted <= 0) return out
  let guard = 0
  while (out.length > wanted && guard++ < 6) {
    const per = Math.ceil(out.length / wanted)
    if (per <= 1) break
    const merged: Array<{ label: string; excerpt: string }> = []
    for (let i = 0; i < out.length; i += per) {
      const chunk = out.slice(i, i + per)
      merged.push({
        label: chunk.length > 1 ? `${chunk[0].label} 起` : chunk[0].label,
        excerpt: chunk.map((item) => item.excerpt).join('\n\n')
      })
    }
    if (merged.length >= out.length) break
    out.splice(0, out.length, ...merged)
  }
  while (out.length < wanted) {
    let index = 0
    out.forEach((item, i) => {
      if (item.excerpt.length > out[index].excerpt.length) index = i
    })
    const item = out[index]
    if (item.excerpt.length < 40) break
    const mid = Math.floor(item.excerpt.length / 2)
    let cut = item.excerpt.lastIndexOf('\n\n', mid)
    if (cut < 20) cut = item.excerpt.lastIndexOf('\n', mid)
    if (cut < 20) cut = mid
    const left = item.excerpt.slice(0, cut).trim()
    const right = item.excerpt.slice(cut).trim()
    if (!left || !right) break
    out.splice(
      index,
      1,
      { label: `${item.label} · 前段`, excerpt: left },
      { label: `${item.label} · 后段`, excerpt: right }
    )
  }
  return out
}

/**
 * 先在本地按场次和剧情段落切工作包，避免把整份剧本交给一个模型。
 * 每个工作包只允许产出 1–3 镜；并发数由调用方限制为 3。
 *
 * targetBatches：期望的工作包总数。给了这个值就按成片时长收敛到这么多组，
 * 多了合并、少了拆开，不再按场次数拆出 8、9 个小组。
 * 不传时保持原来的 1100 字 / 4 段口径。
 */
function buildShotWorkBatches(play: string, targetBatches?: number): ShotWorkBatch[] {
  const normalized = String(play || '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const headingRe = /^#{1,4}\s+(.+)$/gm
  const headings = [...normalized.matchAll(headingRe)].map((match) => ({
    title: String(match[1] || '').trim(),
    level: String(match[0] || '').match(/^#+/)?.[0].length || 2,
    start: match.index || 0,
    bodyStart: (match.index || 0) + match[0].length
  }))
  const sceneHeading = (title: string) =>
    /^(?:场景\s*[一二三四五六七八九十百0-9]|장면\s*\d+|第[^\n]{1,12}场(?:\b|[：:]?)|scene\b)/i.test(title)
  const scenes = headings
    .map((heading, index) => ({
      ...heading,
      end:
        headings.slice(index + 1).find((next) => next.level <= heading.level)?.start ??
        normalized.length
    }))
    .filter((heading) => sceneHeading(heading.title))
    .map((heading) => ({
      title: heading.title,
      text: normalized.slice(heading.bodyStart, heading.end).trim()
    }))

  let sections = scenes.length ? scenes : [{ title: '完整剧情', text: normalized }]

  // 场次比期望包数还多时，先把相邻场次并成一组——工作包数永远不会少于场次数，
  // 不合并的话长剧本照样拆出十几个小组。
  const wanted0 = Math.floor(Number(targetBatches) || 0)
  if (wanted0 > 0 && sections.length > wanted0) {
    const per = Math.ceil(sections.length / wanted0)
    const merged: Array<{ title: string; text: string }> = []
    for (let i = 0; i < sections.length; i += per) {
      const chunk = sections.slice(i, i + per)
      merged.push({
        title: chunk.length > 1 ? `${chunk[0].title} 等 ${chunk.length} 场` : chunk[0].title,
        text: chunk.map((s) => s.text).join('\n\n')
      })
    }
    sections = merged
  }

  // 切分口径：默认 1100 字 / 4 段；给了期望包数就按正文总长摊平，使包数收敛到目标。
  let maxChars = SHOT_BATCH_MAX_CHARS
  let maxParagraphs = SHOT_BATCH_MAX_PARAGRAPHS
  const wanted = Math.floor(Number(targetBatches) || 0)
  if (wanted > 0) {
    const bodyLen = sections.reduce((sum, s) => sum + s.text.length, 0)
    const roughChars = Math.ceil(bodyLen / wanted)
    if (roughChars > maxChars) maxChars = Math.ceil(roughChars * 1.12)
    const totalParas = sections.reduce(
      (sum, s) => sum + s.text.split(/\n\s*\n+/).filter((p) => p.trim()).length,
      0
    )
    const roughParas = Math.ceil(totalParas / wanted)
    if (roughParas > maxParagraphs) maxParagraphs = roughParas + 1
  }

  const drafts: Array<{ label: string; excerpt: string }> = []
  for (const section of sections) {
    const paragraphs = section.text
      .split(/\n\s*\n+/)
      .flatMap((paragraph) => splitLongStoryBeat(paragraph, maxChars))
      .filter(Boolean)
    let current = ''
    let paragraphCount = 0
    let part = 1
    const flush = () => {
      if (!current.trim()) return
      drafts.push({
        label: paragraphs.length > 1 ? `${section.title} · 第${part++}段` : section.title,
        excerpt: `## ${section.title}\n\n${current.trim()}`
      })
      current = ''
      paragraphCount = 0
    }
    for (const paragraph of paragraphs.length ? paragraphs : [section.text]) {
      const next = current ? `${current}\n\n${paragraph}` : paragraph
      if (current && (next.length > maxChars || paragraphCount >= maxParagraphs)) {
        flush()
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph
      paragraphCount++
    }
    flush()
  }

  const fitted =
    wanted > 0 && drafts.length !== wanted ? collapseShotBatches(drafts, wanted) : drafts

  return fitted.map((draft, index) => ({
    index,
    ...draft,
    previousHint: index > 0 ? fitted[index - 1].excerpt.slice(-320) : undefined,
    nextHint: index + 1 < fitted.length ? fitted[index + 1].excerpt.slice(0, 320) : undefined
  }))
}

function verbatimSplitRule(verbatim?: boolean): string {
  if (!verbatim) return ''
  return `【가져온 대본의 샷 나누기】사용자가 가져온 완성 대본입니다. 샷을 나눌 때 본문을 고치거나 다듬거나 줄거리를 보완하거나 표현을 바꾸거나 대사를 추가·삭제하지 마세요. 대사와 내레이션을 서로 바꾸지 마세요. voiceover에는 원문의 대사를 글자 그대로 옮기세요. visualPrompt와 videoPrompt에는 원문에 명시된 인물, 동작, 장면만 담으세요. 원문에 없는 사건, 소품, 반응, 결말을 추가하지 마세요. 샷은 원문 순서를 따르세요.\n`
}

async function generateShotWorkBatch(
  input: StoryboardInput,
  model: string,
  batch: ShotWorkBatch,
  subjectNames: string[],
  sceneNames: string[],
  directives: string,
  retry = false,
  /** 本工作包的镜数配额（全片预算分摊后）；不给则退回 1–3 镜。 */
  shotBudget?: number,
  /** 全片镜数预算，用于向模型交代「这就是总数，不许超」。 */
  totalShotBudget?: number,
  targetDurationSec?: number,
  /** 本包各镜 duration 相加的上限（秒）。 */
  durationCap?: number
): Promise<{ shots: Record<string, unknown>[]; model?: string }> {
  const limit = Math.max(
    1,
    Math.min(SHOTS_PER_BATCH, Math.round(Number(shotBudget) || SHOTS_PER_BATCH))
  )
  const budgetLine =
    totalShotBudget && totalShotBudget > 0
      ? `\n【샷 수와 길이 제한】완성 영상의 목표 길이는 ${targetDurationSec || '?'}초이고 허용 오차는 ±${DURATION_TOLERANCE_SEC}초입니다. 영상 전체에는 ${totalShotBudget}개 작업 묶음만 허용합니다. 이 작업 묶음은 샷을 ${limit}개만 생성하고 duration의 합은 반드시 ${durationCap || targetDurationSec || '?'}초로 맞추세요. 이 구간의 동작과 대사를 ${limit}개 샷에 담고, 카메라 움직임과 화면 속 인물 배치로 표현하세요. 작업 묶음을 더 나누지 마세요.`
      : ''
  const parseBatch = (content: string): Record<string, unknown>[] => {
    try {
      const raw = parseJsonRobust(content)
      const rows = Array.isArray(raw?.shots)
        ? raw.shots
        : Array.isArray(raw)
          ? raw
          : []
      if (rows.length) {
        return rows
          .slice(0, limit)
          .filter((item: unknown) => item && typeof item === 'object') as Record<string, unknown>[]
      }
    } catch {
      /* 兼容普通聊天模型返回的自然语言分镜表。 */
    }
    return parseOutlineText(content)
      .slice(0, limit)
      .map((outline) => outlineToRawShot(outline))
  }
  const ask = async () =>
    callLLM({
      messages: [
        {
          role: 'system',
          content: `${importedDirectorPrefix()}${verbatimSplitRule(input.verbatim)}You are the film storyboard team for this excerpt only. Break it into 1–${limit} consecutive filmable shots. Never exceed ${limit} shots.${budgetLine}

Make the image live. Establish the physical states of people and key objects, the event that triggers action, the continuous action and reaction, and why and where the camera moves. Do not fill with generic static-camera, slight wobble, held-expression, or frame-breathing instructions. Use static only if stillness serves the story. Motivate movement by a spatial reveal, changing relationship, or emotional turn.
Cover every visible action and line of dialogue in the excerpt without inventing plot. Put original words verbatim in voiceover as "Character name: original line." Use h3-voiceover only for explicitly off-screen speech, h3-dialogue for visible speaking, and none with an empty string only when there is no dialogue.
visualPrompt describes the representative still keyframe. videoPrompt is an actionable image-to-video timeline from zero to the end, split into 2–5 actual beats. State actor and speaker, other people's blocking and reactions, facial changes, and a motivated camera move. Give a visible response to wind, rain, smoke, clothes, light, or props where relevant. Do not repeat visualPrompt or divide into equal slots.
Give each shot a framing and the spatial relations. Eyelines stay in the scene. Write titles, shot descriptions for the user, and sound notes in Korean (한국어). Write visualPrompt and videoPrompt in English for generation, preserving original dialogue and requested Korean on-screen text.
Prefer JSON: {"shots":[{"title":"3–8 character title","purpose":"Dramatic function","shotSize":"Framing change","visualPrompt":"Representative still frame","videoPrompt":"English cinematic timeline in 2–5 beats from zero to the end","duration":6,"audioDescription":"Synchronized scene sound","voiceover":"Character name: original lines or empty","audioMode":"h3-dialogue|h3-voiceover|none","cameraMovement":"push|pull|pan|tilt|static|orbit","subjectNames":["Short character name"],"sceneName":"Existing location name"}]}. Include only 1–${limit} entries in shots. If JSON is unavailable, use "Shot N: title" followed by "Image:", "Action:", "Duration:", "Sound:", and optional "Dialogue:". ${retry ? 'The previous response did not contain parseable shots. Return the result now without reasoning.' : ''}`
        },
        {
          role: 'user',
          content: `작업 묶음 ${batch.label}
기존 캐릭터 ${subjectNames.join('、') || '（원문에서 식별）'}
기존 장소 ${sceneNames.join('、') || '（원문에서 식별）'}
현재 영상 모델의 샷당 최대 길이는 ${shotDurationLimit(input)}초입니다. ${durationCap ? `이 작업 묶음의 결과 길이는 ${durationCap}초입니다. 샷 ${limit}개만 생성하고 duration은 ${durationCap}으로 쓰세요.` : `샷마다 duration을 ${MIN_SHOT_SEC}–${shotDurationLimit(input)}초로 지정하세요.`} 같은 장소와 캐릭터의 연속 행동을 제한 시간 안에 촬영할 수 있으면 하나의 완전한 롱테이크로 구성하세요.${budgetLine}
${directives ? `\n전체 영상 제약(원문 보존에만 사용)\n${directives}\n` : ''}
${batch.previousHint ? `이전 작업 묶음의 끝(연결에만 사용하고 다시 촬영하지 않음)\n${batch.previousHint}\n` : ''}
현재 작업 묶음의 대본 원문
${batch.excerpt}
${batch.nextHint ? `\n다음 작업 묶음의 시작(끝 상태를 정하는 데만 사용하고 미리 촬영하지 않음)\n${batch.nextHint}` : ''}`
        }
      ],
      model,
      temperature: retry ? 0.1 : 0.35,
      // 不强制 response_format：部分兼容接口在并发 JSON 约束下会一直推理到超时。
      // 提示仍优先要 JSON，同时下方解析器接受普通分镜文本。
      jsonMode: false,
      maxTokens: 3200,
      signal: input.signal,
      timeoutMs: retry ? FILM_SHOT_OUTLINE_TIMEOUT_MS : 90_000
    })
  try {
    const response = await ask()
    const rows = parseBatch(response.content)
    const shots = rows.map((item: Record<string, unknown>) => {
      const text = `${item.title || ''}\n${item.visualPrompt || ''}\n${item.videoPrompt || ''}\n${item.voiceover || ''}`
      const inferredSubjects = subjectNames.filter((name) => name && text.includes(name))
      const inferredScene = sceneNames.find((name) => name && text.includes(name))
      return {
        ...item,
        subjectNames:
          Array.isArray(item.subjectNames) && item.subjectNames.length
            ? item.subjectNames
            : inferredSubjects,
        sceneName: String(item.sceneName || inferredScene || '').trim() || undefined
      }
    })
    if (!shots.length) throw new Error('모델 응답에 해석할 수 있는 스토리보드가 없습니다.')
    return { shots, model: response.model }
  } catch (error) {
    if (isAbortError(error) && !isTimeoutAbort(error)) throw error
    log(`⚠ 分镜工作包 ${batch.index + 1}${retry ? '单路重试' : '并发首轮'}失败：${(error as Error).message.split('\n')[0]}`)
    throw error
  }
}

function asShotOutlineList(raw: unknown): ShotOutline[] {
  const shots = Array.isArray((raw as { shots?: unknown })?.shots)
    ? (raw as { shots: unknown[] }).shots
    : Array.isArray(raw)
      ? raw
      : []
  return shots
    .map((item, i) => {
      const s = item as Record<string, unknown>
      const names = Array.isArray(s?.subjectNames)
        ? s.subjectNames.map((n) => String(n).trim()).filter(Boolean)
        : undefined
      const voiceover = String(s?.voiceover ?? '').trim()
      return {
        title: String(s?.title || `샷 ${i + 1}`).trim() || `샷 ${i + 1}`,
        shotSize: String(s?.shotSize || '').trim() || undefined,
        visualPrompt: String(s?.visualPrompt || s?.picture || '').trim(),
        videoPrompt: String(s?.videoPrompt || s?.action || '').trim() || undefined,
        omitNote: String(s?.omitNote || '').trim() || undefined,
        duration: Number(s?.duration) || undefined,
        audioDescription: String(s?.audioDescription || s?.sound || '').trim() || undefined,
        voiceover,
        audioMode: inferOutlineAudioMode(voiceover, String(s?.audioMode || '')),
        subjectNames: names?.length ? names : undefined,
        sceneName: String(s?.sceneName || '').trim() || undefined
      }
    })
    .filter((item) => item.visualPrompt || item.voiceover || item.title)
}

function cleanShotVoiceover(raw: string | undefined): string {
  const v = String(raw || '').trim()
  if (!v) return ''
  const body = v.replace(/^[^：:\n]{1,12}[：:]\s*/, '').trim()
  if (isPlaceholderSpokenLine(v) || isPlaceholderSpokenLine(body)) return ''
  return v
}

function inferOutlineAudioMode(voiceover: string, requested?: string): ShotAudioMode | undefined {
  const vo = cleanShotVoiceover(voiceover)
  if (!vo) return 'none'
  if (
    requested === 'h3-dialogue' ||
    requested === 'h3-voiceover' ||
    requested === 'tts' ||
    requested === 'none'
  ) {
    return requested
  }
  if (/旁白|画外音/.test(vo) || /^(?:成年|내레이션|화면 밖 음성|narrator|voiceover)/i.test(vo)) return 'h3-voiceover'
  return 'h3-dialogue'
}

const OUTLINE_SHOT = /(?:镜头|샷|Shot)\s*\d+\s*[：:]/i
const OUTLINE_FIELDS = {
  size: '景别|샷 크기|Shot size',
  image: '画面|화면|Image|Visual',
  action: '内容表现|内容|동작|내용|Action',
  omit: '不拍|촬영 제외|Omit',
  duration: '时长|길이|Duration',
  sound: '声音|音效|소리|효과음|Sound|Audio',
  speech: '口播|对白|台词|내레이션|대사|Narration|Dialogue'
} as const

function outlineField(block: string, names: string): string {
  const labels = Object.values(OUTLINE_FIELDS).join('|')
  const m = block.match(
    new RegExp(
      `(?:^|\\n)[ \\t]*(?:${names})[ \\t]*[：:][ \\t]*([^\\n]+(?:\\n(?![ \\t]*(?:(?:${labels})[ \\t]*[：:]|${OUTLINE_SHOT.source}))[^\\n]+)*)`,
      'i'
    )
  )
  return (m?.[1] || '').replace(/\s+/g, ' ').trim()
}

/** 按「镜头 N：标题（景别）/ 画面 / 时长 / 声音」场记拆条 */
function parseOutlineText(content: string): ShotOutline[] {
  const text = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/```[\w]*\n?|\n?```/g, '')
    .trim()
  const blocks = text
    .split(new RegExp(`\\n(?=[ \\t]*${OUTLINE_SHOT.source})`, 'i'))
    .map((b) => b.trim())
    .filter((b) => b.search(OUTLINE_SHOT) === 0)
  return blocks
    .map((block, i) => {
      const head = block.match(new RegExp(`^${OUTLINE_SHOT.source}\\s*([^\\n]+)`, 'i'))
      let title = (head?.[1] || `샷 ${i + 1}`).trim()
      let shotSize = outlineField(block, OUTLINE_FIELDS.size)
      const paren = title.match(/[（(]([^）)]+)[）)]\s*$/)
      if (paren) {
        if (!shotSize) shotSize = paren[1].trim()
        title = title.slice(0, paren.index).trim() || title
      }
      const visualPrompt = outlineField(block, OUTLINE_FIELDS.image)
      const videoPrompt = outlineField(block, OUTLINE_FIELDS.action)
      const omitNote = outlineField(block, OUTLINE_FIELDS.omit)
      const audioDescription = outlineField(block, OUTLINE_FIELDS.sound)
      const voiceover = outlineField(block, OUTLINE_FIELDS.speech)
      const duration = Number(outlineField(block, OUTLINE_FIELDS.duration).match(/^\d+(?:\.\d+)?/)?.[0])
      return {
        title: title.trim() || `샷 ${i + 1}`,
        shotSize: shotSize || undefined,
        visualPrompt: visualPrompt || videoPrompt,
        videoPrompt: videoPrompt || undefined,
        omitNote: omitNote || undefined,
        duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
        audioDescription: audioDescription || undefined,
        voiceover,
        audioMode: inferOutlineAudioMode(voiceover)
      }
    })
    .filter((item) => item.visualPrompt.length > 4 || item.title.length > 1)
}

function attachCastToOutline(
  outline: ShotOutline,
  subjectNames: string[],
  sceneNames: string[]
): ShotOutline {
  const blob = `${outline.title}\n${outline.visualPrompt}\n${outline.videoPrompt || ''}\n${outline.voiceover}`
  const hits = subjectNames.filter((name) => name && blob.includes(name))
  const sceneName = outline.sceneName || sceneNames.find((name) => name && blob.includes(name))
  return {
    ...outline,
    subjectNames: outline.subjectNames?.length ? outline.subjectNames : hits.length ? hits : undefined,
    sceneName
  }
}

function formatOutlineNote(outline: ShotOutline, index: number): string {
  const size = outline.shotSize ? `（${outline.shotSize}）` : ''
  const lines = [
    `镜头 ${index + 1}：${outline.title}${size}`,
    `画面：${outline.visualPrompt}`,
    `时长：${outline.duration || 6} 秒`,
    `声音：${outline.audioDescription || '现场环境声'}`
  ]
  if (outline.videoPrompt) lines.push(`内容：${outline.videoPrompt}`)
  if (outline.omitNote) lines.push(`不拍：${outline.omitNote}`)
  if (outline.voiceover) lines.push(`口播：${outline.voiceover}`)
  return lines.join('\n')
}

function outlineToRawShot(outline: ShotOutline, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: outline.title,
    shotSize: outline.shotSize,
    visualPrompt: outline.visualPrompt,
    videoPrompt: outline.videoPrompt,
    duration: outline.duration || 6,
    audioDescription: outline.audioDescription,
    voiceover: outline.voiceover || '',
    audioMode: outline.audioMode,
    subjectNames: outline.subjectNames,
    sceneName: outline.sceneName,
    ...extra
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const n = Math.min(Math.max(1, limit), items.length)
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        throwIfAborted(signal)
        const index = cursor++
        if (index >= items.length) return
        out[index] = await fn(items[index], index)
      }
    })
  )
  return out
}

async function extractShotOutline(
  input: StoryboardInput,
  model: string,
  play: string,
  subjectNames: string[],
  sceneNames: string[],
  onProgress?: (msg: string) => void
): Promise<{ outlines: ShotOutline[]; model?: string }> {
  const film = isFilmChapterInput(input)
  const longForm = isLongFormPlay(input, play)
  const directives = extractPlayDirectives(play)
  onProgress?.(
    film
      ? '按剧本拍点出分镜场记（动作、对白、不拍清单）…'
      : '先把剧本交给模型出分镜场记（只要画面、时长、声音）…'
  )
  // 일반·영화 제작 스토리보드의 출력 필드와 대사 보존 규칙.
  const shortSystem = `${importedDirectorPrefix()}You are a storyboard director. Write concise production notes that describe shots a team can film.
Split the script in story order. Consecutive dialogue in one space may remain in one shot, as may a series of short lines from the same person.
For each shot, write its title (shot size or camera movement in parentheses), image (2–4 sentences of visible action), action (what happens in the shot), duration, and sound.
If the shot contains dialogue, add a line in the form "Dialogue: Character name: Original line". Preserve every line from the script verbatim. Omit Dialogue only for shots without speech, such as empty establishing shots or travel shots.
Do not turn the story background into narration by an older version of a character. Do not output JSON, reasoning, continuity, blocking, or aesthetic sections.
Follow the format below exactly, with a blank line between shots. Write shot titles, shot sizes, sound notes, and user-facing descriptions in Korean (한국어). Write the Image and Action fields in English for the generation models. Preserve dialogue in its original language.

Shot 1: 한밤중의 질주 (원경→중경)
Image: At 11 p.m., a silvery band of light crosses the shallows by the village entrance. Niulang rushes out of the brush carrying a bamboo basket on a shoulder pole. Two children jolt and grip the rim.
Action: Niulang bursts from the brush. As the children grip the bouncing rim, one sandal sinks into the mud. He watches the path and his children and keeps his gaze off the camera.
Duration: 6 seconds
Sound: 풀을 밟는 소리, 가쁜 숨, 물이 흐르고 튀는 소리`

  const filmSystem = `${importedDirectorPrefix()}You are a film storyboard director. The input is a complete chapter script. Break it into filmable shots in script order. Cover every scene and montage beat without inventing plot.

Shot breakdown rules:
- Split each scene by its dramatic beats: entering, noticing, hesitating, speaking, reacting, and leaving. Do not compress the entire scene into one shot or stretch one line into three shots of blank expressions.
- Combine 3–6 consecutive images with the same purpose into one 8–10-second montage shot. Describe tangible progression, such as light moving right from a door crack, an apple core darkening, or raindrops gathering into a puddle. Avoid vague statements such as "time passes" or "several days pass."
- A dialogue exchange in a single space and a continuous run of short lines from a single speaker can each stay in one shot. Copy each script line verbatim into the relevant Dialogue field. Do not omit lines or use narration by the character's older self to recap backstory.
- Use "Dialogue: Narrator: Original line" only when the script identifies a line as off-screen narration. On-screen people keep their lips closed. For on-screen dialogue, name the actual speaker.
- Add an Omit line to each applicable shot when the script excludes imagery such as wound close-ups, religious icons, rituals, or framing a homeless person as monstrous.
- Have people look at someone or something in the scene. Do not pose the whole cast toward the lens. Show kindness as an ordinary person doing a small thing; avoid a savior entrance.
- Follow the script's period, weather, wet or dry clothing, and gait.
- Expected size: ${longForm ? '25–60 shots covering the entire chapter, including all scenes and montages' : 'about 6–14 shots, depending on the running time'}. Do not omit important beats or split one line into three shots of blank expressions.

Follow the format below exactly. Put one blank line between shots. Do not output JSON or reasoning. Write shot titles, shot sizes, sound notes, and user-facing descriptions in Korean (한국어). Write Image, Action, and Omit in English for the generation models. Preserve script dialogue verbatim.

Shot 1: 모퉁이에서 잠들다 (중근경)
Image: At the corner of an abandoned warehouse, Afeng sits against a cracked wall holding an apple core. His down jacket is wet and dirty. Pale gray daylight enters through a gap in the door.
Action: Afeng's breathing steadies and his eyes close gradually. He looks at the floor or into the distance, away from the camera. The camera barely moves.
Omit: Close-ups of wounds and religious icons
Duration: 8 seconds
Sound: 바깥의 빗소리, 멀리서 들리는 자동차 소리, 그의 숨소리
Dialogue: 아펑: 먼저 다 먹자. 심은 남겨 두고.`

  const response = await callLLM({
    messages: [
      { role: 'system', content: film ? filmSystem : shortSystem },
      {
        role: 'user',
        content: `已有人物：${subjectNames.join('、') || '（无）'}
已有地点：${sceneNames.join('、') || '（无）'}
单镜时长：当前模型最长 ${shotDurationLimit(input)} 秒；${film ? `按场次动作在 5–${shotDurationLimit(input)} 秒内规划` : `参考 ${input.shotDuration}，可在 3–${shotDurationLimit(input)} 秒内规划`}。连续动作能在一个镜头完成就不要拆成多个短镜头

${directives ? `本章必须遵守：\n${directives}\n` : ''}전체 대본
${play}`
      }
    ],
    model,
    temperature: film ? 0.35 : 0.4,
    jsonMode: false,
    maxTokens: film ? 12288 : 2500,
    signal: input.signal,
    timeoutMs: film ? FILM_SHOT_OUTLINE_TIMEOUT_MS : SHOT_OUTLINE_TIMEOUT_MS
  })
  let outlines = parseOutlineText(response.content).map((item) =>
    attachCastToOutline(item, subjectNames, sceneNames)
  )
  if (!outlines.length) {
    try {
      outlines = asShotOutlineList(parseJsonRobust(response.content)).map((item) =>
        attachCastToOutline(item, subjectNames, sceneNames)
      )
      if (outlines.length) log('⚠ 场记不是文本格式，已从 JSON 兜底识别')
    } catch {
      /* 下面统一报空表 */
    }
  }
  if (!outlines.length) {
    throw new Error('스토리보드 초안이 비어 있습니다. 캐릭터와 장면은 저장됐습니다. 스토리보드 추출을 다시 시도할 수 있습니다.')
  }
  onProgress?.(`✓ 샷 현장 기록 ${outlines.length}개를 받아 캔버스에 저장하는 중…`)
  return { outlines, model: response.model }
}

async function expandOneShot(
  input: StoryboardInput,
  model: string,
  outline: ShotOutline,
  index: number,
  prev: ShotOutline | undefined,
  next: ShotOutline | undefined,
  subjectNames: string[],
  sceneNames: string[],
  extras?: { directives?: string; sceneSlice?: string; film?: boolean }
): Promise<Record<string, unknown>> {
  const film = extras?.film ?? isFilmChapterInput(input)
  try {
    const response = await callLLM({
      messages: [
        {
          role: 'system',
          content: `${importedDirectorPrefix()}You fill storyboard nodes. Expand only the production note supplied below, leaving the story, duration, and intended image intact.
Use the note's original spoken words in voiceover. An empty string is invalid when the note contains dialogue. A conversation within one space may remain in one shot. Use audioMode=h3-voiceover only for off-screen speech or explicitly marked narration.
videoPrompt is required. Divide the shot from zero through the end into 2–5 story beats. In each beat identify the acting person, concrete motion, expression, speaker and original words, the foreground or background placement and orientation of other people, their eyelines and nonverbal reactions, the motivated camera move, and its final position. A speaker can be behind others. Foreground listeners should turn sideways or look back. Avoid posing as a group portrait or only saying that nobody looks at the camera.
${film ? 'Find the corresponding beat in the original script. Treat montage as visible continuous action. Put script exclusions in the final sentence of videoPrompt. Show kindness through ordinary small actions.' : ''}
Write titles and user-facing descriptions in Korean (한국어). Preserve existing category values and the cast and place names. Write visualPrompt and videoPrompt in English for the generation models. Keep dialogue, narration, and explicitly requested Korean on-screen text verbatim.
Return one JSON object only. {"title":"3–8 character title","purpose":"钩子/说明/反应/揭示/转场/收口","shotSize":"Framing","blocking":"Each person's foreground or background position, orientation, and relation to others","eyeline":"What or whom each person looks at; keep eyes off the lens","continuity":"Previous shot ending → Current visible change → Next shot opening","propFocus":"Prop or none","visualPrompt":"English still frame description","videoPrompt":"Filmable timeline in English, split into 2–5 beats from the opening to the end. Include action, expression, speaker and verbatim lines, positions and reactions, camera movement and endpoint, and synchronized sound","audioDescription":"Actual scene sound","voiceover":"Character name: original line, or empty","audioMode":"h3-dialogue|h3-voiceover|tts|none","speakerHint":"Voice and emotion","duration":6,"cameraMovement":"push|pull|pan|tilt|static|orbit","subjectNames":["Short name"],"sceneName":"Original place name"}`
        },
        {
          role: 'user',
          content: `已有人物：${subjectNames.join('、') || '（无）'}
已有地点：${sceneNames.join('、') || '（无）'}
${prev ? `이전 샷 ${formatOutlineNote(prev, index - 1)}` : '이전 샷 없음(현재 샷이 시작)'}

현재 샷 현장 기록
${formatOutlineNote(outline, index)}

${next ? `다음 샷 ${formatOutlineNote(next, index + 1)}` : '다음 샷 없음(현재 샷이 마지막)'}
${extras?.directives ? `\n챕터 제약\n${extras.directives}` : ''}
${extras?.sceneSlice ? `\n이 장면의 대본 원문\n${extras.sceneSlice}` : ''}
이 샷만 확장하세요.`
        }
      ],
      model,
      temperature: 0.25,
      jsonMode: true,
      maxTokens: 1800,
      signal: input.signal,
      timeoutMs: SHOT_EXPAND_TIMEOUT_MS
    })
    let raw: any
    try {
      raw = parseJsonRobust(response.content)
    } catch {
      return outlineToRawShot(outline)
    }
    const shot = (raw?.shots && Array.isArray(raw.shots) ? raw.shots[0] : raw) as Record<string, unknown>
    if (!shot || typeof shot !== 'object') return outlineToRawShot(outline)
    const voiceover = String(shot.voiceover ?? outline.voiceover ?? '')
    const videoPrompt = String(shot.videoPrompt || outline.videoPrompt || '').trim()
    const omit = outline.omitNote
    const withOmit =
      omit && videoPrompt && !videoPrompt.includes(omit) ? `${videoPrompt}不拍：${omit}。` : videoPrompt
    return {
      ...outlineToRawShot(outline),
      ...shot,
      title: String(shot.title || outline.title),
      visualPrompt: String(shot.visualPrompt || outline.visualPrompt),
      videoPrompt: withOmit,
      duration: Number(shot.duration) || outline.duration,
      audioDescription: String(shot.audioDescription || outline.audioDescription || ''),
      voiceover,
      audioMode: inferOutlineAudioMode(voiceover, String(shot.audioMode || outline.audioMode || ''))
    }
  } catch (error) {
    if (isAbortError(error) && !isTimeoutAbort(error)) throw error
    log(`⚠ 第${index + 1}镜扩节点失败，先用粗分镜落库：${(error as Error).message.split('\n')[0]}`)
    return outlineToRawShot(outline)
  }
}

/** 真实 LLM 调用 */
async function realStoryboard(
  input: StoryboardInput,
  onProgress?: (msg: string) => void
): Promise<{
  result: StoryboardResult
  model: string
}> {
  let productNote =
    input.productImages && input.productImages.length > 0
      ? `
[${input.productImages.length} reference images attached]
Inspect the images before writing the storyboard.
- Record visible people, animals, or mascots as subjects. Match their actual appearance and set fromReference=true. Do not invent faces.
- For products, use kind=other and match the actual item.
- Keep clothing, hairstyle, and age from subjects consistent in all later shots.
- Keep the product or protagonist legible in each shot.`
      : `
[No reference images]
List all on-screen people and animals under subjects and locations under scenes. Use a separate subject for every named or speaking person or anyone who acts. Do not merge supporting characters into a single protagonist.
Preserve names, ages, hairstyles, clothes, and accessories throughout the film.`

  if (input.productImages?.length) {
    log(`→ 调用视觉工具分析 ${input.productImages.length} 张参考图`)
    onProgress?.(`참조 이미지 ${input.productImages.length}장을 먼저 분석한 뒤 캐릭터 → 장면 → 스토리보드 순으로 추출하는 중…`)
    const visualContent: LLMContentPart[] = [
      ...input.productImages.slice(0, 5).map((url) => ({
        type: 'image_url' as const,
        image_url: { url }
      })),
      {
        type: 'text',
        text: `Analyze the reference images only. Do not write the script. Write visible findings for each image in Korean (한국어):
1. Count people, animals, and mascots, and describe age ranges, face shapes, hairstyles, clothing, and accessories.
2. Report product type, appearance, colors, and legible text. If unclear, mark it unreadable without guessing.
3. Describe location, composition, and lighting.
4. Identify visual anchors to preserve across shots.
Report visible facts only. Do not infer brands, specifications, prices, efficacy, or relationships.`
      }
    ]
    const visual = await callLLM({
      provider: 'vision',
      messages: [{ role: 'user', content: visualContent }],
      temperature: 0.1,
      maxTokens: 1800,
      signal: input.signal,
      timeoutMs: 60_000
    })
    productNote += `\n\n[Reference image findings: use only as factual evidence]\n${visual.content.slice(0, 8_000)}`
  }

  const stylePriority = buildStylePriorityBlock(input)
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const styleCn = styleLabel(look.style)
  const styleGuide = VISUAL_STYLE_GUIDE[look.style]
  const mediumPhrase = extractUserMediumPhrase(
    input.topic,
    input.content,
    ...(input.keywords ?? [])
  )
  const hasUserStyle = Boolean(mediumPhrase)
  const directorPlaybook = directorPlaybookText()
  const extractMode = input.mode === 'extract'

  if (extractMode) {
    const { model: configuredModel } = getLlmConfig()
    const parallelModel = resolvePlayModel(input) || configuredModel
    const play = input.content?.trim() || ''
    const common = `主题：${input.topic || '（未填）'}\n比例：${input.aspectRatio}\n单镜时长参考：${input.shotDuration} 秒\n\n전체 대본\n${play}`
    const startAt = input.extractStartAt || 'subjects'
    const stopAfter = input.extractStopAfter || startAt
    const stageOrder = { subjects: 0, scenes: 1, shots: 2 } as const
    onProgress?.(
      `按步骤提炼：先人物，再场景，再分镜。本轮只做${startAt === 'subjects' ? '人物' : startAt === 'scenes' ? '场景' : '分镜'}。`
    )

    const runPart = async (
      label: string,
      system: string,
      maxTokens: number,
      timeoutMs: number,
      validate?: (raw: any) => boolean,
      repairInstruction?: string,
      userContent?: string
    ): Promise<{ raw: any; model?: string }> => {
      const baseUser = userContent || common
      const ask = async (extraUser?: string) =>
        callLLM({
          messages: [
            { role: 'system', content: `${system}\nDo not output reasoning or natural-language preamble. The first character must be { and the last character must be }.` },
            { role: 'user', content: extraUser ? `${baseUser}\n\n${extraUser}` : baseUser }
          ],
          model: parallelModel,
          temperature: extraUser ? 0 : 0.25,
          jsonMode: true,
          maxTokens,
          signal: input.signal,
          timeoutMs
        })
      try {
        const response = await ask()
        let raw: any
        try {
          raw = parseJsonRobust(response.content)
        } catch {
          onProgress?.(`${label}의 JSON을 받지 못해 다시 요청하는 중…`)
          const salvage = await ask(
            'The prior answer contained reasoning but no JSON. Return one JSON object with no explanation.'
          )
          raw = parseJsonRobust(salvage.content)
          if (validate && !validate(raw)) {
            throw new Error(`${label} JSON에 필수 데이터 배열이 없습니다.`)
          }
          onProgress?.(`✓ ${label} 추출 완료`)
          return { raw, model: salvage.model }
        }
        if (validate && !validate(raw)) {
          onProgress?.(`${label} JSON 구조가 불완전해 자동 복구하는 중…`)
          const repaired = await ask(
            repairInstruction || `The prior JSON had the wrong structure. Return complete ${label} JSON matching the system instructions.`
          )
          raw = parseJsonRobust(repaired.content)
          if (!validate(raw)) throw new Error(`${label} JSON을 복구했지만 필수 데이터 배열이 여전히 없습니다.`)
          onProgress?.(`✓ ${label} 추출 완료`)
          return { raw, model: repaired.model }
        }
        onProgress?.(`✓ ${label} 추출 완료`)
        return { raw, model: response.model }
      } catch (error) {
        if (isAbortError(error) && !isTimeoutAbort(error)) throw error
        const message = (error as Error).message
        log(`⚠ ${label}提炼失败：${message}`)
        throw new Error(`${label} 추출에 실패했습니다. 이미 완료된 노드는 저장됐습니다. 이 단계만 다시 시도할 수 있습니다. ${message}`)
      }
    }

    // 캐릭터 프로필은 한국어, 생성 모델용 음색 지시는 영어로 요청한다.
    const subjectSystem = `You extract character records. Use every independent subsection under "## 캐릭터" (or legacy "## 人物") and any people, animals, products, or key subjects that appear, are seen through a keepsake or portrait, or exert visible pressure. Do not extract locations, shots, asset images, or prop lists. Include deceased parents and absent opponents when their ### records exist. Preserve names from the script. If someone has both a name and a role, put the most-used short name in name and the full identity and aliases in role for matching. Describe age, face shape, hair, build, wardrobe, shoes, accessories, and stable visual features. Do not only label someone the protagonist. Keep description focused on identity and appearance, with no place or weather. Character sheets will use four views on seamless white. In stateVariants, identify wardrobe wetness, stains, hunger, limping, or held food that changes; use the existing "单一状态" value when nothing changes. Write user-facing character descriptions and roles in Korean (한국어).
${productNote}
Write one voicePrompt in English for every person, covering age and gender, timbre (raspy, bright, slow, nasal, or similar), speed and intensity, emotional tone, and an appropriate accent or speaking habit. Use one consistent voice in the entire film. For animal and other, use an empty string.
Output JSON only: {"subjects":[{"name":"Short name","kind":"person|animal|other","description":"Specific physical identity, excluding location","role":"Identity, dramatic function, and aliases","stateVariants":"Changes in this episode, or 单一状态","voicePrompt":"English vocal qualities and delivery, empty for non-person subjects","fromReference":false}]}. Before returning, verify a record for every ###, separate people who speak, act, or are seen, and a voicePrompt for every person.`

    // 촬영 장소만 추출하고 장면 설명과 생성용 스타일의 언어를 지정한다.
    const sceneSystem = `You extract locations and visual settings. Include only places actually filmed in this episode. Do not write characters or shots.
Prefer locations under "## 환경과 장면" or legacy "## 环境与场景", then scene lines such as "실내｜장소｜날씨" or "内景｜地点｜天气". Deduplicate places; do not create a new record for every scene.
Use a short existing location name, such as the old warehouse or charity kitchen yard. Do not use a generic scene number.
Describe an unoccupied space, including the ground, building, weather, light, and period objects. Write user-facing descriptions in Korean (한국어), and write h3Aesthetic in English for the video model.
${productNote}
${stylePriority}
Return JSON only: {"aesthetic":"Overall tone of the film","h3Aesthetic":"English production aesthetic with concrete lighting, material, color and camera qualities","styleBrief":"Conflict and visual hook for this episode","colorPalette":"Visible colors","lightingNote":"Time and light source","scenes":[{"name":"Short location name","description":"At least 80 characters about the unoccupied space, ground, architecture, weather, movement, and lighting","mainAnchor":"Primary visual anchor","anchors":"Wide view; main anchor; ground and blocking area; light source or secondary anchor","lighting":"Time and light source"}]}
Return a top-level object with a nonempty scenes array. Do not nest inside data or result or write scenes as an object.`


    const pullRecurringProps = async (script: string, subjects: Subject[]): Promise<StoryProp[]> => {
      const names = subjects.map((item) => item.name)
      let rows = propsListedInPlay(script)
      if (!rows.length && getAIMode() !== 'mock') {
        try {
          const part = await runPart(
            '道具',
            '영상에 반복해서 등장하는 동일한 소품만 추출하세요. 인물, 장소, 옷, 신발과 헤어스타일은 제외하세요. 검은 넥타이, 간식 통, 같은 열쇠처럼 찾거나 건네거나 여러 번 클로즈업하는 독립된 물건만 포함하세요. name에는 대본에서 사용하는 2–8자의 짧은 이름을 쓰세요. description에는 모양, 재질, 색, 닳은 상태와 식별 특징만 쓰고 방은 묘사하지 마세요. JSON만 출력하세요. {"props":[{"name":"검은 넥타이","description":"폭이 좁은 검은 실크 넥타이. 끝에 가는 금속 클립이 달려 있음"}]}. 소품이 없으면 {"props":[]}를 출력하세요.',
            1800,
            PLAY_LLM_TIMEOUT_MS,
            (raw) => Array.isArray(raw?.props)
          )
          rows = Array.isArray(part.raw?.props) ? part.raw.props : []
        } catch (error) {
          if (isAbortError(error) && !isTimeoutAbort(error)) throw error
          rows = []
        }
      }
      return keepRecurringProps(script, rows, names).map((row, index) => ({
        id: `prop_${index + 1}`,
        name: row.name,
        description: row.description,
        mentions: row.mentions
      }))
    }

    let subjectPart: { raw: any; model?: string } = {
      raw: { subjects: input.existingSubjects || [] }
    }
    let scenePart: { raw: any; model?: string } = {
      raw: { scenes: input.existingScenes || [] }
    }

    if (stageOrder[startAt] <= stageOrder.subjects) {
      onProgress?.('1/3단계 — 캐릭터와 반복 등장하는 소품을 추출하는 중…')
      const playPeople = extractSubjectsFromPlay(play)
      if (playPeople.length) {
        log(`✓ 从剧本文字抽出 ${playPeople.length} 个角色，不走模型`)
        onProgress?.(`대본에 캐릭터 설정이 있어 캐릭터 ${playPeople.length}개를 바로 저장했습니다.`)
        subjectPart = { raw: { subjects: playPeople }, model: parallelModel }
      } else {
        subjectPart = await runPart('캐릭터', subjectSystem, 4000, PLAY_LLM_TIMEOUT_MS)
      }
      const rows = Array.isArray(subjectPart.raw?.subjects) ? subjectPart.raw.subjects : playPeople
      if (!rows.length) throw new Error('캐릭터 추출에 실패했습니다. 대본에 캐릭터 섹션이나 대사의 화자 이름이 없고 모델도 명단을 반환하지 않았습니다.')
      const normalized = normalizeStoryboard(
        { subjects: rows, scenes: [], shots: [] },
        { style: input.style, topic: input.topic, content: input.content, keywords: input.keywords, maxShotDuration: input.maxShotDuration }
      )
      const props = await pullRecurringProps(play, normalized.subjects ?? [])
      await input.onExtractStage?.('subjects', { subjects: normalized.subjects, props, scenes: [], shots: [] })
      onProgress?.(
        props.length
          ? `✓ 已保存 ${normalized.subjects?.length || 0} 个角色，${props.length} 个反复出现的道具`
          : `✓ 已保存 ${normalized.subjects?.length || 0} 个角色`
      )
      if (stopAfter === 'subjects') {
        onProgress?.('캐릭터 추출을 마쳤습니다. 확인 후 장면을 추출합니다.')
        return {
          result: { subjects: normalized.subjects, props, scenes: [], shots: [] },
          model: subjectPart.model || parallelModel
        }
      }
    } else {
      onProgress?.(`✓ 저장된 캐릭터 ${input.existingSubjects?.length || 0}개에서 이어서 작업합니다.`)
    }

    if (stageOrder[startAt] <= stageOrder.scenes) {
      onProgress?.('2/3단계 — 장면의 기준 정보를 추출하는 중…')
      const playScenes = extractLocationsFromPlay(play)
      if (playScenes.length) {
        log(`✓ 从剧本文字抽出 ${playScenes.length} 个地点，不走模型`)
        onProgress?.(`대본에 장소가 있어 장면 ${playScenes.length}개를 바로 저장했습니다.`)
        scenePart = { raw: { scenes: playScenes }, model: parallelModel }
      } else {
        const sceneUser = `主题：${input.topic || '（未填）'}
比例：${input.aspectRatio}

Extract locations only from the supplied locations and scene excerpts. Do not invent places. Record each place once.
${extractPlayForSceneStage(play)}`
        try {
          scenePart = await runPart(
            '场景',
            sceneSystem,
            8000,
            PLAY_LLM_TIMEOUT_MS,
            (raw) => extractSceneRows(raw).length > 0,
            'The prior response omitted or misplaced scenes. Return one object with a nonempty top-level scenes array. Do not wrap it in data or result, and do not include reasoning.',
            sceneUser
          )
        } catch (error) {
          if (isAbortError(error) && !isTimeoutAbort(error)) throw error
          throw error
        }
      }
      let rows = extractSceneRows(scenePart.raw)
      if (!rows.length && playScenes.length) rows = playScenes
      if (!rows.length) throw new Error('장면 추출에 실패했습니다. 대본에 「环境与场景」이나 「内景｜장소」가 없고 모델도 장소를 반환하지 않았습니다. 캐릭터 노드는 저장됐습니다.')
      const normalized = normalizeStoryboard(
        { ...scenePart.raw, subjects: subjectPart.raw.subjects || [], scenes: rows, shots: [] },
        { style: input.style, topic: input.topic, content: input.content, keywords: input.keywords, maxShotDuration: input.maxShotDuration }
      )
      await input.onExtractStage?.('scenes', { ...normalized, shots: [] })
      onProgress?.(`✓ 장면 ${normalized.scenes?.length || 0}개를 저장했습니다.`)
      if (stopAfter === 'scenes') {
        onProgress?.('장면 추출을 마쳤습니다. 확인 후 스토리보드를 추출합니다.')
        return {
          result: { ...normalized, shots: [] },
          model: scenePart.model || subjectPart.model || parallelModel
        }
      }
    } else {
      onProgress?.(`✓ 저장된 장면 ${input.existingScenes?.length || 0}개에서 이어서 작업합니다.`)
    }

    onProgress?.('3/3단계 — 장면을 작업 묶음으로 나누고 스토리보드를 병렬 작성하는 중…')
    const subjectNames = (Array.isArray(subjectPart.raw?.subjects) ? subjectPart.raw.subjects : [])
      .map((item: { name?: unknown }) => String(item?.name || '').trim())
      .filter(Boolean)
    const sceneNames = extractSceneRows(scenePart.raw)
      .map((item: { name?: unknown }) => String(item?.name || '').trim())
      .filter(Boolean)
    // 目标总时长 ÷ 模型单镜上限 = 小组数。30 秒、最长 15 秒 → 2 组，每组 15 秒。
    const targetDurationSec =
      Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
    const maxShotSec = shotDurationLimit(input)
    const slices = durationSlices(targetDurationSec, maxShotSec)
    const totalShotBudget = slices.length
    const workBatches = buildShotWorkBatches(play, totalShotBudget || undefined)
    if (!workBatches.length) throw new Error('대본 본문이 비어 있어 샷을 나눌 수 없습니다.')
    onProgress?.(
      slices.length
        ? `目标成片 ${targetDurationSec} 秒，单镜最长 ${maxShotSec} 秒 → ${workBatches.length} 个小组（${slices.join(' + ')} 秒）`
        : `已拆成 ${workBatches.length} 个剧情工作包；每包最多 ${SHOTS_PER_BATCH} 镜，同时运行 ${Math.min(SHOT_BATCH_CONCURRENCY, workBatches.length)} 个小组…`
    )
    const directives = extractPlayDirectives(play)
    const batchShots: Array<Record<string, unknown>[] | undefined> = new Array(workBatches.length)
    const batchModels: Array<string | undefined> = new Array(workBatches.length)
    // 有时长切片时，一组只出一镜，时长就是这一片的秒数。
    const perBatchBudget = (index: number) => {
      if (slices.length) return 1
      return undefined
    }
    const perBatchSeconds = (index: number) => slices[index]
    const failed: Array<{ index: number; label: string; error: string }> = []
    let completed = 0
    let persistedPrefix = 0
    let persistQueue = Promise.resolve()
    const subjectRows = Array.isArray(subjectPart.raw?.subjects) ? subjectPart.raw.subjects : []
    const sceneRows = extractSceneRows(scenePart.raw)
    const normalizedFromFinishedBatches = (onlyContiguousPrefix = false) => {
      const rows = onlyContiguousPrefix
        ? batchShots.slice(0, persistedPrefix)
        : batchShots
      const shots = rows.flatMap((batch) => batch || [])
      return normalizeStoryboard(
        { ...scenePart.raw, subjects: subjectRows, scenes: sceneRows, shots },
        { style: input.style, topic: input.topic, content: input.content, keywords: input.keywords, maxShotDuration: input.maxShotDuration }
      )
    }
    const landFinishedBatch = async (
      index: number,
      result: { shots: Record<string, unknown>[]; model?: string }
    ) => {
      batchShots[index] = result.shots
      batchModels[index] = result.model
      completed++
      input.onBatchDone?.(index, result.shots, result.model)
      while (batchShots[persistedPrefix]) persistedPrefix++
      if (persistedPrefix > 0 && index < persistedPrefix) {
        const partial = normalizedFromFinishedBatches(true)
        const completedSnapshot = completed
        onProgress?.(`✓ 작업 묶음 ${completed}/${workBatches.length}개 완료. 누적 샷 ${partial.shots.length}개를 대본 순서대로 캔버스에 저장하는 중…`)
        persistQueue = persistQueue.then(() =>
          input.onExtractStage?.('shots', partial, {
            partial: true,
            completed: completedSnapshot,
            total: workBatches.length
          })
        )
        await persistQueue
      } else {
        onProgress?.(`✓ 작업 묶음 ${completed}/${workBatches.length}개 완료. 앞 구간을 기다린 뒤 샷 번호 순서로 저장합니다.`)
      }
    }

    await mapLimit(
      workBatches,
      SHOT_BATCH_CONCURRENCY,
      async (batch, index) => {
        // 断点续跑：这个工作包上次已经完成，直接复用结果，不重复消耗 token。
        const resumed = input.resumeBatchShots?.[index]
        if (resumed?.length) {
          onProgress?.(`↩ ${batch.label}에 저장된 결과를 재사용합니다(샷 ${resumed.length}개).`)
          await landFinishedBatch(index, { shots: resumed })
          return
        }
        try {
          const result = await generateShotWorkBatch(
            input,
            parallelModel,
            batch,
            subjectNames,
            sceneNames,
            directives,
            false,
            perBatchBudget(index),
            totalShotBudget || undefined,
            targetDurationSec || undefined,
            perBatchSeconds(index)
          )
          await landFinishedBatch(index, result)
        } catch (error) {
          if (isAbortError(error) && !isTimeoutAbort(error)) throw error
          failed.push({
            index,
            label: batch.label,
            error: (error as Error).message.split('\n')[0]
          })
          onProgress?.(`⚠ ${batch.label}의 첫 병렬 작업을 완료하지 못했습니다. 다른 작업 묶음은 계속합니다.`)
        }
      },
      input.signal
    )
    await persistQueue

    if (failed.length) {
      const retryRows = [...failed].sort((a, b) => a.index - b.index)
      failed.length = 0
      onProgress?.(`완료되지 않은 작업 묶음 ${retryRows.length}개를 API 동시 요청 제한에 맞춰 하나씩 다시 시도하는 중…`)
      for (const item of retryRows) {
        throwIfAborted(input.signal)
        const batch = workBatches[item.index]
        try {
        const result = await generateShotWorkBatch(
          input,
          parallelModel,
          batch,
          subjectNames,
          sceneNames,
          directives,
          true,
          perBatchBudget(item.index),
          totalShotBudget || undefined,
          targetDurationSec || undefined,
          perBatchSeconds(item.index)
        )
        await landFinishedBatch(item.index, result)
        } catch (error) {
          if (isAbortError(error) && !isTimeoutAbort(error)) throw error
          failed.push({
            index: item.index,
            label: item.label,
            error: (error as Error).message.split('\n')[0]
          })
          onProgress?.(`⚠ ${item.label}을 개별로 다시 시도했지만 실패했습니다. 다음 묶음을 처리합니다.`)
        }
      }
      await persistQueue
    }

    let rawShots = batchShots.flatMap((rows) => rows || [])
    // 兜底：模型超发时按预算截断，宁可少一镜也不让成片时长失控。
    if (totalShotBudget && rawShots.length > totalShotBudget) {
      onProgress?.(
        `⚠ 模型给出 ${rawShots.length} 镜，超出 ${targetDurationSec} 秒的 ${totalShotBudget} 镜预算，按剧本顺序保留前 ${totalShotBudget} 镜`
      )
      rawShots = rawShots.slice(0, totalShotBudget)
    }
    if (!rawShots.length) {
      throw new Error(`모든 스토리보드 작업 묶음이 실패했습니다. 캐릭터와 장면은 저장됐습니다. 스토리보드 추출을 다시 시도하세요.${failed[0]?.error ? `첫 번째 오류 ${failed[0].error}` : ''}`)
    }
    if (!subjectRows.length) {
      const names = new Set<string>()
      for (const shot of rawShots) {
        for (const name of Array.isArray(shot?.subjectNames) ? shot.subjectNames : []) {
          if (String(name || '').trim()) names.add(String(name).trim())
        }
        const speaker = String(shot?.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
        if (speaker) names.add(speaker)
      }
      subjectRows.push(
        ...[...names].slice(0, 8).map((name) => ({
          name,
          kind: 'person',
          description: `${name}，外貌与服装细节待在画布补充`,
          role: '由分镜对白和动作识别出的出场人物',
          stateVariants: '单一状态'
        }))
      )
    }
    if (!sceneRows.length) {
      const names = [...new Set(rawShots.map((shot) => String(shot?.sceneName || '').trim()).filter(Boolean))]
      sceneRows.push(
        ...names.slice(0, 8).map((name) => ({
          name,
          description: `${name}，空间结构、地面材质、主锚与光线细节待在画布补充`,
          mainAnchor: '场景中心视觉焦点',
          anchors: '全景；主锚；地面站位区；光源',
          lighting: '与本场剧情匹配的主光源'
        }))
      )
    }

    if (failed.length) {
      const partial = normalizedFromFinishedBatches()
      await input.onExtractStage?.('shots', partial, {
        partial: true,
        completed,
        total: workBatches.length
      })
      throw new Error(
        `${failed.length}/${workBatches.length}개 스토리보드 작업 묶음이 실패했습니다. 나머지 ${rawShots.length}개 샷은 저장됐습니다. 실패한 구간 ${failed.map((item) => item.label).join('、')}`
      )
    }
    onProgress?.(`✓ 작업 묶음 ${workBatches.length}개를 완료해 샷 ${rawShots.length}개를 추출했습니다.`)
    const merged = {
      ...scenePart.raw,
      subjects: subjectRows,
      scenes: sceneRows,
      shots: rawShots
    }
    const parsed = await ensureShotDuration(
      normalizeStoryboard(merged, {
        style: input.style,
        topic: input.topic,
        content: input.content,
        keywords: input.keywords,
        maxShotDuration: input.maxShotDuration
      }),
      { ...input, targetDurationSec: targetDurationSec || input.targetDurationSec },
      parallelModel,
      onProgress
    )
    const warnings = storyboardQualityIssues(parsed, input)
    if (warnings.length) {
      log(`⚠ 并行提炼完成，保留可编辑稿并提示 ${warnings.length} 项：${warnings.join('；')}`)
      onProgress?.(`단계별 추출을 완료했습니다. 캔버스에서 ${warnings.length}개 항목을 더 조정할 수 있습니다.`)
    } else {
      onProgress?.('캐릭터, 장면, 스토리보드를 추출하고 연결했습니다.')
    }
    await input.onExtractStage?.('shots', parsed, {
      partial: false,
      completed: workBatches.length,
      total: workBatches.length
    })
    const usedModel = batchModels.find(Boolean) || subjectPart.model || scenePart.model || parallelModel
    return { result: parsed, model: usedModel }
  }

  const budgetSec =
    Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  const budgetShots = shotBudgetFromDuration(budgetSec, input.maxShotDuration)
  const budgetLine = budgetShots
    ? `\n【镜数与时长硬上限】用户要的是 ${budgetSec} 秒成片，单镜最长 ${shotDurationLimit(input)} 秒，所以只批 ${budgetShots} 个镜头。允许 ${budgetSec - DURATION_TOLERANCE_SEC}–${budgetSec + DURATION_TOLERANCE_SEC} 秒。全部镜头 duration 相加必须落在这个窗口。`
    : ''

  const userText = extractMode
    ? `${verbatimSplitRule(input.verbatim)}아래에 완성된 대본이 있습니다. **원문에 충실하게** 캔버스 노드 JSON(subjects / scenes / shots)을 추출하세요. 이야기를 고치거나 새로 만들지 마세요.${budgetLine}

전체 대본
"""
${input.content?.trim() || '（空）'}
"""

主题：${input.topic || '（未填）'}
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}
视频比例：${input.aspectRatio}
时长参考：大约每镜 ${input.shotDuration} 秒（跟剧本里的场次走，别强行统一）

${stylePriority}
${productNote}

캐릭터, 장면과 개별 장면은 대본과 일치시켜야 합니다. 원문 대사는 해당 샷의 voiceover에 ‘캐릭터 이름：대사’로 넣으세요. 성인이 된 인물의 내레이션으로 바꾸거나 대사를 비우지 마세요. 같은 인물이 같은 의도로 이어 말하는 짧은 대사 2–4개는 가능한 한 한 샷에 넣고 대사마다 기계적으로 샷을 나누지 마세요. visualPrompt는 대본의 화면을 바탕으로 그릴 수 있는 영어 정지 화면 프롬프트로 쓰세요. videoPrompt는 영어로 0초부터 샷이 끝날 때까지 실제 박자에 따라 2–5구간으로 나누세요. 구간마다 인물의 시작 상태, 보는 대상, 동작, 화자와 대사 원문, 다른 인물의 위치와 반응, 감정 변화, 카메라 움직임과 도착점을 쓰세요. 기계적으로 등분하거나 ‘멍한 표정을 피한다’처럼 상투적인 문구를 넣지 마세요. 대사 중 화면을 좁힐지는 화면의 느낌, 동작, 공간 관계, 감정 리듬에 맞춰 정하세요. 표정을 강조할 때는 근경이나 클로즈업을, 관계나 환경을 유지할 때는 중경이나 두 사람 또는 여러 사람이 보이는 구도를 사용하세요. 모든 대사를 클로즈업으로 처리하거나 visualPrompt를 복사하지 마세요. JSON을 바로 출력하세요.`
    : `시나리오 작성 지침에 따라 원고를 촬영할 수 있는 스토리보드로 나누세요. 내레이션은 말할 수 있게 쓰고 모델용 화면 묘사는 Write model-facing imagery in clear natural English instead of a list of disconnected prompt keywords.${budgetLine}

원문의 사실을 유지하세요. 원문에 없는 가격, 제품 사양, 효능, 인물 관계, 브랜드 약속이나 결말을 추가하지 마세요. 숫자와 고유명사는 원문 그대로 유지하세요. 정보가 부족하면 화면으로 연결하고 사실을 만들어 채우지 마세요.

원고 주제
"""
${input.topic || '（未填）'}
"""

원고 내용
"""
${input.content?.trim() || '（본문 없음. 참조 이미지가 있다면 이미지에 맞춰 내레이션과 샷을 작성）'}
"""
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}

视频比例：${input.aspectRatio}
时长参考：大约每镜 ${input.shotDuration} 秒（只是节奏，别所有镜头同一秒数）

${stylePriority}
${productNote}

먼저 캐릭터와 장소를 고정한 뒤 샷을 나누세요. 샷마다 visualPrompt는 정지 화면에서 보이는 것을 샷 연출에 맞춰 쓰고, videoPrompt는 해당 샷에서 연기할 동작을 쓰세요. 샷 이미지 프롬프트를 반복하지 마세요.
${
  hasUserStyle
    ? `画风「${mediumPhrase}」在画面描述里点一次，写进桥、水、衣这些实物上。禁止第一句只写画风、结尾再抄一段技法套话。禁止只写「两人相对拱手」这种站位摘要。`
    : `主题没提画风时，画面里带上「${styleCn}」，同样要写清环境实物与动态。`
}
설명 없이 JSON만 출력하세요.`

  const extractSystemExtra = extractMode
    ? `\n【이번 작업】입력은 완성된 대본입니다. 추출하고 저장에 필요한 필드만 보완하세요. 내레이션 원문의 의미를 바꾸거나 대본에서 구분한 인물을 합치지 마세요. 각 subject는 적어도 한 샷의 subjectIds에 연결하고 visualPrompt에서 이름을 언급해 화면에 등장시키세요.`
    : ''

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${directorPlaybook}

${NARRATIVE_CONTINUITY_RULES}
${SPEAKER_STAGING_RULES}

${productNote}

${stylePriority}
${extractSystemExtra}

Output languages: write titles and user-facing descriptions in Korean (한국어). Write h3Aesthetic, visualPrompt, and videoPrompt in English for the generation models. Keep title text requested in Korean and original dialogue verbatim.
${videoPerformanceSpec(getVideoPromptStyle())}

【출력 JSON】
{
  "aesthetic": "<One or two natural sentences in Korean about the overall tone, using the user's wording>",
  "h3Aesthetic": "<English production aesthetic, concrete lighting/material/camera qualities>",
  "styleBrief": "<Purpose, central conflict, and why a viewer keeps watching>",
  "colorPalette": "<Visible colors in the scene, without palette numbers>",
  "lightingNote": "<Time of day and source of light>",
  "subjects": [
    {
      "id": "sub_1",
      "name": "Short, speakable character name",
      "kind": "person|animal|other",
      "description": "<Identity details concrete enough to match at a market: age, hairstyle, clothes, shoes, scars, or habitual movements. Exclude place and weather. The character sheet has four views on white>",
      "role": "<Role in the film>",
      "stateVariants": "<Wardrobe changes, or 单一状态 if unchanged>",
      "voicePrompt": "<One English sentence for dubbing direction, covering age and gender, timbre, pace and intensity, emotional tone, accent or speech habits. Empty for animal or other>",
      "props": "<Items worn or carried, such as bag, ID, tablet, shoes, or hat. Use 无 if none>",
      "fromReference": false
    }
  ],
  "scenes": [
    {
      "id": "scn_1",
      "name": "Short place name",
      "description": "<At least 80 characters on ground, water, vegetation, buildings, wind, and light before people enter>",
      "mainAnchor": "<Physical anchor visible to the camera>",
      "anchors": "<Four anchors separated by semicolons: wide view, main anchor, ground or blocking area, light source or secondary anchor>",
      "lighting": "<Time and light source>"
    }
  ],
  "shots": [
    {
      "title": "3–8 character title suitable for a slate",
      "purpose": "钩子/说明/反应/揭示/收口",
      "shotSize": "<Framing and reason for it>",
      "blocking": "<Foreground and background position, what each person stands on, and body orientation. The speaker may be behind others. Avoid frontal lineups>",
      "eyeline": "<Eyeline per person. Foreground people look back or sideways toward the speaker or indicated object, away from the camera>",
      "continuity": "<Previous concrete ending or opening state for the first shot → current visible change → specific state for the next shot. State position, pose, orientation, held items, emotion, and knowledge>",
      "propFocus": "<Prop to show clearly and its current state, or 无 if none>",
      "visualPrompt": "<Write a visible English still-frame prompt. Specify objects from near to far, movement or stillness in water, wind, and clothing, light source, wardrobe, ground, and objects in hand. Mention the medium once. Avoid generic style paragraphs or blocking alone>",
      "videoPrompt": "${videoPromptJsonHint(getVideoPromptStyle())}",
      "audioDescription": "<Audible scene sounds, separated by commas>",
      "voiceover": "<Character name: 1–4 consecutive short original lines. Prefer 2–4, or leave empty if silent>",
      "audioMode": "h3-dialogue|h3-voiceover|tts|none",
      "speakerHint": "<Voice quality, emotion, delivery, or empty if silent>",
      "duration": <5-${shotDurationLimit(input)}>,
      "cameraMovement": "push|pull|pan|tilt|static|orbit",
      "subjectIds": ["sub_1"],
      "sceneId": "scn_1"
    }
  ]
}

画风：用户原词写进画面实物，不要单独成段。主题完全没提才用下拉「${styleCn}」。
visualPrompt 若只有站位没有环境实物、或开头结尾是画风套话，视为不合格。
videoPrompt 若没从0秒覆盖到镜头结束、没按拍点写清每段谁在做什么和谁在说什么，或只是机械等分后填套话，视为不合格。
${hasUserStyle && !look.matched ? '这是自定义画风，不要套页面下拉风格。' : `${styleGuide.avoid}。`}
Use H3 on-screen dialogue by default. Divide the original words into meaningful paragraphs for voiceover and set audioMode=h3-dialogue. Avoid one line per shot. The current model accepts at most ${shotDurationLimit(input)} seconds per shot. For a shared place, person, intention, or continuous action, prefer one complete 7–${shotDurationLimit(input)}-second shot when it fits. Do not force two 5-second shots to fill a template. Cut only when focus, time, place, axis, or dramatic purpose changes. Reserve a single line for brief reactions or transitions and allow about four characters per second. Use "Character name: dialogue" in voiceover and specify the speaker and vocal quality in speakerHint.
Follow action, spacing, and emotion when choosing framing. Use close framing when the expression matters and no surroundings are needed; use medium, two-person, or group framing for handoffs, arguments, exchanges, distance, environmental pressure, or group reactions. Do not force close-ups; name who speaks and others' reactions so mouths do not open together.
Use h3-voiceover only for explicit off-screen narration, tts for requested dubbing in postproduction, and none for a silent empty shot. Create a separate subject for each ### under characters. Show a deceased character's keepsake, portrait, or flashback in at least one shot, and a living opponent's confrontation or visible pressure in at least one shot. Give every shot its own specific 3–8-character Korean title. Verify adjacent continuity and apply the narrative rules to major changes instead of jumping from a result to explanatory speech.
Return valid JSON only.`
    },
    {
      role: 'user',
      content: userText
    }
  ]

  const { baseUrl, model: cfgModel } = getLlmConfig()
  const model = resolvePlayModel(input) || cfgModel
  log(
    `→ 调用主 LLM: ${baseUrl}/chat/completions (model: ${model})`
  )

  const resp = await callLLM({
    messages,
    model,
    temperature: 0.45,
    jsonMode: true,
    maxTokens: 24576,
    signal: input.signal,
    timeoutMs: PLAY_LLM_TIMEOUT_MS
  })

  log(`← 收到响应 (${resp.content.length} 字符)`)
  if (resp.content.includes('<think>') || resp.content.includes('<reasoning>')) {
    log('⚠ 响应包含思考标签，使用鲁棒解析剥除')
  }

  let parsed = normalizeStoryboard(await parseJsonWithModelRepair(resp.content, input, '脚本首稿'), {
    style: input.style,
    topic: input.topic,
    content: input.content,
    keywords: input.keywords,
    maxShotDuration: input.maxShotDuration
  })

  if (!parsed?.shots || !Array.isArray(parsed.shots)) {
    throw new Error(
      `LLM 응답 구조에 shots 배열이 없습니다. ${JSON.stringify(parsed).slice(0, 200)}`
    )
  }

  parsed = await polishStoryboardOnce(parsed, input, model, onProgress)
  parsed = await ensureShotDuration(parsed, input, model, onProgress)

  log(
    `✓ 解析成功，${parsed.subjects?.length ?? 0} 个主体 / ${parsed.scenes?.length ?? 0} 个场景 / ${parsed.shots.length} 个分镜`
  )
  const durSummary = parsed.shots.map((s) => s.duration).join('+')
  const totalDur = parsed.shots.reduce((sum, s) => sum + s.duration, 0)
  log(`⏱ 镜头秒数：${durSummary} = ${totalDur}s`)
  return { result: parsed, model: resp.model ?? model }
}

function asKind(v: unknown): Subject['kind'] {
  return v === 'animal' || v === 'other' || v === 'person' ? v : 'person'
}

/**
 * 人物音色描述归一化。非人物一律清空；
 * 人物漏写时补一条通用兜底，保证「每个会说话的角色都有声线」，不会每镜一个声音。
 */
function normalizeVoicePrompt(v: unknown, kind: Subject['kind']): string | undefined {
  if (kind !== 'person') return undefined
  const text = String(v || '').trim()
  return text || FALLBACK_VOICE_PROMPT
}

/** 通用兜底声线：模型漏写 voicePrompt 时用，避免同一角色每镜声音漂移。 */
export const FALLBACK_VOICE_PROMPT =
  '自然口语的中文对白声线，语速中等、气息平稳，情绪贴合本场剧情，不要播音腔'

function spokenSentenceCount(text: string): number {
  const body = (text || '').replace(/^[^：:\n]{1,12}[：:]\s*/, '').trim()
  if (!body) return 0
  const parts = body.split(/[。！？!?；;]+/).map((part) => part.trim()).filter(Boolean)
  return Math.max(1, parts.length)
}

function voiceoverSpeakerLabels(text: string): string[] {
  const labels: string[] = []
  const source = (text || '').trim()
  const pattern = /(?:^|[\n。！？!?])\s*([^：:\n。！？!?]{1,12})[：:]\s*/g
  for (const match of source.matchAll(pattern)) {
    const label = match[1].trim()
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/** 口播里的「名字：台词」标签 → 角色卡。名字对不上再退回包含匹配。 */
export function matchSpeakerSubject(
  label: string,
  subjects: Array<{ id: string; name: string; voicePrompt?: string }>
): { id: string; name: string; voicePrompt?: string } | undefined {
  const key = String(label || '').trim()
  if (!key) return undefined
  const exact = subjects.find((s) => s.name.trim() === key)
  if (exact) return exact
  return subjects.find((s) => {
    const name = s.name.trim()
    return name && (key.includes(name) || name.includes(key))
  })
}

/**
 * 把人物节点的音色描述绑到分镜上。
 * 每镜按口播里的说话人找到角色，把 Subject.voicePrompt 写进 Shot.speakerVoice，
 * 生成视频和后期配音都读这一份，保证同一角色全片一个声线。
 * 返回成功绑定的镜数。
 */
export function bindShotVoiceHints<
  T extends { voiceover?: string; speakerVoice?: string }
>(
  shots: T[],
  subjects: Array<{ id: string; name: string; voicePrompt?: string }>
): number {
  if (!shots.length || !subjects.length) return 0
  let bound = 0
  for (const shot of shots) {
    const voiceover = String(shot.voiceover || '').trim()
    // 没有口播的镜头不绑声线：空镜不需要说话人。
    if (!voiceover) continue
    const labels = voiceoverSpeakerLabels(voiceover)
    const picked: string[] = []
    for (const label of labels) {
      const subject = matchSpeakerSubject(label, subjects)
      const voice = subject?.voicePrompt?.trim()
      if (voice && !picked.includes(voice)) picked.push(voice)
    }
    if (picked.length) {
      shot.speakerVoice = picked.join('；')
      bound++
    }
  }
  return bound
}

function mergeAdjacentShots(a: StoryboardShot, b: StoryboardShot): StoryboardShot {
  const voice = [a.voiceover, b.voiceover].map((item) => item.trim()).filter(Boolean).join('\n')
  const video = [a.videoPrompt, b.videoPrompt].map((item) => (item || '').trim()).filter(Boolean).join('\n')
  return {
    ...a,
    duration: a.duration + b.duration,
    voiceover: voice,
    videoPrompt: video || a.videoPrompt,
    audioDescription: [a.audioDescription, b.audioDescription].filter(Boolean).join('，'),
    subjectIds: [...new Set([...(a.subjectIds || []), ...(b.subjectIds || [])])],
    continuity: [a.continuity, b.continuity].filter(Boolean).join(' → ')
  }
}

/** 镜数放不进窗口时合并相邻镜头，再把各镜秒数收进目标 ±10 秒。收不进去返回 null。 */
function fitShotsToDuration(
  shots: StoryboardShot[],
  targetSec: number,
  maxShot: number
): StoryboardShot[] | null {
  const max = Math.max(MIN_SHOT_SEC, maxShot)
  const minCount = Math.max(1, Math.ceil((targetSec - DURATION_TOLERANCE_SEC) / max))
  const maxCount = Math.max(minCount, Math.floor((targetSec + DURATION_TOLERANCE_SEC) / MIN_SHOT_SEC))
  const rows = shots.map((shot) => ({ ...shot }))
  while (rows.length > maxCount && rows.length > 1) {
    let index = 0
    let smallest = Number.POSITIVE_INFINITY
    for (let i = 0; i < rows.length - 1; i++) {
      const sum = rows[i].duration + rows[i + 1].duration
      if (sum < smallest) {
        smallest = sum
        index = i
      }
    }
    rows.splice(index, 2, mergeAdjacentShots(rows[index], rows[index + 1]))
  }
  if (rows.length < minCount) return null
  const goal = Math.min(rows.length * max, Math.max(rows.length * MIN_SHOT_SEC, targetSec))
  const weight = rows.reduce((sum, shot) => sum + Math.max(MIN_SHOT_SEC, shot.duration), 0) || rows.length
  const values = rows.map((shot) =>
    Math.min(max, Math.max(MIN_SHOT_SEC, Math.round((Math.max(MIN_SHOT_SEC, shot.duration) / weight) * goal)))
  )
  let total = values.reduce((sum, value) => sum + value, 0)
  let guard = 0
  while (total !== goal && guard++ < 500) {
    if (total > goal) {
      const index = values.reduce((best, value, i) => (value > values[best] ? i : best), 0)
      if (values[index] <= MIN_SHOT_SEC) break
      values[index] -= 1
      total -= 1
    } else {
      const index = values.findIndex((value) => value < max)
      if (index < 0) break
      values[index] += 1
      total += 1
    }
  }
  if (Math.abs(total - targetSec) > DURATION_TOLERANCE_SEC) return null
  return rows.map((shot, index) => ({ ...shot, duration: values[index] }))
}

/**
 * 检测成片总时长。不合格就打回重拆；模型仍交不出合格时长时，强制把各镜秒数收进 ±10 秒。
 */
async function ensureShotDuration(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  const target =
    Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  if (target < 10 || !parsed.shots.length) return parsed
  let current = parsed
  for (let round = 0; round <= DURATION_REPAIR_ROUNDS; round++) {
    const total = totalShotDuration(current.shots)
    const issue = durationWindowIssue(total, target)
    if (!issue) {
      if (round > 0) onProgress?.(`时长检测通过：总时长 ${total} 秒，在 ${target} 秒的 ±${DURATION_TOLERANCE_SEC} 秒内`)
      return current
    }
    if (round === DURATION_REPAIR_ROUNDS) break
    onProgress?.(
      `时长检测未通过：现在 ${total} 秒，用户要 ${target} 秒（允许 ${target - DURATION_TOLERANCE_SEC}–${target + DURATION_TOLERANCE_SEC} 秒）。打回按时长重拆（${round + 1}/${DURATION_REPAIR_ROUNDS}）…`
    )
    try {
      current = await repairStoryboardOnce(current, { ...input, targetDurationSec: target }, model, [issue])
    } catch (error) {
      log(`⚠ 时长打回失败，改为强制收秒：${(error as Error).message}`)
      break
    }
  }
  const fitted = fitShotsToDuration(current.shots, target, shotDurationLimit(input))
  if (!fitted) {
    const total = totalShotDuration(current.shots)
    throw new Error(
      `时长检测未通过：总时长 ${total} 秒，用户要求 ${target} 秒，只允许上下浮动 ${DURATION_TOLERANCE_SEC} 秒。已打回重拆 ${DURATION_REPAIR_ROUNDS} 次，仍收不进这个区间。`
    )
  }
  const fittedTotal = totalShotDuration(fitted)
  onProgress?.(`길이 검사를 통과하지 않아 목표 ${target}초에 맞춰 샷 길이를 조정했습니다. 현재 ${fittedTotal}초입니다.`)
  return { ...current, shots: fitted }
}

export function storyboardQualityIssues(
  result: StoryboardResult,
  input: Pick<StoryboardInput, 'content' | 'topic' | 'targetDurationSec' | 'maxShotDuration'>
): string[] {
  const issues: string[] = []
  if (!result.shots.length) issues.push('심각: 생성된 스토리보드 샷이 없습니다.')
  const targetSec = Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  const shotCap = shotBudgetFromDuration(targetSec, input.maxShotDuration) || 12
  if (result.shots.length > shotCap) {
    issues.push(
      `${targetSec ? '심각: ' : ''}스토리보드 샷 ${result.shots.length}개가 ${targetSec ? `목표 ${targetSec}초에 해당하는 ${shotCap}` : shotCap}개 한도를 넘었습니다. 숏폼 영상의 리듬에 맞게 줄이세요.`
    )
  }
  if (
    result.subjects?.length === 1 &&
    result.subjects[0]?.name === '主角' &&
    (input.content || '').trim()
  ) {
    issues.push('심각: 사용자 원문에서 캐릭터를 충분히 추출하지 못하고 기본 ‘주인공’만 생성했습니다.')
  }
  const sourceText = `${input.topic || ''}\n${input.content || ''}`
  const castText = (result.subjects ?? [])
    .map((subject) => `${subject.name} ${subject.description} ${subject.role || ''}`)
    .join('\n')
  const visibleRoles = [
    '大哥', '哥哥', '兄长', '弟弟', '妹妹', '父亲', '母亲', '爸爸', '妈妈',
    '爷爷', '奶奶', '祖父', '祖母', '老人', '老者', '老师', '同学', '店员',
    '顾客', '主持人', '女孩', '男孩', '女人', '男人'
  ].filter((role) => sourceText.includes(role) && !castText.includes(role))
  if (visibleRoles.length) {
    issues.push(`심각: subjects에서 다음 원문 인물이 빠졌습니다. ${visibleRoles.join('、')}`)
  }
  const normalizedTitles = result.shots.map((shot) => shot.title.trim())
  if (
    normalizedTitles.some((title) => /^(?:镜头|샷)\s*\d*$/.test(title)) ||
    new Set(normalizedTitles).size !== normalizedTitles.length
  ) {
    issues.push('심각: 스토리보드 제목이 없거나 중복됩니다. 샷마다 내용에 맞는 제목을 쓰세요. 모두 ‘샷’으로 적지 마세요.')
  }
  const targetDuration = targetSec
  const totalDuration = result.shots.reduce((sum, shot) => sum + shot.duration, 0)
  const durationIssue = durationWindowIssue(totalDuration, targetDuration)
  if (durationIssue) issues.push(durationIssue)
  if (!result.h3Aesthetic || result.h3Aesthetic.length < 35) {
    issues.push('H3에 바로 보낼 영어 Aesthetic이 없습니다.')
  }
  const people = (result.subjects ?? []).filter((s) => s.kind !== 'other')
  const voicedShots = result.shots.filter((shot) => (shot.voiceover || '').trim())
  const looksLikeAd = /带货|产品演示|口播文案/.test(`${input.topic || ''}\n${input.content || ''}`)
  if (
    !looksLikeAd &&
    people.length >= 2 &&
    result.shots.length >= 4 &&
    voicedShots.length < Math.max(3, Math.ceil(result.shots.length * 0.35))
  ) {
    issues.push('대사가 너무 적습니다. 여러 인물이 함께 있는 샷에서 거의 말하지 않습니다. 이름 부르기, 질문과 답변, 서로 알아보기, 대치, 만류는 voiceover에 대사를 써야 합니다. 앞 이야기를 전부 첫 샷의 성인이 된 인물 내레이션에 넣지 마세요.')
  }
  if (
    voicedShots.some((shot) => /成年/.test(shot.voiceover)) &&
    voicedShots.filter((shot) => !/成年/.test(shot.voiceover)).length < 2
  ) {
    issues.push('화면 속 대사가 성인이 된 인물의 내레이션으로 바뀌었습니다. 이 장면에서 보이는 인물이 직접 말해야 합니다. 배경을 내레이션으로 요약하지 마세요.')
  }
  if (
    totalDuration >= 25 &&
    voicedShots.length >= 3 &&
    voicedShots.every((shot) => spokenSentenceCount(shot.voiceover) <= 1)
  ) {
    issues.push('대사가 샷마다 한 마디씩 기계적으로 나뉘었습니다. 같은 인물이 같은 의도로 이어 말하는 2–4마디를 7–10초 샷 하나에 넣으세요. 짧은 반응에만 한 마디를 쓰세요.')
  }
  result.shots.forEach((shot, index) => {
    const label = `${index + 1}번 샷`
    const speakers = voiceoverSpeakerLabels(shot.voiceover || '')
    const speaker = speakers[0]
    if (shot.audioMode === 'h3-dialogue' && speaker) {
      const staging = [shot.shotSize, shot.blocking, shot.visualPrompt, shot.videoPrompt]
        .filter(Boolean)
        .join('\n')
      if (!staging.includes(speaker)) {
        issues.push(`${label}의 화면 속 대사에서 화자 ‘${speaker}’를 지목하지 않았습니다.`)
      }
    }
    if ((shot.visualPrompt || '').trim().length < 50) {
      issues.push(`${label}의 화면 묘사가 너무 짧아 안정적으로 생성하기 어렵습니다.`)
    }
    const performance = (shot.videoPrompt || '').trim()
    const still = (shot.visualPrompt || '').trim()
    if (!performance || performance === still) {
      issues.push(`${label}의 영상 연출이 빠졌습니다. 누가 무엇을 하고 말하는지, 카메라가 어떻게 움직이는지 작성하세요. 샷 이미지 설명을 재사용하지 마세요.`)
    } else {
      const names = (result.subjects || [])
        .filter((s) => (shot.subjectIds || []).includes(s.id) || performance.includes(s.name))
        .map((s) => s.name)
      const perfIssue = videoPerformanceIssue(performance, names)
      if (perfIssue) issues.push(`${label} ${perfIssue}`)
    }
    if (!shot.sceneId) issues.push(`${label}에 연결된 장면이 없습니다.`)
    if (!shot.cameraMovement) issues.push(`${label}에 카메라 움직임 방식이 없습니다.`)
    const continuity = (shot.continuity || '').trim()
    const continuitySteps = (continuity.match(/→/g) || []).length
    if (continuity.length < 28 || continuitySteps < 2) {
      issues.push(`심각: ${label}의 continuity에 ‘이전 샷 끝 상태 → 현재 샷의 변화 → 다음 샷 끝 상태’가 명시되지 않아 구간 사이의 연속성을 보장할 수 없습니다.`)
    }
    const emptyPlate =
      !shot.voiceover.trim() && /空镜|空景|无人/.test(`${shot.title}${shot.visualPrompt}`)
    if (people.length && !(shot.subjectIds ?? []).length && !emptyPlate) {
      issues.push(`심각: ${label}에 캐릭터가 연결되지 않아 샷 이미지에 캐릭터 설정 이미지를 전달할 수 없습니다.`)
    }
  })
  const source = (input.content || '').trim()
  if (source.length > 0 && result.shots.every((shot) => !shot.voiceover.trim())) {
    issues.push('심각: 사용자 원고가 있지만 모든 샷의 내레이션이 비어 있습니다.')
  }
  for (const sub of people) {
    const used = result.shots.some(
      (shot) =>
        (shot.subjectIds ?? []).includes(sub.id) ||
        inferSubjectsFromText(shotCastText(shot as Shot), [sub]).length > 0
    )
    if (!used) issues.push(`심각: 캐릭터 ‘${sub.name}’의 설정은 있지만 스토리보드의 어느 샷에도 등장하지 않습니다.`)
  }
  return issues.slice(0, 16)
}

function optStr(v: unknown): string | undefined {
  const s = String(v ?? '').trim()
  return s || undefined
}

function extractSceneRows(raw: any): any[] {
  const asRows = (value: unknown): any[] => {
    if (Array.isArray(value)) {
      return value.filter((item) => item && typeof item === 'object')
    }
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).filter(
        (item) => item && typeof item === 'object' && !Array.isArray(item)
      )
    }
    return []
  }
  const looksScene = (item: any) =>
    Boolean(
      item?.lighting ||
        item?.mainAnchor ||
        item?.anchors ||
        item?.props ||
        item?.地点 ||
        /景|屋|街|房|院|田|仓|铺|厅|路|城/.test(String(item?.name || item?.description || ''))
    )

  const keys = ['scenes', 'scene', 'locations', 'places', 'sceneList', '场景', '地点', '场景列表']
  const queue: unknown[] = [raw]
  const seen = new Set<unknown>()
  while (queue.length) {
    const cur = queue.shift()
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
    seen.add(cur)
    const rec = cur as Record<string, unknown>
    for (const key of keys) {
      const rows = asRows(rec[key]).filter((item) => item.name || item.title || item.地点)
      if (rows.length) return rows.map((item) => ({ ...item, name: item.name || item.title || item.地点 }))
    }
    for (const value of Object.values(rec)) {
      if (Array.isArray(value) && value.length >= 1 && value.every((item) => item && typeof item === 'object')) {
        const rows = value.filter(looksScene)
        if (rows.length) {
          return rows.map((item: any) => ({ ...item, name: item.name || item.title || item.地点 }))
        }
      } else if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }
  return []
}

function shotTitle(raw: any, index: number): string {
  const explicit = String(raw?.title ?? raw?.shotTitle ?? raw?.name ?? '').trim()
  if (explicit && !/^(?:镜头|샷)\s*\d*$/.test(explicit)) return explicit.slice(0, 12)

  const source = String(raw?.purpose ?? raw?.visualPrompt ?? raw?.videoPrompt ?? '')
    .replace(/^(特写|近景|中景|全景|远景|镜头|画面)[：:，,、\s-]*/i, '')
    .replace(/[【】()[\]<>"'“”‘’]/g, '')
    .trim()
  const phrase = source.split(/[，。！？；,:.!?;\n]/)[0]?.replace(/\s+/g, '') || ''
  return phrase ? `${phrase.slice(0, 6)}${index + 1}` : `샷 ${index + 1}`
}

function resolveIds(
  raw: unknown,
  idMap: Map<string, string>,
  fallback: string[]
): string[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: string[] = []
  for (const item of list) {
    const key = String(item ?? '').trim()
    if (!key) continue
    let id = idMap.get(key) || idMap.get(key.toLowerCase())
    if (!id && key.length >= 2) {
      const lower = key.toLowerCase()
      const fuzzyIds = new Set(
        [...idMap.entries()]
          .filter(([candidate]) => {
            const normalized = candidate.toLowerCase()
            return normalized.length >= 2 && (normalized.includes(lower) || lower.includes(normalized))
          })
          .map(([, candidateId]) => candidateId)
      )
      if (fuzzyIds.size === 1) id = [...fuzzyIds][0]
    }
    if (id && !out.includes(id)) out.push(id)
  }
  return out.length ? out : fallback
}

function pickBoundScene(
  resolvedId: string | undefined,
  scenes: Scene[],
  shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'audioDescription'>
): Scene | undefined {
  const hit = resolvedId ? scenes.find((item) => item.id === resolvedId) : undefined
  if (hit && !sceneConflictsWithShot(shot, hit)) return hit
  return scenes.find((item) => shotMentionsScene(shot, item) && !sceneConflictsWithShot(shot, item))
}

function stampCastNames(prompt: string, chars: Subject[]): string {
  const body = (prompt || '').trim()
  if (!chars.length) return body
  const line = `出场：${chars.map((c) => c.name).join('、')}。必须是人设里这些人，脸、发型、衣服跟设计图一致，禁止另造路人。`
  if (body.includes('出场：') && chars.every((c) => body.includes(c.name))) return body
  return body ? `${body}\n${line}` : line
}

function bindCastIntoShots(shots: StoryboardShot[], subjects: Subject[]): StoryboardShot[] {
  if (!subjects.length) return shots
  return shots.map((shot) => {
    const ids = boundSubjectIds(shot as Shot, subjects)
    const chars = ids
      .map((id) => subjects.find((s) => s.id === id))
      .filter((s): s is Subject => Boolean(s))
    return {
      ...shot,
      subjectIds: ids,
      visualPrompt: stampCastNames(shot.visualPrompt, chars),
      videoPrompt: stampCastNames(shot.videoPrompt || '', chars)
    }
  })
}

/** 把 LLM 的 subjects/scenes/shot 绑定规范成稳定 id；按用户主题画风补强过短提示 */
export function normalizeStoryboard(
  raw: any,
  opts: {
    style?: VisualStyle
    topic?: string
    content?: string
    keywords?: string[]
    maxShotDuration?: number
  } | VisualStyle = 'cinematic'
): StoryboardResult {
  const options =
    typeof opts === 'string'
      ? { style: opts as VisualStyle }
      : opts
  const style = resolveVisualStyle(
    options.style ?? 'cinematic',
    options.topic,
    options.content,
    options.keywords
  )
  const userStyleAuth = extractUserStyleAuthority(
    options.topic ?? '',
    options.content ?? '',
    options.keywords
  )
  const styleLockFromUser = userStyleAuth
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('；')
    .slice(0, 160)
  const shotsIn = Array.isArray(raw?.shots)
    ? raw.shots
    : Array.isArray(raw?.storyboard)
      ? raw.storyboard
      : []
  const rawSubjects = Array.isArray(raw?.subjects)
    ? raw.subjects
    : Array.isArray(raw?.characters)
      ? raw.characters
      : Array.isArray(raw?.cast)
        ? raw.cast
        : []
  const rawScenes = extractSceneRows(raw)

  /** 模型偶尔会把「一句话故事 / 对抗引擎 / 身材」这类标签当成人物，这里统一剔掉 */
  const subjectRows = rawSubjects.filter((s: any) => {
    const n = String(s?.name || '').trim()
    return n && !isFieldLabelName(n)
  })
  const subjects: Subject[] = subjectRows.slice(0, 8).map((s: any, i: number) => ({
    id: `sub_${i + 1}`,
    name: String(s?.name || `角色${i + 1}`).trim() || `角色${i + 1}`,
    kind: asKind(s?.kind),
    description: String(s?.description || '').trim(),
    role: optStr(s?.role),
    stateVariants: optStr(s?.stateVariants),
    voicePrompt: normalizeVoicePrompt(s?.voicePrompt, asKind(s?.kind)),
    fromReference: Boolean(s?.fromReference)
  }))

  const scenes: Scene[] = rawScenes.slice(0, 8).map((s: any, i: number) => ({
    id: `scn_${i + 1}`,
    name: String(s?.name || `场景${i + 1}`).trim() || `场景${i + 1}`,
    description: String(s?.description || '').trim(),
    mainAnchor: optStr(s?.mainAnchor),
    anchors: optStr(s?.anchors),
    lighting: optStr(s?.lighting)
  }))

  if (subjects.length === 0) {
    subjects.push({
      id: 'sub_1',
      name: '主角',
      kind: 'person',
      description: '全片同一位主角，面部、发型、服装与配色保持完全一致',
      role: '主角',
      stateVariants: '单一状态'
    })
  }
  if (scenes.length === 0) {
    scenes.push({
      id: 'scn_1',
      name: '主场景',
      description: '全片同一主场景，光线与建筑材质保持一致',
      mainAnchor: '场景中心视觉焦点',
      lighting: '与文案情绪匹配的主光源'
    })
  }

  const subMap = new Map<string, string>()
  subjectRows.forEach((s: any, i: number) => {
    const id = subjects[i]?.id
    if (!id) return
    if (s?.id) subMap.set(String(s.id), id)
    if (s?.name) {
      subMap.set(String(s.name), id)
      subMap.set(String(s.name).toLowerCase(), id)
    }
    if (s?.role) {
      const role = String(s.role).trim()
      if (role.length >= 2) subMap.set(role, id)
    }
    subMap.set(id, id)
  })
  subjects.forEach((s) => {
    subMap.set(s.id, s.id)
    subMap.set(s.name, s.id)
    subMap.set(s.name.toLowerCase(), s.id)
    for (const key of subjectMatchKeys(s)) subMap.set(key, s.id)
  })

  const scnMap = new Map<string, string>()
  rawScenes.forEach((s: any, i: number) => {
    const id = scenes[i]?.id
    if (!id) return
    if (s?.id) scnMap.set(String(s.id), id)
    if (s?.name) {
      scnMap.set(String(s.name), id)
      scnMap.set(String(s.name).toLowerCase(), id)
    }
    scnMap.set(id, id)
  })
  scenes.forEach((s) => {
    scnMap.set(s.id, s.id)
    scnMap.set(s.name, s.id)
    scnMap.set(s.name.toLowerCase(), s.id)
  })

  const shots: StoryboardShot[] = shotsIn.map((s: any, i: number) => {
    const subjectIds = resolveIds(
      s?.subjectIds ?? s?.subjectNames ?? s?.characters,
      subMap,
      []
    ).slice(0, 3)
    const sceneIds = resolveIds(s?.sceneId ?? s?.sceneName ?? s?.location, scnMap, [])
    const voiceover = cleanShotVoiceover(
      String(s?.voiceover ?? s?.dialogue ?? s?.narration ?? s?.spokenText ?? s?.caption ?? '')
    )
    const requestedAudioMode = String(s?.audioMode || '')
    const audioMode: ShotAudioMode = inferOutlineAudioMode(voiceover, requestedAudioMode) || 'none'
    const purpose = optStr(s?.purpose)
    const shotSize = optStr(s?.shotSize)
    const blocking = optStr(s?.blocking)
    const eyeline = optStr(s?.eyeline)
    const continuity = optStr(s?.continuity)
    const propFocus = optStr(s?.propFocus)
    let visualPrompt = String(s?.visualPrompt || '').trim()
    const placeDraft = {
      title: shotTitle(s, i),
      visualPrompt,
      videoPrompt: String(s?.videoPrompt || ''),
      audioDescription: String(s?.audioDescription || '')
    }
    const boundScene = pickBoundScene(sceneIds[0], scenes, placeDraft)

    // 只补极短/缺画风词的镜头；不把技法套话和导演表单拼进画面描述
    visualPrompt = enrichVisualPrompt(visualPrompt, {
      style,
      userStyleLock: styleLockFromUser,
      look: lookFromTexts(style, options.topic, options.content, options.keywords),
      shotSize,
      blocking,
      propFocus,
      purpose,
      sceneName: boundScene?.name,
      sceneLighting: boundScene?.lighting,
      sceneAnchor: boundScene?.mainAnchor
    })

    const draftShot = {
      title: shotTitle(s, i),
      visualPrompt,
      audioDescription: String(s?.audioDescription || ''),
      voiceover,
      speakerHint: optStr(s?.speakerHint),
      duration: clampShotDuration(s?.duration, voiceover, i, options.maxShotDuration),
      cameraMovement: normalizeCameraMovement(s?.cameraMovement),
      purpose,
      blocking,
      continuity: optStr(s?.continuity)
    }
    const ownVideo = optStr(s?.videoPrompt)
    const videoPrompt =
      ownVideo && ownVideo !== visualPrompt && !isVideoPerformanceTemplate(ownVideo)
        ? ownVideo
        : synthesizeVideoPerformance(draftShot as Shot)

    return {
      title: draftShot.title,
      visualPrompt,
      videoPrompt,
      audioDescription: String(s?.audioDescription || ''),
      voiceover,
      audioMode,
      speakerHint: optStr(s?.speakerHint),
      speakerVoice: optStr(s?.speakerVoice),
      duration: clampShotDuration(s?.duration, voiceover, i, options.maxShotDuration),
      cameraMovement: normalizeCameraMovement(s?.cameraMovement),
      subjectIds,
      sceneId: boundScene?.id,
      purpose,
      shotSize,
      blocking,
      eyeline,
      continuity,
      propFocus
    }
  })

  const boundShots = bindCastIntoShots(shots, subjects)
  // 角色音色绑到分镜：每镜按口播说话人取人物卡的 voicePrompt，
  // 生成视频与后期配音都读这份，保证同一角色全片一个声线。
  bindShotVoiceHints(boundShots, subjects)

  const look = lookFromTexts(style, options.topic, options.content, options.keywords)
  const styleCn = styleLabel(look.matched ?? style)
  let aesthetic = optStr(raw?.aesthetic)
  if (look.userNamed) {
    if (!aesthetic) {
      aesthetic = look.medium
    } else if (!aesthetic.includes(look.medium)) {
      aesthetic = `${look.medium}。${aesthetic}`
    }
  } else if (aesthetic && !promptMentionsStyle(aesthetic, style)) {
    aesthetic = `${styleCn}。${aesthetic}`
  } else if (!aesthetic) {
    aesthetic = styleCn
  }

  return {
    aesthetic,
    h3Aesthetic: optStr(raw?.h3Aesthetic),
    styleBrief:
      optStr(raw?.styleBrief) ??
      (styleLockFromUser
        ? `画风严格遵循用户主题：${styleLockFromUser.split('\n')[0]}`
        : `${styleCn}短片，先让人看下去，再把事讲清楚`),
    colorPalette: optStr(raw?.colorPalette),
    lightingNote: optStr(raw?.lightingNote),
    subjects,
    scenes,
    shots: boundShots
  }
}

/** 画面描述缺画风词时点一下名字；禁止往镜头语言前面堆技法说明书。 */
function enrichVisualPrompt(
  prompt: string,
  ctx: {
    style: VisualStyle
    userStyleLock?: string
    look?: ReturnType<typeof lookFromTexts>
    shotSize?: string
    blocking?: string
    propFocus?: string
    purpose?: string
    sceneName?: string
    sceneLighting?: string
    sceneAnchor?: string
  }
): string {
  const look = ctx.look ?? lookFromTexts(ctx.style, ctx.userStyleLock)
  let body = prompt.trim()

  if (!body) {
    body = [
      ctx.sceneName ? `${ctx.sceneName}` : '',
      ctx.sceneAnchor ? `看得见${ctx.sceneAnchor}` : '',
      ctx.sceneLighting ? `光线：${ctx.sceneLighting}` : '',
      ctx.blocking ? ctx.blocking : '',
      ctx.shotSize ? ctx.shotSize : '',
      ctx.propFocus && ctx.propFocus !== '无' ? `手里/近处：${ctx.propFocus}` : '',
      '写清地面、水或风是否在动、光从哪来。'
    ]
      .filter(Boolean)
      .join('。')
  }

  const hasMedium = look.userNamed
    ? body.includes(look.medium) ||
      (look.matched != null && promptMentionsStyle(body, look.matched))
    : promptMentionsStyle(body, look.style)

  if (!hasMedium && look.medium) {
    body = `${body.trim()}（${look.medium}）`
  }

  return body
}

/** 按当前视频模型上限规划单镜；缺省时按口播字数估算，并避免整片同一秒数。 */
function clampShotDuration(
  raw: unknown,
  voiceover: string,
  index: number,
  maxDuration = 15
): number {
  const max = Math.max(5, Math.min(30, Math.round(Number(maxDuration) || 15)))
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) {
    return Math.min(max, Math.max(5, Math.round(n)))
  }
  const chars = voiceover.replace(/\s+/g, '').length
  let est = chars > 0 ? Math.ceil(chars / 4) + 1 : 6
  est += index % 3
  return Math.min(max, Math.max(5, est))
}

export async function generateStoryboard(
  input: StoryboardInput,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<StoryboardRunResult> {
  const mode = getAIMode()
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const resolved: StoryboardInput = { ...input, style: look.style, signal }
  if (look.matched && look.matched !== input.style) {
    log(`画风已从用户原话对上已知画种：${input.style} → ${look.matched}（${look.medium}）`)
  } else if (look.userNamed && !look.matched) {
    log(`画风按用户原词锁定：${look.medium}（不套下拉枚举）`)
  }
  log(`当前 AI 模式：${mode}`)

  if (mode === 'real') {
      onProgress?.(
        input.mode === 'extract'
          ? (input.extractStopAfter || input.extractStartAt) === 'scenes'
            ? '第 2 步：只提炼场景锚点…'
            : (input.extractStopAfter || input.extractStartAt) === 'shots'
              ? '3단계 — 저장된 캐릭터와 장면을 바탕으로 스토리보드를 추출하는 중…'
              : '1단계 — 캐릭터를 추출하는 중…'
          : `正在按「${look.medium}」拆能拍的镜头...`
      )
    try {
      const { result, model } = await realStoryboard(resolved, onProgress)
      onProgress?.(
        input.mode === 'extract' && !result.shots.length
          ? '✓ 현재 추출 단계를 완료하고 저장했습니다.'
          : `✓ 已交付 ${result.shots.length}개의 편집 가능한 스토리보드 샷`
      )
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 真实 LLM 调用失败：${msg}`)
      if (isAbortError(e) && !isTimeoutAbort(e)) throw e
      throw new Error(
        msg.startsWith('脚本') ||
          msg.startsWith('提炼') ||
          msg.startsWith('模型超过') ||
          msg.startsWith('连不上') ||
          msg.startsWith('粗分镜')
          ? msg
          : `대본 생성에 실패했습니다. ${msg}`
      )
    }
  }

  onProgress?.('🎭 데모 모드(VITE_AI_REAL_MODE=true 설정 필요)')
  const result = normalizeStoryboard(
    mockStoryboardFromPrompt(
      `style: ${resolved.style} duration: ${resolved.shotDuration} """${resolved.content}"""`
    ),
    {
      style: resolved.style,
      topic: resolved.topic,
      content: resolved.content,
      keywords: resolved.keywords,
      maxShotDuration: resolved.maxShotDuration
    }
  )
  return { result, source: 'mock' }
}

/** 把分镜结果转成项目里的 Shot[] */
export function storyboardToShots(
  result: StoryboardResult,
  prefix: string = 'shot'
): Shot[] {
  return result.shots.map((s, i) => ({
    id: `${prefix}_${Date.now()}_${i}`,
    index: i,
    title: s.title,
    visualPrompt: s.visualPrompt,
    videoPrompt: s.videoPrompt,
    // 拆分镜时只初始化一次。之后用户即使全部删除，也绝不自动回填。
    compiledVideoPrompt: s.videoPrompt,
    audioDescription: s.audioDescription ?? '',
    voiceover: cleanShotVoiceover(s.voiceover),
    audioMode: s.audioMode,
    speakerHint: s.speakerHint,
    speakerVoice: s.speakerVoice,
    duration: s.duration,
    cameraMovement: s.cameraMovement,
    subjectIds: s.subjectIds,
    sceneId: s.sceneId,
    purpose: s.purpose,
    shotSize: s.shotSize,
    blocking: s.blocking,
    eyeline: s.eyeline,
    continuity: s.continuity,
    propFocus: s.propFocus,
    status: 'draft'
  }))
}

/** 把项目级导演字段应用到 Script */
export function applyAestheticToScript(
  script: Pick<Script, 'aesthetic' | 'h3Aesthetic' | 'styleBrief' | 'colorPalette' | 'lightingNote'>,
  result: StoryboardResult
) {
  if (result.aesthetic) script.aesthetic = result.aesthetic
  if (result.h3Aesthetic) script.h3Aesthetic = result.h3Aesthetic
  if (result.styleBrief) script.styleBrief = result.styleBrief
  if (result.colorPalette) script.colorPalette = result.colorPalette
  if (result.lightingNote) script.lightingNote = result.lightingNote
}

export interface PlayDraftResult {
  topic: string
  playMarkdown: string
  aesthetic?: string
  styleBrief?: string
  colorPalette?: string
  lightingNote?: string
}

export interface PlayRunResult {
  result: PlayDraftResult
  source: StoryboardSource
  model?: string
}

function playBibleGaps(md: string): string[] {
  const t = md || ''
  const gaps: string[] = []
  if (!/##\s*(?:故事背景|本章承接|이야기 배경|챕터 연결|Story background|Chapter handoff)/i.test(t)) {
    gaps.push('Story background: include a one-sentence premise, the central conflict, and the full synopsis. Do not include only the climax.')
  }
  else {
    if (!/一句话故事|한 문장 이야기|one-sentence (?:story|premise)/i.test(t)) gaps.push('Include a one-sentence premise in the story background.')
    if (!/对抗引擎|갈등 구조|central conflict/i.test(t)) gaps.push('State the central conflict: who the opponent is, what they want, and how they raise the stakes.')
    if (/本片从|本段从哪一帧|从.*瞬间开始/.test(t) && !/完整梗概/.test(t)) {
      gaps.push('故事背景被写成高潮切片，必须补完整梗概：开端、对手、递进阻力、高潮选择、结局')
    }
  }
  if (!/##\s*(?:人物|캐릭터|인물|Characters)/i.test(t)) {
    gaps.push('Characters: include the protagonist, opponent, and key family members. State each person’s desire, fear, arc, and visual anchor.')
  } else {
    if (!/欲望|욕망|desire/i.test(t) || !/恐惧|두려움|fear/i.test(t) || !/弧光|변화|character arc/i.test(t)) {
      gaps.push('Character profiles need desires, fears, and character arcs. Fill in each missing field using the screenwriting guide.')
    }
    const people = t.split(/##\s*(?:人物|캐릭터|인물|Characters)/i)[1]?.split(/^##\s+/m)[0] || ''
    const charCount = (people.match(/^###\s+/gm) || []).length
    const looksLikeAd = /口播|带货|产品演示/.test(t)
    if (!looksLikeAd && charCount > 0 && charCount < 3) {
      gaps.push('人物表过薄：除路人外必须有主角、对手、关键亲人/导师；已故父亲和活人对手也要建档，不能只留两人高潮对手戏')
    }
  }
  if (!/##\s*(?:环境与场景|환경과 장면|Environment and locations)/i.test(t) && !/##\s*场景\s*$/m.test(t)) {
    gaps.push('Environment and locations: describe spaces without people, the weather, and period details.')
  }
  const sceneCount = (t.match(/^##\s*(?:场景[一二三四五六七八九十百0-9]|(?:장면|Scene)\s*\d+)/gim) || []).length
  if (sceneCount > 0 && !/场次任务|장면 과제|scene objective/i.test(t)) {
    gaps.push('Give each scene an objective, obstacle, and outcome.')
  }
  const tableHits = t.match(/\*\*口播\*\*/g)?.length || 0
  if (tableHits >= 3) gaps.push('把口播/画面/时长四格改写成连续动作和对白，不要再填表')
  const looksLikeAd = /口播|带货|产品演示/.test(t)
  const quotes = t.match(/「[^」]{2,}」/g)?.length || 0
  const namedLines = t.match(/\*\*[^*：\n]{1,16}：\*\*/g)?.length || 0
  if (!looksLikeAd && sceneCount >= 3 && quotes + namedLines < Math.max(6, sceneCount)) {
    gaps.push('对白过少：这是影视剧不是默片。相认、唤名、对峙、劝阻、问答必须写出可念的对白往来，禁止把前情塞进一句成年旁白、其余场次全哑巴')
  }
  if (/成年[^「\n]{0,8}：/.test(t) && quotes < 4) {
    gaps.push('禁止用「成年某某」旁白代替出镜对白；让本场人物自己开口')
  }
  return gaps
}

async function fillPlayBibleIfThin(
  draft: PlayDraftResult,
  input: StoryboardInput,
  model: string
): Promise<PlayDraftResult> {
  if (input.playMode === 'continue') return draft
  const gaps = playBibleGaps(draft.playMarkdown)
  if (!gaps.length) return draft
  try {
    log(`⚠ 剧本缺少设定节，补写一次：${gaps.join('；')}`)
    const repair = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You are a screenwriter. Fill the listed gaps in the draft's story engine, setting, or dialogue. You may add character profiles, the central conflict, scenes with the opponent or family, and speakable on-screen dialogue in the format **캐릭터 이름：**「대사 원문」. Preserve existing scenes that work. Restore omitted conflict and key people when the draft contains only a climax. Add spoken exchanges for recognition, confrontation, and questions or answers when the draft is silent. Do not merely add a name to the background or replace on-screen dialogue with older-character narration. Write the script and new lines in Korean (한국어).${PLAY_MARKDOWN_SPEC}\nReturn JSON only: {"playMarkdown":"..."}`
        },
        {
          role: 'user',
          content: `반드시 보완할 항목\n- ${gaps.join('\n- ')}\n\n사용자 요구사항\n${input.topic}\n${input.content}\n\n보완할 대본\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.3,
      jsonMode: true,
      maxTokens: 24576,
      signal: input.signal,
      timeoutMs: PLAY_LLM_TIMEOUT_MS
    })
    const repaired = await parseJsonWithModelRepair(repair.content, input, '剧本设定补全')
    const playMarkdown = String(repaired?.playMarkdown || '').trim()
    if (playMarkdown.length < draft.playMarkdown.length * 0.8) return draft
    return { ...draft, playMarkdown }
  } catch (error) {
    log(`⚠ 剧本设定补全失败，保留首稿：${(error as Error).message}`)
    return draft
  }
}

function mockPlayFromBrief(input: StoryboardInput): PlayDraftResult {
  const topic = input.topic?.trim() || '短视频剧本'
  const brief = input.content?.trim() || topic
  if (input.playMode === 'continue' && brief.length > 80) {
    const next = mergeContinuedPlay(
      brief,
      [
        '## 场景续｜往后',
        '',
        '**外景｜主场景｜与上一场同一天气**',
        '',
        `从上一场结尾接着演。${(input.continueHint || '把这件事做完。').slice(0, 80)}`,
        ''
      ].join('\n')
    )
    return {
      topic,
      playMarkdown: next,
      aesthetic: `围绕「${topic}」的叙事`,
      styleBrief: '演示模式续写'
    }
  }
  const playMarkdown = [
    `# ${topic}`,
    '',
    '> 类型：剧情　时间：按文案　地点：按文案　建议时长：1 分钟内',
    '',
    '## 故事背景',
    '',
    brief,
    '',
    '## 人物',
    '',
    '### 主角',
    '',
    '年龄与外貌待按文案锁定。这一段的衣服、鞋和手里的东西保持统一。',
    '',
    '## 环境与场景',
    '',
    '### 主场景',
    '',
    '无人时的地面、建筑、光线和天气。年代物件与文案一致。',
    '',
    '## 拍摄原则',
    '',
    '按写实，不煽情。人物看向场景里的人或物，不要看镜头。',
    '',
    '## 场景一｜开场',
    '',
    '**外景｜主场景｜按文案时辰**',
    '',
    '从主场景切入，完成开场信息。',
    '',
    '## 场景二｜收口',
    '',
    '把这件事落到一个清楚的结束状态。',
    '',
    '## 本章情绪线',
    '',
    '从进入到收口，情绪跟看见的事走。',
    '',
    '## 视觉与声音基调',
    '',
    '自然光，现场环境声。',
    ''
  ].join('\n')
  return {
    topic,
    playMarkdown,
    aesthetic: `围绕「${topic}」的叙事`,
    styleBrief: '演示模式生成的完整剧本草稿'
  }
}

async function ensurePlayNarrativeContinuity(
  draft: PlayDraftResult,
  input: StoryboardInput,
  model: string
): Promise<PlayDraftResult> {
  try {
    const audit = await callLLM({
      messages: [
        {
          role: 'system',
          content: `Audit the script's narrative continuity.${NARRATIVE_CONTINUITY_RULES}\nFirst determine where the user asks this installment to end. Check only substantial gaps that make the plot jump within that boundary. Do not flag a suspense ending, omitted later episode, or deliberate silence, or edit style and phrasing. Write QA comments in Korean (한국어). Return only {"issues":["specific issue and the transition to add within the boundary"]}, at most six. If there are none, return {"issues":[]}.`
        },
        {
          role: 'user',
          content: `사용자 요청\n${input.topic}\n${input.content}\n\n전체 대본\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.1,
      jsonMode: true,
      maxTokens: 2400,
      signal: input.signal,
      timeoutMs: 30_000
    })
    const audited = parseJsonRobust(audit.content)
    const issues = (Array.isArray(audited?.issues) ? audited.issues : [])
      .map((issue: unknown) => String(issue || '').trim())
      .filter(Boolean)
      .slice(0, 6)
    if (!issues.length) return draft

    log(`⚠ 完整剧本发现叙事断层，自动局部重写：${issues.join('；')}`)
    const repair = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You are a screenwriter. Repair only the identified narrative discontinuities. Preserve user facts, character relationships, important dialogue, visual style, and scenes that already work.${NARRATIVE_CONTINUITY_RULES}\nAdd, split, or reorder nearby scenes as needed to give central events enough visible action and runtime. Do not skip an important process with a single narration line. Keep or complete the story background, characters, environments, and filming principles. Write the script and new dialogue in Korean (한국어), keeping existing important lines verbatim. Do not use a four-cell narration, image, and duration table. Return JSON only: {"playMarkdown":"..."}.`
        },
        {
          role: 'user',
          content: `사용자 요청\n${input.topic}\n${input.content}\n\n반드시 수정할 항목\n- ${issues.join('\n- ')}\n\n수정할 전체 대본\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.25,
      jsonMode: true,
      maxTokens: 16384,
      signal: input.signal,
      timeoutMs: PLAY_LLM_TIMEOUT_MS
    })
    const repaired = await parseJsonWithModelRepair(repair.content, input, '完整剧本连续性修订')
    const playMarkdown = String(repaired?.playMarkdown || '').trim()
    if (playMarkdown.length < 80) return draft
    return { ...draft, playMarkdown }
  } catch (error) {
    log(`⚠ 完整剧本连续性自检不可用，保留首稿：${(error as Error).message}`)
    return draft
  }
}

// 한국어 대본의 구조, 장면·캐릭터 요건과 작성 규칙.
const PLAY_MARKDOWN_SPEC = `Write playMarkdown as a complete script that can be filmed and broken into shots. Do not compress it into a table of narration, visuals, sound, and duration. Later extraction reads the script to identify characters, locations, and shots, so include the background, character profiles, and environments in the text.

Write the title, headings, descriptions, and dialogue in Korean (한국어). Use the structural labels shown below. Write as many scenes as the story needs. A short film can be compressed without dropping the opponent, key family members, or central conflict. Do not reduce an adaptation of folklore or intellectual property to a clip from its climax. Cover all scenes needed for a film chapter.

# 제목
> 유형: …　시간: 시대/계절/낮밤　장소: 도시와 구체적인 구역　권장 길이: …

## 이야기 배경
Include all three items. Do not replace the full story by saying where the opening frame begins unless the user explicitly requests an excerpt.
- 한 문장 이야기: the protagonist must take a difficult action to reach an external goal or pay the cost of failure.
- 갈등 구조: identify the opponent, what they want, their values, and how they keep raising the stakes.
- 전체 줄거리: write connected prose from the beginning through turning points, escalating obstacles, the climactic choice, and the ending. Keep the opponent and key family members present in the story.

## 캐릭터
Use one subsection (### short name) for each person who drives the story, including the protagonist, the opponent or their personified representative, parents, mentors, and law enforcement. Include people who are deceased, absent, or appear late. Passersby can be brief, but give people with dialogue or a causal role their own identities.
Write each subsection with enough detail for a character sheet and actor direction:
- 신분
- 나이와 외모 식별 특징: face, hair, build, and impression of height
- 성격과 말투
- 욕망
- 두려움과 약점
- 관계
- 변화: how they change over the chapter
- AI 시각 기준점: clothes, shoes, accessories, possessions, and signs of wear or dirt, suitable for a four-view character sheet
- 장면 간 상태 변화: hunger, wet or dry clothes, injury, and what they hold
- 등장 방식: on screen, deceased and off screen with a keepsake or portrait, or visible pressure from the opponent

## 환경과 장면
Use one subsection (### short place name) per location. Describe the empty space so it can be used for the location image.
- Building structure, access points, ground, and a primary physical anchor
- Weather, wet or dry surfaces, and the direction of the light
- Period and city details, such as vehicles, signs, clothing, wiring, and shutters appropriate to the year and region
Maintain continuous weather between scenes. Do not follow a downpour with an inexplicably dry ground.

## 촬영 원칙
State what to omit, how kindness appears in visible actions, and how to portray hardship with restraint. If no special limits apply, choose a realistic treatment and avoid melodrama.

## 장면 1｜현장 기록 제목
**실내｜장소 원래 이름｜날씨와 시간대**
등장인물: List the people present and identify absent characters represented by a keepsake or portrait.
장면 과제: goal / obstacle / outcome

Write visible, audible, performable action in the present tense. Use ■ for action beats if helpful. Specify who is in the foreground or background, how they face, what they see, and what they do. The foreground character can stand sideways or turn back instead of facing the camera.
Use this dialogue format:

**캐릭터 이름：**

「대사 원문」

Scenes involving interaction must include back-and-forth dialogue. Calling someone by name, questions and answers, recognition, confrontation, persuasion, and farewells need at least one line and a response. Let visible characters speak. Do not explain the backstory through narration by an older version of a character.
Restraint means avoiding slogans and quotable maxims. Do not cut an entire film to one or two lines. Travel and empty establishing shots can remain silent, but scenes with interacting characters need dialogue.
End each scene with a beat label: 【장면 박자：계기/선택/장애/전환/절정/회수】.
For time compression, use ### 몽타주 and describe something visible in each entry. Do not write "time passes" or "days pass."
Put older-character narration in a block quote and identify it as off-screen.
Keep wardrobe, injuries, objects in hand, and weather consistent between scenes.

(Continue with 장면 2, 장면 3, and so on.)

## 챕터 감정선
Describe the emotional progression from opening to ending in one paragraph so shot breakdown retains expressive performances.

## 시각 및 소리 기조
Describe color, film or documentary texture, and real ambient sound. For warm scenes use hot water, steam, and people's voices. Do not suddenly introduce opulent surroundings.

Additional rules:
- Establish the story engine, characterization, and environment before writing the scenes. Give speaking characters physical positions.
- Show kindness through small things ordinary people do. Show hardship through clothes, gait, breathing, and environment.
- In sales and presenter-led videos, include the host and product under characters. Put narration into dialogue, and specify the location, what the speaker looks at, and what they hold.
- Keep lines that share one intention in the same scene. Do not force one line per scene or leave an interaction silent.`

/**
 * 目标成片时长 → 剧本规模约束。
 * 这是控制分镜数量的最上游闸门：剧本写多长，后面就拆多少个镜。
 */
function playScaleBrief(targetSec: number | undefined): string {
  const target = Number(targetSec) || 0
  if (target < 10) return ''
  const scenes = Math.max(2, Math.min(6, Math.round(target / 15)))
  const chars = Math.max(400, Math.round(target * 18))
  const lines = Math.max(4, Math.round(target / 5))
  return `목표 영상 길이는 ${target}초입니다. 이 값을 기준으로 대본 분량을 반드시 정하세요. 완성 영상의 허용 범위는 ${target - DURATION_TOLERANCE_SEC}–${target + DURATION_TOLERANCE_SEC}초이며 범위를 벗어나면 요구사항을 충족하지 못합니다. ${target}초를 기준으로 장면은 최대 ${scenes}개, 캐릭터 소개와 환경 목록을 제외한 장면 본문은 ${chars}자 이내, 전체 대사는 ${lines}문장 이내로 쓰세요. 장면을 늘리기보다 짧고 밀도 있게 쓰세요. 장면이 하나 늘어날 때마다 이후 스토리보드가 샷 분량을 초과하고 완성 영상이 길어집니다.`
}

async function realGeneratePlay(input: StoryboardInput): Promise<{ result: PlayDraftResult; model?: string }> {
  const continueMode = input.playMode === 'continue'
  const existingPlay = continueMode ? (input.content || '').trim() : ''
  const hint = (input.continueHint || '').trim()
  const targetSec =
    Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content, hint)
  const scaleBrief = playScaleBrief(targetSec)
  const { model: cfgModel } = getLlmConfig()
  const model = resolvePlayModel(input) || cfgModel
  log(`→ ${continueMode ? '续写剧本' : '写剧本'} LLM: ${model}`)
  const resp = await callLLM({
    disableThinking: true,
    messages: [
      {
        role: 'system',
        content: `You are a screenwriter. Write the script directly from the user's request and the existing material.
Return only the Markdown body. Do not output JSON, explanations, or self-review.
Write the title, script, character descriptions, and dialogue in Korean (한국어). Start with the title, story background, characters, and environment and locations, then write each scene. Use the exact section headings "## 이야기 배경", "## 캐릭터", and "## 환경과 장면". Use "## 장면 N｜제목" for scene headings and "**실내｜장소｜날씨와 시간대**" or "**실외｜장소｜날씨와 시간대**" for the scene line. For dialogue, write "**캐릭터 이름：**" followed by 「대사 원문」 on the next line.
Match the requested running time if supplied. Write speakable lines when characters interact. Do not add prices or efficacy claims that the user did not mention.`
      },
      {
        role: 'user',
        content: continueMode
          ? `Continue the script by appending new scenes. Preserve existing scenes verbatim.

Continuation direction
${hint || 'Continue from what has already happened.'}

Current script
${existingPlay || '(empty)'}
${scaleBrief}`
          : `Write a complete script based on the following requirements.

Requirements
${input.topic || '(unspecified)'}

Existing material
${input.content?.trim() || '(none)'}
${input.keywords?.length ? `Keywords: ${input.keywords.join(', ')}` : ''}
Aspect ratio: ${input.aspectRatio || '16:9'}
${scaleBrief}`
      }
    ],
    model,
    temperature: 0.5,
    maxTokens: 4000,
    timeoutMs: 90_000,
    signal: input.signal
  })
  let playMarkdown = String(resp.content || '')
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (continueMode) playMarkdown = mergeContinuedPlay(existingPlay, playMarkdown)
  if (playMarkdown.length < 40) throw new Error('모델이 대본을 반환하지 않았습니다.')
  const result: PlayDraftResult = {
    topic: playMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || input.topic?.trim() || '短视频剧本',
    playMarkdown
  }
  return { result, model: resp.model ?? model }
}

/** 第一步：只生成完整剧本 Markdown，不拆节点 */
export async function generatePlay(
  input: StoryboardInput,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<PlayRunResult> {
  const mode = getAIMode()
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const resolved: StoryboardInput = { ...input, style: look.style, signal }
  log(`${input.playMode === 'continue' ? '续写剧本' : '写剧本'} · AI 模式：${mode}`)

  if (mode === 'real') {
    onProgress?.(input.playMode === 'continue' ? '대본을 이어 쓰는 중…' : '전체 대본을 작성하는 중…')
    try {
      const { result, model } = await realGeneratePlay(resolved)
      onProgress?.(
        input.playMode === 'continue'
          ? '✓ 기존 장면을 보존하고 대본을 이어 썼습니다.'
          : '✓ 전체 대본을 작성했습니다. 노드 추출은 아직 시작하지 않았습니다.'
      )
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 대본 작성에 실패했습니다. ${msg}`)
      if (isAbortError(e) && !isTimeoutAbort(e)) throw e
      throw new Error(msg.startsWith('写剧本') || msg.startsWith('模型超过') ? msg : `대본 작성에 실패했습니다. ${msg}`)
    }
  }

  onProgress?.('🎭 데모 모드에서 대본을 작성합니다.')
  return { result: mockPlayFromBrief(resolved), source: 'mock' }
}

/** 是否已有可提炼的完整剧本 */
export function isPlayReady(script: Script | null | undefined): boolean {
  return Boolean(script?.playReady && script.content?.trim())
}
