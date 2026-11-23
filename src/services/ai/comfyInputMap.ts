/**
 * ComfyUI 워크플로의 입력 매핑
 *
 * 워크플로마다 노드와 연결 구조가 다르다.
 * 고정 규칙으로 CLIPTextEncode나 LoadImage를 찾으면 비표준 워크플로의 입력을 놓칠 수 있다.
 * 그 경우 워크플로에 저장된 이전 프롬프트가 그대로 사용된다.
 * 언어 모델이 노드 구조를 읽고 매핑을 만들면 코드는 그 위치에 입력을 넣는다.
 * 모델을 사용할 수 없거나 분석에 실패할 때만 guessInputMap을 쓴다.
 */

import { parseJsonRobust } from '@/utils/jsonRepair'

export type ComfyInputRole =
  | 'prompt'
  | 'negative'
  | 'image'
  | 'imageEnd'
  | 'mask'
  | 'audio'
  | 'seed'
  | 'width'
  | 'height'
  | 'length'
  | 'fps'
  | 'steps'
  | 'cfg'
  | 'strength'
  | 'batch'

export type ComfyWorkflowKind =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'audio-sync'
  | 'unknown'

export interface ComfyInputBinding {
  role: ComfyInputRole
  /** API 형식 노드 ID(문자열 키) */
  nodeId: string
  /** 노드의 inputs 필드 이름 */
  field: string
  /** 이미지나 오디오에 upload는 업로드한 파일명, path는 로컬 경로, url은 URL을 사용한다. */
  mediaMode?: 'upload' | 'path' | 'url'
  /** 도우미의 참고 사항 */
  note?: string
}

export interface ComfyInputMap {
  version: 1
  kind: ComfyWorkflowKind
  summary: string
  bindings: ComfyInputBinding[]
  /** 필요한 모델이나 소재 등을 사용자에게 안내하는 설명 */
  notes?: string
  /** llm은 도우미 분석, heuristic은 규칙 기반 결과를 나타낸다. */
  source: 'llm' | 'heuristic'
  analyzedAt?: number
}

export const COMFY_ROLE_LABEL: Record<ComfyInputRole, string> = {
  prompt: '긍정 프롬프트',
  negative: '부정 프롬프트',
  image: '참조 이미지 / 시작 프레임',
  imageEnd: '끝 프레임',
  mask: '마스크',
  audio: '오디오',
  seed: '난수 시드',
  width: '너비',
  height: '높이',
  length: '길이 / 프레임 수',
  fps: '프레임률',
  steps: '샘플링 단계',
  cfg: 'CFG',
  strength: '재생성 강도',
  batch: '배치'
}

const MEDIA_ROLES: ComfyInputRole[] = ['image', 'imageEnd', 'mask', 'audio']
const NUMERIC_ROLES: ComfyInputRole[] = ['seed', 'width', 'height', 'length', 'fps', 'steps', 'cfg', 'strength', 'batch']

export function isMediaRole(role: ComfyInputRole): boolean {
  return MEDIA_ROLES.includes(role)
}

export function isNumericRole(role: ComfyInputRole): boolean {
  return NUMERIC_ROLES.includes(role)
}

