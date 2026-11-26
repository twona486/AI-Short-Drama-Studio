import { nearestVideoDuration, videoDurationCapability } from '@/services/ai/capabilities/video'
import { isLtxTask } from '@/services/ai/ltxDesktopOptions'
import { isLtxProfile } from '@/services/ai/ltxOptions'
import { autodlVideoProfileId } from '@/services/ai/runtime'
import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import {
  normalizeVideoGenModel,
  normalizeVideoResolution,
  stillModeForVideoModel,
  videoStillNeedsCanvas,
  type VideoGenModel,
  type VideoStillMode
} from '@/types/canvas'
import { stillModeFromNode } from '@/utils/videoStill'
import { rebuildCanvasGraph } from './layout'

/** 노드 모델을 변경할 때 참조 방식도 저장하고 필요하면 샷 키프레임 그룹을 다시 배치한다. */
export function applyShotVideoModel(nodeId: string, model: VideoGenModel, profileId?: string) {
  const project = useProjectStore()
  const settings = useSettingsStore()
  const node = project.current?.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) return
  // H3 v5는 AutoDL 토큰을 사용하며 선택한 연결이 없다고 Zealman으로 바꾸지 않는다.
  const selectedProfileId = profileId
    || (model === 'h3' || model === 'h3-v5' ? autodlVideoProfileId() : undefined)
  const selectedProfile = selectedProfileId
    ? settings.config.videos.find((profile) => profile.id === selectedProfileId)
    : undefined
  const prevStill = stillModeFromNode(node)
  const nextStill = stillModeForVideoModel(model, selectedProfile || settings.config.video)
  const ltx = model === 'h3' && isLtxProfile(selectedProfile)
  const nextH3Mode = ltx ? 'reference' : selectedProfile?.provider === 'zealman' && selectedProfile.workflowId.startsWith('U02-')
    ? 'fl2va'
    : node.data.h3GenMode
  const { durations } = videoDurationCapability({ model, profile: selectedProfile || settings.config.video, resolution: node.data.videoResolution })
  const changedProfile = node.data.videoProfileId !== selectedProfileId || node.data.videoModel !== model
  project.patchCanvasNode(nodeId, {
    ...(changedProfile && isLtxTask(node.data.videoTaskId) ? { videoTaskId: undefined } : {}),
    videoModel: model,
    videoProfileId: selectedProfileId,
    videoStillMode: nextStill,
    h3GenMode: nextH3Mode,
    videoResolution: normalizeVideoResolution(node.data.videoResolution, model),
    ...(node.type === 'videoGen'
      ? { duration: nearestVideoDuration(node.data.duration || durations[0], durations) }
      : {})
  })
  const shotId = node.data.shotId
  if (node.type === 'shotVideo' && shotId) {
    const shot = project.current?.shots.find((s) => s.id === shotId)
    if (shot) {
      project.updateShot(shot.id, {
        ...(changedProfile && isLtxTask(shot.videoTaskId) ? { videoTaskId: undefined } : {}),
        videoProfileId: selectedProfileId,
        h3GenMode: nextH3Mode
      })
    }
  }
  if (
    node.type === 'shotVideo' &&
    videoStillNeedsCanvas(prevStill) !== videoStillNeedsCanvas(nextStill) &&
    project.current
  ) {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
  }
}

/** 노드에서 지정한 연결을 저장해 화면과 실제 요청을 일치시킨다. */
export function applyShotVideoProfile(nodeId: string, profileId: string) {
  const settings = useSettingsStore()
  if (!settings.config.videos.some((profile) => profile.id === profileId)) return
  applyShotVideoModel(nodeId, 'h3', profileId)
}

/** 영상 연결의 참조 방식을 바꾸면 해당 연결을 사용하는 샷 노드를 갱신한다. */
export function syncH3ShotStillModes(stillMode: VideoStillMode) {
  const project = useProjectStore()
  const p = project.current
  if (!p?.canvas) return
  for (const node of p.canvas.nodes) {
    if (node.type !== 'shotVideo') continue
    const model = normalizeVideoGenModel(node.data.videoModel)
    if (model === 'h3-v5' || model === 'wan-prime' ||
      isLtxProfile(useSettingsStore().config.videos.find((profile) => profile.id === node.data.videoProfileId))) continue
    project.patchCanvasNode(node.id, { videoStillMode: stillMode })
  }
  if (project.current) project.setCanvas(rebuildCanvasGraph(project.current, true))
}
