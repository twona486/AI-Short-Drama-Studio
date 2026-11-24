---
name: character-consistency
description: Lock characters and locations with four-view sheets and scene anchor images before making shot images.
triggers: 人设,角色,主体,四视图,三视图,设定图,一致性,换脸,场景,底板,空镜,锚点图,캐릭터 설정,캐릭터,피사체,4면 설정 이미지,3면 설정 이미지,설정 이미지,일관성,얼굴 변경,장면,빈 장면,기준 이미지,character sheet,location anchor,character design
---

# Character and location consistency

Before drawing shots, lock identities so people remain recognizable throughout the short film.

## Order

1. Use the existing subjects and scenes from the storyboard.
2. Use `generate_sheet` for missing character sheets and `generate_scene` for missing location anchors.
3. If many are missing, use `generate_all_sheets` and `generate_all_scenes`.
4. Complete character and location references before generating storyboard panels or calling `generate_shot_image`.

## Character sheets

Make one image with four panels: face close-up, full-body front, full-body side, and full-body back. Preserve the same face and clothing.

- Use the user's specified rendering medium. For hand-drawn or material-specific styles, use that medium; do not generate live-action studio photography instead.
- Use a seamless pure-white background (#FFFFFF) for any medium. Exclude gray studio backgrounds, gradients, ground, and scenery.
- If the user supplied an image, match the reference face and clothes. Do not optimize the facial features.

Describe age range, hairline, colors and styles of clothing, shoes, and accessories. Avoid vague compliments.

## Location anchors

Use a four-panel image with these views:
1. Wide, unoccupied view
2. Close-up of the main anchor, such as a door, worktop, pan, or elevator
3. Ground and blocking area
4. Light source or secondary anchor

Keep the location and time consistent. Exclude faces, people, silhouettes, animals, and subtitles. Later shots use these physical anchors without reproducing the grid. For video, send character design images, the location image, and the storyboard panel. Do not send a composited character-and-location still. Later shots stay on the same ground and retain the same time of day.

Write final generation prompts in English and preserve explicitly requested Korean on-screen text. Write user-facing descriptions in Korean (한국어).
