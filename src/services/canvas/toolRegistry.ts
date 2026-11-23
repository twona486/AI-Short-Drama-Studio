import { useProjectStore, useSettingsStore } from '@/stores'
import { needsExternalTts } from '@/utils/shot'
import { stillModeForShot, shotsMissingKeyframe, shotsMissingStoryboard, needsShotFrames, shotUsesFrames } from '@/utils/videoStill'
import { inferVisualStyleFromText } from '@/utils/visualStyle'
import { topicFromBrief } from '@/utils/storyBrief'
import { controlledSignal, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { VIDEO_GEN_CONCURRENCY } from './jobs'
import {
  runCanvasNode,
  generateMissingSheets,
  generateMissingPlates,
  generateMissingBoards,
  generateMissingImages,
  generateMissingVideos,
  generateMissingAudio,
  generateShotFramePair
} from './runner'
import { nextExtractStage, type ExtractStage } from './pipeline'
import { revealCanvas } from './canvasBridge'
import { appendCanvasReferenceSource, canvasNodeProducesImage, resolvedCanvasReferenceAssetIds } from './references'
import { rebuildCanvasGraph } from './layout'
import type { AgentTaskGraph, AgentTaskGraphNode } from '@/types/pipeline'

export type AgentToolName =
  | 'seed_script'
  | 'generate_play'
  | 'continue_play'
  | 'generate_storyboard'
  | 'extract_cast'
  | 'approve_play'
  | 'revise_shot'
  | 'generate_sheet'
  | 'generate_all_sheets'
  | 'generate_all_prop_sheets'
  | 'generate_prop_sheet'
  | 'generate_scene'
  | 'generate_all_scenes'
  | 'generate_shot_board'
  | 'generate_all_boards'
  | 'generate_shot_image'
  | 'generate_all_images'
  | 'generate_shot_frames'
  | 'generate_all_frames'
  | 'generate_video'
  | 'generate_all_videos'
  | 'generate_audio'
  | 'generate_all_audio'
  | 'sync_canvas'
  | 'focus_node'
  | 'create_image_node'
  | 'create_video_node'
  | 'connect_nodes'
  | 'delete_node'
  | 'arrange_canvas'
  | 'check_project'
  | 'update_node'
  | 'run_node'
  | 'optimize_node_prompt'
  | 'remember'
  | 'forget'

export interface AgentToolAction {
  tool: AgentToolName
  text?: string
  subjectId?: string
  sceneId?: string
  shotId?: string
  nodeId?: string
  /** 连线 / 派生新节点的上游节点 id */
  sourceNodeId?: string
  /** 连线的下游节点 id */
  targetNodeId?: string
  /** 节点显示名（重命名用） */
  nodeLabel?: string
  visualPrompt?: string
  imagePrompt?: string
  videoPrompt?: string
  compiledVideoPrompt?: string
  voiceover?: string
  duration?: number
  cameraMovement?: 'push' | 'pull' | 'pan' | 'tilt' | 'static' | 'orbit'
  extractStage?: ExtractStage
}

export interface ToolExecutionContext {
  signal?: AbortSignal
  onLog: (message: string) => void
}

export interface ToolEstimate {
  calls: number
  seconds: number
}

interface ToolDefinition {
  name: AgentToolName
  phase: number
  timeoutMs: number
  required?: Array<keyof AgentToolAction>
  estimate: (action: AgentToolAction) => ToolEstimate
  execute: (action: AgentToolAction, ctx: ToolExecutionContext) => Promise<string>
}

export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly code: 'invalid_action' | 'timeout' | 'cancelled' | 'execution_failed' | 'postcondition_failed',
    readonly recoverable = false
  ) {
    super(message)
  }
}

function abortError(tool: string) {
  return new AgentToolError('사용자가 작업을 중단했습니다.', tool, 'cancelled', false)
}

async function withControl<T>(
  tool: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal
): Promise<T> {
  const control = controlledSignal(parent, timeoutMs)
  try {
    if (control.signal.aborted) throw abortError(tool)
    return await run(control.signal)
  } catch (error: any) {
    if (error instanceof AgentToolError) throw error
    if (isTimeoutAbort(error, control.signal) && control.signal.aborted) {
      throw new AgentToolError(
        `이 단계가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다. 다시 시도하세요.`,
        tool,
        'timeout',
        true
      )
    }
    if (isAbortError(error) || control.signal.aborted) throw abortError(tool)
    throw error
  } finally {
    control.cleanup()
  }
}

function counts() {
  const p = useProjectStore().current
  return {
    sheets: (p?.subjects ?? []).filter((s) => !s.designSheetAssetId).length,
    props:
      (p?.subjects ?? []).filter((s) => !s.propSheetAssetId).length
      + (p?.scenes ?? []).filter((s) => !s.propSheetAssetId).length,
    scenes: (p?.scenes ?? []).filter((s) => !s.plateAssetId).length,
    boards: p ? shotsMissingStoryboard(p).length + shotsMissingKeyframe(p).length : 0,
    images: p ? shotsMissingKeyframe(p).length : 0,
    videos: (p?.shots ?? []).filter((s) => !s.videoAssetId).length,
    audio: (p?.shots ?? []).filter((s) => needsExternalTts(s, p) && !s.audioAssetId).length
  }
}

export interface ToolPreflight {
  state: 'ready' | 'skip' | 'repair'
  detail?: string
  actions?: AgentToolAction[]
}

function shotFor(action: AgentToolAction) {
  return useProjectStore().current?.shots.find((shot) => shot.id === action.shotId)
}

