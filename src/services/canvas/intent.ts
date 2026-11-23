/**
 * 意图识别：在任务规划之前先判断用户这句话想干什么。
 * 正式模式（real）下全部交给 LLM 分类，不用任何正则/关键词规则；
 * 只有演示模式（没配语言模型）才退回 detectIntent 这套规则兜底。
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
  | 'remember' // 要求记住偏好 / 事实
  | 'forget' // 要求忘掉某条记忆
  | 'question' // 问答咨询，不动画布
  | 'status' // 查询项目进度 / 检查缺漏
  | 'prompt_polish' // 加厚 / 改写提示词
  | 'create_asset' // 新建自由图片 / 视频节点
  | 'edit_canvas' // 修改现有节点或分镜
  | 'pipeline' // 剧本流水线推进
  | 'chitchat'
  | 'task' // 其他需要工具的任务

export interface AgentIntent {
  kind: AgentIntentKind
  /** 展示在界面上的短标签 */
  label: string
  /** 是否需要进入任务规划 / 工具循环 */
  needsTools: boolean
  confidence: 'high' | 'low'
}

export interface IntentContext {
  /** 项目里是否已有剧本 / 人物 / 场景 / 分镜（不再区分画布模式） */
  hasPipeline: boolean
  project: Project | null
  hasSelectedGenNode: boolean
}

const INTENT_LABEL: Record<AgentIntentKind, string> = {
  remember: '记住这个',
  forget: '删除记忆',
  question: '问答咨询',
  status: '查看进度',
  prompt_polish: '优化提示词',
  create_asset: '创建生成节点',
  edit_canvas: '修改画布',
  pipeline: '推进制作',
  chitchat: '闲聊',
  task: '执行任务'
}

function intent(kind: AgentIntentKind, confidence: 'high' | 'low' = 'high'): AgentIntent {
  const needsTools =
    kind === 'prompt_polish' ||
    kind === 'create_asset' ||
    kind === 'edit_canvas' ||
    kind === 'pipeline' ||
    kind === 'task'
  return { kind, label: INTENT_LABEL[kind], needsTools, confidence }
}

/** 工具类关键词：命中即说明用户想动画布，不是纯问答 */
const ACTION_HINT =
  /写|续写|改编|拆|提炼|提取|生成|出图|配图|出视频|做|改|换|重跑|重新|创建|新建|加一|补|跑|优化|扩写|加厚|删除|去掉|全流程|确认通过|继续|开始/

