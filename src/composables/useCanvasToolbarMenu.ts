import { ref, watch } from 'vue'

export function useCanvasToolbarMenu() {
  const toolbar = ref<HTMLElement | null>(null)
  const moreOpen = ref(false)

  function dismissOutside(event: MouseEvent) {
    if (toolbar.value && !event.composedPath().includes(toolbar.value)) {
      moreOpen.value = false
    }
  }

  watch(moreOpen, (open, _, onCleanup) => {
    if (!open) return
    document.addEventListener('click', dismissOutside, true)
    onCleanup(() => document.removeEventListener('click', dismissOutside, true))
  })

  return { toolbar, moreOpen }
}
