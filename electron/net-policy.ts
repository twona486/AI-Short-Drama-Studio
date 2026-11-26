import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { isLanHost, llmAddressError, privateIPv4, tailscaleIPv4 } from '../src/services/ai/networkAddress'

export { llmAddressError }

export function lanOrigin(raw: string, defaultPort: string): URL {
  const value = raw.trim()
  const absolute = value.includes('://') ? value : `http://${value}`
  const url = new URL(absolute)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || !isLanHost(url.hostname)) throw new Error('Invalid LAN address')
  if (!url.port && !/:\d+(?:[/?#]|$)/.test(absolute.slice(absolute.indexOf('://') + 3))) url.port = defaultPort
  return url
}

export async function pinAddress(url: URL): Promise<string> {
  if (privateIPv4(url.hostname)) return url.hostname
  if (url.hostname === 'localhost') return '127.0.0.1'
  const records = await lookup(url.hostname, { all: true, family: 4 })
  const allowed = url.hostname.endsWith('.ts.net') ? tailscaleIPv4 : privateIPv4
  if (!records.length || records.some(({ address }) => !allowed(address))) {
    throw new Error('LAN host did not resolve to private IPv4')
  }
  return records[0].address
}

export function desktopHostHeader(origin: URL, address: string, override?: string) {
  if (override !== undefined && typeof override !== 'string') throw new Error('Invalid Host header')
  const value = override?.trim()
  if (value) {
    const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(value)
    if (!match || value.length > 253 || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
      throw new Error('Invalid Host header')
    }
    return value
  }
  const port = origin.port || (origin.protocol === 'https:' ? '443' : '80')
  const host = tailscaleIPv4(address) || origin.hostname.endsWith('.ts.net') ? 'localhost' : address
  return `${host}:${port}`
}

/**
 * 사용자 지정 영상 워크플로는 여러 제공업체의 임시 CDN에서 결과를 가져온다.
 * 고정 도메인 목록 대신 로컬 및 사설망 주소를 차단해 다운로드 IPC의 SSRF를 막는다.
 * 공용 HTTPS 영상 주소는 허용한다.
 */
function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1' || normalized === '::' || /^fe[89ab][0-9a-f]:/.test(normalized)) {
    return true
  }
  if (/^(?:f[cd]|ff)[0-9a-f]{2}:/.test(normalized)) return true

  // IPv4 매핑 IPv6의 예는 ::ffff:127.0.0.1이다.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  const hexMapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized)
  const mappedOctets = hexMapped?.slice(1).flatMap((part) => [parseInt(part, 16) >> 8, parseInt(part, 16) & 255])
  const ipv4 = mapped?.[1] ?? mappedOctets?.join('.') ?? (isIP(normalized) === 4 ? normalized : '')
  if (!ipv4) return false
  const octets = ipv4.split('.').map(Number)
  const [a, b] = octets
  return (
    a === 0 ||
    privateIPv4(ipv4) ||
    (a === 169 && b === 254) ||
    a >= 224
  )
}

export async function publicHttpsTarget(raw: string, message: (key: 'invalidVideoUrl' | 'requirePublicHttps' | 'rejectPrivateHost' | 'lookupFailed' | 'rejectPrivateResolution', fields?: Record<string, string>) => string) {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(message('invalidVideoUrl'))
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(message('requirePublicHttps'))
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(message('rejectPrivateHost'))
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(message('rejectPrivateHost'))
    return { url: parsed, lookup: pinnedLookup([{ address: host, family: isIP(host) }]) }
  }
  let addresses: Awaited<ReturnType<typeof lookup>>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error(message('lookupFailed', { host }))
  }
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
    throw new Error(message('rejectPrivateResolution'))
  }
  return { url: parsed, lookup: pinnedLookup(addresses) }
}

function pinnedLookup(addresses: { address: string; family: number }[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  }
}

export async function llmPinnedLookup(url: URL) {
  if (url.protocol === 'http:') return pinnedLookup([{ address: await pinAddress(url), family: 4 }])
}

export function isAllowedProviderFetch(url: URL) {
  return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password
}

export function isAllowedDashscopeFetch(parsed: URL) {
  const host = parsed.hostname.toLowerCase()
  const pathName = parsed.pathname
  const allowedHost =
    host === 'dashscope.aliyuncs.com' ||
    host.endsWith('.dashscope.aliyuncs.com') ||
    host.endsWith('.maas.aliyuncs.com')
  const allowedPath =
    pathName.includes('/services/aigc/video-generation/') ||
    /\/api\/v1\/tasks\/[^/]+$/.test(pathName)
  return parsed.protocol === 'https:' && isAllowedProviderFetch(parsed) && allowedHost && allowedPath
}
