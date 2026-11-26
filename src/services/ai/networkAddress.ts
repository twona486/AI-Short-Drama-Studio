export function tailscaleIPv4(address: string) {
  return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}$/.test(address)
}

export function privateIPv4(address: string) {
  const octets = address.split('.')
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [a, b] = octets.map(Number)
  return tailscaleIPv4(address) || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function isLanHost(host: string) {
  return host === 'localhost' || privateIPv4(host) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|ts\.net)$/i.test(host)
}

export function llmAddressError(url: URL) {
  if (url.username || url.password || url.search || url.hash) return 'credentials'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLanHost(url.hostname))) return 'protocol'
}

export function isOfficialOpenAi(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.origin === 'https://api.openai.com' && !url.username && !url.password
  } catch {
    return false
  }
}
