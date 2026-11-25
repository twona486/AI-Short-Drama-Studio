/**
 * 대본 라이브러리.
 *
 * 생성하거나 가져온 대본은 다음 두 곳에 저장된다.
 * 1. 로컬 Markdown 파일. 데스크톱에서는 저장 폴더의 _scripts/<id>.md에 둔다.
 * 2. 대본 관리와 리소스 라이브러리에서 참조하는 index.json 메타데이터.
 *
 * 본문은 Markdown에 저장한다. 각 회차는 본문의 2단계 제목으로 나눈다.
 */

import type { ID } from './project'

export type ScriptSource = 'ai-generated' | 'imported' | 'manual'

/** 대본 본문에서 분리한 회차 또는 챕터. */
export interface ScriptEpisode {
  id: ID
  /** 0부터 시작하는 인덱스. */
  index: number
  title: string
  /** 제목 줄을 제외한 회차 본문. */
  content: string
  /** 공백을 제외한 본문 글자 수. */
  wordCount: number
}

/** 라이브러리의 전체 대본. */
export interface ScriptDoc {
  id: ID
  title: string
  defaultNamesLocalized?: true
  /** Markdown 파일 이름. 예를 들어 여름밤.md. */
  filename: string
  /** 출처. AI 생성, 외부 가져오기 또는 직접 작성. */
  source: ScriptSource
  /** 소속 프로젝트. 가져오거나 직접 작성한 대본은 프로젝트가 없을 수 있다. */
  projectId?: ID
  /** 프로젝트에 다시 반영할 대본 ID. */
  scriptId?: ID
  /** 생성 시 입력한 원래 요청. */
  prompt?: string
  /** 회차 수. 본문의 2단계 제목 수를 사용하며 최소 1이다. */
  episodeCount: number
  totalWords: number
  /** 데스크톱에서 _scripts 폴더를 기준으로 한 파일 이름. 웹에서는 쓰지 않는다. */
  fileRelPath?: string
  /** 사용자 지정 분류 폴더. */
  folderId?: string
  createdAt: number
  updatedAt: number
}

export const EMPTY_EPISODE_TEMPLATE = `장면:
캐릭터:
줄거리:
`
