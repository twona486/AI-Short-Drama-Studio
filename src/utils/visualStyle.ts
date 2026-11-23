/**
 * 画面风格词库：给 LLM 分镜 / 配图 / 人设共用
 * 避免只传英文枚举（cinematic）导致模型写成空泛提示。
 */

import type { VisualStyle } from '@/types'

export const VISUAL_STYLE_LABEL: Record<VisualStyle, string> = {
  cinematic: '电影感',
  anime: '日系动画',
  photorealistic: '写实摄影',
  '3d-render': '三维渲染',
  'oil-painting': '古典油画',
  watercolor: '水彩画',
  'pixel-art': '复古像素',
  'ink-wash': '中国水墨'
}

/** 用户口语别名。更长短语在前，便于从原文抽出「水墨风」而不是只命中「墨」 */
export const STYLE_ALIASES: Record<VisualStyle, string[]> = {
  'ink-wash': [
    '中国水墨画',
    '中国水墨',
    '水墨写意',
    '水墨风格',
    '水墨风',
    '水墨画',
    '写意画',
    'ink-wash',
    'ink wash',
    'inkwash',
    '水墨',
    '国画',
    '写意',
    '工笔',
    '宣纸'
  ],
  watercolor: ['水彩画风', '水彩画', '水彩风', 'watercolor', '水彩'],
  'oil-painting': ['古典油画', '油画风', 'oil painting', 'oil-painting', '厚涂', '油画'],
  'pixel-art': ['像素风格', '像素风', 'pixel-art', 'pixel art', '像素画', '像素'],
  '3d-render': ['三维渲染', '3d渲染', '3d-render', 'blender', 'octane', 'c4d'],
  anime: ['日系动画', '二次元', '赛璐璐', '动漫风', '动画风', 'anime', '动漫', '动画'],
  photorealistic: ['写实摄影', '超写实', 'photorealistic', '纪实摄影', '真人实拍'],
  cinematic: ['电影剧照', '院线电影', '胶片摄影', '电影感', 'cinematic', '胶片颗粒']
}

const INFER_ORDER: VisualStyle[] = [
  'ink-wash',
  'watercolor',
  'oil-painting',
  'pixel-art',
  '3d-render',
  'anime',
  'photorealistic',
  'cinematic'
]

const TECHNIQUE_HINT: Record<VisualStyle, RegExp> = {
  'ink-wash': /宣纸|墨色|墨分|焦浓|浓淡|留白|飞白|晕染|笔锋/,
  watercolor: /晕染|水渍|纸纹|渗化|透明叠色/,
  'oil-painting': /厚涂|笔触|布面|伦勃朗/,
  'pixel-art': /像素格|色板|抖动/,
  '3d-render': /pbr|全局光|octane|blender/i,
  anime: /赛璐璐|线稿|分阶|眼睛高光/,
  photorealistic: /毛孔|浅景深|纪实|织物纹理/,
  cinematic: /胶片|剧照|景深|焦段|光比|颗粒/
}

/** 每种风格必须写进 visualPrompt 的媒介/技法锚点 */
export const VISUAL_STYLE_GUIDE: Record<
  VisualStyle,
  {
    medium: string
    mustInclude: string
    avoid: string
    sampleTail: string
  }
