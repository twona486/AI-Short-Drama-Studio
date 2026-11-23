/**
 * 도구 작업을 사용자가 읽을 수 있는 계획으로 정리한다.
 * plan 이벤트로 패널에 전달하고 stepKey로 실행 상태를 갱신한다.
 */
import { estimateToolActions, toolPhase, type AgentToolAction } from './toolRegistry'
import { TOOL_LABEL } from './pipeline'

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'fail'

export interface AgentPlanStep {
  /** agentLoop의 stepKey와 같은 도구명 및 대상 ID 형식 */
  key: string
  title: string
  tool: string
  status: PlanStepStatus
  detail?: string
}

export interface AgentPlan {
  intentLabel: string
  summary: string
  steps: AgentPlanStep[]
  calls: number
  seconds: number
}

export function stepKeyOf(action: AgentToolAction): string {
  return `${action.tool}:${action.shotId || action.subjectId || action.sceneId || action.nodeId || ''}`
}

function stepTitle(action: AgentToolAction): string {
  const label = TOOL_LABEL[action.tool] || action.tool
  if (action.tool === 'optimize_node_prompt' || action.tool === 'update_node' || action.tool === 'run_node') {
    return action.nodeId ? `${label} ${action.nodeId}` : label
  }
  return label
}

/** agentLoop의 실행 순서에 맞춰 작업을 단계별로 정렬한다. */
export function buildPlanFromActions(actions: AgentToolAction[], intentLabel: string): AgentPlan {
  const sorted = [...actions].sort((a, b) => toolPhase(a.tool) - toolPhase(b.tool))
  const estimate = estimateToolActions(sorted)
  const steps: AgentPlanStep[] = sorted.map((action) => ({
    key: stepKeyOf(action),
    title: stepTitle(action),
    tool: action.tool,
    status: 'pending'
  }))
  const summary =
    steps.length === 1
      ? `1단계 계획 ${steps[0].title}`
      : `${steps.length}단계 계획 ${steps.map((s) => s.title).join(' → ')}`
  return {
    intentLabel,
    summary,
    steps,
    calls: estimate.calls,
    seconds: estimate.seconds
  }
}
