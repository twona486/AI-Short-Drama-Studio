import { t } from '@/i18n'
import { desktop, isDesktop } from '@/services/desktop'

/** Markdown 또는 텍스트 대본을 선택한다. 취소하면 null을 반환한다. */
export async function pickPlayMarkdownFile(): Promise<{ text: string; filename: string } | null> {
  if (isDesktop()) {
    const paths = await desktop().pickFiles([
      { name: t('common.markdownScript'), extensions: ['md', 'markdown', 'txt'] }
    ])
    const path = paths[0]
    if (!path) return null
    return { text: await desktop().readText(path), filename: path.split(/[\\/]/).pop() || '' }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      resolve({ text: await file.text(), filename: file.name })
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