> = {
  "cinematic": {
    medium: "Film still / film photography",
    mustInclude: "cinematic color grading, shallow or layered depth of field, dramatic lighting ratios, a clear lens perspective such as 35mm/50mm/85mm, film grain or cinematic contrast, negative space, and leading lines",
    avoid: "Avoid flat illustration, oversized anime eyes, and cartoon outlines.",
    sampleTail: "Use warm/cool or teal/orange contrast, soft film grain, controlled highlights, open shadows, and feature-film framing."
  },
  "anime": {
    medium: "Japanese cel animation / animated feature frame",
    mustInclude: "clean line art or color shapes, cel shading, stepped lighting, highlights in hair and eyes, expressive anime proportions, and clear spatial relationships even in simplified backgrounds",
    avoid: "Avoid live-action photography, visible skin pores, and oil brushwork.",
    sampleTail: "Use clean line art, cel shading, visible eye highlights, and atmospheric perspective in a bright animated feature frame."
  },
  "photorealistic": {
    medium: "Commercial photography / documentary photography",
    mustInclude: "plausible materials and microtexture, such as pores and fabric weave, natural light, photographic depth of field, optional slight lens distortion, and credible reflections",
    avoid: "Avoid anime faces, visible brushstrokes, and cartoon outlines.",
    sampleTail: "Use natural light, realistic surface details, shallow depth of field, and commercial photographic sharpness without illustration strokes."
  },
  "3d-render": {
    medium: "3D render / C4D, Blender, or Octane",
    mustInclude: "PBR materials, global illumination, soft area light or HDRI, clean modeled edges, skin subsurface scattering, and product-grade highlights",
    avoid: "Avoid hand-painted brushwork, pixel blocks, and ink bleeding.",
    sampleTail: "Use clean 3D models with PBR materials, global illumination, and soft reflections as in Octane or Blender."
  },
  "oil-painting": {
    medium: "Classical oil painting",
    mustInclude: "visible strokes and impasto, canvas texture, classical chiaroscuro such as Rembrandt lighting, layered and mixed pigments, and museum-quality composition",
    avoid: "Avoid digital photographic sharpness, flat cel shading, and pixel art.",
    sampleTail: "Use impasto, canvas texture, dramatic light and dark, and restrained colors suited to a classical oil painting."
  },
  "watercolor": {
    medium: "Watercolor painting",
    mustInclude: "pigment blooms and watermarks, visible paper grain, transparent layers, intermittent soft bleeding edges, and negative space",
    avoid: "Avoid heavy oil impasto, hyperreal photography, and hard-edged vector shapes.",
    sampleTail: "Use transparent washes with natural blooms, visible paper grain, soft bleeding edges, and a luminous, clear palette."
  },
  "pixel-art": {
    medium: "Retro pixel art",
    mustInclude: "visible pixel grids, a limited palette, no anti-aliasing or controlled dithering, 16-bit or 32-bit game aesthetics, and readable silhouettes",
    avoid: "Avoid high-definition photography, smooth vector gradients, and realistic pores.",
    sampleTail: "Use a clear pixel grid, a limited palette, and subtle dithering as in classic console games."
  },
  "ink-wash": {
    medium: "Chinese ink wash / freehand ink on xuan paper",
    mustInclude: "five ink tones from burnt black to pale wash, dry and wet strokes with flying white, centered and side brush techniques with pressure variation, ample negative space, xuan-paper fibers and watermarks, and freehand garment folds or distant landscapes",
    avoid: "Avoid live-action photos and visible pores, gray studio character sheets, plastic 3D, flat cel shading, thick Western oil paint, and generic film color-grading language.",
    sampleTail: "Use layered ink tones on xuan paper, controlled dry-brush texture and negative space, centered brush strokes for folds, and soft distant washes with visible paper grain."
  }
}

export function styleLabel(style: VisualStyle): string {
  return VISUAL_STYLE_LABEL[style] || style
}

function joinedText(...texts: Array<string | undefined>): string {
  return texts.filter(Boolean).join('\n')
}

function flattenTexts(...texts: Array<string | string[] | undefined>): string[] {
  return texts.flatMap((t) => (Array.isArray(t) ? t : t ? [t] : []))
}

/** 不是画风的「X风」 */
const MEDIUM_STOP = new Set([
  '台风',
  '作风',
  '学风',
  '校风',
  '门风',
  '家风',
  '文风',
  '民风',
  '通风',
  '漏风',
  '吹风',
  '刮风',
  '整风',
  '党风',
  '口风',
  '耳风',
  '上风',
  '下风',
  '中风',
  '逆风',
  '顺风',
  '威风',
  '风风',
  '风光',
  '风险',
  '风波',
  '风声',
  '风头',
  '风凉'
])

const OPEN_MEDIUM_CUE =
  /风格|画风|质感|电影感|动画|动漫|二次元|写实|摄影|渲染|油画|水彩|像素|水墨|赛博|蒸汽朋克|复古|胶片|手绘|插画|国风|赛璐璐|厚涂|扁平|3d|黏土|粘土|剪纸|皮影|浮世绘|波普|定格|卡通|q版|cel-shad/

/** 卡通渲染 / Q 版 / Cel-shading：词库里没有独立枚举，不能落到「像素」或写实 PBR 3D */
const CEL_SHADE_PHRASE =
  /卡通渲染(?:（Cel-shading）)?(?:\s*3D)?(?:\s*[+＋]\s*)?(?:Q\s*版(?:人物)?)?|Cel-shading(?:\s*3D)?|Q\s*版人物|卡通\s*3D|3D\s*卡通/i

