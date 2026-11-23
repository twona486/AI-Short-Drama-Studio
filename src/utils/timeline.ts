import type { Project, TimelineClip } from '@/types'

export function timelineClipAssetId(project: Project, clip: TimelineClip): string | undefined {
  if (clip.assetId) return clip.assetId
  const shot = project.shots.find((item) => item.id === clip.shotId)
  return shot?.videoAssetId || shot?.imageAssetId
}

/** 기존 영상과 이미지로 샷 순서에 따라 타임라인을 만든다. */
export function buildTimelineFromShots(project: Project): TimelineClip[] {
  const clips: TimelineClip[] = [...project.shots]
    .sort((a, b) => a.index - b.index)
    .filter((s) => s.videoAssetId || s.imageAssetId)
    .map((s) => ({
      id: 'tc_' + s.id,
      shotId: s.id,
      startTime: 0,
      duration: s.duration,
      sourceIn: 0,
      transitionIn: project.settings.defaultTransition,
      transitionDuration: 0.5,
      speed: 1,
      volume: 1,
      enabled: true
    }))

  let cursor = 0
  for (const c of clips) {
    c.startTime = cursor
    cursor += c.duration
  }
  return clips
}

/**
 * 타임라인이 비어 있고 내보낼 수 있는 샷이 있으면 자동으로 채운다.
 * 새 타임라인을 만들었는지 반환한다.
 */
export function ensureTimelineFromShots(project: Project): {
  built: boolean
  clips: TimelineClip[]
} {
  if (project.timeline.length > 0) {
    return { built: false, clips: project.timeline }
  }
  const clips = buildTimelineFromShots(project)
  return { built: clips.length > 0, clips }
}

/** 활성 타임라인 클립 또는 샷의 영상이 있어 내보낼 수 있는지 확인한다. */
export function canBuildExport(project: Project | null | undefined): boolean {
  if (!project) return false
  if (project.timeline.some((c) => c.enabled)) return true
  return project.shots.some((s) => s.videoAssetId || s.imageAssetId)
}