/** Deterministic dependency check. Repairs are ordinary registered tools and remain bounded by AgentLoop. */
export function preflightRegisteredTool(raw: unknown): ToolPreflight {
  const action = validateToolAction(raw)
  const project = useProjectStore().current
  if (!project) return { state: 'ready' }

  if (action.tool === 'extract_cast' && !(project.script?.playReady && project.script.content?.trim())) {
    return {
      state: 'repair',
      detail: '노드를 추출하려면 완성된 대본이 필요합니다. 먼저 대본을 작성합니다.',
      actions: [{ tool: 'generate_play' }]
    }
  }

  if (action.tool === 'generate_shot_image') {
    const shot = shotFor(action)
    if (!shot) throw new AgentToolError(`스토리보드 샷 ${action.shotId}을 찾을 수 없습니다.`, action.tool, 'invalid_action', true)
    if (shot.imageAssetId) return { state: 'skip', detail: `${shot.index + 1}번 샷에 키프레임이 이미 있습니다.` }
    if (stillModeForShot(shot, project) !== 'keyframe') {
      return { state: 'skip', detail: `${shot.index + 1}번 샷의 영상 모델에는 키프레임이 필요 없습니다.` }
    }
    const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
    const missingSubjects = (project.subjects ?? []).filter(
      (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
    )
    const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
    const repairs: AgentToolAction[] = missingSubjects.map((subject) => ({ tool: 'generate_sheet', subjectId: subject.id }))
    if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
    if (repairs.length) {
      return { state: 'repair', detail: `${shot.index + 1}번 샷에 캐릭터 설정이나 장면이 없습니다. 먼저 보완한 뒤 키프레임을 생성합니다.`, actions: repairs }
    }
  }

  if (action.tool === 'generate_shot_frames') {
    const shot = shotFor(action)
    if (!shot) throw new AgentToolError(`스토리보드 샷 ${action.shotId}을 찾을 수 없습니다.`, action.tool, 'invalid_action', true)
    if (!shotUsesFrames(shot, project)) {
      return { state: 'skip', detail: `${shot.index + 1}번 샷은 시작·끝 프레임 생성이 필요한 모드가 아닙니다.` }
    }
    if (shot.firstFrameAssetId && shot.lastFrameAssetId) {
      return { state: 'skip', detail: `${shot.index + 1}번 샷의 시작·끝 프레임이 이미 있습니다.` }
    }
    const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
    const missingSubjects = (project.subjects ?? []).filter(
      (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
    )
    const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
    const repairs: AgentToolAction[] = missingSubjects.map((subject) => ({ tool: 'generate_sheet', subjectId: subject.id }))
    if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
    if (repairs.length) {
      return { state: 'repair', detail: `${shot.index + 1}번 샷에 캐릭터 설정이나 장면이 없습니다. 먼저 보완한 뒤 시작·끝 프레임을 생성합니다.`, actions: repairs }
    }
  }

  if (action.tool === 'generate_shot_board' || action.tool === 'generate_video' || action.tool === 'generate_audio') {
    const shot = shotFor(action)
    if (!shot) throw new AgentToolError(`스토리보드 샷 ${action.shotId}을 찾을 수 없습니다.`, action.tool, 'invalid_action', true)

    if (action.tool === 'generate_video') {
      if (shot.videoAssetId) return { state: 'skip', detail: `${shot.index + 1}번 샷의 영상이 이미 있습니다.` }
      const fl2vaShot = shotUsesFrames(shot, project)
      const stillMode = stillModeForShot(shot, project)
      if (!fl2vaShot && stillMode === 'storyboard' && !shot.boardAssetId) {
        return {
          state: 'repair',
          detail: `${shot.index + 1}번 샷에 스토리 개요판이 없어 먼저 생성합니다.`,
          actions: [{ tool: 'generate_shot_board', shotId: shot.id }]
        }
      }
      if (!fl2vaShot && stillMode === 'keyframe' && !shot.imageAssetId) {
        return {
          state: 'repair',
          detail: `${shot.index + 1}번 샷에 4분할 키프레임이 없어 먼저 생성합니다.`,
          actions: [{ tool: 'generate_shot_image', shotId: shot.id }]
        }
      }
      // 首尾帧模式：视频吃的就是这两张帧，缺了必须先画，否则这一镜等于没走首尾帧。
      // 只在两张都缺时补一次——画过一半或用户自己指定过就不再拦，避免补帧失败反复重来。
      if (fl2vaShot && !shot.firstFrameAssetId && !shot.lastFrameAssetId) {
        return {
          state: 'repair',
          detail: `${shot.index + 1}번 샷에는 시작·끝 프레임이 필요하므로 먼저 생성합니다.`,
          actions: [{ tool: 'generate_shot_frames', shotId: shot.id }]
        }
      }
      const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
      const missingSubjects = (project.subjects ?? []).filter(
        (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
      )
      const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
      const repairs: AgentToolAction[] = missingSubjects.map((subject) => ({ tool: 'generate_sheet', subjectId: subject.id }))
      if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
      if (repairs.length) {
        return { state: 'repair', detail: `${shot.index + 1}번 샷에 영상의 캐릭터나 장면 참조 이미지가 없어 먼저 보완합니다.`, actions: repairs }
      }
    }

    if (action.tool === 'generate_audio') {
      if (!needsExternalTts(shot, project)) return { state: 'skip', detail: `${shot.index + 1}번 샷은 H3가 음성을 생성하므로 별도의 TTS가 필요 없습니다.` }
      if (shot.audioAssetId) return { state: 'skip', detail: `${shot.index + 1}번 샷의 내레이션이 이미 있습니다.` }
    }

    if (action.tool === 'generate_shot_board') {
      const stillMode = stillModeForShot(shot, project)
      if (stillMode === 'identity') {
        return { state: 'skip', detail: `${shot.index + 1}번 샷의 영상 모델에 스토리 개요판이나 키프레임이 필요 없습니다.` }
      }
      if (stillMode === 'keyframe') {
        if (shot.imageAssetId) return { state: 'skip', detail: `${shot.index + 1}번 샷에 키프레임이 이미 있습니다.` }
      } else if (shot.boardAssetId) return { state: 'skip', detail: `${shot.index + 1}번 샷의 스토리 개요판이 이미 있습니다.` }
      const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
      const missingFour = (project.subjects ?? []).filter(
        (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
      )
      const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
      const repairs: AgentToolAction[] = [
        ...missingFour.map((subject) => ({ tool: 'generate_sheet' as const, subjectId: subject.id }))
      ]
      if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
      if (repairs.length) {
        return { state: 'repair', detail: `${shot.index + 1}번 샷에 캐릭터나 장면 참조 이미지가 없어 먼저 보완합니다.`, actions: repairs }
      }
    }
  }

  if (action.tool === 'generate_all_sheets') {
    if (!(project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) {
      return { state: 'skip', detail: '4면 설정 이미지가 모두 있습니다.' }
    }
  }
  if (action.tool === 'generate_all_prop_sheets' || action.tool === 'generate_prop_sheet') {
    return { state: 'skip', detail: '주요 소품 이미지 생성을 취소했습니다.' }
  }

  if (action.tool === 'generate_all_boards') {
    if (!shotsMissingStoryboard(project).length && !shotsMissingKeyframe(project).length) {
      return { state: 'skip', detail: '현재 영상 모델에 필요한 스토리 개요판과 키프레임을 확인했습니다.' }
    }
    const repairs: AgentToolAction[] = []
    if ((project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) repairs.push({ tool: 'generate_all_sheets' })
    if ((project.scenes ?? []).some((scene) => !scene.plateAssetId)) repairs.push({ tool: 'generate_all_scenes' })
    if (repairs.length) return { state: 'repair', detail: '스토리 개요판 일괄 생성에 필요한 캐릭터나 장면 참조 이미지를 먼저 보완합니다.', actions: repairs }
  }

  if (action.tool === 'generate_all_images') {
    if (!shotsMissingKeyframe(project).length) return { state: 'skip', detail: '현재 작업에 필요한 키프레임을 확인했습니다.' }
    if (shotsMissingStoryboard(project).length) {
      return { state: 'repair', detail: '샷 이미지 일괄 생성에 필요한 스토리 개요판을 먼저 생성합니다.', actions: [{ tool: 'generate_all_boards' }] }
    }
    const repairs: AgentToolAction[] = []
    if ((project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) repairs.push({ tool: 'generate_all_sheets' })
    if ((project.scenes ?? []).some((scene) => !scene.plateAssetId)) repairs.push({ tool: 'generate_all_scenes' })
    if (repairs.length) return { state: 'repair', detail: '키프레임 일괄 생성에 필요한 캐릭터 설정이나 장면을 먼저 보완합니다.', actions: repairs }
  }

  if (action.tool === 'generate_all_videos') {
    if (!(project.shots ?? []).some((shot) => !shot.videoAssetId)) return { state: 'skip', detail: '모든 스토리보드 샷에 영상이 있습니다.' }
    if (needsShotFrames(project) && (project.shots ?? []).some((shot) => shotUsesFrames(shot, project) && !shot.firstFrameAssetId && !shot.lastFrameAssetId)) {
      return { state: 'repair', detail: '시작·끝 프레임 모드입니다. 영상 생성 전에 샷마다 시작과 끝 프레임을 채웁니다.', actions: [{ tool: 'generate_all_frames' }] }
    }
    if (shotsMissingKeyframe(project).length) {
      return { state: 'repair', detail: '영상 일괄 생성에 필요한 키프레임을 먼저 생성합니다.', actions: [{ tool: 'generate_all_images' }] }
    }
    if (shotsMissingStoryboard(project).length) {
      return { state: 'repair', detail: '영상 일괄 생성에 필요한 스토리 개요판을 먼저 생성합니다.', actions: [{ tool: 'generate_all_boards' }] }
    }
    const repairs: AgentToolAction[] = []
    if ((project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) repairs.push({ tool: 'generate_all_sheets' })
    if ((project.scenes ?? []).some((scene) => !scene.plateAssetId)) repairs.push({ tool: 'generate_all_scenes' })
    if (repairs.length) return { state: 'repair', detail: '영상 일괄 생성에 필요한 캐릭터 디자인 이미지나 장면 이미지를 먼저 보완합니다.', actions: repairs }
  }

  if (action.tool === 'generate_all_audio') {
    if (!(project.shots ?? []).some((shot) => needsExternalTts(shot, project) && !shot.audioAssetId)) {
      return { state: 'skip', detail: '추가로 생성할 별도 TTS가 없습니다.' }
    }
  }

  return { state: 'ready' }
}

/** Verify persisted project state instead of trusting a tool's success string. */
export function verifyRegisteredTool(raw: unknown): string | null {
  const action = validateToolAction(raw)
  const project = useProjectStore().current
  if (!project) return '프로젝트 상태가 없습니다.'
  const shot = shotFor(action)
  switch (action.tool) {
    case 'generate_play':
    case 'generate_storyboard':
    case 'continue_play':
      return project.script?.playReady && project.script.content?.trim() ? null : '전체 대본이 프로젝트에 저장되지 않았습니다.'
    case 'extract_cast':
      return (project.subjects ?? []).length ? null : '캐릭터 노드가 프로젝트에 저장되지 않았습니다.'
    case 'generate_sheet': {
      const subject = (project.subjects ?? []).find((item) => item.id === action.subjectId)
      return subject?.designSheetAssetId ? null : '캐릭터 4면 설정 이미지가 저장되지 않았습니다.'
    }
    case 'generate_prop_sheet':
    case 'generate_all_prop_sheets':
      return null
    case 'generate_scene':
      return (project.scenes ?? []).find((item) => item.id === action.sceneId)?.plateAssetId ? null : '장면 기준 이미지가 저장되지 않았습니다.'
    case 'generate_all_sheets':
      return (project.subjects ?? []).every((item) => item.designSheetAssetId) ? null : '일부 캐릭터의 4면 설정 이미지가 없습니다.'
    case 'generate_all_scenes':
      return (project.scenes ?? []).every((item) => item.plateAssetId) ? null : '일부 장면의 기준 이미지가 없습니다.'
    case 'generate_shot_board': {
      if (!shot) return '스토리 개요판이 저장되지 않았습니다.'
      const mode = stillModeForShot(shot, project)
      if (mode === 'identity') return null
      if (mode === 'storyboard') return shot.boardAssetId ? null : '스토리 개요판이 저장되지 않았습니다.'
      return shot.imageAssetId ? null : '키프레임이 저장되지 않았습니다.'
    }
    case 'generate_shot_image':
      if (!shot) return '키프레임이 저장되지 않았습니다.'
      if (stillModeForShot(shot, project) !== 'keyframe') return null
      return shot.imageAssetId ? null : '키프레임이 저장되지 않았습니다.'
    case 'generate_shot_frames':
      if (!shot) return '시작·끝 프레임이 저장되지 않았습니다.'
      return shot.firstFrameAssetId && shot.lastFrameAssetId ? null : '시작·끝 프레임이 저장되지 않았습니다.'
    case 'generate_all_frames':
      return (project.shots ?? []).some((s) => !s.firstFrameAssetId || !s.lastFrameAssetId)
        ? '일부 샷에 시작·끝 프레임이 없습니다.'
        : null
    case 'generate_all_boards':
      return shotsMissingStoryboard(project).length || shotsMissingKeyframe(project).length
        ? '일부 샷에 스토리 개요판이나 키프레임이 없습니다.'
        : null
    case 'generate_all_images':
      return shotsMissingKeyframe(project).length ? '일부 키프레임이 없습니다.' : null
    case 'generate_video':
      return shot?.videoAssetId ? null : '스토리보드 샷 영상이 저장되지 않았습니다.'
    case 'generate_all_videos':
      return project.shots.every((item) => item.videoAssetId) ? null : '일부 스토리보드 샷 영상이 없습니다.'
    case 'generate_audio':
      return !shot || !needsExternalTts(shot, project) || shot.audioAssetId ? null : '별도 내레이션이 저장되지 않았습니다.'
    case 'generate_all_audio':
      return project.shots.every((item) => !needsExternalTts(item, project) || item.audioAssetId) ? null : '일부 별도 내레이션이 없습니다.'
    default:
      return null
  }
}

const noCost = () => ({ calls: 0, seconds: 1 })
const oneLlm = () => ({ calls: 1, seconds: 180 })
const oneImage = () => ({ calls: 1, seconds: 45 })
const oneVideo = () => ({ calls: 1, seconds: 180 })
const oneAudio = () => ({ calls: 1, seconds: 20 })

function progress(ctx: ToolExecutionContext) {
  return (_id: string, message: string) => {
    if (ctx.signal?.aborted) throw abortError('run_node')
    ctx.onLog(message)
  }
}

/** 把两个已有节点连起来（source → target），必要时把上游的产出作为参考图继承给下游 */
function linkCanvasNodes(sourceId: string, targetId: string): string {
  const project = useProjectStore()
  const canvas = project.current?.canvas
  if (!project.current || !canvas) throw new Error('현재 프로젝트에 사용할 수 있는 캔버스가 없습니다.')
  const source = canvas.nodes.find((n) => n.id === sourceId)
  const target = canvas.nodes.find((n) => n.id === targetId)
  if (!source) throw new Error(`상위 노드를 찾을 수 없습니다. ${sourceId}`)
  if (!target) throw new Error(`하위 노드를 찾을 수 없습니다. ${targetId}`)
  if (sourceId === targetId) throw new Error('노드를 자기 자신에 연결할 수 없습니다.')

  let refNote = ''
  if (canvasNodeProducesImage(source) && (target.type === 'imageGen' || target.type === 'videoGen')) {
    const ok = appendCanvasReferenceSource(project.current, targetId, sourceId)
    refNote = ok ? '(상위 노드의 결과를 하위 노드에 참조 이미지로 전달했습니다.)' : '(하위 노드의 참조 이미지 한도에 도달해 노드 연결만 완료했습니다.)'
  }

  const id = `e-${sourceId}-${targetId}-in`
  const existed = canvas.edges.some((e) => e.id === id)
  if (!existed) {
    canvas.edges = [
      ...canvas.edges,
      { id, source: sourceId, target: targetId, sourceHandle: 'out', targetHandle: 'in' }
    ]
  }
  return existed
    ? `${sourceId} → ${targetId} 노드는 이미 연결돼 있습니다. ${refNote}`
    : `${sourceId} → ${targetId} 노드를 연결했습니다. ${refNote}`
}

/** 上游节点右侧的空位，已有几个下游就往下错开 */
function spotNextToSource(sourceId: string, fallbackX: number, fallbackY: number, count: number) {
  const canvas = useProjectStore().current?.canvas
  const source = canvas?.nodes.find((n) => n.id === sourceId)
  if (!source) return { x: fallbackX, y: fallbackY }
  const siblings = (canvas?.edges ?? []).filter((e) => e.source === sourceId).length
  return { x: source.position.x + 420, y: source.position.y + siblings * 300 + (count % 2) * 40 }
}

const definitions: ToolDefinition[] = [
  {
    name: 'seed_script', phase: 0, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action, ctx) {
      const project = useProjectStore()
      const cur = project.current
      if (!cur) throw new Error('먼저 프로젝트를 만드세요.')
      const text = String(action.text || '').trim()
      const hasFullPlay = Boolean(
        cur.script?.playReady &&
        (
          /^#{1,4}\s+/m.test(cur.script.content || '') ||
          (cur.script.content || '').length >= 500 ||
          (cur.subjects ?? []).length ||
          (cur.scenes ?? []).length ||
          (cur.shots ?? []).length
        )
      )
      const explicitReplace =
        /重新写(?:完整)?剧本|重写(?:完整)?剧本|换(?:一个|成).{0,12}(?:故事|剧本)|新故事|新剧本|从头(?:写|开始)|대본(?:을)?\s*다시\s*써|새\s*(?:대본|이야기)/.test(text)
      if (cur.script?.origin === 'imported' && !explicitReplace) {
        ctx.onLog('가져온 대본의 원문을 유지합니다.')
        return '가져온 대본의 본문을 보존합니다. 스토리보드는 바로 추출할 수 있습니다. 다시 쓰려면 ‘대본을 다시 써 줘’라고 명시하세요.'
      }
      if (hasFullPlay && !explicitReplace) {
        ctx.onLog('전체 대본이 있어 현재 채팅 내용으로 덮어쓰지 않았습니다.')
        return '기존 전체 대본을 보존합니다. 캐릭터 피드백이나 부분 수정 시에도 본문을 유지합니다.'
      }
      const topic = topicFromBrief(text) || cur.name
      const inferred = inferVisualStyleFromText(text)
      const style = inferred || cur.script?.style || 'cinematic'
      cur.name = topic
      if (!cur.script) {
        project.setScript({
          id: `s_${Date.now().toString(36)}`, topic, content: text, keywords: [], style,
          aspectRatio: cur.settings.aspectRatio,
          shotDuration: cur.settings.defaultShotDuration || 5,
          playReady: false,
          createdAt: Date.now()
        })
      } else {
        project.setScript({
          ...cur.script,
          topic,
          content: text,
          style,
          playReady: false
        })
      }
      ctx.onLog('원고를 저장했습니다.')
      return '원고를 준비했습니다.'
    }
  },
  {
    name: 'generate_play', phase: 0, timeoutMs: 420_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal, undefined, {
        mode: 'write',
        brief: action.text
      })
      revealCanvas('script')
      return '전체 대본을 작성했습니다. 다음은 캐릭터 추출 단계입니다.'
    }
  },
  {
    name: 'continue_play', phase: 0, timeoutMs: 420_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal, undefined, {
        mode: 'continue',
        hint: action.text
      })
      revealCanvas('script')
      return '기존 장면을 보존하고 이후 장면을 이어 썼습니다. 노드를 이미 추출했다면 ‘스토리보드 키프레임’ 그룹에서 ‘다시 추출’을 눌러 새 장면을 동기화하세요.'
    }
  },
  {
    name: 'generate_storyboard', phase: 0, timeoutMs: 420_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal, undefined, {
        mode: 'write',
        brief: action.text
      })
      revealCanvas('script')
      return '1단계인 전체 대본 작성을 마쳤습니다. ‘계속’이라고 하면 캐릭터를 추출합니다.'
    }
  },
  {
    name: 'extract_cast', phase: 0, timeoutMs: 1_080_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runExtractStoryboard, runGeneratePlay } = await import('./runner')
      const { isPlayReady } = await import('@/services/ai')
      const project = useProjectStore()
      const script = project.current?.script
      if (!isPlayReady(script) && !script?.content?.trim()) {
        await runGeneratePlay(ctx.onLog, ctx.signal)
        revealCanvas('script')
        return '전체 대본이 없어 먼저 작성했습니다. 노드를 추출하려면 ‘노드 추출’을 다시 누르세요.'
      }
      const start = action.extractStage || nextExtractStage(project.current)
      if (!start) {
        throw new Error('캐릭터, 장면, 스토리보드를 모두 추출했습니다. 특정 그룹을 바꾸려면 해당 그룹의 ‘다시 추출’을 누르거나 다시 추출할 그룹을 알려 주세요.')
      }
      await runExtractStoryboard(ctx.onLog, ctx.signal, undefined, start)
      revealCanvas(
        start === 'subjects' ? 'group-subjects' : start === 'scenes' ? 'group-scenes' : 'group-shots'
      )
      const after = project.current
      const subjects = after?.subjects?.length ?? 0
      const scenes = after?.scenes?.length ?? 0
      const shots = after?.shots.length ?? 0
      if (start === 'subjects' && !subjects) throw new Error('캐릭터를 캔버스에 저장하지 못했습니다.')
      if (start === 'scenes' && !scenes) throw new Error('장면을 캔버스에 저장하지 못했습니다.')
      if (start === 'shots' && !shots) throw new Error('스토리보드를 캔버스에 저장하지 못했습니다.')
      const re = Boolean(action.extractStage)
      const kept = '이름이나 샷 번호가 같은 기존 이미지와 영상을 보존했습니다.'
      if (start === 'subjects') {
        return re
          ? `캐릭터 ${subjects}개를 다시 추출했습니다. ${kept}`
          : `1단계 완료. 캐릭터 ${subjects}개를 추출했습니다.`
      }
      if (start === 'scenes') {
        return re
          ? `장면 ${scenes}개의 기준 정보를 다시 추출했습니다. ${kept}`
          : `2단계 완료. 장면 ${scenes}개를 추출했습니다.`
      }
      return re
        ? `스토리보드 샷 ${shots}개를 다시 추출했습니다. ${kept}`
        : `3단계 완료. 스토리보드 샷 ${shots}개를 추출했습니다.`
    }
  },
  {
    name: 'approve_play', phase: 0, timeoutMs: 5_000, estimate: noCost,
    async execute() {
      const project = useProjectStore()
      project.setPlayApproved(true)
      await project.save()
      return '대본을 승인했습니다.'
    }
  },
  {
    name: 'revise_shot', phase: 0, timeoutMs: 10_000, required: ['shotId'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const shot = project.current?.shots.find((item) => item.id === action.shotId)
      if (!shot) throw new Error(`스토리보드 샷 ${action.shotId}을 찾을 수 없습니다.`)
      const patch = {
        ...(action.visualPrompt ? { visualPrompt: action.visualPrompt } : {}),
        ...(action.imagePrompt ? { imagePrompt: action.imagePrompt } : {}),
        ...(action.videoPrompt
          ? { videoPrompt: action.videoPrompt, compiledVideoPrompt: action.videoPrompt }
          : action.compiledVideoPrompt !== undefined
            ? { compiledVideoPrompt: action.compiledVideoPrompt }
            : {}),
        ...(action.voiceover !== undefined ? { voiceover: action.voiceover } : {}),
        ...(typeof action.duration === 'number' ? { duration: Math.max(3, Math.min(10, Math.round(action.duration))) } : {}),
        ...(action.cameraMovement ? { cameraMovement: action.cameraMovement } : {})
      }
      if (!Object.keys(patch).length) throw new Error('revise_shot에 수정할 필드가 없습니다.')
      project.updateShot(shot.id, patch)
      if (action.visualPrompt) project.updateShot(shot.id, { boardAssetId: undefined })
      if (action.visualPrompt || action.imagePrompt) project.invalidateShotAssets(shot.id, 'image')
      else if (action.videoPrompt || action.compiledVideoPrompt !== undefined || action.cameraMovement || action.duration) project.invalidateShotAssets(shot.id, 'video')
      if (action.voiceover !== undefined) {
        project.invalidateShotAssets(shot.id, 'audio')
        project.invalidateShotAssets(shot.id, 'video')
      }
      await project.save()
      revealCanvas(`shotImage:${shot.id}`)
      return `${shot.index + 1}번 샷을 부분 수정하고 영향받은 후속 산출물을 무효화했습니다.`
    }
  },
  {
    name: 'generate_sheet', phase: 1, timeoutMs: 240_000, required: ['subjectId'], estimate: oneImage,
    async execute(action, ctx) {
      const p = useProjectStore().current!
      const sub = (p.subjects ?? []).find((s) => s.id === action.subjectId)
      if (!sub) throw new Error(`대상 ${action.subjectId}을 찾을 수 없습니다.`)
      await runCanvasNode(`subject:${sub.id}`, progress(ctx), ctx.signal)
      revealCanvas(`subject:${sub.id}`)
      return `${sub.name}의 4면 설정 이미지를 생성했습니다.`
    }
  },
  {
    name: 'generate_all_sheets', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().sheets, seconds: counts().sheets * 90 }),
    async execute(_action, ctx) { await generateMissingSheets(ctx.onLog, ctx.signal); return '4면 설정 이미지를 모두 생성했습니다.' }
  },
  {
    name: 'generate_all_prop_sheets', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: 0, seconds: 0 }),
    async execute() { return '주요 소품 이미지 생성을 취소했습니다.' }
  },
  {
    name: 'generate_prop_sheet', phase: 1, timeoutMs: 240_000, required: ['sceneId'], estimate: oneImage,
    async execute() { return '주요 소품 이미지 생성을 취소했습니다.' }
  },
  {
    name: 'generate_scene', phase: 1, timeoutMs: 240_000, required: ['sceneId'], estimate: oneImage,
    async execute(action, ctx) {
      const p = useProjectStore().current!
      const scene = (p.scenes ?? []).find((s) => s.id === action.sceneId)
      if (!scene) throw new Error(`장면 ${action.sceneId}을 찾을 수 없습니다.`)
      await runCanvasNode(`scene:${scene.id}`, progress(ctx), ctx.signal)
      return `${scene.name}의 장면 기준 이미지를 생성했습니다.`
    }
  },
  {
    name: 'generate_all_scenes', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().scenes, seconds: counts().scenes * 45 }),
    async execute(_action, ctx) { await generateMissingPlates(ctx.onLog, ctx.signal); return '장면 기준 이미지를 모두 생성했습니다.' }
  },
  {
    name: 'generate_shot_board', phase: 2, timeoutMs: 240_000, required: ['shotId'], estimate: oneImage,
    async execute(action, ctx) {
      const project = useProjectStore().current
      const shot = project?.shots.find((item) => item.id === action.shotId)
      const mode = shot && project ? stillModeForShot(shot, project) : 'identity'
      if (mode === 'identity') return '현재 영상 모델에 스토리 개요판이나 키프레임이 필요 없습니다.'
      const nodeId = mode === 'storyboard' ? `shotBoard:${action.shotId}` : `shotImage:${action.shotId}`
      await runCanvasNode(nodeId, progress(ctx), ctx.signal)
      revealCanvas(nodeId)
      return mode === 'storyboard' ? '스토리 개요판을 생성했습니다.' : '키프레임을 생성했습니다.'
    }
  },
  {
    name: 'generate_all_boards', phase: 2, timeoutMs: 900_000,
    estimate: () => ({ calls: counts().boards, seconds: counts().boards * 45 }),
    async execute(_action, ctx) {
      const project = useProjectStore().current
      if (project && shotsMissingStoryboard(project).length) {
        await generateMissingBoards(ctx.onLog, ctx.signal)
        return '스토리 개요판을 모두 생성했습니다.'
      }
      await generateMissingImages(ctx.onLog, ctx.signal)
      return '키프레임을 모두 생성했습니다.'
    }
  },
  {
    name: 'generate_shot_image', phase: 3, timeoutMs: 240_000, required: ['shotId'], estimate: oneImage,
    async execute(action, ctx) {
      await runCanvasNode(`shotImage:${action.shotId}`, progress(ctx), ctx.signal)
      revealCanvas(`shotImage:${action.shotId}`)
      return '키프레임을 생성했습니다.'
    }
  },
  {
    name: 'generate_all_images', phase: 3, timeoutMs: 900_000,
    estimate: () => ({ calls: counts().images, seconds: counts().images * 45 }),
    async execute(_action, ctx) { await generateMissingImages(ctx.onLog, ctx.signal); return '키프레임을 모두 생성했습니다.' }
  },
  {
    name: 'generate_shot_frames', phase: 3, timeoutMs: 300_000, required: ['shotId'],
    estimate: () => ({ calls: 2, seconds: 90 }),
    async execute(action, ctx) {
      const shot = useProjectStore().current?.shots.find((item) => item.id === action.shotId)
      if (!shot) throw new AgentToolError(`스토리보드 샷 ${action.shotId}을 찾을 수 없습니다.`, action.tool, 'invalid_action', true)
      await generateShotFramePair(shot, (msg) => ctx.onLog?.(msg), ctx.signal)
      revealCanvas(`shotFrames:${action.shotId}`)
      return `${shot.index + 1}번 샷의 시작·끝 프레임을 생성했습니다.`
    }
  },
  {
    name: 'generate_all_frames', phase: 3, timeoutMs: 1800_000,
    estimate: () => ({ calls: counts().images * 2, seconds: counts().images * 90 }),
    async execute(_action, ctx) {
      const p = useProjectStore().current
      const targets = (p?.shots ?? [])
        .filter((s) => !s.firstFrameAssetId || !s.lastFrameAssetId)
        .sort((a, b) => a.index - b.index)
      if (!targets.length) return '모든 샷에 시작·끝 프레임이 있습니다.'
      // 这一镜起始帧要接着上一镜结束帧，必须按镜号串行
      for (const shot of targets) {
        await generateShotFramePair(shot, (msg) => ctx.onLog?.(msg), ctx.signal)
      }
      return `${targets.length}개 샷의 시작·끝 프레임을 샷 번호 순서대로 생성했습니다.`
    }
  },
  {
    name: 'generate_video', phase: 4, timeoutMs: 20 * 60_000, required: ['shotId'], estimate: oneVideo,
    async execute(action, ctx) {
      await runCanvasNode(`shotVideo:${action.shotId}`, progress(ctx), ctx.signal)
      revealCanvas(`shotVideo:${action.shotId}`)
      return '스토리보드 샷 영상을 생성했습니다.'
    }
  },
  {
    name: 'generate_all_videos', phase: 4, timeoutMs: 60 * 60_000,
    estimate: () => {
      const n = counts().videos
      return { calls: n, seconds: n ? Math.ceil(n / VIDEO_GEN_CONCURRENCY) * 180 : 0 }
    },
    async execute(_action, ctx) { await generateMissingVideos(ctx.onLog, ctx.signal); return '영상을 모두 생성했습니다.' }
  },
  {
    name: 'generate_audio', phase: 5, timeoutMs: 180_000, required: ['shotId'], estimate: oneAudio,
    async execute(action, ctx) { await runCanvasNode(`audio:${action.shotId}`, progress(ctx), ctx.signal); return '내레이션을 생성했습니다.' }
  },
  {
    name: 'generate_all_audio', phase: 5, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().audio, seconds: counts().audio * 20 }),
    async execute(_action, ctx) { await generateMissingAudio(ctx.onLog, ctx.signal); return '내레이션을 모두 생성했습니다.' }
  },
  {
    name: 'sync_canvas', phase: 6, timeoutMs: 5_000, estimate: noCost,
    async execute() { useProjectStore().syncCanvasFromProject(); revealCanvas(); return '캔버스를 동기화했습니다.' }
  },
  {
    name: 'focus_node', phase: 6, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) { revealCanvas(action.nodeId); return '노드로 이동했습니다.' }
  },
  {
    name: 'create_image_node', phase: 2, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const canvas = project.current?.canvas
      if (!project.current || !canvas) throw new Error('현재 프로젝트에 사용할 수 있는 캔버스가 없습니다.')
      const count = canvas.nodes.filter((node) => node.type === 'imageGen').length + 1
      const sourceId = action.sourceNodeId || action.nodeId
      const right = canvas.nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
      const spot = sourceId
        ? spotNextToSource(sourceId, right + 340, 120 + ((count - 1) % 4) * 260, count)
        : { x: right + 340, y: 120 + ((count - 1) % 4) * 260 }
      const id = `imageGen_${Date.now().toString(36)}`
      project.addCanvasNode({
        id,
        type: 'imageGen',
        position: spot,
        data: { label: `이미지 ${count}`, prompt: action.text, aspectRatio: project.current.settings.aspectRatio },
        status: 'idle'
      })
      await project.save()
      let linked = ''
      if (sourceId) {
        try {
          linked = ` ${linkCanvasNodes(sourceId, id)}`
        } catch (e: any) {
          linked = `(연결 실패. ${e?.message || '알 수 없는 원인'}. 캔버스에서 수동으로 연결할 수 있습니다.)`
        }
      }
      revealCanvas(id)
      return `이미지 노드 ${id}을 만들고 프롬프트를 저장했습니다. ${linked} run_node로 생성할 수 있습니다.`
    }
  },
  {
    name: 'create_video_node', phase: 2, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const canvas = project.current?.canvas
      if (!project.current || !canvas) throw new Error('현재 프로젝트에 사용할 수 있는 캔버스가 없습니다.')
      const count = canvas.nodes.filter((node) => node.type === 'videoGen').length + 1
      const sourceId = action.sourceNodeId || action.nodeId
      const right = canvas.nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
      const spot = sourceId
        ? spotNextToSource(sourceId, right + 340, 140 + ((count - 1) % 4) * 280, count)
        : { x: right + 340, y: 140 + ((count - 1) % 4) * 280 }
      const id = `videoGen_${Date.now().toString(36)}`
      project.addCanvasNode({
        id,
        type: 'videoGen',
        position: spot,
        data: {
          label: `영상 ${count}`,
          prompt: action.text,
          aspectRatio: project.current.settings.aspectRatio,
          duration: Math.max(1, Math.min(15, Math.round(action.duration || 8)))
        },
        status: 'idle'
      })
      await project.save()
      let linked = ''
      if (sourceId) {
        try {
          linked = ` ${linkCanvasNodes(sourceId, id)}`
        } catch (e: any) {
          linked = `(연결 실패. ${e?.message || '알 수 없는 원인'}. 캔버스에서 수동으로 연결할 수 있습니다.)`
        }
      }
      revealCanvas(id)
      return `영상 노드 ${id}을 만들고 동작 프롬프트를 저장했습니다. ${linked} run_node로 생성할 수 있습니다.`
    }
  },
  {
    name: 'connect_nodes', phase: 2, timeoutMs: 5_000, required: ['sourceNodeId', 'targetNodeId'], estimate: noCost,
    async execute(action) {
      const note = linkCanvasNodes(action.sourceNodeId!, action.targetNodeId!)
      await useProjectStore().save()
      revealCanvas(action.targetNodeId!)
      return note
    }
  },
  {
    name: 'delete_node', phase: 2, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const canvas = project.current?.canvas
      const node = canvas?.nodes.find((n) => n.id === action.nodeId)
      if (!canvas || !node) throw new Error(`캔버스 노드 ${action.nodeId}을 찾을 수 없습니다.`)
      if (node.type !== 'imageGen' && node.type !== 'videoGen') {
        throw new Error('delete_node는 자유 이미지·영상 노드를 삭제합니다. 대본, 캐릭터 설정, 스토리보드 노드는 캔버스에서 직접 삭제하세요.')
      }
      const label = node.data.label || node.id
      for (const other of canvas.nodes) {
        const sources = other.data.referenceSourceNodeIds ?? []
        if (sources.includes(node.id)) {
          other.data.referenceSourceNodeIds = sources.filter((id) => id !== node.id)
        }
      }
      project.removeCanvasNode(node.id)
      await project.save()
      return `‘${label}’ 노드와 관련 연결, 다른 노드에서 이 노드를 쓰던 참조 이미지 항목을 삭제했습니다.`
    }
  },
  {
    name: 'arrange_canvas', phase: 6, timeoutMs: 5_000, estimate: noCost,
    async execute() {
      const project = useProjectStore()
      const p = project.current
      if (!p) throw new Error('열려 있는 프로젝트가 없습니다.')
      try {
        p.canvas = rebuildCanvasGraph(p, true)
      } catch {
        p.canvas = rebuildCanvasGraph(p, false)
      }
      await project.save()
      return '캔버스를 대본 → 캐릭터 설정·장면 → 스토리보드 순서로 재배치했습니다.'
    }
  },
  {
    name: 'check_project', phase: 6, timeoutMs: 5_000, estimate: noCost,
    async execute() {
      const project = useProjectStore()
      const p = project.current
      if (!p) throw new Error('열려 있는 프로젝트가 없습니다.')
      const settings = useSettingsStore()
      const blocking: string[] = []
      const warnings: string[] = []

      if (!(settings.config.llms ?? []).length) blocking.push('LLM을 설정해야 대본 작성, 노드 추출, 프롬프트 최적화를 사용할 수 있습니다.')
      if (!(settings.config.images ?? []).length) blocking.push('이미지를 생성하려면 이미지 모델을 설정하세요.')
      if (!(settings.config.videos ?? []).length) blocking.push('영상을 생성하려면 영상 모델을 설정하세요.')

      const canvas = p.canvas
      const nodes = canvas?.nodes ?? []
      const edges = canvas?.edges ?? []
      const free = nodes.filter((n) => n.type === 'imageGen' || n.type === 'videoGen')
      for (const n of free) {
        const name = n.data.label || n.id
        if (!(n.data.prompt || '').trim()) {
          warnings.push(`‘${name}’에 프롬프트가 없어 실행해도 생성할 내용이 없습니다.`)
        }
        if (n.type === 'videoGen' && !resolvedCanvasReferenceAssetIds(p, n).length) {
          warnings.push(`‘${name}’은 이미지→영상 노드입니다. 상위 노드를 연결하지 않았다면 참조 이미지가 한 장 이상 필요합니다.`)
        }
        if (n.status === 'failed') {
          warnings.push(`‘${name}’의 이전 생성이 실패했습니다. ${n.error || '알 수 없는 원인'}`)
        }
        if (!n.data.outputAssetId && n.status !== 'failed') {
          warnings.push(`‘${name}’에 생성 결과가 없습니다.`)
        }
      }
      const connected = new Set<string>()
      for (const e of edges) {
        connected.add(e.source)
        connected.add(e.target)
      }
      const orphans = free.filter((n) => !connected.has(n.id))
      if (orphans.length) {
        warnings.push(`연결되지 않은 노드 ${orphans.length}개 ${orphans.map((n) => n.data.label || n.id).join('、')}`)
      }

      const subjects = p.subjects ?? []
      const scenes = p.scenes ?? []
      if (!p.script?.content?.trim()) warnings.push('대본이 없습니다.')
      if (subjects.length && subjects.some((s) => !s.designSheetAssetId)) {
        warnings.push(`캐릭터 ${subjects.filter((s) => !s.designSheetAssetId).length}명에게 설정 이미지가 없습니다.`)
      }
      if (scenes.length && scenes.some((s) => !s.plateAssetId)) {
        warnings.push(`장면 ${scenes.filter((s) => !s.plateAssetId).length}개에 기준 이미지가 없습니다.`)
      }
      if (p.shots.length) {
        const noImg = p.shots.filter((s) => !s.imageAssetId).length
        const noVid = p.shots.filter((s) => !s.videoAssetId).length
        if (noImg) warnings.push(`스토리보드 샷 ${noImg}개에 이미지가 없습니다.`)
        if (noVid) warnings.push(`스토리보드 샷 ${noVid}개에 영상이 없습니다.`)
        if (!p.playApproved) warnings.push('대본과 스토리보드의 검수가 완료되어야 후속 제작을 진행할 수 있습니다.')
      }

      if (!blocking.length && !warnings.length) {
        return `점검을 통과했습니다. 대본, 캐릭터 ${subjects.length}명, 장면 ${scenes.length}개, 스토리보드 샷 ${(p.shots ?? []).length}개, 캔버스 생성 노드 ${free.length}개를 확인했습니다.`
      }
      const lines: string[] = []
      if (blocking.length) lines.push(`【진행을 막는 문제】\n- ${blocking.join('\n- ')}`)
      if (warnings.length) lines.push(`【처리할 항목】\n- ${warnings.join('\n- ')}`)
      return lines.join('\n')
    }
  },
  {
    name: 'update_node', phase: 2, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const node = project.current?.canvas?.nodes.find((item) => item.id === action.nodeId)
      if (!node) throw new Error(`캔버스 노드 ${action.nodeId}을 찾을 수 없습니다.`)
      if (node.type !== 'imageGen' && node.type !== 'videoGen') {
        throw new Error('update_node는 자유 이미지·영상 노드에 사용합니다. 스토리보드 샷은 revise_shot으로 수정하세요.')
      }
      if (action.text === undefined && action.duration === undefined && action.nodeLabel === undefined) {
        throw new Error('update_node에는 prompt(text), duration, label 중 하나 이상이 필요합니다.')
      }
      project.patchCanvasNode(node.id, {
        ...(action.text !== undefined ? { prompt: action.text } : {}),
        ...(action.nodeLabel !== undefined ? { label: action.nodeLabel.trim() || undefined } : {}),
        ...(action.duration !== undefined
          ? { duration: Math.max(1, Math.min(15, Math.round(action.duration))) }
          : {}),
        outputAssetId: undefined
      })
      node.status = 'idle'
      node.error = undefined
      await project.save()
      revealCanvas(node.id)
      return `노드 ${node.id}을 갱신했습니다. 기존 결과를 무효화했으며 run_node로 다시 생성할 수 있습니다.`
    }
  },
  {
    name: 'run_node', phase: 2, timeoutMs: 20 * 60_000, required: ['nodeId'], estimate: oneImage,
    async execute(action, ctx) { await runCanvasNode(action.nodeId!, progress(ctx), ctx.signal); return '노드 실행을 완료했습니다.' }
  },
  {
    name: 'optimize_node_prompt', phase: 2, timeoutMs: 240_000, required: ['nodeId'], estimate: oneLlm,
    async execute(action, ctx) {
      const project = useProjectStore()
      const node = project.current?.canvas?.nodes.find((item) => item.id === action.nodeId)
      if (!node) throw new Error(`캔버스 노드 ${action.nodeId}을 찾을 수 없습니다.`)
      if (node.type !== 'imageGen' && node.type !== 'videoGen') {
        throw new Error('optimize_node_prompt는 자유 이미지·영상 노드에서 사용할 수 있습니다.')
      }
      const { optimizeNodePrompt } = await import('@/services/ai/promptCoach')
      const result = await optimizeNodePrompt(
        {
          kind: node.type === 'videoGen' ? 'video' : 'image',
          nodeLabel: `${node.data.label || node.id} · ${node.type === 'videoGen' ? '이미지→영상' : '이미지 생성'}`,
          currentPrompt: node.data.prompt || '',
          userHint: action.text,
          script: project.current?.script?.content || '',
          duration: node.data.duration,
          signal: ctx.signal
        },
        (msg) => ctx.onLog(msg)
      )
      project.setCanvasNodePrompt(node.id, result.prompt)
      await project.save()
      revealCanvas(node.id)
      return `${result.note}(‘${node.data.label || node.id}’에 저장했습니다.)\n\n\`\`\`\n${result.prompt}\n\`\`\``
    }
  },
  {
    name: 'remember', phase: 6, timeoutMs: 10_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const { rememberMemory } = await import('@/services/memory/memoryStore')
      const scope = /项目|本剧|这部/.test(action.text || '') ? 'project' : 'global'
      const entry = await rememberMemory(action.text!, { scope })
      if (!entry) throw new Error('저장할 기억 내용이 없습니다.')
      return `${scope === 'global' ? '장기 기억' : '이 프로젝트의 기억'}에 저장했습니다. ${entry.content}`
    }
  },
  {
    name: 'forget', phase: 6, timeoutMs: 10_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const { forgetMemory } = await import('@/services/memory/memoryStore')
      const removed = await forgetMemory(action.text!)
      if (!removed) throw new Error('일치하는 기억을 찾지 못했습니다.')
      return `기억을 삭제했습니다. ${removed}`
    }
  }
]

