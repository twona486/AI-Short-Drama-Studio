/**
 * 节点上展示的提示词 = 真正发给出图/出视频接口的全文。
 * 框里有字就原样发送，不再背后拼接。
 */
import {
  characterPropSheetPrompt,
  characterSheetPrompt,
  propTurnaroundPrompt,
  ensureCharacterSheetWhiteBackground,
  scenePlatePrompt,
  scenePropSheetPrompt,
  shotBoardPrompt,
  shotKeyframePrompt
} from '@/services/ai/consistency'
import { spokenTextOnly } from '@/services/ai/dialogue'
import { buildH3ImageSlots, pictureIdentityBlock } from '@/services/ai/h3Prompt'
import type { Project, Scene, Shot, StoryProp, Subject } from '@/types'
import {
  collectShotRefIds,
  collectShotVideoEntries,
  composeShotImagePrompt,
  packVideoRefEntries,
  sceneForShot,
  shotRefRoster,
  subjectsForShot
} from '@/utils/consistency'
import { resolveShotPlace } from '@/utils/shotPlace'
import { lookFromScript, mediumLockText } from '@/utils/visualStyle'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'

export function defaultSubjectSheetPrompt(subject: Subject, project: Project): string {
  const look = lookFromScript(project.script)
  return ensureCharacterSheetWhiteBackground(characterSheetPrompt(subject, look.style, false, look))
}

export function defaultScenePlatePrompt(scene: Scene, project: Project): string {
  const look = lookFromScript(project.script)
  return scenePlatePrompt(scene, look.style, look)
}

export function defaultScenePropPrompt(scene: Scene, project: Project): string {
  const look = lookFromScript(project.script)
  return scenePropSheetPrompt(scene, look.style, look)
}

export function defaultSubjectPropPrompt(subject: Subject, project: Project): string {
  const look = lookFromScript(project.script)
  return characterPropSheetPrompt(subject, look.style, look)
}

export function defaultBoardPrompt(shot: Shot, project: Project): string {
  const look = lookFromScript(project.script)
  return shotBoardPrompt(shot, look.style, look, {
    filmChapter:
      project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter',
    aspectRatio: project.settings.aspectRatio
  })
}

export function defaultShotImagePrompt(shot: Shot, project: Project): string {
  if (!videoRequiresStoryboard(project)) {
    const look = lookFromScript(project.script)
    return shotKeyframePrompt(shot, look, { aspectRatio: project.settings.aspectRatio })
  }
  return composeShotImagePrompt(shot, project, (shot.visualPrompt || shot.title).trim())
}

