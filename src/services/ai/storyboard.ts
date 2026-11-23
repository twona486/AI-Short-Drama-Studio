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
  return `严重：成片总时长 ${total} 秒，不在用户要求的 ${target} 秒允许区间 ${lo}–${hi} 秒（只能多 ${DURATION_TOLERANCE_SEC} 秒或少 ${DURATION_TOLERANCE_SEC} 秒）。当前${delta > 0 ? '超了' : '少了'} ${Math.abs(delta)} 秒。必须重排镜头，让全部 duration 相加落进这个区间：超了就合并相邻、同地点、同组人物的镜头并缩短；短了就加长已有镜头。不能删掉关键剧情来凑秒数。`
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
    return `【画风听用户的 · 硬性】
用户点名了画风。画风写进画面实物里，不要单独开一段技法说明书。

用户点名的画风原词（文中点一次即可）：「${mediumPhrase}」

用户主题/画风原文：
"""
${userAuth}
"""

每一镜 visualPrompt 必须是镜头语言：
1. 写画面里能看见的一切：地面/建筑/水/植物/天空/道具，近到远。
2. 写动态：水波、风、衣摆、烟尘；不动也要写明静止。
3. 写光从哪来、影子落在哪。
4. 人：衣服、手脚、朝向、手里的具体物件、这一秒在做什么。
5. 「${mediumPhrase}」在文中自然出现一次；技法只写在实物上。禁止开头「${mediumPhrase}。」然后空讲站位，禁止结尾抄画风套话。
${
  look.matched
    ? `6. 该媒介画在实物上时注意：${VISUAL_STYLE_GUIDE[look.matched].mustInclude}。${VISUAL_STYLE_GUIDE[look.matched].avoid}`
    : `6. 按「${mediumPhrase}」这个媒介本身的材料与质感来写实物，不要套页面下拉风格。`
}`
  }

  if (userAuth) {
    return `【画风听用户的】
用户主题原文（保留味道，但主题没点名具体媒介）：
"""
${userAuth}
"""

画面媒介以下拉风格为准（当前：${styleLabel(input.style)} / ${input.style}）：
${fallback}`
  }

  return `【画风指令】主题未写画风时，以下拉风格为准：
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
      throw new Error(`${label} JSON 自动修复失败：没有可修复的内容\n首次错误：${(parseError as Error).message}`)
    }
    let repairedContent = ''
    try {
      const repaired = await callLLM({
        messages: [
          {
            role: 'system',
            content: `JSON 문법을 복구하세요. 쉼표, 따옴표, 이스케이프 문자, 괄호와 잘린 컨테이너 구조만 고치세요. 기존 필드 이름과 값, 배열 순서와 원문을 그대로 유지하세요. 문장을 다듬거나 번역하거나 요약하거나 새로운 사실을 추가하지 마세요. 끝이 잘렸다면 완성된 배열 요소만 남기고 JSON을 닫으세요. 유효한 JSON 객체 하나만 출력하세요.`
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
      `${label} JSON 自动修复失败：${(parseError as Error).message}`
    )
  }
}

const QUALITY_REPAIR_ROUNDS = 3

const NARRATIVE_CONTINUITY_RULES = `
【叙事连续性硬规则】
1. 先从用户要求中锁定“本次视频/本集”的起点、终点、时长和明确要展示的事件。边界指用户指定的集或段，不是把完整故事砍成高潮切片。用户要完整短片或完整改编时，必须写全对抗引擎与关键人物；只有用户明确只要某一段时才允许切片。禁止为了显得完整而续写下一集、提前揭晓用户要求停住的后果、补讲无关世界观或替用户推进到下一集。
2. 允许在用户指定的任何节点结束，包括异变刚启动、穿越途中、刚落地、看到陌生人或其他悬念点。开放式结尾和悬念不是断层；结尾只需把当前状态落稳，不得擅自接着解释。
3. 在本次边界内，每个镜头/场次必须由上一段的可见结果触发，并给下一段留下明确的可见状态；禁止只靠观众脑补人物怎么到场、怎么认识、为什么突然开始解释。
4. 地点、时代、身份、关系、目标或身体状态发生重大变化时，只展开到本次视频终点为止的因果链。可用的拍点包括：触发征兆 → 变化过程 → 冲击结果 → 即时反应 → 观察确认 → 首次接触。根据用户要求与时长选取必要拍点，可以停在链条中间，但不能在实际展示的两个拍点之间无过渡跳跃。
5. 穿越、事故、变身、发现秘密、重逢、背叛、战斗爆发等若是本集核心卖点，应获得与本集重要性相称的画面和时长；若用户只把它作为背景或明确要求略过，则服从用户，不强行扩写。
6. 解释性台词要有当前剧情中的触发条件；但用户明确要求从讲解、复盘或既定关系开场时，服从该形式，不擅自补前情。
7. 相邻段落逐对核对人物位置、姿势、朝向、手中物、伤势、情绪、已知信息和环境时间。后一段开头必须接住前一段末态；若跳时空，必须用用户允许的可见转场完成。
8. 不用旁白代替本集本应看见的关键过程，也不为了补过程虚构用户未要求的新事实。`

const SPEAKER_STAGING_RULES = `
【出镜对白与站位】
1. 开口的人嘴要可读，但不等于他必须正面朝向镜头、站在画面正中。说话者可以在后面、侧面、跪着。
2. 画面里每一个人都要写进 blocking / eyeline / videoPrompt：在近处还是后面、身体朝哪、眼睛看谁或看什么。没写占位的人会被生成模型摆成合影看镜头。
3. 前面的人如果不是说话者，必须侧对或背对镜头，回头/侧头看说话者或他指的东西，禁止正面看镜头。
4. 同一空间的对白往来可以留在一镜。videoPrompt 必须从0秒到本镜结束按实际剧情拍点分成2–5段，逐段写清当前唯一说话者和其他人的反应；同一说话者连续2–4个短句也可以保留在同一段。
5. voiceover 保留“人物名：台词”。videoPrompt 禁止只写说话者动作、再用一句「不要看镜头」带过其他人。每段必须写全所有在场人物的占位、视线和非语言反应。`

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
          content: `你是影视连续性编审，只找会让普通观众觉得“怎么突然就到这里了”的实质断层，不挑措辞和审美细节。${NARRATIVE_CONTINUITY_RULES}
