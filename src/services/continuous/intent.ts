import { callLLM } from '@/services/ai/client'
import { isDirectNodeShortcut } from '@/services/canvas/selectedText'
import { isCaptureApproval } from './model'

export type CaptureIntent = 'chat' | 'question' | 'status' | 'plan' | 'revise' | 'approve' | 'node'

const LABEL: Record<CaptureIntent, string> = {
  chat: '대화',
  question: '질문',
  status: '진행 상황',
  plan: '연속 촬영 계획 세우기',
  revise: '촬영 계획 수정',
  approve: '이어서 진행',
  node: '선택한 노드 수정'
}

export function captureIntentLabel(kind: CaptureIntent): string {
  return LABEL[kind]
}

/** 선택한 영상의 끝 프레임을 저장하는 요청을 감지한다. */
export function isLastFrameGrab(text: string): boolean {
  const t = text.trim()
  if (!t || /继续拍|接着拍|往下拍|开拍|重新规划|이어서 촬영|촬영 시작|다시 계획/.test(t)) return false
  return /最后一帧|尾帧|末帧|마지막 프레임|끝 프레임/.test(t) && /截|提|取|导|存|做成|出一张|来一张|帮我|要一张|추출|저장|캡처|뽑아|이미지로/.test(t)
}

function ruleIntent(text: string, hasPlan: boolean, hasScriptPaste: boolean): CaptureIntent | null {
  const t = text.trim()
  if (!t) return 'chat'
  if (isDirectNodeShortcut(t)) return 'node'
  if (t === '确认重新提交' || isCaptureApproval(t)) return 'approve'
  if (/^(?:重新规划|다시 계획|계획 다시)/.test(t)) return 'revise'
  if (/从头开始拍|从头拍|指定开始拍|指定开拍/.test(t)) return hasPlan ? 'approve' : 'plan'
  if (/^(?:你好|您好|嗨|hi|hello|hey|在吗|在不在|谢谢|谢了|辛苦了?|哈哈+|嗯+|哦+|你是谁|你能干什么|你能做什么)[\s!！。.~～?？]*$/i.test(t)) return 'chat'
  if (/不要继续|不要开始|先别|等一下|等会儿|暂停|不用了|先别拍|하지 마|잠깐|기다려|일시 정지/.test(t)) return 'chat'
  if (/进度|做到哪|还差|缺什么|现在什么情况|什么进度|진행 상황|어디까지|뭐가 남았/.test(t)) return 'status'
  if (/多久|几分钟|多少秒|多少个镜头|多少场|要什么资产|需要什么|要拍什么/.test(t)) return hasPlan ? 'status' : 'question'
  if (/[吗呢？?]$/.test(t) && !/生成|开始|继续|规划|开拍/.test(t)) return 'question'
  if (hasPlan && /改计划|改场次|重排整场|重拆剧本|重做计划/.test(t)) return 'revise'
  if (!hasPlan && (hasScriptPaste || /分析|规划|制定|连续拍/.test(t) || t === '开始')) return 'plan'
  if (hasPlan && /分析剧本|看下计划|当前计划/.test(t)) return 'status'
  return null
}

export async function detectCaptureIntent(text: string, hasPlan: boolean, hasScriptPaste: boolean, signal?: AbortSignal, hasSelection = false): Promise<CaptureIntent> {
  const ruled = ruleIntent(text, hasPlan, hasScriptPaste)
  if (ruled) return ruled === 'node' && !hasSelection ? 'question' : ruled
  try {
    const resp = await callLLM({
      signal,
      temperature: 0,
      disableThinking: true,
      jsonMode: true,
      maxTokens: 40,
      timeoutMs: 20_000,
      messages: [
        {
          role: 'system',
          content: `Classify intent in continuous capture mode. Return only JSON: {"kind":"chat|question|status|plan|revise|approve|node"}.
Use the request's meaning. Use chat for greetings, thanks, or requests to wait or stop. Use question for explanations or uncertainty. Use status for progress, missing items, or expected running time. Use plan when no plan exists and the user asks to analyze the script, arrange the scene, or begin continuous capture. Use revise only when an existing plan needs an explicit scene-wide or project-wide change. Use approve when an existing plan is ready and the user explicitly asks to begin, resume, restart, or start from a specified point. Use node only when a node is selected and the user asks to edit this shot, align its timing, refine its action or acting, or continue from its end frame. Merely asking a question, capturing the final frame, or editing a node does not approve or revise the plan.`
        },
        { role: 'user', content: `Plan exists: ${hasPlan}. Canvas node selected: ${hasSelection}.\nUser message:\n${text}` }
      ]
    })
    const matched = String(resp.content || '').match(/"kind"\s*:\s*"(chat|question|status|plan|revise|approve|node)"/)
    if (matched) {
      const kind = matched[1] as CaptureIntent
      return kind === 'node' && !hasSelection ? 'question' : kind
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return 'question'
}
