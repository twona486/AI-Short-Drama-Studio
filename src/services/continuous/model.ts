import { z } from 'zod'
import { parseJsonRobust } from '@/utils/jsonRepair'

const text = z.string().trim().min(1)
export const capturePlanSchema = z.object({
  title: text,
  aesthetic: text,
  assets: z.array(z.object({ id: text, name: text, kind: z.enum(['character', 'prop', 'scene']), prompt: text })).min(1),
  scenes: z.array(z.object({
    id: text, name: text, sourceText: text, assetIds: z.array(text).min(1),
    openingPrompt: text,
    segments: z.array(z.object({
      title: text, duration: z.number().int().min(6), prompt: text,
      startState: text, endState: text, sound: text,
      dialogue: z.array(z.object({ speaker: text, text, delivery: text }))
    })).min(1)
  })).min(1)
})
export type CapturePlan = z.infer<typeof capturePlanSchema>
export interface CaptureState {
  id: string
  source: string
  sourceFromCanvas?: boolean
  plan: CapturePlan
  model: import('@/types').VideoGenModel
  profileId?: string
  modelName: string
  maxSeconds: number
  aspectRatio: import('@/types').AspectRatio
  phase: 'assets' | 'videos' | 'complete'
  /** Next scene whose asset costs have not been approved. */
  sceneIndex: number
  approvedScenes: string[]
  videosApproved: boolean
  assetNodes: Record<string, string>
  openingNodes: Record<string, string>
  videoNodes: Record<string, string>
  tailAssets: Record<string, { videoAssetId: string; assetId: string }>
  /** 생성 전 대사 검토를 마친 내용의 요약값이다. 이미지와 영상의 검토 결과를 따로 기록한다. */
  dialoguePreflight?: Partial<Record<'images' | 'videos', string>>
}
export const compact = (s: string) => s.replace(/\s+/g, '')
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function fieldText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function pick(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value != null && value !== '') return value
  }
  return undefined
}

function hasPlanFields(item: Record<string, unknown>): boolean {
  return pick(item, ['scenes', '场景', '场次', 'assets', '资产', 'aesthetic', '画风', '风格']) != null
}

function planBody(raw: Record<string, unknown>): Record<string, unknown> {
  if (hasPlanFields(raw)) return raw
  for (const key of ['plan', 'capturePlan', 'capture', 'data', 'result', 'output', 'json', 'content']) {
    let nested: unknown = raw[key]
    if (typeof nested === 'string') {
      try { nested = parseJsonRobust(nested) } catch { nested = undefined }
    }
    const body = asRecord(nested)
    if (body && hasPlanFields(body)) return { ...body, title: body.title ?? body['标题'] ?? raw.title ?? raw['标题'] }
  }
  return raw
}

const PLAN_KEYS = new Set([
  'title', 'aesthetic', 'style', 'look', 'visualStyle', 'assets', 'assetList', 'characters', 'props', 'locations', 'places', 'scenes', 'sequences',
  'plan', 'capturePlan', 'capture', 'data', 'result', 'output', 'json', 'content',
  'id', 'name', 'kind', 'type', 'category', 'prompt', 'description', 'desc',
  'sourceText', 'source', 'script', 'text', 'assetIds', 'refs', 'openingPrompt', 'opening', 'firstFrame',
  'segments', 'shots', 'clips', 'duration', 'seconds', 'startState', 'start', 'endState', 'end', 'sound', 'audio',
  'dialogue', 'lines', 'speaker', 'role', 'delivery', 'tone', 'line', 'character', 'prop', 'scene'
])

function restoreKey(key: string): string {
  if (PLAN_KEYS.has(key)) return key
  const mapped = key.replace(/4/g, 'a').replace(/3/g, 'e').replace(/1/g, 'i').replace(/0/g, 'o').replace(/5/g, 's').replace(/7/g, 't')
  return PLAN_KEYS.has(mapped) ? mapped : key
}

function restoreLeetKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreLeetKeys)
  const row = asRecord(value)
  if (!row) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(row)) out[restoreKey(key)] = restoreLeetKeys(child)
  return out
}

function assetKind(value: unknown, fallback?: 'character' | 'prop' | 'scene') {
  const known: Record<string, 'character' | 'prop' | 'scene'> = {
    character: 'character', char: 'character', person: 'character', cast: 'character',
    人物: 'character', 角色: 'character', 演员: 'character',
    prop: 'prop', item: 'prop', 道具: 'prop', 物品: 'prop', 器物: 'prop',
    scene: 'scene', location: 'scene', place: 'scene', set: 'scene',
    场景: 'scene', 地点: 'scene', 环境: 'scene', 布景: 'scene',
    costume: 'character', outfit: 'character', wardrobe: 'character', clothing: 'character', look: 'character',
    服装: 'character', 造型: 'character', 衣着: 'character', 换装: 'character'
  }
  const folded = fieldText(value).toLowerCase().replace(/\s+/g, '').replace(/4/g, 'a').replace(/3/g, 'e').replace(/1/g, 'i').replace(/0/g, 'o')
  return known[folded] ?? fallback
}