export function detectIntent(text: string, ctx: IntentContext): AgentIntent {
  const t = text.trim()
  if (!t) return intent('chitchat')

  // 1. 记忆指令优先
  if (parseRememberRequest(t)) return intent('remember')
  if (parseForgetRequest(t)) return intent('forget')

  // 1.5 指向本地路径的读取 / 查看请求 → 读材料问答，绝不能推进制作。
  // 「把 X 拆成分镜」这类带明确制作动作的不在此列，交给后面的流水线判断。
  if (/[A-Za-z]:[\\/]/.test(t) && /读|打开|看看|看一?下|瞅|瞄|查看|加载|载入/.test(t) && !ACTION_HINT.test(t)) {
    return intent('question')
  }
  // 任何含本地盘符路径的消息都不是「新故事梗概」，别被长度兜底误判成写剧本
  if (/[A-Za-z]:[\\/]/.test(t) && !ACTION_HINT.test(t)) return intent('question', 'low')

  // 2. 进度查询 / 质检
  if (/进度|状态|还差|缺什么|缺了|齐了没|检查一遍|质检|验收清单|现在.*(?:情况|进展)|做到哪/.test(t)) {
    return intent('status')
  }

  // 3. 显式流水线指令
  if (isFullPipelineRequest(t) || isContinueRequest(t) || isApprovePlayRequest(t)) {
    return intent('pipeline')
  }
  if (isNewStoryBrief(t, ctx.project)) return intent('pipeline')
  if (
    /剧本|短剧|剧集|微剧|故事|写剧|完整剧本|续写|接着写|拆分镜|拆镜|故事板|出分镜|拆剧本|提炼|提取节点|人设|四视图|场景图|底板|故事看板|口播|配音/.test(t)
  ) {
    // 明确的流水线指令：不管画布现在有没有东西，都按流水线走
    return intent('pipeline')
  }

  // 4. 提示词优化
  if (/优化|扩写|加厚|润色|改写|重写/.test(t) && /提示词|prompt|画面|运镜|文案|这段|这句|节点/i.test(t)) {
    return intent('prompt_polish')
  }
  if (ctx.hasSelectedGenNode && /更有画面感|写清|动作|表情|暗一点|亮一点|按剧情|更具体|再细/.test(t)) {
    return intent('prompt_polish')
  }

  // 5. 新建自由节点
  if (/新建|创建|加一?个|来一个|帮我做一?[个张条]/.test(t) && /图片|图像|视频|节点|画面/.test(t)) {
    return intent('create_asset')
  }

  // 6. 修改画布现有内容
  if (/第\s*[\d一二两三四五六七八九十]+\s*镜/.test(t) && ACTION_HINT.test(t)) {
    return intent('edit_canvas')
  }
  if (/把|将|改/.test(t) && /节点|提示词|分镜|时长|比例|运镜/.test(t) && ACTION_HINT.test(t)) {
    return intent('edit_canvas')
  }

  // 7. 纯问答：带疑问词且不含动作词
  const looksQuestion =
    /[吗呢吧？?]$/.test(t) ||
    /^(?:什么是|怎么|为什么|为啥|能不能|可不可以|你会|你认识|介绍一下|解释一下|讲讲|告诉我)/.test(t) ||
    /你能做什么|你会什么|你是谁|有什么功能|怎么用/.test(t) ||
    /(?:是|讲的?是|说的?是|里面(?:是|有))啥|什么意思|啥意思|是什么意思|什么内容|内容是什么|里面有什么|讲了什么|说了什么/.test(t)
  if (looksQuestion && !ACTION_HINT.test(t)) {
    return intent('question')
  }

  // 8. 兜底：含动作词交给任务规划，否则当闲聊/咨询交给 LLM 自由回答
  if (ACTION_HINT.test(t)) return intent('task', 'low')
  if (t.length >= 12) return intent('question', 'low')
  return intent('chitchat')
}

/** LLM 意图分类的系统提示：只输出 kind，不承担任何任务执行 */
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
    return (Object.keys(INTENT_LABEL) as AgentIntentKind[]).includes(kind as AgentIntentKind)
      ? (kind as AgentIntentKind)
      : null
  } catch {
    return null
  }
}

/** 正式模式的意图识别：LLM 分类，不用正则。模型没接通或调用失败时把错误抛回去，不用固定文案顶上。 */
async function detectIntentWithLlm(
  text: string,
  ctx: IntentContext,
  signal?: AbortSignal
): Promise<AgentIntent> {
  const p = ctx.project
  const state = [
    p?.script?.content?.trim() ? '有剧本' : '无剧本',
    (p?.shots?.length ?? 0) > 0 ? `有${p!.shots.length}个分镜` : '无分镜',
    ctx.hasSelectedGenNode ? '画布上选中了一个生成节点' : '没有选中节点'
  ].join('，')
  const resp = await callLLM({
    messages: [
      { role: 'system', content: INTENT_LLM_SYSTEM },
      {
        role: 'user',
        content: `项目当前状态：${state}\n\n用户消息：\n${text}`
      }
    ],
    temperature: 0,
    jsonMode: true,
    maxTokens: 60,
    signal,
    timeoutMs: 30_000
  })
  const kind = parseIntentJson(resp.content || '')
  if (kind) return intent(kind)
  return intent('question', 'low')
}

/**
 * 意图识别入口：正式模式（real）全走 LLM；
 * 演示模式（没配语言模型）退回规则版 detectIntent 兜底。
 */
export async function detectIntentSmart(
  text: string,
  ctx: IntentContext,
  signal?: AbortSignal
): Promise<AgentIntent> {
  if (getAIMode() === 'real') return detectIntentWithLlm(text, ctx, signal)
  return detectIntent(text, ctx)
}