export function shotDirectorBrief(shot: Shot, project: Project): string {
  const scene = sceneForShot(shot, project)
  const place = resolveShotPlace(shot, scene)
  const cast = subjectsForShot(shot, project)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const performance = (shot.videoPrompt || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(spoken ? new RegExp(spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '')
    .replace(/\s*Location facts\s*:[\s\S]*$/i, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^(?:镜头|景别|地点|出场|站位|视线|动作承接|可见画面|道具|现场声|台词|对白|旁白|口播)\s*[：:]/.test(line))
    .map((line) => line.replace(/^这一镜怎么演\s*[：:]\s*/, ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  const lines = [
    shot.title ? `镜头：${shot.title}` : '',
    shot.shotSize ? `景别：${shot.shotSize}` : '',
    place.name ? `地点：${place.name}` : '',
    cast.length ? `出场：${cast.map((item) => item.name).join('、')}` : '',
    shot.blocking ? `站位：${shot.blocking}` : '',
    shot.eyeline ? `视线：${shot.eyeline}` : '',
    shot.continuity ? `Continuity: ${shot.continuity}` : '',
    shot.visualPrompt?.trim() ? `可见画面：${shot.visualPrompt.trim()}` : '',
    performance ? `这一镜怎么演：${performance}` : '',
    shot.propFocus && shot.propFocus !== '无' ? `道具：${shot.propFocus}` : '',
    shot.audioDescription?.trim() ? `现场声：${shot.audioDescription.trim()}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 本镜出场人物各自的声音描述。音色是中文，必须原样写进提示词开头，
 * 否则会被「正文去中文」的清洗一起抹掉，人物就只剩脸没有声音。
 */
export function shotVoiceBlock(shot: Shot, project: Project): string {
  const cast = subjectsForShot(shot, project)
  const speakerLabel = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const lines: string[] = []
  for (const sub of cast) {
    const voice = sub.voicePrompt?.trim()
    if (!voice) continue
    const speaking = Boolean(
      speakerLabel &&
        (sub.name === speakerLabel ||
          speakerLabel.includes(sub.name) ||
          sub.name.includes(speakerLabel))
    )
    lines.push(`${sub.name}（${speaking ? '本镜说话' : '在场'}）：${voice}`)
  }
  if (!lines.length) {
    const own = shot.speakerVoice?.trim()
    if (!own) return ''
    lines.push(`本镜说话人：${own}`)
  }
  return [
    '人物声音（每个人自己的音色，开口时按这个来，不要互相串音色）：',
    ...lines
  ].join('\n')
}

export function defaultVideoSendPrompt(shot: Shot, project: Project): string {
  const packed = packVideoRefEntries(collectShotVideoEntries(shot, project))
  const imageSlots = buildH3ImageSlots(packed)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const roster = pictureIdentityBlock({ prompt: '', imageSlots, duration: shot.duration })
  const camera: Record<string, string> = {
    push: 'Push in slowly along the eyeline and finish on the visible result',
    pull: 'Pull back slowly from the action detail to reveal relationships and the whole location',
    pan: 'Pan along the movement or eyeline and settle on newly revealed information',
    tilt: 'Tilt with the person or object and settle on the dramatic focus',
    orbit: 'Use a short arc with a clear start and end to reveal depth around the character',
    static: 'Keep the camera still where appropriate; follow or reframe only for movement, a reveal, or environmental change'
  }
  const visual = String(shot.visualPrompt || '').trim()
  const performance = String(shot.videoPrompt || '').trim()
  const voices = shotVoiceBlock(shot, project)
  return [
    roster,
    voices,
    `Shot: ${shot.title || `Shot ${shot.index + 1}`}`,
    `Framing and camera: ${shot.shotSize || 'Choose a framing that fits the action'}. ${camera[shot.cameraMovement || 'static']}. Finish within ${shot.duration} seconds with a clear final state.`,
    visual ? `Visual and action basis: ${visual}` : '',
    performance && performance !== visual ? `Action and performance: ${performance}` : '',
    shot.blocking ? `Blocking: ${shot.blocking}` : '',
    shot.eyeline ? `Eyelines: ${shot.eyeline}` : '',
    shot.continuity ? `Continuity: ${shot.continuity}` : '',
    shot.propFocus && shot.propFocus !== '无' ? `Key prop: ${shot.propFocus}` : '',
    shot.audioDescription ? `Synchronized sound: ${shot.audioDescription}` : '',
    spoken ? `原词台词：${shot.voiceover}` : 'No dialogue. No lips moving.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 出图前补上全片画风。已写明同一种画风时不重复堆。 */
export function ensureStyleLock(prompt: string, project: Project): string {
  const look = lookFromScript(project.script)
  const line = `Visual style: keep ${look.medium} consistent throughout the film. ${mediumLockText(look)}`
  const body = prompt.trim()
  if (body.includes(look.medium) && /画风|绘制媒介|必须按|visual style|render in|use/i.test(body)) return body
  return `${body}\n${line}`.trim()
}

export function defaultPropSheetPrompt(prop: StoryProp, project: Project): string {
  const look = lookFromScript(project.script)
  return ensureStyleLock(ensureCharacterSheetWhiteBackground(propTurnaroundPrompt(prop, look)), project)
}

export function propSendPrompt(prop: StoryProp, project: Project): string {
  const raw = prop.sheetPrompt?.trim() || defaultPropSheetPrompt(prop, project)
  return ensureStyleLock(ensureCharacterSheetWhiteBackground(raw), project)
}

export function subjectSendPrompt(subject: Subject, project: Project): string {
  const raw = subject.sheetPrompt?.trim() || defaultSubjectSheetPrompt(subject, project)
  return ensureStyleLock(ensureCharacterSheetWhiteBackground(raw), project)
}

export function sceneSendPrompt(scene: Scene, project: Project): string {
  return ensureStyleLock(scene.platePrompt?.trim() || defaultScenePlatePrompt(scene, project), project)
}

export function scenePropSendPrompt(scene: Scene, project: Project): string {
  return ensureStyleLock(scene.propSheetPrompt?.trim() || defaultScenePropPrompt(scene, project), project)
}

export function boardSendPrompt(shot: Shot, project: Project): string {
  const raw = shot.boardPrompt?.trim() || defaultBoardPrompt(shot, project)
  const film = project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter'
  return film ? ensureStyleLock(raw, project) : raw
}

export function shotImageSendPrompt(shot: Shot, project: Project): string {
  return ensureStyleLock(shot.imagePrompt?.trim() || defaultShotImagePrompt(shot, project), project)
}

/** 运镜对结束帧构图的影响：结束帧不是把开场画面复制一遍，要走到运镜的落点 */
const CAMERA_END_TEXT: Record<string, string> = {
  push: 'Push-in: frame the ending closer than the opening and land on the visible result or emotion.',
  pull: 'Pullback: frame the ending farther away to reveal relationships and the full space.',
  pan: 'Pan: settle on newly revealed information. The opening and ending belong to one continuous pan.',
  tilt: 'Tilt: follow the character lifting their head or bending over to the story focus.',
  orbit: 'Arc: end at the new angle on the same cast and in the same location.',
  static: 'Static: keep camera position, focal length, and composition across frames. Advance only actions, expressions, and prop state.'
}

/**
 * 把「起始快照 → 本镜可见变化 → 末态」拆成开场状态和结束状态两段。
 * 拆不出来就用可见画面兜底，结束状态再额外强调「动作已完成」。
 */
function splitShotContinuity(shot: Shot): { start: string; end: string } {
  const raw = String(shot.continuity || '').trim()
  const segs = raw
    .split(/\s*(?:→|->|-->|—>|=>|⇒|\|)\s*/)
    .map((item) => item.replace(/^(?:起始快照|本镜可见变化|末态|结束状态)\s*[：:]?\s*/, '').trim())
    .filter(Boolean)
  const visual = String(shot.visualPrompt || '').trim()
  if (segs.length >= 2) {
    return { start: segs[0], end: segs[segs.length - 1] }
  }
  return { start: segs[0] || visual, end: segs[0] || visual }
}

/** 首尾帧专用画面词：起始帧画开场那一瞬，结束帧画动作完成后的末态。 */
export function defaultShotFramePrompts(shot: Shot, project: Project): { start: string; end: string } {
  const look = lookFromScript(project.script)
  const scene = sceneForShot(shot, project)
  const place = resolveShotPlace(shot, scene)
  const cast = subjectsForShot(shot, project)
  const { start, end } = splitShotContinuity(shot)
  // 参考图编号对照：起始帧比结束帧多带一张（上一镜末帧 / 本镜起始帧），编号要跟着走
  const refIds = collectShotRefIds(shot, project).ids
  const orderedShots = [...(project.shots ?? [])].sort((a, b) => a.index - b.index)
  const pos = orderedShots.findIndex((item) => item.id === shot.id)
  const prevTail = pos > 0 ? orderedShots[pos - 1]?.lastFrameAssetId : undefined
  const startRoster = shotRefRoster(
    shot,
    project,
    refIds,
    prevTail
      ? `Picture ${refIds.length + 1}: the previous shot's last frame. Carry its composition, camera position, and light forward for continuity without copying the image.`
      : ''
  )
  const endRoster = shotRefRoster(
    shot,
    project,
    refIds,
    shot.firstFrameAssetId
      ? `Picture ${refIds.length + 1}: this shot's first frame. Keep camera position, focal length, wardrobe, and lighting, advancing action to its end state.`
      : ''
  )
  const ar = project.settings?.aspectRatio || '16:9'
  const visual = String(shot.visualPrompt || '').trim()
  const performance = String(shot.videoPrompt || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .trim()
  const common = [
    look.medium ? `Visual style: keep ${look.medium} consistent throughout the film. ` : '',
    place.name ? `Location: ${place.name}.` : '',
    place.lighting ? `Light: ${place.lighting}.` : '',
    cast.length
      ? `People in frame: ${cast.map((item) => (item.description ? `${item.name}（${item.description}）` : item.name)).join('、')}。`
      : '',
    shot.shotSize ? `Framing: ${shot.shotSize}.` : '',
    shot.blocking ? `Blocking: ${shot.blocking}.` : '',
    shot.propFocus && shot.propFocus !== '无' ? `Key prop: ${shot.propFocus}。` : '',
    `Output the entire frame at aspect ratio ${ar}.`
  ].filter(Boolean)
  const still = 'Output one complete still image. Do not use grids, collages, numbers, text, or dialogue captions. Preserve user-requested Korean on-screen text verbatim.'
  const startPrompt = [
    startRoster,
    `First frame of shot ${shot.index + 1}, ${shot.title || 'current shot'}, before the action begins.`,
    start ? `Opening state: ${start}.` : '',
    visual ? `Visual reference: ${visual}.` : '',
    ...common,
    'Show people at the start of the action in their initial expressions and poses. Make the composition usable as the exact first frame of the video.',
    still
  ]
    .filter(Boolean)
    .join('\n')
  const endPrompt = [
    endRoster,
    `Last frame of shot ${shot.index + 1}, ${shot.title || 'current shot'}. Preserve the same shot, cast, location, and lighting. Show the action complete and at rest.`,
    end ? `Ending state: ${end}.` : '',
    performance && performance !== visual ? `Action progression: ${performance}.` : '',
    ...common,
    CAMERA_END_TEXT[shot.cameraMovement || 'static'] || CAMERA_END_TEXT.static,
    'The reference includes this first frame of this shot. Match camera position, focal length, clothing, and lighting. Advance only actions, positions, expressions, prop states, and environmental details. Keep the location, cast, and time.',
    still
  ]
    .filter(Boolean)
    .join('\n')
  return { start: startPrompt, end: endPrompt }
}

export function shotFrameSendPrompt(
  shot: Shot,
  project: Project,
  which: 'start' | 'end'
): string {
  const raw =
    which === 'start'
      ? shot.startFramePrompt?.trim() || defaultShotFramePrompts(shot, project).start
      : shot.endFramePrompt?.trim() || defaultShotFramePrompts(shot, project).end
  return ensureStyleLock(raw, project)
}

function hasStoredPrompt(value: string | undefined): boolean {
  return value != null
}

export function videoSendPrompt(shot: Shot, project: Project): string {
  void project
  // 单一数据源：文本框字段就是接口参数。禁止清洗、补映射、迁移或自动改写。
  return shot.compiledVideoPrompt ?? ''
}

export function rebuildGeneratePrompt(
  kind: 'subject' | 'scene' | 'sceneProps' | 'shotBoard' | 'shotImage' | 'shotVideo',
  project: Project,
  target: Subject | Scene | Shot
): Record<string, string> {
  if (kind === 'subject') {
    return { sheetPrompt: defaultSubjectSheetPrompt(target as Subject, project) }
  }
  if (kind === 'scene') {
    return { platePrompt: defaultScenePlatePrompt(target as Scene, project) }
  }
  if (kind === 'sceneProps') {
    return { propSheetPrompt: defaultScenePropPrompt(target as Scene, project) }
  }
  const shot = target as Shot
  if (kind === 'shotBoard') return { boardPrompt: defaultBoardPrompt(shot, project) }
  if (kind === 'shotImage') return { imagePrompt: defaultShotImagePrompt(shot, project) }
  return { compiledVideoPrompt: defaultVideoSendPrompt(shot, project) }
}

export function fillEmptyGeneratePrompt(
  kind: 'subject' | 'scene' | 'sceneProps' | 'shotBoard' | 'shotImage' | 'shotVideo',
  project: Project,
  target: Subject | Scene | Shot
): Record<string, string> | null {
  if (kind === 'subject') {
    const subject = target as Subject
    if (hasStoredPrompt(subject.sheetPrompt)) return null
    return { sheetPrompt: defaultSubjectSheetPrompt(subject, project) }
  }
  if (kind === 'scene') {
    const scene = target as Scene
    if (hasStoredPrompt(scene.platePrompt)) return null
    return { platePrompt: defaultScenePlatePrompt(scene, project) }
  }
  if (kind === 'sceneProps') {
    const scene = target as Scene
    if (hasStoredPrompt(scene.propSheetPrompt)) return null
    return { propSheetPrompt: defaultScenePropPrompt(scene, project) }
  }
  const shot = target as Shot
  if (kind === 'shotBoard') {
    if (hasStoredPrompt(shot.boardPrompt)) return null
    return { boardPrompt: defaultBoardPrompt(shot, project) }
  }
  if (kind === 'shotImage') {
    if (hasStoredPrompt(shot.imagePrompt)) return null
    return { imagePrompt: defaultShotImagePrompt(shot, project) }
  }
  // 视频框永不自动初始化、迁移或回填。只有用户主动点“按分镜重铺”才改它。
  return null
}
