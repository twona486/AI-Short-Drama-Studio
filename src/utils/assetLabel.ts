import { t } from '@/i18n'
import type { Asset, Project } from '@/types'

export function assetContext(
  a: Asset,
  projects: Project[],
  current?: Project | null
) {
  const proj =
    projects.find((p) => p.id === a.projectId) ||
    (current?.id === a.projectId ? current : undefined)
  const shot =
    (proj?.shots ?? []).find((s) => s.id === a.shotId) ||
    current?.shots.find((s) => s.id === a.shotId)
  const projectName = proj?.name || (a.projectId ? t('assetLabel.otherProject') : t('assetLabel.unassigned'))
  const shotTitle = shot?.title
    ? t('assetLabel.storyboardTitle', { number: (shot.index ?? 0) + 1, title: shot.title })
    : ''
  const duration =
    a.kind === 'video' && 'duration' in a && a.duration
      ? `${Number(a.duration).toFixed(1)}s`
      : ''
  return {
    projectName,
    shotTitle,
    duration,
    title: shotTitle || a.filename || a.id,
    sub: [projectName, duration].filter(Boolean).join(' · ')
  }
}
