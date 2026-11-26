import type { IpcMain, WebContents } from 'electron'

export function registerProviderRequests(ipcMain: IpcMain) {
  const requests = new WeakMap<WebContents, Map<string | symbol, AbortController>>()
  ipcMain.on('desktop:cancelProviderFetch', ({ sender }, id: string) => {
    requests.get(sender)?.get(id)?.abort()
  })

  function requestsFor(sender: WebContents) {
    const existing = requests.get(sender)
    if (existing) return existing
    const active = new Map<string | symbol, AbortController>()
    requests.set(sender, active)
    sender.once('destroyed', () => {
      for (const controller of active.values()) controller.abort()
      active.clear()
    })
    return active
  }

  return function start(sender: WebContents, id?: string, timeoutMs?: number) {
    const active = requestsFor(sender)
    const key = id || Symbol()
    const controller = new AbortController()
    active.set(key, controller)
    const timer = timeoutMs === undefined ? undefined : setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs
    )
    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timer)
        if (active.get(key) === controller) active.delete(key)
      }
    }
  }
}