function truncate(text: string, max = 80): string {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 노드 ID, 유형, 축약한 필드 값, 연결 참조를 분석용으로 정리한다.
 * 노드 구조를 식별하는 데 필요한 앞부분만 남긴다.
 */
export function summarizeWorkflow(payload: any, maxNodes = 160): string {
  const nodes = payload?.prompt && typeof payload.prompt === 'object' ? payload.prompt : payload
  if (!nodes || typeof nodes !== 'object') return ''
  const lines: string[] = []
  const entries = Object.entries(nodes as Record<string, any>)
  for (const [id, node] of entries.slice(0, maxNodes)) {
    if (!node || typeof node !== 'object') continue
    const ct = String(node.class_type || '?')
    const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {}
    const parts: string[] = []
    for (const [k, v] of Object.entries(inputs as Record<string, any>)) {
      if (Array.isArray(v)) parts.push(`${k}=←#${v[0]}`)
      else if (v == null) parts.push(`${k}=null`)
      else if (typeof v === 'string') parts.push(`${k}="${truncate(v, 60)}"`)
      else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
      else parts.push(`${k}=<${typeof v}>`)
    }
    lines.push(`#${id} ${ct} ${parts.length ? `{ ${parts.join(', ')} }` : '{}'}`)
  }
  if (entries.length > maxNodes) lines.push(`…（노드 ${entries.length - maxNodes}개 생략）`)
  return lines.join('\n')
}

// ComfyUI 그래프의 입력 바인딩을 분석하고 설명은 한국어로 반환한다.
const ANALYZE_SYSTEM = `You are a ComfyUI workflow analyzer. Given an API Format graph, identify the exact node field for each external input so the app can inject the value at generation time.

Supported roles:
- prompt: positive prompt text
- negative: negative prompt text
- image: reference image or first frame
- imageEnd: last frame for first-and-last-frame workflows
- mask: mask image
- audio: audio for digital-human narration
- seed: integer random seed
- width / height: integer dimensions
- length: duration or frame count
- fps / steps / cfg / strength / batch: numeric settings

Rules:
1. Select only fields that need external values. Keep fixed settings such as model names, VAE, and sampler names.
2. Follow positive and negative links from KSampler, KSamplerAdvanced, SamplerCustom, and similar sampler nodes to the actual text nodes. Do not infer their roles from node order or names.
3. Use the actual text field: often text, but possibly prompt, value, string, text_g, or text_l.
4. Use the actual image field: often image, but possibly image_path, url, file, or upload.
5. Select a string or numeric input, never a link reference such as ←#6.
6. If a role cannot be located, omit it. Do not invent nodes or fields.
7. When there are multiple candidates for a role, choose the one actually used in the generation graph.

Write summary, binding notes, and notes for the user in Korean (한국어). Return JSON only:
{"kind":"text-to-image|image-to-image|text-to-video|image-to-video|audio-sync|unknown","summary":"One sentence explaining the workflow","bindings":[{"role":"prompt","nodeId":"6","field":"text","mediaMode":"upload","note":"Explanation"}],"notes":"User guidance, such as required models or reference images"}`

function toBinding(raw: any): ComfyInputBinding | null {
  const role = String(raw?.role || '').trim() as ComfyInputRole
  if (!(role in COMFY_ROLE_LABEL)) return null
  const nodeId = String(raw?.nodeId ?? raw?.node_id ?? raw?.node ?? '').trim()
  const field = String(raw?.field ?? raw?.input ?? '').trim()
  if (!nodeId || !field) return null
  const mode = String(raw?.mediaMode || raw?.imageMode || '').trim()
  return {
    role,
    nodeId,
    field,
    ...(mode === 'upload' || mode === 'path' || mode === 'url' ? { mediaMode: mode } : {}),
    ...(raw?.note ? { note: String(raw.note).slice(0, 120) } : {})
  }
}

function parseMapJson(text: string): ComfyInputMap | null {
  let s = String(text || '').trim()
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim()
  const from = s.indexOf('{')
  const to = s.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  try {
    const obj = parseJsonRobust(s.slice(from, to + 1)) as any
    const bindings = Array.isArray(obj?.bindings)
      ? obj.bindings.map(toBinding).filter(Boolean as unknown as (b: ComfyInputBinding | null) => b is ComfyInputBinding)
      : []
    const kind = String(obj?.kind || 'unknown') as ComfyWorkflowKind
    return {
      version: 1,
      kind: [
        'text-to-image',
        'image-to-image',
        'text-to-video',
        'image-to-video',
        'audio-sync',
        'unknown'
      ].includes(kind)
        ? kind
        : 'unknown',
      summary: String(obj?.summary || '').slice(0, 160),
      bindings,
      ...(obj?.notes ? { notes: String(obj.notes).slice(0, 300) } : {}),
      source: 'llm',
      analyzedAt: Date.now()
    }
  } catch {
    return null
  }
}

/** 분석을 사용할 수 없으면 샘플러 연결과 LoadImage 계열 노드에서 입력을 추정한다. */
export function guessInputMap(payload: any): ComfyInputMap {
  const nodes = payload?.prompt && typeof payload.prompt === 'object' ? payload.prompt : payload
  const bindings: ComfyInputBinding[] = []
  const seen = new Set<string>()
  const mark = (role: ComfyInputRole, nodeId: string, field: string) => {
    const key = `${role}:${nodeId}`
    if (seen.has(key)) return
    seen.add(key)
    bindings.push({ role, nodeId, field })
  }
  if (nodes && typeof nodes === 'object') {
    const map = nodes as Record<string, any>
    // 샘플러의 연결을 역추적한다.
    for (const node of Object.values(map)) {
      const inputs = node?.inputs
      if (!inputs || typeof inputs !== 'object') continue
      if (!('positive' in inputs) && !('negative' in inputs)) continue
      for (const [role, slot] of [
        ['prompt', 'positive'],
        ['negative', 'negative']
      ] as const) {
        const ref = (inputs as any)[slot]
        const srcId = Array.isArray(ref) ? String(ref[0]) : ''
        if (!srcId) continue
        const target = map[srcId]
        if (target?.inputs && typeof target.inputs === 'object' && 'text' in target.inputs) {
          mark(role, srcId, 'text')
        }
      }
    }
    // 대체 경로로 CLIPTextEncode가 나타나는 순서를 사용한다.
    if (!bindings.length) {
      const encoders = Object.entries(map).filter(
        ([, n]) =>
          /clip.*text.*encode|textencode|text.?encoder/i.test(String(n?.class_type || '')) &&
          n?.inputs &&
          'text' in (n.inputs as object)
      )
      if (encoders.length) mark('prompt', encoders[0][0], 'text')
      if (encoders.length > 1) mark('negative', encoders[1][0], 'text')
    }
    // 이미지 또는 오디오 입력을 찾는다.
    for (const [id, node] of Object.entries(map)) {
      const ct = String(node?.class_type || '')
      const inputs = node?.inputs
      if (!inputs || typeof inputs !== 'object') continue
      if (/loadimage|load.?image|image.?load/i.test(ct)) {
        if ('image' in (inputs as object)) mark('image', id, 'image')
      } else if (/loadaudio|load.?audio|vhs_loadaudio/i.test(ct)) {
        if ('audio' in (inputs as object)) mark('audio', id, 'audio')
      } else if (/load.*mask|mask.*load/i.test(ct)) {
        if ('mask' in (inputs as object)) mark('mask', id, 'mask')
      }
    }
  }
  return {
    version: 1,
    kind: bindings.some((b) => b.role === 'image') ? 'image-to-image' : 'unknown',
    summary: bindings.length ? '규칙으로 추정한 입력 매핑(도우미 분석을 적용할 수 없음)' : '값을 주입할 수 있는 입력 노드를 찾지 못했습니다.',
    bindings,
    source: 'heuristic',
    analyzedAt: Date.now()
  }
}

/** 도우미가 입력 매핑을 만들며 실패하면 규칙으로 추정한다. */
export async function analyzeWorkflowWithLlm(
  payload: any,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ map: ComfyInputMap; error?: string }> {
  const brief = summarizeWorkflow(payload)
  if (!brief) return { map: guessInputMap(payload), error: '워크플로가 비어 있어 분석할 수 없습니다.' }
  try {
    // 어댑터와 런타임 사이의 정적 순환 참조를 막기 위해 나중에 가져온다.
    const { callLLM } = await import('./client')
    const resp = await callLLM({
      messages: [
        { role: 'system', content: ANALYZE_SYSTEM },
        {
          role: 'user',
          content: `Node graph:\n${brief}\n\nReturn the input mapping JSON.`
        }
      ],
      temperature: 0,
      jsonMode: true,
      maxTokens: 900,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 60_000
    })
    const map = parseMapJson(resp.content || '')
    if (map && map.bindings.length) return { map }
    return {
      map: guessInputMap(payload),
      error: map ? '도우미가 값을 주입할 입력 노드를 찾지 못했습니다.' : '도우미 응답을 입력 매핑으로 해석할 수 없습니다.'
    }
  } catch (e: any) {
    if (opts.signal?.aborted) throw e
    return { map: guessInputMap(payload), error: e?.message || String(e) }
  }
}

/** 역직렬화할 때 완전한 바인딩만 연결 설정에 저장한다. */
export function sanitizeInputMap(raw: unknown): ComfyInputMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, any>
  const bindings = Array.isArray(o.bindings)
    ? o.bindings
        .map((b: any) => toBinding(b))
        .filter((b: ComfyInputBinding | null): b is ComfyInputBinding => Boolean(b))
    : []
  const kind = String(o.kind || 'unknown') as ComfyWorkflowKind
  return {
    version: 1,
    kind: [
      'text-to-image',
      'image-to-image',
      'text-to-video',
      'image-to-video',
      'audio-sync',
      'unknown'
    ].includes(kind)
      ? kind
      : 'unknown',
    summary: String(o.summary || '').slice(0, 160),
    bindings,
    ...(o.notes ? { notes: String(o.notes).slice(0, 300) } : {}),
    source: o.source === 'heuristic' ? 'heuristic' : 'llm',
    ...(typeof o.analyzedAt === 'number' ? { analyzedAt: o.analyzedAt } : {})
  }
}

