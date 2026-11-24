import { t } from '@/i18n'
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
  | 'megapixels'
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
  durationUnit?: 'seconds' | 'frames'
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

export const COMFY_INPUT_ROLES = [
  'prompt', 'negative', 'image', 'imageEnd', 'mask', 'audio', 'seed', 'width', 'height',
  'length', 'megapixels', 'fps', 'steps', 'cfg', 'strength', 'batch'
] as const satisfies readonly ComfyInputRole[]

export function comfyRoleLabel(role: ComfyInputRole) {
  return t(`comfyInputRoles.${role}`)
}


const MEDIA_ROLES: ComfyInputRole[] = ['image', 'imageEnd', 'mask', 'audio']
const NUMERIC_ROLES: ComfyInputRole[] = ['seed', 'width', 'height', 'length', 'megapixels', 'fps', 'steps', 'cfg', 'strength', 'batch']

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
    lines.push(`#${id} ${ct} ${node._meta?.title ? `(${truncate(node._meta.title)}) ` : ''}${parts.length ? `{ ${parts.join(', ')} }` : '{}'}`)
  }
  if (entries.length > maxNodes) lines.push(`…（노드 ${entries.length - maxNodes}개 생략）`)
  return lines.join('\n')
}

// ComfyUI 그래프의 입력 바인딩을 분석하고 설명은 한국어로 반환한다.
const ANALYZE_SYSTEM = `You are a ComfyUI workflow analyzer. Given an API Format graph, identify the exact node field for each external input so the app can inject the value at generation time.

Available roles:
- prompt or negative: positive or negative prompt text.
- image: reference image or opening frame.
- imageEnd: closing frame only when the workflow accepts one.
- mask: mask image.
- audio: audio for workflows that accept it, such as talking avatars.
- seed, width, height: integer seed or dimensions.
- length: follow graph links to the scalar that controls generated duration. Supply durationUnit as seconds or frames. Exclude output FPS, loop counts, fixed sampling steps and connected fields. Omit it if uncertain.
- megapixels: resolution in megapixels, such as ResolutionSelector.megapixels.
- fps, steps, cfg, strength, batch: numerical inputs.

Rules:
1. Select only fields that need external values. Keep fixed settings such as model names, VAE, and sampler names.
2. Follow positive and negative links from KSampler, KSamplerAdvanced, SamplerCustom, and similar sampler nodes to the actual text nodes. Do not infer their roles from node order or names.
3. Use the actual text field: often text, but possibly prompt, value, string, text_g, or text_l.
4. Use the actual image field: often image, but possibly image_path, url, file, or upload.
5. Select a string or numeric input, never a link reference such as ←#6.
6. If a role cannot be located, omit it. Do not invent nodes or fields.
7. When there are multiple candidates for a role, choose the one actually used in the generation graph.

Write summaries and user-facing notes in natural, polite conversational Korean. Return JSON only:
{"kind":"text-to-image|image-to-image|text-to-video|image-to-video|audio-sync|unknown","summary":"One sentence explaining the workflow","bindings":[{"role":"prompt","nodeId":"6","field":"text","mediaMode":"upload","note":"Explanation"}],"notes":"User guidance, such as required models or reference images"}`

