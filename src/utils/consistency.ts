import { t } from '@/i18n'
import type { ID, Project, Scene, Shot, StoryProp, Subject } from '@/types'
import { sceneForShotPlace, shotMentionsScene } from '@/utils/shotPlace'
import { lookFromScript, mediumLockText } from '@/utils/visualStyle'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { shotVideoNode, stillModeForShot } from '@/utils/videoStill'

export interface ShotRefBundle {
  ids: ID[]
  labels: string[]
  characterCount: number
  hasScene: boolean
}

export function sceneHasKeyProps(scene: Pick<Scene, 'props'>): boolean {
  const value = scene.props?.trim()
  return Boolean(value && !/^(无|没有|暂无|없음|none|no)$/i.test(value))
}

function uniqueIds(ids: ID[]): ID[] {
  const out: ID[] = []
  for (const id of ids) {
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** ID, 이름, 역할명으로 캐릭터를 서로 연결한다. */
export function subjectMatchKeys(sub: Subject): string[] {
  return uniqueIds(
    [sub.id, sub.name, sub.role]
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length >= 2)
  )
}

export function matchSubject(token: string, subjects: Subject[]): Subject | undefined {
  const key = String(token ?? '').trim()
  if (!key) return undefined
  const lower = key.toLowerCase()
  return subjects.find((s) =>
    subjectMatchKeys(s).some((k) => k === key || k.toLowerCase() === lower)
  )
}

export function inferSubjectsFromText(text: string, subjects: Subject[]): Subject[] {
  const t = text || ''
  if (!t.trim() || !subjects.length) return []
  return subjects.filter((s) => subjectMatchKeys(s).some((k) => t.includes(k)))
}

export function shotCastText(shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'voiceover' | 'blocking'>): string {
  return [shot.title, shot.visualPrompt, shot.videoPrompt, shot.voiceover, shot.blocking]
    .map((s) => String(s ?? ''))
    .join('\n')
}

/** ID나 이름으로 이 샷에 출연하는 캐릭터를 찾고, 본문에만 있는 캐릭터도 추가한다. */
/** 이 샷의 본문에 명시된 반복 소품만 참조에 포함한다. */
export function propsForShot(shot: Shot, project: Project): StoryProp[] {
  const text = [shot.title, shot.visualPrompt, shot.videoPrompt, shot.propFocus, shot.blocking, shot.purpose]
    .map((item) => String(item ?? ''))
    .join('\n')
  return (project.props ?? []).filter((item) => item.name && text.includes(item.name))
}

export function boundSubjectIds(shot: Shot, subjects: Subject[]): ID[] {
  const explicit = (shot.subjectIds ?? [])
    .map((token) => matchSubject(String(token), subjects)?.id)
    .filter((id): id is ID => Boolean(id))
  const inferred = inferSubjectsFromText(shotCastText(shot), subjects).map((s) => s.id)
  return uniqueIds([...explicit, ...inferred])
}

function castRefEntries(
  shot: Shot,
  project: Project,
  opts?: { includeProps?: boolean }
): { id: ID; label: string }[] {
  const subjects = project.subjects ?? []
  const bound = boundSubjectIds(shot, subjects)
  const speakerLabel = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const speaker = speakerLabel ? matchSubject(speakerLabel, subjects) : undefined
  const wanted = uniqueIds([...(speaker ? [speaker.id] : []), ...bound]).slice(0, 4)
  const out: { id: ID; label: string }[] = []
  for (const sid of wanted) {
    const sub = subjects.find((s) => s.id === sid)
    if (!sub) continue
    if (sub.designSheetAssetId) {
      out.push({
        id: sub.designSheetAssetId,
        label: `four-view turnaround of "${sub.name}" (${sub.kind}); lock face, hair, body and outfit`
      })
    }
    if (out.filter((x) => x.label.includes('four-view')).length >= 2) break
  }
  return out
}

/**
 * 스토리 개요판을 만들 때 캐릭터 사면도, 에셋 이미지, 배경 이미지를 참조한다.
 */
export function collectShotBoardRefIds(shot: Shot, project: Project): ShotRefBundle {
  return packShotRefs(shot, project, { includeBoard: false, includeProps: true, max: 6 })
}

export type VideoRefKind = 'character' | 'scene' | 'board' | 'extra' | 'keyframe' | 'prop'

export interface VideoRefEntry {
  id: ID
  label: string
  kind: VideoRefKind
  name?: string
}

/** 영상 모델의 stillMode에 맞춰 참조를 구성한다. H3 identity에는 캐릭터와 배경만 전달한다. */
export function collectShotVideoEntries(shot: Shot, project: Project): VideoRefEntry[] {
  const omitted = new Set(shot.omittedRefAssetIds ?? [])
  const stillMode = stillModeForShot(shot, project)
  const subjects = project.subjects ?? []
  const bound = boundSubjectIds(shot, subjects)
  const speakerLabel = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const speaker = speakerLabel ? matchSubject(speakerLabel, subjects) : undefined
  const wanted = uniqueIds([...(speaker ? [speaker.id] : []), ...bound])
  const out: VideoRefEntry[] = []
  for (const sid of wanted) {
    const sub = subjects.find((item) => item.id === sid)
    if (!sub?.designSheetAssetId || omitted.has(sub.designSheetAssetId)) continue
    out.push({
      id: sub.designSheetAssetId,
      kind: 'character',
      name: sub.name,
      label: `CHARACTER DESIGN SHEET of ${sub.name}; lock only this person's face, hair, body and outfit; do not generate a four-view grid`
    })
  }
  for (const prop of propsForShot(shot, project)) {
    if (!prop.designSheetAssetId || omitted.has(prop.designSheetAssetId)) continue
    out.push({
      id: prop.designSheetAssetId,
      kind: 'prop',
      name: prop.name,
      label: `multi-angle PROP SHEET of ${prop.name}; this picture is the recurring prop; lock shape, material, color and wear; not a first frame`
    })
  }
  const scene = sceneAssetForShot(shot, project)
  if (scene?.plateAssetId && !omitted.has(scene.plateAssetId)) {
    out.push({
      id: scene.plateAssetId,
      kind: 'scene',
      name: scene.name,
      label: `SCENE PLATE of ${scene.name}; lock only space, materials and light; do not generate a four-panel grid`
    })
  }
  if (stillMode === 'storyboard' && shot.boardAssetId && !omitted.has(shot.boardAssetId)) {
    out.push({
      id: shot.boardAssetId,
      kind: 'board',
      name: `shot ${shot.index + 1}`,
      label: `six-panel STORYBOARD for [Shot 1]; action plan only; one continuous full-frame take; never copy panels or play them as a slideshow`
    })
  }
  if (stillMode === 'keyframe' && shot.imageAssetId && !omitted.has(shot.imageAssetId)) {
    out.unshift({
      id: shot.imageAssetId,
      kind: 'keyframe',
      name: 'keyframe',
      label: '2x2 four-panel KEYFRAME for [Shot 1] (exactly 4 cells, never more); action plan only; one continuous full-frame take; never copy the grid'
    })
  }
  const used = new Set(out.map((item) => item.id))
  for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
    if (!id || used.has(id) || omitted.has(id)) continue
    if (id === shot.imageAssetId || id === shot.boardAssetId) continue
    used.add(id)
    out.push({
      id,
      kind: 'extra',
      name: 'user reference',
      label: 'additional user reference; match people, clothing, product or style from this image'
    })
  }
  return out
}

