/**
 * 도구 작업을 사용자가 읽을 수 있는 계획으로 정리한다.
 * plan 이벤트로 패널에 전달하고 stepKey로 실행 상태를 갱신한다.
 */
import { estimateToolActions, type AgentToolAction } from './toolRegistry'
import { useProjectStore } from '@/stores'
import { expandRegeneration, uniqueActions } from './actionPolicy'
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
  return `${action.tool}:${action.shotId || action.subjectId || action.sceneId || action.nodeId || action.extractStage || ''}${action.referenceIndex ? `:${action.referenceIndex}` : ''}`
}

function stepTitle(action: AgentToolAction): string {
  const label = `${action.regenerate ? '重新' : ''}${TOOL_LABEL[action.tool] || action.tool}`
  if (action.tool === 'inspect_canvas_image' && action.referenceIndex) return `${label} · 图${action.referenceIndex}`
  if (action.tool === 'optimize_node_prompt' || action.tool === 'update_node' || action.tool === 'run_node') {
    return action.nodeId ? `${label} ${action.nodeId}` : label
  }
  return label
}

/** 与执行器一致，保留用户计划的顺序，批量重做按目标展示。 */
export function buildPlanFromActions(actions: AgentToolAction[], intentLabel: string): AgentPlan {
  const sorted = uniqueActions(expandRegeneration(actions, useProjectStore().current))
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
