/**
 * 모델이 반환한 불완전한 JSON을 파싱할 수 있게 복구한다.
 * 쉼표, 괄호, 전각 기호, 잘린 구조만 고친다. 문자열 값은 보존한다.
 */

const WS = /\s/

function nextNonWs(s: string, i: number): { ch: string; index: number } | null {
  for (let j = i; j < s.length; j++) {
    if (!WS.test(s[j])) return { ch: s[j], index: j }
  }
  return null
}

function isValueStart(ch: string): boolean {
  return (
    ch === '{' ||
    ch === '[' ||
    ch === '"' ||
    ch === '-' ||
    ch === 't' ||
    ch === 'f' ||
    ch === 'n' ||
    (ch >= '0' && ch <= '9')
  )
}

const THINK_TAG = 'think|thinking|reasoning|analysis'

/** 추론 태그를 제거한다. 태그가 닫히지 않으면 최종 응답 시작점까지 잘라 내고, 시작점이 없으면 전체를 버린다. */
export function stripThinkTags(content: string): string {
  const closed = new RegExp(`<(?:${THINK_TAG})\\b[^>]*>[\\s\\S]*?<\\/(?:${THINK_TAG})>`, 'gi')
  const untilDeliverable = new RegExp(
    `<(?:${THINK_TAG})\\b[^>]*>[\\s\\S]*?(?=(?:subject_definitions|integrated_multimodal_description|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\\s*:|\\[Shot\\s*\\d+\\]|\\{)`,
    'i'
  )
  const unclosed = new RegExp(`<(?:${THINK_TAG})\\b[^>]*>[\\s\\S]*$`, 'i')
  return String(content || '')
    .replace(closed, '')
    .replace(untilDeliverable, '')
    .replace(unclosed, '')
}

function isDeliverableLine(line: string): boolean {
  return (
    /^(?:subject_definitions|integrated_multimodal_description|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:/i.test(
      line
    ) ||
    /^\[Shot\s*\d+\]/i.test(line) ||
    /^\(S\d+\)/.test(line) ||
    /^<Picture\s*\d+/i.test(line) ||
    /^<\s*d\s*>/i.test(line) ||
    /^(?:No dialogue|The camera|The action|Picture \d)/i.test(line) ||
    line.trim() === '{'
  )
}

/** 이 문장은 작성 방법을 설명하는 메타 문장이다. 영상 모델에 줄 화면 설명에서 제외한다. */
function isReasoningLine(line: string): boolean {
  const t = line.trim()
  if (!t || isDeliverableLine(t)) return false
  if (
    /^(?:let me\b|i need to\b|i'll\b|i will\b|the user\b|here(?:'s| is) (?:the|my|a)\b|to summarize\b|thinking\b|analysis\b)/i.test(
      t
    )
  ) {
    return true
  }
  if (/^(?:ok[,.]|okay[,.]|sure[,.]|certainly[,.])/i.test(t) && t.length < 80) return true
  if (
    /思考过程|推理过程|分析过程|我的理解|用户要求|用户希望|用户给的|需要输出|应该输出|只输出|不要解释|改写如下|优化如下|以下是优化|下面是优化|最终提示词|最终稿/.test(
      t
    )
  ) {
    return true
  }
  return (
    /^(?:好的[，,。！]|嗯[，,。]|让我|我来|我会先|我需要先|我先)/.test(t) &&
    /提示词|用户|镜头稿|英文|格式|优化|改写|输出|JSON|六段/.test(t)
  )
}

function prefixLooksLikeReasoning(prefix: string): boolean {
  const t = prefix.trim()
  if (!t) return false
  if (isReasoningLine(t)) return true
  return /思考过程|let me\b|the user\b|用户要求|我来把|改写如下|优化如下/.test(t)
}

function trimReasoningParagraphs(text: string): string {
  const parts = text.split(/\n{2,}/)
  let start = 0
  let end = parts.length
  while (start < end && parts[start].split(/\n/).every((line) => !line.trim() || isReasoningLine(line))) start += 1
  while (end > start && parts[end - 1].split(/\n/).every((line) => !line.trim() || isReasoningLine(line))) end -= 1
  const kept = parts.slice(start, end)
  if (kept.length) {
    const sentences = kept[0].split(/(?<=[。！？.!?])\s+/)
    let i = 0
    while (i < sentences.length && isReasoningLine(sentences[i])) i += 1
    kept[0] = sentences.slice(i).join(' ').trim()
    if (!kept[0]) kept.shift()
  }
  return kept.join('\n\n').trim()
}

/**
 * 모델이 저장할 프롬프트에 추론 과정을 섞어 쓰는 경우가 있다.
 * 태그와 앞뒤의 작업 설명만 제거한다. 가운데의 샷 본문은 보존한다.
 */
