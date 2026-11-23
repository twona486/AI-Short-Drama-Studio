import { throwIfAborted } from './abort'

export interface QualityReport {
  passed: boolean
  score: number
  issues: string[]
  retryHint?: string
}

/**
 * 图片生成后只做文件级校验。
 *
 * 人物身份、动作、构图和画风等主观判断交给用户，不再调用视觉模型，
 * 也不会因为 AI 质检意见自动中止流水线或触发重试。
 */
export async function reviewImageQuality(
  blob: Blob,
  _expected: string,
  signal?: AbortSignal
): Promise<QualityReport> {
  throwIfAborted(signal)
  if (blob.size < 8_000 || !(blob.type || '').startsWith('image/')) {
    return { passed: false, score: 0, issues: ['응답이 올바른 이미지가 아니거나 파일이 너무 작아요.'] }
  }
  return { passed: true, score: 100, issues: [] }
}

/** 视频同样只校验输出文件，不再抽帧并交给视觉模型评价。 */
export async function reviewVideoQuality(
  blob: Blob,
  _expected: string,
  signal?: AbortSignal
): Promise<QualityReport> {
  throwIfAborted(signal)
  if (blob.size < 24_000 || !(blob.type || '').startsWith('video/')) {
    return { passed: false, score: 0, issues: ['응답이 올바른 영상이 아니거나 파일이 너무 작아요.'] }
  }
  return { passed: true, score: 100, issues: [] }
}

export async function reviewSpeechQuality(
  blob: Blob,
  text: string,
  targetDuration: number
): Promise<QualityReport> {
  if (blob.size < 1_000 || !(blob.type || '').startsWith('audio/')) {
    return { passed: false, score: 0, issues: ['TTS가 올바른 오디오를 반환하지 않았어요.'] }
  }
  const spokenChars = text.replace(/[\s，。！？、,.!?；;]/g, '').length
  const estimated = spokenChars / 4
  if (estimated > targetDuration + 1.5) {
    return {
      passed: false,
      score: 45,
      issues: [`${spokenChars}자 내레이션에 약 ${estimated.toFixed(1)}초가 필요해 샷 길이 ${targetDuration}초를 초과해요.`],
      retryHint: 'Shorten the narration or extend the shot. Avoid speeding up the delivery.'
    }
  }
  return { passed: true, score: 80, issues: [] }
}
