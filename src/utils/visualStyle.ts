/**
 * 스토리보드, 이미지 생성, 캐릭터 설정에 공통으로 적용하는 화풍 지침이다.
 * 모델에 열거형 값과 함께 구체적인 매체와 기법을 전달한다.
 */

import type { VisualStyle } from '@/types'

export const VISUAL_STYLE_LABEL: Record<VisualStyle, string> = {
  cinematic: 'Cinematic',
  anime: 'Japanese animation',
  photorealistic: 'Photorealistic photography',
  '3d-render': '3D rendering',
  'oil-painting': 'Classical oil painting',
  watercolor: 'Watercolor',
  'pixel-art': 'Retro pixel art',
  'ink-wash': 'Chinese ink wash'
}

/** 파서 호환. 사용자 표현에서 가장 구체적인 화풍을 먼저 찾는다. */
export const STYLE_ALIASES: Record<VisualStyle, string[]> = {
  'ink-wash': [
    '中国水墨画',
    '中国水墨',
    '水墨写意',
    '水墨风格',
    '水墨风',
    '水墨画',
    '写意画',
    '수묵화',
    '수묵',
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
  '3d-render': ['3d动画', '3d 动画', '三维动画', '3d stylized animation', 'pixar', '皮克斯', '三维渲染', '3d渲染', '3d-render', 'blender', 'octane', 'c4d'],
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
  'ink-wash': /宣纸|墨色|墨分|焦浓|浓淡|留白|飞白|晕染|笔锋|화선지|먹의 농담|여백|ink tones|rice paper|negative space|dry brush/i,
  watercolor: /晕染|水渍|纸纹|渗化|透明叠色|물 번짐|종이 결|투명한 겹칠|transparent washes|paper grain|soft bleeding/i,
  'oil-painting': /厚涂|笔触|布面|伦勃朗|임파스토|붓 자국|캔버스 결|impasto|canvas texture|Rembrandt/i,
  'pixel-art': /像素格|色板|抖动|픽셀 격자|제한 팔레트|디더링|pixel grid|limited palette|dithering/i,
  '3d-render': /pbr|全局光|전역 조명|global illumination|octane|blender/i,
  anime: /赛璐璐|线稿|分阶|眼睛高光|셀 채색|선화|눈 하이라이트|cel shading|line art|eye highlights/i,
  photorealistic: /毛孔|浅景深|纪实|织物纹理|모공|얕은 심도|직물 결|pores|shallow depth of field|fabric texture/i,
  cinematic: /胶片|剧照|景深|焦段|光比|颗粒|필름|심도|초점 거리|조명 대비|film grain|depth of field|focal length|lighting ratio/i
}

/** visualPrompt에 포함할 화풍별 매체와 기법이다. */
export const VISUAL_STYLE_GUIDE: Record<
  VisualStyle,
  {
    medium: string
    mustInclude: string
    avoid: string
    sampleTail: string
  }
> = {
  cinematic: {
    medium: 'Cinematic still / film photography',
    mustInclude:
      'Cinematic grading, shallow or layered depth of field, dramatic lighting ratios, an identifiable focal-length feel (such as 35mm, 50mm, or 85mm), film grain or cinematic contrast, negative space, and leading lines.',
    avoid: 'Avoid flat illustration, exaggerated anime eyes, and cartoon outlines.',
    sampleTail:
      'Frame it like a theatrical film still, with teal-orange or warm-cool grading, soft film grain, restrained highlights, and detailed shadows.'
  },
  anime: {
    medium: 'Japanese cel animation / animated feature frame',
    mustInclude:
      'Clean line art or color blocks, cel shading, stepped light and shadow, hair and eye highlights, stylized proportions and expressions, and legible space even in simplified backgrounds.',
    avoid: 'Avoid photographic realism, visible skin pores, and oil paint brushwork.',
    sampleTail:
      'Use feature-animation styling with clean line art, cel shading, bright eye highlights, and atmospheric perspective.'
  },
  photorealistic: {
    medium: 'Commercial / documentary photography',
    mustInclude:
      'Realistic materials and microdetail such as pores and fabric texture, physically plausible light and reflections, optical depth of field, and optional mild lens distortion.',
    avoid: 'Avoid anime faces, visible brushstrokes, and cartoon outlines.',
    sampleTail:
      'Show photorealistic material details, natural light, shallow depth of field, and commercial photography clarity without painterly marks.'
  },
  '3d-render': {
    medium: '3D rendering / C4D, Blender, or Octane',
    mustInclude:
      'PBR materials, global illumination, soft area lights or HDRI, clean model edges, subsurface scattering for skin, and product-quality specular reflections.',
    avoid: 'Avoid hand-painted brush marks, pixel blocks, and ink bleeding.',
    sampleTail:
      'Render with clean geometry, PBR materials, global illumination, and soft reflections in the style of Octane or Blender.'
  },
  'oil-painting': {
    medium: 'Classical oil painting',
    mustInclude:
      'Visible brushwork and impasto, canvas texture, classical lighting such as Rembrandt lighting, layered pigments, blended color masses, and a gallery-quality composition.',
    avoid: 'Avoid digitally sharp photographic rendering, flat cel color, and pixel art.',
    sampleTail:
      'Show classical oil painting with impasto, canvas texture, dramatic light and shade, and a restrained museum-painting palette.'
  },
  watercolor: {
    medium: 'Watercolor painting',
    mustInclude:
      'Watercolor blooms, visible paper grain, transparent washes, controlled soft bleeding at the edges, and open negative space.',
    avoid: 'Avoid thick oil paint, hyperreal photography, and hard-edged vector art.',
    sampleTail:
      'Use transparent washes and natural watercolor blooms over subtle paper grain with soft edges.'
  },
  'pixel-art': {
    medium: 'Retro pixel art',
    mustInclude:
      'A distinct pixel grid, limited palette, crisp edges or controlled dithering, 16- or 32-bit game styling, and readable silhouettes.',
    avoid: 'Avoid high-resolution photography, smooth vector gradients, and realistic skin pores.',
    sampleTail:
      'Render a crisp pixel grid, limited palette, and light dithering like a classic console game.'
  },
  'ink-wash': {
    medium: 'Chinese ink wash / freehand ink on xuan paper',
    mustInclude:
      'Five tonal grades from scorched dark to clear pale ink, wet and dry brush techniques, broken strokes, variable brush pressure, generous negative space, visible xuan paper fibers and blooms, and freehand drapery or pale distant landscapes.',
    avoid:
      'Avoid photographic skin pores, gray studio turnarounds, glossy 3D, flat cel shading, Western oil impasto, and generic film grading.',
    sampleTail:
      'Paint freehand in ink on xuan paper. Use clearly separated tonal grades, dry brush and negative space, centered brushwork for drapery, and pale washes for the distance.'
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

/** 파서 호환. 중국어의 화풍 접미사와 모양이 같은 일반 단어를 제외한다. */
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
  /风格|画风|质感|电影感|动画|动漫|二次元|写实|摄影|渲染|油画|水彩|像素|水墨|赛博|蒸汽朋克|复古|胶片|手绘|插画|国风|赛璐璐|厚涂|扁平|3d|黏土|粘土|剪纸|皮影|浮世绘|波普|定格|卡通|q版|cel-shad|화풍|그림체|점토|종이 공예|스톱모션|일러스트|clay|papercut|stop.?motion|illustration/i

/** 셀 셰이딩이나 카툰 렌더링에는 별도 열거형이 없다. */
const CEL_SHADE_PHRASE =
  /卡通渲染(?:（Cel-shading）)?(?:\s*3D)?(?:\s*[+＋]\s*)?(?:Q\s*版(?:人物)?)?|cel[- ]shad(?:ing|ed)(?:\s*3D)?|Q\s*版人物|卡通\s*3D|3D\s*卡通|셀\s*셰이딩|카툰\s*렌더링/i

function extractCelShadePhrase(blob: string): string {
  const hit = blob.match(CEL_SHADE_PHRASE)
  if (!hit?.[0]) return ''
  return hit[0].replace(/\s+/g, ' ').trim()
}

/** 사용자가 표현한 화풍이나, 명시한 매체를 찾는다. */
export function extractUserMediumPhrase(...texts: Array<string | undefined>): string {
  const blob = joinedText(...texts)
  if (!blob.trim()) return ''

  const cel = extractCelShadePhrase(blob)
  const dimensional = blob.match(/(?:3\s*d|三维)\s*[-·]?\s*(?:半写实|写实|卡通|动画|渲染)(?:\s*(?:风格|画风))?/i)
  if (dimensional) return dimensional[0].trim()
  if (cel) return cel

  const open: string[] = []
  for (const m of blob.matchAll(/([\u4e00-\u9fffA-Za-z0-9]{1,12}(?:风格|画风)|[가-힣A-Za-z0-9][가-힣A-Za-z0-9 -]{0,18}\s(?:화풍|그림체|style))/gi)) {
    if (m[1]) open.push(m[1])
  }
  for (const m of blob.matchAll(/([\u4e00-\u9fffA-Za-z]{2,8}风)/g)) {
    const w = m[1]
    if (w && !MEDIUM_STOP.has(w) && !/的风$|起风$|吹风$|阵风$|冷风$|寒风$|晚风$|微风$|被.*风$/.test(w)) open.push(w)
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

/** 주제나 본문에서 화풍을 찾는다. 명시한 화풍이 없으면 null을 반환한다. */
export function inferVisualStyleFromText(...texts: Array<string | undefined>): VisualStyle | null {
  const blob = joinedText(...texts)
  if (!blob.trim()) return null
  // 카툰 렌더링은 픽셀 아트나 실사 3D로 분류하지 않는다.
  if (extractCelShadePhrase(blob)) return null
  if (/(?:3\s*d|三维)\s*[-·]?\s*(?:半写实|写实|动画|渲染)/i.test(blob)) return '3d-render'
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
  /** API용 열거형. 입력이 알려진 화풍과 일치할 때만 기본 선택을 바꾼다. */
  style: VisualStyle
  /** 사용자의 원문 표현 또는 선택한 화풍 이름. */
  medium: string
  /** 입력과 일치하는 화풍. 일치하지 않으면 null. */
  matched: VisualStyle | null
  /** 사용자가 화풍을 직접 언급했는지 나타낸다. */
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

/** 대사 속 표현을 피하기 위해 화풍을 명시한 줄만 추린다. */
export function styleLinesFromPlay(content?: string): string {
  return (content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /画风|视觉风格|画面风格|美术风格|绘制风格|风格要求|整体风格|画面质感|(?:3\s*d|三维)\s*(?:半写实|写实|动画|渲染)/i.test(line))
    .join('\n')
}

export function lookFromScript(
  script?: {
    style?: VisualStyle
    visualStyleOverride?: string
    topic?: string
    content?: string
    keywords?: string[]
    aesthetic?: string
    styleBrief?: string
  } | null,
  ...extra: Array<string | undefined>
): VisualLook {
  const fallback = script?.style ?? 'cinematic'
  if (script?.visualStyleOverride?.trim()) return lookFromTexts(fallback, script.visualStyleOverride)
  const scriptLook = lookFromTexts(fallback, styleLinesFromPlay(script?.content))
  if (scriptLook.userNamed) return scriptLook
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

/** 실사 매체인지 확인해 캐릭터 설정 이미지 방식을 결정한다. */
export function isPhotographicLook(look: VisualLook): boolean {
  if (/(?:3\s*d|三维)/i.test(look.medium)) return false
  if (look.matched) {
    return look.matched === 'cinematic' || look.matched === 'photorealistic'
  }
  if (look.userNamed) {
    return /电影|摄影|写实|实拍|纪实|胶片|剧照|真人|영화|실사|사진|cinematic|photograph|film still|live.action/i.test(look.medium)
  }
  return look.style === 'cinematic' || look.style === 'photorealistic'
}

/** 사용자 지정 화풍을 적용하고 알려진 화풍이면 매체별 기법을 추가한다. */
export function mediumLockText(look: VisualLook): string {
  if (look.userNamed && look.matched) {
    const userBit =
      look.medium !== styleLabel(look.matched)
        ? `Follow the user's visual style "${look.medium}". `
        : `Render in "${styleLabel(look.matched)}". `
    return `${userBit}${styleLockSuffix(look.matched)} ${professionalQualityLock(look.matched)}`
  }
  if (look.userNamed) {
    return `Render in the user's specified medium "${look.medium}". Use its materials, techniques, and textures at a professional finish. Preserve the requested style.`
  }
  return `${styleLockSuffix(look.style)} ${professionalQualityLock(look.style)}`
}

export function promptHasTechnique(prompt: string, style: VisualStyle): boolean {
  return TECHNIQUE_HINT[style]?.test(prompt) ?? false
}

/** 이미지 생성에 적용할 매체별 품질 기준이다. */
export function professionalQualityLock(style: VisualStyle): string {
  const locks: Record<VisualStyle, string> = {
    'ink-wash':
      'Professional finish: Use five ink tones, variable brush pressure, broken strokes, visible xuan paper fibers and blooms, and generous negative space. Avoid studio photography, glossy CGI, and oil impasto.',
    watercolor:
      'Professional finish: Use transparent washes, natural paper grain and water marks, and controlled edge bleeding. Avoid hyperreal photos and thick oil paint.',
    'oil-painting':
      'Professional finish: Show impasto, canvas grain, and classical chiaroscuro. Avoid digital photo sharpness.',
    'pixel-art':
      'Professional finish: Use a clear pixel grid, limited colors, and readable silhouettes. Avoid smooth high-resolution photographic rendering.',
    '3d-render':
      'Professional finish: Use PBR materials, global illumination, and clean modeling. Avoid painted smears.',
    anime:
      'Professional finish: Use clean lines, stepped cel shading, and distinct eye highlights. Avoid photographic skin pores.',
    photorealistic:
      'Professional finish: Use realistic material detail, natural light, and photographic clarity. Avoid illustrative brush marks.',
    cinematic:
      'Professional finish: Apply cinematic grading, strong lighting ratios, and layered depth of field. Avoid flat illustration.'
  }
  return locks[style]
}

/** LLM에 전달할 화풍 지침을 작성한다. */
export function buildStyleBriefForLLM(style: VisualStyle): string {
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  if (!g) {
    return `Selected visual style: ${style}. Name its medium and techniques in each visualPrompt.`
  }
  return `Use the selected visual style consistently throughout:
- Style ID: ${style}
- Style name: ${label}
- Medium: ${g.medium}
- Each visualPrompt must include: ${g.mustInclude}
- ${g.avoid}
- Close each visualPrompt with a style reminder like this: "${g.sampleTail}"
- Keep aesthetic, colorPalette, and lightingNote consistent with the selected style. Avoid generic cinematic phrasing unless cinematic is selected. Write user-facing descriptions in Korean and generation prompts in English.`
}

/** 이미지 생성 API에 전달할 짧은 화풍 지침이다. */
export function styleLockSuffix(style: VisualStyle): string {
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  if (!g) return `${label} style, high detail.`
  return `${label} style (${g.medium}). ${g.sampleTail}`
}

/** 구체적인 기법이나 별칭으로 프롬프트의 화풍을 확인한다. */
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