const registry = new Map(definitions.map((definition) => [definition.name, definition]))

export function validateToolAction(raw: unknown): AgentToolAction {
  if (!raw || typeof raw !== 'object') {
    throw new AgentToolError('도구 작업은 객체여야 합니다.', 'unknown', 'invalid_action')
  }
  const action = raw as Record<string, unknown>
  const name = String(action.tool || '') as AgentToolName
  const definition = registry.get(name)
  if (!definition) throw new AgentToolError(`허용되지 않는 도구입니다. ${name || '이름 없음'}`, name, 'invalid_action')
  for (const key of definition.required ?? []) {
    if (typeof action[key] !== 'string' || !String(action[key]).trim()) {
      throw new AgentToolError(`${name}에 파라미터 ${key}이 없습니다.`, name, 'invalid_action')
    }
  }
  return {
    tool: name,
    ...(typeof action.text === 'string' ? { text: action.text } : {}),
    ...(typeof action.subjectId === 'string' ? { subjectId: action.subjectId } : {}),
    ...(typeof action.sceneId === 'string' ? { sceneId: action.sceneId } : {}),
    ...(typeof action.shotId === 'string' ? { shotId: action.shotId } : {}),
    ...(typeof action.nodeId === 'string' ? { nodeId: action.nodeId } : {})
    ,...(typeof action.visualPrompt === 'string' ? { visualPrompt: action.visualPrompt } : {})
    ,...(typeof action.imagePrompt === 'string' ? { imagePrompt: action.imagePrompt } : {})
    ,...(typeof action.videoPrompt === 'string' ? { videoPrompt: action.videoPrompt } : {})
    ,...(typeof action.compiledVideoPrompt === 'string' ? { compiledVideoPrompt: action.compiledVideoPrompt } : {})
    ,...(typeof action.voiceover === 'string' ? { voiceover: action.voiceover } : {})
    ,...(typeof action.duration === 'number' ? { duration: action.duration } : {})
    ,...(['push', 'pull', 'pan', 'tilt', 'static', 'orbit'].includes(String(action.cameraMovement))
      ? { cameraMovement: action.cameraMovement as AgentToolAction['cameraMovement'] }
      : {})
    ,...(['subjects', 'scenes', 'shots'].includes(String(action.extractStage))
      ? { extractStage: action.extractStage as ExtractStage }
      : {})
  }
}

