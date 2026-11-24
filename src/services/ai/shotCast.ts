import { blobToChatImageUrl, callLLM, getAIMode } from './client'
import { getVisionConfig } from './runtime'
import type { Subject } from '@/types'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import { parseJsonRobust } from '@/utils/jsonRepair'

function fallbackLock(style: VideoPromptStyle): string {
  if (style === 'formatted') {
    return 'Keep the people already visible. Do not add passersby or change their faces, hair, or clothing.'
  }
  return 'In the frame: keep the people, positions, and appearances from the reference image. Do not add passersby.'
}

/**
 * 비전 모델로 샷 이미지에서 인물을 찾아 H3 프롬프트 앞에 쓸 인물 매핑을 만든다.
 */
export async function h3IdentityLockFromFrame(opts: {
  imageBlob: Blob
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  signal?: AbortSignal
  promptStyle?: VideoPromptStyle
}): Promise<string> {
  const style = opts.promptStyle ?? 'scene-narrative'
  if (getAIMode() === 'mock') return fallbackLock(style)

  const roster = (opts.subjects || [])
    .map((s, i) => `${i + 1}. ${s.name}${s.role ? `（${s.role}）` : ''}：${(s.description || '').slice(0, 280)}`)
    .join('\n')

  // 샷 이미지와 캐릭터 목록을 대조해 영상 모델용 영어 식별 문구를 만든다.
  const system =
    style === 'formatted'
      ? `Identify each visible person in the storyboard image using the supplied cast list.
Return JSON only: {"identityLock":"In the frame: identify who stands where and what they wear. Do not add people or change faces or clothes."}
Write the generation-model value in English, preserving each cast name as supplied. Identify people by clothing, hair, and position. If there are no people, say that the location is empty.`
      : `Identify each visible person in the storyboard image using the supplied cast list.
Return JSON only: {"identityLock":"In the frame: identify the first person by position, hair, clothing, activity, and approximate age; then identify the next person."}
Write the generation-model value in English. Use one continuous sentence beginning with "In the frame:" and separate people with semicolons. For each person, specify position, hairstyle, clothing, what their hands and feet are doing, and approximate age, then use the exact cast name.
Example: In the frame: the barefoot four-year-old in the foreground, crouching with two tufts tied with gray cloth and holding a pear in both hands, is Kong Rong; the man in his early thirties crouching on the right, with callused hands, a wooden hairpin, and the sleeves of a worn blue-green robe rolled up, is Father.
Do not add a list, an instruction to continue from the first frame, or a prohibition on changing faces. When nobody is visible, write "The frame shows an empty location."`

  const user = `Project cast list
${roster || '(no named characters)'}

Identify the visible cast from this storyboard image.`

  try {
    const url = await blobToChatImageUrl(opts.imageBlob)
    const resp = await callLLM({
      provider: 'vision',
      model: getVisionConfig().model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url } }
          ]
        }
      ],
      jsonMode: true,
      temperature: 0.1,
      maxTokens: style === 'scene-narrative' ? 900 : 500,
      signal: opts.signal
    })
    const lock = String(
      (parseJsonRobust(resp.content) as { identityLock?: string }).identityLock || ''
    ).trim()
    return lock || fallbackLock(style)
  } catch {
    return fallbackLock(style)
  }
}
