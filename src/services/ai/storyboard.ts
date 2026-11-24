/**
 * 스토리보드 생성 서비스
 *
 * 입력은 원고, 주제, 스타일, 샷 길이다.
 * 출력은 연출 계획 필드를 포함한 StoryboardResult다.
 *
 * 실제 언어 모델을 호출해 숏폼 영상 감독의 관점에서 촬영 가능한 샷을 나눈다.
 * 실패하거나 설정이 없으면 데모 데이터를 사용한다.
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
import { mergeContinuedPlay, playSceneHeadings } from '@/utils/playContinue'
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
  /** 선택한 영상 모델의 샷당 최대 길이. 동작이 이 범위 안에서 이어져야 한다. */
  maxShotDuration?: number
  aspectRatio: string
  /** 원고 키워드(선택) */
  keywords?: string[]
  /** 제품 또는 주제 참조 이미지(data URL 또는 공개 URL)는 최대 5장. 상품 소개 영상에서는 제품을 기준으로 삼는다. */
  productImages?: string[]
  /**
   * extract는 완성 대본에서 캐릭터, 장면, 스토리보드 노드만 추출한다.
   * full은 기존 일괄 실행과 호환하기 위한 모드다.
   */
  mode?: 'extract' | 'full'
  /** write는 초안을 전체 대본으로 완성한다. continue는 기존 장면에 새 장면을 덧붙인다. */
  playMode?: 'write' | 'continue'
  /** 이어 쓰기 방향. 예를 들어 아버지가 귀가한 뒤 장면을 두 개 추가한다. */
  continueHint?: string
  /** 설정에 저장한 모델 이름으로 기본 언어 모델을 재정의한다. */
  model?: string
  signal?: AbortSignal
  /** 추출 단계가 끝날 때마다 저장한다. 이후 단계의 실패로 저장된 결과를 되돌리지 않는다. */
  onExtractStage?: (
    stage: 'subjects' | 'scenes' | 'shots',
    partial: StoryboardResult,
    meta?: { partial?: boolean; completed?: number; total?: number }
  ) => void | Promise<void>
  /** 재시도 시 완료하지 못한 단계부터 진행하고 이미 저장한 결과를 재사용한다. */
  extractStartAt?: 'subjects' | 'scenes' | 'shots'
  /** 사용자 작업 한 번마다 한 단계를 완료한다. */
  extractStopAfter?: 'subjects' | 'scenes' | 'shots'
  existingSubjects?: Subject[]
  existingScenes?: Scene[]
  /** 오리지널 영화 챕터는 장면과 몽타주를 기준으로 나눈다. */
  workflowMode?: Script['workflowMode']
  /** 가져온 완성 대본은 원문에 따라 샷을 나누고 대사와 줄거리를 유지한다. */
  verbatim?: boolean
  /**
   * 요청한 최종 영상 길이(초)는 스토리보드 샷 수의 상한을 결정한다.
   * 목표 길이에서 대본과 스토리보드의 규모를 역산한다.
   */
  targetDurationSec?: number
  /**
   * 재개 시 작업 그룹 번호별 완료 결과를 전달하면 해당 그룹의 모델 호출을 건너뛴다.
   * 배열 순서는 같은 대본을 buildShotWorkBatches로 나눈 결과와 일치해야 한다.
   */
  resumeBatchShots?: Array<Record<string, unknown>[] | undefined>
  /** 작업 그룹이 완료되거나 기존 결과를 재사용할 때 호출해 재개 지점을 기록한다. */
  onBatchDone?: (index: number, shots: Record<string, unknown>[], model?: string) => void
}

function isFilmChapterInput(input: Pick<StoryboardInput, 'workflowMode' | 'content'>): boolean {
  return input.workflowMode === 'film-chapter' || looksLikeFilmChapterPlay(input.content || '')
}

function shotDurationLimit(input: Pick<StoryboardInput, 'maxShotDuration'>): number {
  return Math.max(5, Math.min(30, Math.round(Number(input.maxShotDuration) || 15)))
}

/** 완성 영상과 목표 길이 사이에 ±10초를 허용한다. 이를 벗어나면 다시 요청한다. */
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

