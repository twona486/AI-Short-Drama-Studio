/**
 * 이미지, 영상, 오디오 에셋.
 * - id: 고유 식별자
 * - kind: 유형
 * - mimeType   : MIME
 * - blob: IndexedDB에 저장하는 이진 데이터
 * - url: blob에서 파생하는 런타임 URL. 별도로 저장하지 않는다.
 * - meta: 해상도, 길이, 크기
 */

import type { ID } from './project'

export type AssetKind = 'image' | 'video' | 'audio'

export interface AssetBase {
  id: ID
  kind: AssetKind
  mimeType: string
  /** 사용자가 올린 원래 파일 이름. */
  filename: string
  /** 파일 크기(바이트). */
  size: number
  /** 생성 시간. */
  createdAt: number
  /** 출처. ai-generated, uploaded 또는 extracted. */
  source: 'ai-generated' | 'uploaded' | 'extracted'
  /** AI로 생성할 때 사용한 프롬프트. */
  prompt?: string
  /** 리소스 라이브러리의 필터에 사용하는 소속 프로젝트. */
  projectId?: ID
  /** 생성 시 연결된 샷. */
  shotId?: ID
  /** 데스크톱에서 프로젝트 폴더를 기준으로 한 경로. 예를 들어 assets/images/xxx.png. */
  fileRelPath?: string
  /** 여러 프로젝트에서 사용할 수 있는 공용 에셋 라이브러리. */
  library?: boolean
  /** 사용자 지정 폴더. 비어 있으면 분류되지 않은 공용 에셋이다. */
  folderId?: string
}

/** 공용 에셋 라이브러리의 사용자 지정 폴더. */
export interface LibraryFolder {
  id: ID
  name: string
  createdAt: number
}

export interface ImageAsset extends AssetBase {
  kind: 'image'
  width: number
  height: number
}

export interface VideoAsset extends AssetBase {
  kind: 'video'
  width: number
  height: number
  duration: number
  fps: number
  /** 영상 첫 프레임으로 만든 썸네일. */
  thumbnailId?: ID
  /** 오디오 트랙 포함 여부. */
  hasAudio: boolean
}

export interface AudioAsset extends AssetBase {
  kind: 'audio'
  duration: number
}

export type Asset = ImageAsset | VideoAsset | AudioAsset

/** 에셋과 실행 중 사용하는 blob URL 묶음. */
export type AssetWithUrl = Asset & {
  url: string
  thumbnailUrl?: string
}
