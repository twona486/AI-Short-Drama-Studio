import { locale } from '@/i18n'

export function confirmAction(message: string): Promise<boolean> {
  if (window.desktop) {
    return window.desktop.confirmAction(message, locale.value === 'zh' ? 'zh' : 'ko')
  }
  return Promise.resolve(window.confirm(message))
}
