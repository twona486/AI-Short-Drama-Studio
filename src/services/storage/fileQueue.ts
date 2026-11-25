const pending = new Map<string, Promise<unknown>>()

/** 읽기와 쓰기가 같은 저장 경로에서 겹치지 않도록 한다. */
export async function withFileQueue<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(path)
  const next = previous ? previous.then(run, run) : run()
  pending.set(path, next)
  try {
    return await next
  } finally {
    if (pending.get(path) === next) pending.delete(path)
  }
}
