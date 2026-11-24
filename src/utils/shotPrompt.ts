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

/** 编辑器里仍写中文内容表现；选 H3 出片时再编译成官方 Ref2VA / I2VA。用户若已粘贴官方英文全文，原样使用。 */
export const DIRECTOR_TIMELINE_SPEC = `参考图角色/场景对应由程序单独生成；不要重写图号清单，也不要把身份锁定凑进正文。正文用中文，按剧情拍点每段另起一行，格式“镜头 N（起秒–止秒）：…”。从 0 连续覆盖到 duration，上一段止秒等于下一段起秒（例如 0–4、4–9、9–15），不能跳秒或重叠。4–6 秒可用两段，10–15 秒通常用三至四段；拍点不等于硬切，同一次运镜可以跨段。短镜通常写约 180–300 字，10–15 秒通常约 280–500 字，以信息量为准，不灌水。
每段都给出可执行的拍法：① 景别、机位角度或主体在构图中的位置；② 摄影机固定、推拉、摇移或跟随的方向、速度和起落位置，焦点跟什么走、逐步揭示什么；③ 用起始姿态、连续可见的动作及反应、可见的落幅状态说明表演。对关键拍点补光线/景深/材质、被动作影响的环境和同步现场声，不强行添加道具或声音。转场处说明是同机位连续运镜还是硬切；不中断的就写继续，不制造切镜。
例如“镜头拉远，展现困境”不够。可写“贴地侧拍从虚化腐叶间的前足起幅，足节蜷起再徒劳伸直；焦点留在打滑的足尖，镜头沿原轴匀速后撤到中全景，露出压在身侧的湿叶。停在坑沿与角色同框的位置，叶片随扒抓擦响。”只借鉴写法，不能照抄动作到别的剧情。
系统面板/屏显文字是画面事件：写出现的拍点、屏幕方位、层级和停留/消失时机，避开角色关键动作；逐字保留原文和顺序，禁止擅自简写、数字换格式或编造文字。人物不是人类时，按参考图的真实形态写表演，不默认有手、衣服、发型或人脸。`

export const SCENE_NARRATIVE_SPEC = `用导演给演员和摄影说戏的口吻，写这一镜最终会怎样动起来。只写本镜，不要把上一镜或下一镜的剧情演进来。

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
  return '<中文可执行分镜：每段另起一行写镜头 N（起秒–止秒），无缝覆盖全时长。逐段写景别、机位、运镜起落与焦点、可见动作过程和落幅，按剧情交代转场、声音及屏显原文。不是剧情简述。>'
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

/** 只验收时间轴正文；图号清单和出场锁定不计入细节。 */
export function directorTimelineIssue(text: string, duration?: number): string | null {
  const body = text.split(/\n\s*(?:出场|转场)\s*[:：]/)[0]
  const ranges = [...body.matchAll(/(?:^|[^\d.])([0-9]+(?:\.[0-9]+)?)\s*(?:秒|s)?\s*[-–—~～到至]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:秒|s)(?=\s*[）)】：:]|\s|$)/gi)]
  if (ranges.length < 2) return '缺少分段导演时间轴（至少两段）'
  let end = 0
  for (const range of ranges) {
    const start = Number(range[1])
    const next = Number(range[2])
    if (Math.abs(start - end) > 0.001 || next <= start) return '时间轴有跳秒、重叠或倒序；必须从 0 秒连续覆盖本镜'
    end = next
  }
  if (duration && Math.abs(end - duration) > 0.001) return `时间轴止于 ${end} 秒，与本镜 ${duration} 秒不一致`
  const camera = /景别|特写|近景|中景|全景|远景|微距|机位|俯拍|仰拍|侧拍|过肩|构图|固定|跟拍|跟移|拉远|后撤|推近|焦点|景深|连续拉|沿原轴|镜头(?:慢|缓|匀|向|从|沿|停|不动|保持)/
  const beats = ranges.map((range, i) => body.slice(range.index! + range[0].length, ranges[i + 1]?.index ?? body.length)
    .replace(/(?:镜头\s*\d+\s*[（(【]?|[\s\p{P}])/gu, ''))
  if (beats.some(beat => beat.length < 36 || !camera.test(beat))) return '部分拍点只是剧情摘要；逐段补机位或构图、运镜起落与连续动作细节'
  const min = end >= 10 ? 210 : end >= 7 ? 150 : 105
  if (beats.reduce((sum, beat) => sum + beat.length, 0) < min) return '动态正文缺少可拍细节；补足景别、焦点、动作过程、环境反馈及结束姿势，不要用身份锁定凑字数'
  return null
}

/** 自动补写必须逐字保留旧稿中已标明的屏显，不接受缩写或调换次序。 */
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

/** H3 用英文正文和自己的分镜格式，不套中文时间段校验。 */
export function h3DirectorBodyIssue(body: string, duration: number): string | null {
  const prose = body
    .replace(/<d>[\s\S]*?<\/d>/gi, ' ')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\d+[:.]\d+|\b(?:at|from)\s+\d+|$)/i, ' ')
  const words = prose.match(/[a-z]+(?:[-'][a-z]+)*/gi)?.length || 0
  if (words < (duration >= 10 ? 105 : duration >= 7 ? 75 : 45)) return '动态正文过短，须写足连续表演与摄影调度，身份和台词不计入'
  if (!/\b(?:close[- ]?up|wide shot|medium shot|low[- ]angle|over[- ]the[- ]shoulder|eye[- ]level|framing|foreground|macro|profile)\b/i.test(prose) ||
      !/\b(?:camera|lens|focus|dolly|tracks?|pans?|tilts?|push(?:es)?|pulls?|locked[- ]off)\b/i.test(prose)) return '动态正文缺少具体景别、机位或运镜焦点'
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
