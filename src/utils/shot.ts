import type { Shot, ShotAudioMode } from '@/types'
import { composeShotVisualPrompt } from '@/utils/shotPrompt'

export {
  composeVideoPerformance,
  synthesizeVideoPerformance,
  isVideoPerformanceThin,
  VIDEO_PERFORMANCE_SPEC,
  assembleShotVideoPrompt,
  videoPerformanceSpec,
  videoPromptJsonHint,
  editableVideoPrompt
} from '@/utils/shotPrompt'
export type { VideoPromptStyle } from '@/utils/shotPrompt'

/** 이미지 프롬프트를 별도로 지정했으면 우선 사용하고, 없으면 샷의 화면 묘사를 사용한다. */
export function effectiveImagePrompt(shot: Shot): string {
  return composeShotVisualPrompt(shot, 'image')
}

/** 영상용 연기 설명을 반환한다. 정지 이미지용 프롬프트는 사용하지 않는다. */
export function effectiveVideoPrompt(shot: Shot): string {
  return composeShotVisualPrompt(shot, 'video')
}

export function isDigitalHumanSpeechProject(
  project?: { pipelineMode?: string; speechWorkflow?: { mode?: string } | null } | null
): boolean {
  return project?.pipelineMode === 'smart-speech' && project.speechWorkflow?.mode === 'digital-human'
}

/** H3 화면 대사를 기본으로 사용한다. 오디오를 이미 만든 기존 프로젝트는 TTS로 처리한다. */
export function effectiveShotAudioMode(shot: Shot): ShotAudioMode {
  return shot.audioMode ?? (shot.audioAssetId ? 'tts' : 'h3-dialogue')
}

export function isVideoVoiceMode(mode: ShotAudioMode): boolean {
  return mode === 'h3-dialogue' || mode === 'h3-voiceover'
}

export function compatibleShotAudioMode(mode: ShotAudioMode, supportsVoice: boolean): ShotAudioMode {
  return !supportsVoice && isVideoVoiceMode(mode) ? 'tts' : mode
}

export function h3VoiceMode(shot: Shot): 'dialogue' | 'voiceover' | 'none' {
  const mode = effectiveShotAudioMode(shot)
  if (mode === 'h3-dialogue') return 'dialogue'
  if (mode === 'h3-voiceover') return 'voiceover'
  return 'none'
}

/** 화자가 화면에 없으면 화면 밖 음성으로 처리해 호명된 인물이 입을 움직이지 않도록 한다. */
export function resolveH3VoiceMode(shot: Shot, onScreenNames: string[] = []): 'dialogue' | 'voiceover' | 'none' {
  const mode = h3VoiceMode(shot)
  if (mode !== 'dialogue') return mode
  const speaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  if (!speaker) return mode
  const onScreen = onScreenNames.some((name) => name === speaker || speaker.includes(name) || name.includes(speaker))
  return onScreen ? 'dialogue' : 'voiceover'
}

export function shotLipSyncDuration(shot?: Shot, assetId = shot?.videoAssetId): number | undefined {
  return assetId ? shot?.lipSyncVideos?.[assetId] : undefined
}

export function shotPlaybackDuration(shot: Shot): number {
  return shotLipSyncDuration(shot) ?? shot.duration
}

export function isLipSyncShot(shot: Shot): boolean {
  return effectiveShotAudioMode(shot) === 'ltx-lip-sync' ||
    (shot.audioMode === undefined && !shot.audioAssetId && shotLipSyncDuration(shot) !== undefined)
}

export function needsExternalTts(
  shot: Shot,
  project?: { pipelineMode?: string; speechWorkflow?: { mode?: string } | null } | null
): boolean {
  if (isDigitalHumanSpeechProject(project)) return false
  return effectiveShotAudioMode(shot) === 'tts' && Boolean(shot.voiceover.trim())
}

/** 새 에셋을 현재 결과로 지정하고 기존 에셋은 이력에 보관한다. 중복을 제거하고 최대 12개를 유지한다. */
export function pushHistory(
  currentId: string | undefined,
  nextId: string,
  history: string[] | undefined
): string[] {
  const list = [...(history ?? [])]
  if (currentId && currentId !== nextId && !list.includes(currentId)) {
    list.unshift(currentId)
  }
  return list.filter((id) => id !== nextId).slice(0, 12)
}
