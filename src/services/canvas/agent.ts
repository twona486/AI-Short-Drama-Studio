import { callLLM, getAIMode } from '@/services/ai/client'
import { skillContextForAgent } from '@/skills'
import { importedDirectorPrefix } from '@/services/settings/directorSkill'
import { useProjectStore } from '@/stores'
import type { Project } from '@/types'
import { needsShotFrames, shotsMissingKeyframe, shotsMissingStoryboard } from '@/utils/videoStill'
import { collectStoryBrief, isNewStoryBrief } from '@/utils/storyBrief'
import { rebuildCanvasGraph } from './layout'
import { projectContextPrompt } from './contextBuilder'
import { runAgentLoop } from './agentLoop'
import { buildMaterialBlock, type AgentAttachment } from './attachments'
import { getAgentState } from './taskStore'
import {
  continueQuestion,
  clarifyMessage,
  isContinueRequest,
  isVagueRequest,
  nextPipelineStep,
  extractStageFromText,
  TOOL_LABEL,
  type PipelineStep
} from './pipeline'
import {
  DOWNSTREAM_TOOLS,
  playGateMessage,
  isApprovePlayRequest,
  isFullPipelineRequest,
  needsPlayReview
} from './playGate'
import { detectIntentSmart, type AgentIntent } from './intent'
import { buildPlanFromActions } from './planner'
import {
  forgetMemory,
  memoryContextPrompt,
  parseForgetRequest,
  parseRememberRequest,
  rememberMemory
} from '@/services/memory/memoryStore'

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentToolResult {
  tool: string
  ok: boolean
  detail: string
}

export interface AgentEvent {
  kind?: 'log' | 'step' | 'focus' | 'think' | 'intent' | 'plan'
  label: string
  step?: string
  status?: 'running' | 'done' | 'fail'
  nodeId?: string
  plan?: import('./planner').AgentPlan
}

export type AgentProgress = (ev: AgentEvent) => void

/** 单轮最多执行多少个画布动作。放宽上限，别把用户的整句需求切碎。 */
const MAX_ACTIONS_PER_TURN = 12

export interface AgentTurnResult {
  reply: string
  results: AgentToolResult[]
  chips: { label: string; text: string }[]
}
export interface AgentRunOptions {
  signal?: AbortSignal
  autonomy?: 'assist' | 'gated' | 'autopilot'
  /** 已废弃：合并后不再按模式分叉，路线由意图与画布状态决定 */
  mode?: 'drama' | 'freeform'
  /** 当前在画布上选中的自由生成节点 */
  selectedNodeId?: string
  /** 用户在对话框附加的本地文件（文本内容已读入） */
  attachments?: AgentAttachment[]
}

// 캔버스 에이전트의 계획·도구 호출 규칙과 한국어 답변 형식.
const TOOLS_HINT = `You are the assistant working on the Studio canvas. Tell the user what actually happens as you work. Write every user-facing message in the say field in Korean (한국어).

Mandatory rules:
1. Return JSON only: { "say": "User-facing message in Korean", "actions": [ ... ], "done": false }. actions is the next small batch of real canvas operations. After the tools run, inspect the current canvas and decide again. Return done=true and actions=[] when the requested result is present on the canvas.
1b. Act on the canvas: create, connect, update, delete, rerun, or arrange nodes; check and fix errors; write professional scripts and storyboards. Act directly by default. Confirm first for operations that consume substantial quota or involve irreversible bulk generation. Ask when genuinely uncertain rather than only giving advice.
2. If the request is ambiguous, such as "help me make it" or "start", return actions=[] and ask in say for the topic, duration, and whether the user wants a script or the full workflow.
3. Script creation has two steps in separate turns by default. generate_play produces a complete Markdown script only. For writing, adaptation, and continuation, apply the story engine, adaptation requirements, beats, AI production constraints, and scene-level rules from ai-short-film-screenwriter. Review the draft before returning it. Include a one-sentence premise, central conflict, full synopsis, character profiles for the protagonist, opponent, and key family with wants, fears, and arcs, environments, each scene's objective, action, and dialogue. Do not use a four-cell table of narration, picture, and duration; reduce a folk tale to its climax; or leave recognition, call-outs, confrontation, and questions without visible on-screen dialogue. Do not create character, location, or storyboard nodes yet. Run extract_cast when the user says to continue or extract nodes. Only an explicit full-workflow request authorizes generate_play and extract_cast in the same turn.
3b. extract_cast does the next missing stage only. Extract characters, then locations, then shots, stopping after each stage. Say what completed and what comes next. Use extractStage to redo one existing group instead of rebuilding everything.
3c. Duration is a hard budget. Preserve the user's original wording, such as "약 40초", "30S", or "1분", in the text for seed_script and generate_play. That wording controls scene, text, and shot counts. Verify that total shot duration is within ten seconds of the requested final duration in either direction. Otherwise redo the breakdown. Ask in say for the target duration before making a short film if the user omitted it.
4. If a complete script exists:
   - Use continue_play for requests to continue, append, or add two scenes. Preserve existing scenes.
   - When the user explicitly requests a rewrite or introduces an unrelated story with new subject matter, characters, or art style, seed_script first with the full original story as provided across recent turns, including style, duration, subject, and characters. Then run generate_play. Do not use continue_play or treat the old script as a draft.
4b. For imported scripts (origin=imported), use extract_cast for shots, characters, and locations. Do not use seed_script, generate_play, or generate_storyboard. Preserve the original plot and lines in the shot breakdown. Rewrite only on an explicit request to do so.
5. For time-consuming or irreversible bulk generation of all sheets, locations, keyframes, videos, or dubbing, run a small batch and name the next step in say. Continue when asked or when the full workflow is requested. Finish all other requested operations in a single turn, including adding, connecting, deleting, renaming, or rerunning a single node, changing a prompt, arranging the canvas, and checking status.
6. For ordinary creation, use character and location references to make a keyframe depicting the current shot, then generate video. Use storyboard panels for AI short dramas.
6b. If the project or shot uses first-and-last-frame mode, generate both frames before video. Use generate_all_frames or generate_shot_frames, then generate_video or generate_all_videos. The order is character sheets, locations, first and last frames, and video; skip keyframes or panels for shots using this mode. If frame generation fails, record the error and continue with video generation.
7. Do not generate storyboard panels or video before storyboard approval. Use approve_play on explicit approval. When asked to continue, verify then perform the next step. This gate applies to workflow operations, not manual node creation, single freeform node generation, or prompt edits.
8. Return no more than 12 actions at a time. Use tools when available. Update the node prompt before producing the requested image or video. After each batch, verify against current assets. When creating a freeform node, return only create in this batch and use the actual nodeId from the updated canvas in the next batch's run_node.
9. The same canvas supports the script workflow (seed_script / generate_play / extract_cast / …) and single-node operations (create_image_node / create_video_node / update_node / run_node). Route requests about scripts, storyboards, character sheets, or locations to the workflow. A request for an image, an eight-second video, or a change to one node affects only that node and can be completed directly.
10. When the user wants to add an image or video node downstream from an existing one, create_image_node or create_video_node must include sourceNodeId. Default to the currently selected node when no other node is named. The tool places the new node on the right, connects it, and passes the upstream result as a reference image. Use connect_nodes for two existing nodes.

Available tools:
{ "tool": "seed_script", "text": "Complete original story from the recent user turns" }
{ "tool": "generate_play", "text": "Optional original story matching seed_script" }
{ "tool": "continue_play", "text": "Optional continuation direction, for example two more scenes or what happens after the father returns" }
{ "tool": "extract_cast" }
{ "tool": "extract_cast", "extractStage": "subjects|scenes|shots" }
{ "tool": "generate_storyboard" }
{ "tool": "approve_play" }
{ "tool": "revise_shot", "shotId": "shot_xxx", "visualPrompt": "Optional still frame or keyframe description in English", "imagePrompt": "Optional final image model prompt in English", "videoPrompt": "English video direction: initial state, trigger, action chain, camera, final framing, and synchronized sound. Preserve Korean dialogue and requested Korean on-screen text", "voiceover": "Optional spoken lines in Korean (한국어), or verbatim when provided", "duration": 5, "cameraMovement": "static|push|pull|pan|tilt|orbit" }
{ "tool": "generate_sheet", "subjectId": "sub_1" }
{ "tool": "generate_scene", "sceneId": "scn_1" }
{ "tool": "generate_shot_board", "shotId": "shot_xxx" }
{ "tool": "generate_video", "shotId": "shot_xxx" }
{ "tool": "generate_audio", "shotId": "shot_xxx" }
{ "tool": "generate_all_sheets" }
{ "tool": "generate_all_scenes" }
{ "tool": "generate_all_boards" }
{ "tool": "generate_all_images" }
{ "tool": "generate_shot_frames", "shotId": "shot_xxx" }
{ "tool": "generate_all_frames" }
{ "tool": "generate_all_videos" }
{ "tool": "generate_all_audio" }
{ "tool": "sync_canvas" }
{ "tool": "focus_node", "nodeId": "script" }
{ "tool": "create_image_node", "text": "Complete image generation prompt in English", "sourceNodeId": "Optional upstream node ID. Places and links the new node to its right" }
{ "tool": "create_video_node", "text": "Complete video generation direction in English", "duration": 8, "sourceNodeId": "Upstream node ID. Required when attaching to an existing node" }
{ "tool": "connect_nodes", "sourceNodeId": "Upstream node ID", "targetNodeId": "Downstream node ID" }
{ "tool": "delete_node", "nodeId": "Freeform image or video node ID" }
{ "tool": "arrange_canvas" }
{ "tool": "check_project" }
{ "tool": "update_node", "nodeId": "imageGen_xxx or videoGen_xxx", "text": "Complete updated generation prompt in English", "nodeLabel": "Optional new Korean node label", "duration": 8 }
{ "tool": "run_node", "nodeId": "Node ID from the current canvas" }
{ "tool": "optimize_node_prompt", "nodeId": "imageGen_xxx or videoGen_xxx", "text": "Optional direction, such as making action and expressions more concrete" }
{ "tool": "remember", "text": "Preference or fact to remember; required when the user says to remember it or apply it from now on" }
{ "tool": "forget", "text": "Keyword for the memory to remove" }

Questions and memory:
9. For questions, advice, or creative discussion that needs no canvas change, answer in Korean (한국어) in say and return actions=[]. Give a concrete answer informed by project context and saved preferences.
10. Use remember for an explicit request to remember and forget for an explicit request to forget. Do not combine these with other actions.`