function extractCelShadePhrase(blob: string): string {
  const hit = blob.match(CEL_SHADE_PHRASE)
  if (!hit?.[0]) return ''
  return hit[0].replace(/\s+/g, ' ').trim()
}

/** 从用户原话抽出画风词：先抓「X风/X风格」，再匹配已知画种。剧名不算画风。 */
export function extractUserMediumPhrase(...texts: Array<string | undefined>): string {
  const blob = joinedText(...texts)
  if (!blob.trim()) return ''

  const cel = extractCelShadePhrase(blob)
  if (cel) return cel

  const open: string[] = []
  for (const m of blob.matchAll(/([\u4e00-\u9fffA-Za-z0-9]{1,12}(?:风格|画风))/g)) {
    if (m[1]) open.push(m[1])
  }
  for (const m of blob.matchAll(/([\u4e00-\u9fffA-Za-z]{2,8}风)/g)) {
    const w = m[1]
    if (w && !MEDIUM_STOP.has(w)) open.push(w)
  }
  open.sort((a, b) => b.length - a.length)
  if (open[0]) return open[0]

  const lower = blob.toLowerCase()
  const ranked = INFER_ORDER.flatMap((style) =>
    STYLE_ALIASES[style].map((alias) => ({ alias, style }))
  ).sort((a, b) => b.alias.length - a.alias.length)

  for (const { alias } of ranked) {
    if (alias.length < 2) continue
    const hit = /[a-z]/i.test(alias) ? lower.includes(alias.toLowerCase()) : blob.includes(alias)
    if (hit) return alias
  }

  const compact = blob.replace(/\s+/g, '')
  if (compact.length > 0 && compact.length <= 16 && OPEN_MEDIUM_CUE.test(compact)) {
    return blob.trim().slice(0, 24)
  }
  return ''
}

/** 主题/文案里点名了哪种画风。未点名返回 null，不要默认电影感。 */
export function inferVisualStyleFromText(...texts: Array<string | undefined>): VisualStyle | null {
  const blob = joinedText(...texts)
  if (!blob.trim()) return null
  // 点了卡通渲染 / Q 版就不要对成词库里的像素或写实三维
  if (extractCelShadePhrase(blob)) return null
  const lower = blob.toLowerCase()
  for (const style of INFER_ORDER) {
    const hit = STYLE_ALIASES[style].some((alias) => {
      if (alias.length < 2) return false
      return /[a-z]/i.test(alias) ? lower.includes(alias.toLowerCase()) : blob.includes(alias)
    })
    if (hit) return style
  }
  return null
}

export function resolveVisualStyle(
  fallback: VisualStyle,
  ...texts: Array<string | string[] | undefined>
): VisualStyle {
  const flat = flattenTexts(...texts)
  return inferVisualStyleFromText(...flat) ?? fallback
}

export interface VisualLook {
  /** 接口仍要枚举：仅当原文能对上已知画种时才改，否则保持下拉值 */
  style: VisualStyle
  /** 展示用：用户原词，或下拉风格中文名 */
  medium: string
  /** 原文对上的已知画种，对不上则为 null（黏土风、剪纸等） */
  matched: VisualStyle | null
  /** 用户原文里点名了画风（X风/X风格/已知画种），不是我们拿下拉名填的 */
  userNamed: boolean
}

export function lookFromTexts(
  fallback: VisualStyle,
  ...texts: Array<string | string[] | undefined>
): VisualLook {
  const flat = flattenTexts(...texts)
  const named = extractUserMediumPhrase(...flat)
  const matched = inferVisualStyleFromText(...flat)
  return {
    style: matched ?? fallback,
    medium: named || styleLabel(matched ?? fallback),
    matched,
    userNamed: Boolean(named)
  }
}

/** 只取正文里点名画风的行，避免把对白里的「电影」「风格」误当成全片画风。 */
export function styleLinesFromPlay(content?: string): string {
  return (content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /画风|视觉风格|画面风格|美术风格|绘制风格|风格要求|整体风格|画面质感/.test(line))
    .join('\n')
}

export function lookFromScript(
  script?: {
    style?: VisualStyle
    topic?: string
    content?: string
    keywords?: string[]
    aesthetic?: string
    styleBrief?: string
  } | null,
  ...extra: Array<string | undefined>
): VisualLook {
  const fallback = script?.style ?? 'cinematic'
  return lookFromTexts(
    fallback,
    script?.topic,
    script?.keywords,
    script?.aesthetic,
    script?.styleBrief,
    styleLinesFromPlay(script?.content),
    ...extra
  )
}

