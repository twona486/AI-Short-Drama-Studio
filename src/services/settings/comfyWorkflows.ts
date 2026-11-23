/**
 * ComfyUI 워크플로의 API 형식을 검사하고 로컬 목록과 파일 또는 URL을 가져온다.
 */

import { buildAuthHeader, providerHttp, type AdapterConfig } from '@/services/ai/adapters'
import { guessInputMap, type ComfyInputBinding } from '@/services/ai/comfyInputMap'

export type ComfyWorkflowFormat = 'api' | 'ui' | 'unknown'

export interface DiscoveredWorkflow {
  id: string
  name: string
  /** userdata 기준 상대 경로. 응답에 따라 workflows/foo.json 또는 foo.json이다. */
  path: string
  size?: number
  modified?: number
  source: 'userdata' | 'api-workflows' | 'url' | 'file'
  /**
   * 목록을 읽은 디렉터리 접두사. 예를 들어 workflows다.
   * 목록의 상대 파일 경로 앞에 이 접두사를 다시 붙여야 한다.
   */
  root?: string
  /** 목록을 읽은 API 경로를 파일을 읽을 때 우선 사용한다. */
  endpoint?: string
}

export interface DiscoverResult {
  ok: boolean
  reachable: boolean
  workflows: DiscoveredWorkflow[]
  /** 검색 결과와 공통 목록 API의 지원 여부를 사용자에게 안내한다. */
  message: string
  tried: string[]
}

export interface WorkflowParseResult {
  ok: boolean
  format: ComfyWorkflowFormat
  /** API에 제출할 수 있는 adapter.workflowTemplate 문자열 */
  template?: string
  detail: string
  /** 디버깅용 전체 요청 URL과 응답 상태 */
  tried?: string[]
  /** 도우미가 입력 매핑을 분석할 때 쓰는 노드 그래프 */
  payload?: any
  /** 도우미의 분석 전이나 분석이 불가능할 때 규칙으로 추정한 입력 노드 */
  bindings?: ComfyInputBinding[]
}

function trimSlash(url: string) {
  return (url || '').replace(/\/+$/, '')
}

