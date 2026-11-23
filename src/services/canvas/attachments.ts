/**
 * 대화의 로컬 텍스트 첨부를 이번 요청의 자료로 추가한다.
 * 데스크톱 설정에서 파일 접근을 허용하면 사용자가 지정한 경로를 읽는다.
 */
import { desktop, isDesktop } from '@/services/desktop'

export interface AgentAttachment {
  name: string
  /** 중복을 제거하고 출처를 확인하기 위한 로컬 절대 경로 */
  path?: string
  content: string
}

const MAX_FILE_CHARS = 200_000
const MAX_TOTAL_CHARS = 500_000

function limitedContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content
  return `${content.slice(0, MAX_FILE_CHARS)}\n\n【Truncated to the first ${MAX_FILE_CHARS.toLocaleString()} characters】`
}

/**
 * 드라이브 문자로 시작하는 경로를 확인한다. 공백, 인용 부호 또는 전각 문장 부호에서 끝난다.
 * 지원하는 텍스트 확장자 뒤에 이어진 사용자 지시는 경로에서 제외한다.
 */
const ANY_PATH_RE = /[A-Za-z]:[\\/][^\s"'“”‘’<>|*?，。！？；：、]+/g
const TEXT_EXT_RE = /\.(markdown|fountain|json|csv|txt|md|srt|ass|lrc)(?![A-Za-z0-9])/i

/** 사용자 메시지의 로컬 경로와 첨부에서 자료를 만든다. 자료가 없으면 빈 문자열을 반환한다. */
export async function buildMaterialBlock(
  userText: string,
  attachments?: AgentAttachment[],
  onLog?: (label: string) => void
): Promise<string> {
  const parts: string[] = []
  let totalChars = 0
  const append = (label: string, content: string) => {
    if (totalChars >= MAX_TOTAL_CHARS) return
    const remaining = MAX_TOTAL_CHARS - totalChars
    const normalized = limitedContent(content).slice(0, remaining)
    parts.push(`${label}\n${normalized}`)
    totalChars += normalized.length
  }
  for (const a of attachments || []) {
    append(`【Attachment: ${a.name}】`, a.content)
  }
  const known = new Set((attachments || []).map((a) => (a.path || a.name).toLowerCase()))
  for (const m of userText.matchAll(ANY_PATH_RE)) {
    let p = m[0].replace(/[\\/]+$/, '')
    // 경로 바로 뒤의 지시를 제외하고 알려진 텍스트 확장자까지만 사용한다.
    const extHit = p.match(TEXT_EXT_RE)
    if (extHit && extHit.index !== undefined) p = p.slice(0, extHit.index + extHit[0].length)
    if (!p || known.has(p.toLowerCase())) continue
    known.add(p.toLowerCase())
    const ext = extHit ? extHit[1].toLowerCase() : ''
    if (!extHit && /[^\\/]\.[A-Za-z0-9]{2,5}$/.test(p)) {
      // 지원하지 않는 확장자라면 파일을 읽지 않고 사유를 전달한다.
      parts.push(`【Local file: ${p} is not a supported text file. Convert to TXT or Markdown, or paste its contents.】`)
      onLog?.(`텍스트가 아닌 파일을 건너뛰었어요. ${p}`)
      continue
    }
    try {
      if (!isDesktop()) throw new Error('로컬 파일을 읽으려면 설치된 데스크톱 앱이 필요합니다.')
      const content = await desktop().readText(p)
      append(`【Local file: ${p}】`, content)
      onLog?.(`로컬 파일을 읽었어요. ${p}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const dirHint = extHit
        ? ''
        : '. If this is a directory, provide a complete path to a specific file, including its extension.'
      parts.push(`【Local file: ${p} could not be read: ${msg}${dirHint}】`)
      onLog?.(`${p} 파일을 읽지 못했어요.`)
    }
  }
  return parts.length
    ? `Use these local materials supplied by the user as attachments or paths. Do not ask the user to paste them again:\n\n${parts.join('\n\n')}`
    : ''
}
