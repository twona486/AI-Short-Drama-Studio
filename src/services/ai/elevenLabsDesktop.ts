import { desktop, isDesktop } from '@/services/desktop'
import { t } from '@/i18n'
import type { ElevenLabsOperation, ElevenLabsReply } from './elevenLabsTts'

export async function elevenLabsRequest<Operation extends ElevenLabsOperation>(
  encryptedKey: string | undefined, operation: Operation, signal?: AbortSignal
) {
  if (!encryptedKey) throw new Error(t('elevenLabs.missingKey'))
  if (!isDesktop() || !desktop().elevenLabs) throw new Error(t('elevenLabsErrors.desktopRequired'))
  signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const cancel = () => desktop().cancelProviderFetch(requestId)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const reply = await desktop().elevenLabs({ requestId, encryptedKey, operation })
    signal?.throwIfAborted()
    if (reply.kind === 'cancelled') throw new DOMException(t('elevenLabsErrors.cancelled'), 'AbortError')
    if (reply.kind === 'timeout') throw new DOMException(t('elevenLabsErrors.timeout'), 'TimeoutError')
    if (reply.kind === 'http') throw new Error(t('elevenLabsErrors.http', { status: reply.status }))
    if (reply.kind === 'missingKey') throw new Error(t('elevenLabs.missingKey'))
    if (reply.kind !== operation.kind) {
      const kind = reply.kind === 'speech' || reply.kind === 'voices' || reply.kind === 'connection' || reply.kind === 'addVoice' ? 'invalidResponse' : reply.kind
      throw new Error(t(`elevenLabsErrors.${kind}`))
    }
    return reply as Extract<ElevenLabsReply, { kind: Operation['kind'] }>
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
