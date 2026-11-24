/**
 * 이미지 생성에는 정지 화면을, 영상 생성에는 동작과 대사, 카메라 움직임을 전달한다.
 * 두 프롬프트는 각각의 생성 단계에서 사용한다.
 */

import { t as translate } from '@/i18n'
import type { Shot } from '@/types'

export const CAMERA_MOVEMENTS = ['push', 'pull', 'pan', 'tilt', 'static', 'orbit'] as const

/** 지원하지 않는 카메라 움직임이 모델에서 반환돼도 안전하게 기본값을 사용한다. */
export function normalizeCameraMovement(value: unknown): Shot['cameraMovement'] {
  const raw = String(value ?? '').trim().toLowerCase()
  return (CAMERA_MOVEMENTS as readonly string[]).includes(raw)
    ? (raw as Shot['cameraMovement'])
    : 'static'
}

/** 이전 설정값을 읽고 H3에서 공식 Ref2VA 또는 I2VA 모드에 연결한다. */
export type VideoPromptStyle = 'scene-narrative' | 'formatted'

export function clampShotSeconds(duration?: number): number {
  return Math.max(4, Math.min(15, Math.round(Number(duration) || 5)))
}

/** 현재 샷의 처음부터 끝까지 연속 시간 구간을 만든다. */
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

export function formatBeatRange(start: number, end: number): string {
  const a = Number.isInteger(start) ? String(start) : start.toFixed(1)
  const b = Number.isInteger(end) ? String(end) : end.toFixed(1)
  return `${a}–${b}s`
}

export function formatBeatRangeEn(start: number, end: number): string {
  return `From ${start.toFixed(2)}s to ${end.toFixed(2)}s`
}

export const DIRECTOR_TIMELINE_SPEC = `The runtime assigns image numbers and identity locks separately. In English, start each beat on a new line, such as "Beat 1 (0–4s): ...". Cover zero through duration without gaps or overlaps. Two beats can work for 4–6 seconds, and three or four often work for 10–15 seconds. Keep continuous camera movement within a shot across beat boundaries. Give each beat enough detail to film it.

For every beat, specify shot size, camera angle or subject placement, how the camera holds or moves, direction and speed, starting and ending composition, focus target, and what the motion reveals. Describe the initial pose, continuous visible action and reaction, and final visible result. Add light, depth of field, materials, environmental reactions and synchronized sound where they matter. Distinguish a true cut from continuous movement without introducing gratuitous cuts, extra props or sounds.

Concrete example: "A ground-level side view begins on a foot between blurred wet leaves. It curls, extends and slips. Focus holds on the toes as the camera pulls straight back to a medium-wide view, revealing the leaves pressed against the subject's body. It comes to rest with the rim and the subject in frame. The leaves rustle as the foot catches." Use the level of detail without copying the example's story.

Treat system panels and visible text as on-screen action. Specify when each cue appears, its on-screen position and visual hierarchy, and when it fades. Preserve literal text, numbers, format and order, and keep it clear of key action. Use each nonhuman subject's actual reference anatomy.`

