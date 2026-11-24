import type { VideoRefEntry } from './consistency'

/** 실제로 제출한 이미지 배열에서 번호를 매긴다. 등장인물 목록에서 참조 번호를 추정하지 않는다. */
export function withVideoReferenceBlock(prompt: string, entries: ReadonlyArray<Pick<VideoRefEntry, 'name' | 'kind'>>): string {
  const body = prompt
    .replace(/【实际参考图对应】[\s\S]*?【参考图对应结束】\s*/g, '')
    .replace(/\[Reference image assignments\][\s\S]*?\[End reference image assignments\]\s*/g, '')
    .trim()
  if (!entries.length) return body
  const labels: Record<string, string> = {
    character: 'character reference',
    scene: 'location reference',
    prop: 'prop reference',
    keyframe: 'keyframe',
    board: 'storyboard panel',
    extra: 'additional reference'
  }
  return [
    '[Reference image assignments]',
    ...entries.map((entry, index) => {
      const kind = labels[entry.kind]
      return `Picture ${index + 1}: ${entry.name || kind} (${kind})`
    }),
    'Assign each line to the existing character who speaks it. Location and prop images do not speak.',
    '[End reference image assignments]',
    body
  ].join('\n')
}