function joinUrl(base: string, path: string) {
  const b = trimSlash(base)
  if (/^https?:\/\//i.test(path)) return path
  return `${b}/${String(path).replace(/^\//, '')}`
}

export function detectWorkflowFormat(raw: unknown): ComfyWorkflowFormat {
  if (!raw || typeof raw !== 'object') return 'unknown'
  const o = raw as Record<string, unknown>
  if (o.prompt && typeof o.prompt === 'object') {
    const nodes = o.prompt as Record<string, unknown>
    const first = Object.values(nodes)[0]
    if (first && typeof first === 'object' && 'class_type' in (first as object)) return 'api'
  }
  const values = Object.values(o)
  if (
    values.some(
      (v) => v && typeof v === 'object' && 'class_type' in (v as object) && 'inputs' in (v as object)
    )
  ) {
    return 'api'
  }
  if (Array.isArray(o.nodes) && (Array.isArray(o.links) || o.last_node_id != null)) return 'ui'
  return 'unknown'
}

/** 가져온 JSON을 제출 가능한 workflowTemplate으로 정규화한다. */
export function parseComfyWorkflowJson(text: string): WorkflowParseResult {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { ok: false, format: 'unknown', detail: '내용이 비어 있습니다.' }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch (e: any) {
    return { ok: false, format: 'unknown', detail: `JSON이 유효하지 않습니다. ${e?.message || e}` }
  }
  const format = detectWorkflowFormat(obj)
  if (format === 'ui') {
    return {
      ok: false,
      format,
      detail:
        'nodes/links가 있는 ComfyUI 화면 형식이어서 /prompt에 직접 제출할 수 없습니다. ComfyUI 메뉴에서 Save (API Format)을 선택한 뒤 붙여 넣으세요.'
    }
  }
  if (format === 'unknown') {
    return {
      ok: false,
      format,
      detail: 'Comfy API 워크플로 형식을 인식할 수 없습니다. class_type이 포함된 노드 그래프나 { "prompt": { ... } } 형식을 사용하세요.'
    }
  }
  const o = obj as Record<string, unknown>
  let payload: Record<string, unknown>
  if (o.prompt && typeof o.prompt === 'object') {
    payload = { ...o }
  } else {
    payload = { prompt: o }
  }
  if (!payload.client_id) payload.client_id = 'ai-cut'
  // JSON에 고정 플레이스홀더를 넣지 않고 도우미가 구조를 읽어 입력 매핑을 구한다.
  // 연결을 저장할 때 입력 매핑도 함께 저장한다.
  const bindings = guessInputMap(payload).bindings
  return {
    ok: true,
    format: 'api',
    template: JSON.stringify(payload, null, 2),
    payload,
    detail: 'API Format으로 인식했습니다. ‘도우미로 워크플로 분석’을 눌러 프롬프트와 참조 이미지를 연결할 노드를 확인하세요.',
    bindings
  }
}

function authHeaders(apiKey?: string, adapter?: AdapterConfig): Record<string, string> {
  return {
    Accept: 'application/json',
    ...buildAuthHeader(apiKey || '', {
      ...adapter,
      authPrefix: adapter?.authPrefix ?? ''
    })
  }
}

async function tryGetJson(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; data?: any; text?: string }> {
  try {
    const res = await providerHttp(url, { method: 'GET', headers, timeoutMs: 12_000 })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 200) }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text || 'null') }
    } catch {
      return { ok: false, status: res.status, text: text.slice(0, 200) }
    }
  } catch (e: any) {
    return { ok: false, status: 0, text: e?.message || String(e) }
  }
}

function normalizeListedFiles(
  data: unknown,
  dirHint: string,
  endpoint?: string
): DiscoveredWorkflow[] {
  const out: DiscoveredWorkflow[] = []
  const root = String(dirHint || '').replace(/^\/+|\/+$/g, '')
  const push = (pathRaw: string, size?: number, modified?: number) => {
    let rel = String(pathRaw || '').replace(/^\/+/, '')
    if (!rel) return
    if (/\.json$/i.test(rel)) {
      const name = rel.split('/').pop() || rel
      out.push({
        id: rel,
        name,
        path: rel,
        size,
        modified,
        source: 'userdata',
        root: root || undefined,
        endpoint
      })
    }
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        const path = String(o.path || o.name || o.file || '')
        push(path, typeof o.size === 'number' ? o.size : undefined, typeof o.modified === 'number' ? o.modified : undefined)
      }
    }
  }
  return out
}

/**
 * 로컬 ComfyUI 연결을 확인하고 저장된 워크플로의 목록을 요청한다.
 * 데스크톱 목록은 GET /userdata?dir=workflows를 시도하고 디렉터리가 없으면 안내한다.
 */
