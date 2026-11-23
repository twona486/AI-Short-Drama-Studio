import { ref } from 'vue'

/** 현재 생성 중인 캔버스 노드. 여러 노드를 독립적으로 실행할 수 있다. */
export const runningNodeIds = ref<string[]>([])

export function isNodeRunning(id: string) {
  return runningNodeIds.value.includes(id)
}

export async function withNodeJob<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (runningNodeIds.value.includes(id)) {
    throw new Error('이 노드에서 이미 생성하고 있습니다.')
  }
  runningNodeIds.value = [...runningNodeIds.value, id]
  try {
    return await fn()
  } finally {
    runningNodeIds.value = runningNodeIds.value.filter((x) => x !== id)
  }
}

/** AutoDL 일괄 영상 생성의 동시 요청 상한 */
export const VIDEO_GEN_CONCURRENCY = 8

export async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (!items.length) return
  const queue = [...items]
  const n = Math.min(Math.max(1, limit), queue.length)
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift()
        if (item === undefined) break
        try {
          await fn(item)
        } catch {
          /* 개별 실패가 나머지 작업을 중단시키지 않는다. */
        }
      }
    })
  )
}
