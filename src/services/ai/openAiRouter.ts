import { llmAddressError } from './networkAddress'

export class RouterAddressError extends Error {
  constructor(readonly kind: 'invalid' | 'credentials' | 'protocol') {
    super(kind)
  }
}

export function normalizeRouterBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new RouterAddressError('invalid')
  }
  const error = llmAddressError(url)
  if (error) throw new RouterAddressError(error)
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '')
  return url.origin + (path || '/v1')
}
