---
name: h3-prompt-writing
description: Write official MiniMax prompts for storyboard shots. Multimodal reference uses six sections. Frame and text-only modes use three fields, with the appropriate alignment sentence where applicable. Bind characters as (S1)(S2) and put dialogue inside <d>.
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词,优化提示词,영상,더빙,내레이션,이미지→영상,프롬프트,프롬프트 최적화
---

# Storyboard video prompts

Use prompt optimization to write the official format for the node mode. Generate **one clip per canvas shot**.

- Multimodal reference uses six sections: `subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`。Use `<Subject N> (S#)` for characters and use references to lock identity. Begin summary with `[reference generation]`.
- FL2VA uses a first-and-last-frame alignment sentence (Picture 1 at 0.00 seconds and Picture 2 at the end), followed by three fields including `integrated_multimodal_description`.
- I2VA has one first frame. Use the `at 0.00 seconds` alignment sentence followed by three fields.
- L2VA aligns Picture 1 with the end and uses three fields.
- Text-only T2VA uses three fields without an alignment sentence.

## Character reference identifiers

(S1) always uses the first character reference; (S2) uses the second. The numbering follows the person across the clip, regardless of dialogue order. These are identity references.

```text
Speaker lock (these labels are the pictures):
(S1) is 「민준」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「도윤」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「임대 아파트」. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.
```

Do not use `Picture 1 aligns with 0.00 seconds` for multimodal reference. Reserve alignment for frame modes. Keep the six-section and three-field formats separate.

## Six sections for multimodal reference

In `subject_definitions`, use `<Subject N> is 「name」 (S#) in <Picture N>`. Put the shot body below directly in `detailed_description`. Use the three fields for first-and-last-frame, first-frame, last-frame, and text-only modes. Place an applicable alignment sentence before those fields.

```text
subject_definitions:
<Subject 1> is 「민준」 (S1) in <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 2> is 「도윤」 (S2) in <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 3> is 「임대 아파트」 in <Picture 3>, the location for [Shot 1].

summary:
[reference generation] The target video is one continuous [Shot 1] of <Subject 1> and <Subject 2> in <Subject 3>. Character sheets lock identity only.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 1>.
<Subject 2> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 2>.
<Subject 3> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture 3>.

detailed_description:
[Shot 1] Grounded contemporary comedy, photorealistic live-action, 9:16. Afternoon light through the living-room window. (S1) 「민준」 squats at the left sofa, digging through cushions. (S2) 「도윤」 sprawls on the right sofa with a bag of chips. Neither looks into the lens.

[00:00.000–00:01.200]
Wide view from the doorway. Both mouths stay closed. Chip crunch and cushion rustle only.

[00:01.200–00:05.600]
Cut to (S1) alone. (S2) is off screen.
(S1) says: <d>[Korean] 내 검은 넥타이 어디 갔지? 지난주에 산 건데! 너 못 봤어?</d>
Only (S1) speaks in this shot. (S2) keeps their lips completely closed and makes no voice.

[Shot 2] At 00:05.600
Cut to (S2) alone. He swallows before he talks.
(S2) says: <d>[Korean] 네가 둔 걸 왜 나한테 물어봐? 내 과자통에 숨긴 건 아니야.</d>
Only (S2) speaks in this shot. (S1) keeps their lips completely closed and makes no voice.
The chip bag is visibly emptier than at the start. The action develops continuously and finishes naturally within 8 seconds.

overall_soundscape:
Quiet living-room tone, cushion rustle, crisp chip crunch. Only the speaking (S#) is heard, and only the words inside the d tag. No music.

non_diegetic_music:
N/A
```

## Dialogue

- Each line is spoken once by its assigned (S#) in its own time range.
- Use original words and the correct language tag. For Chinese use `(S1) says: <d>[Chinese] verbatim line</d>`; for Korean use `(S1) says: <d>[Korean] 대사 원문</d>`. Immediately say that the other people keep their lips closed.
- Keep production notes, duration, style, and cast details outside dialogue tags.
- When there is no dialogue, write `No dialogue. No lips moving.`. Do not put a placeholder such as “none” or ‘없음’ inside `<d>`.

## Writing guidance

- Write the final model prompt in English, including action, camera position, and light. Keep Korean dialogue and explicitly requested Korean (한국어) on-screen text verbatim. Preserve original dialogue and names; avoid model-facing scene narration in Chinese.
- Describe what actually happens: who is to the left or right, what they hold, and how the prop changes. Avoid template language like “Begin with the opening frame” or “let the frame breathe”.
- In `overall_soundscape`, name the actual sounds, such as crisp chip crunch or cushion rustle. Do not just write close breath.
- Set `non_diegetic_music` to `N/A`. Write user-facing explanations in Korean (한국어).
