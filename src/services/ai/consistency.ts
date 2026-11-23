/**
 * 캐릭터 설정 및 장면 기준 이미지 프롬프트
 *
 * 사용자가 요청한 매체와 화면 스타일의 재료를 사용한다.
 * 알려진 스타일은 해당 기법으로 보완하고 그 외에는 요청한 표현을 보존한다.
 */

import type { Scene, Shot, Subject, VisualStyle } from '@/types'
import {
  isPhotographicLook,
  lookFromTexts,
  mediumLockText,
  type VisualLook
} from '@/utils/visualStyle'

export function characterSheetPrompt(
  subject: Subject,
  style: VisualStyle,
  hasReferencePhotos: boolean,
  look?: VisualLook
): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const kindHint =
    subject.kind === 'animal'
      ? 'Use the same animal with identical species or breed, markings, fur or feathers.'
      : subject.kind === 'other'
        ? 'Use the same object or mascot with identical material, logo, color, and silhouette.'
        : 'Use the same person with identical face shape, age, hair, build, clothing, and accessories.'

  const refHint = hasReferencePhotos
    ? 'Match identity closely to the supplied reference images. Do not invent a different face or change wardrobe.'
    : ''

  const whiteBg =
    'Use one seamless pure white background (#FFFFFF) across all four panels. Exclude gray or beige studio backdrops, gradients, floor lines, cast-shadow backdrops, scenery, furnishings, and passersby.'

  const layout = isPhotographicLook(resolved)
    ? `[16:9] Four-view character sheet for ${subject.name}. Use the specified visual style: ${medium}.
${whiteBg}
Use exactly four panels from left to right:
1. Face close-up  2. Full-body front  3. Full-body side  4. Full-body back.`
    : `[16:9] Four-view character sheet for ${subject.name}. Render in ${medium}.
${whiteBg}
Use exactly four panels, left to right: face close-up, full-body front, full-body side, and full-body back. Preserve identity features.
Match materials, strokes, and texture to ${medium}. Do not substitute a live-action studio photo or another medium.`

  return `${layout}
${refHint}${subject.description}

${kindHint} Keep the same character, wardrobe, and colors across the four panels. Exclude unrelated people and exploded prop diagrams.
${whiteBg}
${mediumLockText(resolved)}`
}

const WHITE_BG_HINT = /纯白背景|#FFFFFF|无缝纯白/
const STUDIO_BG_HINT = /浅色棚拍|中性灰|影棚背景|干净浅色|浅色干净背景/

/** 캐릭터 설정 이미지 배경은 순백색으로 통일한다. */
export function ensureCharacterSheetWhiteBackground(prompt: string): string {
  const lock =
    'Use one seamless pure white background (#FFFFFF) across all four panels. Exclude gray or beige studio backdrops, gradients, floor lines, cast-shadow backdrops, scenery, furnishings, and passersby.'
  let next = prompt
    .replace(/干净浅色棚拍背景（无风景、无路人）/g, lock)
    .replace(/中性灰影棚背景/g, 'seamless pure white background (#FFFFFF)')
    .replace(/浅色棚拍背景/g, 'seamless pure white background (#FFFFFF)')
    .replace(/浅色干净背景/g, 'seamless pure white background (#FFFFFF)')
  if (!WHITE_BG_HINT.test(next) || STUDIO_BG_HINT.test(next)) {
    next = `${next.trim()}\n${lock}`
  }
  return next.trim()
}

/** 반복 등장하는 소품의 앞면, 옆면, 뒷면과 상세를 순백색 배경에서 보여 준다. */
export function propTurnaroundPrompt(prop: { name: string; description?: string }, look?: VisualLook): string {
  const medium = look?.medium || 'the visual style of the film'
  const whiteBg =
    'Use one seamless pure white background (#FFFFFF) across all four panels. Exclude gray or beige studio backdrops, gradients, floor lines, cast-shadow backdrops, scenery, furnishings, hands, and any setting.'
  return `[16:9] Multi-view design sheet for ${prop.name}. Use ${medium}.
${whiteBg}
Show one object with consistent shape, material, colors, wear, and logos. Four panels from left to right: front, side, back, and detail. Exclude people, settings, and other objects.
Appearance reference: ${prop.description || prop.name}`
}

