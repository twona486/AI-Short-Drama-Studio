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
  PLAY_GATE_MSG,
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

const TOOLS_HINT = `당신은 剧流 Studio 캔버스의 현장 도우미입니다. 작업을 진행하면서 캔버스에서 일어난 일을 사용자에게 알려 주세요.

필수 규칙
1. JSON만 출력하세요. { "say": "사용자에게 보여 줄 한국어 메시지", "actions": [ ... ], "done": false }. actions는 다음에 실행할 소량의 실제 캔버스 작업입니다. 한 번에 제안 목록을 작성하는 대신 도구를 실행한 뒤 최신 캔버스를 보고 다시 판단하세요. 사용자 목표가 캔버스에 반영된 것을 확인하면 done=true, actions=[]를 반환하세요.
1b. 캔버스의 노드를 생성, 연결, 수정, 삭제, 재실행하거나 배치를 정리하고, 오류를 점검하고 복구하며, 전문적인 대본과 스토리보드를 작성하세요. 기본적으로 직접 완료하세요. 할당량을 많이 소비하거나 되돌릴 수 없는 일괄 생성은 먼저 사용자에게 확인하세요. 불확실하면 확인한 뒤 진행하되 캔버스를 건드리기 두렵다는 이유로 조언만 하지 마세요.
2. ‘만들어 줘’, ‘시작’처럼 요청이 모호하면 actions는 빈 배열로 두고 say에서 주제와 길이, 대본만 필요한지 전체 워크플로가 필요한지 물으세요.
3. 대본 제작은 두 단계이며 기본적으로 다른 차례에 진행합니다. generate_play는 전체 Markdown 대본만 작성합니다. 대본 작성, 각색, 이어 쓰기에는 ai-short-film-screenwriter의 이야기 동력, 필수 각색 제약, 이야기 박자, AI 제작 제약, 장면별 규칙을 적용하고 완성 전에 자체 점검하세요. 한 문장 이야기, 갈등 구조, 전체 줄거리, 캐릭터 소개(주인공, 상대역, 핵심 가족의 욕망, 두려움, 변화), 환경과 장면, 장면별 목표, 동작과 대사를 포함해야 합니다. 내레이션, 화면, 길이를 네 칸짜리 표에 넣지 마세요. 설화의 절정만 뽑아서 쓰거나 대사 없는 영화로 만들지 마세요. 서로 알아보기, 이름 부르기, 대치, 질문과 답변에서는 화면 속 인물들이 대사를 주고받아야 합니다. 캐릭터, 장면, 스토리보드 노드는 만들지 마세요. 사용자가 다시 ‘계속’ 또는 ‘노드 추출’이라고 해야 extract_cast를 실행합니다. ‘전체 워크플로’를 요청한 경우에만 같은 차례에서 generate_play와 extract_cast를 실행하세요.
3b. extract_cast는 지금 빠진 단계 하나만 실행합니다. 캐릭터, 장면, 스토리보드 순으로 각각 추출한 뒤 멈추세요. 한 번에 모두 추출하지 마세요. say에 방금 완료한 단계와 다음 단계를 정확히 쓰세요. 기존 노드 중 특정 그룹의 수정을 요청하면 extractStage를 사용하고 전체를 다시 작업하지 마세요.
3c. 길이는 반드시 맞춰야 하는 예산입니다. 사용자가 ‘약 40초’, ‘30S’, ‘1분’처럼 최종 영상 길이를 지정하면 seed_script와 generate_play의 text에 그 문구를 그대로 포함하세요. 시스템에서 그 값으로 장면 수, 본문 글자 수, 샷 수를 정하므로 빠뜨리면 샷이 20개 이상으로 늘고 영상이 몇 분으로 길어질 수 있습니다. 샷을 나눈 다음 전체 길이를 검증합니다. 지정 길이에서 ±10초만 허용하고 벗어나면 다시 나눕니다. 사용자가 길이를 지정하지 않고 단편을 요청하면 실행하기 전에 say에서 목표 길이를 물으세요.
4. 전체 대본이 이미 있는 경우
   - ‘이어 써’, ‘계속 써’, ‘두 장면 더 써’라는 요청에는 continue_play를 실행하고 기존 장면을 보존하세요.
   - 사용자가 대본을 새로 쓰라고 명시하거나 현재 대본과 무관한 새 이야기(소재, 등장인물, 그림체)를 제시하면 먼저 seed_script를 실행하고(text는 최근 몇 차례에 나온 그림체, 길이, 소재, 인물이 포함된 이야기 원문) generate_play를 실행하세요. continue_play를 쓰거나 이전 대본을 초안으로 삼지 마세요.
4b. 현재 대본의 origin이 imported(사용자가 가져온 완성 대본)인 경우 샷 나누기, 캐릭터 추출, 장면 추출에는 extract_cast만 사용하세요. seed_script, generate_play, generate_storyboard는 금지합니다. 대사와 줄거리를 원문 그대로 샷에 넣으세요. 사용자가 ‘대본을 다시 써’라고 분명히 말할 때만 본문을 재작성할 수 있습니다.
5. 일괄, 장시간 또는 되돌릴 수 없는 생성(전체 캐릭터 이미지, 장면, 키프레임, 영상, 더빙 채우기)은 기본적으로 한 번에 소량을 처리하고 say에 다음 단계를 밝히세요. 사용자가 ‘계속’이나 ‘전체 워크플로’라고 하면 진행하세요. 노드 생성, 연결, 삭제, 프롬프트 수정, 이름 변경, 단일 노드 재실행, 캔버스 재배치, 상태 점검은 요청을 받으면 한 번에 완료하세요.
6. 일반 제작에서는 스토리 개요판을 생성하지 않습니다. 캐릭터 설정 이미지와 장면 이미지로 해당 샷에서 일어나는 사건을 키프레임으로 그린 뒤 영상을 만드세요. AI 숏드라마에는 스토리 개요판을 사용하세요.
6b. 시작·끝 프레임 그룹이 캔버스에 있으면 반드시 해당 단계를 거치세요. 프로젝트에서 시작·끝 프레임 워크플로를 활성화했거나 샷에서 해당 모드를 선택했다면, 영상 생성 전에 샷별 시작 프레임과 끝 프레임을 그리세요. generate_all_frames로 한 번에 채우거나 샷마다 generate_shot_frames를 실행한 다음 generate_video / generate_all_videos를 실행하세요. 순서는 캐릭터 설정 → 장면 → (해당 모드의 샷은 키프레임과 개요판 생략) → 시작·끝 프레임 → 영상입니다. 장면 기준 이미지나 키프레임에서 바로 영상으로 넘어가면 모델에 시작·끝 프레임을 전달할 수 없습니다. 프레임 생성에 실패하면 기록하고 영상 제작을 계속하세요.
7. 스토리보드 노드를 검수하기 전에는 스토리 개요판이나 영상을 생성하지 마세요. 사용자가 ‘검수 통과’라고 하면 approve_play를 실행하고, ‘계속’이라고 하면 검수 후 다음 단계를 실행하세요. 이 규칙은 제작 워크플로에 적용하며 수동 노드 추가, 단일 자유 노드 생성, 프롬프트 수정을 막지 않습니다.
8. 한 번에 actions는 최대 12개입니다. 도구로 할 수 있는 요청은 실제 캔버스에서 수행하세요. 사용법만 답하지 마세요. 먼저 노드 프롬프트를 수정한 뒤 요청에 맞춰 이미지 또는 영상을 생성하세요. 각 작업 묶음 후에 최신 에셋 상태로 검수하고 이미 성공한 도구를 무의미하게 반복하지 마세요. 자유 노드를 새로 만들 때는 이번 묶음에서 생성만 하고 다음 차례에 최신 캔버스에서 실제 nodeId를 읽은 뒤 run_node를 실행하세요. ID를 지어내지 마세요.
9. 동일한 캔버스에서 대본 제작 워크플로(seed_script / generate_play / extract_cast / …)를 실행하거나 생성 노드 하나만 조작(create_image_node / create_video_node / update_node / run_node)할 수 있습니다. 대본, 스토리보드, 캐릭터 설정, 장면을 말하면 제작 워크플로를 선택하세요. ‘한 장 그려’, ‘8초 영상 만들어’, ‘이 노드 수정해’만 요청하면 단일 노드만 조작하세요. 단일 노드는 곧바로 조작하고 생성할 수 있습니다.
10. 사용자가 ‘특정 노드나 선택한 노드에 이미지 또는 영상 노드를 추가해’, ‘이어서 붙여’, ‘연결해’라고 요청하면 create_image_node / create_video_node에 sourceNodeId를 반드시 넣으세요. 별도 노드를 지정하지 않으면 현재 선택한 노드의 ID를 넣습니다. 도구는 새 노드를 상위 노드 오른쪽에 배치하고 자동으로 연결하며 상위 노드 결과를 하위 노드의 참조 이미지로 전달합니다. 기존 노드 두 개를 연결할 때는 connect_nodes를 쓰세요. 연결 없이 생성만 하지 마세요.

사용 가능한 도구
{ "tool": "seed_script", "text": "최근 대화에 나온 이야기 원문 전체" }
{ "tool": "generate_play", "text": "선택 사항. seed_script와 같은 이야기 원문" }
{ "tool": "continue_play", "text": "선택 사항. 이어 쓸 방향. 예를 들어 두 장면을 더 쓰거나 아버지가 집에 돌아온 뒤를 작성" }
{ "tool": "extract_cast" }
{ "tool": "extract_cast", "extractStage": "subjects|scenes|shots" }
{ "tool": "generate_storyboard" }
{ "tool": "approve_play" }
{ "tool": "revise_shot", "shotId": "shot_xxx", "visualPrompt": "선택 사항. 정지 화면 또는 키프레임 화면", "imagePrompt": "선택 사항. 실제 이미지 생성 프롬프트", "videoPrompt": "영상 모델에 실제로 보내는 동작 연출 프롬프트. 시작 화면, 계기, 연속 동작, 카메라 움직임, 마지막 화면, 동기화된 소리", "voiceover": "선택 사항", "duration": 5, "cameraMovement": "static|push|pull|pan|tilt|orbit" }
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
{ "tool": "create_image_node", "text": "완전한 이미지 생성 프롬프트", "sourceNodeId": "선택 사항인 상위 노드 ID. 입력하면 새 노드를 해당 노드 오른쪽에 두고 자동으로 연결" }
{ "tool": "create_video_node", "text": "완전한 동작 연출 프롬프트", "duration": 8, "sourceNodeId": "상위 노드 ID. 특정 노드에 영상 노드를 추가할 때 필수" }
{ "tool": "connect_nodes", "sourceNodeId": "상위 노드 ID", "targetNodeId": "하위 노드 ID" }
{ "tool": "delete_node", "nodeId": "삭제할 자유 이미지 또는 영상 노드 ID" }
{ "tool": "arrange_canvas" }
{ "tool": "check_project" }
{ "tool": "update_node", "nodeId": "imageGen_xxx 또는 videoGen_xxx", "text": "새 프롬프트 전문", "nodeLabel": "선택 사항인 새 노드 이름", "duration": 8 }
{ "tool": "run_node", "nodeId": "캔버스 컨텍스트에 있는 노드 ID" }
{ "tool": "optimize_node_prompt", "nodeId": "imageGen_xxx 또는 videoGen_xxx", "text": "선택 사항인 최적화 방향. 예를 들어 더 생생한 화면, 명확한 동작과 표정" }
{ "tool": "remember", "text": "오래 기억할 사용자 선호 또는 사실. 사용자가 ‘기억해’나 ‘앞으로는’이라고 하면 필수" }
{ "tool": "forget", "text": "삭제할 기억의 키워드" }

질문과 기억 규칙
9. 캔버스를 조작하지 않는 질문, 조언, 창작 아이디어 대화는 say에서 바로 답하고 actions는 빈 배열로 반환하세요. 현재 프로젝트와 저장된 선호를 반영하여 구체적으로 답하세요.
10. 사용자가 ‘기억해’나 ‘앞으로는’이라고 하면 remember를, ‘잊어 줘’라고 하면 forget을 사용하세요. 이 요청에는 다른 작업이 필요하지 않습니다.`

