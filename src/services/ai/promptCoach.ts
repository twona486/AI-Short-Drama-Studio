/**
 * 이미지→영상画布：按用户原文扩写节点提示词，补画面层次，不另起故事，不改格式。
 */
import { callLLM, getAIMode } from './client'
import { parseJsonRobust, stripModelWrappers } from '@/utils/jsonRepair'

export type PromptCoachKind = 'image' | 'video'

export interface OptimizeNodePromptInput {
  kind: PromptCoachKind
  nodeLabel: string
  currentPrompt: string
  userHint?: string
  script?: string
  duration?: number
  signal?: AbortSignal
}

export interface OptimizeNodePromptResult {
  prompt: string
  note: string
}

const H3_HEADINGS =
  /(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music|\bdialogue)\s*:/i

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 原文里必须原样留下的标题、节拍和指代。 */
export function extractFormatAnchors(text: string): string[] {
  const t = String(text || '')
  const anchors: string[] = []
  for (const m of t.matchAll(
    /(?:^|\n)\s*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music|dialogue)\s*:/gi
  )) {
    anchors.push(`${m[1]}:`)
  }
  for (const m of t.matchAll(/(?:^|\n)\s*(画面|镜头|声音|对白|台词|运镜|参考图)[：:]/g)) {
    anchors.push(m[1])
  }
  for (const m of t.matchAll(/\[Shot\s*[^\]]+\]/gi)) anchors.push(m[0])
  for (const m of t.matchAll(/\d+\.\d{2}\s*[-–—to]+\s*\d+\.\d{2}/gi)) anchors.push(m[0])
  for (const m of t.matchAll(/图\s*\d+\s*=/g)) anchors.push(m[0].replace(/\s+/g, ''))
  return unique(anchors)
}

function normalizeForAnchor(text: string): string {
  return text.replace(/\s+/g, '').replace(/[–—−]/g, '-').toLowerCase()
}

function hasAnchor(text: string, anchor: string): boolean {
  if (normalizeForAnchor(text).includes(normalizeForAnchor(anchor))) return true
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
  return new RegExp(escaped, 'i').test(text)
}

function formatBreakReason(original: string, next: string): string | null {
  const origAnchors = extractFormatAnchors(original)
  if (!origAnchors.length) {
    if (H3_HEADINGS.test(next) && !H3_HEADINGS.test(original)) {
      return '프롬프트를 확장하면서 원문의 섹션 구조가 바뀌었습니다.'
    }
    return null
  }
  const missing = origAnchors.filter((anchor) => !hasAnchor(next, anchor))
  if (missing.length) return `프롬프트 확장 중 원문의 표식이 사라졌습니다. ${missing.slice(0, 8).join('、')}`
  return null
}

function isReasoningDump(text: string): boolean {
  const t = String(text || '')
  if (t.length < 40) return false
  const hits = [
    /需要判断/,
    /需要输出\s*JSON/,
    /需要遵守输出JSON/,
    /系统规则/,
    /需要权衡/,
    /我们应保留/,
    /用户当前提示词是/,
    /用户原文若已是/,
    /只输出 JSON/,
    /评估者/,
    /这里用户当前提示词/
  ].filter((re) => re.test(t)).length
  return hits >= 2
}

function mockExpand(input: OptimizeNodePromptInput): OptimizeNodePromptResult {
  const base = input.currentPrompt.trim()
  if (!base) {
    return {
      prompt: input.kind === 'video' ? '一条连续镜头。写清谁在做什么、光从哪来。' : '一张能看清主体和光线的静帧。',
      note: '데모 모드입니다. 원문이 비어 있어 임시 문구를 넣었습니다.'
    }
  }
  return { prompt: base, note: '데모 모드입니다. 원문과 형식을 그대로 유지했습니다.' }
}

