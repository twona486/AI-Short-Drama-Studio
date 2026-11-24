import { t } from '@/i18n'
import type { AspectRatio } from '@/types'

export const ASPECT_PRESETS: { value: AspectRatio; label: string; hint: string }[] = [
  { value: '16:9', label: '16:9', get hint() { return t('aspect.landscape') } },
  { value: '9:16', label: '9:16', get hint() { return t('aspect.portrait') } },
  { value: '1:1', label: '1:1', get hint() { return t('aspect.square') } },
  { value: '4:3', label: '4:3', get hint() { return t('aspect.classic') } },
  { value: '21:9', label: '21:9', get hint() { return t('aspect.cinema') } }
]

export function aspectToSize(ar: AspectRatio): { width: number; height: number } {
  switch (ar) {
    case '16:9':
      return { width: 1280, height: 720 }
    case '9:16':
      return { width: 720, height: 1280 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:3':
      return { width: 960, height: 720 }
    case '21:9':
      return { width: 1680, height: 720 }
  }
}

export function aspectFrameHint(ar?: string): string {
  if (ar === '9:16') return 'Portrait 9:16, full-screen mobile framing. Height must exceed width.'
  if (ar === '1:1') return 'Square 1:1, with equal width and height.'
  if (ar === '4:3') return 'Landscape 4:3.'
  if (ar === '21:9') return 'Ultrawide cinema framing, 21:9.'
  return 'Widescreen landscape 16:9. Width must exceed height.'
}

export function isLandscapeAspect(ar?: string): boolean {
  return ar === '16:9' || ar === '4:3' || ar === '21:9'
}