function parseAgentJson(text: string): { say: string; actions: any[]; done: boolean } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [], done: true }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      say: String(obj.say || '확인했습니다.'),
      actions: Array.isArray(obj.actions) ? obj.actions : [],
      done: obj.done === true
    }
  } catch {
    return { say: text.slice(0, 400), actions: [], done: true }
  }
}

function skillSelectContext(userText: string) {
  const p = useProjectStore().current
  const subjects = p?.subjects ?? []
  const scenes = p?.scenes ?? []
  const shots = p?.shots ?? []
  return {
    userText,
    pipelineMode: p?.pipelineMode,
    workflowMode: p?.script?.workflowMode,
    hasShots: shots.length > 0,
    missingSheets: subjects.some((s) => !s.designSheetAssetId),
    missingPlates: scenes.some((s) => !s.plateAssetId),
    missingImages: Boolean(
      p && (shotsMissingStoryboard(p).length || shotsMissingKeyframe(p).length)
    ),
    missingVideos: shots.some((s) => !s.videoAssetId)
  }
}

function qaNotes(p: Project): string {
  const issues: string[] = []
  if (!p.shots.length) issues.push('스토리보드가 없습니다.')
  const noSheet = (p.subjects ?? []).filter((s) => !s.designSheetAssetId)
  if (noSheet.length) issues.push(`캐릭터 설정 이미지 없음 ${noSheet.map((s) => s.name).join('、')}`)
  const noPlate = (p.scenes ?? []).filter((s) => !s.plateAssetId)
  if (noPlate.length) issues.push(`장면 기준 이미지 없음 ${noPlate.map((s) => s.name).join('、')}`)
  const noBoard = shotsMissingStoryboard(p)
  const noKf = shotsMissingKeyframe(p)
  if (noBoard.length) issues.push(`${noBoard.length}개 샷에 스토리 개요판이 없습니다.`)
  if (noKf.length) issues.push(`${noKf.length}개 샷에 키프레임이 없습니다.`)
  const noVid = p.shots.filter((s) => !s.videoAssetId)
  if (noVid.length) issues.push(`${noVid.length}개 샷에 영상이 없습니다.`)
  const unbound = p.shots.filter((s) => !s.sceneId || !(s.subjectIds && s.subjectIds.length))
  if (unbound.length) issues.push(`${unbound.length}개 샷에 캐릭터나 장면이 연결되지 않았습니다.`)
  if (!issues.length) return '점검을 마쳤습니다. 편집을 계속할 수 있습니다.'
  return `**보완할 항목 ${issues.length}개**\n\n${issues.map((s) => `- ${s}`).join('\n')}`
}

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

function parseShotIndexes(text: string): number[] {
  const out = new Set<number>()
  for (const m of text.matchAll(/(?:第\s*(\d+)\s*镜|(\d+)\s*번\s*샷|\bshot\s+(\d+)\b)/gi)) {
    const n = Number(m[1] || m[2] || m[3])
    if (n >= 1) out.add(n - 1)
  }
  for (const m of text.matchAll(/第\s*([一二两三四五六七八九十]+)\s*镜/g)) {
    const n = CN_NUM[m[1]]
    if (n) out.add(n - 1)
  }
  return [...out].sort((a, b) => a - b)
}

function wantAll(text: string) {
  return isFullPipelineRequest(text)
}