export function estimateToolActions(actions: unknown[]): ToolEstimate {
  return actions.map(validateToolAction).reduce(
    (sum, action) => {
      const cost = registry.get(action.tool)!.estimate(action)
      return { calls: sum.calls + cost.calls, seconds: sum.seconds + cost.seconds }
    },
    { calls: 0, seconds: 0 }
  )
}

export function buildTaskGraph(actions: unknown[]): AgentTaskGraph {
  const valid = actions.map(validateToolAction)
  const nodes: AgentTaskGraphNode[] = valid.map((action, index) => {
    const definition = registry.get(action.tool)!
    const estimate = definition.estimate(action)
    const previous = valid
      .map((a, i) => ({ a, i, phase: registry.get(a.tool)!.phase }))
      .filter((item) => item.i < index && item.phase < definition.phase)
      .map((item) => `step_${item.i}`)
    return {
      id: `step_${index}`,
      tool: action.tool,
      phase: definition.phase,
      dependsOn: previous,
      estimatedCalls: estimate.calls,
      estimatedSeconds: estimate.seconds
    }
  })
  return { id: `graph_${Date.now().toString(36)}`, nodes, createdAt: Date.now() }
}

export async function executeRegisteredTool(action: unknown, ctx: ToolExecutionContext) {
  const valid = validateToolAction(action)
  const definition = registry.get(valid.tool)!
  try {
    return await withControl(
      valid.tool,
      (signal) => definition.execute(valid, { ...ctx, signal }),
      definition.timeoutMs,
      ctx.signal
    )
  } catch (error: any) {
    if (error instanceof AgentToolError) throw error
    const message = error?.message ?? String(error)
    const hardStop = /401|403|鉴权|密钥|API Key|余额不足|配额不足|内容安全|用户停止|用户取消|API 키|인증 실패|할당량 부족|콘텐츠 안전|사용자가 작업을 (?:중단|취소)/i.test(message)
    throw new AgentToolError(
      message,
      valid.tool,
      'execution_failed',
      !hardStop
    )
  }
}

