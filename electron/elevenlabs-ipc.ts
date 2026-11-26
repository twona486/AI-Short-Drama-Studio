import { ipcMain, safeStorage } from 'electron'
import type { ElevenLabsRequest } from '../src/services/ai/elevenLabsTts'
import { requestElevenLabs } from './elevenlabs-tts'

const MAX_KEY_BYTES = 4096

function protectKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > MAX_KEY_BYTES) return null
  try {
    if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) return null
    return safeStorage.encryptString(key.trim()).toString('base64')
  } catch {
    return null
  }
}

function openKey(encryptedKey: unknown): string {
  if (typeof encryptedKey !== 'string' || !encryptedKey) {
    throw new Error('설정에서 ElevenLabs API 키를 등록해야 합니다.')
  }
  try {
    if (encryptedKey.length > 8192) throw new Error()
    return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
  } catch {
    throw new Error('저장된 ElevenLabs API 키를 읽을 수 없습니다. 설정에서 키를 다시 등록해야 합니다.')
  }
}

export function registerElevenLabsIpc(requests: Map<string, AbortController>) {
  ipcMain.handle('desktop:protectElevenLabsKey', (_event, key: unknown) => protectKey(key))
  ipcMain.handle('desktop:elevenLabs', async ({ sender }, request: ElevenLabsRequest) => {
    const id = `${sender.id}:${request?.requestId}`
    if (!request?.requestId || requests.has(id)) throw new Error('ElevenLabs 요청 ID가 올바르지 않습니다.')
    const controller = new AbortController()
    const abort = () => controller.abort()
    requests.set(id, controller)
    sender.once('destroyed', abort)
    try {
      return await requestElevenLabs(openKey(request.encryptedKey), request.operation, controller.signal)
    } finally {
      sender.removeListener('destroyed', abort)
      requests.delete(id)
    }
  })
}
