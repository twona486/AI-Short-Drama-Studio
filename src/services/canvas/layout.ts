import type { CanvasEdge, CanvasGraph, CanvasNode, Project } from '@/types'
import { emptyCanvas, normalizeVideoGenModel, stillModeForVideoModel, videoStillNeedsCanvas, type VideoGenModel } from '@/types/canvas'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { boundSubjectIds } from '@/utils/consistency'
import { needsShotFrames, shotUsesFrames, stillModeFromNode, stillTypeForMode } from '@/utils/videoStill'
import { useSettingsStore } from '@/stores/settings'

export const NODE_W = 240
const GAP = 18
const PAD = 20
const HEAD = 44
const COL_GAP = 32
const SCRIPT_W = 460
const SCRIPT_H = 720
/** 이미지 아래 이름 표시줄 높이 */
const NODE_CHROME = 36
/** 내레이션 노드는 별도 카드이며 스토리보드 이미지 비율과 무관하다. */
export const AUDIO_NODE_H = 128

function aspectValue(ar?: string): number {
  const [a, b] = String(ar || '16:9').split(':').map(Number)
  if (!a || !b) return 16 / 9
  return a / b
}

/** 캔버스 이미지 영역은 영상 비율을 따라 세로 영상이 잘리지 않게 한다. */
export function pipelineNodeHeight(aspectRatio?: string): number {
  return NODE_CHROME + Math.round(NODE_W / aspectValue(aspectRatio))
}

/** CSS aspect-ratio 값. 예를 들어 16 / 9다. */
export function cssAspectRatio(ar?: string): string {
  const [a, b] = String(ar || '16:9').split(':')
  const w = Number(a)
  const h = Number(b)
  if (!w || !h) return '16 / 9'
  return `${w} / ${h}`
}

function groupBox(rows: number, cols: number, nodeH: number) {
  const r = Math.max(1, rows)
  const c = Math.max(1, cols)
  return {
    width: PAD * 2 + c * NODE_W + (c - 1) * GAP,
    height: HEAD + PAD + r * nodeH + Math.max(0, r - 1) * GAP + PAD
  }
}

function cell(row: number, col: number, nodeH: number) {
  return {
    x: PAD + col * (NODE_W + GAP),
    y: HEAD + PAD + row * (nodeH + GAP)
  }
}

function persistStatus(
  prevStatus: CanvasNode['status'] | undefined,
  hasAsset: boolean
): CanvasNode['status'] {
  // 재시작 시 디스크에 남아 있는 running 상태를 활성 생성으로 취급하지 않는다.
  if (!prevStatus || prevStatus === 'running' || prevStatus === 'pending') {
    return hasAsset ? 'success' : 'idle'
  }
  return prevStatus
}

function fallbackStillMode() {
  try {
    return stillModeForVideoModel('h3', useSettingsStore().config.video)
  } catch {
    return 'identity' as const
  }
}

function activeVideoProfile() {
  try {
    return useSettingsStore().config.video
  } catch {
    return undefined
  }
}

/** 제작 환경의 기본 영상 모델이다. 선택하지 않으면 노드 연결의 기본값을 사용한다. */
function defaultVideoModelPref(): VideoGenModel | undefined {
  try {
    return useSettingsStore().config.defaultVideoModel
  } catch {
    return undefined
  }
}

function pos(
  prev: Map<string, CanvasNode>,
  id: string,
  fallback: { x: number; y: number }
) {
  return prev.get(id)?.position ?? fallback
}

/** 그룹 노드는 상대 좌표를 저장한다. 자유 노드를 추가할 때는 절대 좌표를 사용한다. */
export function absoluteCanvasPosition(
  nodes: CanvasNode[],
  node: Pick<CanvasNode, 'position' | 'parentGroupId'>
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let pid = node.parentGroupId
  const byId = new Map(nodes.map((item) => [item.id, item]))
  const seen = new Set<string>()
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    const parent = byId.get(pid)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    pid = parent.parentGroupId
  }
  return { x, y }
}

