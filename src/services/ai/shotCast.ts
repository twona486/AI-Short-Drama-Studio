import { blobToChatImageUrl, callLLM, getAIMode } from './client'
import { getVisionConfig } from './runtime'
import type { Subject } from '@/types'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import { parseJsonRobust } from '@/utils/jsonRepair'

function fallbackLock(style: VideoPromptStyle): string {
  if (style === 'formatted') {
    return '画面中已经出现的人物保持不变，不要增加路人，不要换脸、换发型、换衣服。'
  }
  return '画面中：保持参考图里已经出现的人物、站位和外貌，不要增加路人。'
}

/**
 * 用视觉模型认本镜配图里谁是谁，产出中文身份锁（给 H3 视频内容表现开头）。
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

  const system =
    style === 'formatted'
      ? `이 스토리보드의 샷 이미지 한 장을 보고 명단과 대조해 각 인물이 누구인지 밝히세요.
JSON만 출력하세요.
{"identityLock":"画面中：穿什么/站在哪的人是谁（用名单里的中文名）。接着写不要加路人、不要换脸换装。"}
생성 모델에 전달할 값은 중국어로 작성하세요. 의상, 헤어스타일, 위치를 근거로 명단의 이름을 쓰세요. 인물이 없으면 빈 장면이라고 쓰세요.`
      : `이 스토리보드의 샷 이미지 한 장을 보고 명단과 대조해 각 인물이 누구인지 밝히세요.
JSON만 출력하세요.
{"identityLock":"画面中：站位、发型、衣服、手脚正在做什么、年龄的人是名单里的中文名；下一个人……"}
규칙
- 생성 모델에 전달할 값은 중국어로만 쓰고 「画面中：…」으로 시작하는 한 문장으로 연결하세요. 인물 사이에는 세미콜론을 넣으세요.
- 인물마다 화면 속 위치, 헤어스타일, 의상, 손발의 동작, 대략적인 나이를 넣고 「是【名字】」로 끝내세요.
- 예시 画面中：蹲在前景、头顶两个小揪用灰布条缠着、穿灰布短衣赤脚、手捧梨看向前方的四岁男童是孔融；右侧蹲坐、发髻木簪固定、穿洗旧青色直裾袖口挽起、手有茧的三十出头男性是父亲。
- 첫 프레임부터 이어서 연기하라는 표현, 얼굴을 바꾸지 말라는 금지 문구, 항목별 나열을 쓰지 마세요.
- 인물이 없으면 「画面中没有人物，这是空景。」이라고 쓰세요.`

  const user = `대조에 사용할 프로젝트 캐릭터 명단
${roster || '（이름이 있는 캐릭터 없음）'}

이 스토리보드 이미지를 근거로 캐릭터 식별 문구를 작성하세요.`

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
