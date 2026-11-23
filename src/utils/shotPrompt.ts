/**
 * 分镜提示词：配图用静帧画面，视频用「内容表现」（动作/台词/运镜）。
 * 二者不能混用。
 */

import type { Shot } from '@/types'

export const CAMERA_MOVEMENTS = ['push', 'pull', 'pan', 'tilt', 'static', 'orbit'] as const

/** 拆分镜模型常写出 handheld / 跟踪 等非法值；查表失败会让 H3 提示词编译崩掉。 */
export function normalizeCameraMovement(value: unknown): Shot['cameraMovement'] {
  const raw = String(value ?? '').trim().toLowerCase()
  return (CAMERA_MOVEMENTS as readonly string[]).includes(raw)
    ? (raw as Shot['cameraMovement'])
    : 'static'
}

/** 旧设置值继续兼容；选 H3 时编译成官方 Ref2VA / I2VA，不套万相。 */
export type VideoPromptStyle = 'scene-narrative' | 'formatted'

export function clampShotSeconds(duration?: number): number {
  return Math.max(4, Math.min(15, Math.round(Number(duration) || 5)))
}

/** 按本镜时长切连续时间段，出片提示词必须覆盖到最后一秒。 */
export function timedBeatWindows(duration?: number): Array<{ start: number; end: number }> {
  const total = clampShotSeconds(duration)
  const n = total <= 5 ? 3 : total <= 8 ? 4 : total <= 12 ? 5 : 6
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < n; i++) {
    out.push({
      start: Number(((total * i) / n).toFixed(2)),
      end: Number(((total * (i + 1)) / n).toFixed(2))
    })
  }
  out[out.length - 1].end = Number(total.toFixed(2))
  return out
}

export function formatBeatRangeCn(start: number, end: number): string {
  const a = Number.isInteger(start) ? String(start) : start.toFixed(1)
  const b = Number.isInteger(end) ? String(end) : end.toFixed(1)
  return `${a}–${b}秒`
}

export function formatBeatRangeEn(start: number, end: number): string {
  return `From ${start.toFixed(2)}s to ${end.toFixed(2)}s`
}

/** 编辑器里仍写中文内容表现；选 H3 出片时再编译成官方 Ref2VA / I2VA。用户若已粘贴官方英文全文，原样使用。 */
// 영상 모델용 영어 연출과 한국어 대사 보존 규칙.
export const SCENE_NARRATIVE_SPEC = `Write in the voice of a director explaining this shot to actors and camera crew. Use English for model-facing direction. Describe only the current shot. Preserve Korean (한국어) dialogue, narration, and requested Korean on-screen text verbatim.

Establish the opening blocking. For every visible person, state whether they are near or farther back, how their body is oriented, and exactly where they look. The speaker may stand in the background or to one side. Foreground characters may turn sideways or look back at the speaker or what the speaker points to. Avoid lining up the cast frontally or making everyone look at the camera. Character sheets lock identity; do not copy their poses.

Describe a causal progression: initial physical state → sound, gaze, or prop that triggers change → hands, feet, and body carrying out the action → visible effect on the prop or environment → final state. Use the real props and location details of this shot. Describe observable expressions changing in response to what happens.

Split the full duration from zero to the end into 2–5 consecutive ranges using labels such as 0–2s. Assign the ranges by story beats instead of equal divisions. In each range, identify current actions and speakers, other people's blocking and eyelines, what triggers expression changes, and how the camera follows or holds. Give the opening position and framing, the reason to move or change focus, what the movement reveals, and where it ends. Allow pullbacks, tracking, vertical moves, pans, or cuts when a large space, blocking, reveal, or impact needs them.

Tie sound to visible events. Show how the action affects light, rain, mist, dust, flame, fabric, and objects. Use only trusted original dialogue. Narration by an older version of a character is off screen and people on screen keep their mouths closed. Follow the script's exclusions.

Reference images determine faces and clothing. Avoid reciting identity details or using generic language such as "no blank stares" or "clothing, light and air move." Name each person's actual eyeline instead of adding a general rule at the end.

Weak: Lin Yao points at the ridge and talks. The farmer and constable are present. Everyone looks at someone or something in the scene.
Better: In the foreground, the farmer and constable stand sideways on the stone path. Behind them, Lin Yao rises partway from his knees and points a muddy hand at the ridge. The farmer squints back at Lin Yao. The constable stops and follows his hand toward the ridge. None looks at the camera.`

