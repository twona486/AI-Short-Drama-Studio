---
name: pipeline-batch
description: Run the full production workflow in order only when the user explicitly asks to batch or complete everything.
triggers: 全部做完,一口气,整条流水线,都生成,全做,全部生成,从头到尾,缺的都补上,全流程,전부 완료,한 번에,전체 워크플로,모두 생성,전부 해,전체 생성,처음부터 끝까지,빠진 것 전부,전체 과정,full workflow,generate all,finish everything
---

# Batch workflow

Use this guide only when the user explicitly requests a batch on this turn. Execute at most 12 actions at a time. Skip steps the user did not request. Use `generate_all_*` only for an explicit request for all results.

## Default progression

Stop after writing the script. Tell the user in Korean (한국어) that the complete script is on the left side of the canvas and node extraction has not started. Ask whether to extract nodes.

- When the user says to continue and there are no nodes, extract characters, then locations, then storyboard shots, one step per invocation. Save immediately after each. When nodes are present, verify and do only the next step.
- When the user approves, verify and ask whether to continue.
- Run everything in one workflow only on an explicit request for the full workflow.
- When unclear, ask for the subject, duration, and whether the user wants the script or the full workflow.

## Order for the full workflow

1. Without a complete script, use `generate_play`.
2. Without storyboard nodes, use `extract_cast`.
3. Use `approve_play`. Automatically approve only in a full workflow.
4. For missing character sheets, use `generate_all_sheets`.
5. For missing location anchors, use `generate_all_scenes`.
6. For missing storyboard panels, use `generate_all_boards`.
7. If panels exist and videos are missing, use `generate_all_videos`. Supply character images, location images, and panels without pre-generating shot images.
8. Use `generate_all_images` only when the user explicitly requests shot images.

## Checks and recovery

- Check dependencies before each action. Fill the smallest missing prerequisite and then return to the original objective.
- Verify the actual script, nodes, or assets in the project after tool success.
- Fix only affected parts for input or quality problems. Retry the same objective once after a transient service error.
- Stop repeated attempts after the same error happens twice. Pause and explain authentication, quota, content safety, user-approval, or authorization issues.
- Record automatic prerequisite actions and replanning counts so they can be traced after a refresh or reopening.

## Requests for one stage

- Write the script or break down the story: use only `generate_play` and stop.
- Continue or add two scenes: use only `continue_play` and preserve existing scenes.
- Extract nodes: use only `extract_cast`; characters first, then locations after confirmation, then shots on a later turn.
- Character sheet: generate only character images.
- Location: generate the four-panel location anchor only.
- Storyboard panel: generate the line-art composition only.
- Draw the third shot: generate that image only, and fill its missing panel first if needed.
- Generate the third shot video: generate that video only.

Report briefly and concretely in Korean (한국어). Write prompts sent to generation models in English, preserving Korean dialogue or explicitly requested Korean on-screen text.