export function collectShotVideoRefIds(shot: Shot, project: Project): ShotRefBundle {
  const entries = packVideoRefEntries(collectShotVideoEntries(shot, project))
  return {
    ids: entries.map((entry) => entry.id),
    labels: entries.map((entry) => entry.label),
    characterCount: entries.filter((entry) => entry.kind === 'character').length,
    hasScene: entries.some((entry) => entry.kind === 'scene')
  }
}

/** 최대 9장. 일반 제작의 키프레임을 영상의 첫 프레임으로 맨 앞에 배치한다. */
export function packVideoRefEntries(entries: VideoRefEntry[], max = 9): VideoRefEntry[] {
  const chars = entries.filter((entry) => entry.kind === 'character')
  const props = entries.filter((entry) => entry.kind === 'prop')
  const extras = entries.filter((entry) => entry.kind === 'extra')
  const scene = entries.find((entry) => entry.kind === 'scene')
  const board = entries.find((entry) => entry.kind === 'board')
  const keyframe = entries.find((entry) => entry.kind === 'keyframe')
  if (keyframe) {
    const reserved = [keyframe, scene].filter((entry): entry is VideoRefEntry => Boolean(entry))
    const leftover = Math.max(0, max - reserved.length)
    const extraTake = Math.min(extras.length, leftover)
    const propTake = Math.min(props.length, Math.max(0, leftover - extraTake))
    const charTake = Math.max(0, leftover - extraTake - propTake)
    return [keyframe, ...chars.slice(0, charTake), ...props.slice(0, propTake), ...reserved.slice(1), ...extras.slice(0, extraTake)]
  }
  const reserved = [scene, board].filter((entry): entry is VideoRefEntry => Boolean(entry))
  const leftover = Math.max(0, max - reserved.length)
  const extraTake = Math.min(extras.length, leftover)
  const propTake = Math.min(props.length, Math.max(0, leftover - extraTake))
  const charTake = Math.max(0, leftover - extraTake - propTake)
  return [...chars.slice(0, charTake), ...props.slice(0, propTake), ...reserved, ...extras.slice(0, extraTake)]
}

