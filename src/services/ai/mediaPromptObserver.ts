export type MediaKind = 'image' | 'video'
const observers = new WeakMap<AbortSignal, (kind: MediaKind, prompt: string) => void>()

export function observeMediaPrompts(signal: AbortSignal | undefined, onPrompt: (kind: MediaKind, prompt: string) => void) {
  const scoped = signal ? AbortSignal.any([signal]) : new AbortController().signal
  observers.set(scoped, onPrompt)
  return scoped
}

export function reportMediaPrompt(kind: MediaKind, prompt: string, signal?: AbortSignal) {
  if (signal) observers.get(signal)?.(kind, prompt)
}