export const SCENE_NARRATIVE_SPEC = `Direct actors and camera for this shot only, keeping adjacent story events out of it.

${DIRECTOR_TIMELINE_SPEC}

Establish opening positions. Give each character a sentence that specifies depth, body orientation, and gaze target. A speaker may stand farther back or to the side. Foreground characters should turn toward the speaker or the object indicated. Avoid front-facing group poses and staring into the lens. Use turnaround images for identity only.

Describe causes and visible effects in order: opening posture, a trigger such as sound, gaze, or a prop, the movement of hands and body, the visible effect on props or surroundings, and the final state. Use the actual objects and spaces in this shot. Tie expressions to events and describe physical actions concretely.

Divide the shot into two to five contiguous intervals covering zero through the end. Set boundaries at story beats. For each beat, identify who acts and speaks, where other characters stand and look, why expressions change, and how the camera follows or holds. Give the camera's starting position and framing, motivation for movement or a focus change, what it reveals, and where it settles. Allow pullbacks, tracking, rising or descending, pans, tilts, or cuts when movement, spectacle, a reveal, or impact calls for them.

Specify synchronized sounds and how actions affect light, rain, fog, dust, fire, fabric, or objects. Use exact source dialogue. If you need to supply new lines, write them in Korean. Adult narration is off-camera and visible actors keep their mouths closed. Honor all exclusions in the script.

Use reference images for faces and wardrobe. Avoid generic directions about static expressions or moving clothes and atmosphere. State each person's exact gaze target.

Weak example: "Jihyun points at the rice field and speaks. A farmer and a guard are present. They look at one another."
Strong example: "In the foreground, the farmer and guard stand sideways on the stone path. Behind them, Jihyun pushes up from a kneel and points a mud-covered hand toward the rice field. The farmer looks back and squints at Jihyun. The guard stops and follows the pointing hand. No one looks at the camera."`

/** 캐릭터와 배경 참조를 직접 전달할 때도 연기를 구체적으로 작성하고, H3 형식은 전송 시 적용한다. */
export const FORMATTED_VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function videoPerformanceSpec(style: VideoPromptStyle = 'scene-narrative'): string {
  return style === 'formatted' ? FORMATTED_VIDEO_PERFORMANCE_SPEC : SCENE_NARRATIVE_SPEC
}

export function videoPromptJsonHint(_style: VideoPromptStyle = 'scene-narrative'): string {
  return '<English timed direction. On each line write Beat N (start–ends): then specify framing, camera position, movement and focus, visible action and its end state, sound, and exact on-screen text. Cover the entire duration without gaps.>'
}

/** 편집기와 영상 생성 지침에 쓰는 연기 설명을 정리한다. */
export const VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function stripFrameLead(text: string): string {
  return (text || '')
    .replace(/^(?:从第一帧接着演|첫 프레임부터 이어서|continue from the first frame)[。.]?\s*/gi, '')
    .replace(/\n(?:从第一帧接着演|첫 프레임부터 이어서|continue from the first frame)[。.]?\s*/gi, '\n')
    .trim()
}

/** 기존 인물 식별 문장을 제거하고 동작 설명만 남긴다. */
export function stripIdentityOpening(text: string): string {
  let t = stripFrameLead(text)
  if (!/^(?:画面中|화면 속|in (?:the )?frame|cast in frame)[：:]/i.test(t)) return t
  const parts = t.split(/\n\s*\n/)
  if (parts.length >= 2) return parts.slice(1).join('\n\n').trim()
  const m = t.match(/^画面中[：:][\s\S]+?(?:是[^；;\n]{1,16}[。；;]\s*)+/)
  if (m && t.slice(m[0].length).trim().length > 40) return t.slice(m[0].length).trim()
  return t
}

export function normalizeIdentityLock(lock: string): string {
  let t = stripFrameLead(lock)
  if (!t) return ''
  if (!/^(?:画面中|화면 속|in (?:the )?frame|cast in frame)[：:]/i.test(t)) t = `In frame: ${t}`
  return t
}

