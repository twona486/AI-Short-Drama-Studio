import type { AgentAutonomy } from '@/types'
import type { AgentEvent, AgentToolResult } from './agent'
import {
  AgentToolError,
  buildTaskGraph,
  estimateToolActions,
  executeRegisteredTool,
  preflightRegisteredTool,
  toolPhase,
  validateToolAction,
  verifyRegisteredTool,
  type AgentToolAction
} from './toolRegistry'
import { TOOL_LABEL } from './pipeline'
import { beginAgentTask, getAgentState, patchAgentTask } from './taskStore'

export interface ReplanInput {
  error: AgentToolError
  completed: AgentToolAction[]
  remaining: AgentToolAction[]
  attempt: number
}

export interface ContinueAgentInput {
  completed: AgentToolAction[]
  results: AgentToolResult[]
  round: number
}

export interface ContinueAgentPlan {
  actions: unknown[]
  say?: string
  done?: boolean
}

export interface AgentLoopOptions {
  request: string
  autonomy: AgentAutonomy
  signal?: AbortSignal
  onEvent: (event: AgentEvent) => void
  replan?: (input: ReplanInput) => Promise<unknown[]>
  /**
   * A real agent must observe the canvas again after tools have changed it.
   * This callback lets the planner inspect the fresh project state and either
   * schedule another small batch or explicitly declare the request complete.
   */
  continue?: (input: ContinueAgentInput) => Promise<ContinueAgentPlan>
}