function formatRules(input: OptimizeNodePromptInput, current: string): string {
  const kindLabel = input.kind === 'video' ? '이미지→영상' : '텍스트→이미지 / 이미지→이미지'
  const duration = input.kind === 'video' ? Math.max(1, Math.round(input.duration || 8)) : 0
  const anchors = extractFormatAnchors(current)
  const anchorLine = anchors.length
    ? `원문에서 꼭 보존할 표식 ${anchors.join('、')}`
    : '원문에 섹션 제목이 없습니다. MiniMax 여섯 섹션이나 다른 형식을 입히지 마세요.'

  const shotBlock =
    input.kind === 'video'
      ? `${duration}초 동안 이어지는 샷 하나입니다. 시작 화면, 동작의 시작과 끝만 구체화하세요. 샷을 자르거나 새 시간 구간을 만들지 마세요. 원문의 시간 표식은 그대로 유지하세요.`
      : '정지 프레임입니다. 화면에서 보이는 내용만 구체화하고 시간의 흐름은 쓰지 마세요.'

  return `당신은 프롬프트를 다듬는 도우미입니다. 원문에 있는 화면만 구체화하고 형식을 바꾸지 마세요.
작업 유형은 ${kindLabel}입니다.
형식 필수 규칙
- ${anchorLine}
- 제목, 섹션, [Shot], 图1=, 0.00-2.00 같은 표식의 이름과 순서를 유지하세요.
- 자유 형식 문단을 여섯 섹션으로 바꾸거나 기존 섹션을 삭제, 통합, 이름 변경하지 마세요.
- 기존 문단 안에서 눈썹과 눈, 입, 손, 몸, 빛, 재료와 소리를 구체화하세요.
- 대사, 이름, 의상, 장면의 제약과 참조 이미지 표시는 그대로 두세요.
- 생성 모델에 전달하는 프롬프트는 문장마다 원래 언어를 유지하세요. 중국어는 중국어로, 영어는 영어로 유지하고 문단 전체를 다른 언어로 바꾸지 마세요.
${shotBlock}
필수 요구사항
- 원문에 없는 이야기를 만들어 내지 마세요.
- 상투적인 말과 분석 과정을 생략하세요. prompt에는 생성 모델에 보낼 본문 전문만 넣으세요.
JSON만 출력하세요. {"prompt":"확장한 프롬프트 전문","note":"무엇을 바꿨는지 한국어 한두 문장으로 설명"}`
}

async function askOnce(
  input: OptimizeNodePromptInput,
  current: string,
  hint: string,
  script: string,
  extra = ''
) {
  return callLLM({
    jsonMode: true,
    temperature: extra ? 0.2 : 0.35,
    maxTokens: 5000,
    signal: input.signal,
    messages: [
      { role: 'system', content: formatRules(input, current) },
      {
        role: 'user',
        content: `노드 ${input.nodeLabel}

현재 프롬프트
${current || '（비어 있음）'}

사용자가 추가한 요청
${hint || '（추가 요청 없음. 형식을 유지하고 화면을 더 생생하게 묘사）'}

이야기 참조 자료
${script ? script.slice(0, 6000) : '（없음）'}
${extra}

확장한 본문 전문을 반환하세요. 현재 프롬프트와 같은 형식을 유지하세요.`
      }
    ]
  })
}

function readPrompt(content: string): { prompt: string; note: string } | null {
  try {
    const parsed = parseJsonRobust(content) as {
      prompt?: string
      optimizedPrompt?: string
      note?: string
    }
    const prompt = String(parsed.prompt || parsed.optimizedPrompt || '').trim()
    if (prompt.length >= 8 && !isReasoningDump(prompt)) {
      return { prompt, note: String(parsed.note || '원문 형식에 맞춰 화면 묘사를 구체화했습니다.').trim() }
    }
  } catch {
    /* ignore */
  }
  const fallback = stripModelWrappers(content).trim()
  if (fallback.length >= 8 && !isReasoningDump(fallback) && fallback[0] !== '{') {
    return { prompt: fallback, note: '모델이 JSON을 반환하지 않아 확장한 프롬프트 본문을 가능한 한 보존했습니다.' }
  }
  return null
}

export async function optimizeNodePrompt(
  input: OptimizeNodePromptInput,
  onProgress?: (msg: string) => void
): Promise<OptimizeNodePromptResult> {
  const current = input.currentPrompt.trim()
  const hint = input.userHint?.trim() || ''
  const script = input.script?.trim() || ''
  if (!current && !hint && !script) {
    throw new Error('먼저 노드에 생성할 내용을 한 문장으로 쓰거나 이야기 참조 자료를 붙여 넣으세요.')
  }
  if (getAIMode() === 'mock') return mockExpand(input)
  if (!current) {
    throw new Error('먼저 노드에 프롬프트를 작성하세요. 원문의 형식을 유지한 채 기존 내용을 구체화합니다.')
  }

  onProgress?.('원문의 형식에 맞춰 프롬프트를 구체화하는 중…')
  const first = await askOnce(input, current, hint, script)
  let result = readPrompt(first.content)
  let breakReason = result ? formatBreakReason(current, result.prompt) : '사용 가능한 프롬프트를 얻지 못했습니다.'

  if (result && !breakReason) return result

  onProgress?.('이전 응답의 형식이 바뀌어 원문의 구조로 다시 작성하는 중…')
  const retry = await askOnce(
    input,
    current,
    hint,
    script,
    `\n이전 응답이 요구사항을 충족하지 못했습니다. ${breakReason || '형식이 바뀌었습니다.'} 원문의 제목과 섹션을 그대로 쓰고 내용만 구체화하세요. 다른 형식을 사용하지 마세요.`
  )
  result = readPrompt(retry.content)
  if (!result || isReasoningDump(result.prompt)) {
    throw new Error('모델이 프롬프트 대신 분석 과정을 반환했습니다. 다른 모델을 선택하거나 다시 시도하세요.')
  }
  breakReason = formatBreakReason(current, result.prompt)
  if (breakReason) {
    throw new Error(`${breakReason} 원문의 형식을 유지해 다시 시도하세요.`)
  }
  return result
}
