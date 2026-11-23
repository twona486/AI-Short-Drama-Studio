/**
 * ComfyUI 工作流：校验 API Format、从本机 userdata 尝试列举、导入文件/URL。
 */

import { buildAuthHeader, providerHttp, type AdapterConfig } from '@/services/ai/adapters'
import { guessInputMap, type ComfyInputBinding } from '@/services/ai/comfyInputMap'

export type ComfyWorkflowFormat = 'api' | 'ui' | 'unknown'

export interface DiscoveredWorkflow {
  id: string
  name: string
  /** userdata 相对路径，如 workflows/foo.json 或 foo.json（取决于服务返回） */
  path: string
  size?: number
  modified?: number
  source: 'userdata' | 'api-workflows' | 'url' | 'file'
  /**
   * 列举成功的目录前缀（如 workflows）。列表接口常返回相对该目录的路径，
   * 读取文件时必须把这个前缀拼回去，否则 404。
   */
  root?: string
  /** 列举成功的接口（如 /userdata、/api/v2/userdata），读取时优先复用 */
  endpoint?: string
}

export interface DiscoverResult {
  ok: boolean
  reachable: boolean
  workflows: DiscoveredWorkflow[]
  /** 向用户说明探测结果（含「官方无统一列表」等诚实提示） */
  message: string
  tried: string[]
}

export interface WorkflowParseResult {
  ok: boolean
  format: ComfyWorkflowFormat
  /** 可写入 adapter.workflowTemplate 的字符串（API 提交体） */
  template?: string
  detail: string
  /** 调试用：实际请求过的完整 URL 与返回状态 */
  tried?: string[]
  /** 解析后的节点图，供助手分析输入映射 */
  payload?: any
  /** 规则初判的输入节点（助手分析前 / 助手不可用时的兜底） */
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

/** 把粘贴/导入的 JSON 规范成可提交的 workflowTemplate */
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
  // 不再往 JSON 里写死占位符：节点怎么接输入由助手读完结构后给出映射，
  // 保存时会一并把映射写进接入配置。
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
 * 探测本机 Comfy 是否可达，并尝试列举已保存工作流。
 * 官方桌面端通过 GET /userdata?dir=workflows 列举；无此目录时诚实说明。
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

  // 1) 连通性：/system_stats 或 /object_info
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

  // 2) userdata 列表（本地 Comfy 常见）
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

  // 3) 部分扩展：/api/workflows（非官方标配）
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
 * 拉取 userdata 中的单个工作流文件。
 * 关键：列表接口通常返回「相对目录」的路径（如 C图像-Zimage/xx.json），
 * 读取时必须把列举时用的目录前缀（workflows 等）拼回去，否则必然 404。
 */
export async function fetchComfyUserdataWorkflow(opts: {
  baseUrl: string
  path: string
  apiKey?: string
  adapter?: AdapterConfig
  /** 列举时成功的目录前缀（来自 DiscoveredWorkflow.root） */
  root?: string
  /** 列举时成功的接口（来自 DiscoveredWorkflow.endpoint） */
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
  // 1) 列举成功时的接口 + 目录（最可能命中），两种编码都试
  if (knownEp) candidates.push(...build(knownEp, knownRoot))
  // 2) 同一接口换目录前缀（列表返回相对路径的情况）
  if (knownEp) for (const r of otherRoots) candidates.push(...build(knownEp, r).slice(0, 1))
  // 3) 换接口、仍用已知目录
  for (const e of otherEps) candidates.push(...build(e, knownRoot).slice(0, 1))
  // 4) 最常见兜底：/userdata/workflows/... 与 /api/userdata/workflows/...
  candidates.push(...build('/userdata', 'workflows').slice(0, 1), ...build('/api/userdata', 'workflows').slice(0, 1))
  // 5) 查询串形式（部分网关 / 云 API 用 ?file= 而不是路径参数）
  for (const ep of endpoints) {
    for (const root of roots) {
      candidates.push(`${ep}?file=${encodeURIComponent(fullSeg(root))}`)
    }
  }
  // 6) 部分扩展把工作流当资源暴露（/api/workflows/xx）
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
