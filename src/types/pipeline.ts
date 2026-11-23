/**
 * 파이프라인 작업 상태.
 */

export type TaskStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'

export interface PipelineTask {
  id: string
  /** 작업 유형. */
  kind:
    | 'storyboard'
    | 'image'
    | 'video'
    | 'caption'
    | 'export'
  /** 작업 제목. */
  title: string
  /** 상태. */
  status: TaskStatus
  /** 진행률. 범위는 0~1이다. */
  progress: number
  /** 현재 단계 설명. */
  message?: string
  /** 오류. */
  error?: string
  /** 시작 시각. */
  startedAt?: number
  /** 종료 시각. */
  finishedAt?: number
  /** 관련 샷 ID. 선택 사항이다. */
  shotId?: string
}

export interface AgentTaskGraphNode {
  id: string
  tool: string
  phase: number
  dependsOn: string[]
  estimatedSeconds: number
  estimatedCalls: number
}

export interface AgentTaskGraph {
  id: string
  nodes: AgentTaskGraphNode[]
  createdAt: number
}

export type PipelineStepId =
  | 'script'
  | 'storyboard'
  | 'image'
  | 'video'
  | 'edit'
  | 'caption'
  | 'export'

export interface PipelineStep {
  id: PipelineStepId
  label: string
  description: string
  /** 사용자가 완료로 표시했는지 여부. */
  done: boolean
  /** 접근할 수 있는지 여부. */
  enabled: boolean
  /** 현재 단계. */
  current: boolean
  route: string
  icon: string
}
