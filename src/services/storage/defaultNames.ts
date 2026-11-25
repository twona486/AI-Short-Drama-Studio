import type { Project, ScriptDoc } from '@/types'

const scriptTitle = (title: string) => title.replace(/^未命名剧本( [1-9][0-9]*)?$/, '제목 없는 대본$1')
const episodeTitle = (title: string) => title
  .replace(/^第 ([1-9][0-9]*) 集$/, '$1화')
  .replace(/^未命名$/, '제목 없음')

const date = '(?:(?:[13578]|1[02])-(?:[1-9]|[12][0-9]|3[01])|(?:[469]|11)-(?:[1-9]|[12][0-9]|30)|2-(?:[1-9]|[12][0-9]))'
const clock = '(?:[01][0-9]|2[0-3])'
const minute = '[0-5][0-9]'
const datedName = new RegExp(`^(新项目|视频复刻) (${date} ${clock}:${minute})$`)
const quickEditName = new RegExp(`^自由剪辑 (${date} ${clock}${minute})$`)
const topBarName = new RegExp(`^项目 (0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01]) (${clock}):(${minute})$`)

function projectName(name: string): string {
  return name
    .replace(/^未命名项目$/, '제목 없는 프로젝트')
    .replace(datedName, (_, kind, date) => `${kind === '新项目' ? '새 프로젝트' : '영상 재현'} ${date}`)
    .replace(quickEditName, '자유 편집 $1')
    .replace(topBarName, (_, month, day, hour, minute) => {
      const date = new Date(Date.UTC(2000, Number(month) - 1, Number(day), Number(hour), Number(minute)))
      if (date.getUTCDate() !== Number(day)) return _
      return `프로젝트 ${date.toLocaleString('ko-KR', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
      })}`
    })
}

function localizeHeadings(markdown: string): string {
  let sawTitle = false
  let fence = ''
  // 줄 구분과 제목 외의 원문을 그대로 보존한다.
  return markdown.split(/(\r\n|\n|\r)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = ''
      return line
    }
    if (marker) {
      fence = marker[1]
      return line
    }
    const heading = /^((?:\uFEFF)?(#{1,2})[ \t]+)(\S.*?)([ \t]*)$/.exec(line)
    if (!heading) return line
    const [, prefix, level, title, suffix] = heading
    if (level === '##') return prefix + episodeTitle(title) + suffix
    if (sawTitle) return line
    sawTitle = true
    return prefix + scriptTitle(title) + suffix
  }).join('')
}

export function localizeScript(doc: ScriptDoc, markdown: string): { meta: ScriptDoc; markdown: string } {
  const meta: ScriptDoc = { ...doc, defaultNamesLocalized: true }
  if (doc.source === 'imported') return { meta, markdown }
  meta.title = scriptTitle(doc.title)
  return { meta, markdown: localizeHeadings(markdown) }
}

const subjectName = (name: string) => name.replace(/^角色 ([1-9][0-9]*)$/, '캐릭터 $1')
const propName = (name: string) => name.replace(/^道具 ([1-9][0-9]*)$/, '소품 $1')
const sceneName = (name: string) => name.replace(/^场景 ([1-9][0-9]*)$/, '장면 $1')
const shotName = (name: string) => name.replace(/^镜头 ([1-9][0-9]*)$/, '샷 $1')
const shotLabel = (label: string) => label.replace(/^([1-9][0-9]*\. )镜头 ([1-9][0-9]*)$/, '$1샷 $2')

const nodeNames: Partial<Record<NonNullable<Project['canvas']>['nodes'][number]['type'], (label: string) => string>> = {
  imageGen: label => label.replace(/^图片 ([1-9][0-9]*)$/, '이미지 $1'),
  videoGen: label => label.replace(/^视频 ([1-9][0-9]*)$/, '영상 $1'),
  audioGen: label => label.replace(/^音频 ([1-9][0-9]*)$/, '오디오 $1'),
  compose: label => label.replace(/^合成$/, '합성'),
  export: label => label.replace(/^合成视频$/, '영상 합성'),
  final: label => label.replace(/^视频预览$/, '영상 미리보기'),
  subject: subjectName,
  prop: propName,
  scene: sceneName,
  shotBoard: shotLabel,
  shotImage: shotLabel,
  shotFrames: shotLabel,
  shotVideo: shotLabel,
  audio: label => label.replace(/^后期 TTS$/, '후반 TTS').replace(/^H3 人声$/, 'H3 음성').replace(/^无口播$/, '내레이션 없음')
}

const groupNames = new Map([
  ['group-subjects:人物角色', '캐릭터'],
  ['group-props:反复出现的道具', '반복 등장 소품'],
  ['group-scenes:场景锚点', '장면 기준 이미지'],
  ['group-shots:故事看板', '스토리 개요판'],
  ['group-shots:分镜关键帧', '샷 키프레임'],
  ['group-frames:首尾帧', '시작·끝 프레임'],
  ['group-videos:分镜视频', '샷 영상'],
  ['group-audio:口播', '내레이션'],
  ['group-export:合成视频', '영상 합성']
])

export function localizeProject(project: Project): void {
  const originalName = project.name
  const originalTopic = project.script?.topic
  project.name = projectName(originalName)
  if (project.script && project.script.origin !== 'imported' && typeof originalTopic === 'string') {
    project.script.topic = originalTopic === originalName
      ? project.name
      : scriptTitle(originalTopic)
    if (originalTopic === '自由剪辑' && quickEditName.test(originalName)) {
      project.script.topic = '자유 편집'
    }
  }
  for (const chapter of project.chapters ?? []) {
    if (typeof chapter?.title === 'string') chapter.title = chapter.title.replace(/^第 ([1-9][0-9]*) 章$/, '챕터 $1')
  }
  for (const subject of project.subjects ?? []) {
    if (typeof subject?.name === 'string') subject.name = subjectName(subject.name)
  }
  for (const prop of project.props ?? []) {
    if (typeof prop?.name === 'string') prop.name = propName(prop.name)
  }
  for (const scene of project.scenes ?? []) {
    if (typeof scene?.name === 'string') scene.name = sceneName(scene.name)
  }
  for (const shot of project.shots ?? []) {
    if (typeof shot?.title === 'string') shot.title = shotName(shot.title)
  }
  for (const group of project.canvas?.groups ?? []) {
    if (typeof group?.label !== 'string') continue
    group.label = groupNames.get(`${group.id}:${group.label}`) ?? group.label
  }
  for (const node of project.canvas?.nodes ?? []) {
    const label = node?.data?.label
    if (typeof label !== 'string') continue
    if (node.type === 'script') {
      if (project.script && label === originalTopic) node.data.label = project.script.topic
      else if (label === originalName) node.data.label = project.name
      else if (label === '剧本') node.data.label = '대본'
    } else if (node.type === 'groupFrame') {
      node.data.label = groupNames.get(`${node.id}:${label}`) ?? label
    } else {
      node.data.label = nodeNames[node.type]?.(label) ?? label
    }
  }
  project.defaultNamesLocalized = true
}
