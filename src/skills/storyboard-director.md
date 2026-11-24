---
name: storyboard-director
description: Develop a full script, then extract character, location, and storyboard nodes. Use for writing, revising, or breaking down scripts and extracting nodes.
triggers: 分镜,拆镜,编剧,故事板,文案,脚本,口播,重写,剧本,镜头,提炼,续写,接着写,스토리보드,샷 나누기,시나리오,스토리보드 이미지,원고,스크립트,내레이션,다시 쓰기,대본,샷,추출,이어 쓰기,계속 써,storyboard,shot breakdown,script,extract nodes
---

# Script and storyboard production

**Step 1 creates the complete script only. Do not create character, location, or storyboard nodes.**
**Step 2 extracts subjects / scenes / shots from the script.**

## Step 1: Complete script

Turn the user's premise or draft into editable, readable, filmable Markdown. Write the title, headings, body, character descriptions, and dialogue in Korean (한국어).

Never use a four-cell table of narration, picture, sound, and duration. Include background, characters, and environments so the subsequent storyboard is grounded.

Use this order:

1. **Title, genre, time, location, and suggested duration**
2. **Story background (`## 이야기 배경`)**: one-sentence premise, opposition and escalation, and a complete synopsis through the ending. Do not reduce a complete story to the climax unless the user requests that excerpt.
3. **Characters (`## 캐릭터`)**: record everyone who drives the story, including protagonist, opponent, parents, and mentors. Include deceased characters and use appearance, keepsakes, or other visible anchors. Each profile needs identity, appearance, personality and voice, desire, fear, relationships, arc, visual anchors, and cross-scene state. Include more than the people standing at the center of the shot.
4. **Environment and locations (`## 환경과 장면`)**: for each location describe the empty space, ground, weather, light, and period or city texture.
5. **Filming principles (`## 촬영 원칙`)**: identify exclusions and how acts of kindness are shown.
6. **Scenes**: use `## 장면 N｜제목`. Name the present characters and give each scene an objective, obstacle, and outcome. Write visible action in the present tense, optionally prefixed by ■. Write speakable dialogue as `**캐릭터 이름：**` followed by 「대사 원문」. Make every montage beat observable.
7. **Chapter emotional arc** and **visual and sound tone**.

For sales and presenter-led narration, include the host and product in characters and the setting in environments. Put the exact spoken narration in dialogue. Show where the person is, where they look, and what they hold.

- Write lines people can speak naturally. Avoid brochure copy and silent-film captions.
- Keep 2–4 consecutive short lines with the same speaker and intent together. Interactions need spoken exchanges; do not force one line per scene.
- Restraint means avoiding slogans and maxims. Include visible exchanges for recognition, calling someone's name, confrontation, persuasion, questions, and farewells. Do not recap the backstory through narration by an older version of a character.
- Choose framing from action, spatial relationships, and emotion rather than making every speaker a close-up.
- Avoid vague promotional expressions such as empowering, immersive, premium-looking, cinematic, and aesthetic.
- Write people as recognizable individuals and locations as concrete places at definite times, including physical obstacles.
- Cover the number of scenes the story needs. Compress a short film without losing the opponent, key family, and central conflict. Do not reduce a folk tale or adaptation to a 3–5-scene climax. Use all the scenes and montage beats needed for a film chapter.
- Pin down the requested boundaries: full story, first episode, excerpt, trailer, or suspense point. A complete short film or adaptation must retain its core characters and conflicts. Only excerpt when asked. Do not add a later episode or reveal an outcome where the user requested a suspenseful stop.
- Do not skip from before to after a central event. For major changes in place, era, identity, relationships, or physical state, show the trigger, process, impact, and reaction necessary within the requested boundary. You may stop at a suspense point but must bridge two shown beats causally.
- Give central time travel, accidents, transformations, discoveries, reunions, betrayals, or battle outbreaks enough screen time. Treat them only as background or omit them when expressly requested.
- Give explanatory lines a local story trigger. If the user asks to begin with explanation, recap, or an established relationship, do not add prior events. Check each prior ending against the next opening.

Use `generate_play`, stop after writing, and ask whether to extract nodes. For continuation, use `continue_play` and append without rewriting existing scenes. If the user begins an unrelated story, seed it with `seed_script` using the original recent text, then use `generate_play`. Do not reuse the old script as a draft.

## Continuation

Continue only after a complete script exists.

- Preserve existing background, characters, environments, and scene text verbatim.
- Append after the last scene with `## 장면 N｜제목`.
- Add new characters and places to their sections.
- Default to 2–3 additional scenes unless the user provides direction.
- If nodes already exist, tell the user to re-extract them from the storyboard keyframe group.

## Step 2: Extract nodes

When a script exists on the left and the user asks to continue or extract, use `extract_cast`. It saves one stage at a time: characters first, locations second, storyboard third. Stop after each stage. Do not parallelize or bundle the three stages.

- Follow the script's characters, locations, and scenes. Create a record for every ### under characters, including deceased parents and absent opponents. Use a keepsake, portrait, or flashback for the deceased and a confrontation or visible pressure for a living opponent. Do not add passersby or invent appearances or environments.
- Preserve original spoken lines in each matching shot's voiceover. Do not replace them with older-character narration or empty them in favor of action. Write the still-frame visualPrompt in English for the image model.
- Write videoPrompt as English generation direction covering zero through the end in 2–5 real story beats. In each range describe the initial state, what is seen and done, who speaks, how others are placed and react, emotional changes, and camera motion and endpoint. Keep Korean dialogue or explicitly requested Korean on-screen text verbatim. Give actors in-scene eyelines and describe montage as visible action. Do not copy visualPrompt, divide time equally, insert neighboring action, or ignore the script's exclusions. Older-character narration is off screen.

## Shot fields

- **title**: distinct 3–8-character Korean (한국어) title suitable for a slate.
- **purpose**: write a short dramatic function in Korean, such as `도입 / 설명 / 반응 / 공개 / 마무리`.
- **shotSize**: state framing and its reason.
- **blocking / eyeline**: locate every person and give body direction and eyeline. A speaker can be behind others; foreground characters can look back or sideways.
- **voiceover**: use "Character name: line". Keep 2–4 consecutive short phrases with the same intent together. H3 strips the speaker prefix. Leave empty if there is no dialogue.
- **audioDescription**: audible sounds in the scene.
- **duration**: integer seconds from 5 to 10; vary across the film.
- **cameraMovement**: one of push / pull / pan / tilt / static / orbit per shot.
- **visualPrompt**: English still-frame prompt with near, underfoot, surrounding, and far details, visible action, and light.
- **videoPrompt**: 2–5 beat-based ranges with action, expression, original lines, other people's blocking and reaction, one motivated camera move, and its endpoint. Avoid posing at the lens, ending with a generic eyeline instruction, or dividing equally.
- **Dialogue framing**: a close-up is optional. The speaker need not face the camera or occupy the center. Establish who speaks, turns sideways, or looks back.
- **Speaker clarity**: the speaker's mouth is visible from front, side, or background. Foreground listeners keep their mouths closed and look at the speaker or the indicated object.
- **Exchanges**: dialogue in one space can stay in one shot. For H3 use internal `[Shot 1]/[Shot 2]/[Shot 3]` beats, one `<d>` tag per line. Consecutive short lines from one speaker may stay in one shot.
- **Continuity**: previous shot's concrete ending → current visible change → concrete state for the next shot. Match positions, poses, orientation, props, injuries, emotion, and what people know.

## Visual style

Follow the user's description of the desired look. Express it in visible bridges, water, and clothes instead of a separate block of technique jargon.