export async function runAgentTurn(
  history: AgentMessage[],
  userText: string,
  onEvent: AgentProgress,
  options: AgentRunOptions = {}
): Promise<AgentTurnResult> {
  const project = useProjectStore()
  if (!project.current) {
    return { reply: '먼저 프로젝트를 열거나 새로 만드세요.', results: [], chips: [] }
  }

  const p0 = project.current

  // ── 意图识别：先判断这句话想干什么，再决定走哪条路 ──
  // 附件 / 消息里的本地文件路径 → 读成材料块。材料只拼给模型看，不参与意图分类。
  const baseText = userText
  const material = await buildMaterialBlock(userText, options.attachments, (label) =>
    onEvent({ kind: 'log', label })
  )
  if (material) userText = `${material}\n\n${userText}`
  const hasPipeline = hasPipelineData(p0)
  // 意图分类全部由 LLM 完成（正式模式）；演示模式退回 detectIntent 规则兜底
  const intent = await detectIntentSmart(
    baseText,
    {
      hasPipeline,
      project: p0,
      hasSelectedGenNode: Boolean(options.selectedNodeId)
    },
    options.signal
  )
  onEvent({ kind: 'intent', label: intent.label })

  // 闲聊也交给语言模型写回复，不用固定开场白
  if (intent.kind === 'chitchat') {
    return answerQuestion(userText, history, p0, onEvent, options)
  }

  // 合并模式：不再按项目模式分叉，而是按「这句话 + 画布当前状态」决定走节点路径还是流水线路径
  const nodePath = resolveNodePath(intent, p0, baseText)
  // 只在「这句话明确是单个节点需求」时才收紧工具集；意图含糊时不硬拦，避免模型想做却被静默过滤掉
  const restrictToNodes =
    !hasPipeline && (intent.kind === 'create_asset' || intent.kind === 'prompt_polish')

  // 显式记忆指令：直接写本地记忆，不进任务规划（按用户原话提取内容，意图已由 LLM 判定）
  if (intent.kind === 'remember') {
    const req = parseRememberRequest(baseText)
    if (req) {
      const entry = await rememberMemory(req.content, { kind: req.kind, scope: req.scope })
      if (entry) {
        onEvent({ kind: 'log', label: `로컬 기억에 저장했습니다(${req.scope === 'global' ? '장기' : '이 프로젝트'}).` })
        return {
          reply: `기억했습니다. ${entry.content}\n${req.scope === 'global' ? '앞으로 모든 프로젝트에 적용합니다.' : '현재 프로젝트에만 적용합니다.'}`,
          results: [],
          chips: [{ label: '기억 보기', text: '查看记忆' }]
        }
      }
    }
  }
  if (intent.kind === 'forget') {
    const keyword = parseForgetRequest(baseText)
    if (keyword) {
      const removed = await forgetMemory(keyword)
      return {
        reply: removed ? `기억을 삭제했습니다. ${removed}` : `‘${keyword}’와 관련된 기억을 찾지 못했습니다.`,
        results: [],
        chips: []
      }
    }
  }
  // 进度查询 / 质检：确定性汇总，不消耗模型调用。
  // 但带着附件问「状态」时，多半是在问材料本身，交给模型结合材料回答。
  if (intent.kind === 'status' && material) {
    return answerQuestion(userText, history, p0, onEvent, options)
  }
  if (intent.kind === 'status') {
    onEvent({ kind: 'log', label: '캔버스와 프로젝트 상태를 확인하는 중' })
    return { reply: statusNotes(p0), results: [], chips: statusChips(p0) }
  }
  // 纯问答 / 咨询：不动画布，结合记忆与项目上下文直接回答
  if (intent.kind === 'question') {
    return answerQuestion(userText, history, p0, onEvent, options)
  }
  // 选中节点的提示词优化：快路径，不等规划
  if (intent.kind === 'prompt_polish') {
    const nodeId = options.selectedNodeId || findGenNodeInText(p0, baseText)
    if (nodeId) {
      const plan0 = {
        say: '요청한 방향으로 노드 프롬프트의 화면 묘사를 구체화하고 원문 형식을 유지합니다.',
        actions: [{ tool: 'optimize_node_prompt', nodeId, text: userText }]
      }
      onEvent({ kind: 'plan', label: '1단계 계획 — 노드 프롬프트 최적화', plan: buildPlanFromActions(plan0.actions as any, intent.label) })
      onEvent({ kind: 'log', label: '캔버스 작업을 시작합니다.' })
      const loop0 = await runAgentLoop(plan0.actions, {
        request: userText,
        autonomy: options.autonomy ?? getAgentState().autonomy,
        signal: options.signal,
        onEvent
      })
      const r0 = loop0.results
      if (loop0.stopped) {
        const failed = [...r0].reverse().find((r) => !r.ok)
        return {
          reply: `프롬프트 최적화에 실패했습니다.${failed ? `\n원인 ${failed.detail}` : ''}`,
          results: r0,
          chips: [{ label: '다시 시도', text: '再优化一次当前节点提示词' }]
        }
      }
      return {
        reply: r0[0]?.detail || '프롬프트를 구체화하고 노드에 저장했습니다.',
        results: r0,
        chips: [
          { label: '이 노드 생성', text: `生成节点 ${nodeId}` },
          { label: '더 구체화', text: '继续加厚当前节点提示词，画面再具体一点' }
        ]
      }
    }
    return {
      reply:
        '캔버스에서 이미지나 영상 노드를 선택한 뒤 원하는 최적화 방향을 알려 주세요. ‘새 … 노드를 만들어 줘’라고 요청할 수도 있습니다.',
      results: [],
      chips: statusChips(p0)
    }
  }

  if (
    !nodePath &&
    !material &&
    getAIMode() !== 'real' &&
    isVagueRequest(baseText, p0) &&
    !wantAll(baseText) &&
    !isContinueRequest(baseText) &&
    !isApprovePlayRequest(baseText) &&
    !isNewStoryBrief(baseText, p0)
  ) {
    onEvent({ kind: 'log', label: '작업 범위를 확인하는 중' })
    return { reply: clarifyMessage(p0), results: [], chips: clarifyChips(p0) }
  }

  const skillPack = skillContextForAgent(skillSelectContext(baseText))
  const wantQa = skillPack.selected.some((s) => s.id === 'qa-verify')
  const directorManual =
    skillPack.selected.some((s) =>
      ['storyboard-director', 'shot-video', 'h3-prompt-writing', 'film-chapter-production', 'shot-image'].includes(
        s.id
      )
    ) || /分镜|拆镜|提示词|导演|스토리보드|샷 나누기|프롬프트|연출|storyboard|shot breakdown|prompt|director/i.test(baseText)
      ? importedDirectorPrefix()
      : ''

  let plan: { say: string; actions: any[]; done?: boolean }

  if (isContinueRequest(baseText) && !wantAll(baseText)) {
    plan = continuePlan(p0)
  } else if (getAIMode() === 'real' && !isContinueRequest(baseText)) {
    onEvent({ kind: 'think', label: '작업을 계획하는 중…' })
    const memoryText = await memoryContextPrompt()
    const chat = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `${TOOLS_HINT}\n\n${skillPack.prompt}${directorManual ? `\n\n${directorManual}` : ''}${restrictToNodes ? `\n\n${NODE_PATH_RULE}` : ''}${memoryText ? `\n\n${memoryText}\nRespect the saved memories above when answering and planning.` : ''}`
        },
        {
          role: 'user',
          content: `현재 프로젝트 정보입니다. 이번 요청에 맞춰 요약한 내용이라 세부사항이 빠져 있습니다. 도구는 실행 시 실시간 데이터를 읽으므로 정보가 더 필요하면 도구로 확인하세요.\n${projectContextPrompt(baseText)}\n\n위 내용은 프로젝트 상태입니다. 아래 대화의 마지막 메시지가 이번 작업입니다. 현재 대본과 무관한 새 이야기라면 기존 대본을 사용하지 마세요. 요청이 모호하면 질문하세요. 사용자가 지정한 범위만 수정하세요.${options.selectedNodeId ? `\n현재 사용자가 선택한 노드 ${options.selectedNodeId}（다른 노드를 지정하지 않으면 이 노드를 조작）` : ''}${material ? `\n\n${material}\n\n위 자료는 사용자가 이번 요청에 첨부한 파일 또는 로컬 파일입니다. 이 자료를 우선 사용하고 사용자에게 다시 붙여 넣으라고 요청하지 마세요.` : ''}`
        },
        ...chat
      ],
      temperature: 0.2,
      jsonMode: true,
      maxTokens: 2000,
      signal: options.signal,
      timeoutMs: 120_000
    })
    plan = parseAgentJson(resp.content)
    plan.actions = gateModeActions(
      applyPlayGate(
        dedupeActions(alignNewStoryActions(sanitizeActions(plan.actions, baseText), baseText, history)),
        baseText
      ),
      restrictToNodes
    )
  } else {
    if (nodePath) {
      const nodePlan = freeformHeuristicPlan(baseText, options.selectedNodeId)
      // 单节点规则没命中时回退到流水线规则，避免空手而归
      plan = nodePlan.actions.length ? nodePlan : heuristicPlan(baseText)
    } else {
      plan = heuristicPlan(baseText)
    }
    plan.actions = gateModeActions(
      applyPlayGate(
        dedupeActions(alignNewStoryActions(plan.actions, baseText, history)),
        baseText
      ),
      restrictToNodes
    )
  }

  // 验收门只挡「流水线下游动作」：手动加单个节点、单节点生成、改提示词不受阻
  const hitDownstream = plan.actions.some((a) => isDownstreamAction(a, project.current))
  const gated =
    hitDownstream &&
    !wantAll(baseText) &&
    needsPlayReview(project.current) &&
    !isApprovePlayRequest(baseText) &&
    !isContinueRequest(baseText) &&
    !plan.actions.some(
      (a) => a.tool === 'generate_storyboard' || a.tool === 'generate_play' || a.tool === 'continue_play' || a.tool === 'seed_script'
    )
  if (gated && !plan.actions.length) {
    plan.say = playGateMessage()
  }

  if (!plan.actions.length) {
    const say = String(plan.say || '').trim()
    if (!say) throw new Error('모델이 실행할 수 있는 답변을 반환하지 않았습니다.')
    onEvent({ kind: 'log', label: '작업 방향 확인을 기다리는 중' })
    if (nodePath) {
      return {
        reply: say,
        results: [],
        chips: statusChips(project.current)
      }
    }
    const chips = gated ? reviewChips() : clarifyChips(project.current)
    return { reply: say, results: [], chips }
  }

  // ── 任务规划：把动作整理成用户可读的计划卡片，执行中同步状态 ──
  try {
    const agentPlan = buildPlanFromActions(plan.actions.slice(0, MAX_ACTIONS_PER_TURN), intent.label)
    onEvent({ kind: 'plan', label: agentPlan.summary, plan: agentPlan })
  } catch {
    /* 计划卡片生成失败不阻断执行 */
  }
  onEvent({ kind: 'log', label: '캔버스 작업을 시작합니다.' })
  const autonomy = options.autonomy ?? getAgentState().autonomy
  const loop = await runAgentLoop(plan.actions.slice(0, MAX_ACTIONS_PER_TURN), {
    request: userText,
    autonomy,
    signal: options.signal,
    onEvent,
    replan: getAIMode() === 'real'
      ? async ({ error, completed, remaining, attempt }) => {
          const response = await callLLM({
            messages: [
              {
                role: 'system',
                content: `${TOOLS_HINT}\n\nRecover from the failed operation. Output JSON only. Use the error, completed steps, and current project state to identify whether the cause is a missing prerequisite, invalid input, an invalid result, a transient service error, or an authentication, quota, or user-permission issue.\n- For missing prerequisites, fill the smallest dependency and resume the original objective.\n- For input or output-quality problems, change only the affected node and retry the objective.\n- For transient service errors, retry the same objective once.\n- For authentication, quota, content safety, or decisions that require the user, return no actions and do not bypass the condition.\nDo not rerun successful tools, expand authorization, or remake unrelated results. Return at most four recovery actions. AgentLoop will recheck the original objective after the recovery actions run.`
              },
              {
                role: 'user',
                content: `원래 작업 ${userText}\n${attempt}번째 복구 시도입니다.\n실패한 도구 ${error.tool}\n오류 ${error.message}\n완료한 작업 ${JSON.stringify(completed)}\n남은 작업 ${JSON.stringify(remaining)}\n최신 프로젝트 상태 ${projectContextPrompt(userText)}`
              }
            ],
            temperature: 0.1,
            jsonMode: true,
            maxTokens: 1200,
            signal: options.signal,
            timeoutMs: 90_000
          })
          const repaired = parseAgentJson(response.content)
          return applyPlayGate(
            dedupeActions(alignNewStoryActions(sanitizeActions(repaired.actions, baseText), baseText, history)),
            baseText
          ).slice(0, 4)
        }
      : undefined,
    continue: getAIMode() === 'real' && autonomy !== 'assist'
      ? async ({ completed, results: observedResults, round }) => {
          const response = await callLLM({
            messages: [
              {
                role: 'system',
                content: `${TOOLS_HINT}\n\nThis is observation ${round} of the same task. The tools have run and changed the project. Check each item against the original request.\n- For a prompt write or edit, confirm that the target storyboard fields contain concrete, filmable action and do not use a static template.\n- For image or video generation, confirm the expected asset exists. Regenerate once if an updated prompt invalidated an earlier asset.\n- For node operations, use focus_node, run_node, sync_canvas, or the specific generation tool.\n- If complete, return done=true and actions=[], and report what actually finished in Korean (한국어) in say.\n- If work remains, return done=false with only the next small batch of required actions.\nDo not repeat successful tools unless later changes invalidated their results. Do not expand the original request or count instructions for the user as execution.`
              },
              {
                role: 'user',
                content: `원래 작업 ${userText}\n\n실행한 작업 ${JSON.stringify(completed)}\n실행 결과 ${JSON.stringify(observedResults)}\n\n최신 캔버스와 프로젝트 상태\n${projectContextPrompt(userText)}`
              }
            ],
            temperature: 0.1,
            jsonMode: true,
            maxTokens: 2400,
            signal: options.signal,
            timeoutMs: 120_000
          })
          const next = parseAgentJson(response.content)
          const actions = applyPlayGate(
            dedupeActions(alignNewStoryActions(sanitizeActions(next.actions, baseText), baseText, history)),
            baseText
          ).slice(0, MAX_ACTIONS_PER_TURN)
          return {
            say: next.say,
            actions,
            done: next.done || !actions.length
          }
        }
      : undefined
  })
  const results = loop.results

  if (project.current) {
    const alreadyOnCanvas = nodePath || results.some(
      (r) => r.ok && (r.tool === 'extract_cast' || r.tool === 'generate_play' || r.tool === 'continue_play')
    )
    if (!alreadyOnCanvas) {
      try {
        project.setCanvas(rebuildCanvasGraph(project.current, true))
      } catch {
        project.setCanvas(rebuildCanvasGraph(project.current, false))
      }
    }
    if (project.dirty) await project.save()
  }

  if (loop.stopped) {
    const ok = results.filter((result) => result.ok).length
    const failed = [...results].reverse().find((result) => !result.ok)
    return {
      reply: `후속 작업을 중단했습니다.${ok ? `완료한 ${ok}단계는 보존했습니다.` : ''}\n실패 단계 ${TOOL_LABEL[failed?.tool || ''] || failed?.tool}\n원인 ${failed?.detail || loop.error?.message}`,
      results,
      chips: [
        { label: '실패 단계 다시 시도', text: `重试${TOOL_LABEL[failed?.tool || ''] || '실패 단계'}` },
        { label: '설정 확인', text: '帮我检查当前失败原因' }
      ]
    }
  }

  if (nodePath) {
    const fails = results.filter((r) => !r.ok)
    const failLine = fails.length
      ? `\n실패 ${fails.length}건 ${fails.map((f) => `${TOOL_LABEL[f.tool] || f.tool}：${f.detail}`).join('；')}`
      : ''
    return {
      reply: (loop.finalSay || plan.say || '캔버스에 작업 결과를 반영했습니다.') + failLine,
      results,
      chips: statusChips(project.current)
    }
  }

  const wrap = wrapUpReply(results, baseText, plan.say)
  const qa = wantQa && project.current ? `\n${qaNotes(project.current)}` : ''
  return { reply: (loop.finalSay || wrap.reply) + qa, results, chips: wrap.chips }
}