export function nextFreeformPosition(
  nodes: CanvasNode[],
  opts: {
    source?: CanvasNode
    click?: { x: number; y: number }
  }
): { x: number; y: number } {
  let pos: { x: number; y: number }
  if (opts.source) {
    const abs = absoluteCanvasPosition(nodes, opts.source)
    pos = { x: abs.x + NODE_W + 48, y: abs.y }
  } else if (opts.click && Number.isFinite(opts.click.x) && Number.isFinite(opts.click.y)) {
    pos = { x: opts.click.x, y: opts.click.y }
  } else {
    const groups = nodes.filter((n) => n.type === 'groupFrame')
    if (groups.length) {
      const right = Math.max(
        ...groups.map((g) => g.position.x + (Number(g.data.width) || NODE_W))
      )
      pos = { x: right + 48, y: groups[0].position.y + 48 }
    } else {
      pos = { x: 120, y: 120 }
    }
  }
  const taken = nodes.filter((n) => n.type === 'imageGen' || n.type === 'videoGen')
  let guard = 0
  while (
    guard < 24 &&
    taken.some(
      (n) => Math.abs(n.position.x - pos.x) < 36 && Math.abs(n.position.y - pos.y) < 36
    )
  ) {
    pos = { x: pos.x + 36, y: pos.y + 36 }
    guard += 1
  }
  return pos
}

/** 상대 좌표를 잘못 사용한 노드를 샷 영상 그룹의 오른쪽으로 옮긴다. */
export function rescueStrandedFreeformNodes(nodes: CanvasNode[]): CanvasNode[] | null {
  const groups = nodes.filter((n) => n.type === 'groupFrame')
  const free = nodes.filter(
    (n) => (n.type === 'imageGen' || n.type === 'videoGen') && !n.parentGroupId
  )
  if (!free.length) return null
  const videos = groups.find((g) => g.id === 'group-videos') || groups[groups.length - 1]
  const clusterX = videos ? videos.position.x : Math.max(...groups.map((g) => g.position.x), 0)
  const clusterY = videos ? videos.position.y : Math.min(...groups.map((g) => g.position.y), 0)
  const clusterW = videos ? Number(videos.data.width) || NODE_W : NODE_W
  const stranded = free.filter((n) => {
    if (!groups.length) return false
    return n.position.x + NODE_W < clusterX - 80
  })
  if (!stranded.length) return null
  const startX = clusterX + clusterW + 48
  const startY = clusterY + 48
  const ids = new Set(stranded.map((n) => n.id))
  return nodes.map((n) => {
    if (!ids.has(n.id)) return n
    const i = stranded.findIndex((item) => item.id === n.id)
    return {
      ...n,
      parentGroupId: undefined,
      position: {
        x: startX + (i % 3) * (NODE_W + 36),
        y: startY + Math.floor(i / 3) * 220
      }
    }
  })
}