function inferAssetKind(name: string, prompt: string): 'character' | 'prop' | 'scene' {
  const text = `${name}\n${prompt}`
  if (/场景|地点|空镜|环境|布景|室内|室外|建筑|街道|房间/.test(text) && !/四视图|三视图|人脸|岁/.test(text)) return 'scene'
  if (/道具|物品|武器|器物/.test(text) && !/人物|角色|人脸|岁/.test(name)) return 'prop'
  return 'character'
}

function normalizeAssets(body: Record<string, unknown>) {
  const groups: Array<[unknown, 'character' | 'prop' | 'scene' | undefined]> = []
  const direct = pick(body, ['assets', '资产', 'assetList'])
  if (Array.isArray(direct)) groups.push([direct, undefined])
  else {
    for (const [keys, kind] of [
      [['characters', '角色', '人物'], 'character'],
      [['props', '道具'], 'prop'],
      [['locations', 'places', '场景资产'], 'scene']
    ] as const) {
      const list = pick(body, [...keys])
      if (Array.isArray(list)) groups.push([list, kind])
    }
  }
  const assets = groups.flatMap(([list, fallback]) => (list as unknown[]).map(item => {
    const row = asRecord(item)
    if (!row) return undefined
    const name = fieldText(pick(row, ['name', '名称', 'title', '角色名']))
    const prompt = fieldText(pick(row, ['prompt', '提示词', 'description', '描述', 'desc'])) || name
    const rawKind = pick(row, ['kind', 'type', '类型', 'category'])
    return {
      id: fieldText(pick(row, ['id', 'ID'])) || name,
      name,
      kind: assetKind(rawKind, fallback) || inferAssetKind(`${fieldText(rawKind)}\n${name}`, prompt),
      prompt
    }
  })).filter((item): item is NonNullable<typeof item> => Boolean(item?.name))
  assets.forEach((asset, index) => { if (!asset.id) asset.id = `asset-${index + 1}` })
  return assets.length ? assets : undefined
}

function normalizeDuration(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  const matched = fieldText(value).match(/\d+/)
  return matched ? Number(matched[0]) : value
}

function normalizeDialogue(value: unknown) {
  const lines = typeof value === 'string' ? value.split(/\n+/) : Array.isArray(value) ? value : []
  return lines.flatMap(item => {
    if (typeof item === 'string') {
      const matched = item.match(/^([^：:]{1,16})[：:](.+)$/)
      return matched ? [{ speaker: matched[1].trim(), text: matched[2].trim(), delivery: '자연스러운 말투' }] : []
    }
    const row = asRecord(item)
    if (!row) return []
    const speaker = fieldText(pick(row, ['speaker', 'name', '说话人', '角色', 'role']))
    const text = fieldText(pick(row, ['text', 'line', '台词', 'content', '对白']))
    if (!speaker || !text) return []
    return [{ speaker, text, delivery: fieldText(pick(row, ['delivery', 'tone', '语气', '表演'])) || '자연스러운 말투' }]
  })
}

