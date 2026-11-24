import { t as translate } from "@/i18n"
/**
 * 작업을 계획하기 전에 사용자 요청의 의도를 파악한다.
 * 실제 모드에서는 언어 모델이 의도를 분류한다.
 * 언어 모델을 설정하지 않은 데모 모드에서는 detectIntent 규칙을 사용한다.
 */
import type { Project } from '@/types'
import { callLLM, getAIMode } from '@/services/ai/client'
import {
  isApprovePlayRequest,
  isFullPipelineRequest
} from './playGate'
import { isContinueRequest } from './pipeline'
import { isNewStoryBrief } from '@/utils/storyBrief'
import { parseForgetRequest, parseRememberRequest } from '@/services/memory/memoryStore'

export type AgentIntentKind =
  | 'remember' // 선호 또는 사실을 저장한다.
  | 'forget' // 기억 항목을 삭제한다.
  | 'question' // 캔버스를 바꾸지 않고 질문에 답한다.
  | 'status' // 진행 상황이나 누락을 확인한다.
  | 'prompt_polish' // 프롬프트를 보완하거나 다시 작성한다.
  | 'create_asset' // 자유 이미지 또는 영상 노드를 만든다.
  | 'edit_canvas' // 기존 노드나 스토리보드를 수정한다.
  | 'pipeline' // 대본 워크플로를 진행한다.
  | 'chitchat'
  | 'task' // 도구가 필요한 기타 작업

export interface AgentIntent {
  kind: AgentIntentKind
  /** 화면에 표시하는 짧은 라벨 */
  label: string
  /** 작업 계획과 도구 실행이 필요한지 나타낸다. */
  needsTools: boolean
  confidence: 'high' | 'low'
}

export interface IntentContext {
  /** 프로젝트에 대본, 캐릭터, 장면 또는 스토리보드가 있는지 나타낸다. */
  hasPipeline: boolean
  project: Project | null
  hasSelectedGenNode: boolean
}

const INTENT_KINDS: AgentIntentKind[] = [
  'remember',
  'forget',
  'question',
  'status',
  'prompt_polish',
  'create_asset',
  'edit_canvas',
  'pipeline',
  'chitchat',
  'task',
]

function intent(kind: AgentIntentKind, confidence: 'high' | 'low' = 'high'): AgentIntent {
  const needsTools =
    kind === 'prompt_polish' ||
    kind === 'create_asset' ||
    kind === 'edit_canvas' ||
    kind === 'pipeline' ||
    kind === 'task'
  return { kind, label: translate(`canvasIntent.${kind}`), needsTools, confidence }
}

/** 캔버스 변경을 요청했는지 판별하는 작업 키워드 */
const ACTION_HINT =
  /写|续写|改编|拆|提炼|提取|生成|出图|配图|出视频|做|改|换|重跑|重新|创建|新建|加一|补|跑|优化|扩写|加厚|删除|去掉|全流程|确认通过|继续|开始|작성해|생성해|수정해|바꿔|삭제해|계속해|시작해|\b(?:write|generate|edit|change|remove|continue|start)\b/i

