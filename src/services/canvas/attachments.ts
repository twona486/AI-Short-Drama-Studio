/**
 * 对话Attachment: 把本地文本文件内容注入智能体本轮材料。
 * 桌面端已在设置里授权文件访问；地址一律以用户给的路径为准。
 */
import { desktop, isDesktop } from '@/services/desktop'

export interface AgentAttachment {
  name: string
  /** 本地绝对路径（有的话可去重、可追溯） */
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
 * 任意盘符路径（含文件夹、无后缀文件）。遇到空格 / 引号 / 中文标点即截止（路径里允许中文，如 F:\剧本\），
 * 命中已知文本后缀时只截到后缀为止，避免把后面的指令吃进来（如 F:\剧本\x.txt拆成分镜）。
 */
const ANY_PATH_RE = /[A-Za-z]:[\\/][^\s"'“”‘’<>|*?，。！？；：、]+/g
const TEXT_EXT_RE = /\.(markdown|fountain|json|csv|txt|md|srt|ass|lrc)(?![A-Za-z0-9])/i

/** 从用户消息里的本地路径 + 显式附件构建材料块；没有材料返回空串。 */
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
    // 路径后面紧跟指令文字时，只保留到已知文本后缀为止
    const extHit = p.match(TEXT_EXT_RE)
    if (extHit && extHit.index !== undefined) p = p.slice(0, extHit.index + extHit[0].length)
    if (!p || known.has(p.toLowerCase())) continue
    known.add(p.toLowerCase())
    const ext = extHit ? extHit[1].toLowerCase() : ''
    if (!extHit && /[^\\/]\.[A-Za-z0-9]{2,5}$/.test(p)) {
      // 有后缀但不是文本格式：不读，明说
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
