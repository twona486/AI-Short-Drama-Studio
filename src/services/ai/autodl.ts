import { t as translate } from '@/i18n'
import {
  VIDEO_AUTODL_ROOT,
  VIDEO_DEFAULT_WORKFLOW_ID,
  VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
  VIDEO_FL2VA_WORKFLOW_ID,
  VIDEO_H3_V5_10S_WORKFLOW_ID
} from './env'

/** AutoDL 固定网关地址，用户只填 Token，不需要碰地址。 */
export const AUTODL_BASE_URL = VIDEO_AUTODL_ROOT

export interface AutodlWorkflow {
  id: string
  name: string
  displayName: string
  mode: 'standard' | 'fl2va' | 'audio-sync'
  maxDuration: number
  note: string
}

/**
 * AutoDL 内置 H3 系列工作流。全部对应 autodl.art 上的现成工作流，
 * 用户只需要在设置里填一次 AutoDL Token。
 */
export const AUTODL_WORKFLOWS: AutodlWorkflow[] = [
  {
    id: VIDEO_DEFAULT_WORKFLOW_ID,
    name: 'H3 图生视频 · 15 秒',
    get displayName() { return translate('autodlSettings.h3Name') },
    mode: 'standard',
    maxDuration: 15,
    get note() { return translate('autodlSettings.h3Note') }
  },
  {
    id: VIDEO_H3_V5_10S_WORKFLOW_ID,
    name: 'H3 v5 · 10 秒（可选 1080p）',
    get displayName() { return translate('autodlSettings.h3V5Name') },
    mode: 'standard',
    maxDuration: 10,
    get note() { return translate('autodlSettings.h3V5Note') }
  },
  {
    id: VIDEO_FL2VA_WORKFLOW_ID,
    name: 'H3 首尾帧',
    get displayName() { return translate('autodlSettings.firstLastName') },
    mode: 'fl2va',
    maxDuration: 10,
    get note() { return translate('autodlSettings.firstLastNote') }
  },
  {
    id: VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
    name: '数字人口播 · 图 + 音频',
    get displayName() { return translate('autodlSettings.digitalHumanName') },
    mode: 'audio-sync',
    maxDuration: 15,
    get note() { return translate('autodlSettings.digitalHumanNote') }
  }
]

export function autodlWorkflowById(id: string): AutodlWorkflow | undefined {
  return AUTODL_WORKFLOWS.find((workflow) => workflow.id === id)
}