/** 格式化：人物图 + 空镜底板直接出视频时，内容表现仍写细，出片再套 H3 结构 */
export const FORMATTED_VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function videoPerformanceSpec(style: VideoPromptStyle = 'scene-narrative'): string {
  return style === 'formatted' ? FORMATTED_VIDEO_PERFORMANCE_SPEC : SCENE_NARRATIVE_SPEC
}

export function videoPromptJsonHint(_style: VideoPromptStyle = 'scene-narrative'): string {
  return '<English shot direction in 2–5 beat-based time ranges such as 0–2s. Cover the full shot and specify actions, expressions, speakers and verbatim dialogue, blocking and eyelines, motivated camera motion and ending, synchronized sound, and environmental reactions. Preserve Korean dialogue and Korean on-screen text.>'
}

/** 写给编剧 / 质检 / 出视频：默认按当前主流的场景叙事 */
export const VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function stripFrameLead(text: string): string {
  return (text || '')
    .replace(/^从第一帧接着演[。.]?\s*/g, '')
    .replace(/\n从第一帧接着演[。.]?\s*/g, '\n')
    .trim()
}

/** 去掉已有的「画面中：…是谁」身份段，只留下演戏叙述 */
export function stripIdentityOpening(text: string): string {
  const t = stripFrameLead(text)
  if (!/^(?:画面中|화면 속|In the frame)[：:]/i.test(t)) return t
  const parts = t.split(/\n\s*\n/)
  if (parts.length >= 2) return parts.slice(1).join('\n\n').trim()
  const m = t.match(/^画面中[：:][\s\S]+?(?:是[^；;\n]{1,16}[。；;]\s*)+/)
  if (m && t.slice(m[0].length).trim().length > 40) return t.slice(m[0].length).trim()
  return t
}

export function normalizeIdentityLock(lock: string): string {
  let t = stripFrameLead(lock)
  if (!t) return ''
  if (!/^(?:画面中|화면 속|In the frame)[：:]/i.test(t)) t = `In the frame: ${t}`
  return t
}

/**
 * 把视觉模型认出的身份 + 分镜内容表现拼成喂给模型的画面正文。
 * 场景叙事：两段中文。格式化：仍按段拼接，外层再套 H3 标签。
 */
export function assembleShotVideoPrompt(opts: {
  style: VideoPromptStyle
  identityLock?: string
  performance: string
  extraLead?: string
}): string {
  const performance = (opts.performance || '').trim()
  if (opts.style === 'formatted') {
    return [opts.extraLead, opts.identityLock, performance].filter(Boolean).join('\n\n')
  }
  const reference = (opts.extraLead || '').trim()
  const ident = normalizeIdentityLock(opts.identityLock || '')
  const action = stripIdentityOpening(performance)
  return [reference, ident, action].filter(Boolean).join('\n\n')
}

const FACE_RE =
  /表情|神态|眉|眼|笑|愣|皱|歪|低头|抬头|眼神|嘴角|脸|惊喜|开心|认真|犹豫|紧张|温柔|点头|摇头|吃惊|无奈|得意|委屈|好奇|惊|呆|표정|눈빛|미소|\b(?:eyes?|brows?|smiles?|frowns?|glances?|nods?|jaw)\b/i
const BODY_RE =
  /跑|走|拿|放|伸|举|弯|站|坐|蹲|抱|推|拉|转身|回头|抬手|伸手|迈|踏|递|捧|摸|拍|跳|停|凑|靠|俯|仰|躺|撑|醒|걷|뛰|잡|밀|당기|돌아|\b(?:runs?|walks?|reaches?|holds?|pushes?|pulls?|turns?|sits?|stands?|stops?|opens?|closes?)\b/i
const ENV_RE =
  /门|桌|地|光|风|窗|墙|衣|树|水|灯|屋|院|街|天|雾|雨|烟|火|锅|盘|碗|杯|台|椅|梨|包|产品|案|桥|石|帘|影|尘|叶|草|田|바닥|조명|창문|바람|빗물|\b(?:light|wind|rain|smoke|mist|dust|door|window|floor|table|wall|fabric|water)\b/i