const NODE_PATH_RULE = `This is a single-node request. Prefer create_image_node, create_video_node, connect_nodes, update_node, delete_node, arrange_canvas, check_project, optimize_node_prompt, run_node, focus_node, sync_canvas, remember, and forget. Use workflow tools such as generate_play and extract_cast only when the user explicitly asks for a script, character/location/shot extraction, or full production. Default to the selected node if none is named.`

/** 项目里是否已经有流水线产物（剧本 / 人物 / 场景 / 分镜） */
function hasPipelineData(p: Project | null | undefined): boolean {
  if (!p) return false
  return Boolean(
    p.shots.length ||
      (p.subjects?.length ?? 0) > 0 ||
      (p.scenes?.length ?? 0) > 0 ||
      p.script?.content?.trim()
  )
}

/**
 * 合并后不再看项目模式，只按「这句话的意图 + 画布现状」决定路线：
 * node = 单个节点操作（建图片/视频节点、改提示词、重跑节点）
 * flow = 流水线推进（写剧本、拆人物场景分镜、批量出图出视频）
 */
function resolveNodePath(
  intent: { kind: string },
  p: Project | null | undefined,
  userText: string
): boolean {
  if (intent.kind === 'create_asset' || intent.kind === 'prompt_polish') return true
  if (intent.kind === 'pipeline') return false
  if (intent.kind === 'edit_canvas') return !hasPipelineData(p)
  if (intent.kind === 'task') return NODE_REQUEST.test(userText)
  return !hasPipelineData(p)
}

