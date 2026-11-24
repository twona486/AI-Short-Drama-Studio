export function normalizeRouterBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('전체 API 주소를 입력하세요. 예: https://api.example.com/v1') }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 주소에서 계정, 키, 쿼리 매개변수와 프래그먼트를 빼 주세요.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/i.test(url.hostname))) {
    throw new Error('원격 API에는 HTTPS를 사용하세요. 이 기기의 API에는 HTTP를 사용할 수 있어요.')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '')
  return url.origin + (path || '/v1')
}
