export function runEnterShortcut(event: KeyboardEvent, action: () => void) {
  // Some IMEs report the confirmation key as 229 even when isComposing is false.
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!event.repeat) action()
}