/** 「画一张…」「做个 8 秒视频」这类只针对单个节点的需求 */
const NODE_REQUEST =
  /画一?[张幅个]|做一?[个条]|生成一?[张个条]|出一张|图片|图像|视频节点|出图|一张图|一段视频/i

/** 这个动作是否属于「流水线下游」——只有它才需要先验收剧本 */
function isDownstreamAction(a: any, p: Project | null | undefined): boolean {
  const tool = String(a?.tool || '')
  if (!tool) return false
  if (tool === 'run_node') {
    const node = (p?.canvas?.nodes ?? []).find((n) => n.id === a.nodeId)
    if (!node) return false
    return node.type !== 'imageGen' && node.type !== 'videoGen'
  }
  return /^(generate_|extract_)/.test(tool)
}

/** 只在「空画布 + 单节点需求」时收紧工具集，其余情况全放开 */
function gateModeActions(actions: any[], restrictToNodes: boolean): any[] {
  if (!restrictToNodes) return actions
  const allowed = new Set([
    'create_image_node',
    'create_video_node',
    'connect_nodes',
    'delete_node',
    'arrange_canvas',
    'check_project',
    'update_node',
    'optimize_node_prompt',
    'run_node',
    'focus_node',
    'sync_canvas',
    'remember',
    'forget'
  ])
  return actions.filter((a) => allowed.has(String(a?.tool || '')))
}

/** 在用户文本里找被点名的自由生成节点 */
function findGenNodeInText(p: Project, text: string): string | null {
  const nodes = (p.canvas?.nodes ?? []).filter(
    (n) => n.type === 'imageGen' || n.type === 'videoGen'
  )
  for (const node of nodes) {
    if (node.data.label && text.includes(node.data.label)) return node.id
    if (text.includes(node.id)) return node.id
  }
  return null
}

/** 自由生成节点（图片 / 视频节点）的进度小结；没有这类节点时返回空 */
function genNodeNotes(p: Project): string {
  const nodes = (p.canvas?.nodes ?? []).filter(
    (n) => n.type === 'imageGen' || n.type === 'videoGen'
  )
  if (!nodes.length) return ''
  const done = nodes.filter((n) => n.data.outputAssetId).length
  const running = nodes.filter((n) => n.status === 'running' || n.status === 'pending').length
  const failed = nodes.filter((n) => n.status === 'failed' || n.error)
  const lines = [`**캔버스 노드** — 생성 노드 ${nodes.length}개 중 ${done}개에 결과가 있습니다.`]
  if (running) lines.push(`- ${running}개 생성 중`)
  if (failed.length) {
    lines.push(
      `- ${failed.length}개 실패 ${failed
        .slice(0, 3)
        .map((n) => `「${n.data.label || n.id}」${n.error ? `（${n.error.slice(0, 40)}）` : ''}`)
        .join('、')}`
    )
  }
  return lines.join('\n')
}

/** 合并后的进度盘点：流水线进度 + 自由节点进度一起报 */
function statusNotes(p: Project): string {
  const parts: string[] = []
  if (hasPipelineData(p)) parts.push(qaNotes(p))
  const gen = genNodeNotes(p)
  if (gen) parts.push(gen)
  if (!parts.length) {
    return '**캔버스가 비어 있습니다.** 왼쪽에 ‘선협 판타지 숏드라마를 샷 8개로 써 줘’처럼 요청하세요. 캔버스 빈 곳을 오른쪽 클릭해 이미지, 영상, 대본, 캐릭터, 장면, 스토리보드 노드를 직접 추가할 수도 있습니다.'
  }
  return parts.join('\n\n')
}

function statusChips(p: Project | null | undefined): { label: string; text: string }[] {
  const chips: { label: string; text: string }[] = []
  const next = nextPipelineStep(p)
  if (next && (p?.shots.length || p?.script?.content?.trim())) {
    chips.push({ label: `계속 — ${next.label}`, text: '继续' })
  }
  const failed = (p?.canvas?.nodes ?? []).find(
    (n) => (n.type === 'imageGen' || n.type === 'videoGen') && (n.status === 'failed' || n.error)
  )
  if (failed) chips.push({ label: '실패한 노드 다시 실행', text: `重新生成节点 ${failed.id}` })
  chips.push({ label: '이미지 그리기', text: '帮我创建一个图片节点并生成：' })
  chips.push({ label: '전체 워크플로', text: '全流程跑完' })
  return chips.slice(0, 3)
}