const TEMPLATE_RE =
  /禁止呆脸空眼|衣摆、光和空气里的东西跟着动|把这件事做起来：|表情往前走：眼神一转|人物看向场景里的人或物，不要看镜头/

const ENSEMBLE_LAYER_RE =
  /近处|近景里|身前|身后|稍远|前景|后景|侧对|侧身|侧过|四分之三|过肩|回头|扭头|전경|배경|앞쪽|뒤쪽|뒤돌|\b(?:foreground|background|behind|in front|sideways|over the shoulder|looks back)\b/i

/** 多人在场却没写谁在前、谁在后、各自看谁 → 模型会摆成合影看镜头。 */
export function lacksEnsembleBlocking(text: string, names: string[] = []): boolean {
  const t = (text || '').trim()
  if (!t) return false
  const named = names.filter((n) => n && n.length >= 2 && t.includes(n))
  const multi = named.length >= 2 || /和|、|与/.test(t) && (t.match(/[\u4e00-\u9fff]{2,4}(?=从|跪|说|看|眯|停|站)/g) || []).length >= 2
  if (!multi && named.length < 2) return false
  return !ENSEMBLE_LAYER_RE.test(t)
}

export function isVideoPerformanceTemplate(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  return TEMPLATE_RE.test(t)
}

export function timedBeatCount(text: string): number {
  return ((text || '').match(/\d+(?:\.\d+)?\s*(?:秒|초|s)?\s*(?:[–\-~到至]|\bto\b)\s*\d+(?:\.\d+)?\s*(?:秒|초|s(?:ec(?:onds?)?)?)/gi) || []).length
}

/** continuity 常写成「上一镜末态 → 本镜变化 → 下一镜初态」；出视频只演中间这一截。 */
export function thisShotAction(continuity?: string): string {
  const raw = (continuity || '').trim().replace(/^起始[:：]\s*/, '')
  if (!raw) return ''
  const parts = raw
    .split(/\s*(?:→|->|／|\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length >= 3) return parts[1]
  if (parts.length === 2) return parts[1]
  return raw
}

function cameraDirection(movement: Shot['cameraMovement']): string {
  switch (movement) {
    case 'push':
      return 'The camera slowly pushes in toward the point of focus, then holds.'
    case 'pull':
      return 'The camera pulls back slowly to reveal the surroundings and approaching people.'
    case 'pan':
      return 'The camera pans slowly along the eyeline and settles on what the character sees.'
    case 'tilt':
      return 'The camera tilts slowly with the gaze and settles where the character looks.'
    case 'orbit':
      return 'The camera arcs slightly around the character to reveal the surroundings, well short of a half circle.'
    default:
      return 'Keep the camera nearly still, with slight motion following breathing and action.'
  }
}

export function isVideoPerformanceThin(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 120) return true
  if (isVideoPerformanceTemplate(t)) return true
  if (timedBeatCount(t) < 2) return true
  return !(BODY_RE.test(t) || FACE_RE.test(t))
}

export function videoPerformanceIssue(text: string, names?: string[]): string | null {
  const t = (text || '').trim()
  if (!t) return 'Video direction is missing.'
  if (isVideoPerformanceTemplate(t)) return 'Video direction is generic. Specify each character’s position and eyeline.'
  if (t.length < 120) return 'Video direction is too short. Specify the trigger, continuous actions, resulting prop state, camera endpoint, and synchronized sound.'
  if (timedBeatCount(t) < 2) return 'Add a timeline from zero to the end of the shot. Identify who acts and who speaks in each beat.'
  if (lacksEnsembleBlocking(t, names)) {
    return 'For multiple characters, specify who is near the camera or in the background and who each person looks at. Avoid posing them for the camera.'
  }
  if (!BODY_RE.test(t) && !FACE_RE.test(t) && !ENV_RE.test(t)) {
    return 'Describe concrete actions or reactions.'
  }
  return null
}

