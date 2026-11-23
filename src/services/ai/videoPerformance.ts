import type { Scene, Shot, Subject } from '@/types'
import { callLLM, getAIMode } from './client'
import { getVideoPromptStyle } from './runtime'
import {
  composeVideoPerformance,
  isVideoPerformanceTemplate,
  isVideoPerformanceThin,
  lacksEnsembleBlocking,
  stripFrameLead,
  thisShotAction,
  videoPerformanceSpec
} from '@/utils/shotPrompt'
import { parseJsonRobust } from '@/utils/jsonRepair'
import { importedDirectorPrefix } from '@/services/settings/directorSkill'

function shotLine(shot?: Shot): string {
  if (!shot) return '（없음）'
  const action = thisShotAction(shot.continuity) || shot.title || ''
  return `${shot.title || '제목 없음'}。${action}`
}

/**
 * 出视频前的内容表现：你亲手写过、且不像套话的原文原样用。
 * 空着、过短、缺少时间轴、或旧套话稿，按本镜剧情重写。
 */
export async function enrichVideoPerformance(opts: {
  shot: Shot
  prevShot?: Shot
  nextShot?: Shot
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  scene?: Pick<Scene, 'name' | 'description' | 'lighting' | 'mainAnchor'>
  chapterNotes?: string
  sceneExcerpt?: string
  force?: boolean
  signal?: AbortSignal
}): Promise<string> {
  const own = stripFrameLead((opts.shot.videoPrompt || '').trim())
  const names = (opts.subjects || []).map((s) => s.name).filter(Boolean)
  if (
    !opts.force &&
    own &&
    !isVideoPerformanceThin(own) &&
    !isVideoPerformanceTemplate(own) &&
    !lacksEnsembleBlocking(own, names)
  ) {
    return own
  }

  const current = composeVideoPerformance(opts.shot, {
    ignoreStored: opts.force || isVideoPerformanceTemplate(own) || lacksEnsembleBlocking(own, names)
  })
  if (getAIMode() === 'mock') return current

  const roster = (opts.subjects || [])
    .map((s) => `${s.name}${s.role ? `（${s.role}）` : ''}：${(s.description || '').slice(0, 180)}`)
    .join('\n')
  const scene = opts.scene
    ? `${opts.scene.name}。${opts.scene.description || ''} 광원 ${opts.scene.lighting || ''} 주요 기준물 ${opts.scene.mainAnchor || ''}`
    : ''

  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `${importedDirectorPrefix()}이미지→영상의 연출 프롬프트를 작성하세요. 생성 모델에 전달할 videoPrompt의 연출 문장은 중국어로 쓰고 대사 원문은 유지하세요. ${videoPerformanceSpec(getVideoPromptStyle())}
JSON만 출력하세요. {"videoPrompt":"..."}
배우에게 장면을 설명하는 말투로 쓰세요. 표를 채우는 방식은 피하고 이 샷의 ${opts.shot.duration}초 동안 일어나는 일만 쓰세요.
0초부터 ${opts.shot.duration}초까지 실제 이야기의 박자에 맞춰 2–5구간으로 나누세요. 시간을 기계적으로 등분하지 마세요. 구간별로 행동하는 인물, 동작과 표정, 화자와 대사 원문, 나머지 인물의 위치와 시선, 동기 있는 카메라 움직임과 도착점을 명시하세요. 타임라인은 감독의 연출 지시입니다. 네 줄로 요약하지 말고 구간마다 눈에 보이는 변화를 넣으세요.
화면에 등장하는 인물마다 앞뒤 위치, 몸 방향(측면 또는 4분의 3 방향이며 카메라 정면은 피함), 보는 사람이나 물건을 쓰세요. 화자는 뒤쪽에 있어도 됩니다. 앞쪽 인물은 고개를 돌려 화자나 화자가 가리킨 물건을 봅니다. 캐릭터 설정 이미지의 정면 구도를 최종 영상의 단체 사진 구도로 가져오지 마세요.
나쁜 예 「林遥指着田垄说话。老农和差役在场。人物看向场景里的人或物，不要看镜头。」
좋은 예 「近处：老农和差役侧对镜头站在石板路上。林遥在他们身后稍远，从跪姿撑起半身，泥手指向田垄。老农回头眯眼打量林遥，差役视线跟着那只手看向田垄。三个人都不看镜头。」
샷 이미지용 정지 프레임 프롬프트는 배경 설정으로만 쓰세요. continuity에 화살표가 있으면 가운데 구간만 연출하고 앞뒤 샷까지 포함하지 마세요.
대본의 각색 원칙, 촬영 제외 목록, 시대와 날씨를 지키세요. 성인이 된 인물의 내레이션은 화면 밖 음성이며 화면 속 사람들은 입을 다뭅니다. 선의는 평범한 사람이 하는 작은 일로 표현하고 구원자가 등장하는 것처럼 쓰지 마세요.`
        },
        {
          role: 'user',
          content: `캐릭터
${roster || '（화면에 이미 있는 캐릭터를 따름）'}

장면
${scene || '（참조 화면을 따름）'}

이전 샷(연결에만 사용. 다시 연출하지 않음) ${shotLine(opts.prevShot)}
다음 샷(이번 샷에 포함하지 않음) ${shotLine(opts.nextShot)}

현재 샷 제목 ${opts.shot.title}
길이 ${opts.shot.duration}초
카메라 움직임 ${opts.shot.cameraMovement}
인물 배치 ${opts.shot.blocking || ''}
시선 ${opts.shot.eyeline || '각 인물이 보는 대상을 명시하고 카메라를 보지 않게 하세요.'}
현재 샷의 캐릭터(각 인물의 위치와 시선 포함) ${names.join('、') || '（화면에 이미 있는 캐릭터를 따름）'}
현재 샷의 동작(이 부분만 촬영) ${thisShotAction(opts.shot.continuity) || opts.shot.blocking || opts.shot.title || ''}
소품 ${opts.shot.propFocus || '없음'}
대사 원문 ${opts.shot.voiceover || '（없음）'}
기존 초안(상투적인 문장이라면 다시 작성)
${own || current}

이 챕터의 필수 제약
${opts.chapterNotes || '（없음）'}

이 장면의 대본 원문(원문을 따르고 사건을 만들지 않음)
${opts.sceneExcerpt || '（없음. 현재 샷의 현장 기록을 따름）'}

참조 정지 화면(배경 설정으로만 사용. 다시 서술하지 않음)
${(opts.shot.visualPrompt || '').slice(0, 400)}`
        }
      ],
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 1600,
      signal: opts.signal
    })
    const parsed = parseJsonRobust(resp.content) as { videoPrompt?: string }
    const rich = stripFrameLead(String(parsed.videoPrompt || ''))
    if (!rich || rich === (opts.shot.visualPrompt || '').trim()) return current
    if (isVideoPerformanceTemplate(rich)) return current
    return rich
  } catch {
    return current
  }
}