/** 짧은 길이 표현을 초로 변환한다. 초, 분과 초, 소수 분을 지원한다. */
function secondsFromPhrase(phrase: string): number {
  const english = phrase.trim().match(/^(\d+(?:\.\d+)?)[\s-]*(minutes?|mins?|m|seconds?|secs?|s)\b(?:\s*(\d+)\s*(?:seconds?|secs?|s)\b)?$/i)
  if (english) {
    const scale = /^m/i.test(english[2]) ? 60 : 1
    return acceptDuration(Number(english[1]) * scale + Number(english[3] || 0))
  }
  const text = phrase.replace(/\s+/g, '')
  if (!text) return 0
  if (text.includes('半分钟')) return 30
  const minSec = text.match(/(\d+)(?:分|분)(\d+)(?:秒|초)/)
  if (minSec) return acceptDuration(Number(minSec[1]) * 60 + Number(minSec[2]))
  const minutes = text.match(/(\d+(?:\.\d+)?)(?:分钟|분)/)
  if (minutes) return acceptDuration(Number(minutes[1]) * 60)
  const seconds = text.match(/(\d+)(?:秒钟|秒|초|s\b)/i)
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
  '((?:半分钟)|(?:\\d+\\s*(?:分|분)\\s*\\d+\\s*(?:秒|초))|(?:\\d+(?:\\.\\d+)?\\s*(?:分钟|분))|(?:\\d+\\s*(?:秒钟|秒|초))|(?:\\d+(?:\\.\\d+)?[\\s-]*(?:minutes?|mins?|m)\\b(?:\\s*\\d+\\s*(?:seconds?|secs?|s)\\b)?)|(?:\\d+[\\s-]*(?:seconds?|secs?|s)\\b)|(?:[一二两三四五六七八九十]+\\s*分钟)|(?:[一二两三四五六七八九十]+\\s*秒))'

function labeledDuration(text: string): number {
  const primary = new RegExp(
    `(?:总时长|成片时长|目标成片|成片|全片|整片|总共|一共|控制在|做成|拍成|建议时长|目标时长|视频时长|전체 길이|목표 길이|목표 영상 길이|영상 길이|\\b(?:target|total|video) duration\\b)\\s*[:：是为]?\\s*(?:约|大概|大约|약|about\\b|approximately\\b)?\\s*${DURATION_PHRASE}`,
    'gi'
  )
  let hit: RegExpExecArray | null
  while ((hit = primary.exec(text))) {
    const n = secondsFromPhrase(hit[1] || '')
    if (n) return n
  }
  const filmed = text.match(
    new RegExp(`${DURATION_PHRASE}\\s*(?:左右|以内|정도|이내|짜리)?\\s*(?:的)?\\s*(?:短剧|短片|视频|成片|短电影|숏드라마|단편|영상|\\b(?:short film|short drama|video)\\b)`, 'i')
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

/** 사용자 요청에서 목표 길이를 찾는다. 인식할 수 없으면 0을 반환한다. */
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

/** 목표 길이의 ±10초 범위를 벗어나면 다시 요청할 사유를 반환한다. */
export function durationWindowIssue(totalSec: number, targetSec: number): string {
  const target = Math.round(Number(targetSec) || 0)
  if (target < 10) return ''
  const total = Math.round(totalSec)
  if (Math.abs(total - target) <= DURATION_TOLERANCE_SEC) return ''
  const lo = target - DURATION_TOLERANCE_SEC
  const hi = target + DURATION_TOLERANCE_SEC
  return `Critical: The video runs ${total} seconds, outside the ${lo}–${hi}-second window for the ${target}-second target. Merge adjacent shots with the same cast and location if too long, or extend existing shots if too short. Retain all key story events.`
}

/**
 * 모델의 샷당 최대 길이로 최종 영상 길이를 나눈다.
 * 목표가 30초이고 샷당 최대 15초면 두 그룹에 15초씩 배정한다.
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
 * 목표 길이로 스토리보드 그룹 수를 정한다. 그룹 하나는 모델의 최대 길이 샷 하나에 해당한다.
 * 목표가 30초이고 최대 15초면 그룹을 두 개 만든다.
 */
export function shotBudgetFromDuration(targetSec: number | undefined, maxShotSec?: number): number {
  return durationSlices(targetSec, maxShotSec).length
}

const AD_COPY = /口播|带货|产品演示|내레이션|라이브\s*커머스|제품\s*시연|\b(?:narration|product demo|shoppable video|live commerce)\b/i
const ADULT_NARRATOR = /成年|성인|어른이\s*된|\badult\b/i
const NUMBERED_SCENE = /^##[ \t]+(?:场景[ \t]*[一二三四五六七八九十百0-9]|(?:장면|Scene)[ \t]+\d+)/gim

function isLongFormPlay(input: Pick<StoryboardInput, 'workflowMode' | 'content'>, play = ''): boolean {
  const text = play || input.content || ''
  if (input.workflowMode === 'film-chapter') return true
  if (/(?:建议时长|권장\s*길이|recommended\s*(?:duration|length))[：:\s]*\d+\s*(?:[—–\-～~]\s*\d+\s*)?(?:分钟|분|minutes?\b)/i.test(text)) return true
  const scenes = [...text.matchAll(NUMBERED_SCENE)]
  return scenes.length >= 5
}

export interface StoryboardShot {
  /** 짧은 제목(3~8자) */
  title: string
  /**
   * 영어로 상세한 화면을 5~8문장으로 서술한다.
   * 장면의 기준물과 조명, 인물 위치와 방향, 동작, 샷 크기와 카메라 움직임, 소품, 분위기를 포함한다.
   */
  visualPrompt: string
  /** 영어로 인물의 동작과 대사 표기, 카메라 움직임을 서술한다. visualPrompt와 구별한다. */
  videoPrompt?: string
  /** 효과음을 한국어로 간단히 설명한다. */
  audioDescription: string
  /** 내레이션 또는 대사 원문 */
  voiceover: string
  audioMode?: ShotAudioMode
  speakerHint?: string
  /**
   * 이 샷의 화자 음색을 캐릭터 노드의 voicePrompt에서 연결한다.
   * 영상 생성과 후반 더빙에 동일한 음색을 전달한다.
   */
  speakerVoice?: string
  /** 샷 길이(초, 5~10) */
  duration: number
  /** 카메라 움직임 */
  cameraMovement: Shot['cameraMovement']
  /** 이 샷에 등장하는 피사체 ID(subjects[].id 참조) */
  subjectIds?: string[]
  /** 이 샷의 장면 ID(scenes[].id 참조) */
  sceneId?: string
  purpose?: string
  shotSize?: string
  blocking?: string
  eyeline?: string
  continuity?: string
  propFocus?: string
}

export interface StoryboardResult {
  /** 프로젝트 전체 분위기(한국어 1~2문단) */
  aesthetic?: string
  h3Aesthetic?: string
  styleBrief?: string
  colorPalette?: string
  lightingNote?: string
  /** 전체 영상에서 외형을 유지할 인물과 동물. 캐릭터 설정 이미지를 먼저 만든다. */
  subjects?: Subject[]
  /** 대본에 두 번 이상 등장하는 소품. 다각도 이미지를 생성한다. */
  props?: StoryProp[]
  /** 전체 영상에 공통으로 사용할 장면 기준 이미지 */
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
 * 주제와 원고에서 사용자가 직접 쓴 화면 스타일과 미학 지시를 찾는다. 이 지시가 우선한다.
 * 주제 전체와 원고의 도입, 화면 스타일이 언급된 문장을 보존한다.
 */
export function extractUserStyleAuthority(
  topic: string,
  content: string,
  keywords?: string[]
): string {
  const parts: string[] = []
  const t = topic.trim()
  // 사용자가 주제에 화면 스타일을 적을 수 있으므로 전체를 보존한다.
  if (t) parts.push(t)

  const styleCue =
    /风格|画风|美学|视觉|调色|氛围|质感|电影|动画|动漫|二次元|写实|摄影|渲染|油画|水彩|像素|水墨|赛博|蒸汽|复古|胶片|手绘|插画|国风|武侠|奇幻|暗黑|明亮|赛璐璐|厚涂|扁平|3d|C4D|Blender|真人|纪实|灯笼|汉服|商业|广告|grain|cinematic|anime|wuxia|hanfu|aesthetic|lighting|mist|commercial/i

  const contentLines = content
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)

  // 원고 첫 두 줄에 스타일과 설정이 있을 수 있어 우선 추가한다.
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
  if (kws.length) parts.push(`Keywords: ${kws.join('、')}`)

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

Use the dropdown medium (current selection: ${VISUAL_STYLE_GUIDE[input.style].medium} / ${input.style}):
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

/** 로컬에서 복구할 수 없으면 모델로 JSON 문법만 복구한 후 품질을 검수한다. */
async function parseJsonWithModelRepair(
  content: string,
  input: Pick<StoryboardInput, 'signal' | 'model'>,
  label: string
): Promise<any> {
  try {
    return robustParseJson(content)
  } catch (parseError) {
    log(`⚠ ${label} JSON 문법에 오류가 있어 구조를 복구하고 있어요. ${(parseError as Error).message.split('\n')[0]}`)
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
      log(`⚠ ${label} 구조 복구 요청에 실패했어요. ${(llmError as Error).message}`)
    }
    if (repairedContent.trim()) {
      try {
        return robustParseJson(repairedContent)
      } catch (repairError) {
        log(`⚠ ${label} 복구한 응답을 해석하지 못했어요. ${(repairError as Error).message.split('\n')[0]}`)
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
          content: `Original user request\n${input.topic}\n${input.content}\n\nStoryboard to check\n${JSON.stringify(compact)}`
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
    log(`⚠ 이야기 연결을 검수하지 못했어요. 구조 검사 결과를 유지해요. ${(error as Error).message}`)
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
    log(`⚠ 이야기 연결 검수를 통과하지 못했어요. ${round + 1}/2：${issues.join('；')}`)
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
  const issues = [...structural, ...narrative.map((issue) => `Narrative continuity: ${issue}`)].slice(0, 16)
  if (!issues.length) return parsed

  onProgress?.('개선할 항목을 모아 한 번 수정한 뒤 초안을 제공하는 중…')
  try {
    const repaired = await repairStoryboardOnce(parsed, input, model, issues)
    const remaining = storyboardQualityIssues(repaired, input)
    if (remaining.length) {
      log(`⚠ 수정본에 처리할 문제가 있어요. 현재 편집 가능한 초안을 사용해요. ${remaining.join('；')}`)
      onProgress?.(`편집 가능한 스토리보드를 생성했습니다. 캔버스에서 ${remaining.length}개 항목을 더 조정할 수 있습니다.`)
    }
    return repaired.shots.length ? repaired : parsed
  } catch (error) {
    log(`⚠ 수정 사항을 합치지 못해 초안을 사용해요. ${(error as Error).message}`)
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
      ? 'The input is a complete screenplay. Correct only the extraction. Do not change the meaning of narration or invent a new story. Record every ### entry in the Characters section. Include forms of address such as “older brother” in the existing character’s name, role, or description. Create separate records for characters listed separately. Show deceased characters through belongings, portraits, or flashbacks. Give each living antagonist a shot showing confrontation or visible pressure. Feature every recorded character in at least one shot in person, through belongings, in a portrait, or by showing the pressure they exert. Link the character through subjectIds and use their name in visualPrompt and videoPrompt. Do not omit the father, older brother, or counterpart just because they do not occupy the center of the frame. Make a character card for each and do not turn them into a passerby or “some man” in the storyboard.'
      : 'Create an individual subjects record for every character. Do not compress them into a single “protagonist.”'
  const repairTargetSec =
    Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  const repairShotCap = shotBudgetFromDuration(repairTargetSec, input.maxShotDuration)
  const durationBlock = repairTargetSec
    ? `\n[Required final duration] The user requests ${repairTargetSec} seconds. Accept only ${repairTargetSec - DURATION_TOLERANCE_SEC}–${repairTargetSec + DURATION_TOLERANCE_SEC} seconds. Do not exceed ${repairShotCap} shots. If needed, combine adjacent shots in the same location with the same cast and use camera movement and blocking rather than cuts. Keep key events. Each duration must be ${MIN_SHOT_SEC}–${shotDurationLimit(input)} seconds, with a total in the requested range.`
    : ''
  const repair = await callLLM({
    messages: [
      {
        role: 'system',
          content: `${importedDirectorPrefix()}You are the supervising editor for the short film. The previous JSON failed review. Re-extract it and fix all listed issues before returning it.${durationBlock} Do not add products, characters, numbers, or facts the user did not mention. Restore only processes already shown or clearly implied within this request. Do not write consequences beyond its boundary.\n${extractHint}\n${NARRATIVE_CONTINUITY_RULES}\n${SPEAKER_STAGING_RULES}\nWhen a major event has been compressed away or adjacent shots do not connect, split, insert, or reorder shots near the gap to show the missing process and reactions within the episode. Keep unrelated shots and the user's suspenseful stopping point. Each added shot needs continuity in the form of a specific preceding ending → visible change → specific state for the next shot.\nUse a distinct 3–8-character title per shot, never a generic "Shot". Divide original text by meaning across voiceover. Default to h3-dialogue and use h3-voiceover only for explicit narration. Keep 2–4 consecutive short lines of one intent together in a 7–10-second shot where possible. Reserve a single line for short reactions or transitions. Do not exceed duration*4 characters. Use "Character name: line" for speaker identification; H3 removes the prefix.\nChoose framing based on action, spatial relations, setting, and emotion. Use close framing when the expression matters and the environment can be omitted. Use medium or group framing for handoffs, arguments, questions and answers, interpersonal distance, environmental pressure, or group reactions. Do not make every speaker a close-up; identify the one speaker and others' reactions.\nWrite user-facing titles, descriptions, and newly authored dialogue in Korean (한국어). Write visualPrompt, videoPrompt, and h3Aesthetic in English for generation. Preserve supplied lines and explicitly requested Korean on-screen text. Make visualPrompt a visible still frame with setting, clothing, and light, and keep it distinct from videoPrompt. h3Aesthetic covers material, lighting, color, and cinematography, without tag lists.\n${videoPerformanceSpec(getVideoPromptStyle())}\nReturn one complete, valid JSON object.`
      },
      {
        role: 'user',
        content: `User source or script\n${input.content}\n\nTopic: ${input.topic || '(unspecified)'}\n\nIssues to fix (all required)\n- ${issues.join('\n- ')}\n\nJSON to repair\n${JSON.stringify(parsed)}`
      }
    ],
    model,
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 14000,
    signal: input.signal,
    timeoutMs: 75_000
  })
  return normalizeStoryboard(await parseJsonWithModelRepair(repair.content, input, '품질 검수 수정본'), {
    style: input.style,
    topic: input.topic,
    content: input.content,
    keywords: input.keywords,
    maxShotDuration: input.maxShotDuration
  })
}

/** 검수를 통과하지 못하면 워크플로를 멈추기 전에 추출을 다시 요청한다. */
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
    const severe = issues.filter((issue) => /^(?:Critical:|심각:)/.test(issue))
    if (round > 0 && !severe.length) {
      log(`⚠ 검토할 문제가 있어요. 현재 초안을 사용해요. ${issues.join('；')}`)
      return current
    }
    if (round === QUALITY_REPAIR_ROUNDS) {
      throw new Error(
        `${QUALITY_REPAIR_ROUNDS}차례 재추출했지만 대본 품질 검수를 통과하지 못했습니다. ${issues.join('；')}`
      )
    }
    const n = round + 1
    log(`⚠ 품질 검수를 통과하지 못해 다시 추출해요. ${n}/${QUALITY_REPAIR_ROUNDS}：${issues.join('；')}`)
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
        label: chunk.length > 1 ? `${chunk[0].label} 이후` : chunk[0].label,
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
      { label: `${item.label} · 앞부분`, excerpt: left },
      { label: `${item.label} · 뒷부분`, excerpt: right }
    )
  }
  return out
}

/**
 * 대본 전체를 한 모델에 맡기기 전에 장면과 전개 단락을 기준으로 작업 그룹을 나눈다.
 * 그룹당 샷은 1~3개이며 호출자가 동시 처리 그룹을 세 개로 제한한다.
 *
 * targetBatches가 있으면 최종 영상 길이에 맞춰 해당 그룹 수를 목표로 삼는다.
 * 장면 수에 따라 지나치게 많은 그룹이 생기지 않도록 필요에 따라 병합하거나 분할한다.
 * 값이 없으면 기존의 1,100자 및 네 단락 기준을 사용한다.
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

  let sections = scenes.length ? scenes : [{ title: '전체 줄거리', text: normalized }]

  // 장면이 목표 그룹 수보다 많으면 인접한 장면을 먼저 병합한다.
  // 병합하지 않으면 긴 대본의 그룹 수가 목표보다 많아진다.
  const wanted0 = Math.floor(Number(targetBatches) || 0)
  if (wanted0 > 0 && sections.length > wanted0) {
    const per = Math.ceil(sections.length / wanted0)
    const merged: Array<{ title: string; text: string }> = []
    for (let i = 0; i < sections.length; i += per) {
      const chunk = sections.slice(i, i + per)
      merged.push({
        title: chunk.length > 1 ? `${chunk[0].title} 외 ${chunk.length - 1}개 장면` : chunk[0].title,
        text: chunk.map((s) => s.text).join('\n\n')
      })
    }
    sections = merged
  }

  // 기본 기준은 1,100자 또는 네 단락이다. 목표 그룹 수가 있으면 본문 길이를 균등하게 나눈다.
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
        label: paragraphs.length > 1 ? `${section.title} · ${part++}부` : section.title,
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
  return `[Imported script: break down without rewriting] This is the user's complete script. Do not polish, rephrase, extend, or alter lines. Do not turn dialogue into narration or narration into dialogue. Copy the original spoken words verbatim into voiceover. Use only specified people, actions, and locations in visualPrompt and videoPrompt. Do not add events, props, reactions, or outcomes. Preserve shot order from the script.\n`
}

async function generateShotWorkBatch(
  input: StoryboardInput,
  model: string,
  batch: ShotWorkBatch,
  subjectNames: string[],
  sceneNames: string[],
  directives: string,
  retry = false,
  /** 전체 샷 예산에서 이 그룹에 배정한 샷 수. 없으면 1~3개를 적용한다. */
  shotBudget?: number,
  /** 모델이 넘을 수 없는 전체 영상의 샷 한도 */
  totalShotBudget?: number,
  targetDurationSec?: number,
  /** 이 그룹의 모든 샷 길이 합계 상한(초) */
  durationCap?: number
): Promise<{ shots: Record<string, unknown>[]; model?: string }> {
  const limit = Math.max(
    1,
    Math.min(SHOTS_PER_BATCH, Math.round(Number(shotBudget) || SHOTS_PER_BATCH))
  )
  const budgetLine =
    totalShotBudget && totalShotBudget > 0
      ? `\n[Shot and duration limits] Target ${targetDurationSec || '?'} seconds with tolerance ±${DURATION_TOLERANCE_SEC} seconds. The full film has ${totalShotBudget} work groups. This group contains exactly ${limit} shots and must add to ${durationCap || targetDurationSec || '?'} seconds. Fit action and dialogue into those shots using movement and blocking. Do not split the group further.`
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
      /* 일반 대화 모델이 반환한 자연어 스토리보드도 처리한다. */
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
      // 일부 호환 API가 동시 JSON 형식 요청에서 시간 초과될 수 있다.
      // 프롬프트는 JSON을 우선 요청하고 파서는 일반 텍스트도 받는다.
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
    log(`⚠ 스토리보드 작업 그룹 ${batch.index + 1}${retry ? ' 단독 재시도' : ' 첫 동시 실행'} 실패. ${(error as Error).message.split('\n')[0]}`)
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

/** 샷 번호, 제목, 샷 크기, 화면, 길이와 소리 표식을 기준으로 나눈다. */
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
    `Shot ${index + 1}：${outline.title}${size}`,
    `Visual: ${outline.visualPrompt}`,
    `Duration: ${outline.duration || 6} seconds`,
    `Sound: ${outline.audioDescription || 'Ambient sound on location'}`
  ]
  if (outline.videoPrompt) lines.push(`Action: ${outline.videoPrompt}`)
  if (outline.omitNote) lines.push(`Omit: ${outline.omitNote}`)
  if (outline.voiceover) lines.push(`Dialogue: ${outline.voiceover}`)
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
      ? '대본에 맞춰 스토리보드의 동작, 대사, 촬영 제외 항목을 정리하고 있어요…'
      : '대본을 바탕으로 스토리보드의 화면, 길이, 소리를 먼저 정리하고 있어요…'
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
        content: `Existing characters: ${subjectNames.join(', ') || '(none)'}
Existing locations: ${sceneNames.join(', ') || '(none)'}
Shot duration. The current model allows up to ${shotDurationLimit(input)} seconds. ${film ? `Plan by scene action within 5–${shotDurationLimit(input)} seconds` : `Use ${input.shotDuration} seconds as a reference within 3–${shotDurationLimit(input)} seconds`}。Keep uninterrupted action in one shot when it fits.

${directives ? `Chapter requirements:\n${directives}\n` : ''}전체 대본
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
      if (outlines.length) log('⚠ 현장 기록을 JSON으로 읽었어요.')
    } catch {
      /* 아래에서 빈 스토리보드 오류를 공통 처리한다. */
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
Return one JSON object only. {"title":"3–8 character title","purpose":"도입/설명/반응/공개/전환/마무리","shotSize":"Framing","blocking":"Each person's foreground or background position, orientation, and relation to others","eyeline":"What or whom each person looks at; keep eyes off the lens","continuity":"Previous shot ending → Current visible change → Next shot opening","propFocus":"Prop or none","visualPrompt":"English still frame description","videoPrompt":"Filmable timeline in English, split into 2–5 beats from the opening to the end. Include action, expression, speaker and verbatim lines, positions and reactions, camera movement and endpoint, and synchronized sound","audioDescription":"Actual scene sound","voiceover":"Character name: original line, or empty","audioMode":"h3-dialogue|h3-voiceover|tts|none","speakerHint":"Voice and emotion","duration":6,"cameraMovement":"push|pull|pan|tilt|static|orbit","subjectNames":["Short name"],"sceneName":"Original place name"}`
        },
        {
          role: 'user',
          content: `Existing characters: ${subjectNames.join(', ') || '(none)'}
Existing locations: ${sceneNames.join(', ') || '(none)'}
${prev ? `Previous shot: ${formatOutlineNote(prev, index - 1)}` : 'Previous shot: none (opening)'}

Current shot notes
${formatOutlineNote(outline, index)}

${next ? `Next shot: ${formatOutlineNote(next, index + 1)}` : 'Next shot: none (ending)'}
${extras?.directives ? `\nChapter constraints:\n${extras.directives}` : ''}
${extras?.sceneSlice ? `\nOriginal scene text:\n${extras.sceneSlice}` : ''}
Expand this shot only.`
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
      omit && videoPrompt && !videoPrompt.includes(omit) ? `${videoPrompt} Omit: ${omit}.` : videoPrompt
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
    log(`⚠ 샷 ${index + 1}의 노드를 확장하지 못해 스토리보드 초안을 저장해요. ${(error as Error).message.split('\n')[0]}`)
    return outlineToRawShot(outline)
  }
}

/** 실제 언어 모델 호출 */
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
    log(`→ 비전 도구로 참조 이미지 ${input.productImages.length}장을 분석해요.`)
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
  const styleGuide = VISUAL_STYLE_GUIDE[look.style]
  const presetMedium = styleGuide.medium
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
    const common = `Topic: ${input.topic || '(unspecified)'}\nAspect ratio: ${input.aspectRatio}\nSuggested shot duration: ${input.shotDuration} seconds\n\nFull screenplay\n${play}`
    const startAt = input.extractStartAt || 'subjects'
    const stopAfter = input.extractStopAfter || startAt
    const stageOrder = { subjects: 0, scenes: 1, shots: 2 } as const
    onProgress?.(
      `Extract in order: characters, locations, then shots. This step handles only ${startAt === 'subjects' ? 'characters' : startAt === 'scenes' ? 'locations' : 'shots'}。`
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
        log(`⚠ ${label} 추출에 실패했어요. ${message}`)
        throw new Error(`${label} 추출에 실패했습니다. 이미 완료된 노드는 저장됐습니다. 이 단계만 다시 시도할 수 있습니다. ${message}`)
      }
    }

    // 캐릭터 프로필은 한국어, 생성 모델용 음색 지시는 영어로 요청한다.
    const subjectSystem = `You extract character records. Use every independent subsection under "## 캐릭터" (or the equivalent heading in an imported script) and any people, animals, products, or key subjects that appear, are seen through a keepsake or portrait, or exert visible pressure. Do not extract locations, shots, asset images, or prop lists. Include deceased parents and absent opponents when their ### records exist. Preserve names from the script. If someone has both a name and a role, put the most-used short name in name and the full identity and aliases in role for matching. Describe age, face shape, hair, build, wardrobe, shoes, accessories, and stable visual features. Do not only label someone the protagonist. Keep description focused on identity and appearance, with no place or weather. Character sheets will use four views on seamless white. In stateVariants, identify wardrobe wetness, stains, hunger, limping, or held food that changes; use "none" when nothing changes. Write user-facing character descriptions and roles in Korean (한국어).
${productNote}
Write one voicePrompt in English for every person, covering age and gender, timbre (raspy, bright, slow, nasal, or similar), speed and intensity, emotional tone, and an appropriate accent or speaking habit. Use one consistent voice in the entire film. For animal and other, use an empty string.
Output JSON only: {"subjects":[{"name":"Short name","kind":"person|animal|other","description":"Specific physical identity, excluding location","role":"Identity, dramatic function, and aliases","stateVariants":"Changes in this episode, or none","voicePrompt":"English vocal qualities and delivery, empty for non-person subjects","fromReference":false}]}. Before returning, verify a record for every ###, separate people who speak, act, or are seen, and a voicePrompt for every person.`

    // 촬영 장소만 추출하고 장면 설명과 생성용 스타일의 언어를 지정한다.
    const sceneSystem = `You extract locations and visual settings. Include only places actually filmed in this episode. Do not write characters or shots.
Prefer locations under "## 환경과 장면" or its equivalent in an imported script, then scene lines such as "실내｜장소｜날씨". Deduplicate places; do not create a new record for every scene.
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
            'Props',
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
        log(`✓ 대본에서 캐릭터 ${playPeople.length}명을 바로 추출했어요.`)
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
          ? `✓ 캐릭터 ${normalized.subjects?.length || 0}명과 반복 등장 소품 ${props.length}개를 저장했어요.`
          : `✓ 캐릭터 ${normalized.subjects?.length || 0}명을 저장했어요.`
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
        log(`✓ 대본에서 장소 ${playScenes.length}곳을 바로 추출했어요.`)
        onProgress?.(`대본에 장소가 있어 장면 ${playScenes.length}개를 바로 저장했습니다.`)
        scenePart = { raw: { scenes: playScenes }, model: parallelModel }
      } else {
        const sceneUser = `Topic: ${input.topic || '(unspecified)'}
