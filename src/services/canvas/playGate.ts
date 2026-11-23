import type { Project } from '@/types'
import { t } from '@/i18n'

export function playGateMessage() {
  return t('canvasRunner.scriptReview')
}

export function isPlayApproved(p: Project | null | undefined): boolean {
  if (!p) return false
  if (p.playApproved === true) return true
  if (p.playApproved === false) return false
  const hasDownstream =
    (p.subjects ?? []).some((s) => s.designSheetAssetId) ||
    (p.scenes ?? []).some((s) => s.plateAssetId) ||
    p.shots.some((s) => s.imageAssetId || s.videoAssetId)
  return hasDownstream
}

/** 有分镜但剧本还没验收时才需要拦；是否真的拦由调用方按「本次动作」决定 */
export function needsPlayReview(p: Project | null | undefined): boolean {
  return Boolean(p?.shots.length) && !isPlayApproved(p)
}

export function isFullPipelineRequest(text: string) {
  return /全部做完|全部生成|都生成|全做|一口气|整条流水线|从头到尾|缺的都补|全流程|完整流程|全套|전체\s*과정/.test(text) ||
    /^(?:전체\s*워크플로(?:를?\s*(?:진행해|실행해)(?:\s*줘)?)?|(?:run (?:the )?)?(?:full|entire) workflow)[.!。！]*$/i.test(text.trim())
}

export function isApprovePlayRequest(text: string) {
  return /确认剧本|验收通过|确认通过|剧本没问题|通过验收|验收了/.test(text) ||
    /^(?:검수\s*통과|대본\s*승인|(?:approve|accept) (?:the )?(?:script|screenplay)|script approved)[.!。！]*$/i.test(text.trim())
}

export const DOWNSTREAM_TOOLS = new Set([
  'generate_shot_board',
  'generate_all_boards',
  'generate_shot_image',
  'generate_all_images',
  'generate_shot_frames',
  'generate_all_frames',
  'generate_video',
  'generate_all_videos',
  'generate_audio',
  'generate_all_audio',
  'run_node'
])
