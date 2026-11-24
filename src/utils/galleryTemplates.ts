import { t } from '@/i18n'

const albumSizes = [10, 10, 8, 1]
export const galleryAlbums = ['solo', 'pair', 'action', 'character'] as const

const characterPrompt = `Create one 16:9 horizontal photorealistic character reference sheet for an original male courier at a mountain waystation, around 30 years old. He has a square jaw, thick eyebrows, short stubble and a faint scar on the left brow. His short hair is tied low with a dark blue cloth band. He wears a deep indigo cross-collar tunic, ochre shoulder cape, worn smoke-brown leather bracers, a crossbody canvas mailbag, charcoal leg wraps and worn leather boots.

On the left, show full-length front and rear views with complete footwear. Put a weathered frontal close-up in the center. On the right, use a two-column, three-row grid for left and right three-quarter views, the mailbag clasp, boots and wraps, the rear hair knot, and collar and bracer details. Keep the same identity, hair, clothes and accessories in all panels. Use a seamless warm gray studio, soft side light, natural skin and thin white dividers. Output one sheet with no text, watermark or logo. Exclude white-and-gold formalwear, crowns, long loose hair, jewelry and additional characters.`

export const galleryTemplates = albumSizes.flatMap((count, group) => Array.from({ length: count }, (_, index) => ({
  id: `template:${group}-${index}`,
  get title() { return t(`galleryTemplates.item${group}_${index}`) },
  album: group,
  prompt: group === 3 ? characterPrompt : undefined,
  url: `${import.meta.env.BASE_URL}gallery-templates/${group}-${index}.jpg`
})))