Aspect ratio: ${input.aspectRatio}

Extract locations only from the supplied locations and scene excerpts. Do not invent places. Record each place once.
${extractPlayForSceneStage(play)}`
        try {
          scenePart = await runPart(
            'Locations',
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
      if (!rows.length) throw new Error('장면을 추출하지 못했어요. 대본에 ‘환경과 장면’이나 ‘실내｜장소’가 없고 모델 응답에도 장소가 없어요. 캐릭터 노드는 저장했어요.')
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
    // 목표 길이를 모델의 샷당 상한으로 나눈다. 목표 30초와 상한 15초면 15초씩 두 그룹이다.
    const targetDurationSec =
      Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
    const maxShotSec = shotDurationLimit(input)
    const slices = durationSlices(targetDurationSec, maxShotSec)
    const totalShotBudget = slices.length
    const workBatches = buildShotWorkBatches(play, totalShotBudget || undefined)
    if (!workBatches.length) throw new Error('대본 본문이 비어 있어 샷을 나눌 수 없습니다.')
    onProgress?.(
      slices.length
        ? `목표 길이 ${targetDurationSec}초, 샷당 최대 ${maxShotSec}초 → 작업 그룹 ${workBatches.length}개(${slices.join(' + ')}초)`
        : `${workBatches.length}개 그룹으로 나눴어요. 그룹당 최대 ${SHOTS_PER_BATCH}개 샷을 배정해 ${Math.min(SHOT_BATCH_CONCURRENCY, workBatches.length)}개 그룹을 동시에 처리해요…`
    )
    const directives = extractPlayDirectives(play)
    const batchShots: Array<Record<string, unknown>[] | undefined> = new Array(workBatches.length)
    const batchModels: Array<string | undefined> = new Array(workBatches.length)
    // 길이를 배정한 경우 그룹당 샷 하나를 만들고 해당 그룹의 길이를 사용한다.
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
        // 재시도에서는 이전에 완료한 작업 그룹 결과를 재사용해 토큰을 절약한다.
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
    // 모델이 샷 한도를 넘으면 목표 길이를 지키기 위해 초과분을 잘라낸다.
    if (totalShotBudget && rawShots.length > totalShotBudget) {
      onProgress?.(
        `⚠ 모델이 반환한 샷 ${rawShots.length}개가 목표 ${targetDurationSec}초의 한도(${totalShotBudget}개)를 초과해 대본 순서대로 처음 ${totalShotBudget}개를 유지해요.`
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
          description: `${name}의 외모와 의상 세부 정보는 캔버스에서 추가할 수 있어요.`,
          role: '스토리보드의 대사와 동작에서 확인한 등장인물',
          stateVariants: 'none'
        }))
      )
    }
    if (!sceneRows.length) {
      const names = [...new Set(rawShots.map((shot) => String(shot?.sceneName || '').trim()).filter(Boolean))]
      sceneRows.push(
        ...names.slice(0, 8).map((name) => ({
          name,
          description: `${name}의 공간 구조, 지면 재질, 주요 기준물과 조명은 캔버스에서 추가할 수 있어요.`,
          mainAnchor: '장면 중심의 주요 기준물',
          anchors: '전경, 주요 기준물, 인물 위치, 광원',
          lighting: '이 장면의 전개에 맞는 주 광원'
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
      log(`⚠ 동시 추출을 마쳤어요. 편집 가능한 초안을 유지했고 확인할 항목은 ${warnings.length}개예요. ${warnings.join('；')}`)
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
    ? `\n[Shot and duration limits] The requested final duration is ${budgetSec} seconds, with a ${shotDurationLimit(input)}-second maximum per shot and ${budgetShots} shots total. Total duration must be within ${budgetSec - DURATION_TOLERANCE_SEC}–${budgetSec + DURATION_TOLERANCE_SEC} seconds.`
    : ''

  const userText = extractMode
    ? `${verbatimSplitRule(input.verbatim)}The following script is complete. Extract the canvas node JSON (subjects / scenes / shots) faithfully. Do not rewrite or invent a new story.${budgetLine}