/**
 * 이미지 생성에 스토리 개요판, 사면도, 에셋 이미지, 배경 이미지를 참조한다.
 * 영상 재현에는 사용자 제품 이미지를 포함한다. GPT 편집은 최대 4장을 받는다.
 */
export function collectShotRefIds(shot: Shot, project: Project): ShotRefBundle {
  return packShotRefs(shot, project, {
    includeBoard: videoRequiresStoryboard(project),
    includeProps: true,
    max: 8
  })
}

/** 일반 제작의 키프레임에는 캐릭터, 배경, 소품만 참조한다. */
export function collectShotKeyframeRefIds(shot: Shot, project: Project): ShotRefBundle {
  return packShotRefs(shot, project, { includeBoard: false, includeProps: true, max: 8 })
}

function packShotRefs(
  shot: Shot,
  project: Project,
  opts: { includeBoard: boolean; includeProps: boolean; max: number }
): ShotRefBundle {
  const omitted = new Set(shot.omittedRefAssetIds ?? [])
  const keep = (list: { id: ID; label: string }[]) =>
    omitted.size ? list.filter((item) => !omitted.has(item.id)) : list
  const chars = castRefEntries(shot, project, { includeProps: opts.includeProps })
  const scene = sceneAssetForShot(shot, project)
  const sceneEntry = scene?.plateAssetId
    ? {
        id: scene.plateAssetId,
        label: `four-panel scene anchor sheet of "${scene.name}"; same place, no people; use overall space, main anchor, floor and light`
      }
    : null
  const storyPropEntries = opts.includeProps
    ? propsForShot(shot, project)
        .filter((item) => item.designSheetAssetId)
        .slice(0, 2)
        .map((item) => ({
          id: item.designSheetAssetId as ID,
          label: `multi-angle prop sheet of "${item.name}"; this picture is that prop, lock shape, material and color`
        }))
    : []
  const scenePropEntry = opts.includeProps && sceneHasKeyProps(scene || {}) && scene?.propSheetAssetId
    ? {
        id: scene.propSheetAssetId,
        label: `key prop design sheet of "${scene.name}"; only the listed story-relevant objects must match`
      }
    : null
  const boardEntry =
    opts.includeBoard && shot.boardAssetId
      ? {
          id: shot.boardAssetId,
          label: 'six-panel action storyboard for this shot; use the final panel for framing and use all panels for blocking and prop-state continuity; do not copy the grid or line-art look'
        }
      : null

  if (project.pipelineMode === 'remake') {
    const products = uniqueIds([
      ...(shot.referenceAssetIds ?? []),
      ...(project.script?.referenceAssetIds ?? [])
    ])
    const productEntries = products.map((id, i) => ({
      id,
      label: `user product photo ${i + 1}; replace every on-screen product with this exact item, packaging, logo and color`
    }))
    const charOne = chars[0] ? [chars[0]] : []
    const sceneOne = sceneEntry ? [sceneEntry] : []
    const boardOne = boardEntry ? [boardEntry] : []
    const reserved = charOne.length + sceneOne.length + boardOne.length
    const productSlots = Math.max(productEntries.length ? 1 : 0, 4 - reserved)
    const ordered: { id: ID; label: string }[] = [
      ...productEntries.slice(0, productSlots),
      ...boardOne,
      ...charOne,
      ...sceneOne
    ]
    for (const p of productEntries) {
      if (ordered.length >= 4) break
      if (!ordered.some((o) => o.id === p.id)) ordered.push(p)
    }
    const kept = keep(ordered)
    return {
      ids: kept.map((o) => o.id),
      labels: kept.map((o) => o.label),
      characterCount: charOne.length,
      hasScene: Boolean(sceneEntry)
    }
  }

  const fourViews = chars.filter((c) => c.label.includes('four-view'))
  const props = chars.filter((c) => !c.label.includes('four-view'))
  if (chars.length > 0 || storyPropEntries.length > 0 || sceneEntry || boardEntry) {
    const ordered = [
      ...(boardEntry ? [boardEntry] : []),
      ...fourViews.slice(0, 2),
      ...storyPropEntries,
      ...props.slice(0, 2),
      ...(scenePropEntry ? [scenePropEntry] : []),
      ...(sceneEntry ? [sceneEntry] : [])
    ]
    for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
      if (ordered.length >= opts.max) break
      if (ordered.some((o) => o.id === id)) continue
      ordered.push({ id, label: 'user extra reference' })
    }
    const kept = keep(ordered)
    return {
      ids: kept.map((o) => o.id),
      labels: kept.map((o) => o.label),
      characterCount: Math.min(fourViews.length, 2),
      hasScene: Boolean(sceneEntry)
    }
  }

  const fallback = uniqueIds([
    ...(shot.referenceAssetIds ?? []),
    ...(project.script?.referenceAssetIds ?? [])
  ]).filter((id) => !omitted.has(id))
  return {
    ids: fallback.slice(0, 3),
    labels: fallback.slice(0, 3).map((_, i) => `style/product reference ${i + 1}`),
    characterCount: 0,
    hasScene: false
  }
}