/** 가방, 신분증, 태블릿, 신발, 장신구처럼 캐릭터가 사용하는 물건을 별도 이미지로 만든다. */
export function characterPropSheetPrompt(
  subject: Subject,
  style: VisualStyle,
  look?: VisualLook
): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const inventory =
    subject.props?.trim() ||
    'Extract clothing and personal items from the character description: bags, identification, tablet, shoes, hats, accessories, and objects often held. If none stands out, show clothing details such as buttons, collars, shoes, and pockets.'

  return `[16:9] Character asset sheet and personal items for ${subject.name}. Use ${medium}.
Use a clean light background. Lay each personal item out separately with visible shape, material, color, and logo.
Inventory: ${inventory}
Character description for style matching only. Do not draw the whole person: ${subject.description}

Show the objects alone. Draw each one separately and completely for later storyboard reference.
${mediumLockText(resolved)}`
}

/** 장면에서 꼭 유지할 주요 소품만 추출하고 일반 비품은 제외한다. */
export function scenePropSheetPrompt(
  scene: Scene,
  style: VisualStyle,
  look?: VisualLook
): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const inventory = scene.props?.trim() || 'no specified key props'

  return `[16:9] Key prop sheet for ${scene.name}. Render in ${medium}.
Show at most four props that are prominently visible, handled or used by characters, or important to the story: ${inventory}
Scene context: ${scene.description}

Make a production-design prop sheet. Present each object separately and completely, making its shape, scale, material, color, and wear clear. Use a plain neutral backdrop, without people, a complete location, or unlisted cups, furniture, decorations, clothing, and clutter. If there is one object on the list, show only that object.
${mediumLockText(resolved)}`
}