전체 대본
"""
${input.content?.trim() || '(empty)'}
"""

Topic: ${input.topic || '(unspecified)'}
${input.keywords?.length ? `Keywords: ${input.keywords.join('、')}` : ''}
Aspect ratio: ${input.aspectRatio}
Suggested duration: about ${input.shotDuration} seconds per shot. Follow the screenplay beats and vary shot lengths naturally.

${stylePriority}
${productNote}

Match every character, location, and scene to the script. Copy original dialogue into voiceover as “Character name: line.” Do not replace lines with older-character narration or silence. Keep 2–4 consecutive short lines by one character with the same intent in a shot when possible. Write the visible still in English as visualPrompt. Write videoPrompt in English from zero through the ending in 2–5 actual beats. For each beat describe the starting state, perception, action, speaker and original words, others’ blocking and reactions, emotional changes, and camera motion and endpoint. Avoid equal divisions and generic expressions. Frame speaking from action, spacing, and emotion: use close framing for an important expression and medium or group framing for relationships and surroundings. Do not repeat visualPrompt. Write titles and user-facing descriptions in Korean (한국어). Return JSON directly.`
    : `Use the screenwriting guide to break the brief into filmable shots. Write speakable narration in Korean (한국어). Write model-facing imagery in clear natural English, without disconnected prompt keywords.${budgetLine}

