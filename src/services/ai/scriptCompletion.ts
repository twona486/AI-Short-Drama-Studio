/** 제공업체가 중간에 끊겼다고 표시한 응답을 완성한 대본이나 개요로 저장하지 않는다. */
export function assertScriptCompletion(response: { finishReason?: string }): void {
  if (response.finishReason === 'length' || response.finishReason === 'max_tokens') {
    throw new Error('모델이 출력 한도에 도달했어요. 기존 본문을 보관했어요. 출력 한도를 확인하거나 한 번에 요청하는 회차 수와 분량을 줄여 주세요.')
  }
}