function dedupe(actions: AgentToolAction[]) {
  const seen = new Set<string>()
  return actions.filter((action) => {
    const key = `${action.tool}:${action.subjectId ?? ''}:${action.sceneId ?? ''}:${action.shotId ?? ''}:${action.nodeId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function runAgentLoop(rawActions: unknown[], options: AgentLoopOptions) {
  let actions = dedupe(rawActions.map(validateToolAction)).sort(
    (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
  )
  const estimate = estimateToolActions(actions)
  const budget = getAgentState().callBudget
  if (budget > 0 && estimate.calls > budget) {
    throw new Error(`생성 호출이 ${estimate.calls}회 필요할 것으로 예상돼 이번 작업 예산 ${budget}회를 초과합니다. 범위를 줄이거나 예산을 늘리세요.`)
  }
  const graph = buildTaskGraph(actions)
  const task = await beginAgentTask(options.request, estimate)
  await patchAgentTask(task.id, { status: 'running' })
  options.onEvent({
    kind: 'log',
    label: `${graph.nodes.length}단계, 생성 요청 약 ${estimate.calls}회, 예상 ${Math.max(1, Math.ceil(estimate.seconds / 60))}분`
  })

  const completed: AgentToolAction[] = []
  const results: AgentToolResult[] = []
  let replanAttempt = 0
  const maxReplans = options.autonomy === 'autopilot' ? 6 : options.autonomy === 'gated' ? 4 : 2
  const dependencyAttempts = new Map<string, number>()
  const failureFingerprints = new Map<string, number>()
  const recoveringSteps = new Set<string>()
  let continuationRound = 0
  let finalSay = ''
  let scheduledCalls = estimate.calls
  let scheduledSeconds = estimate.seconds
  const maxContinuationRounds = options.autonomy === 'autopilot' ? 10 : options.autonomy === 'gated' ? 5 : 2

  try {
    while (true) {
      if (!actions.length) {
        if (!options.continue || continuationRound >= maxContinuationRounds) break
        continuationRound++
        options.onEvent({ kind: 'think', label: `캔버스를 다시 확인해 작업이 끝났는지 살펴보고 있어요(${continuationRound}/${maxContinuationRounds})…` })
        const next = await options.continue({
          completed: [...completed],
          results: [...results],
          round: continuationRound
        })
        if (next.say?.trim()) finalSay = next.say.trim()
        if (next.done || !next.actions?.length) break

        const nextActions = dedupe(next.actions.map(validateToolAction)).sort(
          (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
        )
        if (!nextActions.length) break
        const nextEstimate = estimateToolActions(nextActions)
        if (budget > 0 && scheduledCalls + nextEstimate.calls > budget) {
          throw new Error(
            `계속하려면 생성 요청이 총 ${scheduledCalls + nextEstimate.calls}회 필요해 한도 ${budget}회를 초과해요. 완료된 결과는 저장돼요.`
          )
        }
        scheduledCalls += nextEstimate.calls
        scheduledSeconds += nextEstimate.seconds
        await patchAgentTask(task.id, {
          estimatedCalls: scheduledCalls,
          estimatedSeconds: scheduledSeconds
        })
        options.onEvent({
          kind: 'log',
          label: `현재 캔버스를 기준으로 ${nextActions.length}단계를 이어서 실행해요. ${nextActions.map((item) => TOOL_LABEL[item.tool] || item.tool).join('、')}`
        })
        actions = nextActions
        continue
      }
      if (options.signal?.aborted) throw new AgentToolError('작업을 취소했어요.', 'agent', 'cancelled')
      const action = actions.shift()!
      const stepKey = `${action.tool}:${action.shotId || action.subjectId || action.sceneId || action.nodeId || ''}`
      const stepLabel = TOOL_LABEL[action.tool] || action.tool

      let preflight
      try {
        preflight = preflightRegisteredTool(action)
      } catch (error: any) {
        const toolError = error instanceof AgentToolError
          ? error
          : new AgentToolError(error?.message ?? String(error), action.tool, 'invalid_action', false)
        results.push({ tool: action.tool, ok: false, detail: toolError.message })
        await patchAgentTask(task.id, {
          status: 'failed', failedTool: action.tool, error: toolError.message, finishedAt: Date.now()
        })
        return { results, graph, stopped: true, error: toolError }
      }
      if (preflight.state === 'skip') {
        completed.push(action)
        results.push({ tool: action.tool, ok: true, detail: preflight.detail || '이미 완료된 작업이라 건너뛰었어요.' })
        options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'done' })
        options.onEvent({ kind: 'log', label: `검사 결과에 따라 건너뛰었어요. ${preflight.detail || stepLabel}` })
        continue
      }
      if (preflight.state === 'repair') {
        const count = (dependencyAttempts.get(stepKey) || 0) + 1
        dependencyAttempts.set(stepKey, count)
        if (count > 3 || !preflight.actions?.length) {
          const toolError = new AgentToolError(
            `${preflight.detail || stepLabel}의 선행 작업을 다시 실행했지만 필요한 조건을 충족하지 못했어요.`,
            action.tool,
            'postcondition_failed',
            false
          )
          results.push({ tool: action.tool, ok: false, detail: toolError.message })
          await patchAgentTask(task.id, {
            status: 'failed', failedTool: action.tool, error: toolError.message, finishedAt: Date.now()
          })
          return { results, graph, stopped: true, error: toolError }
        }
        const candidate = dedupe([...preflight.actions, action, ...actions]).sort(
          (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
        )
        const projected = estimateToolActions([...completed, ...candidate])
        if (budget > 0 && projected.calls > budget) {
          const toolError = new AgentToolError(
            `누락된 선행 작업까지 실행하면 생성 요청이 ${projected.calls}회로 한도 ${budget}회를 초과해요.`,
            action.tool,
            'postcondition_failed',
            false
          )
          results.push({ tool: action.tool, ok: false, detail: toolError.message })
          await patchAgentTask(task.id, {
            status: 'failed', failedTool: action.tool, error: toolError.message, finishedAt: Date.now()
          })
          return { results, graph, stopped: true, error: toolError }
        }
        options.onEvent({ kind: 'log', label: `실행 전 검사 ${preflight.detail}` })
        await patchAgentTask(task.id, {
          repairCount: (dependencyAttempts.get(stepKey) || 0) + replanAttempt,
          lastRecovery: preflight.detail
        })
        actions = candidate
        continue
      }

      options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'running' })
      await patchAgentTask(task.id, { currentStep: action.tool })
      try {
        const detail = await executeRegisteredTool(action, {
          signal: options.signal,
          onLog: (label) => options.onEvent({ kind: 'log', label, step: stepKey })
        })
        const verificationIssue = verifyRegisteredTool(action)
        if (verificationIssue) {
          throw new AgentToolError(
            `도구 실행은 완료됐지만 결과가 검수를 통과하지 못했어요. ${verificationIssue}`,
            action.tool,
            'postcondition_failed',
            true
          )
        }
        completed.push(action)
        results.push({ tool: action.tool, ok: true, detail })
        if (recoveringSteps.delete(stepKey)) {
          options.onEvent({ kind: 'log', label: `자동으로 수정했어요. 다음 작업을 진행해요. ${stepLabel}` })
        }
        options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'done' })
        await patchAgentTask(task.id, {
          completedTools: completed.map((item) => item.tool),
          currentStep: undefined
        })
      } catch (error: any) {
        const toolError = error instanceof AgentToolError
          ? error
          : new AgentToolError(error?.message ?? String(error), action.tool, 'execution_failed')
        options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'fail' })
        const fingerprint = `${stepKey}:${toolError.code}:${toolError.message.replace(/\d+/g, '#').slice(0, 180)}`
        const sameFailureCount = (failureFingerprints.get(fingerprint) || 0) + 1
        failureFingerprints.set(fingerprint, sameFailureCount)

        if (
          toolError.recoverable &&
          options.replan &&
          replanAttempt < maxReplans &&
          sameFailureCount < 2 &&
          !options.signal?.aborted
        ) {
          replanAttempt++
          recoveringSteps.add(stepKey)
          options.onEvent({ kind: 'log', label: `결과가 기준을 충족하지 못해 원인을 확인하고 계획을 다시 세워요(${replanAttempt}/${maxReplans}). ${toolError.message}` })
          await patchAgentTask(task.id, {
            repairCount: replanAttempt + [...dependencyAttempts.values()].reduce((sum, value) => sum + value, 0),
            lastRecovery: `${toolError.code}：${toolError.message}`
          })
          const replacement = await options.replan({
            error: toolError,
            completed,
            remaining: [action, ...actions],
            attempt: replanAttempt
          })
          actions = dedupe([...replacement.map(validateToolAction), action, ...actions]).sort(
            (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
          )
          if (actions.length) continue
        }

        results.push({ tool: action.tool, ok: false, detail: toolError.message })
        options.onEvent({ kind: 'log', label: sameFailureCount >= 2 ? `같은 오류가 반복되어 재시도를 중단했어요. ${toolError.message}` : `작업을 일시 중지했어요. ${toolError.message}` })
        await patchAgentTask(task.id, {
          status: toolError.code === 'cancelled' ? 'cancelled' : 'failed',
          failedTool: action.tool,
          error: toolError.message,
          finishedAt: Date.now()
        })
        return { results, graph, stopped: true, error: toolError }
      }
    }
    await patchAgentTask(task.id, { status: 'success', finishedAt: Date.now(), currentStep: undefined })
    return { results, graph, stopped: false, finalSay }
  } catch (error: any) {
    await patchAgentTask(task.id, {
      status: options.signal?.aborted ? 'cancelled' : 'failed',
      error: error?.message ?? String(error),
      finishedAt: Date.now()
    })
    throw error
  }
}
