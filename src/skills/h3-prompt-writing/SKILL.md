---
name: h3-prompt-writing
description: MiniMax 공식 형식으로 샷 영상 프롬프트를 작성한다. 멀티모달 참조는 여섯 섹션으로 구성한다. 시작 프레임, 시작·끝 프레임, 끝 프레임, 텍스트 전용은 세 필드와 해당 모드의 정렬 문구를 사용한다. 각 캐릭터의 (S1)/(S2)를 고정한다.
compatibility: 로컬 파일을 읽을 수 있는 에이전트에서 사용할 수 있다. 외부 도구는 필요 없다.
---

# 샷 프롬프트 작성

샷 영상 노드의 모드에 맞춘다. 멀티모달 참조는 여섯 섹션의 공식 Ref2VA 본문을 사용한다. 시작·끝 프레임은 FL2VA이며 정렬 문장 뒤에 세 필드를 쓴다. 시작 프레임만 있으면 I2VA, 끝 프레임만 있으면 L2VA, 이미지가 없고 텍스트만 있으면 T2VA다.

## 화자와 참조 이미지 대응

(S1)은 항상 첫 번째 캐릭터 참조, (S2)는 두 번째 참조다. 대사 순서로 번호를 다시 매기지 않는다. 참조 이미지는 캐릭터 식별에 사용한다.

```text
Speaker lock (these labels are the pictures):
(S1) is 「阿凯」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「大斌」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「出租屋」. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time. Everyone else keeps their lips completely closed.
```

멀티모달 참조에서는 `subject_definitions`에 `<Subject N> is 「name」 (S#) in <Picture N>` 형식으로 캐릭터를 정의한다. 이 모드에서는 `Picture 1 aligns with 0.00 seconds`를 쓰지 않는다. 정렬 문구는 I2VA, FL2VA, L2VA에서만 사용한다. 여섯 섹션 본문과 세 필드 본문을 섞지 않는다.

## 본문

1. 화자 대응 블록 뒤에 `[Shot 1]`과 실제 배치를 쓴다. 누가 왼쪽이나 오른쪽에 있고 무엇을 들고 있으며 소품이 어떻게 바뀌는지 명시한다.
2. 원문에 있는 대사마다 시간 구간을 배정한다. 중국어는 `(S1) says: <d>[Chinese] 原词</d>`, 한국어는 `(S1) says: <d>[Korean] 대사 원문</d>`으로 쓰고, 나머지 인물이 입을 다문다고 이어서 적는다.
3. 동작, 카메라, 빛은 영어로 작성한다. 중국어는 `<d>`와 「이름」 안에서만 사용한다. 중국어 장면 문단은 삭제되어 인물 목록만 남을 수 있다.
4. `overall_soundscape`에는 장면에서 실제로 들리는 소리를 쓴다. “close breath stay synchronized”만 쓰지 않는다.
5. `non_diegetic_music`은 항상 `N/A`다.