function parseAgentJson(text: string): { say: string; actions: any[]; done: boolean } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [], done: true }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      say: String(obj.say || '好的'),
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
  if (!p.shots.length) issues.push('还没分镜')
  const noSheet = (p.subjects ?? []).filter((s) => !s.designSheetAssetId)
  if (noSheet.length) issues.push(`没人设：${noSheet.map((s) => s.name).join('、')}`)
  const noPlate = (p.scenes ?? []).filter((s) => !s.plateAssetId)
  if (noPlate.length) issues.push(`没底板：${noPlate.map((s) => s.name).join('、')}`)
  const noBoard = shotsMissingStoryboard(p)
  const noKf = shotsMissingKeyframe(p)
  if (noBoard.length) issues.push(`${noBoard.length} 镜还没故事看板`)
  if (noKf.length) issues.push(`${noKf.length} 镜还没关键帧`)
  const noVid = p.shots.filter((s) => !s.videoAssetId)
  if (noVid.length) issues.push(`${noVid.length} 镜还没视频`)
  const unbound = p.shots.filter((s) => !s.sceneId || !(s.subjectIds && s.subjectIds.length))
  if (unbound.length) issues.push(`${unbound.length} 镜没绑人物或场景`)
  if (!issues.length) return '**清单过了一遍**，目前能往下剪。'
  return `**还有 ${issues.length} 处要补**\n\n${issues.map((s) => `- ${s}`).join('\n')}`
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
  for (const m of text.matchAll(/第\s*(\d+)\s*镜/g)) {
    const n = Number(m[1])
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
    return { reply: '先打开或新建一个项目。', results: [], chips: [] }
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
        onEvent({ kind: 'log', label: `已写入本地记忆（${req.scope === 'global' ? '长期' : '本项目'}）` })
        return {
          reply: `记住了：${entry.content}\n${req.scope === 'global' ? '长期有效，之后的所有项目都会带上。' : '只在当前项目里生效。'}`,
          results: [],
          chips: [{ label: '查看记忆', text: '查看记忆' }]
        }
      }
    }
  }
  if (intent.kind === 'forget') {
    const keyword = parseForgetRequest(baseText)
    if (keyword) {
      const removed = await forgetMemory(keyword)
      return {
        reply: removed ? `已忘掉：${removed}` : `没有找到和「${keyword}」相关的记忆。`,
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
    onEvent({ kind: 'log', label: '正在盘点画布与项目状态' })
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
        say: '按你说的方向加厚这个节点的提示词，只补画面细节，不动原文格式。',
        actions: [{ tool: 'optimize_node_prompt', nodeId, text: userText }]
      }
      onEvent({ kind: 'plan', label: '计划 1 步：优化节点提示词', plan: buildPlanFromActions(plan0.actions as any, intent.label) })
      onEvent({ kind: 'log', label: '开始在画布上干活' })
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
          reply: `提示词优化没成功。${failed ? `\n原因：${failed.detail}` : ''}`,
          results: r0,
          chips: [{ label: '重试', text: '再优化一次当前节点提示词' }]
        }
      }
      return {
        reply: r0[0]?.detail || '提示词已加厚，写回节点了。',
        results: r0,
        chips: [
          { label: '生成这个节点', text: `生成节点 ${nodeId}` },
          { label: '再厚一点', text: '继续加厚当前节点提示词，画面再具体一点' }
        ]
      }
    }
    return {
      reply:
        '先在画布上点选一个图片或视频节点，再告诉我要往哪个方向优化；也可以直接说「新建一个…节点」。',
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
    onEvent({ kind: 'log', label: '需求不够清楚，先问你几句' })
    return { reply: clarifyMessage(p0), results: [], chips: clarifyChips(p0) }
  }

  const skillPack = skillContextForAgent(skillSelectContext(baseText))
  const wantQa = skillPack.selected.some((s) => s.id === 'qa-verify')
  const directorManual =
    skillPack.selected.some((s) =>
      ['storyboard-director', 'shot-video', 'h3-prompt-writing', 'film-chapter-production', 'shot-image'].includes(
        s.id
      )
    ) || /分镜|拆镜|提示词|导演/.test(baseText)
      ? importedDirectorPrefix()
      : ''

  let plan: { say: string; actions: any[]; done?: boolean }

  if (isContinueRequest(baseText) && !wantAll(baseText)) {
    plan = continuePlan(p0)
  } else if (getAIMode() === 'real' && !isContinueRequest(baseText)) {
    onEvent({ kind: 'think', label: '在想怎么做…' })
    const memoryText = await memoryContextPrompt()
    const chat = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `${TOOLS_HINT}\n\n${skillPack.prompt}${directorManual ? `\n\n${directorManual}` : ''}${restrictToNodes ? `\n\n${NODE_PATH_RULE}` : ''}${memoryText ? `\n\n${memoryText}\n回答和规划时必须尊重上面的记忆。` : ''}`
        },
        {
          role: 'user',
          content: `当前项目上下文（按本轮需求摘录的摘要，明细不全；工具执行时读的是实时数据，需要更多信息就用工具查）：\n${projectContextPrompt(baseText)}\n\n上面是状态。下面对话里最后一句才是本轮任务。若用户在讲一个和当前剧本无关的新故事，不要沿用旧剧本。需求含糊就提问，不要瞎做。只修改用户点名的范围。${options.selectedNodeId ? `\n用户当前选中的节点：${options.selectedNodeId}（没点名其他节点时默认操作它）` : ''}${material ? `\n\n${material}\n\n上面这些是用户本轮附上的材料（附件 / 本地文件），优先直接使用，不要要求用户重新粘贴。` : ''}`
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
    plan.say = PLAY_GATE_MSG
  }

  if (!plan.actions.length) {
    const say = String(plan.say || '').trim()
    if (!say) throw new Error('模型没有返回可执行的回复')
    onEvent({ kind: 'log', label: '先等你确认方向' })
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
  onEvent({ kind: 'log', label: '开始在画布上干活' })
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
                content: `${TOOLS_HINT}\n\n你正在做失败恢复。只输出 JSON。先根据错误、已完成步骤和最新项目状态判断根因属于：缺少上游产物、输入不合法、产物验收失败、临时服务错误，还是鉴权/额度/用户权限问题。\n- 缺上游：先补最小依赖，再让原目标继续。\n- 输入或产物质量问题：只修改有问题的局部节点，再重试目标。\n- 临时服务错误：允许一次同目标重试。\n- 鉴权、额度、内容安全或必须由用户决定的问题：actions 返回空，不得绕过。\n不要重复已经成功的工具，不要扩大用户授权范围，不要重做无关产物。最多给 4 个修复 actions；AgentLoop 会在修复动作后自动重新验收原目标。`
              },
              {
                role: 'user',
                content: `原任务：${userText}\n第 ${attempt} 次恢复。\n失败工具：${error.tool}\n错误：${error.message}\n已完成：${JSON.stringify(completed)}\n剩余：${JSON.stringify(remaining)}\n最新项目：${projectContextPrompt(userText)}`
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
                content: `${TOOLS_HINT}\n\n你现在处于同一个任务的第 ${round} 次观察。工具已经真实执行，项目状态已经改变。请对照原始任务逐项验收：\n- 需要写/改提示词：确认目标分镜字段已经具体、可拍、动态，不是静态模板。\n- 需要出图/视频：确认对应资产字段已经存在；如果提示词刚改导致旧资产失效，再生成一次。\n- 需要操控节点：使用 focus_node、run_node、sync_canvas 或对应的精确生成工具。\n- 目标已经完成：done=true 且 actions=[]，say 简洁报告实际完成内容。\n- 仍缺一步：done=false，只给下一小批必要动作。\n禁止重复已成功且未被后续修改失效的工具，禁止扩大原始请求范围，禁止把“建议用户自己点”冒充完成。`
              },
              {
                role: 'user',
                content: `原始任务：${userText}\n\n已执行动作：${JSON.stringify(completed)}\n执行结果：${JSON.stringify(observedResults)}\n\n最新画布与项目状态：\n${projectContextPrompt(userText)}`
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
      reply: `已暂停，没有继续污染下游。${ok ? `前面 ${ok} 步已保留。` : ''}\n失败位置：${TOOL_LABEL[failed?.tool || ''] || failed?.tool}\n原因：${failed?.detail || loop.error?.message}`,
      results,
      chips: [
        { label: '重试失败步骤', text: `重试${TOOL_LABEL[failed?.tool || ''] || '失败步骤'}` },
        { label: '检查配置', text: '帮我检查当前失败原因' }
      ]
    }
  }

  if (nodePath) {
    const fails = results.filter((r) => !r.ok)
    const failLine = fails.length
      ? `\n失败 ${fails.length} 项：${fails.map((f) => `${TOOL_LABEL[f.tool] || f.tool}：${f.detail}`).join('；')}`
      : ''
    return {
      reply: (loop.finalSay || plan.say || '搞定了，画布已更新。') + failLine,
      results,
      chips: statusChips(project.current)
    }
  }

  const wrap = wrapUpReply(results, baseText, plan.say)
  const qa = wantQa && project.current ? `\n${qaNotes(project.current)}` : ''
  return { reply: (loop.finalSay || wrap.reply) + qa, results, chips: wrap.chips }
}