/** 把站位 / 承接 / 道具等导演备注压成短摘要（场记用，不拼进画面描述） */
export function composeDirectingNotes(shot: Pick<
  Shot,
  'purpose' | 'shotSize' | 'blocking' | 'eyeline' | 'continuity' | 'propFocus' | 'cameraMovement'
>): string {
  const parts: string[] = []
  if (shot.purpose?.trim()) parts.push(`戏剧功能：${shot.purpose.trim()}`)
  if (shot.shotSize?.trim()) parts.push(`景别：${shot.shotSize.trim()}`)
  if (shot.blocking?.trim()) parts.push(`站位：${shot.blocking.trim()}`)
  if (shot.eyeline?.trim()) parts.push(`视线：${shot.eyeline.trim()}`)
  if (shot.continuity?.trim()) parts.push(`跨镜承接：${shot.continuity.trim()}`)
  if (shot.propFocus?.trim()) parts.push(`道具焦点：${shot.propFocus.trim()}`)
  return parts.join('\n')
}

function storedVideoPrompt(shot: Shot): string {
  return (shot.videoPrompt || '').trim()
}

/** 从分镜场记写出「这一镜发生了什么」，绝不回退成配图静帧词。 */
export function synthesizeVideoPerformance(shot: Shot): string {
  const secs = clampShotSeconds(shot.duration)
  const happening =
    thisShotAction(shot.continuity) ||
    (shot.blocking || '').trim() ||
    (shot.title || '').trim() ||
    'Complete the action planned for this shot'
  const look = (shot.eyeline || '').trim()
  const line = (shot.voiceover || '').trim()
  const speaker = line.match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim() || ''
  const spokenRaw = line.replace(/^([^：:\n]{1,12})[：:]\s*/, '').trim()
  const spoken = /^(?:无|没有|暂无|空|无对白|无台词|无口播|없음|대사없음|내레이션없음|none|n\/a)$/i.test(spokenRaw.replace(/[。.\s]/g, ''))
    ? ''
    : spokenRaw
  const movement = normalizeCameraMovement(shot.cameraMovement)
  const firstEnd = Number((secs * 0.3).toFixed(1))
  const secondEnd = Number((secs * 0.75).toFixed(1))
  const bits = [
    `${formatBeatRangeEn(0, firstEnd)}: Establish foreground and background blocking and each person's physical state. ${look ? `Eyeline: ${look}.` : 'Everyone looks at the relevant person or object in the scene, away from the lens.'}`,
    `${formatBeatRangeEn(firstEnd, secondEnd)}: ${happening.replace(/[。；;]+$/, '')}. The action unfolds without interruption and the trigger changes the character's gaze, brow, and breathing.`
  ]
  if ((shot.blocking || '').trim() && happening !== (shot.blocking || '').trim()) {
    bits[0] += ` Blocking: ${(shot.blocking || '').trim()}.`
  }
  bits.push(cameraDirection(movement))
  if (spoken) {
    bits[1] +=
      speaker
        ? ` ${speaker} says 「${spoken}」. The others keep their mouths closed, look toward the speaker, and react visibly.`
        : ` A person says 「${spoken}」. The others keep their mouths closed and look at the speaker or the object indicated.`
  } else {
    bits[1] += ' No dialogue.'
  }
  bits.push(`${formatBeatRangeEn(secondEnd, secs)}: ${cameraDirection(movement)} Show the clear physical result of the action and maintain the other people's eyelines toward the actor.`)
  return bits.join('\n')
}

/** 编辑框里的原文：空就是空，不要把场记补回去；旧稿里的套话顺手剥掉 */
export function editableVideoPrompt(shot: Shot): string {
  return stripFrameLead(shot.videoPrompt ?? '')
}

/** 视频内容表现：有原文就用原文；空了才按场记补一段（只用于出片，不写回编辑框） */
export function composeVideoPerformance(
  shot: Shot,
  opts?: { ignoreStored?: boolean }
): string {
  if (!opts?.ignoreStored) {
    const own = stripFrameLead(storedVideoPrompt(shot))
    if (own) return own
  }
  return synthesizeVideoPerformance(shot)
}

/** 供配图/视频使用的提示：配图回退画面描述，视频绝不回退画面描述 */
export function composeShotVisualPrompt(
  shot: Shot,
  kind: 'image' | 'video' | 'base' = 'base'
): string {
  if (kind === 'image') return (shot.imagePrompt ?? shot.visualPrompt ?? '').trim()
  if (kind === 'video') return composeVideoPerformance(shot)
  return (shot.visualPrompt ?? '').trim()
}
