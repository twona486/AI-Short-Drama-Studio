/**
 * 노드에 표시한 전체 프롬프트를 이미지 또는 영상 생성 API로 전송한다.
 * 입력란에 내용이 있으면 별도의 지침을 덧붙이지 않고 그대로 전송한다.
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
import { isPlaceholderSpokenLine, spokenTextOnly } from '@/services/ai/dialogue'
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
import { containsSceneDramaText } from '@/utils/scriptMarkdown'
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
    const roster = shotRefRoster(shot, project, collectShotRefIds(shot, project).ids)
    return [roster, shotKeyframePrompt(shot, look, { aspectRatio: project.settings.aspectRatio })].filter(Boolean).join('\n\n')
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
    .filter((line) => !/^(?:镜头|景别|地点|出场|站位|视线|动作承接|可见画面|道具|现场声|台词|对白|旁白|口播|샷|샷 크기|장소|출연|동선|시선|동작 연결|화면|소품|현장음|대사|내레이션|Shot(?: size)?|Location|Cast|Blocking|Eyeline|Continuity|Visible action|Props?|On-location sound|Dialogue|Narration)\s*[：:]/i.test(line))
    .map((line) => line.replace(/^(?:这一镜怎么演|연기|Performance)\s*[：:]\s*/i, ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  const lines = [
    shot.title ? `Shot: ${shot.title}` : '',
    shot.shotSize ? `Shot size: ${shot.shotSize}` : '',
    place.name ? `Location: ${place.name}` : '',
    cast.length ? `Cast: ${cast.map((item) => item.name).join('、')}` : '',
    shot.blocking ? `Blocking: ${shot.blocking}` : '',
    shot.eyeline ? `Eyeline: ${shot.eyeline}` : '',
    shot.continuity ? `Continuity: ${shot.continuity}` : '',
    shot.visualPrompt?.trim() ? `Visible action: ${shot.visualPrompt.trim()}` : '',
    performance ? `Performance: ${performance}` : '',
    shot.propFocus && !isPlaceholderSpokenLine(shot.propFocus) ? `Props: ${shot.propFocus}` : '',
    shot.audioDescription?.trim() ? `On-location sound: ${shot.audioDescription.trim()}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 인물별 음성 설명은 프롬프트 첫머리에 원문 그대로 넣는다.
 * 본문을 정리하는 과정에서 음성 설명이 제거되지 않도록 한다.
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
    lines.push(`${sub.name} (${speaking ? 'speaking' : 'present'}): ${voice}`)
  }
  if (!lines.length) {
    const own = shot.speakerVoice?.trim()
    if (!own) return ''
    lines.push(`Speaker for this shot: ${own}`)
  }
  return [
    'Character voices (use each character\'s own vocal qualities when they speak):',
    ...lines
  ].join('\n')
}

export function defaultVideoSendPrompt(shot: Shot, project: Project): string {
  const packed = packVideoRefEntries(collectShotVideoEntries(shot, project))
  const imageSlots = buildH3ImageSlots(packed)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const roster = pictureIdentityBlock({ prompt: '', imageSlots, duration: shot.duration })
  const camera: Record<string, string> = {
    push: 'Slowly push in with the character\'s attention and settle on the result of the action.',
    pull: 'Slowly pull back from the action detail to reveal the relationships and the full space.',
    pan: 'Pan along the character\'s movement or gaze, then settle on the newly revealed detail.',
    tilt: 'Tilt with the character\'s head or body movement or the direction of the object, then settle on the story focus.',
    orbit: 'Use a short arc around the character with a clear starting and ending point to reveal spatial depth.',
    static: 'Hold the camera when appropriate for the action. Follow or reframe for movement, a reveal, or an environmental change.'
  }
  const visual = String(shot.visualPrompt || '').trim()
  const performance = String(shot.videoPrompt || '').trim()
  const voices = shotVoiceBlock(shot, project)
  return [
    shotRefRoster(shot, project, packed.map((entry) => entry.id)),
    roster,
    voices,
    `Shot: ${shot.title || `Shot ${shot.index + 1}`}`,
    `Framing and camera: ${shot.shotSize || 'Choose framing appropriate to the action'}. ${camera[shot.cameraMovement || 'static']} Complete the action in ${shot.duration} seconds and land on a clear final state.`,
    visual ? `Visual and action reference: ${visual}` : '',
    performance && performance !== visual ? `Performance reference: ${performance}` : '',
    shot.blocking ? `Blocking: ${shot.blocking}` : '',
    shot.eyeline ? `Eyelines: ${shot.eyeline}` : '',
    shot.continuity ? `Continuity: ${shot.continuity}` : '',
    shot.propFocus && !isPlaceholderSpokenLine(shot.propFocus) ? `Key props: ${shot.propFocus}` : '',
    shot.audioDescription ? `Synchronized sound: ${shot.audioDescription}` : '',
    spoken ? `Deliver the following dialogue in its original language: ${shot.voiceover}` : 'There is no dialogue. Do not animate the characters speaking.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 이미지 생성 전에 전체 작품의 화풍을 적용한다. 같은 화풍이 명시되어 있으면 중복하지 않는다. */
export function ensureStyleLock(prompt: string, project: Project): string {
  const look = lookFromScript(project.script)
  const line = `Visual style: Use "${look.medium}" consistently throughout. ${mediumLockText(look)}`
  const body = prompt.trim()
  if (body.includes(look.medium) && /画风|绘制媒介|必须按|화풍|visual style|rendering medium/i.test(body)) return body
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
  const saved = scene.platePrompt?.trim()
  if (saved && /场景锚点图\s*\/\s*四宫格/.test(saved) && containsSceneDramaText(saved)) {
    throw new Error('장면 기준 이미지 프롬프트에 대사나 샷 내용이 들어 있어요. 장면을 다시 추출하거나 장면 설명과 프롬프트를 수정한 뒤 생성하세요.')
  }
  if (!saved && containsSceneDramaText(scene.description)) {
    throw new Error('장면 설명에 대사나 샷 내용이 들어 있어요. 장면을 다시 추출하거나 설명을 수정한 뒤 생성하세요.')
  }
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
  const stored = shot.imagePrompt?.trim() || ''
  if (stored && (shot.voiceover || '').split('\n').some((line) => line.trim().length > 6 && stored.includes(line.trim()))) {
    throw new Error('키프레임 프롬프트에 대사가 들어 있어요. 노드에서 프롬프트를 수정하고 참조 이미지 매핑을 확인한 뒤 생성하세요.')
  }
  return ensureStyleLock(shot.imagePrompt?.trim() || defaultShotImagePrompt(shot, project), project)
}

/** 종료 프레임은 카메라 움직임이 끝났을 때의 구도를 담는다. */
const CAMERA_END_TEXT: Record<string, string> = {
  push: 'Push in: end closer than the opening frame and settle on the result or emotion conveyed by the shot.',
  pull: 'Pull back: end farther out and reveal the character relationships and surrounding space.',
  pan: 'Pan: move the point of attention to the newly revealed detail in one continuous movement.',
  tilt: 'Tilt: follow the character\'s upward or downward movement until the story focus is framed.',
  orbit: 'Orbit: end at the angle reached by the arc while retaining the same characters and location.',
  static: 'Locked camera: retain the opening camera position, focal length, and framing while advancing action, expressions, and prop state.'
}

/**
 * 시작 스냅샷, 샷에서 보이는 변화, 종료 상태를 시작과 종료로 나눈다.
 * 구분할 수 없으면 화면 묘사를 쓰고 종료 프레임에서 동작이 끝났음을 명시한다.
 */
function splitShotContinuity(shot: Shot): { start: string; end: string } {
  const raw = String(shot.continuity || '').trim()
  const segs = raw
    .split(/\s*(?:→|->|-->|—>|=>|⇒|\|)\s*/)
    .map((item) => item.replace(/^(?:起始快照|本镜可见变化|末态|结束状态|시작 스냅샷|보이는 변화|종료 상태|Opening snapshot|Visible change|Final state|End state)\s*[：:]?\s*/i, '').trim())
    .filter(Boolean)
  const visual = String(shot.visualPrompt || '').trim()
  if (segs.length >= 2) {
    return { start: segs[0], end: segs[segs.length - 1] }
  }
  return { start: segs[0] || visual, end: segs[0] || visual }
}

/** 시작 프레임은 움직이기 직전, 종료 프레임은 동작이 완료된 상태를 묘사한다. */
export function defaultShotFramePrompts(shot: Shot, project: Project): { start: string; end: string } {
  const look = lookFromScript(project.script)
  const scene = sceneForShot(shot, project)
  const place = resolveShotPlace(shot, scene)
  const cast = subjectsForShot(shot, project)
  const { start, end } = splitShotContinuity(shot)
  // 참조 이미지 번호는 이전 샷의 종료 프레임이나 현재 샷의 시작 프레임을 포함한 순서대로 붙인다.
  const refIds = collectShotRefIds(shot, project).ids
  const orderedShots = [...(project.shots ?? [])].sort((a, b) => a.index - b.index)
  const pos = orderedShots.findIndex((item) => item.id === shot.id)
  const prevTail = pos > 0 ? orderedShots[pos - 1]?.lastFrameAssetId : undefined
  const startRoster = shotRefRoster(
    shot,
    project,
    refIds,
    prevTail
      ? `Image ${refIds.length + 1}: The previous shot's final frame. Continue its composition, camera position, and lighting for continuity without duplicating it.`
      : ''
  )
  const endRoster = shotRefRoster(
    shot,
    project,
    refIds,
    shot.firstFrameAssetId
      ? `Image ${refIds.length + 1}: This shot's opening frame. Keep the camera position, focal length, wardrobe, and lighting while advancing the action to its final state.`
      : ''
  )
  const ar = project.settings?.aspectRatio || '16:9'
  const visual = String(shot.visualPrompt || '').trim()
  const performance = String(shot.videoPrompt || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .trim()
  const common = [
    look.medium ? `Visual style: Consistently use "${look.medium}".` : '',
    place.name ? `Scene: ${place.name}.` : '',
    place.lighting ? `Lighting: ${place.lighting}.` : '',
    cast.length
      ? `Cast in frame: ${cast.map((item) => (item.description ? `${item.name} (${item.description})` : item.name)).join(', ')}.`
      : '',
    shot.shotSize ? `Shot size: ${shot.shotSize}.` : '',
    shot.blocking ? `Blocking: ${shot.blocking}.` : '',
    shot.propFocus && !isPlaceholderSpokenLine(shot.propFocus) ? `Key props: ${shot.propFocus}.` : '',
    `Use exactly a ${ar} aspect ratio for the entire image.`
  ].filter(Boolean)
  const still = 'Output a single complete still. Avoid panels, collages, numbering, text, and dialogue subtitles. Preserve any explicitly requested Korean on-screen text verbatim.'
  const startPrompt = [
    startRoster,
    `Opening frame for shot ${shot.index + 1} ("${shot.title || 'This shot'}"). Show the moment before the action begins.`,
    start ? `Opening state: ${start}.` : '',
    visual ? `Visual reference: ${visual}.` : '',
    ...common,
    'Show the characters in their initial posture and expression, ready for the motion to start from this frame.',
    still
  ]
    .filter(Boolean)
    .join('\n')
  const endPrompt = [
    endRoster,
    `Final frame for shot ${shot.index + 1} ("${shot.title || 'This shot'}"). Preserve the cast, location, and lighting. Show the completed action at rest.`,
    end ? `Final state: ${end}.` : '',
    performance && performance !== visual ? `Action during this shot: ${performance}.` : '',
    ...common,
    CAMERA_END_TEXT[shot.cameraMovement || 'static'] || CAMERA_END_TEXT.static,
    'Match the opening reference frame\'s camera position, focal length, wardrobe, and lighting. Advance only the action, blocking, expressions, props, and environmental details. Preserve the location, cast, and time.',
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
  // 입력란의 내용을 API에 그대로 전달한다. 정리, 매핑 추가, 마이그레이션 또는 자동 변경을 하지 않는다.
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
  // 영상 입력란은 사용자가 스토리보드에서 다시 채우도록 요청할 때만 변경한다.
  return null
}