/**
 * 시각 모델의 캐릭터 식별 결과와 샷의 연기 설명을 조합한다.
 * H3 전송 형식은 호출자가 별도로 적용한다.
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
  /표정|시선|미소|고개|눈썹|입꼬리|긴장|놀라|끄덕|웃|expression|gaze|smil|frown|nod|hesitat|表情|神态|眉|眼|笑|愣|皱|歪|低头|抬头|眼神|嘴角|脸|惊喜|开心|认真|犹豫|紧张|温柔|点头|摇头|吃惊|无奈|得意|委屈|好奇|惊|呆/i
const BODY_RE =
  /달리|걷|걸어|집어|내려놓|손을|일어서|앉|돌아|다가|밀|당기|멈|발을|움직|run|walk|reach|sit|stand|turn|lift|step|grasp|push|pull|stop|跑|走|拿|放|伸|举|弯|站|坐|蹲|抱|推|拉|转身|回头|抬手|伸手|迈|踏|递|捧|摸|拍|跳|停|凑|靠|俯|仰|躺|撑|醒/i
const ENV_RE =
  /문|탁자|테이블|바닥|빛|바람|창|벽|옷|나무|물|불|안개|비|컵|가방|의자|door|table|floor|light|wind|wall|window|rain|fog|cup|chair|门|桌|地|光|风|窗|墙|衣|树|水|灯|屋|院|街|天|雾|雨|烟|火|锅|盘|碗|杯|台|椅|梨|包|产品|案|桥|石|帘|影|尘|叶|草|田/i

const TEMPLATE_RE =
  /멍한 표정 금지|모두 사물이나 인물을 보게|avoid blank stares|禁止呆脸空眼|衣摆、光和空气里的东西跟着动|把这件事做起来：|表情往前走：眼神一转|人物看向场景里的人或物，不要看镜头/i

const ENSEMBLE_LAYER_RE =
  /가까이|앞쪽|뒤쪽|앞에|뒤에|몸을 돌|옆으로|전경|후경|어깨 너머|foreground|background|behind|beside|over.the.shoulder|three.quarter|近处|近景里|身前|身后|稍远|前景|后景|侧对|侧身|侧过|四分之三|过肩|回头|扭头/i

/** 여러 캐릭터가 함께 등장하면 위치와 시선이 명확한지 확인한다. */
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
  return ((text || '').match(/\d+(?:\.\d+)?\s*(?:秒|초|s)?\s*[–\-~到至]\s*\d+(?:\.\d+)?\s*(?:秒|초|s)/gi) || []).length
}

/** 시간 구간 본문을 검증한다. 참조 이미지 목록과 등장인물 정보는 묘사 분량에 포함하지 않는다. */
export function directorTimelineIssue(text: string, duration?: number): string | null {
  const body = text.split(/\n\s*(?:出场|转场|등장|장면 전환|cast|transition)\s*[:：]/i)[0]
  const ranges = [...body.matchAll(/(?:^|[^\d.])([0-9]+(?:\.[0-9]+)?)\s*(?:秒|초|s)?\s*[-–—~～到至]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:秒|초|s)(?=\s*[）)】：:]|\s|$)/gi)]
  if (ranges.length < 2) return '연출 시간 구간을 두 개 이상 적어 주세요.'
  let end = 0
  for (const range of ranges) {
    const start = Number(range[1])
    const next = Number(range[2])
    if (Math.abs(start - end) > 0.001 || next <= start) return '0초부터 샷이 끝날 때까지 시간 구간을 겹치거나 비우지 않고 순서대로 적어 주세요.'
    end = next
  }
  if (duration && Math.abs(end - duration) > 0.001) return `시간 구간이 ${end}초에서 끝나요. 샷 길이인 ${duration}초에 맞춰 주세요.`
  const camera = /景别|特写|近景|中景|全景|远景|微距|机位|俯拍|仰拍|侧拍|过肩|构图|固定|跟拍|跟移|拉远|后撤|推近|焦点|景深|连续拉|沿原轴|镜头(?:慢|缓|匀|向|从|沿|停|不动|保持)|클로즈업|구도|카메라|앵글|초점|트래킹|\b(?:shot|framing|angle|macro|camera|focus|pans?|track(?:s|ing)?|locked.off|wide|close.up|foreground)\b/i
  const beats = ranges.map((range, i) => body.slice(range.index! + range[0].length, ranges[i + 1]?.index ?? body.length)
    .replace(/(?:镜头|샷|beat|shot)\s*\d+\s*[（(【]?/giu, '').trim())
  const length = (beat: string) => beat.replace(/[\s\p{P}]/gu, '').length
  if (beats.some(beat => length(beat) < 36 || !camera.test(beat))) return '각 구간에 카메라의 위치나 구도, 움직임의 시작과 끝, 이어지는 동작을 적어 주세요.'
  const min = end >= 10 ? 210 : end >= 7 ? 150 : 105
  if (beats.reduce((sum, beat) => sum + length(beat), 0) < min) return '샷 크기, 초점, 동작 과정, 주변 변화와 마지막 자세를 구체적으로 적어 주세요.'
  return null
}