function toBinding(raw: any): ComfyInputBinding | null {
  const role = String(raw?.role || '').trim() as ComfyInputRole
  if (!COMFY_INPUT_ROLES.includes(role)) return null
  const nodeId = String(raw?.nodeId ?? raw?.node_id ?? raw?.node ?? '').trim()
  const field = String(raw?.field ?? raw?.input ?? '').trim()
  if (!nodeId || !field) return null
  const mode = String(raw?.mediaMode || raw?.imageMode || '').trim()
  return {
    role,
    nodeId,
    field,
    ...(raw?.durationUnit === 'seconds' || raw?.durationUnit === 'frames' ? { durationUnit: raw.durationUnit } : {}),
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
  const nodesMap = nodes as Record<string, any>
  const refs = Object.values(nodesMap || {}).flatMap(n => Object.entries(n?.inputs || {}))
    .filter(([key, value]) => /^ref_images\.ref_image_\d+$/.test(key) && Array.isArray(value))
    .sort(([a], [b]) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
  const orderedIds = [...new Set(refs.map(([, value]) => String((value as unknown[])[0])))]
  if (orderedIds.length) {
    const images = bindings.filter(b => b.role === 'image' && orderedIds.includes(b.nodeId))
    bindings.splice(0, bindings.length, ...bindings.filter(b => b.role !== 'image'), ...orderedIds.flatMap(id => images.filter(b => b.nodeId === id)))
  }
  const video = Object.values(nodesMap || {}).some((n) => /VideoCombine|SaveVideo|VideoConditioning|AudioConditioningT8/i.test(n?.class_type || ''))
  const durations = Object.entries(nodesMap || {}).filter(([, n]) => /duration|时长|秒数/i.test(n?._meta?.title || '') && typeof n?.inputs?.value === 'number')
  if (video && durations.length === 1) {
    bindings.push({ role: 'length', nodeId: durations[0][0], field: 'value', durationUnit: 'seconds' })
  }
  for (const [id, node] of Object.entries(nodesMap || {})) {
    if (/^CR Prompt Text$/i.test(node?.class_type || '') && typeof node.inputs?.prompt === 'string') mark('prompt', id, 'prompt')
    if (/^ResolutionSelector$/i.test(node?.class_type || '') && typeof node.inputs?.megapixels === 'number') mark('megapixels', id, 'megapixels')
  }
  return {
    version: 1,
    kind: video ? (bindings.some((b) => b.role === 'image') ? 'image-to-video' : 'text-to-video') : bindings.some((b) => b.role === 'image') ? 'image-to-image' : 'unknown',
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
    if (map && map.bindings.length) {
      const inferred = guessInputMap(payload).bindings.filter((b) => b.role === 'length' || b.role === 'megapixels')
      const roles = new Set(inferred.map((b) => b.role))
      return { map: { ...map, bindings: [...map.bindings.filter((b) => !roles.has(b.role)), ...inferred] } }
    }
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
      const base = `${comfyRoleLabel(b.role)} → #${b.nodeId}.${b.field}`
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
  megapixels?: number
  length?: number
  fps?: number
  steps?: number
  cfg?: number
  strength?: number
  batch?: number
  /** 역할별로 저장한 ComfyUI 업로드 파일명 */
  uploaded?: Partial<Record<ComfyInputRole, string>>
  uploadedImages?: Record<string, string>
}

/** Ref2VA는 실제 연결 순서로 슬롯을 복원하고 필요한 만큼 늘린다. 사용하지 않은 기본 이미지와 연결은 보존한다. */
export function fitComfyReferenceImages(payload: any, map: ComfyInputMap, count: number): ComfyInputMap {
  const imageBindings = map.bindings.filter(b => b.role === 'image')
  if (!Number.isSafeInteger(count) || count < 1 || count > 9) return map
  const nodes = payload?.prompt || payload
  const slots = Object.values(nodes || {}).flatMap((node: any) => {
    if (!/^MiniMaxH3AudioConditioning/i.test(node?.class_type || '') || !/^ref2va$/i.test(node?.inputs?.task_type || '')) return []
    return Object.keys(node.inputs).flatMap((key) => {
      const link = node.inputs[key]
      return /^ref_images\.ref_image_\d+$/.test(key) && Array.isArray(link)
        ? [{ inputs: node.inputs, key, nodeId: String(link[0]), index: Number(key.split('_').pop()) }]
        : []
    })
  })
  const ids = [...new Set(slots.sort((a, b) => a.index - b.index).map(slot => slot.nodeId))]
  if (!ids.length || imageBindings.some(b => !ids.includes(b.nodeId) || b.field !== 'image')) return map
  if (map.bindings.some(b => b.role !== 'image' && ids.includes(b.nodeId) && b.field === 'image')) return map
  const conditioningInputs = [...new Set(slots.map(slot => slot.inputs))]
  // 가져올 때 저장한 매핑 수를 상한으로 삼지 않고 실제 연결로 이전 매핑을 보완한다.
  if (conditioningInputs.some(inputs => {
    const local = slots.filter(slot => slot.inputs === inputs)
    return local.length !== ids.length || local.some((slot, index) =>
      slot.index !== index || slot.nodeId !== ids[index] || inputs[slot.key][1] !== 0)
  }) || ids.some(id => nodes[id]?.class_type !== 'LoadImage' || typeof nodes[id]?.inputs?.image !== 'string')) return map
  const ordered: ComfyInputBinding[] = ids.map(nodeId => ({ role: 'image', nodeId, field: 'image', mediaMode: 'upload' }))
  if (count > ids.length) {
    for (const inputs of conditioningInputs) {
      for (let i = ids.length; i < count; i++) {
        if (Object.hasOwn(inputs, `ref_images.ref_image_${i}`)) return map
      }
    }
    const allocated = new Set(Object.keys(nodes))
    let next = 1
    for (let i = ids.length; i < count; i++) {
      while (allocated.has(String(next))) next++
      const nodeId = String(next++)
      allocated.add(nodeId)
      nodes[nodeId] = { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: `Reference image ${i + 1}` } }
      for (const inputs of conditioningInputs) inputs[`ref_images.ref_image_${i}`] = [nodeId, 0]
      ordered.push({ role: 'image', nodeId, field: 'image', mediaMode: 'upload' })
    }
    return { ...map, bindings: [...map.bindings.filter(b => b.role !== 'image'), ...ordered] }
  }
  return { ...map, bindings: [...map.bindings.filter(b => b.role !== 'image'), ...ordered] }
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
      skipped.push(`${comfyRoleLabel(b.role)}의 노드 #${b.nodeId}이 없습니다.`)
      continue
    }
    const raw = b.role === 'image' && values.uploadedImages ? values.uploadedImages[`${b.nodeId}:${b.field}`] : (values as any)[b.role]
    if (raw === undefined || raw === null || raw === '') {
      skipped.push(`${comfyRoleLabel(b.role)} 입력이 이번 실행에 제공되지 않았습니다.`)
      continue
    }
    if (isMediaRole(b.role)) {
      const mode = b.mediaMode || 'upload'
      const uploaded = b.role === 'image' && values.uploadedImages ? raw : values.uploaded?.[b.role]
      const value = mode === 'upload' && uploaded ? uploaded : String(raw)
      ;(node.inputs as Record<string, any>)[b.field] = value
      writes.push(`${comfyRoleLabel(b.role)} → #${b.nodeId}.${b.field}`)
      continue
    }
    if (isNumericRole(b.role)) {
      if (b.role === 'length' && b.durationUnit !== 'seconds' && (b.durationUnit !== 'frames' || !values.fps)) {
        skipped.push('영상 길이의 단위나 프레임률이 빠져 있어요.')
        continue
      }
      const num = b.role === 'length' && b.durationUnit === 'frames' ? Math.round(Number(raw) * values.fps!) : Number(raw)
      if (!Number.isFinite(num)) {
        skipped.push(`${comfyRoleLabel(b.role)} 값이 숫자가 아닙니다.`)
        continue
      }
      ;(node.inputs as Record<string, any>)[b.field] = Number.isInteger(num) ? Math.round(num) : num
      writes.push(`${comfyRoleLabel(b.role)} → #${b.nodeId}.${b.field} = ${num}`)
      continue
    }
    ;(node.inputs as Record<string, any>)[b.field] = String(raw)
    writes.push(`${comfyRoleLabel(b.role)} → #${b.nodeId}.${b.field}`)
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
