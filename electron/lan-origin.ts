import { lookup } from 'node:dns/promises'
import { isIPv4 } from 'node:net'

function privateIPv4(address: string) {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function lanOrigin(raw: string, defaultPort: string): URL {
  const value = raw.trim()
  const absolute = value.includes('://') ? value : `http://${value}`
  const url = new URL(absolute)
  const named = url.hostname === 'localhost' || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/i.test(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || (!named && !privateIPv4(url.hostname))) throw new Error('Invalid LAN address')
  if (!url.port && !/:\d+(?:[/?#]|$)/.test(absolute.slice(absolute.indexOf('://') + 3))) url.port = defaultPort
  return url
}

export async function pinAddress(url: URL): Promise<string> {
  if (privateIPv4(url.hostname)) return url.hostname
  if (url.hostname === 'localhost') return '127.0.0.1'
  const records = await lookup(url.hostname, { all: true, family: 4 })
  if (!records.length || records.some(({ address }) => !privateIPv4(address))) {
    throw new Error('LAN host did not resolve to private IPv4')
  }
  return records[0].address
}