先依据用户原始要求判断本次视频的叙事边界，再逐对检查边界内的镜头。用户只要求第一集、片段、预告或悬念结尾时，不得把“没有继续讲后续”判为问题；只检查已经展示的相邻拍点之间是否跳步。只输出 JSON：{"issues":["第 1→2 镜：上一镜末态……，下一镜却……；在本集边界内应补……"]}。没有实质问题就输出 {"issues":[]}。最多 6 条，每条必须指出具体相邻镜头或边界内缺失的过渡。`
        },
        {
          role: 'user',
          content: `用户原始要求：\n${input.topic}\n${input.content}\n\n待审分镜：\n${JSON.stringify(compact)}`
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
    onProgress?.(`发现叙事断层，正在局部重排相关镜头（${round + 1}/2）…`)
    log(`⚠ 叙事连续性未通过 ${round + 1}/2：${issues.join('；')}`)
    current = await repairStoryboardOnce(
      current,
      input,
      model,
      issues.map((issue) => `严重：叙事断层：${issue}`)
    )
    current = await ensureStoryboardQuality(current, input, model, onProgress)
  }
  const remaining = await auditStoryboardNarrative(current, input, model)
  if (remaining.length) {
    throw new Error(`叙事连续性验收未通过（已自动局部重写 2 次）：${remaining.join('；')}`)
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
  onProgress?.('快速检查镜头承接与说话者归属…')
  const narrative = await auditStoryboardNarrative(parsed, input, model)
  const issues = [...structural, ...narrative.map((issue) => `叙事承接：${issue}`)].slice(0, 16)
  if (!issues.length) return parsed

  onProgress?.('发现可改进处，合并修订一次后立即交稿…')
  try {
    const repaired = await repairStoryboardOnce(parsed, input, model, issues)
    const remaining = storyboardQualityIssues(repaired, input)
    if (remaining.length) {
      log(`⚠ 修订后仍有非阻断问题，交付可编辑稿：${remaining.join('；')}`)
      onProgress?.(`已生成可编辑分镜；仍有 ${remaining.length} 项建议可在画布继续调整`)
    }
    return repaired.shots.length ? repaired : parsed
  } catch (error) {
    log(`⚠ 合并修订失败，交付首稿：${(error as Error).message}`)
    onProgress?.('自动修订未完成，已保留并交付可编辑首稿')
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
      ? '输入已是完整剧本，只修提炼结果：不要改口播原意，不要另起故事。人物章每一个 ### 都必须建档——若只是对已有角色的称呼（如哥哥），把这个词写进该人物的 name/role/description；若人物表里确实有这个角色，必须单独建档。已故角色用遗物、画像或闪回入镜即可；活人对手必须有对峙或可见压力镜。每个已建档人物必须出现在至少一镜（本人、遗物、画像或可见压力）：subjectIds 挂上，visualPrompt / videoPrompt 写名字。禁止因为「这集没站在镜头正中」就把父亲、哥哥、对手从人物表删掉。禁止只做人物卡、分镜里却换成路人或「一个男人」。'
      : '每个出场人物都在 subjects 单独建档，不能合并成一个“主角”。'
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
          content: `${importedDirectorPrefix()}你是短视频总编审。上一稿验收未通过，现在把 JSON 打回来重新提炼，必须消掉下列问题后再交稿。${durationBlock}不新增用户没说的产品、人物、数字或事实；只补用户本次内容边界内已经出现或明确蕴含的事件过程，禁止续写边界之外的后果。\n${extractHint}\n${NARRATIVE_CONTINUITY_RULES}\n${SPEAKER_STAGING_RULES}\n如果问题指出重大事件被压扁或相邻镜头断层，可以拆分、插入或重排断层附近的镜头，补足本集边界内的可见过程与反应；只局部修相关段落，其他合格镜头保持原意。若用户指定停在悬念点，就停在那里，不得为了闭环继续讲下一步。每个新增镜头也必须写全 continuity，格式为“承接上一镜的明确末态 → 本镜可见变化 → 留给下一镜的明确末态”。\n每镜 title 使用不同的 3-8 字内容标题，禁止统一写“镜头”。把用户原文按语义段落分配进 voiceover，默认 audioMode=h3-dialogue；只有原文明说旁白时才用 h3-voiceover。不要机械地一镜只放一句：同一人物、同一表达意图的连续 2-4 个短句优先合在一个 7-10 秒镜头里，短促反应或转场才保留一句；总字数仍不得超过 duration*4。voiceover 保留“人物名：台词”便于识别说话人，真正送入 H3 时会自动去掉人物名前缀。\n说话镜头先判断动作、空间关系、环境信息和情绪节奏，再选景别。表情是叙事重点且不需交代环境时可以收近；需要保留递物、争执、问答、人物距离、环境压力或集体反应时，应使用合适的中景、双人或多人同框。特写只是可选倾向，禁止把每个说话镜头机械切成特写；但要写清谁在说、其他人如何反应，不能所有人同时张嘴。\nvisualPrompt 用中文描述可见静帧（场景、人物衣着、光源），这是给配图用的。\n${videoPerformanceSpec(getVideoPromptStyle())}\n禁止把 visualPrompt 翻译成英文，禁止两段写成一样。h3Aesthetic 用英文写全片材质、灯光、色彩和摄影质感。不得堆标签。\n只输出完整合法 JSON。`
      },
      {
        role: 'user',
        content: `用户原文 / 剧本：\n${input.content}\n\n主题：${input.topic || '（未填）'}\n\n验收未通过（必须全部修掉）：\n- ${issues.join('\n- ')}\n\n待修 JSON：\n${JSON.stringify(parsed)}`
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
    const severe = issues.filter((issue) => issue.startsWith('严重'))
    if (round > 0 && !severe.length) {
      log(`⚠ 仍有非阻断问题，继续使用：${issues.join('；')}`)
      return current
    }
    if (round === QUALITY_REPAIR_ROUNDS) {
      throw new Error(
        `脚本质量验收未通过（已打回重提炼 ${QUALITY_REPAIR_ROUNDS} 次）：${issues.join('；')}`
      )
    }
    const n = round + 1
    log(`⚠ 质量未通过，打回重提炼 ${n}/${QUALITY_REPAIR_ROUNDS}：${issues.join('；')}`)
    onProgress?.(`验收未通过，打回重新提炼（${n}/${QUALITY_REPAIR_ROUNDS}）…`)
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
    /^(?:场景\s*[一二三四五六七八九十百0-9]|第[^\n]{1,12}场(?:\b|[：:]?)|scene\b)/i.test(title)
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
  return `【导入剧本 · 只拆不改】这是用户导入的成稿，拆分镜时禁止改写正文。不润色、不补情节、不换说法、不增删对白，也不要把对白改成旁白或把旁白改成对白。voiceover 必须逐字抄原文对白。visualPrompt 和 videoPrompt 只拍摄原文已经写明的人物、动作和场景，禁止添加原文没有的事件、道具、反应或结局。镜头顺序跟原文一致。\n`
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
      ? `\n【镜数与时长硬上限】全片成片目标 ${targetDurationSec || '?'} 秒，允许上下浮动 ${DURATION_TOLERANCE_SEC} 秒。全片只批 ${totalShotBudget} 个小组；本工作包只出 ${limit} 镜，duration 合计必须是 ${durationCap || targetDurationSec || '?'} 秒。把本段动作与对白收进这 ${limit} 个镜头，靠运镜和画内调度表达，不要再拆小组。`
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
          content: `${importedDirectorPrefix()}${verbatimSplitRule(input.verbatim)}你是电影分镜导演小组。你只负责眼前这一小段剧本，不处理整部剧本。把本段拆成 1–${limit} 个真正能拍的连续镜头，绝对不得超过 ${limit} 个。${budgetLine}

画面必须有生命：明确起幅里人物和关键物处于什么状态，什么事件触发动作，人物怎样连续行动和反应，摄影机为什么移动、最后落在哪里。不要用“固定镜头、轻微自然晃动、保持表情、让画面呼吸”这类模板填空；只有剧情确实需要静止时才用 static。运镜必须服务于空间揭示、人物关系或情绪变化。
忠实覆盖本段所有可见动作与对白，不另编故事。对白逐字放进 voiceover，格式“人物名：原台词”；只有剧本明确写旁白/画外音才使用 h3-voiceover，否则出镜说话使用 h3-dialogue。没有对白才写空字符串和 none。
visualPrompt 是最有代表性的关键帧静态画面；videoPrompt 是具体、连续、可执行的动态图生视频时间轴，从0秒到本镜结束按实际拍点分2–5段。每段写清谁行动、谁说话、其他人如何占位和反应、表情变化以及一个有动机的运镜，并让环境中的风、雨、烟、衣摆、光影或道具有合理反馈。不要复述 visualPrompt，不要机械等分时间。
每镜要写清景别和人物空间关系。人物看场景内的人或物，不看镜头。
优先输出 JSON：{"shots":[{"title":"3-8字","purpose":"戏剧作用","shotSize":"景别变化","visualPrompt":"电影关键帧画面","videoPrompt":"220-650字、从0秒覆盖到结束的2-5段电影化时间轴","duration":6,"audioDescription":"同步现场声","voiceover":"人物名：原台词或空字符串","audioMode":"h3-dialogue|h3-voiceover|none","cameraMovement":"push|pull|pan|tilt|static|orbit","subjectNames":["人物短名"],"sceneName":"已有地点短名"}]}。shots 数组只能有 1–${limit} 项。若不能输出 JSON，也可按“镜头 N / 画面 / 内容 / 时长 / 声音 / 口播”返回；系统可以解析。${retry ? '上一轮没有可解析镜头；这次直接交付，不要写思考过程。' : ''}`
        },
        {
          role: 'user',
          content: `工作包：${batch.label}
已有人物：${subjectNames.join('、') || '（按原文识别）'}
已有地点：${sceneNames.join('、') || '（按原文识别）'}
当前视频模型单镜最长 ${shotDurationLimit(input)} 秒。${durationCap ? `本工作包的成片时长就是 ${durationCap} 秒，只出 ${limit} 镜，duration 写成 ${durationCap}。` : `每镜 duration 在 ${MIN_SHOT_SEC}–${shotDurationLimit(input)} 秒。`}同一地点、同一人物、同一连续行动能在上限内拍完时，优先合成一个完整长镜头。${budgetLine}
${directives ? `\n全片约束（只用于保真）：\n${directives}\n` : ''}
${batch.previousHint ? `上一工作包末尾（只用于承接，不要重复拍）：\n${batch.previousHint}\n` : ''}
本工作包剧本原文：
${batch.excerpt}
${batch.nextHint ? `\n下一工作包开头（只用于留下末态，不要提前拍）：\n${batch.nextHint}` : ''}`
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
    if (!shots.length) throw new Error('模型回复中没有可解析的分镜')
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
        title: String(s?.title || `镜头${i + 1}`).trim() || `镜头${i + 1}`,
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
  if (/旁白|画外音/.test(vo) || /^(成年|旁白)/.test(vo)) return 'h3-voiceover'
  return 'h3-dialogue'
}

function outlineField(block: string, names: string): string {
  const m = block.match(
    new RegExp(
      `(?:${names})[：:]\\s*([^\\n]+(?:\\n(?!(?:画面|内容|内容表现|不拍|时长|声音|音效|口播|对白|台词|镜头)\\s*\\d*\\s*[：:])[^\\n]+)*)`,
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
    .split(/\n(?=镜头\s*\d+\s*[：:])/)
    .map((b) => b.trim())
    .filter((b) => /^镜头\s*\d+\s*[：:]/.test(b))
  return blocks
    .map((block, i) => {
      const head = block.match(/^镜头\s*\d+\s*[：:]\s*([^\n]+)/)
      let title = (head?.[1] || `镜头${i + 1}`).trim()
      let shotSize = outlineField(block, '景别')
      const paren = title.match(/[（(]([^）)]+)[）)]\s*$/)
      if (paren) {
        if (!shotSize) shotSize = paren[1].trim()
        title = title.slice(0, paren.index).trim() || title
      }
      const visualPrompt = outlineField(block, '画面')
      const videoPrompt = outlineField(block, '内容|内容表现')
      const omitNote = outlineField(block, '不拍')
      const audioDescription = outlineField(block, '声音|音效')
      const voiceover = outlineField(block, '口播|对白|台词')
      const duration = Number(block.match(/时长[：:]\s*(\d+(?:\.\d+)?)/)?.[1])
      return {
        title: title.trim() || `镜头${i + 1}`,
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
  const shortSystem = `${importedDirectorPrefix()}당신은 스토리보드 감독입니다. 대화에서 샷 목록을 적듯 짧고 빠르게, 촬영할 수 있는 현장 기록만 작성하세요.