/** 존재하지 않는 노드나 필드를 가리키는 바인딩을 제거한다. */
export function validateInputMap(payload: any, map: ComfyInputMap): ComfyInputMap {
  const nodes = payload?.prompt && typeof payload.prompt === 'object' ? payload.prompt : payload
  if (!nodes || typeof nodes !== 'object') return { ...map, bindings: [] }
  const kept = map.bindings.filter((b) => {
    const node = (nodes as Record<string, any>)[b.nodeId]
    if (!node || typeof node !== 'object') return false
    const inputs = node.inputs
    if (!inputs || typeof inputs !== 'object') return false
    if (!(b.field in (inputs as object))) return false
    const cur = (inputs as Record<string, any>)[b.field]
    return typeof cur === 'string' || typeof cur === 'number' || cur === null || cur === undefined
  })
  return { ...map, bindings: kept }
}

export function describeInputMap(map: ComfyInputMap): string {
  if (!map?.bindings?.length) return '주입할 수 있는 입력이 없습니다.'
  return map.bindings
    .map((b) => {
      const base = `${COMFY_ROLE_LABEL[b.role]} → #${b.nodeId}.${b.field}`
      return b.note ? `${base}（${b.note}）` : base
    })
    .join('；')
}

const KIND_LABEL: Record<ComfyWorkflowKind, string> = {
  'text-to-image': '텍스트→이미지',
  'image-to-image': '이미지→이미지',
  'text-to-video': '텍스트→영상',
  'image-to-video': '이미지→영상',
  'audio-sync': '오디오 기반',
  unknown: '인식되지 않음'
}