export async function discoverComfyWorkflows(opts: {
  baseUrl: string
  apiKey?: string
  adapter?: AdapterConfig
}): Promise<DiscoverResult> {
  const base = trimSlash(opts.baseUrl || '')
  const tried: string[] = []
  if (!base) {
    return {
      ok: false,
      reachable: false,
      workflows: [],
      message: 'ComfyUI 주소가 없습니다.',
      tried
    }
  }
  const headers = authHeaders(opts.apiKey, opts.adapter)

  // 연결 확인에는 /system_stats 또는 /object_info를 사용한다.
  let reachable = false
  for (const path of ['/system_stats', '/api/system_stats', '/object_info', '/api/object_info']) {
    const url = joinUrl(base, path)
    tried.push(`GET ${path}`)
    const res = await tryGetJson(url, headers)
    if (res.ok) {
      reachable = true
      break
    }
  }
  if (!reachable) {
    return {
      ok: false,
      reachable: false,
      workflows: [],
      message: 'ComfyUI에 연결하지 못했습니다(system_stats와 object_info 확인). 서비스가 실행 중이고 주소가 맞는지 확인하세요.',
      tried
    }
  }

  // 로컬 ComfyUI의 userdata 목록을 조회한다.
  const dirs = ['workflows', 'workflows/', 'user/default/workflows', 'default/workflows']
  const listPaths = ['/userdata', '/api/userdata', '/v2/userdata', '/api/v2/userdata']
  let workflows: DiscoveredWorkflow[] = []
  for (const listPath of listPaths) {
    for (const dir of dirs) {
      const q =
        listPath.includes('v2')
          ? `path=${encodeURIComponent(dir)}`
          : `dir=${encodeURIComponent(dir)}&recurse=true&full_info=true`
      const url = `${joinUrl(base, listPath)}?${q}`
      tried.push(`GET ${listPath}?dir=${dir}`)
      const res = await tryGetJson(url, headers)
      if (!res.ok) continue
      const found = normalizeListedFiles(res.data, dir.replace(/\/$/, ''), listPath)
      if (found.length) {
        workflows = found
        break
      }
    }
    if (workflows.length) break
  }

  // 일부 확장 기능의 /api/workflows도 시도한다.
  if (!workflows.length) {
    for (const path of ['/api/workflows', '/workflows']) {
      tried.push(`GET ${path}`)
      const res = await tryGetJson(joinUrl(base, path), headers)
      if (!res.ok) continue
      const list = res.data?.workflows || res.data?.data || res.data
      if (Array.isArray(list)) {
        workflows = list.map((item: any, i: number) => ({
          id: String(item.id || item.name || i),
          name: String(item.name || item.id || `workflow-${i}`),
          path: String(item.path || item.name || item.id || ''),
          source: 'api-workflows' as const
        }))
        if (workflows.length) break
      }
    }
  }

  if (workflows.length) {
    return {
      ok: true,
      reachable: true,
      workflows,
      message: `ComfyUI에서 워크플로 파일 ${workflows.length}개를 찾았습니다. 선택하면 파일 내용을 읽습니다. API Format인지 확인하세요.`,
      tried
    }
  }

  return {
    ok: true,
    reachable: true,
    workflows: [],
    message:
      'ComfyUI에 연결했지만 저장된 워크플로 목록을 가져오지 못했습니다. userdata/workflows가 비었거나 현재 버전에서 목록을 제공하지 않을 수 있습니다. API Format JSON을 붙여 넣거나 파일에서 가져오거나 워크플로 URL을 입력하세요.',
    tried
  }
}

