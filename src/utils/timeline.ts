import type { Project, TimelineClip } from '@/types'
import { effectiveShotAudioMode, shotLipSyncDuration, shotPlaybackDuration } from './shot'
import { buildCuesFromClips } from '@/services/ffmpeg/subtitle'

export function timelineClipAssetId(project: Project, clip: TimelineClip): string | undefined {
  if (clip.assetId) return clip.assetId
  const shot = project.shots.find((item) => item.id === clip.shotId)
  return shot?.videoAssetId || shot?.imageAssetId
}

export function clipLipSyncDuration(project: Project, clip: TimelineClip): number | undefined {
  return shotLipSyncDuration(project.shots.find((shot) => shot.id === clip.shotId), timelineClipAssetId(project, clip))
}

export function clipCaptionDuration(project: Project, clip: TimelineClip): number {
  const duration = clipLipSyncDuration(project, clip)
  if (duration === undefined) return clip.duration
  return Math.min(clip.duration, Math.max(0, duration - (clip.sourceIn || 0)) / (clip.speed || 1))
}

export function buildTimelineCaptionCues(project: Project, clips = project.timeline) {
  if (clips.length) {
    return buildCuesFromClips(clips.map((clip) => ({
      startTime: clip.startTime,
      duration: clipCaptionDuration(project, clip),
      text: project.shots.find((shot) => shot.id === clip.shotId)?.voiceover ?? ''
    })))
  }
  let startTime = 0
  return buildCuesFromClips(project.shots.map((shot) => {
    const duration = shotPlaybackDuration(shot)
    const cue = { startTime, duration, text: shot.voiceover }
    startTime += duration
    return cue
  }))
}

/** 후반 더빙이나 내레이션 없음을 선택하면 기존 립싱크 영상의 소리를 끈다. */
export function clipAudioSelection(project: Project, clip: TimelineClip, keepAmbient: boolean) {
  const shot = project.shots.find((item) => item.id === clip.shotId)
  const hasLipSync = clipLipSyncDuration(project, clip) !== undefined
  const mode = shot && effectiveShotAudioMode(shot)
  const muteLipSync = hasLipSync && (mode === 'tts' || mode === 'none')
  const embeddedLipSync = hasLipSync && !muteLipSync
  return {
    keepSource: !muteLipSync && (embeddedLipSync || project.pipelineMode === 'smart-speech' ||
      mode === 'h3-dialogue' || mode === 'h3-voiceover' || keepAmbient),
    embeddedLipSync,
    voiceAssetId: embeddedLipSync ? undefined : clip.voiceAssetId
  }
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
      duration: shotPlaybackDuration(s),
      sourceIn: 0,
      transitionIn: 'none',
      transitionDuration: 0,
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