const NODE_PATH_RULE = `这条需求属于「单个节点」操作。常用的是 create_image_node、create_video_node、connect_nodes、update_node、delete_node、arrange_canvas、check_project、optimize_node_prompt、run_node、focus_node、sync_canvas、remember、forget。除非用户明确要写剧本、拆人物场景分镜或做一整条片子，否则不要动 generate_play、extract_cast 这类流水线工具。用户没点名节点时，优先操作「用户当前选中的节点」。`

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
  const lines = [`**画布节点**：共 ${nodes.length} 个生成节点，${done} 个已有产出`]
  if (running) lines.push(`- ${running} 个正在生成`)
  if (failed.length) {
    lines.push(
      `- ${failed.length} 个失败：${failed
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
    return '**画布还是空的。** 直接在左边说一句话我就开工（例如「写一个修仙短剧，8 个分镜」），也可以在空白处右键手动添加图片 / 视频 / 剧本 / 角色 / 场景 / 分镜节点。'
  }
  return parts.join('\n\n')
}

function statusChips(p: Project | null | undefined): { label: string; text: string }[] {
  const chips: { label: string; text: string }[] = []
  const next = nextPipelineStep(p)
  if (next && (p?.shots.length || p?.script?.content?.trim())) {
    chips.push({ label: `继续：${next.label}`, text: '继续' })
  }
  const failed = (p?.canvas?.nodes ?? []).find(
    (n) => (n.type === 'imageGen' || n.type === 'videoGen') && (n.status === 'failed' || n.error)
  )
  if (failed) chips.push({ label: '重跑失败节点', text: `重新生成节点 ${failed.id}` })
  chips.push({ label: '帮我画一张图', text: '帮我创建一个图片节点并生成：' })
  chips.push({ label: '全流程', text: '全流程跑完' })
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
  onEvent({ kind: 'think', label: '在组织回答…' })
  const memoryText = await memoryContextPrompt()
  const chat = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `你是剧流 Studio（AI 短剧工作台）画布上的智能助手，精通 AI 短剧、AI 图片与视频制作流程、提示词写法。用户在创作过程中向你提问或求建议。
要求：
- 直接回答，不要假装执行了画布操作，不要输出 JSON。
- 结合给出的项目状态${memoryText ? '、用户记忆' : ''}作答，答得具体，别泛泛而谈。
- 口语化，可以分点，但别写成八股文。答完可以顺嘴提一个可行的下一步。
- 用 Markdown 排版：要点用「- 」列表，关键结论用 **加粗**，提示词 / 示例用三个反引号围起来的代码块，超过三个要点就用小标题分段。
- 正文控制在 500 字以内，能短就短。
${memoryText ? `\n${memoryText}` : ''}`
        },
        {
          role: 'user',
          content: `当前项目状态（仅供参考，不需要操作）：\n${projectContextPrompt(userText)}\n\n下面是用户本轮的提问与随附材料（附件 / 本地文件）。材料里的内容优先作为回答依据，不要要求用户重新粘贴：\n${userText}`
        },
        ...chat
      ],
      temperature: 0.5,
      maxTokens: 1200,
      signal: options.signal,
      timeoutMs: 90_000
    })
    const reply = resp.content.trim()
    if (!reply) throw new Error('模型没有返回内容')
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
    const runMatch = t.match(/(?:重新生成|生成|重跑|跑一下)\s*(?:节点)?\s*([a-zA-Z]+_\w+)/)
    if (runMatch) actions.push({ tool: 'run_node', nodeId: runMatch[1] })
    // 优化选中节点
    if (!actions.length && selectedNodeId && /优化|扩写|加厚|润色|更|再/.test(t)) {
      actions.push({ tool: 'optimize_node_prompt', nodeId: selectedNodeId, text: t })
    }
    // 体检 / 整理画布
    if (!actions.length && /检查|体检|看看有什么问题|哪里不对|齐了没|漏了/.test(t)) {
      actions.push({ tool: 'check_project' })
    }
    if (!actions.length && /整理|重排|排布|重新摆放|整理一下画布/.test(t)) {
      actions.push({ tool: 'arrange_canvas' })
    }
    // 删掉选中节点
    if (!actions.length && selectedNodeId && /删|去掉|移除/.test(t)) {
      actions.push({ tool: 'delete_node', nodeId: selectedNodeId })
    }
    // 新建节点（说「给这个节点加…」时自动挂到选中节点后面并连线）
    if (!actions.length && /视频/.test(t) && /新建|创建|做一?[个条]|来一?[个条]|加|接|连/.test(t)) {
      const dur = Number(t.match(/(\d{1,2})\s*秒/)?.[1] || 8)
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
      say: '直接说你想画什么、改哪个节点，我来动手。例如「创建一个修仙渡劫的视频节点，8 秒」或「把这个节点的提示词写得更具体」。',
      actions: []
    }
  }
  return { say: '按你这句做，不加别的步骤。', actions }
}

function continuePlan(p: Project): { say: string; actions: any[] } {
  const n = nextPipelineStep(p)
  if (!n) {
    return { say: '目前没有下一步了。要改某一镜，直接点画布节点重新生成。', actions: [] }
  }
  if (n.id === 'review') {
    const fake = { ...p, playApproved: true }
    const after = nextPipelineStep(fake)
    return {
      say: after ? `剧本算你看过了，接着做「${after.label}」。` : '剧本已确认。',
      actions: [{ tool: 'approve_play' }, ...(after?.tools ?? [])]
    }
  }
  return { say: `继续做「${n.label}」。`, actions: n.tools }
}

function clarifyChips(p: Project | null | undefined): { label: string; text: string }[] {
  if (!p?.script?.content?.trim()) {
    return [
      { label: '先拆剧本', text: '按我刚说的拆剧本' },
      { label: '全流程', text: '全流程跑完' }
    ]
  }
  if (!p.shots.length) {
    return [
      { label: '拆剧本', text: '拆剧本' },
      { label: '全流程', text: '全流程跑完' }
    ]
  }
  if (needsPlayReview(p)) return reviewChips()
  const n = nextPipelineStep(p)
  if (n) {
    return [
      { label: `继续：${n.label}`, text: '继续' },
      { label: '全流程', text: '全流程跑完' }
    ]
  }
  return []
}

function reviewChips() {
  return [
    { label: '确认通过', text: '确认通过' },
    { label: '继续往下', text: '继续' },
    { label: '全流程', text: '全流程跑完' }
  ]
}

function nextChips(next: PipelineStep | null): { label: string; text: string }[] {
  if (!next) return []
  return [
    { label: `继续：${next.label}`, text: '继续' },
    { label: '先看看', text: '先看看' },
    { label: '全流程', text: '全流程跑完' }
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
    ? `\n\n**失败 ${fail.length} 项**\n${fail
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
      reply: `**全流程跑完了。**${failLine || '\n\n画布上的节点都已更新。'}${
        next ? `\n\n还缺「${next.label}」，回「继续」我再补。` : ''
      }`,
      chips: nextChips(next)
    }
  }
  if (didContinue) {
    const hasShots = Boolean(p?.shots.length)
    return {
      reply: hasShots
        ? `**已顺着当前剧后续写**，原场次保留。\n\n- 新场还没进画布节点\n- 到「分镜关键帧」分组点重新提取，或回「重新提取分镜」${failLine}`
        : `**已顺着当前剧后续写**，原场次保留。\n\n- 看完可再改字\n- 回「继续」先拆人物（不会同时拆场景和分镜）${failLine}`,
      chips: hasShots
        ? [
            { label: '重新提取分镜', text: '重新提取分镜' },
            { label: '再续写', text: '续写剧本' },
            { label: '先看看', text: '先看看' }
          ]
        : [
            { label: '先拆人物', text: '继续' },
            { label: '再续写', text: '续写剧本' },
            { label: '先看看', text: '先看看' }
          ]
    }
  }
  if (didPlay && !(p?.shots.length)) {
    return {
      reply: `**完整剧本已经写到画布左侧**（还没拆节点）。

先确认三件事：

- 背景对不对
- 人物对不对
- 环境对不对

确认后回「继续」只拆人物；场景和分镜要再各走一步。说「全流程」会自动跑完。${failLine}`,
      chips: [
        { label: '先拆人物', text: '继续' },
        { label: '续写', text: '续写剧本' },
        { label: '先看看', text: '先看看' },
        { label: '全流程', text: '全流程跑完' }
      ]
    }
  }
  if (didBoard) {
    const n = p?.shots.length ?? 0
    const subjectCount = p?.subjects?.length ?? 0
    const sceneCount = p?.scenes?.length ?? 0
    if (!n && !sceneCount) {
      return {
        reply: `**第 1 步完成**：已提炼并保存 ${subjectCount} 个角色。没有同时运行场景和分镜。

- 确认人物没问题后，回「继续」再单独提炼场景${failLine}`,
        chips: [
          { label: '继续提炼场景', text: '继续' },
          { label: '先检查人物', text: '先看看人物' }
        ]
      }
    }
    if (!n) {
      return {
        reply: `**第 2 步完成**：已保留 ${subjectCount} 个角色，并保存 ${sceneCount} 个场景。

- 确认场景没问题后，回「继续」再单独拆分镜${failLine}`,
        chips: [
          { label: '继续拆分镜', text: '继续' },
          { label: '先检查场景', text: '先看看场景' }
        ]
      }
    }
    return {
      reply: `**第 3 步完成**：已拆出 ${n} 个分镜，并与现有角色和场景绑定。

- 先去画布看一遍
- 看完回「继续」做人设和场景；说「全流程」会自动跑完${failLine}`,
      chips: reviewChips()
    }
  }
  if (didApprove && !didCast && !didImg) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '剧本已确认。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didCast && !didImg) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '人设和场景已经出在画布上了。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didImg && !didVid) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '故事看板已经铺到画布上了。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didVid && !didAud) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '分镜视频已经生成。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didAud) {
    return { reply: `口播好了。可以点「合成视频」节点，结果会显示在视频预览里。${failLine}`, chips: [] }
  }
  const next = nextPipelineStep(p)
  return {
    reply: (fallbackSay || '这一步做完了。') + failLine + (next ? `\n${continueQuestion(next, '')}` : ''),
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

  const askedExtract = /提炼节点|提炼人物|提炼场景|拆节点|出节点|重新提取|重新提炼/.test(t)
  const askedContinuePlay = /续写|接着写|再写[一两三四\d]*场|加一场|往后写|续一[场段]|写下去/.test(t)
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
        say: PLAY_GATE_MSG,
        actions: []
      }
    }
    return {
      say: '你想让我做哪一步？可以说：写剧本、续写、提炼节点、确认通过、出人设、第1镜配图。说「全流程」才会整条跑。',
      actions: []
    }
  }
  if (newStory && !all) {
    return { say: '按你这轮说的新故事重写剧本，不再沿用旧稿。', actions }
  }
  if (askedExtract && !all) {
    return { say: '按完整剧本提炼人物、场景、分镜节点。', actions }
  }
  if (askedContinuePlay && !all) {
    return { say: '顺着当前剧本往后加场，已有场次和台词不动。', actions }
  }
  if ((askedPlay || askedBoard || looksLikeBrief) && !all) {
    return { say: '先写完整剧本，还不拆节点。写完看左侧，回「继续」再提炼。', actions }
  }
  return { say: '按你这句做，不加别的步骤。', actions }
}
