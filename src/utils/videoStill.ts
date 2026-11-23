import type { CanvasNode, Project, Shot } from '@/types'
import {
  normalizeH3GenMode,
  normalizeVideoGenModel,
  stillModeForVideoModel,
  type VideoStillMode
} from '@/types/canvas'

export function stillModeFromNode(node?: Pick<CanvasNode, 'data'> | null): VideoStillMode {
  const raw = node?.data.videoStillMode
  if (raw === 'identity' || raw === 'keyframe' || raw === 'storyboard') return raw
  return stillModeForVideoModel(normalizeVideoGenModel(node?.data.videoModel))
}

export function shotVideoNode(project: Project | null | undefined, shotId: string) {
  return project?.canvas?.nodes.find((n) => n.type === 'shotVideo' && n.data.shotId === shotId)
}

export function stillModeForShot(shot: Shot, project: Project): VideoStillMode {
  return stillModeFromNode(shotVideoNode(project, shot.id))
}

export function shotMissingStill(shot: Shot, project: Project): boolean {
  // 시작·끝 프레임으로 영상을 생성할 때는 키프레임과 개요판이 필요 없다.
  if (shotUsesFrames(shot, project)) return false
  const mode = stillModeForShot(shot, project)
  if (mode === 'storyboard') return !shot.boardAssetId
  if (mode === 'keyframe') return !shot.imageAssetId
  return false
}

export function stillTypeForMode(mode: VideoStillMode): 'shotBoard' | 'shotImage' | null {
  if (mode === 'storyboard') return 'shotBoard'
  if (mode === 'keyframe') return 'shotImage'
  return null
}

export function shotsMissingKeyframe(project: Project): Shot[] {
  return (project.shots ?? []).filter(
    (shot) =>
      !shotUsesFrames(shot, project) && stillModeForShot(shot, project) === 'keyframe' && !shot.imageAssetId
  )
}

export function shotsMissingStoryboard(project: Project): Shot[] {
  return (project.shots ?? []).filter(
    (shot) =>
      !shotUsesFrames(shot, project) && stillModeForShot(shot, project) === 'storyboard' && !shot.boardAssetId
  )
}

/** 프로젝트 전체의 프레임 연결 또는 샷의 개별 h3GenMode를 확인한다. */
export function shotUsesFrames(shot: Shot, project: Project | null | undefined): boolean {
  if (!project) return false
  if ((project.settings?.h3ShotChainMode || 'auto') === 'fl2va') return true
  return normalizeH3GenMode(shot.h3GenMode) === 'fl2va'
}

/**
 * 프로젝트의 프레임 연결 또는 개별 샷의 시작·끝 프레임 설정을 확인한다.
 * 캔버스, 제작 순서, 에이전트에서 공통으로 사용한다.
 */
export function needsShotFrames(project: Project | null | undefined): boolean {
  if (!project) return false
  if ((project.settings?.h3ShotChainMode || 'auto') === 'fl2va') return true
  return (project.shots ?? []).some((shot) => normalizeH3GenMode(shot.h3GenMode) === 'fl2va')
}

/** 시작·끝 프레임 모드를 사용하는 샷에서 누락된 프레임을 찾는다. */
export function shotsMissingFrames(project: Project | null | undefined): Shot[] {
  if (!project) return []
  return (project.shots ?? []).filter(
    (shot) => shotUsesFrames(shot, project) && (!shot.firstFrameAssetId || !shot.lastFrameAssetId)
  )
}

/** 아직 시작 또는 종료 프레임을 만들어야 하는 샷이 있는지 확인한다. */
export function frameStagePending(project: Project | null | undefined): boolean {
  return needsShotFrames(project) && shotsMissingFrames(project).length > 0
}