export function rebuildCanvasGraph(project: Project, preservePositions = true): CanvasGraph {
  const prevList = project.canvas?.nodes ?? []
  const subjects = project.subjects ?? []
  const storyProps = project.props ?? []
  const scenes = project.scenes ?? []
  const shots = project.shots
  const hasPipelineData = subjects.length > 0 || storyProps.length > 0 || scenes.length > 0 || shots.length > 0
  // 워크플로 데이터가 없으면 사용자가 추가한 노드만 배치한다.
  const bare = !hasPipelineData
  const hasScriptNode = prevList.some((n) => n.id === 'script' || n.type === 'script')
  // 노드와 워크플로 데이터가 없으면 캔버스를 비워 둔다.
  if (!hasPipelineData && !hasScriptNode && !prevList.length) {
    return project.canvas ?? emptyCanvas()
  }
  const hadGroups = prevList.some((n) => n.type === 'groupFrame')
  const shotVideoPrev = prevList.filter((n) => n.type === 'shotVideo')
  const defaultStill = fallbackStillMode()
  // 시작·끝 프레임 샷에는 키프레임과 개요판 노드를 추가하지 않는다.
  // 이미 생성한 키프레임은 캔버스에 유지한다.
  const shotsNeedingStills = shots.filter(
    (s) => !shotUsesFrames(s, project) || s.imageAssetId || s.boardAssetId
  )
  const stillsWanted =
    shots.length > 0
      ? shotsNeedingStills.length > 0
      : (project.settings?.h3ShotChainMode || 'auto') !== 'fl2va'
  const useStills =
    stillsWanted &&
    (shotVideoPrev.length
      ? shotVideoPrev.some((n) => videoStillNeedsCanvas(stillModeFromNode(n)))
      : videoStillNeedsCanvas(defaultStill))
  const stillGroupLabel = shotVideoPrev.some((n) => stillModeFromNode(n) === 'storyboard')
    ? '스토리 개요판'
    : '샷 키프레임'
  const videosHomed =
    shots.length === 0 ||
    !prevList.some((n) => n.type === 'shotVideo') ||
    prevList
      .filter((n) => n.type === 'shotVideo')
      .every((n) => n.parentGroupId === 'group-videos')
  // 프로젝트나 개별 샷에서 시작·끝 프레임을 사용하면 프레임 그룹을 표시한다.
  // 프레임 그룹을 샷 키프레임과 샷 영상 그룹 사이에 배치한다.
  // 워크플로와 에이전트도 needsShotFrames로 동일하게 판단한다.
  const needFrames = shots.length > 0 && needsShotFrames(project)
  // 그룹을 처음 삽입할 때 기존 좌표의 겹침을 피하려고 뒤쪽 그룹을 한 번 재배치한다.
  const framesJustAdded = needFrames && !prevList.some((n) => n.id === 'group-frames')
  const layoutReady = bare
    ? shots.length === 0 || (prevList.some((n) => n.id === 'group-videos') && videosHomed)
    : hadGroups &&
      prevList.some((n) => n.id === 'group-audio') &&
      prevList.some((n) => n.id === 'group-videos') &&
      videosHomed &&
      (shots.length === 0 ||
        !useStills ||
        prevList.some((n) => n.type === 'shotBoard' || n.type === 'shotImage'))
  const keepPositions = preservePositions && !framesJustAdded
  const prev = new Map((keepPositions && layoutReady ? prevList : []).map((n) => [n.id, n]))
  const prevAny = new Map(prevList.map((n) => [n.id, n]))
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const groups: CanvasGraph['groups'] = []
  const shotH = pipelineNodeHeight(project.settings?.aspectRatio)
  const sheetH = pipelineNodeHeight('16:9')

  const prevScript = prevAny.get('script')
  const scriptW = prevScript?.data.width || SCRIPT_W
  const scriptH = prevScript?.data.height || SCRIPT_H
  const keepScript = !bare || hasScriptNode
  const scriptPos =
    prevScript && !prevScript.parentGroupId
      ? prevScript.position
      : { x: 24, y: 24 }

  if (keepScript) {
    nodes.push({
      id: 'script',
      type: 'script',
      position: scriptPos,
      data: {
        label: project.script?.topic || project.name || '대본',
        width: scriptW,
        height: scriptH,
        kind: 'scriptDoc'
      },
      status: persistStatus(prevScript?.status, Boolean(project.script?.content))
    })
  }

  const subBox = groupBox(subjects.length, 1, sheetH)
  const propBox = groupBox(storyProps.length, 1, sheetH)
  const scnBox = groupBox(scenes.length, 1, sheetH)
  const shotBox = groupBox(shots.length, 1, shotH)
  const frameBox = groupBox(shots.length, 1, shotH)
  const vidBox = groupBox(shots.length, 1, shotH)
  const audBox = groupBox(shots.length, 1, AUDIO_NODE_H)
  const expBox = groupBox(1, 2, shotH)

  let x = (keepScript ? scriptPos.x + scriptW : 24) + COL_GAP
  const y = keepScript ? scriptPos.y : 24

  function pushGroup(
    id: string,
    label: string,
    kind: string,
    box: { width: number; height: number }
  ) {
    nodes.push({
      id,
      type: 'groupFrame',
      position: pos(prev, id, { x, y }),
      data: { label, width: box.width, height: box.height, kind },
      status: 'idle'
    })
    groups.push({ id, label, nodeIds: [] })
    x += box.width + COL_GAP
  }

  if (!bare || subjects.length) pushGroup('group-subjects', '캐릭터', 'subject', subBox)
  if (storyProps.length) pushGroup('group-props', '반복 등장 소품', 'prop', propBox)
  if (!bare || scenes.length) pushGroup('group-scenes', '장면 기준 이미지', 'scene', scnBox)
  if ((!bare || shots.length) && useStills) {
    pushGroup('group-shots', stillGroupLabel, 'shot', shotBox)
  }
  if ((!bare || shots.length) && needFrames) {
    pushGroup('group-frames', '시작·끝 프레임', 'frames', frameBox)
  }
  if (!bare || shots.length) {
    pushGroup('group-videos', '샷 영상', 'video', vidBox)
  }
  if (!bare) {
    pushGroup('group-audio', '내레이션', 'audio', audBox)
    pushGroup('group-export', '영상 합성', 'export', expBox)
  }

  function attach(groupId: string, node: CanvasNode) {
    if (!nodes.some((item) => item.id === groupId)) return
    const old = prevAny.get(node.id)
    const sameParent = old?.parentGroupId === groupId
    if (
      keepPositions &&
      sameParent === false &&
      old &&
      old.parentGroupId === undefined &&
      node.type !== 'shotVideo' &&
      prevList.some((n) => n.id === node.id)
    ) {
      nodes.push({ ...node, position: old.position, parentGroupId: undefined })
      return
    }
    node.parentGroupId = groupId
    // 그룹을 옮긴 노드에는 새 그룹 기준의 상대 좌표를 사용한다.
    node.position = sameParent ? pos(prev, node.id, node.position) : node.position
    nodes.push(node)
    const g = groups.find((x) => x.id === groupId)
    g?.nodeIds.push(node.id)
  }

  subjects.forEach((s, i) => {
    const id = `subject:${s.id}`
    attach('group-subjects', {
      id,
      type: 'subject',
      position: cell(i, 0, sheetH),
      data: { subjectId: s.id, label: s.name },
      status: persistStatus(prev.get(id)?.status, Boolean(s.designSheetAssetId)),
      parentGroupId: 'group-subjects'
    })
    if (keepScript) {
      edges.push({
        id: `e-script-${id}`,
        source: 'script',
        target: id,
        sourceHandle: 'out',
        targetHandle: 'in'
      })
    }
  })

  storyProps.forEach((item, i) => {
    const id = `prop:${item.id}`
    attach('group-props', {
      id,
      type: 'prop',
      position: cell(i, 0, sheetH),
      data: { propId: item.id, label: item.name },
      status: persistStatus(prev.get(id)?.status, Boolean(item.designSheetAssetId)),
      parentGroupId: 'group-props'
    })
    if (keepScript) {
      edges.push({
        id: `e-script-${id}`,
        source: 'script',
        target: id,
        sourceHandle: 'out',
        targetHandle: 'in'
      })
    }
  })

  scenes.forEach((s, i) => {
    const id = `scene:${s.id}`
    attach('group-scenes', {
      id,
      type: 'scene',
      position: cell(i, 0, sheetH),
      data: { sceneId: s.id, label: s.name },
      status: persistStatus(prev.get(id)?.status, Boolean(s.plateAssetId)),
      parentGroupId: 'group-scenes'
    })
    if (keepScript) {
      edges.push({
        id: `e-script-${id}`,
        source: 'script',
        target: id,
        sourceHandle: 'out',
        targetHandle: 'in'
      })
    }
  })

  shots.forEach((shot, i) => {
    const vidId = `shotVideo:${shot.id}`
    const audId = `audio:${shot.id}`
    const prevVid = prev.get(vidId) || prevAny.get(vidId)
    const model = normalizeVideoGenModel(prevVid?.data.videoModel ?? defaultVideoModelPref())
    const resolvedStill =
      prevVid?.data.videoStillMode === 'identity' ||
      prevVid?.data.videoStillMode === 'keyframe' ||
      prevVid?.data.videoStillMode === 'storyboard'
        ? prevVid.data.videoStillMode
        : stillModeForVideoModel(model, activeVideoProfile())
    // 시작·끝 프레임 샷에서 기존 키프레임과 개요판은 유지한다.
    const keepExistingStill = Boolean(shot.imageAssetId || shot.boardAssetId)
    const stillType =
      shotUsesFrames(shot, project) && !keepExistingStill ? null : stillTypeForMode(resolvedStill)
    const stillId = stillType ? `${stillType}:${shot.id}` : ''
    if (stillType && stillId) {
      const prevStillNode = prev.get(stillId) || prevAny.get(stillId)
      attach('group-shots', {
        id: stillId,
        type: stillType,
        position: cell(i, 0, shotH),
        data: {
          shotId: shot.id,
          label: `${i + 1}. ${shot.title}`,
          aspectRatio: prevStillNode?.data.aspectRatio ?? project.settings.aspectRatio
        },
        status: persistStatus(
          prev.get(stillId)?.status,
          Boolean(stillType === 'shotBoard' ? shot.boardAssetId : shot.imageAssetId)
        ),
        parentGroupId: 'group-shots'
      })
    }
    if (needFrames) {
      const frameId = `shotFrames:${shot.id}`
      const prevFrame = prev.get(frameId) || prevAny.get(frameId)
      attach('group-frames', {
        id: frameId,
        type: 'shotFrames',
        position: cell(i, 0, shotH),
        data: {
          shotId: shot.id,
          label: `${i + 1}. ${shot.title}`,
          aspectRatio: prevFrame?.data.aspectRatio ?? project.settings.aspectRatio
        },
        status: persistStatus(
          prev.get(frameId)?.status,
          Boolean(shot.firstFrameAssetId && shot.lastFrameAssetId)
        ),
        parentGroupId: 'group-frames'
      })
    }
    attach('group-videos', {
      id: vidId,
      type: 'shotVideo',
      position: cell(i, 0, shotH),
      data: {
        shotId: shot.id,
        label: `${i + 1}. ${shot.title}`,
        videoModel: prevVid?.data.videoModel ?? defaultVideoModelPref(),
        videoResolution: prevVid?.data.videoResolution,
        videoStillMode: resolvedStill,
        aspectRatio: prevVid?.data.aspectRatio ?? project.settings.aspectRatio
      },
      status: persistStatus(prevVid?.status, Boolean(shot.videoAssetId)),
      parentGroupId: 'group-videos'
    })
    if (!bare) {
      attach('group-audio', {
        id: audId,
        type: 'audio',
        position: cell(i, 0, AUDIO_NODE_H),
        data: {
          shotId: shot.id,
          label: needsExternalTts(shot, project) ? '후반 TTS' : effectiveShotAudioMode(shot).startsWith('h3-') ? 'H3 음성' : '내레이션 없음'
        },
        status: persistStatus(
          prev.get(audId)?.status,
          Boolean(shot.audioAssetId) || !needsExternalTts(shot, project)
        ),
        parentGroupId: 'group-audio'
      })
    }

    const visualTarget = stillType && stillId ? stillId : vidId
    const frameId = needFrames ? `shotFrames:${shot.id}` : ''
    const wanted = boundSubjectIds(shot, subjects).slice(0, 2)
    wanted.forEach((sid, idx) => {
      const src = `subject:${sid}`
      if (!nodes.some((n) => n.id === src)) return
      edges.push({
        id: `e-${src}-${visualTarget}-${idx}`,
        source: src,
        target: visualTarget,
        sourceHandle: 'out',
        targetHandle: stillType ? (idx === 0 ? 'char1' : 'char2') : 'in'
      })
      // 캐릭터 노드를 프레임에도 연결해 같은 인물을 합성에 사용한다.
      if (frameId) {
        edges.push({
          id: `e-${src}-${frameId}-${idx}`,
          source: src,
          target: frameId,
          sourceHandle: 'out',
          targetHandle: idx === 0 ? 'char1' : 'char2'
        })
      }
    })
    const sceneId = shot.sceneId || scenes[0]?.id
    if (sceneId) {
      edges.push({
        id: `e-scene-${sceneId}-${visualTarget}`,
        source: `scene:${sceneId}`,
        target: visualTarget,
        sourceHandle: 'out',
        targetHandle: stillType ? 'scene' : 'in'
      })
      if (frameId) {
        edges.push({
          id: `e-scene-${sceneId}-${frameId}`,
          source: `scene:${sceneId}`,
          target: frameId,
          sourceHandle: 'out',
          targetHandle: 'scene'
        })
      }
    }
    if (frameId) {
      edges.push({
        id: `e-${frameId}-${vidId}`,
        source: frameId,
        target: vidId,
        sourceHandle: 'out',
        targetHandle: 'frames'
      })
    }
    if (stillType && stillId) {
      edges.push({
        id: `e-${stillId}-${vidId}`,
        source: stillId,
        target: vidId,
        sourceHandle: 'out',
        targetHandle: 'image'
      })
    }
    if (!bare) {
      edges.push({
        id: `e-${audId}-export`,
        source: audId,
        target: 'export',
        sourceHandle: 'out',
        targetHandle: 'in'
      })
      edges.push({
        id: `e-${vidId}-export`,
        source: vidId,
        target: 'export',
        sourceHandle: 'out',
        targetHandle: 'in'
      })
    }
  })

  if (!bare) {
    const hasFinal = Boolean(project.finalVideoAssetId)
    attach('group-export', {
      id: 'export',
      type: 'export',
      position: cell(0, 0, shotH),
      data: { label: '영상 합성' },
      status: persistStatus(prev.get('export')?.status, hasFinal),
      parentGroupId: 'group-export'
    })
    attach('group-export', {
      id: 'final',
      type: 'final',
      position: cell(0, 1, shotH),
      data: { label: '영상 미리보기' },
      status: persistStatus(prev.get('final')?.status, hasFinal),
      parentGroupId: 'group-export'
    })
    edges.push({
      id: 'e-export-final',
      source: 'export',
      target: 'final',
      sourceHandle: 'out',
      targetHandle: 'in'
    })
  }

  // 레이아웃을 정리할 때 사용자가 추가한 자유 이미지나 영상 노드를 유지한다.
  const freeNodes = prevList.filter((node) => node.type === 'imageGen' || node.type === 'videoGen')
  const freeIds = new Set(freeNodes.map((node) => node.id))
  for (const node of freeNodes) {
    if (!nodes.some((item) => item.id === node.id)) nodes.push({ ...node, parentGroupId: undefined })
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  for (const edge of project.canvas?.edges ?? []) {
    if (!freeIds.has(edge.source) && !freeIds.has(edge.target)) continue
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    if (!edges.some((item) => item.id === edge.id)) edges.push(edge)
  }

  const viewport = project.canvas?.viewport ?? emptyCanvas().viewport
  return { nodes, edges, groups, viewport }
}

export function nodeByEntity(graph: CanvasGraph, type: CanvasNode['type'], entityId: string) {
  return graph.nodes.find((n) => {
    if (n.type !== type) return false
    if (type === 'subject' || type === 'subjectProps') return n.data.subjectId === entityId
    if (type === 'scene' || type === 'sceneProps') return n.data.sceneId === entityId
    return n.data.shotId === entityId
  })
}