export function toolPhase(name: AgentToolName) {
  return registry.get(name)?.phase ?? 99
}

export function estimateRequestText(text: string): ToolEstimate {
  const t = text.trim()
  const c = counts()
  const requestedShots = Number(t.match(/(?:生成|做|拆成)?\s*(\d{1,2})\s*(?:个)?镜头/)?.[1] || 0)
  const plannedShots = Math.max(1, requestedShots || c.images || c.videos || c.audio || 6)
  let calls = 0
  let seconds = 0
  if (/拆|剧本|分镜|脚本/.test(t)) { calls += 1; seconds += 30 }
  if (/人设|角色图|四视图/.test(t)) { calls += Math.max(1, c.sheets); seconds += Math.max(1, c.sheets) * 45 }
  if (/资产图/.test(t)) { calls += Math.max(1, c.props); seconds += Math.max(1, c.props) * 45 }
  if (/场景|底板/.test(t)) { calls += Math.max(1, c.scenes); seconds += Math.max(1, c.scenes) * 45 }
  if (/看板|故事看板/.test(t)) { calls += Math.max(1, c.boards); seconds += Math.max(1, c.boards) * 45 }
  if (/配图|出图|关键帧/.test(t)) { calls += Math.max(1, c.images); seconds += Math.max(1, c.images) * 45 }
  if (/视频|成片/.test(t)) { calls += Math.max(1, c.videos || c.images); seconds += Math.max(1, c.videos || c.images) * 180 }
  if (/配音|口播|语音/.test(t)) { calls += Math.max(1, c.audio); seconds += Math.max(1, c.audio) * 20 }
  if (/全流程|完整流程|全部做完|从头到尾|全套/.test(t)) {
    const sheets = c.sheets || 1
    const scenes = c.scenes || 1
    const boards = c.boards || plannedShots
    const images = c.images || plannedShots
    const videos = c.videos || plannedShots
    const audio = c.audio || plannedShots
    calls = 1 + sheets + scenes + boards + images + videos + audio
    seconds = 30 + (sheets + scenes + boards + images) * 45 + videos * 180 + audio * 20
  }
  return { calls, seconds }
}
