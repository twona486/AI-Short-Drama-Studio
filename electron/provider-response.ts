import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class ProviderResponseTooLarge extends Error {}

export async function* boundedChunks(source: AsyncIterable<Uint8Array>, maxBytes: number) {
  let length = 0
  for await (const chunk of source) {
    length += chunk.byteLength
    if (length > maxBytes) throw new ProviderResponseTooLarge()
    yield chunk
  }
}

export async function streamProviderFile(
  source: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal, extension = 'bin'
) {
  signal.throwIfAborted()
  const path = join(tmpdir(), `aicuts-provider-${randomUUID()}.${extension}`)
  try {
    await pipeline(boundedChunks(source, maxBytes), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
    return path
  } catch (error) {
    await rm(path, { force: true })
    throw error
  }
}

export async function readAutoDlResponse(response: Response, binary: boolean, signal: AbortSignal) {
  const contentType = response.headers.get('content-type') || ''
  const textual = /json|text|xml|javascript|x-www-form-urlencoded/i.test(contentType)
  const maxBytes = binary && response.ok && !textual ? 256 * 1024 * 1024 : 16 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new ProviderResponseTooLarge()
  }
  const result = { status: response.status, ok: response.ok, contentType, text: '' }
  if (!response.body) return result
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  if (binary && response.ok && !textual) {
    return { ...result, filePath: await streamProviderFile(source, maxBytes, signal) }
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of boundedChunks(source, maxBytes)) chunks.push(chunk)
  return { ...result, text: Buffer.concat(chunks).toString('utf8') }
}