/** 한 샷의 동작을 흑백 스케치 여섯 칸으로 나눈다. */
export function shotBoardPrompt(
  shot: Pick<
    Shot,
    | 'title'
    | 'duration'
    | 'cameraMovement'
    | 'shotSize'
    | 'blocking'
    | 'continuity'
    | 'visualPrompt'
    | 'videoPrompt'
    | 'boardPrompt'
    | 'propFocus'
    | 'voiceover'
    | 'audioMode'
  >,
  _style: VisualStyle,
  _look?: VisualLook,
  options?: { filmChapter?: boolean; aspectRatio?: string }
): string {
  const ar = options?.aspectRatio || '16:9'
  const frame = ar === '9:16' ? 'vertical 9:16' : ar === '1:1' ? 'square 1:1' : `landscape ${ar}`
  const body = (shot.boardPrompt || shot.visualPrompt || shot.title).trim()
  const size = shot.shotSize ? `Shot size: ${shot.shotSize}.` : ''
  const blocking = shot.blocking ? `Blocking: ${shot.blocking}.` : ''
  const prop = shot.propFocus && shot.propFocus !== '无' ? `Key prop: ${shot.propFocus}.` : ''
  const continuity = shot.continuity ? `Continuity: ${shot.continuity}.` : ''
  const performance = shot.videoPrompt?.trim()
    ? `Action and performance: ${shot.videoPrompt.trim()}.`
    : ''
  const voiceMode = shot.audioMode ?? 'h3-dialogue'
  const dialogue = shot.voiceover?.trim()
    ? voiceMode === 'h3-voiceover' || voiceMode === 'tts' || voiceMode === 'none'
      ? `This is an off-screen narration shot. Every visible person keeps their lips closed across the six panels. A person who hears their name can listen, stop, turn, or search without speaking. Use the narration only as emotional context. Exclude captions, numbering, and speech bubbles: ${shot.voiceover.trim()}。`
      : (() => {
          const speaker = shot.voiceover.trim().match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
          return `Dialogue shot for ${speaker || 'the current speaker'}. Frame that person before speaking as the one visual focus, with face and lips clearly visible. Others may remain in frame with closed mouths, reacting through gaze and expression. Place dialogue in the middle or reaction beat: ${shot.voiceover.trim()}. Do not draw the dialogue or speech bubbles.`
        })()
    : ''
  const camera =
    shot.cameraMovement === 'push'
      ? 'Let people and key objects grow gradually over six cells as the camera pushes in once.'
      : shot.cameraMovement === 'pull'
        ? 'Widen the view gradually over six cells as the camera pulls back once.'
        : shot.cameraMovement === 'pan'
          ? 'Preserve character scale and move the background framing horizontally over six cells as one pan.'
          : shot.cameraMovement === 'tilt'
            ? 'Preserve character scale and move the framing vertically over six cells as one tilt.'
            : shot.cameraMovement === 'orbit'
              ? 'Vary viewing angle slightly across six cells while keeping cast and spatial relationships consistent.'
              : 'Keep camera position and shot size fixed for six cells. Change only actions, expressions, and props continuously.'

  if (options?.filmChapter) {
    const longAction =
      shot.duration >= 9 || /蒙太奇|快速切|连续数|反复|多次|逐渐/.test(`${body}${performance}`)
    const count = longAction ? 8 : 4
    const layout = longAction ? '4 columns × 2 rows' : '2 columns × 2 rows'
    const beats = longAction
      ? 'Eight cells: establish the space, set initial character state, show hesitation or preparation, start the action, show the core action, show bodily or environmental reaction, resolve the action, and show a clear final pose.'
      : 'Four cells: establish and set the initial state, show hesitation or preparation, show the core action, and show reaction with the final pose.'
    const filmCamera =
      shot.cameraMovement === 'static'
        ? `Lock position, focal length, and framing across ${count} cells. Let movement, expressions, rain, steam, and other environmental details develop continuously.`
        : `Use ${count} sequential samples of the same ${shot.cameraMovement} camera move. Keep the motion restrained. Do not jump the axis or change positions suddenly.`

    return `[${ar} ${frame} color film storyboard panel] ${shot.title}, ${shot.duration} seconds total.
Generate one color film storyboard panel in a ${layout} layout with exactly ${count} cells, read from top left to bottom right. Use aspect ratio ${ar} throughout. Keep all cells in the same continuous shot or montage rather than unrelated scenes.

Use a normally colored, realistic film look with natural light and believable people. Match clothing, architecture, and objects to the script's period and region. Make a previsualization suitable for the director and cinematographer. Avoid monochrome line art, comics, and poster layouts.
Use equal cells divided by fine black lines. Do not add titles, numbers, timestamps, captions, speech bubbles, notes, logos, or watermarks. Keep explicitly requested Korean on-screen text verbatim.

${beats}
${filmCamera}

Keep place, time, cast, faces, ages, hair, costumes, and props consistent. Carry weather, ground wetness, stains, injuries, hunger, damp clothes, light direction, screen direction, blocking, and the main scene anchor from one cell to the next. Do not add characters, change clothes or sides, or alter the building structure.
${size}${blocking}${prop}${continuity}${performance}${dialogue}
${body}

Use reference sheets for faces, ages, builds, and clothes, and scene anchors for buildings, ground, weather, materials, and light. Do not invent people or locations. Output just this ${count}-cell color film storyboard panel.`
  }

  return `[${ar} ${frame} action panel for one shot] ${shot.title}, ${shot.duration} seconds total.
Generate one director's sketch in a 3×2 grid of exactly six cells, read top left to bottom right. The full image must be ${ar}. The six cells sample six moments in one continuous shot, in the same location.

Use black or light gray pencil on white. Keep lines simple, add sparse gray values to explain space, and use clear silhouettes to show movement. Avoid detailed coloring, poster layouts, and realistic rendering.
Use equal cells separated by fine lines. Exclude titles, numbers, timecodes, subtitles, speech bubbles, explanatory text, and watermarks. Preserve only explicitly requested Korean on-screen text.

Action progression across six cells:
1. Set the opening composition and character positions at zero seconds. 2. Show preparation. 3. Begin the action. 4. Complete the core action. 5. Show dialogue or reaction and prop changes. 6. Lock the ending state for the next shot or last frame.
${camera}

Keep place, time, cast, faces, hair, clothes, and props consistent. Do not introduce or remove people, change clothes, or swap sides. Prop changes must follow time order. Preserve screen direction, blocking, light direction, and the main scene anchor.
${size}${blocking}${prop}${continuity}${performance}${dialogue}
${body}

Use character design images for silhouettes, faces, and clothing, and the scene image for location, lighting, and ground. Do not invent people or places. Output this one black-and-white six-cell storyboard panel.`
}

