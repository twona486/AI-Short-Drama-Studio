import type { Project } from '@/types'
import { isPlayApproved, needsPlayReview } from './playGate'
import { needsExternalTts } from '@/utils/shot'
import { frameStagePending, shotsMissingKeyframe, shotsMissingStoryboard } from '@/utils/videoStill'

export interface PipelineStep {
  id: 'play' | 'board' | 'review' | 'cast' | 'panels' | 'images' | 'frames' | 'videos' | 'audio'
  label: string
  tools: { tool: string }[]
  focusNodeId?: string
}

export type ExtractStage = 'subjects' | 'scenes' | 'shots'

export function nextExtractStage(p: Project | null | undefined): ExtractStage | null {
  if (!(p?.subjects ?? []).length) return 'subjects'
  if (!(p?.scenes ?? []).length) return 'scenes'
  if (!p?.shots.length) return 'shots'
  return null
}

export function extractStageNoun(stage: ExtractStage): string {
  if (stage === 'subjects') return '캐릭터'
  if (stage === 'scenes') return '장면 기준 정보'
  return '스토리보드'
}

export function extractStageFromText(text: string): ExtractStage | undefined {
  const t = String(text || '').trim()
  if (/人物/.test(t) && !/场景|分镜/.test(t)) return 'subjects'
  if (/(场景描点|场景锚点|场景)/.test(t) && !/分镜/.test(t)) return 'scenes'
  if (/分镜|提炼节点|重新提炼/.test(t)) return 'shots'
  return undefined
}

export function extractStageLabel(p: Project | null | undefined): string {
  const stage = nextExtractStage(p)
  if (stage === 'subjects') return '1단계 — 캐릭터 추출'
  if (stage === 'scenes') return '2단계 — 장면 추출'
  if (stage === 'shots') return '3단계 — 스토리보드 추출'
  return '해당 그룹에서 ‘다시 추출’을 선택하세요.'
}

export function nextPipelineStep(p: Project | null | undefined): PipelineStep | null {
  if (!p) return { id: 'play', label: '대본 작성', tools: [{ tool: 'generate_play' }], focusNodeId: 'script' }
  const playReady = Boolean(p.script?.playReady && p.script.content?.trim())
  if (!playReady) {
    return {
      id: 'play',
      label: '대본 작성',
      tools: [{ tool: 'generate_play' }],
      focusNodeId: 'script'
    }
  }
  if (!p.shots.length) {
    return {
      id: 'board',
      label: extractStageLabel(p),
      tools: [{ tool: 'extract_cast' }],
      focusNodeId: 'script'
    }
  }
  if (!isPlayApproved(p)) {
    return {
      id: 'review',
      label: '대본 검수',
      tools: [{ tool: 'approve_play' }],
      focusNodeId: 'script'
    }
  }
  const missingFour = (p.subjects ?? []).some((s) => !s.designSheetAssetId)
  if (missingFour) {
    return {
      id: 'cast',
      label: '캐릭터 4면 설정 이미지',
      tools: [{ tool: 'generate_all_sheets' }],
      focusNodeId: 'group-subjects'
    }
  }
  const missingPlates = (p.scenes ?? []).some((s) => !s.plateAssetId)
  if (missingPlates) {
    return {
      id: 'cast',
      label: '장면 기준 이미지',
      tools: [{ tool: 'generate_all_scenes' }],
      focusNodeId: 'group-scenes'
    }
  }
  const missingBoards = shotsMissingStoryboard(p)
  if (missingBoards.length) {
    return {
      id: 'panels',
      label: '스토리 개요판 이미지',
      tools: [{ tool: 'generate_all_boards' }],
      focusNodeId: 'group-shots'
    }
  }
  const missingKeyframes = shotsMissingKeyframe(p)
  if (missingKeyframes.length) {
    return {
      id: 'images',
      label: '스토리보드 키프레임',
      tools: [{ tool: 'generate_all_images' }],
      focusNodeId: 'group-shots'
    }
  }
  // 首尾帧模式：视频用的就是这两张帧，必须先画，否则这一列会被整条流水线跳过。
  if (frameStagePending(p)) {
    return {
      id: 'frames',
      label: '시작·끝 프레임',
      tools: [{ tool: 'generate_all_frames' }],
      focusNodeId: 'group-frames'
    }
  }
  if (p.shots.some((s) => !s.videoAssetId)) {
    return {
      id: 'videos',
      label: '스토리보드 샷 영상',
      tools: [{ tool: 'generate_all_videos' }],
      focusNodeId: 'group-videos'
    }
  }
  if (p.shots.some((s) => needsExternalTts(s, p) && !s.audioAssetId)) {
    return {
      id: 'audio',
      label: '내레이션',
      tools: [{ tool: 'generate_all_audio' }],
      focusNodeId: 'group-shots'
    }
  }
  return null
}

export function isContinueRequest(text: string) {
  const t = text.trim()
  if (/确认剧本|验收通过|确认通过|剧本没问题|通过验收/.test(t) && !/继续/.test(t)) {
    return false
  }
  return (
    /^(?:계속|다음\s*단계)[\s,.!?。！]*$/.test(t) ||
    /^(继续|下一步|接着做|往下|往下做|可以往下|可以|好的|好|要|嗯|行|开始|开始做|帮我做|做一下)([，,。!！ ]*)$/.test(
      t
    ) || /^(继续往下|继续做|继续吧|接着做|接着往下|下一步|往下做)([，,。!！ ]*)$/.test(t)
  )
}

