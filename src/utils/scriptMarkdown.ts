import type { Project, Scene, Script, Shot, Subject } from '@/types'

const CAM: Record<Shot['cameraMovement'], string> = {
  push: '밀기',
  pull: '당기기',
  pan: '팬',
  tilt: '틸트',
  static: '고정',
  orbit: '회전'
}

const EMPTY_COPY = '*본문이 비어 있어요. 오른쪽에 직접 입력하거나 아래에서 대본을 작성하세요.*'

// 파서 호환. 기존 중국어 Markdown과 한국어 및 영어 제목을 함께 인식한다.
const PROJECT_HEADINGS = {
  body: /^(?:文案|본문|Script body|Copy)(?:$|\s|[：:])/i,
  aesthetic: /^(?:整体氛围|전체 분위기|Overall mood|Aesthetic)/i,
  people: /^(?:人物|캐릭터|등장인물|Characters|Cast|인물)/i,
  scenes: /^(?:场景(?!\s*[一二三四五六七八九十百0-9])|장면(?!\s*\d)|Scenes?|Locations?)(?:$|\s|[：:])/i,
  shots: /^(?:分镜|스토리보드|Storyboard|Shots)/i
}
const SHOT_HEADING = /^(?:第\s*|(?:샷|shot)\s*)(\d+)(?:\s*镜\s*(.*)|(?:\s*[:：.—-]\s*|\s+)?(.*))$/i

const CAM_REV: Record<string, Shot['cameraMovement']> = {
  推: 'push',
  拉: 'pull',
  摇: 'pan',
  移: 'tilt',
  固定: 'static',
  环绕: 'orbit',
  밀기: 'push',
  당기기: 'pull',
  팬: 'pan',
  틸트: 'tilt',
  고정: 'static',
  회전: 'orbit',
  push: 'push',
  pull: 'pull',
  pan: 'pan',
  tilt: 'tilt',
  static: 'static',
  orbit: 'orbit'
}

/** 프로젝트의 대본과 제작 데이터를 하나의 Markdown 문서로 구성한다. */
export function composeProjectPlayMarkdown(p: Project): string {
  const script = p.script
  const parts: string[] = []
  parts.push(`# ${script?.topic || p.name || '대본'}`)
  parts.push('')

  const raw = (script?.content || '').trim()
  if (raw) {
    if (/^#{1,6}\s/m.test(raw)) {
      parts.push(raw)
    } else {
      parts.push('## 본문')
      parts.push('')
      parts.push(raw)
    }
    parts.push('')
  } else {
    parts.push('## 본문')
    parts.push('')
    parts.push(EMPTY_COPY)
    parts.push('')
  }

  if (script?.aesthetic?.trim()) {
    parts.push('## 전체 분위기')
    parts.push('')
    parts.push(script.aesthetic.trim())
    parts.push('')
  }

  const subjects = p.subjects ?? []
  if (subjects.length) {
    parts.push('## 캐릭터')
    parts.push('')
    for (const s of subjects) {
      parts.push(`### ${s.name}`)
      parts.push('')
      if (s.role) parts.push(`- **역할**　${s.role}`)
      if (s.kind) parts.push(`- **유형**　${s.kind === 'person' ? '인물' : s.kind === 'animal' ? '동물' : '기타'}`)
      if (s.description?.trim()) parts.push(s.description.trim())
      parts.push('')
    }
  }

  const scenes = p.scenes ?? []
  if (scenes.length) {
    parts.push('## 장면')
    parts.push('')
    for (const s of scenes) {
      parts.push(`### ${s.name}`)
      parts.push('')
      if (s.lighting?.trim()) parts.push(`- **조명**　${s.lighting.trim()}`)
      if (s.mainAnchor?.trim()) parts.push(`- **주요 기준점**　${s.mainAnchor.trim()}`)
      if (s.description?.trim()) parts.push(s.description.trim())
      parts.push('')
    }
  }

  if (p.shots.length) {
    parts.push('## 스토리보드')
    parts.push('')
    for (const shot of p.shots) {
      parts.push(`### 샷 ${shot.index + 1}　${shot.title}`)
      parts.push('')
      const meta: string[] = []
      if (shot.shotSize) meta.push(`샷 크기: ${shot.shotSize}`)
      meta.push(`카메라: ${CAM[shot.cameraMovement] || shot.cameraMovement}`)
      meta.push(`${shot.duration}초`)
      parts.push(`- ${meta.join('　')}`)
      if (shot.purpose?.trim()) parts.push(`- **극적 기능**　${shot.purpose.trim()}`)
      if (shot.voiceover?.trim()) {
        parts.push('')
        parts.push(`**내레이션**　${shot.voiceover.trim()}`)
      }
      if (shot.visualPrompt?.trim()) {
        parts.push('')
        parts.push(shot.visualPrompt.trim())
      }
      parts.push('')
      parts.push('---')
      parts.push('')
    }
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function splitH2(md: string): { title: string; body: string }[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const sections: { title: string; body: string }[] = []
  let cur: { title: string; body: string[] } | null = null
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)\s*$/)
    if (m) {
      if (cur) sections.push({ title: cur.title, body: cur.body.join('\n').trim() })
      cur = { title: m[1].trim(), body: [] }
      continue
    }
    if (!cur) {
      // 첫 2단계 제목 앞의 본문은 여기서 처리하지 않는다.
      continue
    }
    cur.body.push(line)
  }
  if (cur) sections.push({ title: cur.title, body: cur.body.join('\n').trim() })
  return sections
}