export function subjectsForShot(shot: Shot, project: Project): Subject[] {
  const all = project.subjects ?? []
  const ids = boundSubjectIds(shot, all)
  return ids
    .map((id) => all.find((s) => s.id === id))
    .filter((s): s is Subject => Boolean(s))
}

export function sceneForShot(shot: Shot, project: Project): Scene | undefined {
  return sceneForShotPlace(shot, project)
}

function sceneFromVideoEdges(shot: Shot, project: Project): Scene | undefined {
  const node = shotVideoNode(project, shot.id)
  const canvas = project.canvas
  if (!node || !canvas) return undefined
  const scenes = project.scenes ?? []
  for (const edge of canvas.edges ?? []) {
    if (edge.target !== node.id) continue
    const src = canvas.nodes.find((item) => item.id === edge.source)
    if (src?.type !== 'scene') continue
    const scene = scenes.find((item) => item.id === src.data.sceneId)
    if (scene) return scene
  }
  return undefined
}

/**
 * 이미지와 영상에는 배경 이미지를 쓴다. 프롬프트는 sceneForShot으로 생성하며 시공간이 충돌하면 생략한다.
 * 연결된 배경, 현재 영상 노드와 연결된 배경, 이름이 일치하는 배경, 첫 배경 카드 순으로 찾는다.
 */
