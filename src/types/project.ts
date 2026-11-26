/**
 * 프로젝트 핵심 데이터 타입
 *
 * AI 영상 프로젝트의 전체 데이터 모델이다.
 * - script: 대본 원문
 * - shots: 각 화면, 영상 클립, 자막에 해당하는 샷 목록
 * - assets: 이미지, 영상, 오디오 에셋
 * - timeline: 편집 결과의 재생 순서
 * - settings: 해상도, 프레임률, 전환, 자막 등 프로젝트 설정
 */

import type { CanvasGraph, H3VideoGenMode } from './canvas'

export type ID = string

export type AgentAutonomy = 'assist' | 'gated' | 'autopilot'

export interface AgentChatMessage {
  id: ID
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export interface AgentTaskRecord {
  id: ID
  request: string
  status: 'planned' | 'running' | 'success' | 'failed' | 'cancelled'
  currentStep?: string
  completedTools: string[]
  /** 의존성 보완이나 실패 후 재계획을 수행한 누적 횟수. 프로젝트에 저장한다. */
  repairCount?: number
  /** 최근 자동 복구 진단. 작업 재개와 화면 안내에 사용한다. */
  lastRecovery?: string
  failedTool?: string
  error?: string
  estimatedCalls?: number
  estimatedSeconds?: number
  startedAt: number
  finishedAt?: number
}

export interface AgentWorkspaceState {
  autonomy: AgentAutonomy
  messages: AgentChatMessage[]
  tasks: AgentTaskRecord[]
  /** 한 번의 자동 작업에서 허용하는 외부 생성 호출 수. 0이면 제한을 두지 않는다. */
  callBudget: number
}

/** 화면 화풍. */
export type VisualStyle =
  | 'cinematic'
  | 'anime'
  | 'oil-painting'
  | '3d-render'
  | 'photorealistic'
  | 'watercolor'
  | 'pixel-art'
  | 'ink-wash'

/** 영상 화면 비율. */
export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '21:9'

/** 스토리보드의 단일 샷. */
export interface Shot {
  id: ID
  index: number
  /** 샷 제목. */
  title: string
  /**
   * 상세 화면 묘사.
   * 후속 이미지와 영상 생성에 사용할 수 있도록 다음 정보를 포함한다.
   * 배경, 캐릭터와 의상 및 상태, 동작, 카메라 및 샷 크기, 조명과 색상 및 분위기.
   */
  visualPrompt: string
  /** 프로젝트 전체 샷에 적용되는 분위기와 미학. */
  aesthetic?: string
  /** 빗소리, 배가 흔들리는 소리, 불이 타는 소리 등 효과음 묘사. */
  audioDescription: string
  /** 내레이션 원고 또는 자막 텍스트. */
  voiceover: string
  /** H3 자체 대사나 화면 밖 음성, 후반 TTS 또는 음성 없음. */
  audioMode?: ShotAudioMode
  /** 생성 작업과 영상 에셋에 각각 연결된 립싱크 WAV 길이(초). */
  lipSyncFrame?: { assetId: ID; prompt: string; aspect: AspectRatio }
  lipSyncTask?: { id: string; duration: number }
  lipSyncVideos?: Record<ID, number>
  /** H3 화자의 음색과 말하는 방식. 예를 들어 자연스럽고 차분한 젊은 여성 목소리. */
  speakerHint?: string
  /**
   * 현재 샷의 화자 음색. 스토리보드를 나눌 때 Subject.voicePrompt에서 연결한다.
   * 영상과 더빙 생성에 사용한다. 캐릭터 카드에서 수정한 음색은 생성 작업을 다시 실행하면 반영된다.
   */
  speakerVoice?: string
  ttsInstruction?: string
  /** 샷 길이(초). */
  duration: number
  /** 카메라 움직임. 밀기, 당기기, 팬, 틸트, 고정, 회전. */
  cameraMovement: 'push' | 'pull' | 'pan' | 'tilt' | 'static' | 'orbit'
  /** 상황 설정, 대치, 반응, 공개, 전환 등 샷의 극적 기능. */
  purpose?: string
  /** 원경, 풀 샷, 미디엄 샷, 클로즈업, 익스트림 클로즈업 등 샷 크기. */
  shotSize?: string
  /** 배경 기준점을 중심으로 한 위치와 방향. 화면 좌우의 절대 좌표는 쓰지 않는다. */
  blocking?: string
  /** 시선과 몸이 향하는 방향. */
  eyeline?: string
  /** 샷 간 연결. 시작 모습, 보이는 변화, 종료 상태를 기록한다. */
  continuity?: string
  /** 현재 샷의 주요 소품과 상태. */
  propFocus?: string
  /**
   * 동일한 샷의 시작, 동작, 반응, 종료를 담은 흑백 6컷 스토리 개요판.
   * 이미지에서는 구도를, 영상에서는 동작 순서를 참조한다.
   */
  boardAssetId?: ID
  boardHistoryIds?: ID[]
  /** 스토리 개요판 프롬프트. 비어 있으면 visualPrompt를 사용한다. */
  boardPrompt?: string
  /** 연결된 에셋. */
  imageAssetId?: ID
  videoAssetId?: ID
  /** 현재 샷에 지정한 영상 모델 프로필. */
  videoProfileId?: string
  /** AutoDL 또는 완샹에서 미완료 다운로드의 작업 ID. 재시도 시 재제출 전에 결과를 조회한다. */
  videoTaskId?: string
  /** 내레이션 TTS 오디오. */
  audioAssetId?: ID
  /** 현재 이미지를 제외한 이전 생성 이미지. 리소스 라이브러리에서 재사용할 수 있다. */
  imageHistoryIds?: ID[]
  /** 현재 영상을 제외한 이전 생성 영상. */
  videoHistoryIds?: ID[]
  /** 이전에 생성한 내레이션. */
  audioHistoryIds?: ID[]
  /**
   * 이미지 생성 프롬프트. 비어 있으면 visualPrompt를 사용한다.
   * 이미지 생성 페이지에서 원래 화면 묘사와 별도로 편집할 수 있다.
   */
  imagePrompt?: string
  /**
   * 영상 연기 지침. 인물 동작, 대사, 카메라 움직임을 지정한다.
   * 정지 화면 묘사인 visualPrompt는 재사용하지 않는다. 비어 있으면 샷의 동작과 대사로 구성한다.
   */
  videoPrompt?: string
  /** 영상 생성 API에 전송할 전체 프롬프트. 입력 내용을 그대로 사용한다. */
  compiledVideoPrompt?: string
  /** H3 전용 모드. 참조 이미지 기반 또는 시작·끝 프레임 기반. */
  h3GenMode?: H3VideoGenMode
  /** 시작·끝 프레임 모드의 시작 프레임. 없으면 이 샷의 이미지를 사용한다. */
  firstFrameAssetId?: ID
  /** 시작·끝 프레임 모드의 종료 프레임. */
  lastFrameAssetId?: ID
  /**
   * 시작 프레임의 구도, 캐릭터의 시작 상태, 조명을 묘사한다.
   * 비어 있으면 샷 묘사와 연속성 정보에서 만들며 노드에서 편집할 수 있다.
   */
  startFramePrompt?: string
  /**
   * 동작이 완료된 시점의 종료 프레임을 묘사한다.
   * 비어 있으면 연속성의 종료 상태를 사용하며 노드에서 편집할 수 있다.
   */
  endFramePrompt?: string
  /** 이 샷의 이미지 생성 및 편집에 쓰는 참조 에셋 ID 목록. */
  referenceAssetIds?: ID[]
  /** 캐릭터, 배경, 개요판 등 이 샷을 생성할 때 제외할 참조 이미지. */
  omittedRefAssetIds?: ID[]
  /** 샷에 등장하는 인물과 동물. Project.subjects에 대응한다. */
  subjectIds?: ID[]
  /** 샷의 배경. Project.scenes에 대응한다. */
  sceneId?: ID
  /** 기본값보다 우선 적용할 자막 스타일. */
  captionOverride?: Partial<CaptionStyle>
  /** 샷 상태. */
  status: 'draft' | 'image-generated' | 'video-generated' | 'ready'
  /** 메모. */
  notes?: string
}

export type ShotAudioMode = 'h3-dialogue' | 'h3-voiceover' | 'tts' | 'ltx-lip-sync' | 'none'

/** 스마트 내레이션의 세 가지 제작 모드. */
export type SpeechWorkflowMode = 'digital-human' | 'human-edit' | 'human-aigc'

export type SpeechWorkflowStage =
  | 'ready'
  | 'editing'
  | 'packaging'
  | 'quality-check'
  | 'complete'
  | 'failed'

export interface SpeechWorkflowOptions {
  removePauses: boolean
  removeStumbles: boolean
  beauty: boolean
  captions: boolean
  titles: boolean
  keywordCallouts: boolean
  soundEffects: boolean
  bgm: boolean
  aigcInserts: boolean
}

/** 스마트 내레이션의 입력과 진행 상태. 결과는 Shot, Timeline, Asset으로 기록한다. */
export interface SpeechWorkflow {
  mode: SpeechWorkflowMode
  stage: SpeechWorkflowStage
  imageAssetId?: ID
  /** 음성 복제용 디지털 휴먼 샘플. 완성 영상의 내레이션 트랙과 구분한다. */
  voiceSampleAssetId?: ID
  /** @deprecated 이전 프로젝트가 음성 샘플을 저장한 키. 읽기 호환용이다. */
  audioAssetId?: ID
  clonedVoiceId?: string
  clonedVoiceModel?: string
  generatedVideoAssetIds?: ID[]
  generatedSpeechAssetIds?: ID[]
  /** 미완료 구간의 저장된 오디오. 재시도 시 재사용한다. */
  pendingSegmentIndex?: number
  pendingSpeechAssetId?: ID
  /** H3에 제출한 작업. 일시 정지, 시간 초과, 재시작 후 다시 제출하지 않고 조회한다. */
  activeVideoTaskId?: string
  activeVideoTaskSegmentIndex?: number
  /** 동시에 제출 중인 작업. 구간 인덱스로 조회를 재개한다. */
  activeVideoTasks?: Array<{ index: number; taskId: string }>
  videoAssetIds: ID[]
  referenceAssetIds: ID[]
  options: SpeechWorkflowOptions
  progress?: string
  error?: string
  createdAt: number
  updatedAt: number
}

/** 프로젝트 대본. */
export interface Script {
  id: ID
  /** 대본 주제 또는 제목. */
  topic: string
  /** 대본 본문. */
  content: string
  /** 키워드. */
  keywords: string[]
  /** 화풍. */
  style: VisualStyle
  /** 사용자가 나중에 바꾼 프로젝트 스타일은 원래 대본의 스타일보다 우선한다. 대본은 보존한다. */
  visualStyleOverride?: string
  /** 영상 화면 비율. */
  aspectRatio: AspectRatio
  /** 샷별 목표 길이. */
  shotDuration: number
  /**
   * 사용자가 요청한 완성 영상 길이(초). 대본과 샷 수에 적용한다.
   * 0 또는 미지정이면 내용에 맞춰 길이를 정한다.
   */
  targetDurationSec?: number
  /** 영화 챕터, 일반 숏드라마, 영상 재현 각각의 제작 방식. */
  workflowMode?: 'film-chapter'
  /**
   * 프로젝트 전체의 분위기.
   * 예를 들어 따뜻한 등불 빛이 차가운 비와 안개를 가르는 무협 영화 풍경.
   * 영상 생성 시 각 샷의 videoPrompt와 함께 사용한다.
   */
  aesthetic?: string
  /** H3 Aesthetic 항목에 전달할 영어 문장. */
  h3Aesthetic?: string
  /** 소재, 갈등, 극적 포인트 등을 담은 화풍 요약. */
  styleBrief?: string
  /** 기준 색상. */
  colorPalette?: string
  /** 전체 조명과 시간대. */
  lightingNote?: string
  /** 전체 샷에서 사용할 제품 또는 화풍 참조 이미지. 최대 5장 권장. */
  referenceAssetIds?: ID[]
  /**
   * 짧은 창작 요약이 완성된 대본으로 확장되었는지 나타낸다.
   * true일 때 인물, 배경, 스토리보드 노드를 추출할 수 있다.
   */
  playReady?: boolean
  /**
   * imported는 사용자가 가져온 대본이다. 원문을 편집하지 않고 스토리보드를 나눈다.
   * generated는 대본 작성으로 생성한 대본이다. 값이 없는 이전 프로젝트는 기존 방식으로 처리한다.
   */
  origin?: 'imported' | 'generated'
  /**
   * 스토리보드 생성 중 완료한 작업 묶음을 저장한다.
   * playKey가 같은 대본이면 이전 묶음을 재사용한다.
   */
  shotBatches?: {
    playKey: string
    batches: Record<string, Array<Record<string, unknown>>>
  }
  /** 생성 시각. */
  createdAt: number
}

/** 독립적으로 작성하거나 제작에 투입할 수 있는 대본 챕터. */
export interface ScriptChapter {
  id: ID
  title: string
  content: string
  order: number
  status: 'draft' | 'ready'
  createdAt: number
  updatedAt: number
}

/** 자막 스타일. */
export interface CaptionStyle {
  /** 글꼴. */
  fontFamily: string
  /** 영상 높이에 대한 글자 크기 비율. 예를 들어 0.03은 3퍼센트다. */
  fontSizeRatio: number
  /** 글자색. */
  color: string
  /** 외곽선. */
  strokeColor: string
  strokeWidth: number
  /** 배경. */
  bgColor: string
  bgOpacity: number
  /** 위치. bottom, center, top 중 하나다. */
  position: 'top' | 'center' | 'bottom'
  /** 자유 배치의 중심점. 화면 너비와 높이에 대한 0~1 좌표다. */
  xRatio?: number
  yRatio?: number
  /** 굵게 표시할지 여부. */
  bold: boolean
}

/** 프로젝트 설정. */
export interface ProjectSettings {
  aspectRatio: AspectRatio
  width: number
  height: number
  fps: number
  defaultShotDuration: number
  captionStyle: CaptionStyle
  /** 기본 전환. */
  defaultTransition: TransitionType
  /** 배경 음악 음량. */
  bgmVolume: number
  /** 원본 영상의 현장음 음량. */
  originalVolume: number
  /** TTS 또는 무음 샷의 현장음을 보존할지 여부. H3 내장 대사와 내레이션은 항상 보존한다. */
  keepAmbientAudio?: boolean
  /** 자막에 배경색을 적용할지 여부. */
  captionBg: boolean
  /** 내보낼 때 영상에 자막을 합성할지 여부. */
  burnCaptions: boolean
  /** 자막에서 강조할 단어를 자동으로 찾아 같은 줄에서 색상과 크기를 바꾼다. */
  captionHighlight?: boolean
  /** 강조 단어의 색상. */
  captionHighlightColor?: string
  /** 강조 단어의 글자 크기 배율. */
  captionHighlightScale?: number
  /** 프로젝트의 기본 내레이션 목소리. */
  ttsVoice?: string
  /**
   * H3 영상 생성 모드. auto는 샷별 참조 이미지나 키프레임을 사용한다.
   * fl2va는 둘째 샷부터 이전 영상의 끝 프레임과 다음 샷의 참조 이미지를 연결한다.
   */
  h3ShotChainMode?: 'auto' | 'fl2va'
  /** 제작 환경설정의 기본 영상 해상도다. H3에서 1080p 출력은 v5가 지원하며, Wan 노드는 480P, 720P, 1080P를 개별 선택한다. */
  defaultVideoResolution?: import('./canvas').VideoResolution
}

/** 전환 유형. */
export type TransitionType =
  | 'none'
  | 'fade'
  | 'fade-black'
  | 'slide-left'
  | 'slide-right'
  | 'zoom-in'
  | 'zoom-out'

/** 타임라인 클립. */
export interface TimelineClip {
  id: ID
  shotId: ID
  /** 자유 편집 클립은 영상이나 이미지 에셋을 직접 참조할 수 있다. */
  assetId?: ID
  /** 자유 편집 타임라인에 표시하는 에셋 이름. */
  label?: string
  /** 타임라인에서의 시작 시각(초). */
  startTime: number
  /** 클립 길이(초). */
  duration: number
  /** 원본 에셋에서 재생을 시작하는 위치. */
  sourceIn: number
  /** 진입 전환. */
  transitionIn: TransitionType
  /** 전환 길이. */
  transitionDuration: number
  /** 재생 속도 배율. 1은 정상 속도, 2는 두 배속이다. */
  speed: number
  /** 음량. 범위는 0~1이다. */
  volume: number
  /** 이 클립의 더빙이다. 설정돼 있으면 내보낼 때 스토리보드의 음성보다 먼저 사용한다. */
  voiceAssetId?: ID
  /** 더빙의 시작 위치를 초 단위로 나타낸다. */
  voiceSourceIn?: number
  /** 더빙 음량 범위는 0~1이다. */
  voiceVolume?: number
  enabled: boolean
}

export interface AudioTimelineClip {
  assetId: ID
  startTime: number
  sourceIn: number
  duration: number
  volume: number
}

export interface TextOverlay {
  id: ID
  text: string
  startTime: number
  duration: number
  fontFamily: string
  fontSizeRatio: number
  color: string
  position: 'top' | 'center' | 'bottom'
  /** 화면에 놓인 텍스트 블록 중심의 상대 좌표. 범위는 0~1이다. */
  xRatio?: number
  yRatio?: number
  bold: boolean
}

/** 작품에 걸쳐 외형을 유지할 인물, 동물, 주요 사물. 이미지 생성에 다각도 참조를 사용한다. */
export interface Subject {
  id: ID
  name: string
  kind: 'person' | 'animal' | 'other'
  /** 전체 샷에서 유지할 외형 묘사. */
  description: string
  /** 주인공, 반대자, 목격자 등 극 중 역할. */
  role?: string
  /** 배달 재킷 차림이나 정장 차림 등 캐릭터 상태 변화. */
  stateVariants?: string
  /** 얼굴 클로즈업과 전신 정면, 측면, 후면을 담은 사면도. */
  designSheetAssetId?: ID
  /** 현재 사면도를 제외한 이전 사면도. */
  designSheetHistoryIds?: ID[]
  /** 에셋 이미지에 사용할 착용물과 휴대품 목록. */
  props?: string
  /** 가방, 신분증, 태블릿, 신발 등 캐릭터가 착용하거나 들고 다니는 물건을 보여 주는 이미지. */
  propSheetAssetId?: ID
  propSheetHistoryIds?: ID[]
  /** 사용자 참조 이미지에서 식별했는지 여부. */
  fromReference?: boolean
  /** 사면도 생성용 추가 참조 이미지. */
  referenceAssetIds?: ID[]
  /** 에셋 이미지 생성용 추가 참조 이미지. */
  propReferenceAssetIds?: ID[]
  /** 이미지 API에 그대로 전송할 사면도 프롬프트. */
  sheetPrompt?: string
  /** TTS와 음성 묘사를 지원하는 모델에 전달할 캐릭터 음색 설명. */
  voicePrompt?: string
  openAiTtsVoice?: string
  elevenLabsVoiceId?: string
  /** Model Studio Qwen3-TTS-VC 등 음성 복제를 지원하는 모델에서 쓸 참조 오디오 에셋. */
  voiceRefAssetId?: ID
  /** 참조 오디오를 처음 사용해 내레이션을 생성할 때 얻은 복제 음성 ID. */
  clonedVoiceId?: string
  clonedVoiceModel?: string
}

/** 대본에 두 번 이상 등장하며 다각도 참조를 만드는 반복 소품. */
export interface StoryProp {
  id: ID
  name: string
  /** 소품의 모양, 재질, 색상, 사용감. 위치 정보는 제외한다. */
  description: string
  /** 대본 본문에서 이 이름이 나오는 횟수. */
  mentions?: number
  /** 흰 배경에 정면, 측면, 후면, 디테일을 보여 주는 이미지. */
  designSheetAssetId?: ID
  designSheetHistoryIds?: ID[]
  referenceAssetIds?: ID[]
  /** 이미지 API에 전달할 다각도 프롬프트. */
  sheetPrompt?: string
}

/** 작품 전체가 참조할 4컷 배경 이미지. 전경, 기준점, 지면, 조명을 담는다. */
export interface Scene {
  id: ID
  name: string
  /** 장소, 시간, 날씨, 조명, 재질을 지정하는 배경 묘사. */
  description: string
  /** 로비 안내대나 엘리베이터 문 등 인물의 위치를 설명할 기준점. */
  mainAnchor?: string
  /** 4컷 기준점 목록. 각 항목은 세미콜론으로 구분한다. */
  anchors?: string
  /** 시간대와 광원. */
  lighting?: string
  /** 현재 배경에서 줄거리에 영향을 주거나 인물이 사용하는 주요 소품. 세미콜론으로 구분한다. */
  props?: string
  /** 4컷 배경 기준 이미지. */
  plateAssetId?: ID
  /** 현재 이미지를 제외한 이전 배경 기준 이미지. */
  plateHistoryIds?: ID[]
  /** 배경 기준 이미지 생성에 사용할 추가 참조. */
  referenceAssetIds?: ID[]
  /** 현재 배경의 주요 소품 설정 이미지. */
  propSheetAssetId?: ID
  propSheetHistoryIds?: ID[]
  propReferenceAssetIds?: ID[]
  /** 이미지 API에 그대로 전달할 배경 기준 이미지 프롬프트. */
  platePrompt?: string
  /** 이미지 API에 그대로 전달할 주요 소품 프롬프트. */
  propSheetPrompt?: string
}

/** 전체 프로젝트. */
export interface Project {
  id: ID
  name: string
  defaultNamesLocalized?: true
  script: Script | null
  /** 숏드라마 챕터 라이브러리. 대본 작성과 영상 제작을 별도로 진행한다. */
  chapters?: ScriptChapter[]
  /** 스토리보드 제작을 위해 대본 워크스페이스에서 선택한 챕터. */
  selectedChapterIds?: ID[]
  /** 현재 제작 범위를 안내하기 위해 최근 대본에 조립한 챕터. */
  productionChapterIds?: ID[]
  shots: Shot[]
  /** 작품의 캐릭터. 영상이나 이미지를 생성하기 전에 다각도 참조 이미지를 생성한다. */
  subjects?: Subject[]
  /** 대본의 반복 소품. 영상이나 이미지를 생성하기 전에 다각도 참조 이미지를 생성한다. */
  props?: StoryProp[]
  /** 작품의 배경 이미지. */
  scenes?: Scene[]
  timeline: TimelineClip[]
  settings: ProjectSettings
  /** 자막 페이지에서 편집한 SRT. 내보낼 때 우선 사용한다. */
  captionSrt?: string
  /** 작품의 배경 음악 에셋 ID. */
  bgmAssetId?: ID
  /** 간편 편집기의 음악 트랙 클립. */
  bgmClip?: AudioTimelineClip
  /** 간편 편집기에서 스타일과 구간을 따로 지정할 수 있는 텍스트 블록. */
  textOverlays?: TextOverlay[]
  /** 배경 음악 생성 프롬프트. */
  bgmPrompt?: string
  /** 캔버스 또는 내보내기에서 합성한 최종 영상. */
  finalVideoAssetId?: ID
  /** 데스크톱 프로젝트 폴더의 절대 경로. */
  folderPath?: string
  /** 캔버스의 노드, 연결선, 그룹. */
  canvas?: CanvasGraph
  /**
   * 대본 승인 여부. 스토리보드를 나눈 뒤에는 false이며 승인 후 캐릭터 이미지와 영상 제작을 진행한다.
   * 사용자가 전체 과정을 명시적으로 요청하면 승인한 것으로 처리한다.
   */
  playApproved?: boolean
  /** 에이전트 대화, 실행 내역, 자동 진행 선호도를 프로젝트에 저장한다. */
  agentState?: AgentWorkspaceState
  /** 연속 촬영 모드는 기존 스토리보드 제작과 독립적으로 진행한다. */
  continuousCaptureEnabled?: boolean
  /** 모델이 작성한 미술 설명과 별개로 사용자가 명시한 스타일이다. */
  visualStylePreference?: string
  /** 연속 촬영에서 스타일 확인을 기다리는 동안 현재 대본을 보관한다. */
  continuousPendingScript?: string
  continuousCapture?: import('@/services/continuous/model').CaptureState
  /**
   * standard: 주제 또는 대본에서 시작.
   * remake: 참조 영상을 재현하면서 원본 제품을 사용자 이미지로 교체.
   * img2video: 이미지, 영상, 대본 노드를 배치하는 자유 캔버스.
   */
  pipelineMode?: 'standard' | 'drama' | 'remake' | 'img2video' | 'smart-speech'
  /** 스마트 내레이션에서 만든 프로젝트의 전용 워크플로 설정. */
  speechWorkflow?: SpeechWorkflow
  /** 영상 재현의 참조 영상. */
  sourceVideoAssetId?: ID
  createdAt: number
  updatedAt: number
}
