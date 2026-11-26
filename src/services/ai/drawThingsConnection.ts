import { t } from '@/i18n'
import { desktop, isDesktop } from '@/services/desktop'
import { isDrawThingsGrpc, type DrawThingsReply } from './drawThingsOptions'

export function drawThingsApi() {
  if (!isDesktop() || !desktop().drawThingsRequest) throw new Error(t('drawThings.desktopOnly'))
  return desktop()
}

export function drawThingsReplyMessage(reply: DrawThingsReply) {
  if (reply.kind === 'modelIncomplete' && reply.missingComponents?.length) {
    return t('drawThings.missingComponents', { files: reply.missingComponents.join(', ') })
  }
  return t(`drawThings.${reply.kind}`, reply.kind === 'http' ? { status: reply.status } : {})
}

export async function checkDrawThings(baseUrl: string, encryptedSharedSecret?: string) {
  try {
    const reply = await drawThingsApi().drawThingsRequest({
      kind: 'check', baseUrl, encryptedSharedSecret: isDrawThingsGrpc(baseUrl) ? encryptedSharedSecret : undefined
    })
    return {
      ok: reply.kind === 'ready', detail: drawThingsReplyMessage(reply),
      models: reply.kind === 'ready' ? reply.models : undefined,
      incompleteModels: reply.kind === 'ready' ? reply.incompleteModels : undefined,
      missingComponents: reply.kind === 'ready' ? reply.missingComponents : undefined
    }
  } catch (error) {
    const unavailable = !isDesktop() || !desktop().drawThingsRequest
    return { ok: false, detail: t(unavailable ? 'drawThings.desktopOnly' : 'drawThings.offline') }
  }
}