export function describeWorkflowKind(kind: ComfyWorkflowKind): string {
  return KIND_LABEL[kind] || '인식되지 않음'
}

export interface ComfyInjectValues {
  prompt?: string
  negative?: string
  image?: string
  imageEnd?: string
  mask?: string
  audio?: string
  seed?: number
  width?: number
  height?: number
  length?: number
  fps?: number
  steps?: number
  cfg?: number
  strength?: number
  batch?: number
  /** 역할별로 저장한 ComfyUI 업로드 파일명 */
  uploaded?: Partial<Record<ComfyInputRole, string>>
}

/**
 * 매핑에서 지정한 노드에 이번 생성의 입력값을 넣는다.
 * 화면에 표시할 실제 입력 수와 건너뛴 사유를 반환한다.
 */
export function applyComfyInputs(
  payload: any,
  map: ComfyInputMap | undefined,
  values: ComfyInjectValues
): { writes: string[]; skipped: string[] } {
  const writes: string[] = []
  const skipped: string[] = []
  const list = map?.bindings || []
  if (!list.length) {
    skipped.push('입력 매핑이 없어 워크플로에 설정된 고정값을 사용합니다.')
    return { writes, skipped }
  }
  const nodes = payload?.prompt && typeof payload.prompt === 'object' ? payload.prompt : payload
  if (!nodes || typeof nodes !== 'object') {
    skipped.push('워크플로 노드 그래프가 유효하지 않습니다.')
    return { writes, skipped }
  }
  for (const b of list) {
    const node = (nodes as Record<string, any>)[b.nodeId]
    if (!node?.inputs || typeof node.inputs !== 'object') {
      skipped.push(`${COMFY_ROLE_LABEL[b.role]}의 노드 #${b.nodeId}이 없습니다.`)
      continue
    }
    const raw = (values as any)[b.role]
    if (raw === undefined || raw === null || raw === '') {
      skipped.push(`${COMFY_ROLE_LABEL[b.role]} 입력이 이번 실행에 제공되지 않았습니다.`)
      continue
    }
    if (isMediaRole(b.role)) {
      const mode = b.mediaMode || 'upload'
      const uploaded = values.uploaded?.[b.role]
      const value = mode === 'upload' && uploaded ? uploaded : String(raw)
      ;(node.inputs as Record<string, any>)[b.field] = value
      writes.push(`${COMFY_ROLE_LABEL[b.role]} → #${b.nodeId}.${b.field}`)
      continue
    }
    if (isNumericRole(b.role)) {
      const num = Number(raw)
      if (!Number.isFinite(num)) {
        skipped.push(`${COMFY_ROLE_LABEL[b.role]} 값이 숫자가 아닙니다.`)
        continue
      }
      ;(node.inputs as Record<string, any>)[b.field] = Number.isInteger(num) ? Math.round(num) : num
      writes.push(`${COMFY_ROLE_LABEL[b.role]} → #${b.nodeId}.${b.field} = ${num}`)
      continue
    }
    ;(node.inputs as Record<string, any>)[b.field] = String(raw)
    writes.push(`${COMFY_ROLE_LABEL[b.role]} → #${b.nodeId}.${b.field}`)
  }
  return { writes, skipped }
}

/** 생성 전에 필수 역할이 빠졌는지 확인한다. */
export function missingRoles(map: ComfyInputMap | undefined): ComfyInputRole[] {
  const roles = new Set((map?.bindings || []).map((b) => b.role))
  const missing: ComfyInputRole[] = []
  if (!roles.has('prompt')) missing.push('prompt')
  return missing
}