export function stripReasoningLeak(text: string): string {
  let s = stripThinkTags(text)
  const marker = s.match(
    /(?:^|\n)\s*(?:subject_definitions|integrated_multimodal_description|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:|\[Shot\s*\d+\]/i
  )
  if (marker && marker.index !== undefined && marker.index > 0) {
    const prefix = s.slice(0, marker.index)
    if (prefixLooksLikeReasoning(prefix)) s = s.slice(marker.index)
  }
  s = trimReasoningParagraphs(s)
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function stripModelWrappers(content: string): string {
  return stripThinkTags(content)
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .trim()
}

export function extractJsonText(content: string): string {
  const s = stripModelWrappers(content)
  if (!s) throw new Error('언어 모델이 빈 응답을 반환했어요.')
  const start = s.indexOf('{')
  if (start === -1) {
    throw new Error(
      `언어 모델 응답에서 JSON 객체를 찾지 못했어요.\n응답의 처음 300자: ${content.slice(0, 300)}`
    )
  }
  let inString = false
  let escape = false
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start)
}

function parseErrorContext(text: string, err: Error): string {
  const m = err.message.match(/position (\d+)/i)
  if (!m) return err.message
  const pos = Number(m[1])
  const from = Math.max(0, pos - 90)
  const to = Math.min(text.length, pos + 90)
  return `${err.message}\n오류 위치 주변: …${text.slice(from, to)}…`
}

/** 문자열 값을 보존하면서 JSON 문법 오류를 수정한다. */
export function repairJsonLocally(json: string): string {
  let out = ''
  let inString = false
  let escape = false
  let pendingValueEnd = false

  for (let i = 0; i < json.length; i++) {
    const c = json[i]

    if (inString) {
      if (escape) {
        out += c
        escape = false
        continue
      }
      if (c === '\\') {
        out += c
        escape = true
        continue
      }
      if (c === '"') {
        out += c
        inString = false
        const nxt = nextNonWs(json, i + 1)
        pendingValueEnd = Boolean(nxt && nxt.ch !== ':')
        continue
      }
      if (c === '\n' || c === '\r') {
        out += '\\n'
        if (c === '\r' && json[i + 1] === '\n') i += 1
        continue
      }
      if (c === '\t') {
        out += '\\t'
        continue
      }
      out += c
      continue
    }

    if (WS.test(c)) {
      out += c
      continue
    }

    let ch = c
    if (c === '，') ch = ','
    else if (c === '：') ch = ':'
    else if (c === '“' || c === '”') ch = '"'

    if (ch === '"') {
      if (pendingValueEnd) out += ','
      out += ch
      inString = true
      escape = false
      pendingValueEnd = false
      continue
    }

    if (ch === '{' || ch === '[') {
      if (pendingValueEnd) out += ','
      out += ch
      pendingValueEnd = false
      continue
    }

    if (ch === '}' || ch === ']') {
      out += ch
      pendingValueEnd = true
      continue
    }

    if (ch === ':' || ch === ',') {
      out += ch
      pendingValueEnd = false
      continue
    }

    if (ch === '-' || (ch >= '0' && ch <= '9') || ch === 't' || ch === 'f' || ch === 'n') {
      if (pendingValueEnd) out += ','
      if (ch === 't' || ch === 'f' || ch === 'n') {
        const m = json.slice(i).match(/^(true|false|null)/)
        if (m) {
          out += m[1]
          i += m[1].length - 1
          pendingValueEnd = true
          continue
        }
      }
      const m = json.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      if (m) {
        out += m[0]
        i += m[0].length - 1
        pendingValueEnd = true
        continue
      }
    }

    out += ch
    pendingValueEnd = false
  }

  return out.replace(/,\s*([}\]])/g, '$1')
}

export function closeTruncatedJson(json: string): string {
  let s = json.trim().replace(/,+\s*$/, '')

  const scan = (text: string) => {
    let inString = false
    let escape = false
    const stack: Array<'{' | '['> = []
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inString) {
        if (escape) escape = false
        else if (c === '\\') escape = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{') stack.push('{')
      else if (c === '[') stack.push('[')
      else if ((c === '}' || c === ']') && stack.length) stack.pop()
    }
    return { inString, stack }
  }

  let { inString, stack } = scan(s)
  if (inString) s += '"'

  s = s.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*$/, '')
  s = s.replace(/"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*$/, '')
  s = s.replace(/:\s*$/, '')
  s = s.replace(/,+\s*$/, '')

  ;({ inString, stack } = scan(s))
  if (inString) s += '"'
  ;({ stack } = scan(s))
  while (stack.length) {
    const t = stack.pop()
    s += t === '{' ? '}' : ']'
  }
  return s
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: e as Error }
  }
}

function isUsefulStoryboard(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    (Array.isArray(obj.shots) && obj.shots.length > 0) ||
    (Array.isArray(obj.subjects) && obj.subjects.length > 0) ||
    (Array.isArray(obj.scenes) && obj.scenes.length > 0) ||
    typeof obj.playMarkdown === 'string'
  )
}

/** 원문 파싱, 구조 수정, 괄호 보완, 불완전한 뒷부분 제거 순으로 시도한다. */
export function parseJsonRobust(content: string): any {
  const extracted = extractJsonText(content)
  const repaired = repairJsonLocally(extracted)
  const closed = closeTruncatedJson(repaired)
  const first = tryParse(extracted)
  const firstError = first.ok ? undefined : first.error

  for (const candidate of [extracted, repaired, closed]) {
    const r = tryParse(candidate)
    if (r.ok) return r.value
  }

  let best: unknown
  for (let i = repaired.lastIndexOf('}'); i >= 0; i = repaired.lastIndexOf('}', i - 1)) {
    const slice = closeTruncatedJson(repaired.slice(0, i + 1))
    const r = tryParse(slice)
    if (!r.ok || !r.value || typeof r.value !== 'object') continue
    if (isUsefulStoryboard(r.value)) return r.value
    if (!best) best = r.value
  }
  if (best) return best

  throw new Error(
    `JSON을 읽지 못했어요. ${firstError ? parseErrorContext(extracted, firstError) : '올바른 JSON으로 복구할 수 없어요.'}\n복구를 시도한 내용의 처음 300자: ${extracted.slice(0, 300)}`
  )
}
