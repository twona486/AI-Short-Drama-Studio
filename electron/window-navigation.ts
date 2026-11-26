import type { WebContents } from 'electron'

export function guardWindowNavigation(
  contents: Pick<WebContents, 'setWindowOpenHandler' | 'on'>,
  entry: URL,
  openExternal: (url: string) => Promise<void>
) {
  function launchInBrowser(url: string) {
    const target = URL.parse(url)
    if (target && (target.protocol === 'https:' || target.protocol === 'http:')) {
      void openExternal(target.href).catch((error) => console.warn('[electron] 링크를 열지 못했습니다.', error.code))
    }
  }

  contents.setWindowOpenHandler(({ url }) => {
    launchInBrowser(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event) => {
    const { url } = event
    const destination = URL.parse(url)
    if (destination) destination.hash = ''
    if (destination?.href === entry.href) return
    event.preventDefault()
    launchInBrowser(url)
  })
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame && event.url !== entry.href) event.preventDefault()
  })
}