function normalizeScenes(body: Record<string, unknown>, assets: { id: string; name: string }[] | undefined) {
  const list = pick(body, ['scenes', '场景', '场次', 'sequences'])
  if (!Array.isArray(list)) return undefined
  const byName = new Map((assets ?? []).map(asset => [compact(asset.name), asset.id]))
  return list.flatMap((item, index) => {
    const row = asRecord(item)
    if (!row) return []
    const dialogueOf = (segments: Array<Record<string, unknown>>) => segments.flatMap(segment => normalizeDialogue(segment.dialogue))
    const segments = (Array.isArray(pick(row, ['segments', 'shots', '镜头', '子镜头', 'clips'])) ? pick(row, ['segments', 'shots', '镜头', '子镜头', 'clips']) as unknown[] : []).flatMap(segment => {
      const shot = asRecord(segment)
      if (!shot) return []
      const dialogue = normalizeDialogue(pick(shot, ['dialogue', 'lines', '对白', '台词']))
      const title = fieldText(pick(shot, ['title', '标题', 'name'])) || `샷 ${index + 1}`
      return [{
        title,
        duration: normalizeDuration(pick(shot, ['duration', 'seconds', '时长', '秒'])),
        prompt: fieldText(pick(shot, ['prompt', '提示词', 'description', '描述'])) || title,
        startState: fieldText(pick(shot, ['startState', '起幅', 'start'])) || '클립 시작',
        endState: fieldText(pick(shot, ['endState', '落幅', 'end'])) || '클립 종료',
        sound: fieldText(pick(shot, ['sound', '环境音', 'audio'])) || '환경음',
        dialogue
      }]
    })
    const rawIds = pick(row, ['assetIds', 'assets', '引用', 'refs'])
    const assetIds = (Array.isArray(rawIds) ? rawIds : []).flatMap(ref => {
      const id = typeof ref === 'string' || typeof ref === 'number' ? fieldText(ref) : fieldText(pick(asRecord(ref) || {}, ['id', 'name', '名称']))
      return id ? [byName.get(compact(id)) || id] : []
    })
    const name = fieldText(pick(row, ['name', '名称', 'title', '场景名'])) || `장면 ${index + 1}`
    const sourceText = fieldText(pick(row, ['sourceText', 'source', '原文', 'script', 'text', 'content']))
      || dialogueOf(segments).map(line => `${line.speaker}：${line.text}`).join('\n')
      || name
    return [{
      id: fieldText(pick(row, ['id'])) || `scene-${index + 1}`,
      name,
      sourceText,
      assetIds,
      openingPrompt: fieldText(pick(row, ['openingPrompt', 'opening', '起始画面', 'firstFrame'])) || segments[0]?.startState || '장면의 시작 프레임',
      segments
    }]
  })
}

function formatPlanError(error: z.ZodError): string {
  const parts = error.issues.slice(0, 4).map(issue => {
    const path = issue.path.map(String).join('.') || '최상위 객체'
    if (issue.code === 'invalid_type') return `${path} 항목이 빠졌거나 자료형이 달라요.`
    if (issue.code === 'too_small') return `${path} 길이 또는 항목 수가 부족해요.`
    return `${path} 형식이 맞지 않아요.`
  })
  return `계획 형식이 맞지 않아요. ${parts.join(' ')} 최상위 필드는 title, aesthetic, assets, scenes를 사용해 주세요.`
}

function normalizeCapturePlan(raw: unknown) {
  const root = asRecord(restoreLeetKeys(raw))
  if (!root) throw Error('계획을 JSON 객체로 받지 못했어요. title, aesthetic, assets, scenes를 포함해야 해요.')
  const body = planBody(root)
  const assets = normalizeAssets(body)
  const scenes = normalizeScenes(body, assets)
  if (!assets || !scenes?.length) {
    const keys = Object.keys(body).slice(0, 12).join(', ') || '없음'
    throw Error(`계획에 스타일, 에셋 또는 장면이 빠졌어요. title, aesthetic, assets, scenes를 최상위 필드로 사용해 주세요. 받은 필드: ${keys}`)
  }
  return {
    title: fieldText(pick(body, ['title', '标题', 'name'])) || fieldText(pick(root, ['title', '标题'])) || '연속 촬영',
    aesthetic: fieldText(pick(body, ['aesthetic', 'style', 'look', 'visualStyle', '画风', '风格', '视觉风格'])) || fieldText(pick(root, ['aesthetic', '画风', '风格'])) || '대본에서 지정한 스타일',
    assets,
    scenes
  }
}

export function validateCapturePlan(raw: unknown, max: number): CapturePlan {
  const checked = capturePlanSchema.safeParse(normalizeCapturePlan(raw))
  if (!checked.success) throw Error(formatPlanError(checked.error))
  const p = checked.data
  const ids = p.assets.map(a => a.id)
  if (new Set(ids).size !== ids.length || new Set(p.scenes.map(s => s.id)).size !== p.scenes.length) throw Error('에셋이나 장면 ID가 중복돼요.')
  const names = p.assets.map(a => `${a.kind}:${compact(a.name)}`)
  if (new Set(names).size !== names.length) throw Error('같은 에셋이 여러 번 정의돼 있어요. 여러 장면에서 같은 에셋 ID를 사용하세요.')
  if (ids.some(id => !p.scenes.some(s => s.assetIds.includes(id)))) throw Error('어느 장면에서도 사용하지 않는 에셋이 있어요. 목록에서 빼 주세요.')
  for (const scene of p.scenes) {
    if (scene.assetIds.some(id => !ids.includes(id))) throw Error(`‘${scene.name}’에 정의되지 않은 에셋이 있어요.`)
    if (!scene.assetIds.some(id => p.assets.find(a => a.id === id)?.kind === 'scene')) throw Error(`‘${scene.name}’에 장면 에셋이 빠졌어요.`)
    if (scene.assetIds.length > 9) throw Error(`‘${scene.name}’에 참조 에셋이 9장을 넘어요. 실제로 나오는 소품의 참조를 합쳐 주세요.`)
    for (const seg of scene.segments) {
      if (seg.duration > max) throw Error(`‘${scene.name}’에 모델의 ${max}초 제한을 넘는 클립이 있어요.`)
    }
  }
  return p
}
export function planSeconds(p: CapturePlan) { return p.scenes.reduce((n, s) => n + s.segments.reduce((sum, seg) => sum + seg.duration, 0), 0) }
export function isCaptureApproval(text: string) { return /^(继续|确认|确认继续|开始生成|开始拍摄|开始生成视频|重试|继续拍摄|계속|계속해|계속해 주세요|확인|확인했어요|생성 시작|촬영 시작|촬영 계속|다시 시도)[。！.!\s]*$/.test(text.trim()) }

function verdictFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (/^(true|yes|ok|pass|passed|通过|合格)$/.test(text)) return true
  if (/^(false|no|fail|failed|不通过|未通过|不合格)$/.test(text)) return false
  return undefined
}

function verdictReason(item: Record<string, unknown>): string {
  const direct = item.reason ?? item.message ?? item.detail ?? item.comment ?? item['原因'] ?? item['问题']
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return direct.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('；')
  if (Array.isArray(item.issues)) return item.issues.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('；')
  return ''
}

export interface ShotIssue {
  scene: number
  index: number
  reason: string
}

function positiveInt(value: unknown): number | undefined {
  const text = fieldText(value).replace(/第|场景|镜头|场次|场|镜/g, '')
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

/** 샷별 검토 결과다. 전체의 ok/reason만으로 계획을 거부하지 않는다. 샷을 찾을 수 없으면 unlocated에 넣고 스토리보드를 보존한다. */
export function parseShotReview(content: string): { shots: ShotIssue[]; unlocated: string } | null {
  let parsed: unknown
  try { parsed = parseJsonRobust(content) } catch { return null }
  const root = asRecord(parsed)
  if (!root) return null
  const records = [root]
  for (const key of ['review', 'result', 'data']) {
    const nested = asRecord(root[key])
    if (nested) records.push(nested)
  }
  for (const record of records) {
    const list = pick(record, ['shots', 'issues', '镜头', '问题列表'])
    if (!Array.isArray(list)) continue
    const shots: ShotIssue[] = []
    for (const item of list) {
      const row = asRecord(item)
      if (!row) continue
      const scene = positiveInt(pick(row, ['scene', 'sceneIndex', '场', '场景', '场次']))
      const index = positiveInt(pick(row, ['index', 'shot', 'segment', '镜头', '镜']))
      const ok = verdictFlag(row.ok ?? row.pass ?? row.passed ?? row['通过'] ?? row['是否通过'])
      const reason = verdictReason(row).trim()
      if (ok === true || !scene || !index || !reason) continue
      shots.push({ scene, index, reason })
    }
    return { shots, unlocated: '' }
  }
  for (const record of records) {
    const ok = verdictFlag(record.ok ?? record.pass ?? record.passed ?? record.approved ?? record['通过'] ?? record['是否通过'])
    if (ok === true) return { shots: [], unlocated: '' }
    if (ok === false) {
      const reason = verdictReason(record).trim()
      if (reason) return { shots: [], unlocated: reason }
    }
  }
  return null
}

/** ok/reason으로 판정을 읽는다. 계획 JSON, 빠진 필드, 중국어 키도 동일한 구조로 정리하고 통과 판정의 reason은 생략할 수 있다. */
export function parseCaptureVerdict(content: string): { ok: boolean; reason: string } | null {
  let parsed: unknown
  try { parsed = parseJsonRobust(content) } catch { parsed = undefined }
  const candidates: unknown[] = [parsed]
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['verdict', 'review', 'result', 'data']) {
      const nested = (parsed as Record<string, unknown>)[key]
      if (nested && typeof nested === 'object') candidates.push(nested)
    }
  }
  for (const match of String(content || '').matchAll(/\{[^{}]*"(?:ok|pass|passed|approved|通过)"\s*:[\s\S]*?\}/gi)) {
    try { candidates.push(JSON.parse(match[0])) } catch { /* 객체가 불완전하면 다음 후보를 확인해요. */ }
  }
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const ok = verdictFlag(record.ok ?? record.pass ?? record.passed ?? record.approved ?? record['通过'] ?? record['是否通过'])
    if (ok === undefined) continue
    const reason = verdictReason(record).trim()
    if (!ok && !reason) continue
    return { ok, reason }
  }
  return null
}
