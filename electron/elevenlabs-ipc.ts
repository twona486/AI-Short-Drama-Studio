import { ipcMain } from 'electron'
import { decryptSecret, encryptSecret } from './settings-storage'
import type { ElevenLabsRequest } from '../src/services/ai/elevenLabsTts'
import { requestElevenLabs } from './elevenlabs-tts'

const MAX_KEY_BYTES = 4096

function protectKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > MAX_KEY_BYTES) return null
  try {
    return encryptSecret(key.trim())
  } catch {
    return null
  }
}

export function registerElevenLabsIpc() {
  const requests = new Map<string, AbortController>()
  ipcMain.on('desktop:cancelProviderFetch', ({ sender }, requestId: string) => {
    requests.get(`${sender.id}:${requestId}`)?.abort()
  })
  ipcMain.handle('desktop:protectElevenLabsKey', (_event, key: unknown) => protectKey(key))
  ipcMain.handle('desktop:elevenLabs', async ({ sender }, request: ElevenLabsRequest) => {
    const id = `${sender.id}:${request?.requestId}`
    if (!request?.requestId || requests.has(id)) return { kind: 'invalidRequest' }
    if (typeof request.encryptedKey !== 'string' || !request.encryptedKey) return { kind: 'missingKey' }
    let apiKey: string
    try {
      if (request.encryptedKey.length > 8192) return { kind: 'storedKey' }
      apiKey = decryptSecret(request.encryptedKey)
    } catch {
      return { kind: 'storedKey' }
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    requests.set(id, controller)
    sender.once('destroyed', abort)
    try {
      return await requestElevenLabs(apiKey, request.operation, controller.signal)
    } finally {
      sender.removeListener('destroyed', abort)
      requests.delete(id)
    }
  })
}
