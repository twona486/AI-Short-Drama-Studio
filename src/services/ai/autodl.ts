import { t as translate } from '@/i18n'
import {
  VIDEO_AUTODL_ROOT,
  VIDEO_DEFAULT_WORKFLOW_ID,
  VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
  VIDEO_FL2VA_WORKFLOW_ID,
  VIDEO_H3_MULTI_AUDIO_WORKFLOW_ID,
  VIDEO_H3_V5_10S_WORKFLOW_ID
} from './env'

/** AutoDL 기본 게이트웨이 주소. 사용자는 토큰만 입력한다. */
export const AUTODL_BASE_URL = VIDEO_AUTODL_ROOT

export interface AutodlWorkflow {
  displayName?: string
  legacyName?: string
  id: string
  name: string
  mode: 'standard' | 'fl2va' | 'audio-sync' | 'multi-audio'
  maxDuration: number
  note: string
}

/**
 * autodl.art에서 제공하는 내장 H3 워크플로 목록
 * 설정에서 AutoDL 토큰을 한 번 입력하면 된다.
 */
export const AUTODL_WORKFLOWS: AutodlWorkflow[] = [
  {
    id: VIDEO_DEFAULT_WORKFLOW_ID,
    name: 'H3 이미지→영상 · 15초',
    legacyName: 'H3 图生视频 · 15 秒',
    get displayName() { return translate('autodlSettings.h3Name') },
    mode: 'standard',
    maxDuration: 15,
    get note() { return translate('autodlSettings.h3Note') }
  },
  {
    id: VIDEO_H3_V5_10S_WORKFLOW_ID,
    name: 'H3 v5 · 10초(1080p 선택 가능)',
    legacyName: 'H3 v5 · 10 秒（可选 1080p）',
    get displayName() { return translate('autodlSettings.h3V5Name') },
    mode: 'standard',
    maxDuration: 10,
    get note() { return translate('autodlSettings.h3V5Note') }
  },
  {
    id: VIDEO_FL2VA_WORKFLOW_ID,
    name: 'H3 시작·끝 프레임',
    legacyName: 'H3 首尾帧',
    get displayName() { return translate('autodlSettings.firstLastName') },
    mode: 'fl2va',
    maxDuration: 10,
    get note() { return translate('autodlSettings.firstLastNote') }
  },
  {
    id: VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
    name: '디지털 휴먼 내레이션 · 이미지와 오디오',
    legacyName: '数字人口播 · 图 + 音频',
    get displayName() { return translate('autodlSettings.digitalHumanName') },
    mode: 'audio-sync',
    maxDuration: 15,
    get note() { return translate('autodlSettings.digitalHumanNote') }
  },
  {
    id: VIDEO_H3_MULTI_AUDIO_WORKFLOW_ID,
    name: 'H3 이미지·오디오 다중 참조 영상',
    legacyName: 'H3多图多音频生视频(升级画质)',
    get displayName() { return translate('autodlSettings.multiAudioName') },
    mode: 'multi-audio',
    maxDuration: 15,
    get note() { return translate('autodlSettings.multiAudioNote') }
  }
]

export function autodlWorkflowById(id: string): AutodlWorkflow | undefined {
  return AUTODL_WORKFLOWS.find((workflow) => workflow.id === id)
}
