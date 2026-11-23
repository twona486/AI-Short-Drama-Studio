import type { TaskStatus } from './pipeline'
// VideoStillMode is declared below and used on CanvasNode.data

export type CanvasNodeType =
  | 'script'
  | 'subject'
  | 'prop'
  | 'subjectProps'
  | 'scene'
  | 'sceneProps'
  | 'shotBoard'
  | 'shotImage'
  | 'shotFrames'
  | 'shotVideo'
  | 'audio'
  | 'export'
  | 'final'
  | 'groupFrame'
  | 'imageGen'
  | 'videoGen'

/** 이미지에서 영상을 만드는 노드 모델. H3 기본은 15초, h3-v5는 10초와 1080p 옵션을 지원하며 완샹은 Model Studio 키를 쓴다. */
export type VideoGenModel = 'h3' | 'h3-v5' | 'wan-prime'

export type VideoResolution = '768p' | '1080p'

/** H3 영상 생성 방식. reference는 다중 이미지 참조, fl2va는 시작·끝 프레임 방식이다. */
export type H3VideoGenMode = 'reference' | 'fl2va'

/**
 * 영상 생성 전 모델에 맞는 참조 이미지 방식. 캔버스의 키프레임 배치도 이 설정을 따른다.
 * identity는 H3 기본값으로 캐릭터와 배경 이미지만 사용해 인물 추가를 줄인다.
 * keyframe은 캐릭터, 배경, 4컷 키프레임을 참조한다. 완샹 등에서 사용한다.
 * storyboard는 캐릭터, 배경, 스토리 개요판을 참조한다. 숏드라마와 영화 챕터에서 선택할 수 있다.
 */
export type VideoStillMode = 'identity' | 'keyframe' | 'storyboard'

export const DEFAULT_VIDEO_GEN_MODEL: VideoGenModel = 'h3'
export const DEFAULT_H3_GEN_MODE: H3VideoGenMode = 'reference'
export const DEFAULT_VIDEO_STILL_MODE: VideoStillMode = 'identity'

export function normalizeVideoStillMode(value: unknown): VideoStillMode {
  if (value === 'keyframe' || value === 'storyboard') return value
  return 'identity'
}

export function videoStillNeedsCanvas(mode: VideoStillMode): boolean {
  return mode !== 'identity'
}

/** 내장 H3는 캐릭터와 배경, 완샹은 키프레임을 사용한다. 사용자 지정 연결은 profile.stillMode 또는 워크플로를 따른다. */
export function stillModeForVideoModel(
  model: VideoGenModel,
  profile?: { stillMode?: unknown; workflowId?: string; provider?: string } | null
): VideoStillMode {
  if (model === 'wan-prime') return 'keyframe'
  if (model === 'h3-v5') return 'identity'
  const raw = profile?.stillMode
  if (raw === 'identity' || raw === 'keyframe' || raw === 'storyboard') return raw
  const workflow = String(profile?.workflowId || '').toLowerCase()
  const provider = String(profile?.provider || '').toLowerCase()
  if (provider === 'dashscope' || workflow.includes('wan')) return 'keyframe'
  return 'identity'
}

export function normalizeVideoGenModel(value: unknown): VideoGenModel {
  if (value === 'wan-prime') return 'wan-prime'
  if (value === 'h3-v5') return 'h3-v5'
  return 'h3'
}

export function isH3VideoFamily(model: VideoGenModel): boolean {
  return model !== 'wan-prime'
}

export function videoMinSeconds(model: VideoGenModel): number {
  return model === 'wan-prime' ? 2 : 1
}

export function videoMaxSeconds(model: VideoGenModel): number {
  if (model === 'wan-prime') return 30
  if (model === 'h3-v5') return 10
  return 15
}

export function videoMaxRefImages(_model?: VideoGenModel): number {
  return 9
}

export function videoDurationOptions(model: VideoGenModel): number[] {
  const min = videoMinSeconds(model)
  const max = videoMaxSeconds(model)
  return Array.from({ length: max - min + 1 }, (_, i) => min + i)
}

export function videoAllows1080p(model: VideoGenModel): boolean {
  return model === 'h3-v5'
}

export function normalizeVideoResolution(value: unknown, model: VideoGenModel): VideoResolution {
  if (!videoAllows1080p(model)) return '768p'
  if (value === '768p') return '768p'
  return '1080p'
}

export function normalizeH3GenMode(value: unknown): H3VideoGenMode {
  return value === 'fl2va' ? 'fl2va' : 'reference'
}

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  position: { x: number; y: number }
  data: {
    subjectId?: string
    propId?: string
    sceneId?: string
    shotId?: string
    label?: string
    width?: number
    height?: number
    kind?: string
    prompt?: string
    referenceAssetIds?: string[]
    /** 캔버스 연결에서 참조 이미지를 가져오는 상위 노드. 배열 순서대로 이미지 번호를 붙인다. */
    referenceSourceNodeIds?: string[]
    outputAssetId?: string
    duration?: number
    /** 노드별 화면 비율. 비어 있으면 프로젝트 기본값을 상속한다. */
    aspectRatio?: import('./project').AspectRatio
    videoModel?: VideoGenModel
    /** 현재 노드에서 사용할 영상 모델 연결. 다른 공급업체 설정의 혼용을 방지한다. */
    videoProfileId?: string
    /** 영상 참조 방식. 모델을 바꿀 때 저장하며 키프레임 배치를 결정한다. */
    videoStillMode?: VideoStillMode
    /** h3-v5는 1080p를 선택할 수 있다. 다른 모델은 768p로 고정된다. */
    videoResolution?: VideoResolution
    /** 노드에서 선택하는 이미지 해상도. 모델 문서에 따라 1K, 2K, 4K를 사용한다. */
    imageResolution?: '1k' | '2k' | '4k'
    /** 음성 켜기 옵션을 지원하는 모델에서 유음 또는 무음을 지정한다. */
    generateAudio?: boolean
    /** H3에서 참조 이미지 또는 시작·끝 프레임을 사용한다. */
    h3GenMode?: H3VideoGenMode
    firstFrameAssetId?: string
    lastFrameAssetId?: string
    /** 진행 중인 AutoDL 또는 완샹 작업. 재시도 시 기존 결과를 먼저 조회한다. */
    videoTaskId?: string
  }
  status?: TaskStatus
  error?: string
  parentGroupId?: string
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface CanvasGroup {
  id: string
  label: string
  nodeIds: string[]
}

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  groups: CanvasGroup[]
  viewport: CanvasViewport
}

export function emptyCanvas(): CanvasGraph {
  return {
    nodes: [],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 0.85 }
  }
}
