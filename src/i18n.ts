import { watch } from 'vue'
import { createI18n } from 'vue-i18n'
import type { Router } from 'vue-router'
import ko from './locales/ko'
import zh from './locales/zh'

const LOCALE_KEY = 'studio.locale'
type Locale = 'ko' | 'zh'

function loadLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_KEY) === 'zh' ? 'zh' : 'ko'
  } catch {
    return 'ko'
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: loadLocale(),
  fallbackLocale: 'zh',
  messages: { ko, zh: { ...zh, elevenLabs: ko.elevenLabs } }
})

export const { locale, t } = i18n.global

export const uiPunctuation = {
  get colon() { return locale.value === 'zh' ? '：' : ': ' },
  get comma() { return locale.value === 'zh' ? '，' : ', ' },
  get listSeparator() { return locale.value === 'zh' ? '、' : ', ' },
  get semicolon() { return locale.value === 'zh' ? '；' : '; ' },
  get closeParen() { return locale.value === 'zh' ? '）' : ')' },
  get sentenceSeparator() { return locale.value === 'zh' ? '。' : '. ' },
  quote(value: string) { return locale.value === 'zh' ? `「${value}」` : `“${value}”` },
  parenthetical(value: string | number) {
    return locale.value === 'zh' ? `（${value}）` : ` (${value})`
  }
}

export function setLocale(value: Locale) {
  locale.value = value
  try {
    localStorage.setItem(LOCALE_KEY, value)
  } catch {
    // Storage can be unavailable in a restricted browser session.
  }
}

export function syncDocumentLocale(router: Router) {
  watch([locale, router.currentRoute], ([language, route]) => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'ko'
    const title = t('common.appName')
    const label = route.meta.label
    document.title = typeof label === 'string' ? `${t(label)} · ${title}` : title
    document.querySelector('meta[name=description]')?.setAttribute('content', t('common.appDescription'))
  }, { immediate: true })
  watch(locale, (language) => {
    void window.desktop?.setLocale(language).catch((error) => {
      console.warn('Unable to synchronize the desktop locale', error)
    })
  }, { immediate: true })
}