export function sceneAssetForShot(shot: Shot, project: Project): Scene | undefined {
  const all = project.scenes ?? []
  if (!all.length) return undefined
  const bound = shot.sceneId ? all.find((item) => item.id === shot.sceneId) : undefined
  if (bound) return bound
  return sceneFromVideoEdges(shot, project) || all.find((item) => shotMentionsScene(shot, item)) || all[0]
}

export type ShotRefSlot = {
  id: ID
  label: string
  locked: boolean
}

export function refSlotLabel(id: ID, project: Project): string {
  const four = (project.subjects ?? []).find((s) => s.designSheetAssetId === id)
  if (four) return t('referenceSlots.character', { name: four.name })
  const prop = (project.scenes ?? []).find((s) => s.propSheetAssetId === id)
  if (prop) return t('referenceSlots.prop', { name: prop.name })
  const scn = (project.scenes ?? []).find((s) => s.plateAssetId === id)
  if (scn) return t('referenceSlots.anchor', { name: scn.name })
  const board = (project.shots ?? []).find((s) => s.boardAssetId === id)
  if (board) return t('referenceSlots.numberedBoard', { number: board.index + 1 })
  if ((project.script?.referenceAssetIds ?? []).includes(id)) return t('referenceSlots.product')
  return t('common.referenceImage')
}

/** 이미지 생성 노드에서는 캐릭터, 배경, 제품 참조를 고정한다. 추가 참조는 삭제할 수 있다. */
export function imageRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  const seen = new Set<ID>()
  const omitted = new Set(shot.omittedRefAssetIds ?? [])
  const slots: ShotRefSlot[] = []
  const push = (id: ID | undefined, label: string, locked: boolean) => {
    if (!id || seen.has(id) || omitted.has(id)) return
    seen.add(id)
    slots.push({ id, label, locked })
  }
  push(videoRequiresStoryboard(project) ? shot.boardAssetId : undefined, t('referenceSlots.board'), true)
  for (const sub of subjectsForShot(shot, project)) {
    push(sub.designSheetAssetId, t('referenceSlots.character', { name: sub.name }), true)
  }
  const scene = sceneAssetForShot(shot, project)
  if (scene) {
    push(scene.plateAssetId, t('referenceSlots.anchor', { name: scene.name }), true)
    push(scene.propSheetAssetId, t('referenceSlots.prop', { name: scene.name }), true)
  }
  if (project.pipelineMode === 'remake') {
    for (const id of project.script?.referenceAssetIds ?? []) {
      push(id, t('referenceSlots.product'), true)
    }
  }
  for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
    push(id, refSlotLabel(id, project), false)
  }
  return slots
}

/** 스토리 개요판 노드는 사면도, 에셋, 배경을 참조한다. 개요판 자체는 제외한다. */
export function boardRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  return imageRefSlots(shot, project).filter((s) => s.id !== shot.boardAssetId)
}

/** 영상 노드에 H3에 전달하는 캐릭터 설정 이미지, 배경, 스토리 개요판을 표시한다. */
export function videoRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  return packVideoRefEntries(collectShotVideoEntries(shot, project)).map((entry, index) => ({
    id: entry.id,
    label: t(`referenceSlots.video.${entry.kind}`, { number: index + 1, name: entry.name }),
    locked: false
  }))
}

