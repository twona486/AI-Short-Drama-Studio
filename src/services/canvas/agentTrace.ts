import type { AgentPlan } from './planner'

export type TraceStatus = 'running' | 'done' | 'fail'

/** 에이전트 패널의 의도, 계획, 단계와 실행 로그 행 */
export interface TraceRow {
  key: string
  kind: 'think' | 'plan' | 'step' | 'log' | 'intent'
  label: string
  status?: TraceStatus
  detail?: string
  plan?: AgentPlan
}