Preserve the source facts. Do not add prices, specifications, efficacy, relationships, brand promises, or plot outcomes absent from the source. Keep numbers and proper nouns verbatim. Use visible action to bridge missing detail instead of inventing facts.

원고 주제
"""
${input.topic || '(not provided)'}
"""

원고 내용
"""
${input.content?.trim() || '（본문 없음. 참조 이미지가 있다면 이미지에 맞춰 내레이션과 샷을 작성）'}
"""
${input.keywords?.length ? `Keywords: ${input.keywords.join('、')}` : ''}

Aspect ratio: ${input.aspectRatio}
Suggested pacing: about ${input.shotDuration} seconds per shot. Vary shot lengths.

${stylePriority}
${productNote}

Establish characters and locations before shot breakdown. Write visualPrompt as a visible still and videoPrompt as the performance for the current shot. Do not repeat the still prompt in the video prompt.
${
  hasUserStyle
    ? `Mention “${mediumPhrase}” once and express it through tangible details such as the bridge, water, and clothing. Avoid a style-only opening, a generic technique paragraph at the end, or a blocking-only summary such as “two people clasp their hands in greeting.”`
    : `If the topic gives no style, apply “${presetMedium}” and describe tangible surroundings and motion.`
}
Return JSON only without explanation.`

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
      "stateVariants": "<Wardrobe changes, or none if unchanged>",
      "voicePrompt": "<One English sentence of about 15–35 words for dubbing direction, covering age and gender, timbre, pace and intensity, emotional tone, accent or speech habits. Empty for animal or other>",
      "props": "<Items worn or carried, such as bag, ID, tablet, shoes, or hat. Use none if no items are present>",
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
      "purpose": "도입/설명/반응/공개/마무리",
      "shotSize": "<Framing and reason for it>",
      "blocking": "<Foreground and background position, what each person stands on, and body orientation. The speaker may be behind others. Avoid frontal lineups>",
      "eyeline": "<Eyeline per person. Foreground people look back or sideways toward the speaker or indicated object, away from the camera>",
      "continuity": "<Previous concrete ending or opening state for the first shot → current visible change → specific state for the next shot. State position, pose, orientation, held items, emotion, and knowledge>",
      "propFocus": "<Prop to show clearly and its current state, or none>",
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

Visual style: express the user's wording through physical objects, without a separate style paragraph. Only use the dropdown value when the topic does not specify a style: "${presetMedium}".
Reject visualPrompt if it only lists positions, omits physical surroundings, or opens or ends with generic style language.
Reject videoPrompt if it omits any duration from zero to the end, lacks actions and speakers at actual beats, or fills equal time slots with generic language.
${hasUserStyle && !look.matched ? 'Use the custom visual style in place of the preset selected on the page.' : `${styleGuide.avoid}`}
Use H3 on-screen dialogue by default. Divide the original words into meaningful paragraphs for voiceover and set audioMode=h3-dialogue. Avoid one line per shot. The current model accepts at most ${shotDurationLimit(input)} seconds per shot. For a shared place, person, intention, or continuous action, prefer one complete 7–${shotDurationLimit(input)}-second shot when it fits. Do not force two 5-second shots to fill a template. Cut only when focus, time, place, axis, or dramatic purpose changes. Reserve a single line for brief reactions or transitions and allow about four characters per second. Use "Character name: dialogue" in voiceover and specify the speaker and vocal quality in speakerHint.
Follow action, spacing, and emotion when choosing framing. Use close framing when the expression matters and no surroundings are needed; use medium, two-person, or group framing for handoffs, arguments, exchanges, distance, environmental pressure, or group reactions. Do not force close-ups; name who speaks and others' reactions so mouths do not open together.
Use h3-voiceover only for explicit off-screen narration, tts for requested dubbing in postproduction, and none for a silent empty shot. Create a separate subject for each ### under characters. If a form of address such as “older brother” refers to an existing character, record it in name, role, or description. Include every character in at least one shot, link them through subjectIds, and name them in visualPrompt and videoPrompt. Keep the father, older brother, and antagonist even if they never occupy the center of the frame. Create a character card for each and do not replace them in shots with a passerby or “a man.” Show a deceased character's keepsake, portrait, or flashback in at least one shot, and a living opponent's confrontation or visible pressure in at least one shot. Give every shot its own specific 3–8-character Korean title. Verify adjacent continuity and apply the narrative rules to major changes instead of jumping from a result to explanatory speech.
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
    `→ 기본 언어 모델 호출 ${baseUrl}/chat/completions (model: ${model})`
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

  log(`← 응답 수신(${resp.content.length}자)`)
  if (resp.content.includes('<think>') || resp.content.includes('<reasoning>')) {
    log('⚠ 응답에 포함된 추론 태그를 제거하고 해석해요.')
  }

  let parsed = normalizeStoryboard(await parseJsonWithModelRepair(resp.content, input, '대본 초안'), {
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
    `✓ 캐릭터 ${parsed.subjects?.length ?? 0}명, 장면 ${parsed.scenes?.length ?? 0}개, 스토리보드 샷 ${parsed.shots.length}개를 읽었어요.`
  )
  const durSummary = parsed.shots.map((s) => s.duration).join('+')
  const totalDur = parsed.shots.reduce((sum, s) => sum + s.duration, 0)
  log(`⏱ 샷별 길이 ${durSummary} = ${totalDur}s`)
  return { result: parsed, model: resp.model ?? model }
}

function asKind(v: unknown): Subject['kind'] {
  return v === 'animal' || v === 'other' || v === 'person' ? v : 'person'
}

/**
 * 캐릭터 음색 설명을 정규화한다. 인물이 아닌 피사체의 음색은 비운다.
 * 인물의 음색 설명이 없으면 기본 설명을 채워 샷 간 음색을 유지한다.
 */
function normalizeVoicePrompt(v: unknown, kind: Subject['kind']): string | undefined {
  if (kind !== 'person') return undefined
  const text = String(v || '').trim()
  return text || FALLBACK_VOICE_PROMPT
}

/** 모델이 voicePrompt를 빠뜨리면 기본 음색 설명으로 샷 간 음색 차이를 줄인다. */
export const FALLBACK_VOICE_PROMPT =
  'Natural conversational delivery at a moderate pace with steady breath. Match the emotion to the scene and avoid an announcer cadence.'

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

/** 대사에서 이름을 찾아 캐릭터 카드에 연결한다. 정확히 일치하지 않으면 포함 관계를 확인한다. */
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
 * 캐릭터 노드의 음색을 스토리보드에 연결한다.
 * 샷의 대사에 등장하는 화자를 찾아 Subject.voicePrompt를 Shot.speakerVoice에 저장한다.
 * 영상 생성과 후반 더빙에서 같은 음색을 사용한다.
 * 음색을 연결한 샷 수를 반환한다.
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
    // 대사가 없는 샷에는 화자의 음색을 지정하지 않는다.
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

/** 샷 수가 길이 제한을 넘으면 인접한 샷을 합치고 ±10초 범위에 맞춘다. 불가능하면 null을 반환한다. */
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
 * 최종 영상 길이를 검사하고 범위를 벗어나면 다시 나눈다. 모델로 해결하지 못하면 샷 길이를 직접 조정한다.
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
      if (round > 0) onProgress?.(`전체 ${total}초가 목표 ${target}초의 허용 오차 ±${DURATION_TOLERANCE_SEC}초 안에 들어요.`)
      return current
    }
    if (round === DURATION_REPAIR_ROUNDS) break
    onProgress?.(
      `현재 ${total}초가 목표 ${target}초의 허용 범위(${target - DURATION_TOLERANCE_SEC}–${target + DURATION_TOLERANCE_SEC}초)를 벗어나 다시 샷을 나누고 있어요(${round + 1}/${DURATION_REPAIR_ROUNDS})…`
    )
    try {
      current = await repairStoryboardOnce(current, { ...input, targetDurationSec: target }, model, [issue])
    } catch (error) {
      log(`⚠ 길이 보정 요청에 실패해 샷 길이를 직접 조정해요. ${(error as Error).message}`)
      break
    }
  }
  const fitted = fitShotsToDuration(current.shots, target, shotDurationLimit(input))
  if (!fitted) {
    const total = totalShotDuration(current.shots)
    throw new Error(
      `샷을 ${DURATION_REPAIR_ROUNDS}번 다시 나눴지만 전체 ${total}초가 목표 ${target}초의 허용 오차 ±${DURATION_TOLERANCE_SEC}초를 벗어나요.`
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
  if (!result.shots.length) issues.push('Critical: No storyboard shots were generated.')
  const targetSec = Number(input.targetDurationSec) || extractTargetDurationSec(input.topic, input.content)
  const shotCap = shotBudgetFromDuration(targetSec, input.maxShotDuration) || 12
  if (result.shots.length > shotCap) {
    issues.push(
      `${targetSec ? 'Critical: ' : ''}The storyboard has ${result.shots.length} shots, exceeding the limit of ${shotCap}${targetSec ? ` for ${targetSec} seconds` : ''}. Reduce the shot count for short-form pacing.`
    )
  }
  if (
    result.subjects?.length === 1 &&
    /^(?:主角|주인공|protagonist)$/i.test(result.subjects[0]?.name || '') &&
    (input.content || '').trim()
  ) {
    issues.push('Critical: The extraction returned only a generic protagonist. Extract the other characters named in the source.')
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
    issues.push(`Critical: The following source characters are missing from subjects: ${visibleRoles.join('、')}`)
  }
  const normalizedTitles = result.shots.map((shot) => shot.title.trim())
  if (
    normalizedTitles.some((title) => /^(?:镜头|샷|Shot)\s*\d*$/i.test(title)) ||
    new Set(normalizedTitles).size !== normalizedTitles.length
  ) {
    issues.push('Critical: Shot titles are missing or duplicated. Give every shot a specific title. Do not use the generic title “Shot.”')
  }
  const targetDuration = targetSec
  const totalDuration = result.shots.reduce((sum, shot) => sum + shot.duration, 0)
  const durationIssue = durationWindowIssue(totalDuration, targetDuration)
  if (durationIssue) issues.push(durationIssue)
  if (!result.h3Aesthetic || result.h3Aesthetic.length < 35) {
    issues.push('Provide an English aesthetic description suitable for H3.')
  }
  const people = (result.subjects ?? []).filter((s) => s.kind !== 'other')
  const voicedShots = result.shots.filter((shot) => (shot.voiceover || '').trim())
  const looksLikeAd = AD_COPY.test(`${input.topic || ''}\n${input.content || ''}`)
  if (
    !looksLikeAd &&
    people.length >= 2 &&
    result.shots.length >= 4 &&
    voicedShots.length < Math.max(3, Math.ceil(result.shots.length * 0.35))
  ) {
    issues.push('Add dialogue to shots with multiple characters. Write lines for calling names, questions and answers, recognition, confrontation, and persuasion. Do not put the entire backstory in the first shot’s adult narration.')
  }
  if (
    voicedShots.some((shot) => ADULT_NARRATOR.test(shot.voiceover)) &&
    voicedShots.filter((shot) => !ADULT_NARRATOR.test(shot.voiceover)).length < 2
  ) {
    issues.push('Restore on-screen dialogue instead of narration by an older version of a character. Let the visible characters speak and do not summarize the backstory in narration.')
  }
  if (
    totalDuration >= 25 &&
    voicedShots.length >= 3 &&
    voicedShots.every((shot) => spokenSentenceCount(shot.voiceover) <= 1)
  ) {
    issues.push('Dialogue is split mechanically into one line per shot. Combine 2–4 successive lines by the same speaker with the same intent into one 7–10-second shot. Reserve a single line for brief reactions.')
  }
  result.shots.forEach((shot, index) => {
    const label = `Shot ${index + 1}`
    const speakers = voiceoverSpeakerLabels(shot.voiceover || '')
    const speaker = speakers[0]
    if (shot.audioMode === 'h3-dialogue' && speaker) {
      const staging = [shot.shotSize, shot.blocking, shot.visualPrompt, shot.videoPrompt]
        .filter(Boolean)
        .join('\n')
      if (!staging.includes(speaker)) {
        issues.push(`${label} does not identify “${speaker}” as the on-screen speaker.`)
      }
    }
    if ((shot.visualPrompt || '').trim().length < 50) {
      issues.push(`${label} needs a longer, more concrete visual description for reliable generation.`)
    }
    const performance = (shot.videoPrompt || '').trim()
    const still = (shot.visualPrompt || '').trim()
    if (!performance || performance === still) {
      issues.push(`${label} lacks video direction. Describe who acts and speaks, what they do and say, and how the camera moves. Do not reuse the still-image description.`)
    } else {
      const names = (result.subjects || [])
        .filter((s) => (shot.subjectIds || []).includes(s.id) || performance.includes(s.name))
        .map((s) => s.name)
      const perfIssue = videoPerformanceIssue(performance, names)
      if (perfIssue) issues.push(`${label} ${perfIssue}`)
    }
    if (!shot.sceneId) issues.push(`${label} has no linked location.`)
    if (!shot.cameraMovement) issues.push(`${label} has no camera movement.`)
    const continuity = (shot.continuity || '').trim()
    const continuitySteps = (continuity.match(/→/g) || []).length
    if (continuity.length < 28 || continuitySteps < 2) {
      issues.push(`Critical: ${label} needs continuity specifying the previous shot’s ending → the visible change in this shot → the next shot’s ending.`)
    }
    const emptyPlate =
      !shot.voiceover.trim() && /空镜|空景|无人|빈 장면|인물 없음|사람이 없는|empty (?:shot|frame|scene)|no (?:people|characters)/i.test(`${shot.title}${shot.visualPrompt}`)
    if (people.length && !(shot.subjectIds ?? []).length && !emptyPlate) {
      issues.push(`Critical: ${label} has no linked characters, so the image generator cannot use their character sheets.`)
    }
  })
  const source = (input.content || '').trim()
  if (source.length > 0 && result.shots.every((shot) => !shot.voiceover.trim())) {
    issues.push('Critical: The user supplied a script, but all shots have empty narration and dialogue.')
  }
  for (const sub of people) {
    const used = result.shots.some(
      (shot) =>
        (shot.subjectIds ?? []).includes(sub.id) ||
        inferSubjectsFromText(shotCastText(shot as Shot), [sub]).length > 0
    )
    if (!used) issues.push(`Critical: Character “${sub.name}” has a profile but appears in no storyboard shot.`)
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
  const line = `Cast: ${chars.map((c) => c.name).join('、')}. Use only these characters. Match their faces, hairstyles, and clothing to the reference and add no bystanders.`
  if (/(?:出场[：:]|등장[：:]|\bCast:)/i.test(body) && chars.every((c) => body.includes(c.name))) return body
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

/** 모델의 캐릭터, 장면, 샷 연결에 안정적인 ID를 부여하고 짧은 프롬프트에 요청한 스타일을 반영한다. */
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

  /** 한 문장 이야기, 갈등 구조, 체격처럼 모델이 인물로 잘못 반환하는 항목을 제거한다. */
  const subjectRows = rawSubjects.filter((s: any) => {
    const n = String(s?.name || '').trim()
    return n && !isFieldLabelName(n)
  })
  const subjects: Subject[] = subjectRows.slice(0, 8).map((s: any, i: number) => ({
    id: `sub_${i + 1}`,
    name: String(s?.name || `캐릭터 ${i + 1}`).trim() || `캐릭터 ${i + 1}`,
    kind: asKind(s?.kind),
    description: String(s?.description || '').trim(),
    role: optStr(s?.role),
    stateVariants: /^单一状态$/.test(String(s?.stateVariants ?? '').trim()) ? 'none' : optStr(s?.stateVariants),
    voicePrompt: normalizeVoicePrompt(s?.voicePrompt, asKind(s?.kind)),
    fromReference: Boolean(s?.fromReference)
  }))

  const scenes: Scene[] = rawScenes.slice(0, 8).map((s: any, i: number) => ({
    id: `scn_${i + 1}`,
    name: String(s?.name || `장면 ${i + 1}`).trim() || `장면 ${i + 1}`,
    description: String(s?.description || '').trim(),
    mainAnchor: optStr(s?.mainAnchor),
    anchors: optStr(s?.anchors),
    lighting: optStr(s?.lighting)
  }))

  if (subjects.length === 0) {
    subjects.push({
      id: 'sub_1',
      name: '주인공',
      kind: 'person',
      description: '영상 전체에 같은 주인공이 등장하며 얼굴, 헤어스타일, 의상과 색상을 유지해요.',
      role: '주인공',
      stateVariants: 'none'
    })
  }
  if (scenes.length === 0) {
    scenes.push({
      id: 'scn_1',
      name: '주요 장면',
      description: '영상 전체에 같은 주요 장소가 나오며 조명과 건물 재질을 유지해요.',
      mainAnchor: '장면 중심의 주요 기준물',
      lighting: '원고의 감정에 어울리는 주 광원'
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

    // 매우 짧거나 스타일이 빠진 샷만 보완한다. 일반적인 기법 문구와 연출 양식은 화면 설명에 넣지 않는다.
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
  // 대사의 화자에 해당하는 캐릭터 카드에서 voicePrompt를 가져온다.
  // 영상 생성과 후반 더빙에 동일한 값을 전달한다.
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
        ? `요청한 화면 스타일을 적용해요. ${styleLockFromUser.split('\n')[0]}`
        : `${styleCn} 스타일의 단편 영상. 시선을 끈 뒤 사건을 분명하게 전달해요.`),
    colorPalette: optStr(raw?.colorPalette),
    lightingNote: optStr(raw?.lightingNote),
    subjects,
    scenes,
    shots: boundShots
  }
}

/** 화면 설명에 스타일이 없으면 이름을 언급한다. 화면 묘사 앞에 기법 설명을 쌓지 않는다. */
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
      ctx.sceneAnchor ? `Visible anchor: ${ctx.sceneAnchor}` : '',
      ctx.sceneLighting ? `Lighting: ${ctx.sceneLighting}` : '',
      ctx.blocking ? ctx.blocking : '',
      ctx.shotSize ? ctx.shotSize : '',
      ctx.propFocus && !isPlaceholderSpokenLine(ctx.propFocus) ? `In hand or nearby: ${ctx.propFocus}` : '',
      'Show whether the ground, water, or wind is moving and where the light comes from.'
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

/** 선택한 영상 모델의 상한을 따른다. 값이 없으면 대사 길이로 추정하고 샷별 길이를 달리한다. */
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
    log(`요청에 맞는 화면 스타일을 찾았어요. ${input.style} → ${look.matched}（${look.medium}）`)
  } else if (look.userNamed && !look.matched) {
    log(`요청한 화면 스타일을 적용해요. ${look.medium}`)
  }
  log(`현재 AI 모드 ${mode}`)

  if (mode === 'real') {
      onProgress?.(
        input.mode === 'extract'
          ? (input.extractStopAfter || input.extractStartAt) === 'scenes'
            ? '2단계에서 장면 기준물만 추출하고 있어요…'
            : (input.extractStopAfter || input.extractStartAt) === 'shots'
              ? '3단계 — 저장된 캐릭터와 장면을 바탕으로 스토리보드를 추출하는 중…'
              : '1단계 — 캐릭터를 추출하는 중…'
          : `「${look.medium}」 스타일로 촬영할 수 있는 샷을 나누고 있어요…`
      )
    try {
      const { result, model } = await realStoryboard(resolved, onProgress)
      onProgress?.(
        input.mode === 'extract' && !result.shots.length
          ? '✓ 현재 추출 단계를 완료하고 저장했습니다.'
          : `✓ ${result.shots.length}개의 편집 가능한 스토리보드 샷`
      )
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 언어 모델 호출에 실패했어요. ${msg}`)
      if (isAbortError(e) || isTimeoutAbort(e) || /^(?:대본 본문|스토리보드 초안|모든 스토리보드 작업|언어 모델에 연결|(?:캐릭터|장면|소품|Props|Locations)[을를]? (?:추출|JSON)|脚本|提炼|连不上|粗分镜)/i.test(msg)) throw e
      throw new Error(`대본 생성에 실패했습니다. ${msg}`, { cause: e })
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

