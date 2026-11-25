import { throwIfAborted } from './abort'

export interface QualityReport {
  passed: boolean
  score: number
  issues: string[]
  retryHint?: string
}

/**
 * 이미지 생성 후 출력 파일 형식을 검사한다.
 *
 * 인물, 동작, 구도 및 스타일은 사용자가 판단한다.
 * 비전 모델의 평가로 워크플로를 중단하거나 다시 시도하지 않는다.
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

/** 영상도 출력 파일만 검사한다. */
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
  targetDuration: number,
  durationMs?: number
): Promise<QualityReport> {
  if (blob.size < 1_000 || !(blob.type || '').startsWith('audio/')) {
    return { passed: false, score: 0, issues: ['TTS가 올바른 오디오를 반환하지 않았어요.'] }
  }
  const spokenChars = text.replace(/[\s，。！？、,.!?；;]/g, '').length
  if (durationMs !== undefined) {
    const seconds = durationMs / 1000
    return seconds > targetDuration + 1.5
      ? {
          passed: false, score: 45,
          issues: [`더빙 길이 ${seconds.toFixed(1)}초가 샷 길이 ${targetDuration}초를 초과합니다. 대사를 줄이거나 샷 길이를 늘려 주세요.`]
        }
      : { passed: true, score: 100, issues: [] }
  }
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