export function detectIntent(text: string, ctx: IntentContext): AgentIntent {
  const t = text.trim()
  if (!t) return intent('chitchat')

  // 기억 요청을 먼저 확인한다.
  if (parseRememberRequest(t)) return intent('remember')
  if (parseForgetRequest(t)) return intent('forget')

  // 로컬 경로의 자료를 읽어 달라는 요청은 질문으로 처리한다.
  // 명시적으로 자료를 스토리보드로 만들라는 요청은 아래의 워크플로 규칙을 적용한다.
  if (/[A-Za-z]:[\\/]/.test(t) && /读|打开|看看|看一?下|瞅|瞄|查看|加载|载入/.test(t) && !ACTION_HINT.test(t)) {
    return intent('question')
  }
  // 로컬 드라이브 경로가 있는 요청을 새 이야기 줄거리로 해석하지 않는다.
  if (/[A-Za-z]:[\\/]/.test(t) && !ACTION_HINT.test(t)) return intent('question', 'low')

  // 진행 상황 및 품질 검수 요청
  if (/进度|状态|还差|缺什么|缺了|齐了没|检查一遍|质检|验收清单|现在.*(?:情况|进展)|做到哪|진행 상황|완료 상태|뭐가 남|누락 확인|검수|\b(?:progress|status|what(?:'s| is) missing|quality check)\b/.test(t)) {
    return intent('status')
  }

  // 명시적인 워크플로 요청
  if (isFullPipelineRequest(t) || isContinueRequest(t) || isApprovePlayRequest(t)) {
    return intent('pipeline')
  }
  if (isNewStoryBrief(t, ctx.project)) return intent('pipeline')
  if (
    /剧本|短剧|剧集|微剧|故事|写剧|完整剧本|续写|接着写|拆分镜|拆镜|故事板|出分镜|拆剧本|提炼|提取节点|人设|四视图|场景图|底板|故事看板|口播|配音|대본(?:을)?\s*(?:쓰|써|작성)|스토리보드\s*(?:추출|만들|생성)|\b(?:write|rewrite) (?:a |the )?(?:script|screenplay)\b|\bgenerate (?:a |the )?storyboard\b/i.test(t)
  ) {
    // 명확한 워크플로 요청은 현재 캔버스 상태와 관계없이 처리한다.
    return intent('pipeline')
  }

  // 프롬프트 최적화
  if (/优化|扩写|加厚|润色|改写|重写|최적화|다듬|구체화|확장|\b(?:polish|refine|expand|rewrite)\b/i.test(t) && /提示词|prompt|画面|运镜|文案|这段|这句|节点|프롬프트|노드|화면|카메라 움직임/i.test(t)) {
    return intent('prompt_polish')
  }
  if (ctx.hasSelectedGenNode && /更有画面感|写清|动作|表情|暗一点|亮一点|按剧情|更具体|再细/.test(t)) {
    return intent('prompt_polish')
  }

  // 자유 생성 노드 추가
  if (/新建|创建|加一?个|来一个|帮我做一?[个张条]|새로 만들|새 노드|추가해|\b(?:create|add|make)\b/i.test(t) && /图片|图像|视频|节点|画面|이미지|영상|노드|\b(?:image|video|node)\b/i.test(t)) {
    return intent('create_asset')
  }

  // 기존 캔버스 내용 수정
  if (/(?:第\s*[\d一二两三四五六七八九十]+\s*镜|\d+\s*번\s*샷|\bshot\s+\d+\b)/i.test(t) && ACTION_HINT.test(t)) {
    return intent('edit_canvas')
  }
  if (/把|将|改/.test(t) && /节点|提示词|分镜|时长|比例|运镜/.test(t) && ACTION_HINT.test(t)) {
    return intent('edit_canvas')
  }

  // 작업을 요청하지 않는 질문
  const looksQuestion =
    /[吗呢吧？?]$/.test(t) ||
    /^(?:什么是|怎么|为什么|为啥|能不能|可不可以|你会|你认识|介绍一下|解释一下|讲讲|告诉我)/.test(t) ||
    /你能做什么|你会什么|你是谁|有什么功能|怎么用|어떻게 쓰|뭘 할 수|무슨 뜻|\b(?:what can you do|how do I use|what does .+ mean)\b/i.test(t) ||
    /(?:是|讲的?是|说的?是|里面(?:是|有))啥|什么意思|啥意思|是什么意思|什么内容|内容是什么|里面有什么|讲了什么|说了什么/.test(t)
  if (looksQuestion && !ACTION_HINT.test(t)) {
    return intent('question')
  }

  // 작업 키워드가 있으면 계획을 작성한다. 그 외에는 대화나 질문으로 처리한다.
  if (ACTION_HINT.test(t)) return intent('task', 'low')
  if (t.length >= 12) return intent('question', 'low')
  return intent('chitchat')
}

/** 의도 분류 프롬프트는 kind만 반환한다. 작업은 실행하지 않는다. */
// 사용자 의도를 분류하고 기존 kind 값만 반환한다.
const INTENT_LLM_SYSTEM = `You classify the user's intent in the Studio canvas. Return the category only. Do not carry out the task or answer the user.

Choose one category:
- remember: remember a preference or fact, such as "기억해 줘" or "앞으로는"
- forget: forget or delete a memory
- question: answer a question, give advice, or read a file without changing the canvas
- status: report project progress, find gaps, or review results
- prompt_polish: expand, improve, or rewrite a prompt, picture description, or camera direction
- create_asset: create an image or video generation node and run it
- edit_canvas: update an existing canvas node or storyboard shot, including prompt, duration, aspect ratio, or camera movement
- pipeline: advance script production, including writing or continuing a script, extraction, storyboard generation, a next step, a full workflow, or approval
- chitchat: greetings, small talk, or pausing the task
- task: another task that requires canvas tools

Decision rules:
- If the user supplies a local path such as C:// and asks to read it, choose question.
- If the project contains a script or storyboard and the user only says "계속" or "다음 단계", choose pipeline.
- If a node is selected and the user asks for more vivid or concrete details, choose prompt_polish.
- If uncertain, choose question.

Return JSON only: {"kind":"one category identifier above"}`

function parseIntentJson(raw: string): AgentIntentKind | null {
  let s = raw.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim()
  }
  const from = s.indexOf('{')
  const to = s.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  try {
    const kind = String(JSON.parse(s.slice(from, to + 1))?.kind || '').trim()
    return INTENT_KINDS.includes(kind as AgentIntentKind)
      ? (kind as AgentIntentKind)
      : null
  } catch {
    return null
  }
}

/** 실제 모드에서는 모델이 의도를 분류하며 설정 또는 호출 오류는 호출자에게 전달한다. */
async function detectIntentWithLlm(
  text: string,
  ctx: IntentContext,
  signal?: AbortSignal
): Promise<AgentIntent> {
  const p = ctx.project
  const state = [
    p?.script?.content?.trim() ? 'screenplay available' : 'no screenplay',
    (p?.shots?.length ?? 0) > 0 ? `${p!.shots.length} storyboard shots` : 'no storyboard shots',
    ctx.hasSelectedGenNode ? 'a generation node is selected' : 'no selected node'
  ].join('，')
  const resp = await callLLM({
    messages: [
      { role: 'system', content: INTENT_LLM_SYSTEM },
      {
        role: 'user',
        content: `Current project state: ${state}\n\nUser message:\n${text}`
      }
    ],
    temperature: 0,
    jsonMode: true,
    maxTokens: 60,
    signal,
    timeoutMs: 300_000
  })
  const kind = parseIntentJson(resp.content || '')
  if (kind) return intent(kind)
  return intent('question', 'low')
}

/**
 * 실제 모드에서는 모델로 의도를 파악한다.
 * 언어 모델이 없는 데모 모드에서는 detectIntent 규칙을 사용한다.
 */
export async function detectIntentSmart(
  text: string,
  ctx: IntentContext,
  signal?: AbortSignal
): Promise<AgentIntent> {
  if (getAIMode() === 'real') return detectIntentWithLlm(text, ctx, signal)
  return detectIntent(text, ctx)
}
