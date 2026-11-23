---
name: ai-short-film-screenwriter
description: Write, adapt, continue, or diagnose scripts for AI short dramas, short films, and series. Produce synopses, character profiles, location asset lists, episode outlines, and filmable scenes.
triggers: AI短剧,AI电影,竖屏剧,微短剧,写剧本,改编,续写,分集,逐场,优化剧本,编剧,故事改编,短电影,AI 숏드라마,AI 영화,세로형 드라마,초단편 드라마,대본 작성,각색,이어 쓰기,회차 구성,장면별 대본,대본 개선,시나리오,단편 영화,screenplay,adaptation,short film
---

# Screenwriting for AI short dramas and films

Make the story visual, filmable, and suitable for AI shot breakdown. Write all user-facing script text, headings, narration, dialogue, character profiles, and explanations in Korean (한국어). Preserve existing or quoted dialogue verbatim where the user requires it. Respect requested genre, duration, episode count, aspect ratio, audience, platform, and ending. Make reasonable assumptions for unspecified items and state them briefly before the draft.

## Identify the task

1. Determine whether the user requests new work, adaptation of intellectual property or folklore, continuation, expansion, or diagnosis and revision.
2. Extract required total duration, episode count, per-episode duration, aspect, genre, audience, required plot, exclusions, and production resources.
3. Ask only if missing information would change the basic structure. Otherwise deliver a complete usable draft.
4. Distinguish common motifs from the original expression of a specific modern adaptation. Do not copy protected scenes or dialogue that the user has not supplied.

## Adaptation rules

Reduce incidental passersby and merge reusable extras. Keep opponents and key family members.

- Give every character driving the story a profile: protagonist, opponent or personified representative, parents, mentors, and law enforcement. Keep people explicitly named in the premise.
- Profile deceased and late-arriving characters. Describe their earlier appearance or how a keepsake, portrait, or account continues to exert pressure.
- A living opponent must appear or exert visible pressure through confrontation, obstruction, a messenger, or a visible rule. Do not erase the opponent in backstory and leave only a two-person climax.
- Cover goal, opponent's values, increasing obstacles, climactic choice, and ending in the synopsis. Start at the climax only if the user specifically requests that excerpt.
- A shorter runtime can reduce scenes but must retain the conflict. In the story of Chenxiang saving his mother, Liu Yanchang (the father, even if deceased), Erlang Shen (the opponent), Sanshengmu, and Chenxiang all matter. Do not keep only the mother and son's reunion and departure.

## Story engine

Establish the following before scenes:

- A one-sentence premise: to reach an external goal, the protagonist must take a difficult action or pay the cost of failure, ultimately discovering the inner theme.
- Protagonist: desire, lack or false belief, strength, weakness, and cost of inaction.
- Opposition: a rationale the opponent believes and the ability to raise the stakes over time.
- Emotion: one specific central relationship that large scenes serve.
- Visual motif: one to three recurrent props or visual images whose meaning develops and pays off.

Use action, props, reactions, or environment for information they can convey. Express the theme through choices and costs instead of slogans.

## Structure and rhythm

Set beats to the runtime. At minimum, include:

1. An opening image that immediately shows the protagonist's situation or a contrast.
2. An inciting event that breaks the old order.
3. An active choice that cannot easily be undone.
4. Increasing obstacles that change the situation and raise difficulty, risk, or emotional cost.
5. A midpoint revelation, temporary success, or defeat that changes the protagonist's understanding and method.
6. A low point or highest cost requiring a real sacrifice in goals, relationships, dignity, or safety.
7. A climactic choice that answers the theme through action. Avoid coincidence, sudden awakening, or rescue that replaces the protagonist's action.
8. An ending that echoes a relationship, prop, or opening image and shows character change.

Each series episode completes a smaller goal and ends with a new question, crisis, reveal, misunderstanding, or irreversible decision. Let the hook follow from the causal chain.

## AI production constraints