/** 打招呼 / 闲聊，不应当成「需求含糊」去套澄清模板 */
export function isGreetingOrChitchat(text: string) {
  const t = text.trim()
  if (!t) return false
  if (
    /^(你好|您好|嗨|哈喽|哈囉|在吗|在嘛|在不在|早上好|中午好|下午好|晚上好|你好啊|你好呀|hey|hi|hello|yo)([！!。.～~吗？? ]*)$/i.test(
      t
    )
  ) {
    return true
  }
  if (/^(你好|您好|嗨|哈喽|hey|hi|hello)[，,！!。. ]*(在吗|请问|帮个忙)?$/i.test(t) && t.length <= 12) {
    return true
  }
  return false
}

export function isVagueRequest(text: string, p: Project | null | undefined) {
  const t = text.trim()
  if (!t) return true
  if (isGreetingOrChitchat(t)) return false
  if (
    /拆分镜|拆镜|故事板|故事看板|看板图|出分镜|生成分镜|剧本|续写|接着写|人设|四视图|资产图|角色图|场景图|底板|配图|出图|视频|口播|第.+镜|全流程|全部做完|确认通过|验收|继续|下一步/.test(
      t
    )
  ) {
    return false
  }
  if (isContinueRequest(t)) return false
  if (t.length >= 20 && (p?.script?.content || /视频|短片|口播|带货|教程/.test(t))) {
    return false
  }
  if (t.length < 12) return true
  return /帮我|做一下|弄一下|搞一个|来一个|好看|开始吧/.test(t) && t.length < 18
}

export function clarifyMessage(p: Project | null | undefined): string {
  const lines = ['작업 범위를 정하기 위해 몇 가지를 알려 주세요.']
  if (!p?.script?.content?.trim()) {
    lines.push('1. 영상의 주제나 내레이션 원고가 있나요?')
    lines.push('2. 목표 길이는 몇 초인가요? 예를 들어 15초, 30초, 1분입니다.')
    lines.push('3. 대본만 필요하신가요, 아니면 캐릭터 설정·장면 이미지·스토리 개요판도 만들까요? 모두 진행하려면 ‘전체 워크플로’라고 요청하세요.')
    return lines.join('\n')
  }
  if (!p.script?.playReady) {
    return '초안이 있습니다. ‘대본 작성’이나 ‘계속’이라고 하면 전체 대본부터 작성합니다. 노드 추출은 그다음 단계입니다.'
  }
  if (!p.shots.length) {
    return `왼쪽에 전체 대본이 있습니다. ‘계속’이라고 하면 ‘${extractStageLabel(p)}’을 실행한 뒤 결과를 보여 드립니다.`
  }
  if (needsPlayReview(p)) {
    return '캔버스에 스토리보드 노드를 배치했습니다. 검토한 뒤 ‘검수 통과’나 ‘계속’이라고 하면 캐릭터 설정과 장면 이미지를 생성합니다.'
  }
  const n = nextPipelineStep(p)
  if (n) {
    return `다음 단계는 ‘${n.label}’입니다. ‘계속’이라고 하면 이 단계를 진행합니다. ‘전체 워크플로’라고 하면 모두 실행합니다.`
  }
  return '캐릭터 설정, 장면, 영상이 모두 갖춰졌습니다. ‘영상 합성’을 눌러 결과를 만들 수 있습니다.'
}

export function continueQuestion(next: PipelineStep | null, justDid: string) {
  if (!next) return `${justDid}워크플로의 산출물이 모두 있습니다. 특정 샷을 바꾸려면 노드를 선택해 다시 생성하세요.`
  return `${justDid}‘${next.label}’을 진행할까요? ‘계속’은 다음 한 단계, ‘전체 워크플로’는 남은 모든 단계를 실행합니다.`
}

export const TOOL_LABEL: Record<string, string> = {
  generate_play: '전체 대본 작성',
  continue_play: '대본 이어 쓰기',
  generate_storyboard: '전체 대본 작성',
  extract_cast: '캐릭터·장면·스토리보드 추출(그룹 지정 가능)',
  approve_play: '대본 승인 기록',
  revise_shot: '스토리보드 샷 부분 수정',
  generate_sheet: '4면 설정 이미지 생성',
  generate_all_sheets: '누락된 4면 설정 이미지 생성',
  generate_prop_sheet: '장면 주요 소품 이미지 생성',
  generate_all_prop_sheets: '누락된 장면 주요 소품 이미지 생성',
  generate_scene: '장면 기준 이미지 생성',
  generate_all_scenes: '누락된 장면 기준 이미지 생성',
  generate_shot_board: '스토리 개요판 생성',
  generate_all_boards: '누락된 스토리 개요판 생성',
  generate_shot_image: '키프레임 생성',
  generate_all_images: '누락된 키프레임 생성',
  generate_shot_frames: '시작·끝 프레임 생성',
  generate_all_frames: '누락된 시작·끝 프레임 생성',
  generate_video: '스토리보드 샷 영상 생성',
  generate_all_videos: '누락된 스토리보드 샷 영상 생성',
  generate_audio: '내레이션 생성',
  generate_all_audio: '누락된 내레이션 생성',
  sync_canvas: '캔버스 동기화',
  create_image_node: '이미지 노드 만들기',
  create_video_node: '영상 노드 만들기',
  connect_nodes: '캔버스 노드 연결',
  delete_node: '캔버스 노드 삭제',
  arrange_canvas: '캔버스 배치 정리',
  check_project: '프로젝트 점검',
  update_node: '생성 노드 수정',
  run_node: '노드 실행',
  optimize_node_prompt: '노드 프롬프트 최적화',
  remember: '선호 기억',
  forget: '기억 삭제',
  focus_node: '캔버스 노드로 이동'
}
