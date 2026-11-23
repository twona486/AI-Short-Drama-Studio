---
name: shot-image
description: Generate storyboard keyframes after character and location references are ready. Use when the user asks for an image of a shot, keyframes, or shot images.
triggers: 配图,出图,关键帧,图片,画面,画这一镜,生成图片,四宫格,샷 이미지,이미지 생성,키프레임,화면,이 샷을 그려,4분할,shot image,keyframe,generate image,draw this shot
---

# Shot images and keyframes

A keyframe image for ordinary production is a single 2×2 grid, with exactly four populated panels.

## Before starting

- Create the storyboard first if it is missing.
- Provide the four-view character sheets and location anchor image needed by the shot.
- For ordinary production, call `generate_shot_image` directly. Use only the character design images and location image as references.
- For an AI short drama, call `generate_shot_board` only when this shot lacks a storyboard panel.
- Draw only the named shots. Use `generate_all_images` only when the user asks for all keyframes or shot images.

## Composition

- Use exactly two columns and two rows. Read from top left to bottom right: initial state, preparation, main event, and ending.
- Reject five, six, or eight panels and blank or flat-color filler panels.
- Use the character sheets and location anchor image. Match faces to the sheets and the location to its anchor.
- Do not invent a face or reproduce the character-sheet panel borders inside the shot.
- Use the grid only as an action timeline for video. The video must show one continuous image without grid panels.
- Write final generation instructions in English. Preserve any Korean (한국어) text explicitly requested on screen. Write user-facing notices in Korean (한국어).

Queue at most 12 actions per batch. If there are many shots, start with those missing images and resume in the next batch.