/** 일반 키프레임은 2×2 배열의 네 칸으로 만든다. */
export function shotKeyframePrompt(
  shot: Pick<
    Shot,
    | 'title'
    | 'duration'
    | 'cameraMovement'
    | 'shotSize'
    | 'blocking'
    | 'continuity'
    | 'visualPrompt'
    | 'videoPrompt'
    | 'imagePrompt'
    | 'propFocus'
    | 'voiceover'
    | 'audioMode'
  >,
  look?: VisualLook,
  options?: { aspectRatio?: string }
): string {
  const ar = options?.aspectRatio || '16:9'
  const frame = ar === '9:16' ? 'vertical 9:16' : ar === '1:1' ? 'square 1:1' : `landscape ${ar}`
  const body = (shot.visualPrompt || shot.title).trim()
  const size = shot.shotSize ? `Shot size: ${shot.shotSize}.` : ''
  const blocking = shot.blocking ? `Blocking: ${shot.blocking}.` : ''
  const prop = shot.propFocus && shot.propFocus !== '无' ? `Key prop: ${shot.propFocus}.` : ''
  const continuity = shot.continuity ? `Continuity: ${shot.continuity}.` : ''
  const performance = shot.videoPrompt?.trim() ? `Action and performance: ${shot.videoPrompt.trim()}.` : ''
  const voiceMode = shot.audioMode ?? 'h3-dialogue'
  const dialogue = shot.voiceover?.trim()
    ? voiceMode === 'h3-voiceover' || voiceMode === 'tts' || voiceMode === 'none'
      ? `This shot uses off-screen narration. Keep every visible mouth closed in all four cells. Use narration for emotion only, without subtitles or speech bubbles: ${shot.voiceover.trim()}。`
      : (() => {
          const speaker = shot.voiceover.trim().match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
          return `Dialogue shot for ${speaker || 'the current speaker'}. Frame the speaker before they talk. Place dialogue in the middle of the action. Do not draw the spoken words or speech bubbles: ${shot.voiceover.trim()}。`
        })()
    : ''
  const camera =
    shot.cameraMovement === 'static'
      ? 'Keep camera position, focal length, and composition fixed across four panels. Show only continuous changes in action, expressions, and environmental details.'
      : `Use four sequential samples of the same ${shot.cameraMovement} camera move. Keep the move restrained and maintain the camera axis.`
  const medium = look ? mediumLockText(look) : ''

  return `[${ar} ${frame} four-panel keyframe] ${shot.title}, ${shot.duration} seconds total.
Generate a color keyframe in a 2×2 grid with exactly four filled panels: top left, top right, bottom left, bottom right. The whole image must have aspect ratio ${ar}.

All four panels show sequential moments from one continuous shot. Do not use unrelated images or empty panels.
Show in order: 1. Establishing view and initial character state; 2. Hesitation or preparation; 3. The core event; 4. Reaction and final pose.
${camera}

Use equal panels with thin lines. Exclude titles, numbering, timecodes, subtitles, speech bubbles, captions, logos, and watermarks, unless the user explicitly supplied Korean on-screen text for the scene. No blank, solid-color, or unfinished panels.

Preserve location, time, cast, faces, clothing, and props across panels. Do not invent people, change wardrobe, or change the setting.
${size}${blocking}${prop}${continuity}${performance}${dialogue}
${body}

Use the supplied references: faces, builds, and clothing from the character sheets; location, ground, and lighting from the scene image. Output this one four-panel color keyframe only.
${medium}`.trim()
}

export function scenePlatePrompt(scene: Scene, style: VisualStyle, look?: VisualLook): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const lighting = scene.lighting?.trim() || 'the primary light source appropriate to the script'
  const main = scene.mainAnchor?.trim() || 'the most recognizable physical anchor'
  const extra = scene.anchors?.trim()
  const grid = extra
    ? `Use this list for the four panels: ${extra}. Fill missing entries with the wide view, main anchor (${main}), ground and blocking area, and light source (${lighting}).`
    : `Exactly four panels, left to right and top to bottom:
1. Wide unoccupied view that identifies ${scene.name}
2. Close-up of the primary anchor (${main})
3. Ground and the area where people will stand
4. Light source or secondary anchor (${lighting})`

  const photo = isPhotographicLook(resolved)
  const lead = photo
    ? `[16:9] Four-panel anchor image for ${scene.name}. Use ${medium}. Make a clean location design sheet.`
    : `[16:9] Four-panel anchor image for ${scene.name}. Render in ${medium}, matching its materials and texture. Do not substitute a photograph or another style.`

  return `${lead}
${scene.description}
${grid}

This is a location reference. Keep the same place, time of day, and materials in all four panels.
Exclude people, faces, limbs, silhouettes, models, mannequins, passersby, crowds, human reflections in glass or mirrors, and human-shaped statues.
Show only buildings, furnishings, ground, doors, windows, the main anchor, and light. Include no living subjects.
Keep the four-panel layout. Do not combine panels into a single wide landscape.
${mediumLockText(resolved)}`
}