대본 순서대로 샷을 나누세요. 같은 공간의 대화는 한 샷에 담을 수 있습니다. 같은 인물의 짧은 연속 대사도 한 샷에 담을 수 있습니다.
샷마다 제목(괄호 안에 샷 크기 또는 카메라 움직임), 화면(눈에 보이는 동작 2–4문장), 내용(이 샷에서 연기할 것), 길이, 소리를 쓰세요.
대사가 있으면 「口播：캐릭터 이름：대사 원문」을 한 줄 추가하세요. 대본의 대사 원문을 한 줄도 빠뜨리지 마세요. 대사가 없는 빈 장면이나 이동만 하는 샷에서만 이 줄을 생략하세요.
이야기의 배경을 성인이 된 인물의 내레이션으로 바꾸지 마세요.
JSON, 사고 과정, continuity / blocking / 미학 설정을 출력하지 마세요.
아래 형식을 정확히 따르고 샷 사이에는 빈 줄을 하나 넣으세요. 파서가 읽는 중국어 필드명은 그대로 두세요. 제목과 대사는 한국어로, 이미지·영상 생성 모델에 전달되는 画面과 内容은 중국어로 작성하세요.

镜头 1：한밤중의 질주（원경→중경）
画面：村口浅滩，夜晚十一点，水面横着一条银白光带。牛郎挑着竹筐从草丛中冲出，两个孩子颠簸抓筐边。
内容：牛郎从草丛冲出，孩子们抓着筐边颠簸，一只凉鞋陷进泥里。人看路和孩子，不要看镜头。
时长：6 秒
声音：풀을 밟는 소리, 가쁜 숨, 물이 흐르고 튀는 소리`

  const filmSystem = `${importedDirectorPrefix()}당신은 영화 스토리보드 감독입니다. 입력은 영화 챕터 전체 대본입니다. 대본 순서대로 촬영 가능한 샷을 나누세요. 모든 장면과 몽타주 항목을 충실히 담고 별도의 줄거리를 추가하지 마세요.

샷을 나누는 원칙
- 한 장면은 들어오기, 발견, 망설임, 발화, 반응, 떠나기처럼 극적 박자에 따라 나누세요. 장면 전체를 한 샷으로 압축하거나 대사 한 줄을 표정만 있는 세 샷으로 쪼개지 마세요.
- 몽타주는 같은 의도를 가진 연속 화면 3–6개를 8–10초 샷 하나에 담으세요. 문틈의 빛이 오른쪽으로 이동하거나, 사과 심이 갈변하거나, 빗방울이 고여 웅덩이가 되는 식으로 눈에 보이는 연속 동작을 쓰세요. ‘시간이 흘렀다’나 ‘며칠이 지났다’라는 문구를 쓰지 마세요.
- 같은 공간의 대화와 같은 인물의 짧은 연속 대사는 각각 한 샷에 담을 수 있습니다. 대본의 **캐릭터 이름：**「대사」는 대응하는 샷의 내레이션 필드에 원문 그대로 넣으세요. 대사를 빼거나 성인이 된 인물의 내레이션으로 앞 이야기를 요약하지 마세요.
- 성인이 된 인물의 내레이션이나 화면 밖 음성은 대본에 화면 밖 음성으로 표시되어 있을 때만 「口播：旁白：대사 원문」으로 쓰세요. 화면 속 인물은 입을 다물어야 합니다. 화면에 나오는 인물이 말하면 실제 캐릭터 이름을 쓰세요.
- 대본에 촬영 제외 사항(상처 클로즈업, 신상, 종교의식, 노숙자를 괴물처럼 촬영하는 등)이 있으면 각 샷에 「不拍：…」을 추가하세요.
- 인물은 장면 속 사람이나 물건을 봅니다. 모두가 카메라를 보게 하지 마세요. 선의는 평범한 사람이 하는 작은 일로 표현하고 구원자가 등장하는 것처럼 쓰지 마세요.
- 시대, 날씨, 옷이 젖거나 마른 상태, 걸음걸이는 대본을 따르세요.
- 예상 샷 수는 ${longForm ? '25–60개이며 개별 장면과 몽타주로 챕터 전체를 담으세요' : '영상 길이에 따라 대략 6–14개입니다'}. 핵심 박자를 생략하거나 대사 한 줄을 표정만 있는 세 샷으로 쪼개지 마세요.

아래 형식을 정확히 따르고 샷 사이에는 빈 줄을 하나 넣으세요. JSON과 사고 과정은 출력하지 마세요. 파서가 읽는 중국어 필드명은 그대로 두세요. 제목과 대사는 한국어로, 이미지·영상 생성 모델에 전달되는 画面, 内容 및 不拍은 중국어로 작성하세요.

镜头 1：모퉁이에서 잠들다（중근경）
画面：废弃仓房墙角，阿峰靠开裂墙壁坐地，手里苹果核，羽绒服脏湿。门缝透进灰白天光。
内容：阿峰呼吸渐渐平稳，眼睛慢慢闭上。看向地面或虚空，不要看镜头。机位几乎不动。
不拍：伤口特写、神像
时长：8 秒
声音：바깥의 빗소리, 멀리서 들리는 자동차 소리, 그의 숨소리
口播：아펑：먼저 다 먹자. 심은 남겨 두고.`

  const response = await callLLM({
    messages: [
      { role: 'system', content: film ? filmSystem : shortSystem },
      {
        role: 'user',
        content: `已有人物：${subjectNames.join('、') || '（无）'}
已有地点：${sceneNames.join('、') || '（无）'}
单镜时长：当前模型最长 ${shotDurationLimit(input)} 秒；${film ? `按场次动作在 5–${shotDurationLimit(input)} 秒内规划` : `参考 ${input.shotDuration}，可在 3–${shotDurationLimit(input)} 秒内规划`}。连续动作能在一个镜头完成就不要拆成多个短镜头

