import type { Project } from '@/types'

const PIPELINE_CMD =
  /^(继续|下一步|先看看|确认通过|验收|提炼节点|重新提炼|续写|全流程|전체\s*과정|계속(?:해)?|다음 단계|먼저 보여 줘|대본 승인|샷.*추출|이어 쓰|continue|next step|show progress|approve|extract shots)|第\s*\d+\s*镜|出人设|出图|配图|生成视频|口播|\bshot\s+\d+\b|\d+번 샷|이미지 생성|영상 생성|내레이션/i

const GENERIC_TOKEN =
  /^(故事|剧本|动漫|短片|主题|主角|女主|男主|人物|场景|风格|画面|镜头|时长|分钟|怎么样|可以|一个|自行|设计|网络|热梗|需要|肯定|我们|这个|那个|什么|创作|帮我|来一个|拍一个|写一个|要用|加上|不要|必须|大概|至少|搞笑|幽默|이야기|대본|캐릭터|장면|스타일|story|script|character|scene|style)$/i

export function isPipelineCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (PIPELINE_CMD.test(t) && t.length < 24) return true
  if (/^(续写|提炼节点|重新写剧本|确认通过|全流程跑完|이어 쓰기|샷 추출|대본 다시 쓰기|대본 승인|continue|extract shots|rewrite script|approve)([。.!！ ]*)$/i.test(t)) return true
  return false
}

export function topicFromBrief(text: string): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const first = t.split(/[。！？!?\n]/)[0]?.trim() || t
  return first.slice(0, 32)
}

/** 프로젝트 제목은 대본의 짧은 제목을 우선하고, 없으면 본문의 첫 1단계 제목을 사용한다. */
export function playTitleOf(source: { topic?: string; content?: string } | null | undefined): string {
  const heading = (source?.content || '').match(/^#\s+(.+)\s*$/m)?.[1]?.trim() || ''
  const topic = (source?.topic || '').replace(/\s+/g, ' ').trim()
  return (topic || heading).replace(/\s+/g, ' ').trim().slice(0, 48)
}

function contentTokens(text: string): string[] {
  const raw = [...(text || '').matchAll(/[\u4e00-\u9fff]{2,6}/g)].map((m) => m[0])
  const out: string[] = []
  for (const w of raw) {
    if (GENERIC_TOKEN.test(w)) continue
    if (!out.includes(w)) out.push(w)
  }
  return out
}

function playFingerprint(p: Project | null | undefined): string {
  if (!p) return ''
  const names = [
    ...(p.subjects ?? []).map((s) => s.name),
    ...(p.scenes ?? []).map((s) => s.name)
  ]
  return [p.name, p.script?.topic, (p.script?.content || '').slice(0, 800), ...names]
    .filter(Boolean)
    .join(' ')
}

/** 새 이야기 요청과 기존 대본에 대한 제작 작업을 구분한다. */
export function isNewStoryBrief(text: string, p?: Project | null): boolean {
  const t = text.trim()
  if (t.length < 12) return false
  // 드라이브 경로가 포함된 요청은 길이에 관계없이 파일 작업으로 처리한다.
  if (/[A-Za-z]:[\\/]/.test(t)) return false
  if (isPipelineCommand(t)) return false
  if (/续写|接着写|再写[一两三四\d]*场|提炼节点|确认通过|第\s*\d+\s*镜|이어 쓰|샷 추출|대본 승인|continue|extract shots|approve/i.test(t) && t.length < 40) {
    return false
  }
  const creative =
    t.length >= 16 &&
    /故事|剧本|动漫|短片|主题|修仙|穿越|都市|创作|拍一|写一|帮我写|来一个|炼丹|女主|3D|Q版|이야기|대본|애니메이션|숏드라마|주인공|선협|창작|써 줘|story|script|anime|short film|protagonist|write a/i.test(t)
  if (!creative && t.length < 40) return false
  if (!p?.script?.playReady) return creative || t.length >= 40

  const keys = contentTokens(t)
  if (keys.length < 2) return creative
  const fp = playFingerprint(p)
  const hits = keys.filter((w) => fp.includes(w))
  return hits.length === 0
}

export function collectStoryBrief(history: Array<{ role: string; content: string }>, userText: string): string {
  const users = history
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim())
    .filter(Boolean)
  const last = userText.trim()
  const list = [...users]
  if (last && list[list.length - 1] !== last) list.push(last)
  return [...new Set(list)].slice(-4).join('\n')
}