/** 问答 / 咨询：不操作画布，结合记忆和项目状态直接回答 */
async function answerQuestion(
  userText: string,
  history: AgentMessage[],
  p: Project,
  onEvent: AgentProgress,
  options: AgentRunOptions
): Promise<AgentTurnResult> {
  onEvent({ kind: 'think', label: '답변을 작성하는 중…' })
  const memoryText = await memoryContextPrompt()
  const chat = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You are the Studio canvas assistant. You know AI short-drama production, image and video workflows, and prompt writing. The user is asking a question or requesting creative advice.
- Answer directly in Korean (한국어). Do not execute canvas operations or output JSON.
- Use the project state${memoryText ? ' and saved user preferences' : ''} to give a concrete answer.
- Use a conversational tone and bullets when helpful. You may briefly mention one practical next step after answering.
- Use Markdown lists, bold for key conclusions, and fenced code blocks for prompts or examples. Use subheadings when there are more than three points.
- Keep the answer under 500 characters and be concise.
${memoryText ? `\n${memoryText}` : ''}`
        },
        {
          role: 'user',
          content: `현재 프로젝트 상태(참고용이며 조작할 필요 없음)\n${projectContextPrompt(userText)}\n\n아래에 사용자의 이번 질문과 첨부 자료 또는 로컬 파일이 있습니다. 이 자료를 답변의 근거로 우선 사용하고 사용자에게 다시 붙여 넣으라고 요청하지 마세요.\n${userText}`
        },
        ...chat
      ],
      temperature: 0.5,
      maxTokens: 1200,
      signal: options.signal,
      timeoutMs: 90_000
    })
    const reply = resp.content.trim()
    if (!reply) throw new Error('모델이 내용을 반환하지 않았습니다.')
    return {
      reply,
      results: [],
      chips: statusChips(p)
    }
}

/** 演示模式下自由画布的规则规划 */
function freeformHeuristicPlan(
  userText: string,
  selectedNodeId?: string
): { say: string; actions: any[] } {
  const t = userText.trim()
  const p = useProjectStore().current
  const actions: any[] = []

  if (p) {
    // 生成 / 重跑某个节点
    const runMatch = t.match(/(?:重新生成|生成|重跑|跑一下|다시 생성|생성|실행|regenerate|generate|run)\s*(?:节点|노드|node)?\s*([a-zA-Z]+_\w+)/i)
    if (runMatch) actions.push({ tool: 'run_node', nodeId: runMatch[1] })
    // 优化选中节点
    if (!actions.length && selectedNodeId && /优化|扩写|加厚|润色|更|再|최적화|다듬|구체화|refine|expand|polish/i.test(t)) {
      actions.push({ tool: 'optimize_node_prompt', nodeId: selectedNodeId, text: t })
    }
    // 体检 / 整理画布
    if (!actions.length && /检查|体检|看看有什么问题|哪里不对|齐了没|漏了|검수|누락 확인|quality check|check for issues/i.test(t)) {
      actions.push({ tool: 'check_project' })
    }
    if (!actions.length && /整理|重排|排布|重新摆放|整理一下画布|캔버스 정리|다시 배치|organize the canvas|rearrange/i.test(t)) {
      actions.push({ tool: 'arrange_canvas' })
    }
    // 删掉选中节点
    if (!actions.length && selectedNodeId && /删|去掉|移除|삭제|제거|\b(?:delete|remove)\b/i.test(t)) {
      actions.push({ tool: 'delete_node', nodeId: selectedNodeId })
    }
    // 新建节点（说「给这个节点加…」时自动挂到选中节点后面并连线）
    if (!actions.length && /视频/.test(t) && /新建|创建|做一?[个条]|来一?[个条]|加|接|连/.test(t)) {
      const dur = Number(t.match(/(\d{1,2})\s*(?:秒|초|seconds?\b)/i)?.[1] || 8)
      actions.push({ tool: 'create_video_node', text: t, duration: dur, sourceNodeId: selectedNodeId })
    } else if (
      !actions.length &&
      /图|画/.test(t) &&
      /新建|创建|画一?[张个]|做一?[张个]|来一?[张个]|加|接|连/.test(t)
    ) {
      actions.push({ tool: 'create_image_node', text: t, sourceNodeId: selectedNodeId })
    }
  }

  if (!actions.length) {
    return {
      say: '그릴 대상이나 수정할 노드를 알려 주세요. 예를 들어 ‘선협 판타지의 시련 장면을 8초 영상 노드로 만들어 줘’ 또는 ‘이 노드의 프롬프트를 더 구체적으로 써 줘’라고 요청하세요.',
      actions: []
    }
  }
  return { say: '요청한 작업을 진행합니다.', actions }
}

function continuePlan(p: Project): { say: string; actions: any[] } {
  const n = nextPipelineStep(p)
  if (!n) {
    return { say: '남은 단계가 없습니다. 특정 샷을 바꾸려면 캔버스에서 해당 노드를 선택해 다시 생성하세요.', actions: [] }
  }
  if (n.id === 'review') {
    const fake = { ...p, playApproved: true }
    const after = nextPipelineStep(fake)
    return {
      say: after ? `대본을 승인하고 ‘${after.label}’ 단계로 진행합니다.` : '대본을 승인했습니다.',
      actions: [{ tool: 'approve_play' }, ...(after?.tools ?? [])]
    }
  }
  return { say: `‘${n.label}’ 단계를 진행합니다.`, actions: n.tools }
}

function clarifyChips(p: Project | null | undefined): { label: string; text: string }[] {
  if (!p?.script?.content?.trim()) {
    return [
      { label: '먼저 대본 나누기', text: '按我刚说的拆剧本' },
      { label: '전체 워크플로', text: '全流程跑完' }
    ]
  }
  if (!p.shots.length) {
    return [
      { label: '대본 나누기', text: '拆剧本' },
      { label: '전체 워크플로', text: '全流程跑完' }
    ]
  }
  if (needsPlayReview(p)) return reviewChips()
  const n = nextPipelineStep(p)
  if (n) {
    return [
      { label: `계속 — ${n.label}`, text: '继续' },
      { label: '전체 워크플로', text: '全流程跑完' }
    ]
  }
  return []
}

function reviewChips() {
  return [
    { label: '승인', text: '确认通过' },
    { label: '계속 진행', text: '继续' },
    { label: '전체 워크플로', text: '全流程跑完' }
  ]
}

function nextChips(next: PipelineStep | null): { label: string; text: string }[] {
  if (!next) return []
  return [
    { label: `계속 — ${next.label}`, text: '继续' },
    { label: '먼저 확인', text: '先看看' },
    { label: '전체 워크플로', text: '全流程跑完' }
  ]
}

function wrapUpReply(
  results: AgentToolResult[],
  userText: string,
  fallbackSay: string
): { reply: string; chips: { label: string; text: string }[] } {
  const p = useProjectStore().current
  const fail = results.filter((r) => !r.ok)
  const failLine = fail.length
    ? `\n\n**실패 ${fail.length}건**\n${fail
        .map((f) => `- ${TOOL_LABEL[f.tool] || f.tool}：${f.detail}`)
        .join('\n')}`
    : ''
  const all = wantAll(userText)
  const didPlay = results.some(
    (r) => r.ok && (r.tool === 'generate_play' || r.tool === 'generate_storyboard')
  )
  const didContinue = results.some((r) => r.ok && r.tool === 'continue_play')
  const didBoard = results.some((r) => r.ok && r.tool === 'extract_cast')
  const didApprove = results.some((r) => r.ok && r.tool === 'approve_play')
  const didCast = results.some(
    (r) => r.ok && /sheet|scene/.test(r.tool)
  )
  const didImg = results.some((r) => r.ok && /image/.test(r.tool))
  const didVid = results.some((r) => r.ok && /video/.test(r.tool))
  const didAud = results.some((r) => r.ok && /audio/.test(r.tool))

  if (all) {
    const next = nextPipelineStep(p)
    return {
      reply: `**전체 워크플로 실행을 마쳤습니다.**${failLine || '\n\n캔버스의 노드를 모두 갱신했습니다.'}${
        next ? `\n\n‘${next.label}’ 단계가 남았습니다. ‘계속’이라고 하면 진행합니다.` : ''
      }`,
      chips: nextChips(next)
    }
  }
  if (didContinue) {
    const hasShots = Boolean(p?.shots.length)
    return {
      reply: hasShots
        ? `**기존 장면을 보존하고 대본을 이어 썼습니다.**\n\n- 새 장면의 캔버스 노드가 아직 없습니다.\n- ‘스토리보드 키프레임’ 그룹에서 ‘다시 추출’을 누르거나 ‘스토리보드를 다시 추출해 줘’라고 요청하세요.${failLine}`
        : `**기존 장면을 보존하고 대본을 이어 썼습니다.**\n\n- 검토하고 문구를 수정할 수 있습니다.\n- ‘계속’이라고 하면 먼저 캐릭터를 추출합니다. 장면과 스토리보드는 각각 다음 단계에서 추출합니다.${failLine}`,
      chips: hasShots
        ? [
            { label: '스토리보드 다시 추출', text: '重新提取分镜' },
            { label: '더 이어 쓰기', text: '续写剧本' },
            { label: '먼저 확인', text: '先看看' }
          ]
        : [
            { label: '먼저 캐릭터 추출', text: '继续' },
            { label: '더 이어 쓰기', text: '续写剧本' },
            { label: '먼저 확인', text: '先看看' }
          ]
    }
  }
  if (didPlay && !(p?.shots.length)) {
    return {
      reply: `**캔버스 왼쪽에 전체 대본을 작성했습니다.** 노드 추출은 아직 시작하지 않았습니다.

세 가지를 먼저 확인하세요.

- 이야기 배경
- 캐릭터
- 환경

확인 후 ‘계속’이라고 하면 캐릭터를 추출합니다. 장면과 스토리보드는 각각 다음 단계에서 추출합니다. ‘전체 워크플로’를 요청하면 모든 단계를 실행합니다.${failLine}`,
      chips: [
        { label: '먼저 캐릭터 추출', text: '继续' },
        { label: '이어 쓰기', text: '续写剧本' },
        { label: '먼저 확인', text: '先看看' },
        { label: '전체 워크플로', text: '全流程跑完' }
      ]
    }
  }
  if (didBoard) {
    const n = p?.shots.length ?? 0
    const subjectCount = p?.subjects?.length ?? 0
    const sceneCount = p?.scenes?.length ?? 0
    if (!n && !sceneCount) {
      return {
        reply: `**1단계 완료** — 캐릭터 ${subjectCount}개를 추출하고 저장했습니다. 장면과 스토리보드는 다음 단계에서 추출합니다.

- 캐릭터를 확인한 뒤 ‘계속’이라고 하면 장면을 추출합니다.${failLine}`,
        chips: [
          { label: '장면 추출 계속', text: '继续' },
          { label: '먼저 캐릭터 확인', text: '先看看人物' }
        ]
      }
    }
    if (!n) {
      return {
        reply: `**2단계 완료** — 캐릭터 ${subjectCount}개를 보존하고 장면 ${sceneCount}개를 저장했습니다.

- 장면을 확인한 뒤 ‘계속’이라고 하면 스토리보드를 추출합니다.${failLine}`,
        chips: [
          { label: '스토리보드 추출 계속', text: '继续' },
          { label: '먼저 장면 확인', text: '先看看场景' }
        ]
      }
    }
    return {
      reply: `**3단계 완료** — 스토리보드 샷 ${n}개를 추출해 기존 캐릭터와 장면을 연결했습니다.

- 캔버스에서 결과를 확인하세요.
- 확인 뒤 ‘계속’이라고 하면 캐릭터 설정과 장면 이미지를 생성합니다. ‘전체 워크플로’를 요청하면 모든 단계를 실행합니다.${failLine}`,
      chips: reviewChips()
    }
  }
  if (didApprove && !didCast && !didImg) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '대본을 승인했습니다.\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didCast && !didImg) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '캔버스에 캐릭터 설정 이미지와 장면 이미지를 생성했습니다.\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didImg && !didVid) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '캔버스에 스토리 개요판을 배치했습니다.\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didVid && !didAud) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '스토리보드 샷 영상을 생성했습니다.\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didAud) {
    return { reply: `내레이션을 생성했습니다. ‘영상 합성’ 노드를 누르면 영상 미리보기에 결과가 표시됩니다.${failLine}`, chips: [] }
  }
  const next = nextPipelineStep(p)
  return {
    reply: (fallbackSay || '이 단계를 완료했습니다.') + failLine + (next ? `\n${continueQuestion(next, '')}` : ''),
    chips: nextChips(next)
  }
}

/** 演示模式 / 模型跑偏时：砍掉用户没点名的动作 */
function alignNewStoryActions(
  actions: any[],
  userText: string,
  history: AgentMessage[]
): any[] {
  const p = useProjectStore().current
  if (!isNewStoryBrief(userText, p)) return actions
  const brief = collectStoryBrief(history, userText)
  const triedWrite = actions.some((a) =>
    ['generate_play', 'continue_play', 'seed_script', 'generate_storyboard'].includes(String(a.tool))
  )
  const detailed = brief.length >= 36 || /女主|男主|人物|修仙|炼丹|场景|对白|热梗/.test(brief)
  if (!triedWrite && !detailed) return actions
  const out = actions.filter((a) => a.tool !== 'continue_play' && a.tool !== 'extract_cast')
  const seed = out.find((a) => a.tool === 'seed_script')
  if (seed) seed.text = brief
  else out.unshift({ tool: 'seed_script', text: brief })
  const gen = out.find((a) => a.tool === 'generate_play' || a.tool === 'generate_storyboard')
  if (gen) gen.text = brief
  else out.push({ tool: 'generate_play', text: brief })
  return out
}

function sanitizeActions(actions: any[], userText: string): any[] {
  const all = wantAll(userText)
  const t = userText
  // 只有「批量」动作（会一次性烧掉大量额度）才需要用户的话里有对应意图，
  // 单个动作放手让模型根据最新画布决定，避免在意料之外被静默丢弃。
  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|写剧本|提炼节点|拆剧本|续写|接着写|再写|分镜|场次/.test(t)
  const askedSheet = /人设|角色图|四视图|人物图|角色/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景|场景/.test(t)
  const askedPanel = /故事看板|看板图|线稿分镜|线稿/.test(t)
  const askedImage = /配图|出图|关键帧|画面|图片|静帧|作图|图/.test(t)
  const askedVideo = /视频|图生视频|动态|出片|成片|运镜/.test(t)
  const askedAudio = /口播|配音|语音|旁白|声音|台词录音/.test(t)
  const shotHit = parseShotIndexes(t).length > 0
  return actions.filter((a) => {
    const tool = String(a?.tool || '')
    if (!tool) return false
    if (tool === 'generate_all_prop_sheets' || tool === 'generate_prop_sheet') return false
    if (tool === 'generate_all_sheets') return askedSheet || all
    if (tool === 'generate_all_scenes') return askedScene || all
    if (tool === 'generate_all_boards') return askedPanel || all
    if (tool === 'generate_all_images') return askedImage || shotHit || all
    if (tool === 'generate_all_videos') return askedVideo || shotHit || all
    if (tool === 'generate_all_audio') return askedAudio || shotHit || all
    return true
  })
}

function dedupeActions(actions: any[]): any[] {
  const seen = new Set<string>()
  return actions.filter((a) => {
    const key = `${a.tool}:${a.subjectId || ''}:${a.sceneId || ''}:${a.shotId || ''}:${a.nodeId || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const SCRIPT_REWRITE = /重新写(?:完整)?剧本|重写(?:完整)?剧本|改写剧本|换(?:一个|成).{0,12}(?:故事|剧本)|新故事|新剧本/

/** 导入的成稿只允许拆镜，不允许智能体先重写剧本。 */
function protectImportedScript(actions: any[], userText: string): any[] {
  const origin = useProjectStore().current?.script?.origin
  if (origin !== 'imported' || SCRIPT_REWRITE.test(userText)) return actions
  const kept = actions.filter(
    (item) => !['generate_play', 'generate_storyboard', 'seed_script'].includes(String(item?.tool || ''))
  )
  const askedSplit = /拆分镜|拆镜|提炼|分镜|出节点|拆剧本|拆人物|拆场景/.test(userText)
  if (askedSplit && !kept.some((item) => item.tool === 'extract_cast')) {
    kept.unshift({ tool: 'extract_cast' })
  }
  return kept
}

function applyPlayGate(actions: any[], userText: string): any[] {
  actions = protectImportedScript(actions, userText)
  const all = wantAll(userText)
  const p = useProjectStore().current
  if (all) {
    const out = [...actions]
    const hasBoard = out.some(
      (a) =>
        a.tool === 'generate_storyboard' ||
        a.tool === 'extract_cast' ||
        a.tool === 'continue_play'
    )
    const hasApprove = out.some((a) => a.tool === 'approve_play')
    if (!hasApprove) {
      const idx = out.findIndex((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast')
      if (idx >= 0) out.splice(idx + 1, 0, { tool: 'approve_play' })
      else out.unshift({ tool: 'approve_play' })
    }
    if (hasBoard) {
      /* 全流程：拆完立刻视为通过再往下 */
    }
    return out
  }
  if (isApprovePlayRequest(userText)) {
    return [{ tool: 'approve_play' }]
  }
  const hasBoard = actions.some(
    (a) =>
      a.tool === 'generate_storyboard' ||
      a.tool === 'generate_play' ||
      a.tool === 'continue_play' ||
      a.tool === 'extract_cast' ||
      a.tool === 'seed_script'
  )
  if (hasBoard) {
    const kept = actions.filter(
      (a) =>
        a.tool === 'generate_storyboard' ||
        a.tool === 'generate_play' ||
        a.tool === 'continue_play' ||
        a.tool === 'extract_cast' ||
        a.tool === 'seed_script' ||
        a.tool === 'sync_canvas' ||
        a.tool === 'focus_node'
    )
    const writingPlay = kept.some(
      (a) => a.tool === 'generate_play' || a.tool === 'generate_storyboard' || a.tool === 'continue_play'
    )
    // 非全流程：写剧本和提炼拆开，同一轮只写剧本
    if (writingPlay) {
      return kept.filter((a) => a.tool !== 'extract_cast')
    }
    return kept
  }
  if (p && needsPlayReview(p)) {
    return actions.filter((a) => !DOWNSTREAM_TOOLS.has(String(a.tool)))
  }
  return actions
}

function heuristicPlan(userText: string): { say: string; actions: any[] } {
  const t = userText.trim()
  const p = useProjectStore().current!
  const actions: any[] = []
  const all = wantAll(t)
  const shotIdxs = parseShotIndexes(t)
  const namedSubs = (p.subjects ?? []).filter((s) => s.name && t.includes(s.name))
  const namedScns = (p.scenes ?? []).filter((s) => s.name && t.includes(s.name))

  const askedExtract = /提炼节点|提炼人物|提炼场景|拆节点|出节点|重新提取|重新提炼|노드 추출|캐릭터 추출|장면 추출|다시 추출|extract nodes|extract characters|extract scenes|re-extract/i.test(t)
  const askedContinuePlay = /续写|接着写|再写[一两三四\d]*场|加一场|往后写|续一[场段]|写下去|이어\s*(?:쓰기|써)|장면 추가|continue writing|add a scene/i.test(t)
  const askedPlay = /写剧本|完整剧本|重新写剧本/.test(t) && !askedContinuePlay
  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|拆剧本/.test(t)
  const askedSheet = /人设|角色图|四视图/.test(t)
  const askedProp = /资产图|道具图|关键道具/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景/.test(t)
  const askedPanel = /故事看板|看板图|线稿分镜/.test(t)
  const askedImage = /配图|出图|关键帧|把图画上|缺的图/.test(t)
  const askedVideo = /图生视频|生成视频|出视频/.test(t) || /第.+镜.*视频/.test(t)
  const askedAudio = /口播|配音|语音/.test(t)
  const looksLikeBrief =
    t.length >= 16 &&
    !askedSheet &&
    !askedProp &&
    !askedImage &&
    !askedVideo &&
    !askedScene &&
    !p.shots.length &&
    !p.script?.playReady
  const playReady = Boolean(p.script?.playReady && p.script.content?.trim())
  const newStory = isNewStoryBrief(t, p)
  // 首尾帧链模式：出视频前要先给每镜合成「起始帧 + 结束帧」两张图
  // 判断口径与画布分组、流水线下一步共用 needsShotFrames，避免三边不一致
  const chainFrames = needsShotFrames(p)

  if (newStory) {
    actions.push({ tool: 'seed_script', text: t })
    actions.push({ tool: 'generate_play', text: t })
  } else if (!p.script?.content?.trim() && (askedBoard || askedPlay || looksLikeBrief || all)) {
    actions.push({ tool: 'seed_script', text: t })
  }
  if (!newStory && askedContinuePlay && playReady) {
    actions.push({ tool: 'continue_play', text: t })
  } else if (!newStory && (askedExtract || (askedBoard && playReady && !p.shots.length))) {
    const extractStage = extractStageFromText(t)
    actions.push({ tool: 'extract_cast', ...(extractStage ? { extractStage } : {}) })
  } else if (!newStory && (askedPlay || askedBoard || looksLikeBrief)) {
    actions.push({ tool: 'generate_play' })
  }

  if (namedSubs.length && askedSheet) {
    for (const s of namedSubs) actions.push({ tool: 'generate_sheet', subjectId: s.id })
  } else if (askedSheet) {
    actions.push({ tool: 'generate_all_sheets' })
  }

  if (namedScns.length && askedScene) {
    for (const s of namedScns) actions.push({ tool: 'generate_scene', sceneId: s.id })
  } else if (askedScene) {
    actions.push({ tool: 'generate_all_scenes' })
  }

  if (shotIdxs.length) {
    for (const i of shotIdxs) {
      const shot = p.shots[i] ?? p.shots.find((s) => s.index === i)
      if (!shot) continue
      if (askedVideo && !askedImage && !askedPanel) {
        // 首尾帧链：先用这一镜的人物和场景画出起始帧和结束帧，再拿这两张出视频
        if (chainFrames && !shot.firstFrameAssetId && !shot.lastFrameAssetId) {
          actions.push({ tool: 'generate_shot_frames', shotId: shot.id })
        }
        actions.push({ tool: 'generate_video', shotId: shot.id })
      } else if (askedAudio && !askedImage && !askedVideo && !askedPanel) {
        actions.push({ tool: 'generate_audio', shotId: shot.id })
      } else if (askedPanel && !askedImage) {
        actions.push({ tool: 'generate_shot_board', shotId: shot.id })
      } else {
        actions.push({ tool: 'generate_shot_image', shotId: shot.id })
        if (askedVideo) actions.push({ tool: 'generate_video', shotId: shot.id })
      }
    }
  } else {
    if (askedPanel) actions.push({ tool: 'generate_all_boards' })
    if (askedImage) actions.push({ tool: 'generate_all_images' })
    if (chainFrames) actions.push({ tool: 'generate_all_frames' })
    if (askedVideo) actions.push({ tool: 'generate_all_videos' })
    if (askedAudio) actions.push({ tool: 'generate_all_audio' })
  }

  if (all) {
    if (!playReady && !actions.some((a) => a.tool === 'generate_play')) {
      actions.push({ tool: 'generate_play' })
    }
    if (!p.shots.length && !actions.some((a) => a.tool === 'extract_cast')) {
      actions.push({ tool: 'extract_cast' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_sheets')) {
      actions.push({ tool: 'generate_all_sheets' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_scenes')) {
      actions.push({ tool: 'generate_all_scenes' })
    }
    if (shotsMissingKeyframe(p).length && !actions.some((a) => a.tool === 'generate_all_images')) {
      actions.push({ tool: 'generate_all_images' })
    }
    if (shotsMissingStoryboard(p).length && !actions.some((a) => a.tool === 'generate_all_boards')) {
      actions.push({ tool: 'generate_all_boards' })
    }
    if (chainFrames && !actions.some((a) => a.tool === 'generate_all_frames')) {
      actions.push({ tool: 'generate_all_frames' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_videos')) {
      actions.push({ tool: 'generate_all_videos' })
    }
  }

  if (!actions.length) {
    if (needsPlayReview(p)) {
      return {
        say: playGateMessage(),
        actions: []
      }
    }
    return {
      say: '어떤 단계를 진행할까요? 대본 작성, 이어 쓰기, 노드 추출, 검수 승인, 캐릭터 설정 이미지 또는 1번 샷 이미지를 요청할 수 있습니다. 전체 제작을 진행하려면 ‘전체 워크플로’를 요청하세요.',
      actions: []
    }
  }
  if (newStory && !all) {
    return { say: '이번에 알려 준 새 이야기로 대본을 작성합니다.', actions }
  }
  if (askedExtract && !all) {
    return { say: '전체 대본의 캐릭터, 장면, 스토리보드 노드를 추출합니다.', actions }
  }
  if (askedContinuePlay && !all) {
    return { say: '기존 대본의 장면과 대사를 보존하고 이후 장면을 덧붙입니다.', actions }
  }
  if ((askedPlay || askedBoard || looksLikeBrief) && !all) {
    return { say: '먼저 전체 대본을 작성합니다. 왼쪽에서 확인한 뒤 ‘계속’이라고 하면 노드 추출을 진행합니다.', actions }
  }
  return { say: '요청한 작업을 진행합니다.', actions }
}