function uniqStrings(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

/**
 * userdata에서 개별 워크플로 파일을 가져온다.
 * 목록 API가 디렉터리 기준 상대 경로를 반환할 수 있다.
 * 파일을 읽을 때 목록에 사용한 workflows 같은 디렉터리 접두사를 추가한다.
 */
export async function fetchComfyUserdataWorkflow(opts: {
  baseUrl: string
  path: string
  apiKey?: string
  adapter?: AdapterConfig
  /** DiscoveredWorkflow.root에서 가져온 목록 디렉터리 접두사 */
  root?: string
  /** DiscoveredWorkflow.endpoint에서 가져온 목록 API 경로 */
  endpoint?: string
  source?: DiscoveredWorkflow['source']
}): Promise<WorkflowParseResult> {
  const base = trimSlash(opts.baseUrl || '')
  const rel = String(opts.path || '').replace(/^\/+/, '')
  if (!base || !rel) return { ok: false, format: 'unknown', detail: '주소나 경로가 없습니다.' }
  const headers = authHeaders(opts.apiKey, opts.adapter)

  const roots = uniqStrings([opts.root || '', 'workflows', 'user/default/workflows', 'default/workflows', ''])
  const endpoints = uniqStrings([
    opts.endpoint || '',
    '/userdata',
    '/api/userdata',
    '/v2/userdata',
    '/api/v2/userdata'
  ])
  const relSeg = rel.split('/').map(encodeURIComponent).join('/')
  const relFlat = encodeURIComponent(rel)
  const fullSeg = (root: string) => (root ? `${root}/${rel}` : rel)

  const build = (ep: string, root: string) => {
    const prefix = root ? `${ep}/${root.split('/').map(encodeURIComponent).join('/')}` : ep
    return [`${prefix}/${relSeg}`, `${prefix}/${relFlat}`]
  }
  const knownRoot = opts.root || ''
  const knownEp = opts.endpoint || ''
  const otherRoots = roots.filter((r) => r !== knownRoot)
  const otherEps = endpoints.filter((e) => e !== knownEp)
  const candidates: string[] = []
  // 목록을 조회한 API와 디렉터리에서 두 가지 인코딩을 시도한다.
  if (knownEp) candidates.push(...build(knownEp, knownRoot))
  // 목록이 상대 경로를 반환하면 같은 API에 다른 접두사를 사용한다.
  if (knownEp) for (const r of otherRoots) candidates.push(...build(knownEp, r).slice(0, 1))
  // 기존 디렉터리를 유지하고 API 경로를 바꾼다.
  for (const e of otherEps) candidates.push(...build(e, knownRoot).slice(0, 1))
  // 일반적인 대체 경로는 /userdata/workflows 및 /api/userdata/workflows다.
  candidates.push(...build('/userdata', 'workflows').slice(0, 1), ...build('/api/userdata', 'workflows').slice(0, 1))
  // 일부 게이트웨이의 파일 경로는 ?file= 쿼리 매개변수로 받는다.
  for (const ep of endpoints) {
    for (const root of roots) {
      candidates.push(`${ep}?file=${encodeURIComponent(fullSeg(root))}`)
    }
  }
  // 일부 확장 기능은 워크플로를 /api/workflows/xx 리소스로 노출한다.
  if (opts.source === 'api-workflows' || !opts.source) {
    const id = encodeURIComponent(rel)
    candidates.push(`/api/workflows/${id}`, `/workflows/${id}`)
  }
  const tried: string[] = []
  let last = ''
  for (const path of uniqStrings(candidates)) {
    const url = joinUrl(base, path)
    const res = await tryGetJson(url, headers)
    tried.push(`${res.status || 'ERR'} ${url}`)
    if (!res.ok || res.data == null) {
      last = `${res.status || '응답 없음'} ${(res.text || '').slice(0, 80)}`.trim()
      continue
    }
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    return parseComfyWorkflowJson(text)
  }
  return {
    ok: false,
    format: 'unknown',
    tried,
    detail: `‘${rel}’ 워크플로 파일을 읽지 못했습니다. 경로 ${tried.length}개를 확인했습니다${last ? ` (마지막 응답 ${last})` : ''}. 확인한 주소와 결과를 공유하거나 API Format JSON을 붙여 넣거나 파일에서 가져오세요.`
  }
}

export async function fetchWorkflowFromUrl(url: string, apiKey?: string, adapter?: AdapterConfig): Promise<WorkflowParseResult> {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, format: 'unknown', detail: 'http(s) 워크플로 URL을 입력하세요.' }
  const res = await tryGetJson(u, authHeaders(apiKey, adapter))
  if (!res.ok) return { ok: false, format: 'unknown', detail: `다운로드에 실패했습니다. ${res.status} ${res.text || ''}` }
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  return parseComfyWorkflowJson(text)
}

export function readWorkflowFile(file: File): Promise<WorkflowParseResult> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(parseComfyWorkflowJson(String(reader.result || '')))
    reader.onerror = () => resolve({ ok: false, format: 'unknown', detail: '파일을 읽지 못했습니다.' })
    reader.readAsText(file)
  })
}