- Control the number of characters, locations, wardrobe changes, and key props. Reuse established assets. Merge extras where possible, preserving opponents, key family, and mentors.
- Carry age, hair, wardrobe, injuries, and held props across scenes. Explain changes in the story.
- Use one primary space and time per scene. Avoid frequent location changes, large crowds, and interactions that are difficult to generate reliably.
- Break long motion into beats with clear directions and visible results. Connect actor positions, eyelines, and environmental direction.
- Give every scene one main visual purpose to avoid competing spectacles.
- At script stage write story and filming intent. Add model parameters, negative prompts, seeds, or software instructions only when requested.

## Scene writing

Each scene answers who wants what, what or who prevents it, and how the situation changes. Combine or delete scenes that do not affect causality, character, or emotion.

Use this format, preserving the structural headings and writing the visible content in Korean (한국어):

```markdown
## 장면 N｜제목
**실내｜장소｜날씨와 시간대**
등장인물: [이 장면에 등장하는 캐릭터]
장면 과제: [주인공의 목표] / [장애물] / [결과 또는 전환점]

■ ([필요한 샷 크기 또는 카메라 움직임]) [현재형의 보이거나 들리는 동작과 환경]
■ [캐릭터의 동작이나 반응, 또는 상대역의 행동]
**캐릭터 이름：**
「대사 원문」
■ [새롭게 보이는 화면이나 상황]【장면 박자：[계기/선택/위기/폭로/회수]】
```

Write present tense, with short paragraphs of observable details. Show inner states through expression, movement, pauses, choices, or environmental reactions. Mention close-ups, camera movements, slow motion, flashbacks, and montage only when omitting them would change the story effect.

Dialogue rules:

- Give each person a distinct voice based on identity, age, relationships, purpose, and era.
- Let people speak to get something. Allow concealment, evasion, probing, and subtext.
- Cut facts both speakers know, repeated visuals, and direct declarations of emotion.
- Make critical lines short, specific, and able to change a relationship or action. Avoid manufactured profundity.
- Recognition, questions, calling someone's name, confrontations, persuasion, and farewells need an exchange. Restraint means avoiding slogans, while leaving enough dialogue for drama. Do not compress backstory into the narration of an older version of a person when a present character can speak.

## Default deliverables

For a complete-script request, deliver in this order. If the user requests a single phase, deliver that phase only.

1. **Creative setup**: title, genre, form, expected duration, main audience, one-sentence premise, theme, and visual tone.
2. **Synopsis**: connected prose covering beginning, turns, escalating opposition, climactic choice, and ending.
3. **Character profiles**: identity and age, visual identifiers, personality and voice, desire, fear and weakness, relationships, arc, and AI visual anchors.
4. **Key locations and props**: place, time and weather, spatial layout, color and light, story function, reusable elements, and how props appear and pay off.
5. **Structure**: beats for a short film. For a series, list each episode's goal, conflict, turn, result, and ending hook.
6. **Complete script**: consistent scene format through the ending.
7. **Continuity appendix**: cross-scene changes in appearances, wardrobe, injuries, prop ownership, time, and location.

## Diagnosis and revision

For an existing draft, retain the effective core and revise in this order:

1. Causality and protagonist agency.
2. Goals, obstacles, costs, and escalation.
3. Relationships and climactic choices.
4. Scene functions, information release, and pacing.
5. Dialogue, visual clarity, and AI production feasibility.

For diagnosis only, present problem, impact, fix, and example. For revision, provide usable revised text and add a concise change explanation only when helpful.

## Final review

Before delivery, fix issues found by checking:

- Clear protagonist goal, motives, time pressure, and stakes.
- Major outcomes supported by choices and setup.
- A goal, obstacle, and change in every scene, entering as late and leaving as early as possible.
- Important information appears once at the most effective moment.
- Speakers have distinguishable voices without labels.
- Dialogue avoids repeating pictures or known facts while retaining exchanges in recognition, confrontation, questioning, persuasion, and farewells.
- Continuity of props, injury, clothing, geography, time, and character knowledge.
- A workable number of character and location assets and action that breaks into stable shots.
- Realistic timing based on reading aloud, or about 180–220 Han characters per minute for Chinese dialogue, with time left for action, pauses, and empty shots.
- A readable opening and an emotional or visual payoff.
- Opponents, key family, and deceased characters are present in the profiles and the synopsis covers more than the climax.

Deliver only the requested artifact, without tutorial prose around the script.