function splitH3(body: string): { name: string; body: string }[] {
  const lines = body.split('\n')
  const out: { name: string; body: string[] }[] = []
  let cur: { name: string; body: string[] } | null = null
  for (const line of lines) {
    const m = line.match(/^#{3,4}\s+(.+)\s*$/)
    if (m) {
      if (cur) out.push(cur)
      cur = { name: m[1].trim(), body: [] }
      continue
    }
    if (cur) cur.body.push(line)
  }
  if (cur) out.push(cur)
  return out.map((x) => ({ name: x.name, body: x.body.join('\n').trim() }))
}

function fieldLine(body: string, label: string): string | undefined {
  const re = new RegExp(`^-\\s*\\*\\*${label}\\*\\*[\\s　]+(.+)$`, 'm')
  const m = body.match(re)
  return m?.[1]?.trim() || undefined
}

function stripFieldLines(body: string, labels: string[]): string {
  let s = body
  for (const label of labels) {
    s = s.replace(new RegExp(`^-\\s*\\*\\*${label}\\*\\*[\\s　]+.+$`, 'gm'), '')
  }
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

function parseKind(raw?: string): Subject['kind'] | undefined {
  if (!raw) return undefined
  if (/^(?:动物|동물|animal)$/i.test(raw)) return 'animal'
  if (/^(?:其他|物体|产品|기타|사물|제품|other|object|product)$/i.test(raw)) return 'other'
  if (/^(?:人物|人|인물|캐릭터|person|character)$/i.test(raw)) return 'person'
  return undefined
}

function parseShotBlock(
  name: string,
  body: string,
  fallback: Shot | undefined,
  index: number
): Shot {
  const titleMatch = name.match(SHOT_HEADING)
  const idx = titleMatch ? Math.max(0, Number(titleMatch[1]) - 1) : index
  const title = (titleMatch?.[2] || titleMatch?.[3] || name || fallback?.title || `샷 ${idx + 1}`).trim()

  let shotSize = fallback?.shotSize
  let cameraMovement = fallback?.cameraMovement ?? ('static' as Shot['cameraMovement'])
  let duration = fallback?.duration ?? 5
  let purpose = fallback?.purpose
  let voiceover = fallback?.voiceover ?? ''
  let visualPrompt = fallback?.visualPrompt ?? ''

  const metaLine = body.match(/^-?[ \t]*(?:(?:景别|샷 크기|Shot size)\s*[：:]\s*(.+?)[　\t ]+)?(?:运镜|카메라(?: 움직임)?|Camera(?: movement)?)\s*[：:]\s*(.+?)[　\t ]+([\d.]+)\s*(?:秒|초|s(?:ec(?:onds?)?)?)[ \t]*$/im)
  if (metaLine) {
    if (metaLine[1]) shotSize = metaLine[1].trim()
    const cam = CAM_REV[metaLine[2].trim().toLowerCase()]
    if (cam) cameraMovement = cam
    const d = Number(metaLine[3])
    if (Number.isFinite(d) && d > 0) duration = Math.min(30, Math.max(0.5, d))
  } else {
    // 메타데이터가 여러 줄에 나뉘어 있어도 개별 값을 읽는다.
    const sizeM = body.match(/(?:景别|샷 크기|Shot size)\s*[：:]\s*([^\n　]+)/i)
    const camM = body.match(/(?:运镜|카메라(?: 움직임)?|Camera(?: movement)?)\s*[：:]\s*([^\n　]+)/i)
    const durM = body.match(/([\d.]+)\s*(?:秒|초|s(?:ec(?:onds?)?)?)/i)
    if (sizeM) shotSize = sizeM[1].trim()
    if (camM && CAM_REV[camM[1].trim().toLowerCase()]) cameraMovement = CAM_REV[camM[1].trim().toLowerCase()]
    if (durM) {
      const d = Number(durM[1])
      if (Number.isFinite(d) && d > 0) duration = Math.min(30, Math.max(0.5, d))
    }
  }

  const purposeM = body.match(/^-?\s*\*\*(?:戏剧功能|극적 기능|Dramatic purpose|Purpose)\*\*[：:\s　]+(.+)$/im)
  if (purposeM) purpose = purposeM[1].trim()

  const voM = body.match(/\*\*(?:口播|내레이션|Narration|Voiceover)\*\*[：:\s　]+(.+)/i)
  if (voM) voiceover = voM[1].trim()

  // 메타데이터를 제거한 나머지 본문이 화면 묘사다.
  let rest = body
    .replace(/^-?[ \t]*(?:(?:景别|샷 크기|Shot size)\s*[：:].+?)?(?:运镜|카메라(?: 움직임)?|Camera(?: movement)?)\s*[：:].+(?:秒|초|s(?:ec(?:onds?)?)?)\s*$/gim, '')
    .replace(/^[-]?[ \t]*\*\*(?:戏剧功能|극적 기능|Dramatic purpose|Purpose)\*\*.+$/gim, '')
    .replace(/\*\*(?:口播|내레이션|Narration|Voiceover)\*\*[：:\s　]+.+/gi, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // 비어 있는 목록 표시를 제거한다.
  rest = rest.replace(/^-\s*$/gm, '').trim()
  if (rest) visualPrompt = rest

  const base: Shot =
    fallback ??
    ({
      id: `shot_${Date.now().toString(36)}_${idx}`,
      index: idx,
      title,
      visualPrompt: '',
      audioDescription: '',
      voiceover: '',
      duration: 5,
      cameraMovement: 'static',
      status: 'draft'
    } as Shot)

  return {
    ...base,
    index: idx,
    title,
    shotSize,
    cameraMovement,
    duration,
    purpose,
    voiceover,
    visualPrompt: visualPrompt || base.visualPrompt
  }
}

/**
 * 편집한 Markdown의 대본, 캐릭터, 장면, 샷을 프로젝트에 반영한다.
 * 승인 상태를 다시 확인해야 할 때는 호출자가 playApproved를 변경한다.
 */
export function applyProjectPlayMarkdown(p: Project, markdown: string): void {
  const md = markdown.replace(/\r\n/g, '\n').trim()
  if (!md) return

  const titleM = md.match(/^#\s+(.+)\s*$/m)
  const topic = titleM?.[1]?.trim() || p.script?.topic || p.name

  const sections = splitH2(md)
  const byTitle = (name: keyof typeof PROJECT_HEADINGS) =>
    sections.find((s) => PROJECT_HEADINGS[name].test(s.title))
  const docSection = byTitle('body')
  // 본문에 자체 제목이 있으면 제작 메타데이터 앞의 첫 섹션을 사용한다.
  let content = docSection?.body ?? ''
  if (!content) {
    const headings = Object.values(PROJECT_HEADINGS)
    const first = sections.find((s) => !headings.some((heading) => heading.test(s.title)))
    if (first) content = `## ${first.title}\n\n${first.body}`.trim()
  }
  if (content === EMPTY_COPY || content.startsWith('*还没有正文')) content = (p.script?.content || '').trim()

  const aesthetic = byTitle('aesthetic')?.body?.trim() || p.script?.aesthetic

  if (p.script) {
    p.script = {
      ...p.script,
      topic,
      content: content || p.script.content,
      aesthetic: aesthetic || p.script.aesthetic
    }
  }
  if (topic) p.name = topic.slice(0, 48)

  const peopleSec = byTitle('people')
  if (peopleSec && (p.subjects?.length || peopleSec.body)) {
    const blocks = splitH3(peopleSec.body)
    const next: Subject[] = [...(p.subjects ?? [])]
    blocks.forEach((b, i) => {
      const role = fieldLine(b.body, '(?:角色|역할|Role)')
      const kind = parseKind(fieldLine(b.body, '(?:类型|유형|Type|Kind)'))
      const description = stripFieldLines(b.body, ['(?:角色|역할|Role)', '(?:类型|유형|Type|Kind)'])
      const existing = next.find((x) => x.name === b.name) || next[i]
      if (existing) {
        const idx = next.findIndex((x) => x.id === existing.id)
        next[idx] = {
          ...existing,
          name: b.name,
          role: role ?? existing.role,
          kind: kind ?? existing.kind,
          description: description || existing.description
        }
      } else {
        next.push({
          id: `sub_${Date.now().toString(36)}_${i}`,
          name: b.name,
          kind: kind ?? 'person',
          description: description || '',
          role
        })
      }
    })
    p.subjects = next
  }

  const sceneSec = byTitle('scenes')
  if (sceneSec && (p.scenes?.length || sceneSec.body)) {
    const blocks = splitH3(sceneSec.body)
    const next: Scene[] = [...(p.scenes ?? [])]
    blocks.forEach((b, i) => {
      const lighting = fieldLine(b.body, '(?:光线|조명|Lighting)')
      const mainAnchor = fieldLine(b.body, '(?:主锚|주요 기준점|Main anchor)')
      const description = stripFieldLines(b.body, ['(?:光线|조명|Lighting)', '(?:主锚|주요 기준점|Main anchor)'])
      const existing = next.find((x) => x.name === b.name) || next[i]
      if (existing) {
        const idx = next.findIndex((x) => x.id === existing.id)
        next[idx] = {
          ...existing,
          name: b.name,
          lighting: lighting ?? existing.lighting,
          mainAnchor: mainAnchor ?? existing.mainAnchor,
          description: description || existing.description
        }
      } else {
        next.push({
          id: `scn_${Date.now().toString(36)}_${i}`,
          name: b.name,
          description: description || '',
          lighting,
          mainAnchor
        })
      }
    })
    p.scenes = next
  }

  const shotSec = byTitle('shots')
  if (shotSec?.body) {
    const blocks = splitH3(shotSec.body)
    if (blocks.length) {
      const next = blocks.map((b, i) => {
        const titleMatch = b.name.match(SHOT_HEADING)
        const idx = titleMatch ? Math.max(0, Number(titleMatch[1]) - 1) : i
        const fallback = p.shots.find((s) => s.index === idx) || p.shots[i]
        return parseShotBlock(b.name, b.body, fallback, idx)
      })
      // 샷 순서대로 정렬하고 인덱스를 다시 매긴다.
      next.sort((a, b) => a.index - b.index)
      next.forEach((s, i) => {
        s.index = i
      })
      p.shots = next
    }
  }
}

function cleanMarkdownTitle(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 가져오기 전에 BOM과 줄바꿈을 정리한다. */
export function normalizeImportedMarkdown(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

/** 외부 Markdown에서 대본 필드를 구성한다. */
export function importedPlayFields(markdown: string, filename = '') {
  const content = normalizeImportedMarkdown(markdown)
  if (!content) throw new Error('대본 파일이 비어 있어요.')
  return {
    content,
    topic: inferMarkdownTitle(content, filename),
    playReady: true as const
  }
}

export function scriptFromImportedPlay(p: Project, markdown: string, filename = ''): Script {
  const fields = importedPlayFields(markdown, filename)
  const prev = p.script
  return {
    id: prev?.id ?? `s_${Date.now().toString(36)}`,
    keywords: prev?.keywords ?? [],
    style: prev?.style ?? 'cinematic',
    aspectRatio: prev?.aspectRatio ?? p.settings?.aspectRatio ?? '16:9',
    shotDuration: prev?.shotDuration ?? p.settings?.defaultShotDuration ?? 5,
    createdAt: prev?.createdAt ?? Date.now(),
    ...(prev ?? {}),
    ...fields,
    origin: 'imported' as const
  }
}

/** 1단계 제목이 없으면 파일명에서 대본 이름을 가져온다. */
export function inferMarkdownTitle(markdown: string, filename = ''): string {
  const normalized = normalizeImportedMarkdown(markdown)
  const heading = normalized.match(/^\s*#\s+(.+?)\s*$/m)?.[1]
  if (heading) return cleanMarkdownTitle(heading).slice(0, 80)
  const baseName = filename.replace(/\.(?:md|markdown|txt|text|docx|doc|rtf)$/i, '')
  return cleanMarkdownTitle(baseName).slice(0, 80) || '제목 없는 대본'
}

/** 대본 본문에 1단계 제목이 없을 때 제목을 추가해 내보낸다. */
export function buildScriptMarkdown(topic: string, content: string): string {
  const normalized = normalizeImportedMarkdown(content)
  if (/^\s*#\s+/m.test(normalized)) return `${normalized}\n`
  const title = cleanMarkdownTitle(topic) || '제목 없는 대본'
  return `# ${title}\n\n${normalized}\n`
}

export function scriptExportFilename(topic: string): string {
  const title = cleanMarkdownTitle(topic) || '제목 없는 대본'
  return `${title.slice(0, 60)}.md`
}

/** 촬영용 챕터 대본의 구조 표시가 있는지 확인한다. */
export function looksLikeFilmChapterPlay(markdown: string): boolean {
  const t = markdown || ''
  const sections = splitH2(t)
  return (
    sections.some(({ title }) => [PLAY_STRUCTURE[0], PLAY_STRUCTURE[3], PLAY_STRUCTURE[7]].some((heading) => heading.test(title))) ||
    /^(?:#{1,4}\s*)?(?:촬영 원칙|각색 원칙|Filming (?:rules|principles)|Adaptation (?:rules|principles)|改编原则|拍摄原则)/im.test(t) ||
    sections.some((section) => NUMBERED_SCENE.test(section.title)) ||
    /(?:内景|外景|반실외|실내|실외|INT[.]?|EXT[.]?)\s*[｜|]/i.test(t) ||
    /成年[^\n]{0,16}旁白|성인[^\n]{0,16}내레이션|adult[^\n]{0,16}narrat/i.test(t)
  )
}

const SCENE_SLUG = /(?:内景|外景|半外景|실내|실외|반실외|INT[.]?|EXT[.]?)\s*[｜|]\s*([^｜|\n*]+)\s*[｜|]\s*([^\n*]+)/i
const NUMBERED_SCENE = /^(?:场景\s*[一二三四五六七八九十百0-9]|장면\s*\d+|scene\s+\d+)/i
const PLAY_STRUCTURE = [
  /^(?:故事背景|이야기 배경|Story background)/i,
  /^(?:本章承接|이전 챕터와 연결|챕터 연결|Chapter continuity|Chapter handoff)/i,
  PROJECT_HEADINGS.people,
  /^(?:环境与场景|환경과 장면|Environment and (?:scenes|locations)|Locations)/i,
  /^(?:拍摄原则|촬영 원칙|Filming (?:rules|principles))/i,
  /^(?:改编原则|각색 원칙|Adaptation (?:rules|principles))/i,
  /^(?:本章情绪线|챕터 감정선|Chapter emotional arc)/i,
  /^(?:视觉与声音基调|화면과 소리의 분위기|시각 및 소리 기조|Visual and sound tone)/i
]

/** 스토리보드와 영상 생성에 전달할 챕터의 공통 지침을 추린다. */
export function extractPlayDirectives(markdown: string, maxChars = 3600): string {
  const sections = splitH2(markdown || '')
  const chunks: string[] = []
  const meta = (markdown || '').match(/^>\s*.+(?:\n>\s*.+)*/m)
  if (meta) chunks.push(meta[0])
  for (const [index, heading] of PLAY_STRUCTURE.entries()) {
    const hit = sections.find((s) => heading.test(s.title))
    if (hit?.body?.trim()) {
      const body = index === 2 || index === 3 ? hit.body.trim().slice(0, 1200) : hit.body.trim()
      chunks.push(`## ${hit.title}\n${body}`)
    }
  }
  return chunks.join('\n\n').slice(0, maxChars)
}

export interface PlayLocationDraft {
  name: string
  description: string
  lighting?: string
  mainAnchor?: string
  anchors?: string
  props?: string
}

/** 识别误放进场景环境设定的分镜标题或角色对白。 */
export function containsSceneDramaText(text: string): boolean {
  const value = String(text || '').replace(/\\\*/g, '*')
  return /【\s*镜头\s*[：:]|(?:^|\n)\s*#{2,4}\s*场景\s*[一二三四五六七八九十百\d]+|\*\*\s*[\u3400-\u9fff\s]{1,12}[：:]\s*\*\*|(?:^|\n)\s*[\u3400-\u9fff]{2,6}[（(][^）)\n]{0,16}[）)]\s*[：:]/m.test(value)
}

function normLocationKey(name: string): string {
  return name.replace(/\s+/g, '').replace(/[，,。．.、]/g, '').toLowerCase()
}

function locationShortName(raw: string): string {
  return raw
    .replace(NUMBERED_SCENE.test(raw) ? /^[^｜|]*/ : /^场景[^｜|]*/, '')
    .replace(/^[｜|]\s*/, '')
    .split(/[，,]/)[0]
    .trim()
}

function guessLocationAnchor(name: string, description: string): string {
  const blob = `${name} ${description}`
  const hit = blob.match(
    /破瓦|门缝|墙角|折叠桌|搪瓷盆|铁皮棚|卷帘门|街机|石板路|田埂|仓房|饭堂|修车铺|游戏厅|宿舍|公园|公厕|문틈|벽 모서리|접이식 테이블|돌길|논둑|창고|식당|오락실|기숙사|공원|doorway|table|stone path|warehouse|arcade|dormitory|park/i
  )
  return hit?.[0] || `${name} 기준점`
}

/** 배경 설정과 장면 머리말에서 모델 없이 장소를 찾는다. */
export function extractLocationsFromPlay(markdown: string): PlayLocationDraft[] {
  const sections = splitH2(markdown || '')
  const out: PlayLocationDraft[] = []
  const seen = new Set<string>()

  const add = (rawName: string, description: string, lighting?: string) => {
    const name = locationShortName(rawName) || rawName.trim()
    const key = normLocationKey(name)
    if (!name || key.length < 2 || seen.has(key)) return
    if (/^(?:场景\s*[一二三四五六七八九十百0-9]+|장면\s*\d+|scene\s+\d+)$/i.test(name)) return
    seen.add(key)
    const clean = (description || '').trim()
    const desc = (clean && !containsSceneDramaText(clean) ? clean : `${name}。空间、建筑、地面与光线需依据剧本补充。`).replace(/\s+/g, ' ').trim()
    const mainAnchor = guessLocationAnchor(name, desc)
    out.push({
      name,
      description: desc.slice(0, 480),
      lighting: lighting?.trim() || undefined,
      mainAnchor,
      anchors: `전경; ${mainAnchor}; 인물이 서는 지면; 광원`,
      props: '없음'
    })
  }

  const bible = sections.find(
    (s) => PLAY_STRUCTURE[3].test(s.title) || PROJECT_HEADINGS.scenes.test(s.title) || /^(?:环境|환경|environment)/i.test(s.title)
  )
  if (bible) {
    for (const block of splitH3(bible.body)) add(block.name, block.body)
  }

  for (const sec of sections.filter((s) => NUMBERED_SCENE.test(s.title))) {
    const heading = sec.body.match(SCENE_SLUG)
    const loc = heading?.[1]?.trim()
    const weather = heading?.[2]?.trim()
    if (loc) add(loc, '', weather)
  }

  return out
}

const SKIP_SUBJECT = /旁白|画外|镜头|蒙太奇|改编|类型|本章|视觉|声音|내레이션|화면 밖|몽타주|각색|챕터|조명|\b(?:narration|voiceover|montage|sound)\b/i

/**
 * 대본의 구조나 캐릭터 속성을 나타내는 라벨을 제외한다.
 * 예를 들어 배경, 줄거리, 체격, 역할, 감정선은 캐릭터 이름으로 추출하지 않는다.
 * 파서 호환을 위해 이전 중국어 라벨도 인식한다.
 */
const FIELD_LABEL_WORDS = [
  '이야기배경', '줄거리', '갈등구조', '주제', '역할', '정체', '나이', '외형', '체형', '복장', '의상',
  '성격', '말투', '욕망', '공포', '관계', '상태변화', '조명', '광원', '날씨', '주요소품', '장소',
  '제작원칙', '목표', '현장음', '참고사항', '감정선',
  'storybackground', 'synopsis', 'dramaticpurpose', 'identity', 'appearance', 'wardrobe', 'personality',
  'statevariants', 'lighting', 'dynamics', 'mainanchor', 'visualtone', 'chaptercontinuity',
  '故事', '背景', '梗概', '对抗', '引擎', '主题', '类型', '基调', '核心', '冲突', '悬念', '钩子', '节拍',
  '身份', '年龄', '外形', '脸型', '发型', '体型', '身材', '身高', '服装', '服饰', '配饰', '识别点',
  '性格', '语感', '口音', '欲望', '恐惧', '弱点', '关系', '弧光', '锚点', '状态', '出场', '本片',
  '建筑', '入口', '出口', '地面', '天气', '光线', '光源', '年代', '肌理', '道具', '环境', '场景', '地点',
  '原则', '任务', '目标', '阻力', '结果', '场次', '分镜', '对白', '口播', '画面', '声音', '时长',
  '建议', '时间', '人物', '在场', '备注', '说明', '小结', '总结'
]

/** 구조 또는 속성 라벨이 캐릭터로 추출되는 것을 방지한다. */
export function isFieldLabelName(name: string): boolean {
  const n = name.replace(/\s+/g, '').toLowerCase()
  if (!n) return true
  return FIELD_LABEL_WORDS.some((w) => n.includes(w))
}

/** 본문에서 두 글자 이상인 이름이 등장하는 횟수를 센다. */
export function countNameMentions(text: string, name: string): number {
  const token = String(name || '').trim()
  if (token.length < 2) return 0
  let count = 0
  let from = 0
  const source = String(text || '')
  while (from <= source.length) {
    const at = source.indexOf(token, from)
    if (at < 0) break
    count += 1
    from = at + token.length
  }
  return count
}

/** 대본에 명시한 소품 목록을 읽는다. 없으면 빈 목록을 반환한다. */
export function propsListedInPlay(markdown: string): Array<{ name: string; description: string }> {
  const sections = splitH2(markdown || '')
  const section = sections.find((item) => /道具|物件|关键物品|소품|\bprops\b/i.test(item.title))
  if (!section) return []
  const out: Array<{ name: string; description: string }> = []
  const add = (name: string, description: string) => {
    const clean = name.replace(/\*\*/g, '').replace(/[「」]/g, '').trim()
    if (clean.length < 2 || clean.length > 12) return
    if (out.some((item) => item.name === clean)) return
    out.push({ name: clean, description: description.trim().slice(0, 400) })
  }
  for (const block of splitH3(section.body)) add(block.name, block.body)
  for (const line of section.body.split('\n')) {
    const match = line.match(/^\s*[-*]?\s*([^：:\n]{2,12})[：:]\s*(.+)$/)
    if (match) add(match[1], match[2])
  }
  return out
}

/**
 * 대본에 두 번 이상 등장하며 인물 이름과 겹치지 않는 소품을 보존한다.
 * 한 번만 등장하는 컵이나 표지판 등은 보관하지 않는다.
 */
export function keepRecurringProps(
  play: string,
  rows: Array<{ name?: string; description?: string }>,
  subjectNames: string[] = []
): Array<{ name: string; description: string; mentions: number }> {
  const banned = new Set(subjectNames.map((name) => name.replace(/\s+/g, '')))
  const seen = new Set<string>()
  const out: Array<{ name: string; description: string; mentions: number }> = []
  for (const row of rows) {
    const name = String(row.name || '').replace(/[「」*]/g, '').trim()
    if (name.length < 2 || name.length > 12) continue
    if (/^(?:人物|场景|地点|主角|镜头|道具|服装|衣服|인물|장면|장소|주인공|샷|소품|의상|person|scene|location|protagonist|shot|props?|wardrobe)$/i.test(name)) continue
    const key = name.replace(/\s+/g, '')
    if (seen.has(key) || banned.has(key)) continue
    const mentions = countNameMentions(play, name)
    if (mentions < 2) continue
    seen.add(key)
    out.push({
      name,
      description: String(row.description || `${name}. 모양, 재질, 색상, 사용감은 대본을 따라요.`).slice(0, 400),
      mentions
    })
    if (out.length >= 6) break
  }
  return out
}

/** 캐릭터 섹션과 대사의 화자 이름에서 인물을 추출한다. */
export function extractSubjectsFromPlay(markdown: string): Array<{
  name: string
  kind: 'person' | 'animal' | 'other'
  description: string
  role: string
  stateVariants: string
  fromReference: boolean
}> {
  const sections = splitH2(markdown || '')
  const out: Array<{
    name: string
    kind: 'person' | 'animal' | 'other'
    description: string
    role: string
    stateVariants: string
    fromReference: boolean
  }> = []
  const seen = new Set<string>()

  const add = (raw: string, description = '', role = '') => {
    const name = raw.replace(/（[^）]+）|\([^)]+\)/g, '').replace(/(?:旁白|내레이션|narration)$/i, '').trim()
    if (!name || name.length > 16 || SKIP_SUBJECT.test(name)) return
    if (isFieldLabelName(name)) return
    const key = name.replace(/\s+/g, '').toLowerCase()
    const ident = description.match(/(?:身份|角色|역할|정체|신분|Role|Identity)\s*[：:]\s*([^\n]+)/i)
    const state = description.match(/(?:跨场状态[变化]*|상태 변화|장면 간 상태 변화|Cross-scene state|State variants?)\s*[：:]\s*([^\n]+)/i)
    const roleText = (ident?.[1] || role).trim()
    const stateText = (state?.[1] || '').trim()
    if (seen.has(key)) {
      const row = out.find((item) => item.name.replace(/\s+/g, '').toLowerCase() === key)
      if (row && description && description.length > row.description.length) {
        row.description = description.slice(0, 1200)
        if (roleText) row.role = roleText.slice(0, 200)
        if (stateText) row.stateVariants = stateText.slice(0, 240)
      }
      return
    }
    seen.add(key)
    out.push({
      name,
      kind: 'person',
      description: (description || `${name}. 외형과 의상은 대본을 참고해요.`).slice(0, 1200),
      role: roleText.slice(0, 200),
      stateVariants: stateText || '단일 상태',
      fromReference: false
    })
  }

  const people = sections.find((s) => PROJECT_HEADINGS.people.test(s.title))
  if (people) {
    for (const block of splitH3(people.body)) add(block.name, block.body)
    // 3단계 제목 대신 이름만 한 줄에 굵게 쓴 대본도 지원한다.
    for (const line of people.body.split('\n')) {
      const m = line.match(/^\s*[-*]?\s*\*\*([^*：:\n]{1,16})\*\*\s*$/)
      if (m) add(m[1])
    }
  }
  /**
   * 별도의 인물 섹션이 없으면 대사 앞의 화자 이름에서 추출한다.
   * 굵은 화자 이름 다음에 따옴표로 시작하는 대사가 오는지 확인한다.
   * 속성 라벨은 인물 이름에서 제외한다.
   */
  for (const m of markdown.matchAll(
    /\*\*([^*：:\n]{1,16})[：:]\*\*[ \t]*\n*[ \t]*[「“"『']/g
  )) {
    add(m[1])
  }
  return out
}

/** 배경 추출 모델에 전달할 대본에서 필요한 부분만 고른다. */
export function extractPlayForSceneStage(markdown: string, maxChars = 8000): string {
  const sections = splitH2(markdown || '')
  const chunks: string[] = []
  const meta = (markdown || '').match(/^>\s*.+(?:\n>\s*.+)*/m)
  if (meta) chunks.push(meta[0])
  for (const heading of [PLAY_STRUCTURE[0], PLAY_STRUCTURE[3], PLAY_STRUCTURE[7], PLAY_STRUCTURE[4], PLAY_STRUCTURE[5]]) {
    const hit = sections.find((s) => heading.test(s.title))
    if (hit?.body?.trim()) chunks.push(`## ${hit.title}\n${hit.body.trim()}`)
  }
  for (const sec of sections.filter((s) => NUMBERED_SCENE.test(s.title))) {
    const head = sec.body.match(SCENE_SLUG)?.[0].slice(0, 80) || ''
    const preview = sec.body.split('\n').filter((l) => l.trim()).slice(0, 6).join('\n')
    chunks.push(`## ${sec.title}\n${head}\n${preview}`)
  }
  const text = chunks.join('\n\n').trim()
  return (text || markdown).slice(0, maxChars)
}

/** 샷을 확장할 때 참고할 해당 장면의 대본 원문을 반환한다. */
export function extractSceneSlice(markdown: string, sceneName?: string, maxChars = 4200): string {
  const sections = splitH2(markdown || '')
  const sceneSecs = sections.filter((s) => NUMBERED_SCENE.test(s.title) || PROJECT_HEADINGS.scenes.test(s.title))
  const name = (sceneName || '').trim()
  if (name) {
    const restOfTitle = (title: string) => title.split(/[｜|]/).slice(1).join('|').trim()
    const hit =
      sceneSecs.find((s) => s.title.includes(name) || Boolean(restOfTitle(s.title) && name.includes(restOfTitle(s.title)))) ||
      sceneSecs.find((s) => s.body.includes(name)) ||
      sections.find((s) => s.title.includes(name) || s.body.includes(name))
    if (hit) return `## ${hit.title}\n\n${hit.body}`.slice(0, maxChars)
  }
  if (sceneSecs.length === 1) return `## ${sceneSecs[0].title}\n\n${sceneSecs[0].body}`.slice(0, maxChars)
  return ''
}
