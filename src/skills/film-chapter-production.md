---
name: film-chapter-production
description: Produce character design references, location anchors, color storyboard panels, MiniMax H3 prompts, and video for an original film chapter. Use only for workflowMode=film-chapter outside video remake.
triggers: 原创电影,电影章节,亲身经历,章节剧本,彩色故事板,四宫格,八宫格,现实主义,오리지널 영화,영화 챕터,실화,챕터 대본,컬러 스토리 개요판,4분할,8분할,사실주의,original film,film chapter,color storyboard,realist film
---

# Original film chapter production

Use only when `script.workflowMode === film-chapter` and `pipelineMode !== remake`. Video remake uses a separate workflow. Do not call or rewrite its analysis, product replacement, frame imitation, or prompts.

## Principles

- The imported Markdown script defines the facts and story boundary. Resolve conflicts with earlier drafts before breaking down shots. Do not continue into the next chapter on your own.
- Make people believable. Match clothing, architecture, vehicles, signs, furnishings, and crowds to the script's period and region.
- Lock characters and locations first, then panels, then H3 prompts and videos. Do not send failed assets downstream in bulk.
- Save each version separately. Preserve user-approved character images, location references, panels, and videos.

## Before production

1. Extract chapter boundaries, year, region, season, weather, time of day, physical states, relationships, and key props.
2. Build a continuity checklist: previous ending → current change → next opening. Check wet or dry clothing, stains, injury, hunger, hair, objects in hand, orientation, and the ground.
3. If later user edits conflict with the import, update the canonical script and stop for user confirmation.
4. Batch only on an explicit full-workflow request. Otherwise stop after characters, locations, and the first batch of shots.

## Character design

- Create individual designs for people with dialogue, recurring appearances, or key actions. Use period crowd references for passersby.
- Use a 16:9 four-column realistic sheet: the left 40% is a large frontal head-and-shoulders close-up. On the right, show full-body front, strict side, and full-body back, separated by fine vertical lines.
- Use seamless white (#FFFFFF), even light, and uncropped feet. Exclude gray studio backgrounds, gradients, and settings. Keep face, age, height, build, hair, wardrobe, and wear consistent.
- Identity references take precedence. Clothing references may change clothing only, without modifying face, age, or ethnicity.
- Convey age through head-to-body proportions, jaw, shoulders, hands, feet, and stance. Do not make youth look like children or adults.

## Location anchors

- Keep people out of the location image. Lock the structure, entrances, exits, ground, main anchor, light, weather, period objects, and blocking space.
- Keep continuous weather across scenes. Carry wet ground, puddles, reflections, damp clothing, and shelter after rain.
- For crowds, decide who is seated, in line, or moving. In distant views with unstable figures, reduce movement and use seated people with small gestures.

## Storyboard panels

- Use color film panels by default rather than a generic black-and-white six-panel sheet.
- Use 2×2 for a single clear action and 4×2 for a 9–10-second shot, montage, or multi-stage action.
- Read the same continuous shot or sequence from top left to bottom right: establish → hesitation or preparation → main action → reaction and ending.
- Use character sheets and scene anchors. Preserve faces, costumes, weather, ground, light, screen direction, and prop state.
- Use natural color and a realistic film look. Exclude numbers, subtitles, speech bubbles, captions, and watermarks.
- Use panels for motion and composition only. Do not reproduce their borders, grids, or collage in video.

## Shots and performance

- Use 5–10 seconds per shot. Dialogue exchanges can stay in a canvas shot. For H3 use internal `[Shot 1]/[Shot 2]/[Shot 3]` as needed and one d tag per line. Use `h3-voiceover` for off-screen narration with closed on-screen mouths.
- Split by dramatic beats, without flattening a chapter into a list of short narration fragments. Keep one montage intention in an 8–10-second shot and describe visible action, not a generic passage of time.
- Write `videoPrompt` as English actor direction. Cover the full shot in 2–5 real beats and specify current actor, actions and expressions, speaker and original lines, others' blocking, eyelines and reactions, camera motion and endpoint. A speaker can be in the back. Avoid posing toward the camera, equal divisions, and generic notes about blank expressions.
- Carry adaptation limits into each shot: avoid wound close-ups, religious icons and rituals, and framing a homeless person as monstrous or ridiculous. Show kindness through ordinary gestures such as bringing warm water or sharing a game token.
- Choose motion for emotion and model stability. Prefer static wide shots for complex buildings or crowds, and push, pull, pan, or track only when justified.
- For H3 follow `h3-prompt-writing` and use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music`. Character and location references and panels are not I2VA first frames.
- Leave `[Shot 1]` untimed. Use `[Shot 2] At 00:03.000, ...` for later internal cuts, without `From 0.00s to 1.50s`. One canvas shot produces one clip, which can contain internal cuts. Write camera movements in the action, such as `The camera pushes in with small amplitude at slow speed`.
- Introduce style, framing, appearance, and voice at the start of `[Shot 1]`. Use English descriptions and speaker IDs such as `the man (S1)`.
- Place dialogue only inside tags in the original language. Use `<d>[Korean] 대사 원문</d>` for Korean or `<d>[Chinese] 原词</d>` for Chinese. Use `says in an off-screen voiceover` and specify closed lips for off-screen narration. Without dialogue, write `No dialogue. No lips moving.`
- Use `N/A` for `non_diegetic_music`.
- In a distant crowd shot, say who can move, who stays seated, and who can cross the frame. Avoid irrelevant serving, walking, or attention-grabbing actions.
- Write exclusions for this shot's real risks. A static shot explicitly rules out pan, tilt, zoom, and push-in.
- Write final model prompts in English and preserve requested Korean (한국어) dialogue, narration, and visible text. Write user-facing descriptions and review notes in Korean (한국어).

## Quality checks

For each shot verify the following:

- Recurring people still have the same faces and correct ages.
- Wardrobe, hair, dirt, wetness, injuries, and energy follow the prior shot.
- The location structure, weather, ground, and light stay continuous.
- Background people, hands, utensils, bikes, and other props do not deform or appear suddenly.
- Action and dialogue finish within the duration and non-speakers keep their mouths closed.
- Modern phones, luxury cars, clothes, signage, or an implausibly pristine location do not break the period.

Fix one main problem per retry and try no more than twice. If both fail, pause that shot, keep successful outputs, and report the reason.

## Batch order

1. Lock the canonical script.
2. Extract characters, locations, shots, and continuity.
3. Generate and review character design sheets.
4. Generate and review empty location anchors.
5. Generate color panels and H3 video for 3–5 representative shots.
6. After approval, batch remaining panels and videos by location.
7. Check quality, repair targeted issues, and write to the timeline.

Never route video remake through this workflow.