/** 用户点了非实拍媒介时，人设不要走摄影棚三视图 */
export function isPhotographicLook(look: VisualLook): boolean {
  if (look.matched) {
    return look.matched === 'cinematic' || look.matched === 'photorealistic'
  }
  if (look.userNamed) {
    return /电影|摄影|写实|实拍|纪实|胶片|剧照|真人/.test(look.medium)
  }
  return look.style === 'cinematic' || look.style === 'photorealistic'
}

/** 分镜/人设/配图共用的画风锁。有用户原词就锁原词；对得上词库才补该画种技法。 */
export function mediumLockText(look: VisualLook): string {
  if (look.userNamed && look.matched) {
    const userBit =
      look.medium !== styleLabel(look.matched)
        ? `Use the user's exact requested medium: ${look.medium}. `
        : `Use ${VISUAL_STYLE_GUIDE[look.matched].medium}. `
    return `${userBit}${styleLockSuffix(look.matched)} ${professionalQualityLock(look.matched)}`
  }
  if (look.userNamed) {
    return `Use the medium the user requested: ${look.medium}. Match its materials, techniques, and texture to production quality. Do not substitute a different style.`
  }
  return `${styleLockSuffix(look.style)} ${professionalQualityLock(look.style)}`
}

export function promptHasTechnique(prompt: string, style: VisualStyle): boolean {
  return TECHNIQUE_HINT[style]?.test(prompt) ?? false
}

/** 该媒介的专业完成度句子，配图时强制追加 */
export function professionalQualityLock(style: VisualStyle): string {
  const locks: Record<VisualStyle, string> = {
    'ink-wash':
      'Use five ink tones, varied brush pressure and flying white, visible xuan-paper fibers and watermarks, and broad negative space. Exclude live-action photography, modern studios, smooth CG, and colored oil impasto.',
    watercolor:
      'Use transparent layers, natural grain and watermarks, and controlled edge bleeding. Avoid photo realism and heavy oil impasto.',
    'oil-painting':
      'Use visible impasto and canvas grain, with classical chiaroscuro. Avoid digital photographic sharpness.',
    'pixel-art':
      'Use a clear pixel grid, limited palette, and readable silhouettes. Avoid smooth high-definition photo texture.',
    '3d-render':
      'Use PBR materials, global illumination, and clean models. Avoid hand-painted smears.',
    anime:
      'Use clear line art, stepped cel shading, and distinct eye highlights. Avoid realistic skin pores.',
    photorealistic:
      'Use realistic materials, natural light, and photographic clarity. Avoid illustration brushwork.',
    cinematic:
      'Use film color grading, intentional lighting contrast, and layered depth of field. Avoid flat illustration.'
  }
  return locks[style]
}

/** 写进 LLM system/user 的完整风格说明块 */
export function buildStyleBriefForLLM(style: VisualStyle): string {
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  if (!g) {
    return `The user selected ${style}. State the medium and its techniques in each visualPrompt.`
  }
  return `Follow the user's selected visual style. Do not substitute another style:
- Enum: ${style}
- Display name: ${label}
- Medium: ${g.medium}
- Include in each visualPrompt: ${g.mustInclude}
- ${g.avoid}
- End each shot with an appropriate style lock, for example: ${g.sampleTail}
- Keep aesthetic, colorPalette, and lightingNote consistent with the selected style. Avoid generic cinematic wording unless the user selected cinematic. Write user-facing descriptions in Korean (한국어) and generation prompts in English.`
}

/** 配图 API 追加的短风格锁（中文，不用英文枚举） */
export function styleLockSuffix(style: VisualStyle): string {
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  if (!g) return `Use the ${style} style with high-definition detail.`
  return `Use ${g.medium}. ${g.sampleTail}`
}

/** 判断画面描述是否已体现该风格关键词（含口语别名，如「水墨风」） */
export function promptMentionsStyle(prompt: string, style: VisualStyle): boolean {
  const p = prompt.toLowerCase()
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  const keys = [
    style,
    label,
    g?.medium,
    ...(g?.medium.split(/[\/·]/) ?? []),
    ...STYLE_ALIASES[style]
  ]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase().trim())
  return keys.some((k) => k.length >= 2 && p.includes(k))
}