export function videoExtraRefIds(shot: Shot): ID[] {
  return uniqueIds(shot.referenceAssetIds ?? [])
    .filter((id) => id !== shot.boardAssetId && id !== shot.imageAssetId)
}

export function videoExtraRefLead(shot: Shot, project: Project): string {
  const extras = videoExtraRefIds(shot).slice(0, 2)
  if (!shot.boardAssetId && !extras.length) return ''
  const filmChapter =
    project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter'
  const parts = [
    shot.boardAssetId
      ? filmChapter
        ? 'Image 1 is the color storyboard for this shot, with four or eight panels. Follow its action from top left to bottom right. Do not use it as the opening frame or reproduce the panels, borders, or collage.'
        : 'Image 1 is the six-panel monochrome action storyboard. Follow its action from top left to bottom right. Do not use it as the opening frame or reproduce the panels, borders, line art, or collage.'
      : 'Image 1 is the main reference for this shot.'
  ]
  extras.forEach((id, i) => {
    if (id === shot.boardAssetId) {
      parts.push(
        filmChapter
          ? `Image ${i + 2} is the color storyboard for this shot. Read from top left to bottom right for action order, composition, prop state, and final pose. Do not reproduce the grid borders, collage layout, or simultaneous panels.`
          : `Image ${i + 2} is the six-panel monochrome action storyboard. Read from top left to bottom right for action order, prop state, and final pose. Do not reproduce the panel borders, line art, collage layout, or simultaneous panels.`
      )
    } else {
      const owner = shotRefOwner(id, shot, project)
      parts.push(`Image ${i + 2}: ${REF_OWNER_JOB[owner.kind](owner.name)} Use this as an identity or prop reference. Do not introduce a new character.`)
    }
  })
  return parts.join('\n')
}

export function missingCastAssets(project: Project): {
  subjects: Subject[]
  scenes: Scene[]
} {
  return {
    subjects: (project.subjects ?? []).filter((s) => !s.designSheetAssetId),
    scenes: (project.scenes ?? []).filter((s) => !s.plateAssetId)
  }
}

export type ShotRefOwnerKind = 'character' | 'scene' | 'prop' | 'board' | 'keyframe' | 'extra'

/** 에셋 ID로 캐릭터, 배경, 소품, 스토리 개요판 또는 키프레임을 찾는다. */
export function shotRefOwner(
  id: ID,
  shot: Shot,
  project: Project
): { kind: ShotRefOwnerKind; name: string } {
  const sub = (project.subjects ?? []).find((item) => item.designSheetAssetId === id)
  if (sub) return { kind: 'character', name: sub.name }
  const scene = (project.scenes ?? []).find(
    (item) => item.plateAssetId === id || item.propSheetAssetId === id
  )
  if (scene) {
    return scene.plateAssetId === id
      ? { kind: 'scene', name: scene.name }
      : { kind: 'prop', name: scene.name }
  }
  if (shot.boardAssetId && shot.boardAssetId === id) {
    return { kind: 'board', name: `Shot ${shot.index + 1} storyboard` }
  }
  if (shot.imageAssetId && shot.imageAssetId === id) {
    return { kind: 'keyframe', name: `Shot ${shot.index + 1} four-panel keyframes` }
  }
  return { kind: 'extra', name: 'Additional reference image' }
}

const REF_OWNER_JOB: Record<ShotRefOwnerKind, (name: string) => string> = {
  character: (name) =>
    `Character sheet for "${name}". Match the face, hair, build, age, and outfit. Use it for character identity only. Do not copy the layout or use it as the opening frame.`,
  scene: (name) =>
    `Scene reference for "${name}". Preserve the space, materials, weather, and lighting. Stay in this location and do not reproduce the reference grid.`,
  prop: (name) => `Prop reference for "${name}". Preserve only the props used in the story.`,
  board: (name) => `${name}: Follow the composition, blocking, and action order. Do not reproduce grids, line art, or numbers.`,
  keyframe: (name) => `${name}: Use it only for the action order. Do not reproduce grids or numbers.`,
  extra: () => 'Additional reference image: Match the character, wardrobe, product, or visual style shown.'
}

