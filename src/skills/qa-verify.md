---
name: qa-verify
description: Compare project state against the required storyboard, character, continuity, image, and video assets. Use for an explicit quality check or after batch generation.
triggers: 检查,验收,对一下,有没有漏,质检,看看齐了没,확인,검수,대조,누락,품질 점검,다 갖췄는지,quality check,review,missing
---

# Quality check

Verify that the results can move forward to editing, independent of API success.

## Checklist

- Is there a storyboard? Does the narration sound natural when read in order?
- Does every recurring person have a four-view character sheet? Does every location have a four-panel anchor image? Does every applicable shot have a storyboard panel?
- Are subjectIds / sceneId linked to each storyboard shot?
- Which shots lack a panel, character reference, or location image? Which have a panel but no video? A shot image is optional for video generation.
- Does a person change clothes or locations abruptly, or does an object vanish from their hand?

## Report

Write the report in Korean (한국어). Mention missing or questionable items concisely. For example: “6개 샷을 확인했습니다. 아강의 캐릭터 설정과 4번 샷 이미지가 빠졌습니다. 2번 샷은 골목 입구, 3번 샷은 실내여서 사이에 전환이 필요합니다.”

If everything is present, confirm that in one sentence.
