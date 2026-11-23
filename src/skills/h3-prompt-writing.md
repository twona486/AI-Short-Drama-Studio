---
name: h3-prompt-writing
description: 스토리보드 샷의 영상 생성 프롬프트를 작성한다. 멀티모달 참조는 공식 여섯 섹션을, 시작·끝 프레임, 시작 프레임, 끝 프레임, 텍스트 전용 모드는 세 필드와 해당하는 정렬 문장을 사용한다. (S1)(S2)로 캐릭터를 고정하고 대사는 <d>에 넣는다.
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词,优化提示词,영상,더빙,내레이션,이미지→영상,프롬프트,프롬프트 최적화
---

# 스토리보드 영상 프롬프트

‘프롬프트 최적화’를 누르면 노드 모드에 맞는 공식 형식으로 작성한다. 캔버스에서 **샷 하나당 영상 하나**를 생성한다.

- 멀티모달 참조는 여섯 섹션을 사용한다. `subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`。캐릭터는 `<Subject N> (S#)`로 정의하고 참조 이미지는 캐릭터 식별에 사용한다. summary는 `[reference generation]`으로 시작한다.
- 시작·끝 프레임 FL2VA는 정렬 문장(Picture 1 = 0.00초, Picture 2 = 영상 끝)과 `integrated_multimodal_description`을 포함한 세 필드를 사용한다.
- 시작 프레임 한 장을 쓰는 I2VA는 `at 0.00 seconds` 정렬 문장과 세 필드를 사용한다.
- 끝 프레임만 쓰는 L2VA는 Picture 1을 영상 끝에 정렬하고 세 필드를 사용한다.
- 텍스트 전용 T2VA는 정렬 문장 없이 세 필드만 쓴다.

## 캐릭터 참조 이미지는 (S1) (S2)로 표시

(S1)은 항상 첫 번째 캐릭터 참조 이미지, (S2)는 항상 두 번째다. 번호는 인물에 고정하며 대사 순서로 바꾸지 않는다. 참조 이미지는 **캐릭터 식별용**이다.

```text
Speaker lock (these labels are the pictures):
(S1) is 「阿凯」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「大斌」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「出租屋」. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.
```

멀티모달 참조에서는 `Picture 1 aligns with 0.00 seconds`를 쓰지 않는다. 이 정렬 문장은 프레임 모드에서 사용한다. 여섯 섹션과 세 필드를 한 프롬프트에서 섞지 않는다.

## 멀티모달 참조의 여섯 섹션

`subject_definitions`에는 `<Subject N> is 「이름」 (S#) in <Picture N>`을 쓴다. 아래 샷 본문은 `detailed_description`에 넣고 `integrated_multimodal_description`으로 다시 감싸지 않는다. 시작·끝 프레임, 시작 프레임, 끝 프레임, 텍스트 전용에는 세 필드를 쓴다. 정렬 문장이 있는 모드는 세 필드 앞에 배치한다.

```text
subject_definitions:
<Subject 1> is 「阿凯」 (S1) in <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 2> is 「大斌」 (S2) in <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 3> is 「出租屋」 in <Picture 3>, the location for [Shot 1].

summary:
[reference generation] The target video is one continuous [Shot 1] of <Subject 1> and <Subject 2> in <Subject 3>. Character sheets lock identity only.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 1>.
<Subject 2> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 2>.
<Subject 3> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture 3>.

detailed_description:
[Shot 1] Grounded contemporary comedy, photorealistic live-action, 9:16. Afternoon light through the living-room window. (S1) 「阿凯」 squats at the left sofa, digging through cushions. (S2) 「大斌」 sprawls on the right sofa with a bag of chips. Neither looks into the lens.

[00:00.000–00:01.200]
Wide view from the doorway. Both mouths stay closed. Chip crunch and cushion rustle only.

[00:01.200–00:05.600]
Cut to (S1) alone. (S2) is off screen.
(S1) says: <d>[Chinese] 我那条黑领带呢！上周刚买的！你见着没有啊！</d>
Only (S1) speaks in this shot. (S2) keeps their lips completely closed and makes no voice.

[Shot 2] At 00:05.600
Cut to (S2) alone. He swallows before he talks.
(S2) says: <d>[Chinese] 你自己扔的地方问我？反正我零食罐里没藏领带。</d>
Only (S2) speaks in this shot. (S1) keeps their lips completely closed and makes no voice.
The chip bag is visibly emptier than at the start. The action develops continuously and finishes naturally within 8 seconds.

overall_soundscape:
Quiet living-room tone, cushion rustle, crisp chip crunch. Only the speaking (S#) is heard, and only the words inside the d tag. No music.

non_diegetic_music:
N/A
```

## 대사

- 대사마다 지정된 (S#)가 독립된 시간 구간에서 한 번만 말한다.
- 대사 원문과 언어 태그를 사용한다. 중국어는 `(S1) says: <d>[Chinese] 原词</d>`, 한국어는 `(S1) says: <d>[Korean] 대사 원문</d>`으로 쓰고 바로 뒤에 다른 인물이 입을 다문다고 적는다.
- 현장 기록, 길이, 그림체, 캐릭터 목록은 대사 태그 밖에 둔다.
- 대사가 없으면 `No dialogue. No lips moving.`으로 쓴다. `<d>` 안에 「无」나 ‘없음’을 넣지 않는다.

## 작성 방식

- 동작, 카메라 위치, 조명은 영어로 쓴다. 중국어는 `<d>`와 「인물 이름」 안에서만 사용한다. 장면을 중국어로 쓰면 장면 설명이 삭제돼 인물 목록만 남는다.
- 장면에서 실제로 일어나는 일을 쓴다. 누가 왼쪽이나 오른쪽에 있고 무엇을 들고 있으며 소품이 어떻게 줄어드는지 설명한다. “Begin with the opening frame”이나 “let the frame breathe” 같은 문구는 쓰지 않는다.
- `overall_soundscape`에는 감자 칩이 바삭거리는 소리나 쿠션이 스치는 소리처럼 장면의 실제 소리를 쓴다. close breath만 적지 않는다.
- `non_diegetic_music`은 `N/A`로 고정한다.