/**
 * 실제로 전송하는 순서대로 참조 이미지 번호를 붙인다.
 * 번호별로 해당 캐릭터나 위치를 설명한다.
 */
export function shotRefRoster(
  shot: Shot,
  project: Project,
  ids: ID[],
  tail?: string
): string {
  const usable = (ids ?? []).filter(Boolean)
  if (!usable.length && !tail) return ''
  const lines = usable.map((id, i) => {
    const owner = shotRefOwner(id, shot, project)
    return `Image ${i + 1}: ${REF_OWNER_JOB[owner.kind](owner.name)}`
  })
  if (tail) lines.push(tail)
  return [
    'Reference image guide (follow the numbering exactly and use the images to preserve identity and space):',
    ...lines
  ].join('\n')
}

export function composeShotImagePrompt(
  shot: Shot,
  project: Project,
  basePrompt: string
): string {
  const chars = subjectsForShot(shot, project)
  const scene = sceneForShot(shot, project)
  const aesthetic = project.script?.aesthetic?.trim()
  const roster = shotRefRoster(shot, project, collectShotRefIds(shot, project).ids)
  const parts = [roster, basePrompt.trim()]
  const ar = project.settings?.aspectRatio || '16:9'
  parts.push(`Use exactly a ${ar} aspect ratio for the entire image.`)
  const dialogueSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const filmChapter =
    project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter'
  if ((shot.audioMode || 'h3-dialogue') === 'h3-dialogue' && dialogueSpeaker) {
    parts.push(
      `Show "${dialogueSpeaker}" speaking on camera. In the opening composition, clearly show their face and mouth and make them the sole visual focus. A medium close-up, close-up, over-the-shoulder shot, or two-shot is acceptable. Other characters may listen or react silently without competing for attention.`
    )
  }
  if (shot.boardAssetId && videoRequiresStoryboard(project)) {
    parts.push(
      filmChapter
        ? 'Read the attached four- or eight-panel color storyboard from top left to bottom right. Match the first panel\'s opening composition, blocking, orientation, weather, and props. Use the text for subsequent action. Output a single opening frame without borders, numbering, or a collage.'
        : 'Read the attached six-panel storyboard from top left to bottom right. Match the first panel\'s opening composition, blocking, orientation, and prop state. Use the text for subsequent action. Output one fully colored opening frame without borders, line art, numbering, or a collage.'
    )
  } else if (!videoRequiresStoryboard(project)) {
    parts.push(
      'Create exactly four keyframe panels in a 2×2 grid. From top left to bottom right, show the initial state, preparation, central event, and final state. Match the character reference\'s face and outfit and the scene reference\'s location and lighting. Avoid blank panels or unrelated posters.'
    )
  }
  if (chars.length) {
    parts.push(
      'Match the character turnaround exactly, including face, hair, build, clothing, and palette:' +
        chars
          .map((c) => `${c.name} — ${c.description}`)
          .join('；')
    )
  }
  if (scene) {
    parts.push(
      `Match the location in the scene reference "${scene.name}": ${scene.description}${scene.mainAnchor ? `. Main anchor: ${scene.mainAnchor}` : ''}. Use the location shown in the four-panel reference without reproducing its panels. Populate the empty scene only with the characters from the turnaround references. Do not add locations or bystanders.`
    )
  }
  if (project.pipelineMode === 'remake') {
    parts.push(
      'Replace any product shown with the uploaded product reference, matching its appearance, packaging, logo, and colors exactly. Do not reuse the original branded product from the source video.'
    )
  }
  if (aesthetic) parts.push(aesthetic)
  const look = lookFromScript(project.script)
  parts.push(mediumLockText(look))
  return parts.filter(Boolean).join('\n')
}