${directives ? `本章必须遵守：\n${directives}\n` : ''}完整剧本：
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
    throw new Error('粗分镜表是空的。人物和场景已保留，可直接重试拆分镜')
  }
  onProgress?.(`✓ 已拿到 ${outlines.length} 个镜头场记，正在写入画布…`)
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
          content: `${importedDirectorPrefix()}아래 현장 기록 한 개를 캔버스 스토리보드 노드의 필드로 확장하세요. 이야기, 길이, 화면의 원래 의도를 바꾸지 마세요.
내레이션 및 대사는 기록에 있는 원문을 사용하세요. 기록에 대사가 있으면 빈 문자열은 유효하지 않습니다. 같은 공간의 대화는 한 샷에 담을 수 있습니다. 현장 기록에 화면 밖 음성이나 내레이션이 명시된 경우에만 audioMode=h3-voiceover를 사용하세요.
videoPrompt는 필수입니다. 0초부터 샷이 끝날 때까지 실제 이야기의 박자에 따라 2–5개 구간으로 나누세요. 각 구간에 먼저 현재 행동하는 인물, 구체적인 행동과 표정을 쓰세요. 이어 화자와 대사 원문을 쓰고 다른 인물이 앞이나 뒤 어디에 서는지, 몸과 시선의 방향, 말이 없는 반응을 설명하세요. 마지막으로 해당 구간의 합리적인 카메라 움직임과 도착점을 쓰세요. 말하는 인물이 뒤에 있어도 됩니다. 앞쪽 인물은 옆으로 서거나 뒤돌아 화자를 보게 하세요. 단체 사진처럼 카메라를 보게 하거나 끝에 ‘카메라를 보지 마세요’만 덧붙이지 마세요.
${film ? '이 샷에 대응하는 이야기 박자를 대본 원문에서 찾을 수 있어야 합니다. 몽타주는 눈에 보이는 연속 동작으로 쓰세요. 대본의 촬영 제외 사항은 videoPrompt 마지막 문장에 쓰세요. 선의는 평범한 사람이 하는 작은 일입니다.' : ''}
사용자가 읽는 제목과 설명은 한국어로 쓰세요. 기존 범주값과 캐릭터·장소 이름은 유지하세요. 생성 모델에 전달되는 visualPrompt와 videoPrompt의 연출 문장은 중국어로 쓰고, 대사가 포함되면 대사 원문을 유지하세요.
JSON 객체 하나만 출력하세요. {"title":"3-8자","purpose":"钩子/说明/反应/揭示/转场/收口","shotSize":"샷 크기","blocking":"인물별 앞뒤 위치, 몸 방향, 상대적 위치","eyeline":"인물별로 바라보는 사람 또는 물체. 카메라를 보지 않음","continuity":"이전 샷의 마지막 상태 → 현재 샷의 변화 → 다음 샷의 시작 상태","propFocus":"소품 또는 없음","visualPrompt":"중국어 정지 화면 묘사","videoPrompt":"중국어 220-650자의 실행 가능한 타임라인. 0초부터 끝까지 2-5개 구간에 행동하는 인물, 동작과 표정, 화자와 대사 원문, 다른 인물의 위치와 반응, 카메라 움직임과 도착점, 동기화된 소리를 작성","audioDescription":"현장 소리","voiceover":"캐릭터 이름：대사. 없으면 빈 문자열","audioMode":"h3-dialogue|h3-voiceover|tts|none","speakerHint":"목소리 특성과 감정","duration":6,"cameraMovement":"push|pull|pan|tilt|static|orbit","subjectNames":["짧은 이름"],"sceneName":"장소 원래 이름"}`
        },
        {
          role: 'user',
          content: `已有人物：${subjectNames.join('、') || '（无）'}
已有地点：${sceneNames.join('、') || '（无）'}
${prev ? `上一镜：${formatOutlineNote(prev, index - 1)}` : '上一镜：无（本镜是开场）'}

本镜场记：
${formatOutlineNote(outline, index)}

${next ? `下一镜：${formatOutlineNote(next, index + 1)}` : '下一镜：无（本镜是收尾）'}
${extras?.directives ? `\n本章约束：\n${extras.directives}` : ''}
${extras?.sceneSlice ? `\n本场剧本原文：\n${extras.sceneSlice}` : ''}
只扩这一镜。`
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
【参考图（已附带 ${input.productImages.length} 张）】
先看图再写分镜：
- 图里有人/动物/吉祥物，列为 subjects，外貌按图里真实样子写，fromReference=true，别另造一张脸
- 图里是产品，列为 kind=other，按真实产品写
- 后面每一镜的人都要和 subjects 同一套衣服、发型、年龄
- 产品/主角每镜都要让人看清`
      : `
【没有参考图】
先从文案里列出所有会在画面中出现的人/动物（subjects）和地点（scenes）。每个有名字、有台词或有动作的人都必须单独列一个 subject，不能把配角合并成一个“主角”。
同一人全片同一套外貌：名字、年龄、发型、衣服、配饰不要变着写。`

  if (input.productImages?.length) {
    log(`→ 调用视觉工具分析 ${input.productImages.length} 张参考图`)
    onProgress?.(`先识别 ${input.productImages.length} 张参考图；看完再按人物 → 场景 → 分镜分步提炼…`)
    const visualContent: LLMContentPart[] = [
      ...input.productImages.slice(0, 5).map((url) => ({
        type: 'image_url' as const,
        image_url: { url }
      })),
      {
        type: 'text',
        text: `你只负责看图，不负责写剧本。逐张识别并用简体中文给出：
1. 人物/动物/吉祥物的数量、年龄段、脸型、发型、服装、配饰；
2. 产品的品类、外观、颜色、可见文字（看不清就写“不可辨认”，严禁猜测）；
3. 场景、构图与光线；
4. 跨镜头必须保持不变的视觉锚点。
只陈述画面里可见的事实，不补品牌、参数、价格、功效或人物关系。`
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
    productNote += `\n\n【视觉工具识别结果（只作事实依据）】\n${visual.content.slice(0, 8_000)}`
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
    const common = `主题：${input.topic || '（未填）'}\n比例：${input.aspectRatio}\n单镜时长参考：${input.shotDuration} 秒\n\n完整剧本：\n${play}`
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
            { role: 'system', content: `${system}\n禁止输出思考过程或自然语言。第一个字符必须是 {，最后一个字符必须是 }。` },
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
          onProgress?.(`${label}未收到 JSON，正在补要一次…`)
          const salvage = await ask(
            '上一轮只写了思考、没有 JSON。现在立刻只输出 JSON 对象，不要任何解释。'
          )
          raw = parseJsonRobust(salvage.content)
          if (validate && !validate(raw)) {
            throw new Error(`${label} JSON 缺少必需的数据数组`)
          }
          onProgress?.(`✓ ${label}提炼完成`)
          return { raw, model: salvage.model }
        }
        if (validate && !validate(raw)) {
          onProgress?.(`${label} JSON 结构不完整，正在自动修复一次…`)
          const repaired = await ask(
            repairInstruction || `上一轮 JSON 结构错误。请严格按系统要求重新输出完整的 ${label} JSON。`
          )
          raw = parseJsonRobust(repaired.content)
          if (!validate(raw)) throw new Error(`${label} JSON 修复后仍缺少必需的数据数组`)
          onProgress?.(`✓ ${label}提炼完成`)
          return { raw, model: repaired.model }
        }
        onProgress?.(`✓ ${label}提炼完成`)
        return { raw, model: response.model }
      } catch (error) {
        if (isAbortError(error) && !isTimeoutAbort(error)) throw error
        const message = (error as Error).message
        log(`⚠ ${label}提炼失败：${message}`)
        throw new Error(`提炼${label}失败；已保留此前完成的节点，可直接重试本阶段：${message}`)
      }
    }

    const subjectSystem = `你是人物设定提炼子智能体。只从完整剧本「## 人物」提炼每一个独立小节，以及会实际入镜、入遗物/画像、或形成可见压力的人物、动物、产品或关键主体，不写场景，不拆分镜，不提炼资产图或道具清单。已故父亲、未到场的对手只要人物章有 ### 就必须建档，不要因为本集没站在镜头正中而删掉。忠实保留剧本称呼；有名字又有身份称呼时，name 用最常在对白和场记里出现的短名，role 写全身份和别称，便于另一智能体用名字或身份绑定。人物外貌必须具体到年龄、脸型、发型、体型、服装、鞋、配饰和稳定辨识点，不允许只写“主角”。description 只锁身份外貌，不要写他所在的地点或天气：后续角色设计图一律画在无缝纯白背景的四视图上。stateVariants 写清本章内会变的东西：衣服干湿、污渍、饥饿、跛行、手里的食物；没有变化就写单一状态。${productNote}
voicePrompt 是这个角色开口说话时的音色与表达，必须自动写、不许空着：kind 为 person 的角色都要写，按「年龄性别 + 音色质地（沙哑/清亮/温吞/鼻音重等）+ 语速与力度 + 情绪基调 + 身份口音或口头习惯」写成一句中文，25–60 字，能直接当配音导演给演员的指令。同一个角色全片只写一条，不要每场换声线；动物和产品（kind 为 animal/other）写空字符串。\n只输出 JSON：{"subjects":[{"name":"短名","kind":"person|animal|other","description":"具体外貌锁定，不含场景","role":"身份、剧情作用和别称","stateVariants":"本集内状态变化，没有写单一状态","voicePrompt":"说话时的音色与表达，非人物写空","fromReference":false}]}。输出前自行检查：人物章每一个 ### 都单独建档；有台词、有动作或被镜头看见的人不能并成路人；每个 person 角色都有 voicePrompt。`

    const sceneSystem = `你是场景与视觉设定提炼子智能体。只提炼本集会拍到的**地点**，不写人物，不拆分镜。
地点来源优先：剧本「## 环境与场景」下的地点；其次场记行「内景｜地点｜天气」或「外景｜地点｜」。同一地点只建一条，不要按「场景一、场景二」每场复制一条。
scene.name 用地点短名（如旧仓房、公益饭堂院子），不要用「场景一」。
每个地点写无人时的空间：地面、建筑、天气、光、年代物件。
${productNote}
${stylePriority}
只输出 JSON：{"aesthetic":"全片中文氛围","h3Aesthetic":"English production aesthetic with concrete lighting, material, color and camera qualities","styleBrief":"本集冲突和视觉抓点","colorPalette":"可见颜色","lightingNote":"时辰与光源","scenes":[{"name":"地点短名","description":"无人时的空间、地面、建筑、天气、动态和光线，至少80字","mainAnchor":"主视觉实物","anchors":"全景；主锚；地面站位区；光源或次锚","lighting":"时辰和光源"}]}
顶层必须是对象，scenes 必须是非空数组。不要套 data/result，不要把 scenes 写成对象。`


    const pullRecurringProps = async (script: string, subjects: Subject[]): Promise<StoryProp[]> => {
      const names = subjects.map((item) => item.name)
      let rows = propsListedInPlay(script)
      if (!rows.length && getAIMode() !== 'mock') {
        try {
          const part = await runPart(
            '道具',
            '你只提炼成片里会反复入镜的同一件道具。不要人物，不要地点，不要把衣服、鞋、发型当道具。只有被寻找、交接、反复特写的独立物件才算，例如黑领带、零食罐、同一把钥匙。name 用剧本短名，2到8个字。description 只写形状、材质、颜色、新旧和辨识点，不写房间。只输出 JSON：{"props":[{"name":"黑领带","description":"窄版黑色丝绸领带，尖端有细金属夹"}]}。没有就输出 {"props":[]}。',
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
      onProgress?.('第 1/3 步：提炼人物，并找出反复出现的道具…')
      const playPeople = extractSubjectsFromPlay(play)
      if (playPeople.length) {
        log(`✓ 从剧本文字抽出 ${playPeople.length} 个角色，不走模型`)
        onProgress?.(`剧本里已有人物设定，直接落下 ${playPeople.length} 个角色`)
        subjectPart = { raw: { subjects: playPeople }, model: parallelModel }
      } else {
        subjectPart = await runPart('人物', subjectSystem, 4000, PLAY_LLM_TIMEOUT_MS)
      }
      const rows = Array.isArray(subjectPart.raw?.subjects) ? subjectPart.raw.subjects : playPeople
      if (!rows.length) throw new Error('提炼人物失败：剧本里没有人物节或对白名，模型也没给出名单')
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
        onProgress?.('人物阶段完成。下一步由你确认后再提炼场景。')
        return {
          result: { subjects: normalized.subjects, props, scenes: [], shots: [] },
          model: subjectPart.model || parallelModel
        }
      }
    } else {
      onProgress?.(`✓ 已有 ${input.existingSubjects?.length || 0} 个角色，从已保存结果继续`)
    }

    if (stageOrder[startAt] <= stageOrder.scenes) {
      onProgress?.('第 2/3 步：只提炼场景锚点…')
      const playScenes = extractLocationsFromPlay(play)
      if (playScenes.length) {
        log(`✓ 从剧本文字抽出 ${playScenes.length} 个地点，不走模型`)
        onProgress?.(`剧本里已有地点，直接落下 ${playScenes.length} 个场景`)
        scenePart = { raw: { scenes: playScenes }, model: parallelModel }
      } else {
        const sceneUser = `主题：${input.topic || '（未填）'}
比例：${input.aspectRatio}

只从下面的地点与场次提炼场景，不要另造地点。同一地点只建一条。
${extractPlayForSceneStage(play)}`
        try {
          scenePart = await runPart(
            '场景',
            sceneSystem,
            8000,
            PLAY_LLM_TIMEOUT_MS,
            (raw) => extractSceneRows(raw).length > 0,
            '上一轮虽然是 JSON，但 scenes 数组缺失或放错了层级。立刻只输出一个对象，顶层必须有非空 scenes 数组。不要套 data、result，不要写思考。',
            sceneUser
          )
        } catch (error) {
          if (isAbortError(error) && !isTimeoutAbort(error)) throw error
          throw error
        }
      }
      let rows = extractSceneRows(scenePart.raw)
      if (!rows.length && playScenes.length) rows = playScenes
      if (!rows.length) throw new Error('提炼场景失败：剧本里没有「环境与场景」或「内景｜地点」，模型也没给出地点。人物节点已经保留。')
      const normalized = normalizeStoryboard(
        { ...scenePart.raw, subjects: subjectPart.raw.subjects || [], scenes: rows, shots: [] },
        { style: input.style, topic: input.topic, content: input.content, keywords: input.keywords, maxShotDuration: input.maxShotDuration }
      )
      await input.onExtractStage?.('scenes', { ...normalized, shots: [] })
      onProgress?.(`✓ 已保存 ${normalized.scenes?.length || 0} 个场景`)
      if (stopAfter === 'scenes') {
        onProgress?.('场景阶段完成。下一步由你确认后再拆分镜。')
        return {
          result: { ...normalized, shots: [] },
          model: scenePart.model || subjectPart.model || parallelModel
        }
      }
    } else {
      onProgress?.(`✓ 已有 ${input.existingScenes?.length || 0} 个场景，从已保存结果继续`)
    }

    onProgress?.('第 3/3 步：按场次拆成小组并发写分镜…')
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
    if (!workBatches.length) throw new Error('剧本正文为空，无法拆分镜')
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
        onProgress?.(`✓ 小组 ${completed}/${workBatches.length} 完成，按剧本顺序累计 ${partial.shots.length} 镜，正在写入画布…`)
        persistQueue = persistQueue.then(() =>
          input.onExtractStage?.('shots', partial, {
            partial: true,
            completed: completedSnapshot,
            total: workBatches.length
          })
        )
        await persistQueue
      } else {
        onProgress?.(`✓ 小组 ${completed}/${workBatches.length} 完成；等待前一段后按镜号写入`)
      }
    }

    await mapLimit(
      workBatches,
      SHOT_BATCH_CONCURRENCY,
      async (batch, index) => {
        // 断点续跑：这个工作包上次已经完成，直接复用结果，不重复消耗 token。
        const resumed = input.resumeBatchShots?.[index]
        if (resumed?.length) {
          onProgress?.(`↩ ${batch.label} 已有断点结果，直接续用（${resumed.length} 镜）`)
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
          onProgress?.(`⚠ ${batch.label} 并发首轮未完成；其他小组继续`)
        }
      },
      input.signal
    )
    await persistQueue

    if (failed.length) {
      const retryRows = [...failed].sort((a, b) => a.index - b.index)
      failed.length = 0
      onProgress?.(`有 ${retryRows.length} 个小组未完成，已自动降为单路逐个重试，避免接口并发限流…`)
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
          onProgress?.(`⚠ ${item.label} 单路重试仍失败；继续处理下一包`)
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
      throw new Error(`所有分镜小组均失败。人物和场景已保留；请重试拆分镜。${failed[0]?.error ? `首个错误：${failed[0].error}` : ''}`)
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
        `${failed.length}/${workBatches.length} 个分镜小组失败；其余 ${rawShots.length} 镜已经保存。失败段：${failed.map((item) => item.label).join('、')}`
      )
    }
    onProgress?.(`✓ ${workBatches.length} 个小组全部完成，共拆出 ${rawShots.length} 镜`)
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
      onProgress?.(`分阶段提炼完成；有 ${warnings.length} 项可在画布继续调整`)
    } else {
      onProgress?.('人物、场景、分镜均已完成并绑定…')
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
    ? `${verbatimSplitRule(input.verbatim)}下面是已经写好的完整剧本。请**忠实提炼**成画布节点 JSON（subjects / scenes / shots），不要重写故事、不要另起炉灶。${budgetLine}

完整剧本：
"""
${input.content?.trim() || '（空）'}
"""

主题：${input.topic || '（未填）'}
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}
视频比例：${input.aspectRatio}
时长参考：大约每镜 ${input.shotDuration} 秒（跟剧本里的场次走，别强行统一）

${stylePriority}
${productNote}

要求：人物/场景/分场与剧本一一对应；剧本对白原词必须进入对应镜头 voiceover（写成「人物名：台词」），禁止改成成年旁白，禁止清空成默片；同一人物同一意图的连续 2-4 个短句尽量合在一镜，不要机械拆成“一镜一句”；visualPrompt 按剧本「画面」写成静帧可画描述；videoPrompt 从0秒到镜头结束按剧情拍点分2–5段，逐段写谁从什么状态开始、看见什么、做什么、谁说原词、其他人怎样占位和反应、情绪怎样变化、镜头怎样运动并落下。不要机械等分，不要套「禁止呆脸空眼」这种话。说话时是否收近服从画面感、动作、空间关系与情绪节奏：需要强调表情时可用近景/特写，需要保留关系或环境时继续用中景、双人或多人同框；不要把每个说话镜头机械切成特写。禁止抄 visualPrompt。直接输出 JSON。`
    : `按编剧手册把这段文案拆成能拍的分镜。口播要能念，画面用中文白话写给摄像，别写英文提示词沙拉。${budgetLine}

事实保真：不得新增原文没有的价格、参数、功效、人物关系、品牌承诺或剧情结论。原文含数字、专有名词时必须原样保留。信息不够就用画面承接，不要编事实填空。

文案主题：
"""
${input.topic || '（未填）'}
"""

文案内容：
"""
${input.content?.trim() || '（没写正文。有参考图就按图编口播和镜头。）'}
"""
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}

视频比例：${input.aspectRatio}
时长参考：大约每镜 ${input.shotDuration} 秒（只是节奏，别所有镜头同一秒数）

${stylePriority}
${productNote}

顺序：先锁人物和地点，再拆镜头。每镜 visualPrompt 用镜头语言写静帧里能看见的东西；videoPrompt 写这一镜演什么，不要写成配图词。
${
  hasUserStyle
    ? `画风「${mediumPhrase}」在画面描述里点一次，写进桥、水、衣这些实物上。禁止第一句只写画风、结尾再抄一段技法套话。禁止只写「两人相对拱手」这种站位摘要。`
    : `主题没提画风时，画面里带上「${styleCn}」，同样要写清环境实物与动态。`
}
直接输出 JSON，不要解释。`

  const extractSystemExtra = extractMode
    ? `\n【本轮任务】输入已是完整剧本。只做提炼与落库字段补全，禁止改口播原意，禁止合并剧本里已分开的人物。每个 subject 必须在至少一镜的 subjectIds 和 visualPrompt 里出场点名，不能只建档不入镜。`
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

【字段语言】h3Aesthetic 用英文。visualPrompt 用中文写静帧可画内容。videoPrompt 用中文写这一镜的视频内容表现。
${videoPerformanceSpec(getVideoPromptStyle())}

【输出 JSON】
{
  "aesthetic": "<一两句人话，说出全片味道，用用户主题里的词>",
  "h3Aesthetic": "<English production aesthetic, concrete lighting/material/camera qualities>",
  "styleBrief": "<这片图啥、冲突在哪、凭什么不划走>",
  "colorPalette": "<几处能看见的颜色，别写色板编号>",
  "lightingNote": "<几点钟、灯从哪来>",
  "subjects": [
    {
      "id": "sub_1",
      "name": "街上能喊出来的短名",
      "kind": "person|animal|other",
      "description": "<外貌锁定，写成能去夜市买同款：年龄、发型、衣服、鞋、疤或习惯动作；不要写地点天气，角色设计图是纯白背景四视图>",
      "role": "<这人在片里干什么>",
      "stateVariants": "<会不会换衣服；不会就写单一状态>",
      "voicePrompt": "<这人开口说话时的音色与表达：年龄性别、音色质地、语速力度、情绪基调、口音或口头习惯；25-60 字中文，能当配音导演指令；animal/other 写空字符串>",
      "props": "<身上穿戴和随身物：包、证件、平板、鞋、帽子等，没有写无>",
      "fromReference": false
    }
  ],
  "scenes": [
    {
      "id": "scn_1",
      "name": "地点短名",
      "description": "<人还没进来时这个地方：地面、水、植物、建筑、风是否在动、光从哪来，80字以上>",
      "mainAnchor": "<摄像能对着的实在东西>",
      "anchors": "<四宫格锚点，分号分隔：全景；主锚；地面站位；光源或次锚>",
      "lighting": "<时辰和光源>"
    }
  ],
  "shots": [
    {
      "title": "场记板上能写的 3-8 字",
      "purpose": "钩子/说明/反应/揭示/收口",
      "shotSize": "<远近 + 为什么>",
      "blocking": "<每个人：近处还是后面、踩在什么上、身体朝哪。说话者可以在后。禁止正面排排站>",
      "eyeline": "<每个人看谁或看什么；前面的人回头/侧头看说话者或他指的东西，禁止看镜头>",
      "continuity": "<承接上一镜的具体末态（首镜写开场初态） → 本镜发生的可见变化 → 留给下一镜的具体末态；写清位置、姿势、朝向、手中物、情绪和已知信息>",
      "propFocus": "<这镜要看清的物件及它现在的状态，没有写无>",
      "visualPrompt": "<镜头语言：近到远写清画面里所有实物；水/风/衣摆动或不动；光从哪来；人穿什么、踩哪、手拿什么。这是静帧配图词。画风词点一次。禁止画风套话段，禁止只写站位>",
      "videoPrompt": "${videoPromptJsonHint(getVideoPromptStyle())}",
      "audioDescription": "<现场能听到的，逗号分隔>",
      "voiceover": "<人物名：这一镜连续要说的 1-4 个短句；优先 2-4 句，没有就空字符串>",
      "audioMode": "h3-dialogue|h3-voiceover|tts|none",
      "speakerHint": "<说话人声音特征 / 情绪 / 表达方式；没有口播则空字符串>",
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
默认每镜使用 H3 出镜对白：把原文按语义段落分配到 voiceover，并设置 audioMode=h3-dialogue。不要机械地一镜一句；当前模型单镜最长 ${shotDurationLimit(input)} 秒，同一地点、同一人物、同一表达意图或连续动作能在上限内完成时，优先合成一个 7-${shotDurationLimit(input)} 秒的完整镜头，禁止为了凑固定时长拆成两个 5 秒镜头。只有视觉焦点、时空、轴线或戏剧任务真正改变时才切镜。短促反应或转场才只说一句，口播总量约每秒 4 个字。voiceover 写“人物名：台词”，speakerHint 同时写说话人和声线。说话镜头的景别服从画面感、动作、空间关系和情绪节奏：表情是重点且不需交代环境时可以收近；需要看清递物、争执、问答、人物距离、环境压力或集体反应时，保留中景、双人或多人同框。禁止按“只要说话就特写”的模板拆镜，但要写清当前谁说话、其余人如何反应，避免所有人同时张嘴。只有原文明说是旁白/画外音时才用 h3-voiceover，明确要求后期配音时才用 tts，明确无口播的空镜才用 none。人物章每一个 ### 都必须在 subjects 中单独建档；已故角色至少一镜出现遗物、画像或闪回，活人对手至少一镜出现对峙或可见压力。每镜 title 必须是不同的 3-8 字内容标题，禁止统一写“镜头”。逐对核对 continuity，后一镜开头必须接住前一镜结尾；重大状态变化按上面的叙事连续性硬规则展开，禁止从结果直接跳到讲解。
只输出合法 JSON。`
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
      `LLM 响应结构不对，没有 shots 数组：${JSON.stringify(parsed).slice(0, 200)}`
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
  onProgress?.(`时长检测仍不合格，已按 ${target} 秒强制收回各镜时长，现为 ${fittedTotal} 秒`)
  return { ...current, shots: fitted }
}

export function storyboardQualityIssues(
  result: StoryboardResult,
  input: Pick<StoryboardInput, 'content' | 'topic' | 'targetDurationSec' | 'maxShotDuration'>
): string[] {
  const issues: string[] = []
  if (!result.shots.length) issues.push('严重：没有生成任何分镜')
  const targetSec = Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  const shotCap = shotBudgetFromDuration(targetSec, input.maxShotDuration) || 12
  if (result.shots.length > shotCap) {
    issues.push(
      `${targetSec ? '严重：' : ''}分镜 ${result.shots.length} 个，超出${targetSec ? `「${targetSec} 秒」对应的 ${shotCap}` : shotCap}镜预算，短视频节奏失控`
    )
  }
  if (
    result.subjects?.length === 1 &&
    result.subjects[0]?.name === '主角' &&
    (input.content || '').trim()
  ) {
    issues.push('严重：没有从用户原文中提取完整人物，只生成了兜底“主角”')
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
    issues.push(`严重：subjects 遗漏原文人物：${visibleRoles.join('、')}`)
  }
  const normalizedTitles = result.shots.map((shot) => shot.title.trim())
  if (
    normalizedTitles.some((title) => /^镜头\s*\d*$/.test(title)) ||
    new Set(normalizedTitles).size !== normalizedTitles.length
  ) {
    issues.push('严重：分镜标题缺失或重复；每镜必须使用不同的内容标题，不能统一写“镜头”')
  }
  const targetDuration = targetSec
  const totalDuration = result.shots.reduce((sum, shot) => sum + shot.duration, 0)
  const durationIssue = durationWindowIssue(totalDuration, targetDuration)
  if (durationIssue) issues.push(durationIssue)
  if (!result.h3Aesthetic || result.h3Aesthetic.length < 35) {
    issues.push('缺少可直接传给 H3 的英文 Aesthetic')
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
    issues.push('对白过少：有人物同场的镜头几乎不说话，短剧/短电影不能写成默片。唤名、问答、相认、对峙、劝阻必须落到 voiceover。禁止把全部前情塞进第一镜成年旁白')
  }
  if (
    voicedShots.some((shot) => /成年/.test(shot.voiceover)) &&
    voicedShots.filter((shot) => !/成年/.test(shot.voiceover)).length < 2
  ) {
    issues.push('出镜对白被改成了「成年某某」旁白；本场人物必须自己开口，故事背景不要用旁白复述')
  }
  if (
    totalDuration >= 25 &&
    voicedShots.length >= 3 &&
    voicedShots.every((shot) => spokenSentenceCount(shot.voiceover) <= 1)
  ) {
    issues.push('口播被机械拆成了“一镜一句”；同一人物、同一表达意图的连续 2-4 个短句应合进一个 7-10 秒镜头，只给短促反应保留单句')
  }
  result.shots.forEach((shot, index) => {
    const label = `第 ${index + 1} 镜`
    const speakers = voiceoverSpeakerLabels(shot.voiceover || '')
    const speaker = speakers[0]
    if (shot.audioMode === 'h3-dialogue' && speaker) {
      const staging = [shot.shotSize, shot.blocking, shot.visualPrompt, shot.videoPrompt]
        .filter(Boolean)
        .join('\n')
      if (!staging.includes(speaker)) {
        issues.push(`${label} 出镜对白没点名说话者「${speaker}」`)
      }
    }
    if ((shot.visualPrompt || '').trim().length < 50) {
      issues.push(`${label} 画面描述过短，无法稳定生成`)
    }
    const performance = (shot.videoPrompt || '').trim()
    const still = (shot.visualPrompt || '').trim()
    if (!performance || performance === still) {
      issues.push(`${label} 缺少视频内容表现（谁做什么、说什么、镜头怎么走），不能复用配图描述`)
    } else {
      const names = (result.subjects || [])
        .filter((s) => (shot.subjectIds || []).includes(s.id) || performance.includes(s.name))
        .map((s) => s.name)
      const perfIssue = videoPerformanceIssue(performance, names)
      if (perfIssue) issues.push(`${label} ${perfIssue}`)
    }
    if (!shot.sceneId) issues.push(`${label} 没有关联场景`)
    if (!shot.cameraMovement) issues.push(`${label} 缺少运镜方式`)
    const continuity = (shot.continuity || '').trim()
    const continuitySteps = (continuity.match(/→/g) || []).length
    if (continuity.length < 28 || continuitySteps < 2) {
      issues.push(`严重：${label} continuity 没写清“承接上一镜末态 → 本镜变化 → 下一镜末态”，无法保证跨段连续`)
    }
    const emptyPlate =
      !shot.voiceover.trim() && /空镜|空景|无人/.test(`${shot.title}${shot.visualPrompt}`)
    if (people.length && !(shot.subjectIds ?? []).length && !emptyPlate) {
      issues.push(`严重：${label} 没有关联人物，人设图不会进这镜配图`)
    }
  })
  const source = (input.content || '').trim()
  if (source.length > 0 && result.shots.every((shot) => !shot.voiceover.trim())) {
    issues.push('严重：用户有完整文案，但所有镜头口播均为空')
  }
  for (const sub of people) {
    const used = result.shots.some(
      (shot) =>
        (shot.subjectIds ?? []).includes(sub.id) ||
        inferSubjectsFromText(shotCastText(shot as Shot), [sub]).length > 0
    )
    if (!used) issues.push(`严重：人物「${sub.name}」已建档，但所有分镜都没用上`)
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
  if (explicit && !/^镜头\s*\d*$/.test(explicit)) return explicit.slice(0, 12)

  const source = String(raw?.purpose ?? raw?.visualPrompt ?? raw?.videoPrompt ?? '')
    .replace(/^(特写|近景|中景|全景|远景|镜头|画面)[：:，,、\s-]*/i, '')
    .replace(/[【】()[\]<>"'“”‘’]/g, '')
    .trim()
  const phrase = source.split(/[，。！？；,:.!?;\n]/)[0]?.replace(/\s+/g, '') || ''
  return phrase ? `${phrase.slice(0, 6)}${index + 1}` : `分镜${index + 1}`
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
              ? '第 3 步：按已保存的人物和场景拆分镜…'
              : '第 1 步：只提炼人物角色…'
          : `正在按「${look.medium}」拆能拍的镜头...`
      )
    try {
      const { result, model } = await realStoryboard(resolved, onProgress)
      onProgress?.(
        input.mode === 'extract' && !result.shots.length
          ? '✓ 当前提炼阶段已完成并保存'
          : `✓ 已交付 ${result.shots.length} 个可编辑分镜`
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
          : `脚本生成失败：${msg}`
      )
    }
  }

  onProgress?.('🎭 演示模式（未配置 VITE_AI_REAL_MODE=true）')
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
  if (!/##\s*(故事背景|本章承接)/.test(t)) gaps.push('故事背景（一句话故事、对抗引擎、完整梗概；禁止高潮切片）')
  else {
    if (!/一句话故事/.test(t)) gaps.push('故事背景必须写明「一句话故事」')
    if (!/对抗引擎/.test(t)) gaps.push('故事背景必须写明「对抗引擎」（对手是谁、要什么、如何抬高代价）')
    if (/本片从|本段从哪一帧|从.*瞬间开始/.test(t) && !/完整梗概/.test(t)) {
      gaps.push('故事背景被写成高潮切片，必须补完整梗概：开端、对手、递进阻力、高潮选择、结局')
    }
  }
  if (!/##\s*人物/.test(t)) {
    gaps.push('人物（主角、对手、关键亲人；每人含欲望/恐惧/弧光/视觉锚点）')
  } else {
    if (!/欲望/.test(t) || !/恐惧/.test(t) || !/弧光/.test(t)) {
      gaps.push('人物小传缺少欲望、恐惧或弧光，按编剧手册补全每人字段')
    }
    const people = t.split(/##\s*人物/)[1]?.split(/##\s+/)[0] || ''
    const charCount = (people.match(/^###\s+/gm) || []).length
    const looksLikeAd = /口播|带货|产品演示/.test(t)
    if (!looksLikeAd && charCount > 0 && charCount < 3) {
      gaps.push('人物表过薄：除路人外必须有主角、对手、关键亲人/导师；已故父亲和活人对手也要建档，不能只留两人高潮对手戏')
    }
  }
  if (!/##\s*环境与场景/.test(t) && !/##\s*场景\s*$/m.test(t)) {
    gaps.push('环境与场景（无人时的空间、天气、年代肌理）')
  }
  const sceneCount = (t.match(/##\s*场景[一二三四五六七八九十百0-9]/g) || []).length
  if (sceneCount > 0 && !/场次任务/.test(t)) {
    gaps.push('每场必须有场次任务（目标 / 阻力 / 结果）')
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
          content: `당신은 영상 시나리오 작가입니다. 기존 초고에서 빠진 이야기의 동력, 설정 또는 대사를 아래 요구사항에 따라 보완하세요. 캐릭터 소개, 갈등 구조, 상대역이나 가족이 등장하는 장면을 추가하고 실제로 말할 수 있는 화면 속 대사(**캐릭터 이름：**「대사 원문」)를 작성할 수 있습니다. 기존에 잘 작성된 장면은 가능한 한 원문을 유지하세요. 절정만 남은 초고에는 빠진 갈등과 핵심 인물을 복원하세요. 대사가 없는 초고에는 서로 알아보기, 대치, 질문과 답변을 주고받는 대사를 보완하세요. 배경에 이름만 한 줄 넣거나 성인이 된 인물의 내레이션으로 바꾸지 마세요.${PLAY_MARKDOWN_SPEC}\nJSON만 출력하세요. {"playMarkdown":"..."}`
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
          content: `你是影视剧本连续性编审。${NARRATIVE_CONTINUITY_RULES}\n先判断用户这次只要求讲到哪里。只检查该边界内会导致情节突兀的实质问题，不把悬念结尾、未讲下一集或刻意留白判为缺失，不改风格，不挑遣词。只输出 JSON：{"issues":["具体问题及边界内应补的过渡拍点"]}；没有问题输出 {"issues":[]}。最多 6 条。`
        },
        {
          role: 'user',
          content: `用户要求：\n${input.topic}\n${input.content}\n\n完整剧本：\n${draft.playMarkdown}`
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
          content: `你是影视编剧。只修复指出的叙事断层，保留用户事实、人物关系、重要台词、画风和已经成立的段落。${NARRATIVE_CONTINUITY_RULES}\n可以在断层附近新增、拆分或重排场次，使核心事件获得足够画面与时长；不要用旁白一句带过关键过程。必须保留或补全「故事背景 / 人物 / 环境与场景 / 拍摄原则」。禁止改回口播/画面/时长四格表。只输出 JSON：{"playMarkdown":"..."}。`
        },
        {
          role: 'user',
          content: `用户要求：\n${input.topic}\n${input.content}\n\n必须修复：\n- ${issues.join('\n- ')}\n\n待修完整剧本：\n${draft.playMarkdown}`
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

const PLAY_MARKDOWN_SPEC = `playMarkdown에는 촬영하고 샷으로 나눌 수 있는 완전한 대본이 들어가야 합니다. 내레이션, 화면, 소리, 길이의 네 칸짜리 표로 압축하지 마세요. 이후 캐릭터, 장면, 스토리보드를 추출할 때 이 본문만 읽습니다. 배경, 캐릭터 설정, 환경이 대본에 없으면 스토리보드가 빈약하고 연결이 끊깁니다.

제목과 본문, 캐릭터 설명, 대사는 한국어로 작성하고 아래 구조를 따르세요. 파서와 검수기가 읽는 중국어 제목과 항목명은 그대로 사용하세요. 이야기에 필요한 만큼 장면을 작성하세요. 단편은 길이를 압축할 수 있지만 상대역, 핵심 가족, 갈등 구조를 빼면 안 됩니다. 설화나 IP를 각색할 때 절정만 잘라 내지 마세요. 영화 챕터는 필요한 장면을 모두 작성하세요.

# 제목
> 类型：…　时间：시대/계절/낮밤　地点：도시와 구체적인 구역　建议时长：…

## 故事背景
다음 세 항목을 모두 작성하세요. 사용자가 특정 부분만 요청한 경우를 제외하고, 어느 프레임에서 시작한다는 말로 전체 이야기를 대신하지 마세요.
- 一句话故事：[주인공]은 [외적 목표]를 위해 [어려운 행동]을 해야 한다. 실패하면 [대가]를 치른다.
- 对抗引擎：상대역은 누구이며 무엇을 원하는지, 어떤 가치관에 따라 움직이는지, 대가를 어떻게 계속 키우는지 작성하세요.
- 完整梗概：발단, 전환점, 점차 커지는 장애물, 절정의 선택, 결말까지 이어지는 산문으로 쓰세요. 상대역과 핵심 가족은 이야기 안에 등장해야 하며 배경 설명 한 줄로 처리하지 마세요.

## 人物
이야기를 움직이는 인물마다 한 절(### 짧은 이름)을 배정하세요. 주인공, 상대역 또는 이를 인격화한 인물, 부모, 멘토, 법 집행자가 여기에 해당합니다. 사망하거나 자리에 없거나 후반부에야 등장하는 인물도 기록하세요. 행인은 간단히 언급하되 대사가 있거나 사건의 인과를 움직이는 인물을 ‘어떤 남자’로 뭉뚱그리지 마세요.
각 절은 캐릭터 이미지를 그리거나 상대역과 연기할 수 있을 만큼 구체적으로 쓰세요.
- 身份
- 年龄与外形识别点：얼굴, 헤어스타일, 체형, 키의 인상
- 性格与语感
- 欲望
- 恐惧与弱点
- 关系
- 弧光：이 챕터에서 어떤 상태로 시작해 어떻게 변하는가
- AI视觉锚点：의상, 신발, 액세서리, 소지품, 닳거나 더러워진 부분(4면 설정 이미지를 그릴 수 있도록)
- 跨场状态变化：허기, 옷이 젖거나 마른 상태, 부상, 손에 든 물건
- 本片出场：화면 등장 / 사망해 화면 밖에 있음(유품 또는 초상화가 화면에 등장) / 상대역의 눈에 보이는 압박

## 环境与场景
촬영할 장소마다 한 절(### 짧은 장소명)을 배정하세요. 이후 장면 이미지에 사용할 수 있도록 사람이 없는 공간을 묘사하세요.
- 건축 구조, 출입구, 바닥, 주요 기준 소품
- 날씨, 젖거나 마른 상태, 빛이 들어오는 방향
- 시대와 도시의 질감(차량, 간판, 복장, 전선, 셔터 등을 대본의 연도와 지역에 맞춰 작성)
이어지는 장면에서는 같은 날씨를 유지하세요. 한 장면에 폭우가 쏟아졌는데 다음 장면 바닥이 말라 있으면 안 됩니다.

## 拍摄原则
촬영에서 제외할 것, 선의가 행동으로 드러나는 방식, 고난을 절제해 보여 주는 방식을 명확히 쓰세요. 특별한 제한이 없어도 ‘사실적으로 표현하고 감정을 과장하지 않는다’고 적으세요.

## 场景一｜현장 기록 제목
**内景 또는 外景 중 하나｜장소 원래 이름｜날씨와 시간대**
人物：이 장면에 있는 인물(유품이나 초상화로 대표되는 부재 인물이 있으면 표시)
场次任务：목표 / 장애물 / 결과

보거나 듣거나 실행할 수 있는 동작을 현재형으로 쓰세요. ■ 기호로 동작의 박자를 나열할 수 있습니다. 누가 가까이 또는 뒤에 있는지, 몸을 어느 방향으로 두는지, 무엇을 보고 무엇을 하는지 쓰세요. 앞쪽에 있는 인물은 옆을 향하거나 뒤돌아보고 카메라를 정면으로 보지 않게 하세요.
대사는 다음 형식으로 쓰세요.

**캐릭터 이름：**

「대사 원문」

인물이 소통하는 장면에는 동작만 적지 말고 주고받는 대사를 쓰세요. 이름 부르기, 묻고 답하기, 서로 알아보기, 대치, 만류, 작별에서는 최소 한 번씩 주고받으세요. 이야기 배경을 ‘성인이 된 인물’의 내레이션에 몰아넣지 마세요. 이 장면에 등장한 인물이 직접 말해야 합니다.
절제한다는 것은 구호나 명언 같은 문장을 덜어 내는 것입니다. 전체 대사를 한두 마디로 줄이지 마세요. 이동만 하는 장면이나 인물 없는 장면에는 대사가 없어도 되지만, 인물들이 함께 연기하는 장면에는 대사가 필요합니다.
장면 끝은 【节拍：触发/抉择/阻力/转向/高潮/回收】 형식으로 맺으세요.
시간 압축이 필요하면 ### 蒙太奇를 사용하며 각 항목을 눈에 보이는 화면으로 쓰세요. ‘시간이 흘렀다’, ‘며칠이 지났다’ 같은 문구를 쓰지 마세요.
성인이 된 인물의 내레이션은 인용 블록에 쓰고 화면 밖 음성임을 표시하세요.
앞뒤 장면의 옷, 부상, 손에 든 물건, 날씨가 이어져야 합니다.

（이후 장면은 场景二, 场景三…）

## 本章情绪线
시작부터 마무리까지 감정이 어떻게 바뀌는지 한 문단으로 분명히 써서 이후 스토리보드에서 인물의 표정이 비지 않게 하세요.

## 视觉与声音基调
색채, 필름 또는 다큐멘터리 질감, 주요 환경음을 쓰세요. 따뜻한 장면은 뜨거운 물, 김, 사람 목소리로 표현하며 갑자기 화려한 공간을 만들지 마세요.

원칙
- 이야기의 동력, 캐릭터 설정, 환경을 분명히 한 뒤 장면을 쓰세요. 대사만 있고 인물 위치가 빠져서는 안 됩니다.
- 선의는 평범한 사람이 하는 작은 일입니다. 고난은 의상, 걸음걸이, 호흡, 환경으로 표현하세요.
- 상품 판매나 내레이션에서는 진행자와 제품도 인물 섹션에 넣으세요. 내레이션 원문은 대사에 넣되, 장소, 바라보는 대상, 손에 든 물건을 장면에 명확히 쓰세요.
- 장면마다 기계적으로 한 마디씩 배열하지 마세요. 하나의 의도로 이어지는 대사는 같은 장면에 두세요. 인물이 소통하는 장면에는 주고받는 대사를 쓰고 장면 전체를 무언으로 만들지 마세요.`

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
        content: `당신은 시나리오 작가입니다. 사용자의 요청과 기존 내용을 바탕으로 바로 대본을 작성하세요.
Markdown 본문만 출력하세요. JSON, 설명, 자체 점검은 출력하지 마세요.
제목과 본문, 캐릭터 설명, 대사는 한국어로 작성하세요. 제목, 이야기 배경, 캐릭터, 환경과 장면 순으로 쓴 다음 개별 장면을 작성하세요. 파싱에 필요한 섹션 제목은 정확히 「## 故事背景」, 「## 人物」, 「## 环境与场景」으로 쓰세요. 개별 장면 제목은 「## 场景N｜제목」 형식을 사용하세요. 장면 정보는 「**内景｜장소｜날씨와 시간대**」 또는 「**外景｜장소｜날씨와 시간대**」 형식을 사용하세요. 대사는 「**캐릭터 이름：**」 다음 줄에 「대사 원문」을 쓰세요.
사용자가 길이를 지정하면 그 길이에 맞춰 완성하세요. 캐릭터가 서로 소통하는 장면에서는 실제로 말할 수 있는 대사를 쓰세요. 사용자가 언급하지 않은 가격이나 효능은 추가하지 마세요.`
      },
      {
        role: 'user',
        content: continueMode
          ? `기존 대본 뒤에 이어 쓰세요. 기존 장면의 원문은 보존하고 뒤에만 추가하세요.

이어 쓸 방향
${hint || '지금까지 일어난 사건에 이어서 쓰세요.'}

현재 대본
${existingPlay || '（비어 있음）'}
${scaleBrief}`
          : `아래 요구사항에 따라 완전한 대본을 작성하세요.

요구사항
${input.topic || '（미입력）'}

기존 내용
${input.content?.trim() || '（없음）'}
${input.keywords?.length ? `키워드：${input.keywords.join('、')}` : ''}
화면 비율：${input.aspectRatio || '16:9'}
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
  if (playMarkdown.length < 40) throw new Error('模型没有返回剧本')
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
    onProgress?.(input.playMode === 'continue' ? '正在续写剧本…' : '正在写完整剧本…')
    try {
      const { result, model } = await realGeneratePlay(resolved)
      onProgress?.(
        input.playMode === 'continue'
          ? '✓ 已续写（保留原场次）'
          : '✓ 完整剧本已写好（尚未提炼节点）'
      )
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 写剧本失败：${msg}`)
      if (isAbortError(e) && !isTimeoutAbort(e)) throw e
      throw new Error(msg.startsWith('写剧本') || msg.startsWith('模型超过') ? msg : `写剧本失败：${msg}`)
    }
  }

  onProgress?.('🎭 演示模式写剧本')
  return { result: mockPlayFromBrief(resolved), source: 'mock' }
}

/** 是否已有可提炼的完整剧本 */
export function isPlayReady(script: Script | null | undefined): boolean {
  return Boolean(script?.playReady && script.content?.trim())
}
