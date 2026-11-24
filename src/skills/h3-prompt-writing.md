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
(S1) is Ah Kai / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is Da Bin / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location rental room. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.
```

Do not use `Picture 1 aligns with 0.00 seconds` for multimodal reference. Reserve alignment for frame modes. Keep the six-section and three-field formats separate.

## Six sections for multimodal reference

`subject_definitions` 写 `<Subject N> is EnglishName (S#) in <Picture N>`。名字用英文，不要写「中文名」。下面这段镜头正文放进 `detailed_description`，不要再外包一层 `integrated_multimodal_description`。首尾帧 / 首帧 / 尾帧 / 纯文本才用三段，而且对齐句在三段前面。

```text
subject_definitions:
<Subject 1> is Ah Kai (S1) in <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 2> is Da Bin (S2) in <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 3> is the rental room in <Picture 3>, the location for [Shot 1].

summary:
[reference generation] The target video is one continuous [Shot 1] of <Subject 1> and <Subject 2> in <Subject 3>. Character sheets lock identity only.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 1>.
<Subject 2> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 2>.
<Subject 3> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture 3>.

detailed_description:
[Shot 1] Grounded contemporary comedy, photorealistic live-action, 9:16. Afternoon light through the living-room window. (S1) Ah Kai squats at the left sofa, digging through cushions. (S2) Da Bin sprawls on the right sofa with a bag of chips. Neither looks into the lens.

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

- Deliver each line once, using its own speaker ID and time interval.
- Use `(S1) says: <d>[Korean] 준비됐어요?</d>` and describe the other listeners keeping their mouths closed. Use the actual full English name of the supplied line's language.
- Keep production notes, duration, style and cast lists out of dialogue. Leave dialogue tags and lip-sync instructions out of silent shots.

## Writing guidance

- Write visible action, camera position, lighting and descriptions of people and places in English. Preserve names where needed and keep supplied dialogue and visible text verbatim.
- Describe what actually happens: who stands where, what each person holds and how the props change. Avoid generic filler such as “let the frame breathe.”
- In `overall_soundscape`, name actual sounds, such as the crunch of chips or the rustle of a cushion.
- For this template, set `non_diegetic_music` to `N/A`.