/** 스토리보드 결과를 프로젝트의 Shot 배열로 변환한다. */
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
    // 스토리보드 생성 시 한 번만 초기화한다. 사용자가 삭제한 항목은 자동 복원하지 않는다.
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

/** 프로젝트 전체의 연출 정보를 Script에 반영한다. */
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
      gaps.push('The background is only a climax excerpt. Add a full synopsis with the opening, the antagonist, escalating obstacles, the decisive choice, and the ending.')
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
    const looksLikeAd = AD_COPY.test(t)
    if (!looksLikeAd && charCount > 0 && charCount < 3) {
      gaps.push('The character list is too thin. Beyond extras, include the lead, the antagonist, and key family or mentors. Profile the deceased father and living antagonist too. Do not reduce the screenplay to the two-person climax.')
    }
  }
  if (!/##\s*(?:环境与场景|환경과 장면|Environment and locations)/i.test(t) && !/##\s*场景\s*$/m.test(t)) {
    gaps.push('Environment and locations: describe spaces without people, the weather, and period details.')
  }
  const sceneCount = [...t.matchAll(NUMBERED_SCENE)].length
  if (sceneCount > 0 && !/场次任务|장면 과제|scene objective/i.test(t)) {
    gaps.push('Give each scene an objective, obstacle, and outcome.')
  }
  const tableHits = t.match(/\*\*(?:口播|내레이션|Narration)\*\*/gi)?.length || 0
  if (tableHits >= 3) gaps.push('Rewrite narration, visuals, and duration tables as continuous action and dialogue. Do not retain the table.')
  const looksLikeAd = AD_COPY.test(t)
  const quotes = t.match(/「[^」]{2,}」/g)?.length || 0
  const namedLines = t.match(/\*\*[^*：\n]{1,16}：\*\*/g)?.length || 0
  if (!looksLikeAd && sceneCount >= 3 && quotes + namedLines < Math.max(6, sceneCount)) {
    gaps.push('There is too little dialogue for a screen drama. Write speakable exchanges for recognition, calling a name, confrontation, persuasion, or questions and answers. Do not bury the backstory in one adult narrator line while the other scenes remain silent.')
  }
  if (t.split('\n').some((line) => ADULT_NARRATOR.test(line.split(/[：:]/, 1)[0]) && /[：:]/.test(line)) && quotes < 4) {
    gaps.push('Do not substitute narration from an older version of a character for on-screen dialogue. Let the characters in the scene speak for themselves.')
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
    log(`⚠ 대본에 설정 항목을 보완해요. ${gaps.join('；')}`)
    const repair = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You are a screenwriter. Fill the listed gaps in the draft's story engine, setting, or dialogue. You may add character profiles, the central conflict, scenes with the opponent or family, and speakable on-screen dialogue in the format **캐릭터 이름：**「대사 원문」. Preserve existing scenes that work. Restore omitted conflict and key people when the draft contains only a climax. Add spoken exchanges for recognition, confrontation, and questions or answers when the draft is silent. Do not merely add a name to the background or replace on-screen dialogue with older-character narration. Write the script and new lines in Korean (한국어).${PLAY_MARKDOWN_SPEC}\nReturn JSON only: {"playMarkdown":"..."}`
        },
        {
          role: 'user',
          content: `Required additions\n- ${gaps.join('\n- ')}\n\nUser requirements\n${input.topic}\n${input.content}\n\nScreenplay to complete\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.3,
      jsonMode: true,
      maxTokens: 24576,
      signal: input.signal,
      timeoutMs: PLAY_LLM_TIMEOUT_MS
    })
    const repaired = await parseJsonWithModelRepair(repair.content, input, '대본 설정 보완')
    const playMarkdown = String(repaired?.playMarkdown || '').trim()
    if (playMarkdown.length < draft.playMarkdown.length * 0.8) return draft
    return { ...draft, playMarkdown }
  } catch (error) {
    log(`⚠ 대본 설정을 보완하지 못해 초안을 유지해요. ${(error as Error).message}`)
    return draft
  }
}

function mockPlayFromBrief(input: StoryboardInput): PlayDraftResult {
  const topic = input.topic?.trim() || '숏폼 대본'
  const brief = input.content?.trim() || topic
  if (input.playMode === 'continue' && brief.length > 80) {
    const next = mergeContinuedPlay(
      brief,
      [
        `## 장면 ${playSceneHeadings(brief).length + 1}｜이후`,
        '',
        '**실외｜주요 장면｜이전 장면과 같은 날씨**',
        '',
        `이전 장면의 마지막 동작에서 이어진다. ${(input.continueHint || '이 일을 마무리한다.').slice(0, 80)}`,
        ''
      ].join('\n')
    )
    return {
      topic,
      playMarkdown: next,
      aesthetic: `「${topic}」을 중심으로 한 이야기`,
      styleBrief: '데모 모드에서 이어 쓴 대본'
    }
  }
  const playMarkdown = [
    `# ${topic}`,
    '',
    '> 장르: 드라마　시간: 원고 기준　장소: 원고 기준　권장 길이: 1분 이내',
    '',
    '## 이야기 배경',
    '',
    brief,
    '',
    '## 캐릭터',
    '',
    '### 주인공',
    '',
    '인물의 나이와 외모는 원고를 따른다. 이 구간에서 옷, 신발, 손에 든 물건을 같은 상태로 유지한다.',
    '',
    '## 환경과 장면',
    '',
    '### 주요 장면',
    '',
    '사람이 없는 상태의 지면, 건물, 빛, 날씨를 보여 준다. 시대를 드러내는 물건은 원고를 따른다.',
    '',
    '## 촬영 원칙',
    '',
    '사실적으로 찍고 감정을 과장하지 않는다. 인물은 장면 속 사람이나 물건을 보며 카메라를 바라보지 않는다.',
    '',
    '## 장면 1｜시작',
    '',
    '**실외｜주요 장면｜원고의 시간대**',
    '',
    '주요 장면에서 시작해 도입에 필요한 정보를 전달한다.',
    '',
    '## 장면 2｜마무리',
    '',
    '사건을 분명한 결말로 맺는다.',
    '',
    '## 챕터의 감정선',
    '',
    '도입부터 마무리까지 눈앞에서 벌어지는 사건에 따라 감정이 움직인다.',
    '',
    '## 영상과 소리의 기조',
    '',
    '자연광과 현장 환경음.',
    ''
  ].join('\n')
  return {
    topic,
    playMarkdown,
    aesthetic: `「${topic}」을 중심으로 한 이야기`,
    styleBrief: '데모 모드에서 작성한 전체 대본 초안'
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

    log(`⚠ 대본에서 이어지지 않는 부분을 찾아 다시 작성해요. ${issues.join('；')}`)
    const repair = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You are a screenwriter. Repair only the identified narrative discontinuities. Preserve user facts, character relationships, important dialogue, visual style, and scenes that already work.${NARRATIVE_CONTINUITY_RULES}\nAdd, split, or reorder nearby scenes as needed to give central events enough visible action and runtime. Do not skip an important process with a single narration line. Keep or complete the story background, characters, environments, and filming principles. Write the script and new dialogue in Korean (한국어), keeping existing important lines verbatim. Do not use a four-cell narration, image, and duration table. Return JSON only: {"playMarkdown":"..."}.`
        },
        {
          role: 'user',
          content: `사용자 요청\n${input.topic}\n${input.content}\n\nRequired fixes\n- ${issues.join('\n- ')}\n\nFull script to repair\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.25,
      jsonMode: true,
      maxTokens: 16384,
      signal: input.signal,
      timeoutMs: PLAY_LLM_TIMEOUT_MS
    })
    const repaired = await parseJsonWithModelRepair(repair.content, input, '대본 연결 수정')
    const playMarkdown = String(repaired?.playMarkdown || '').trim()
    if (playMarkdown.length < 80) return draft
    return { ...draft, playMarkdown }
  } catch (error) {
    log(`⚠ 대본의 이야기 연결을 검사하지 못해 초안을 유지해요. ${(error as Error).message}`)
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
 * 최종 영상의 목표 길이로 대본 규모를 제한한다.
 * 대본 분량은 이후 스토리보드 샷 수의 기준이 된다.
 */
function playScaleBrief(targetSec: number | undefined): string {
  const target = Number(targetSec) || 0
  if (target < 10) return ''
  const scenes = Math.max(2, Math.min(6, Math.round(target / 15)))
  const chars = Math.max(400, Math.round(target * 18))
  const lines = Math.max(4, Math.round(target / 5))
  return `The target video length is ${target} seconds. Size the screenplay to fit that target. The finished video must run between ${target - DURATION_TOLERANCE_SEC} and ${target + DURATION_TOLERANCE_SEC} seconds. For ${target} seconds, use at most ${scenes} scenes, ${chars} characters across the scene text excluding the character introductions and setting list, and ${lines} sentences of dialogue in total. Keep scenes compact and dense. Each extra scene makes the later storyboard run over its shot budget and lengthens the finished video.`
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
  log(`→ ${continueMode ? '대본 이어 쓰기' : '대본 작성'} LLM: ${model}`)
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
    topic: playMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || input.topic?.trim() || '숏폼 대본',
    playMarkdown
  }
  return { result, model: resp.model ?? model }
}

/** 첫 단계에서는 완성 대본 Markdown을 생성한다. 노드 추출은 별도 단계에서 한다. */
export async function generatePlay(
  input: StoryboardInput,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<PlayRunResult> {
  const mode = getAIMode()
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const resolved: StoryboardInput = { ...input, style: look.style, signal }
  log(`${input.playMode === 'continue' ? '대본 이어 쓰기' : '대본 작성'} · AI 모드 ${mode}`)

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
      if (isAbortError(e) || isTimeoutAbort(e) || /^(?:대본 작성|모델이 대본을|언어 모델에 연결|写剧本)/.test(msg)) throw e
      throw new Error(`대본 작성에 실패했습니다. ${msg}`, { cause: e })
    }
  }

  onProgress?.('🎭 데모 모드에서 대본을 작성합니다.')
  return { result: mockPlayFromBrief(resolved), source: 'mock' }
}

/** 추출할 수 있는 완성 대본이 있는지 확인한다. */
export function isPlayReady(script: Script | null | undefined): boolean {
  return Boolean(script?.playReady && script.content?.trim())
}