/** 자동 보완 때 명시된 화면 속 문구를 줄이거나 순서를 바꾸지 않고 보존한다. */
export function preservesScreenText(previous: string, next: string): boolean {
  let from = 0
  for (const [, literal] of previous.matchAll(/【([^】\n]+)】/g)) {
    if (/^(?:\s*\d+:\d+\s*(?:[｜|].*)?$|.*(?:参考图对应|画面风格|镜头\s*\d+|画幅|首尾帧).*$)/.test(literal)) continue
    const found = next.indexOf(literal, from)
    if (found < 0) return false
    from = found + literal.length
  }
  return true
}

/** H3는 영어 본문과 전용 샷 형식을 사용하므로 기존 중국어 시간 구간 검증을 적용하지 않는다. */
export function h3DirectorBodyIssue(body: string, duration: number): string | null {
  const prose = body
    .replace(/<d>[\s\S]*?<\/d>/gi, ' ')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\d+[:.]\d+|\b(?:at|from)\s+\d+|$)/i, ' ')
  const words = prose.match(/[a-z]+(?:[-'][a-z]+)*/gi)?.length || 0
  if (words < (duration >= 10 ? 105 : duration >= 7 ? 75 : 45)) return '연출 설명이 너무 짧아요. 인물 소개와 대사 외에 이어지는 연기와 카메라 동선을 구체적으로 적어 주세요.'
  if (!/\b(?:close[- ]?up|wide shot|medium shot|low[- ]angle|over[- ]the[- ]shoulder|eye[- ]level|framing|foreground|macro|profile)\b/i.test(prose) ||
      !/\b(?:camera|lens|focus|dolly|tracks?|pans?|tilts?|push(?:es)?|pulls?|locked[- ]off)\b/i.test(prose)) return '연출 설명에 샷 크기, 카메라 위치 또는 초점을 구체적으로 적어 주세요.'
  return null
}

/** 이전 샷의 종료와 다음 샷의 시작 사이에서 현재 샷의 변화만 가져온다. */
export function thisShotAction(continuity?: string): string {
  const raw = (continuity || '').trim().replace(/^(?:起始|시작|Opening)[:：]\s*/i, '')
  if (!raw) return ''
  const parts = raw
    .split(/\s*(?:→|->|／|\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length >= 3) return parts[1]
  if (parts.length === 2) return parts[1]
  return raw
}

function cameraStory(movement: Shot['cameraMovement']): string {
  switch (movement) {
    case 'push':
      return 'Slowly push in along the character’s attention, then hold.'
    case 'pull':
      return 'Pull back smoothly from the detail to reveal the setting and approaching characters.'
    case 'pan':
      return 'Pan slowly along the character’s gaze until the object of attention is framed.'
    case 'tilt':
      return 'Tilt gently with the character’s head movement and settle on their final eyeline.'
    case 'orbit':
      return 'Move in a shallow arc around the character to reveal their surroundings. Keep the arc under half a turn.'
    default:
      return 'Hold the camera, allowing subtle movement that follows breathing and action.'
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
  if (!t) return translate('shotPrompt.missing')
  if (isVideoPerformanceTemplate(t)) return translate('shotPrompt.generic')
  if (t.length < 120) return translate('shotPrompt.tooShort')
  if (timedBeatCount(t) < 2) return translate('shotPrompt.missingBeats')
  if (lacksEnsembleBlocking(t, names)) {
    return translate('shotPrompt.missingBlocking')
  }
  if (!BODY_RE.test(t) && !FACE_RE.test(t) && !ENV_RE.test(t)) {
    return translate('shotPrompt.missingAction')
  }
  return null
}

/** 장면 기록에 필요한 동선, 연결, 소품을 짧게 요약한다. */
export function composeDirectingNotes(shot: Pick<
  Shot,
  'purpose' | 'shotSize' | 'blocking' | 'eyeline' | 'continuity' | 'propFocus' | 'cameraMovement'
>): string {
  const parts: string[] = []
  if (shot.purpose?.trim()) parts.push(`Dramatic purpose: ${shot.purpose.trim()}`)
  if (shot.shotSize?.trim()) parts.push(`Shot size: ${shot.shotSize.trim()}`)
  if (shot.blocking?.trim()) parts.push(`Blocking: ${shot.blocking.trim()}`)
  if (shot.eyeline?.trim()) parts.push(`Eyeline: ${shot.eyeline.trim()}`)
  if (shot.continuity?.trim()) parts.push(`Continuity between shots: ${shot.continuity.trim()}`)
  if (shot.propFocus?.trim()) parts.push(`Prop focus: ${shot.propFocus.trim()}`)
  return parts.join('\n')
}

function storedVideoPrompt(shot: Shot): string {
  return (shot.videoPrompt || '').trim()
}

/** 정지 화면이 아닌 샷 기록을 바탕으로 영상의 동작을 구성한다. */
export function synthesizeVideoPerformance(shot: Shot): string {
  const secs = clampShotSeconds(shot.duration)
  const happening =
    thisShotAction(shot.continuity) ||
    (shot.blocking || '').trim() ||
    (shot.title || '').trim() ||
    'Complete the action in this shot'
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
    `${formatBeatRange(0, firstEnd)}: Establish positions and posture. ${look ? `Eyelines: ${look.replace(/^(?:看|시선\s*[:：]|gaze\s*[:：])\s*/i, '')}.` : 'Each character looks at the subject of their action within the scene.'}`,
    `${formatBeatRange(firstEnd, secondEnd)}: ${happening.replace(/[。；;]+$/, '')}. Let the action continue smoothly. Eyes, eyebrows, and breathing respond to the triggering event.`
  ]
  if ((shot.blocking || '').trim() && happening !== (shot.blocking || '').trim()) {
    bits[0] += ` Blocking: ${(shot.blocking || '').trim()}.`
  }
  bits.push(cameraStory(movement))
  if (spoken) {
    bits[1] +=
      speaker
        ? ` ${speaker} delivers the supplied line: "${spoken}". The others listen silently and turn their heads or visibly react.`
        : ` The speaker delivers the supplied line: "${spoken}". The others remain silent and look toward the speaker or the object indicated.`
  } else {
    bits[1] += ' There is no dialogue.'
  }
  bits.push(`${formatBeatRange(secondEnd, secs)}: ${cameraStory(movement)} End in a clear final state. Keep the other characters’ attention on the person acting.`)
  return bits.join('')
}

/** 편집기의 원문을 사용하고 이전에 저장된 상투 문구를 제거한다. */
export function editableVideoPrompt(shot: Shot): string {
  return stripFrameLead(shot.videoPrompt ?? '')
}

/** 원문이 없을 때만 영상 생성용 연기 설명을 만들며 편집기 원문은 유지한다. */
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

/** 이미지 프롬프트가 비어 있으면 화면 묘사를 쓰고 영상에는 연기 지침을 사용한다. */
export function composeShotVisualPrompt(
  shot: Shot,
  kind: 'image' | 'video' | 'base' = 'base'
): string {
  if (kind === 'image') return (shot.imagePrompt ?? shot.visualPrompt ?? '').trim()
  if (kind === 'video') return composeVideoPerformance(shot)
  return (shot.visualPrompt ?? '').trim()
}
