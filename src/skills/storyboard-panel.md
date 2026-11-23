---
name: storyboard-panel
description: Draw a storyboard panel as line art to lock the composition before generating the final shot image.
triggers: 故事看板,看板图,线稿,分镜图,构图,스토리 개요판,개요판 이미지,선화,스토리보드 이미지,구도,storyboard panel,line art,composition
---

# Storyboard panel image

Before generating the shot image, use one six-panel black-and-white storyboard to establish the starting state, movement, reaction, and ending within the same shot. It is an intermediate reference for composition and video action.

## Order

1. Gather the four-view character sheets and location anchor image.
2. Use `generate_shot_board` or `generate_all_boards` for missing panels.
3. Use `generate_shot_image`. Match its camera position and composition to the panel.

## Panel composition

- Use fixed 3×2 line art. Do not add colors, subtitles, numbers, speech bubbles, or captions.
- Sample six points in one continuous shot: establish, prepare, begin, main action, reaction, and end.
- Make blocking, eyelines, objects in hand, prop changes, and the main location anchor legible.
- Preserve faces, clothes, props, light source, screen direction, and spatial relations across panels.
- Use the character sheets for people and the anchor image for location. Write the generation prompt in English.

## Use in later generation

Use character and location images to draw the panel. Include the current panel alongside the character and location references when generating video, with at most nine reference images. In off-screen narration shots, all visible mouths stay closed across the six panels. A person who is called only listens and reacts. Color the final image and match the character sheet faces. Video follows only the action sequence and must omit grids, line art, and collage. Write notes to the user in Korean (한국어).
