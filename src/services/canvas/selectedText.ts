import { callLLM } from '@/services/ai/client'
import { useProjectStore } from '@/stores'
import type { CanvasNode } from '@/types'

export function isCanvasTextNode(node?: CanvasNode | null): boolean {
  return node?.type === 'script' || node?.type === 'captureText'
}

const NODE_SHORTCUTS = new Set([
  '구도와 조명, 질감, 분위기를 구체화하고 원래 형식을 유지해 주세요.',
  '표정, 손과 몸의 움직임을 구체화하고 원래 형식을 유지해 주세요.',
  '대본을 참고해 이 샷의 사건만 적고 원래 형식을 유지해 주세요.',
  '이 노드의 끝 프레임에서 이어서 촬영해 주세요.',
  '用这个节点最后一帧继续往下拍'
])

/** 선택한 노드 위의 빠른 작업이다. 이 노드만 수정하고 장면 전체를 다시 나누지 않는다. */
export function isDirectNodeShortcut(text: string): boolean {
  return NODE_SHORTCUTS.has(text.trim())
}

/** 대본이나 스토리보드 텍스트를 선택한 상태에서 요청하면 해당 텍스트만 수정한다. */
export function isSelectedTextEdit(text: string, node?: CanvasNode | null): boolean {
  if (!isCanvasTextNode(node)) return false
  const t = text.trim()
  if (!t || /^(?:继续|确认|开始拍摄|分析剧本|계속|확인|촬영 시작|대본 분석)/.test(t) || /^(?:重新规划|다시 계획)/.test(t)) return false
  if (/节点|下载|合成|截取|参考图|生图|生成视频|生成图片|노드|다운로드|합성|추출|참조 이미지|영상 생성|이미지 생성/.test(t) && !/这段|这段文字|剧本|正文|台词|选中的文|이 텍스트|대본|본문|대사|선택한 문장/.test(t)) return false
  return /改|润色|缩短|加长|重写|修改|换个|写得|改成|删掉|补上|调整|扩写|수정|다듬|짧게|길게|다시 써|늘려|줄여|구체화/.test(t)
}

export async function editSelectedCanvasText(text: string, node: CanvasNode, signal?: AbortSignal): Promise<string> {
  const project = useProjectStore()
  const current = project.current
  if (!current) throw new Error('프로젝트를 먼저 열어 주세요.')
  const source = node.type === 'script' ? current.script?.content || '' : node.data.prompt || ''
  if (!source.trim()) throw new Error('선택한 텍스트가 비어 있어요.')
  const resp = await callLLM({
    signal,
    temperature: 0.4,
    disableThinking: true,
    timeoutMs: 120_000,
    messages: [
      {
        role: 'system',
        content: 'Edit only the passage the user selected. Return only its full revised text, with no explanation, enclosing quotation marks or title. Preserve names, dialogue and facts unless the user asks to change them. Match the passage’s language. Use natural Korean for new user-facing prose.'
      },
      { role: 'user', content: `Requested edit:${text}\n\nSource:\n${source}` }
    ]
  })
  const next = String(resp.content || '').trim()
  if (!next) throw new Error('수정한 내용을 받지 못했어요.')
  if (node.type === 'script') {
    if (!current.script) throw new Error('프로젝트에 대본이 없어요.')
    project.setScript({ ...current.script, content: next })
  } else {
    project.setCanvasNodePrompt(node.id, next)
  }
  await project.save()
  return '선택한 텍스트를 요청에 맞게 수정했어요.'
}

/** 빠른 작업이나 현재 샷 수정 요청은 선택한 노드에만 적용하고 대본을 다시 나누거나 생성을 요청하지 않는다. */
export async function runSelectedNodeShortcut(
  text: string,
  node: CanvasNode,
  signal?: AbortSignal,
  onLog?: (message: string) => void
): Promise<string> {
  const request = text.trim()
  if (/最后一帧|末帧|尾帧|마지막 프레임|끝 프레임/.test(request) && /续|继续|往下|接着|이어|계속/.test(request)) {
    const { createTailContinuation } = await import('./agentMedia')
    return createTailContinuation(node.id, 'Continue the action from this shot’s actual last frame. Preserve all existing shots and their script.', signal, onLog)
  }
  if (node.type === 'script' || node.type === 'captureText') {
    return editSelectedCanvasText(request, node, signal)
  }
  if (node.type !== 'imageGen' && node.type !== 'videoGen') {
    throw new Error('수정할 이미지, 영상 또는 스토리보드 텍스트를 선택하세요.')
  }
  const project = useProjectStore()
  const { optimizeNodePrompt } = await import('@/services/ai/promptCoach')
  onLog?.(`‘${node.data.label || '현재 노드'}’ 수정 중…`)
  const result = await optimizeNodePrompt(
    {
      kind: node.type === 'videoGen' ? 'video' : 'image',
      nodeLabel: `${node.data.label || node.id} · ${node.type === 'videoGen' ? '이미지로 영상 만들기' : '이미지 생성'}`,
      currentPrompt: node.data.prompt || '',
      userHint: request,
      script: project.current?.script?.content || '',
      duration: node.data.duration,
      signal
    },
    onLog
  )
  project.setCanvasNodePrompt(node.id, result.prompt)
  await project.save()
  return `${result.note} ‘${node.data.label || '현재 노드'}’에 프롬프트를 저장했어요.\n\n${result.prompt}`
}
