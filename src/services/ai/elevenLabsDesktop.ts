import { desktop, isDesktop } from '@/services/desktop'
import { friendlyAiError } from './abort'
import type { ElevenLabsOperation, ElevenLabsReply } from './elevenLabsTts'

export async function elevenLabsRequest<Operation extends ElevenLabsOperation>(
  encryptedKey: string | undefined, operation: Operation, signal?: AbortSignal
) {
  if (!encryptedKey) throw new Error('설정에서 ElevenLabs API 키를 등록해야 합니다.')
  if (!isDesktop() || !desktop().elevenLabs) throw new Error('ElevenLabs 더빙을 사용하려면 데스크톱 앱이 필요합니다.')
  signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const cancel = () => desktop().cancelProviderFetch(requestId)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const reply = await desktop().elevenLabs({ requestId, encryptedKey, operation })
    signal?.throwIfAborted()
    if (reply.kind !== operation.kind) throw new Error('ElevenLabs 응답 형식이 올바르지 않습니다.')
    return reply as Extract<ElevenLabsReply, { kind: Operation['kind'] }>
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(friendlyAiError(error))
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
