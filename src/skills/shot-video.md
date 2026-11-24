---
name: shot-video
description: Generate controllable MiniMax H3 video using character design images, the location image, and the shot's storyboard panel.
triggers: 视频,出片,图生视频,运镜,动起来,生成视频,영상,영상 생성,이미지→영상,카메라 움직임,움직이게,video,generate video,image-to-video
---

# Image-to-video

Send no composited character-and-location shot image. Use at most nine references in this order: each character design image for this shot, the current location image, and this shot's storyboard panel. Generate the panel from the character and location images first, then send it to the video model as the action plan.

Provide missing character, location, or panel references before generating. In an off-screen narration shot, a person whose name is called keeps their lips closed. The final video must show one complete image with no grid, panel borders, collage, subtitles, or labels unless the user explicitly asks for on-screen text.

Use the action and performance in `videoPrompt`; do not send `visualPrompt` unchanged. Divide the full duration into 2–5 ranges based on the story's real beats. State who sees and does what, who speaks, how others react, and how emotion and camera motion change. Do not divide into equal generic blocks. For **H3**, use prompt optimization and follow `h3-prompt-writing` for the official `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` format. One generated clip may have internal `[Shot 1]`, `[Shot 2]`, and `[Shot 3]` cuts. Leave the first shot untimed and use a timestamp such as `At 00:03.000` for later cuts. Bind each character to their assigned (S1), (S2), and reference image. Preserve the spoken words in their original language. Tag Korean as `<d>[Korean] 대사 원문</d>` and Chinese as `<d>[Chinese] verbatim line</d>`. Only one person speaks at a time. Character sheets are not I2VA first frames. Do not apply this H3 format to Wan.

## Dubbing

- `h3-dialogue` is the default. H3 generates on-screen dialogue and natural lip movement.
- `h3-voiceover` generates off-screen narration with on-screen mouths closed.
- `tts` disables H3 voices and mixes separate TTS into the final edit.
- `none` uses ambient sound only.

Write the final generation prompt in English and keep Korean dialogue, narration, or user-requested Korean on-screen text verbatim. Names, vocal qualities, and shot directions go outside the spoken tag. For off-screen narration use `says in an off-screen voiceover` and specify closed lips. If the narration field only contains a shot size or direction, write `No dialogue. No lips moving.` Write user-facing explanations in Korean (한국어).

## Motion and queue

- Use the storyboard's single main camera movement and complete the action within the allotted duration.
- For an individual shot use `generate_video + shotId`; for all shots use `generate_all_videos`. AutoDL can submit multiple missing videos concurrently.
- If self-check or generation fails, suspend later workflow steps and report the affected shot.
