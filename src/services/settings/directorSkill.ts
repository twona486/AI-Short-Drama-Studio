import { t } from '@/i18n'
import { getSkillBody } from '@/skills'
import {
  CUSTOM_STORY_SKILL_ID,
  GENERAL_STORY_SKILL_ID,
  storySkillById
} from '@/skills/storyStyles'
import { useSettingsStore, type DirectorSkillDoc } from '@/stores/settings'
import { desktop, isDesktop } from '@/services/desktop'

const MAX_BODY = 24_000

/** SKILL.md 머리말이나 README 제목에서 이름과 본문을 읽는다. 머리말이 없으면 전문을 사용한다. */
export function parseDirectorSkill(text: string, filename = ''): DirectorSkillDoc {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!raw || raw.length < 20) throw new Error(t('directorSkill.tooShort'))
  if (/<html[\s>]/i.test(raw.slice(0, 400))) throw new Error(t('directorSkill.requiresMarkdown'))

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  const yaml = fm?.[1] || ''
  const rest = (fm?.[2] || raw).trim()
  const pick = (key: string) => {
    const line = yaml.split(/\r?\n/).find((item) => item.startsWith(`${key}:`))
    return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : ''
  }
  const heading = rest.match(/^#\s+(.+)$/m)?.[1]?.trim() || ''
  const fileTitle = filename.replace(/\.[^.]+$/, '').replace(/^(readme|skill)$/i, '').trim()
  const name = (pick('name') || (heading && !/^readme$/i.test(heading) ? heading : '') || fileTitle || '연출 가이드').slice(0, 80)
  const body = rest.slice(0, MAX_BODY)
  if (body.length < 20) throw new Error(t('directorSkill.empty'))
  return {
    name,
    filename: filename.slice(0, 180),
    body,
    importedAt: Date.now()
  }
}

export function currentDirectorSkill(): DirectorSkillDoc | null {
  try {
    return useSettingsStore().config.directorSkill || null
  } catch {
    return null
  }
}

function manualText(skill: DirectorSkillDoc): string {
  return `[User-imported director guide: ${skill.name}]
Follow this guide for shot breakdown and writing image and video prompts.
The exact video duration window, per-shot limit, verbatim dialogue, and required storage fields still apply. If the guide conflicts, those constraints take precedence. Otherwise follow the guide for shot breakdown and prompt writing. Write user-facing descriptions in Korean (한국어) and final model-facing generation prompts in English. Preserve requested Korean on-screen text and original spoken words.

${skill.body}`
}

/** 当前选中的分镜技能。通用手册不额外加一层。 */
export function activeStorySkillOverlay(): string {
  let styleId = GENERAL_STORY_SKILL_ID
  let genreId = GENERAL_STORY_SKILL_ID
  try {
    const config = useSettingsStore().config
    styleId = config.storyStyleId || GENERAL_STORY_SKILL_ID
    genreId = config.storyGenreId || GENERAL_STORY_SKILL_ID
  } catch {
    return ''
  }
  const sections: string[] = []
  if (styleId === CUSTOM_STORY_SKILL_ID) {
    const imported = currentDirectorSkill()
    if (imported) sections.push(manualText(imported))
  } else {
    const style = storySkillById(styleId)
    if (style?.group === 'style') sections.push(`【镜头方式：${style.name}】\n${style.body}`)
  }
  const genre = storySkillById(genreId)
  if (genre?.group === 'genre') sections.push(`【题材偏好：${genre.name}】\n${genre.body}`)
  if (!sections.length) return ''
  return `以下是创作倾向而非固定模板。用户明确要求、剧本事实、时长与模型能力优先；不适用时灵活调整，不要强行添加情节。\n\n${sections.join('\n\n')}`
}

/** 通用分镜导演手册，再加上当前选中的风格或类型。导入的手册选中时整份替换这一层。 */
export function directorPlaybookText(): string {
  const base = getSkillBody('storyboard-director')
  const extra = activeStorySkillOverlay()
  if (!extra) return base
  return `${base}\n\n${extra}`
}

/** 写剧本、拆镜和出提示词时插入当前技能。通用分镜不加这一层。 */
export function importedDirectorPrefix(): string {
  const extra = activeStorySkillOverlay()
  return extra ? `${extra}\n\n` : ''
}

/** 给 H3 英文成片稿用：吸收当前技能的调度写法，输出格式仍是 (S#) 与 <d>。 */
export function importedDirectorForH3(): string {
  const extra = activeStorySkillOverlay()
  if (!extra) return ''
  return `Active story skill (follow its blocking, performance and how a shot is staged). Keep this task's output format: speaker lock, English action, dialogue only inside d tags.\n${extra.slice(0, 8_000)}\n\n`
}

const SKILL_NAMES = ['SKILL.md', 'skill.md', 'README.md', 'readme.md', 'Readme.md']

async function readSkillFile(filePath: string): Promise<{ text: string; filename: string }> {
  const filename = filePath.split(/[\\/]/).pop() || 'SKILL.md'
  return { text: await desktop().readText(filePath), filename }
}

/** SKILL.md 또는 README.md 파일이나 해당 파일을 포함한 디렉터리를 선택한다. */
export async function pickDirectorSkillFile(): Promise<{ text: string; filename: string } | null> {
  if (isDesktop()) {
    const paths = await desktop().pickFiles([
      { name: t('settings.director.title'), extensions: ['md', 'markdown', 'txt'] }
    ])
    const path = paths[0]
    if (!path) return null
    return readSkillFile(path)
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      resolve({ text: await file.text(), filename: file.name })
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export async function pickDirectorSkillFolder(): Promise<{ text: string; filename: string } | null> {
  if (!isDesktop()) throw new Error(t('directorSkill.webFileOnly'))
  const dir = await desktop().pickDirectory()
  if (!dir) return null
  for (const name of SKILL_NAMES) {
    const file = await desktop().join(dir, name)
    if (await desktop().exists(file)) return readSkillFile(file)
  }
  throw new Error(t('directorSkill.missingFile'))
}
