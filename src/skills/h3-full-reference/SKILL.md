---
name: h3-full-reference
description: Rewrite a MiniMax H3 full-reference prompt into six sections. Use only when optimizing the H3 full-reference mode.
---

Turn the user's video request into the official six-section format. Preserve the required order, labels, task types, retention values and shot syntax. Describe visible reference identities and the actual action of each shot.

Return only a single JSON object, without code fences, explanation, or additional fields:
{
  "subject_definitions": ["one definition per reference subject"],
  "summary": "an English paragraph beginning with the task type in square brackets",
  "retention_analysis": ["one retention statement per defined reference"],
  "detailed_description": "style opening and newline-separated [Shot N] sections",
  "overall_soundscape": "environmental and physical sound throughout the video",
  "non_diegetic_music": "music heard only by viewers, or N/A"
}

## Language and source fidelity

- Write the six sections in English. Preserve supplied dialogue, lyrics and on-screen text in their original language. If the user requests new dialogue, default to natural Korean and match the character's speaking register.
- Treat a story's system panels, HUDs, notices and countdowns as on-screen action. Preserve specified text and order verbatim. Specify the timing and location of each cue and keep it clear of important action. Give any separate off-screen system voice its own speaker instead of animating the lead's mouth.
- For speech, include the subject tag, speaker ID, action or delivery, and the complete dialogue tag. Example: <Subject 1> (S1) turns and whispers, <d>[Korean] 드디어 찾았어요.</d>. Use full English language names such as Korean, Chinese, English or Japanese. Do not use locale codes like ko or zh-CN.

## Subject definitions

- Keep one sentence per definition. Identify the source image, video or audio, its role and the visible features to follow. Describe action, dialogue, camera and lighting changes in detailed_description.
- For people or creatures, use the reference's actual body shape. Record distinctive features that are visible, typically five to eight, such as apparent age, hair style and color, facial details, makeup, skin tone, clothing, accessories, build and posture. Never invent features or give a nonhuman subject human hands, hair or clothes that the reference lacks.
- For a setting, describe its spatial structure, key furnishings, materials, primary colors, landmarks, light and weather. For example, an exposed brick wall, orange tufted sofa, patterned pillows, neon sign and wooden coffee table.
- Put separately tracked outfits, props and styles on their own lines. A reference image used only to define a person does not need a separate <Picture N> entry. When several sources define the same subject, merge the definition and say which source supplies appearance, motion or voice.
- Example: <Subject 1> is the young woman in <Picture 1>, with long dark hair falling over one shoulder, a pale complexion, a blue knit cardigan over a white blouse, and a thin silver necklace.

## Summary and retention

- Summarize the final result, core event, intended running time and intended effect. Avoid repeating the reference list or introducing new labels.
- Select the task type by the actual role of the references: keyframe completion, reference generation, video editing, video continuation, audio reuse or audio reference. Pure text input can use [text to video]. Use video editing or audio reuse only for an explicit request such as cuts, transitions, effects, captions, picture-in-picture, speed changes, mixing or soundtrack replacement.
- Use one retention line per defined label. State exactly which defined traits carry through or change. New story events, motion or camera work do not imply lost identity. When the traits are unchanged, write fully_preserved and name them.
- Valid visual relationships are fully_preserved, partially_preserved, attribute_transfer and weak_reference. Valid audio relationships are fully_copy, partially_copy, reference and weak_reference.
- Example: <Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - blue cardigan and silver necklace.
- Example: <Picture 2> ([Shot 1] first frame): fully_preserved - initial geometry and lighting.
- Omit speaker IDs from retention_analysis. With no references, state the consistency requirements and avoid inventing reference tags.

## Detailed description

- Start with one or two sentences establishing image quality, color and visual language before [Shot 1]. Describe the shots in playback order. [Shot 1] has no timestamp. Use [Shot N] At MM:SS.mmm, ... for later cuts, with the cut before the target duration.
- Use one shot for a continuous move, push, pullback or track. Open a new shot only for an actual cut or camera change. Time the beats from zero through the target duration without gaps or overlaps. Correct timing without deleting events.
- For every beat, describe framing and shot size, subject appearance and position, lighting and surroundings, continuous action and visible effects, camera direction and speed, current sound and where the references apply. Give the starting pose, focus target, response and final visible result. Preserve requested macro details, side lighting, continuous pullbacks and low-angle tracking. At each important subject's first clear appearance, show the locked appearance in its current position and action. Reuse the same label thereafter.
- Use roughly 350–500 words of concrete direction for generation. For dense conversations, prioritize the full dialogue timeline.
- Number audible sources in order of first speech, starting at (S1), and reuse the same ID for each source throughout. For simultaneous speech, chanting or singing, use the participants' existing IDs together, such as <Subject 1> and <Subject 2> (S1,S2) call together, <d>[Korean] 같이 가요!</d>. Use one dialogue tag for the shared line. Use individual IDs and dialogue tags when lines are sequential.
- An off-screen speaker can be <Subject N> (Sx) off-screen. If no defined subject matches, describe the recurring voice, such as a young male narrator (S2). Use <Audio N> directly only for lyrics from a reused music or audio track, without adding a speaker ID.
- Keep complete spoken lines in detailed_description only. Put ambience and synchronized physical sound in overall_soundscape. Put audience-only music in non_diegetic_music with instruments, tempo and dynamics, or N/A.
