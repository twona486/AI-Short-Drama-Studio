# 🏗 AI Cut 아키텍처 빠른 참조

## 데이터 흐름

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Script   │ →  │ Shot[]   │ →  │ Asset[]  │ →  │Timeline[]│
│ (대본)   │    │ (콘티)   │    │ (자료)   │    │ (편집)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
   LLM 분할       AI 이미지/영상       IndexedDB        FFmpeg 내보내기
```

각 Shot은 `imageAssetId` / `videoAssetId`를 통해 Asset에 연결됩니다.
각 TimelineClip은 `shotId`를 통해 해당 Shot과 Asset을 역으로 찾습니다.

## 모듈 의존성

```
views/  →  stores/  →  services/  →  external (AI / FFmpeg / IDB)
                                ↓
                              types/
```

- `views/`는 store와 service만 호출합니다.
- `stores/`는 상태 계층(Pinia)이며, 자동으로 영구 저장합니다.
- `services/`는 비즈니스 로직입니다.
- `types/`는 순수 타입만 포함하며, 런타임 코드는 없습니다.

## AI 서비스 전환

`src/services/ai/runtime.ts`의 `getAIMode()`는 현재 항상 `real`(실제 API)을 반환합니다.
로컬 개발을 위해 코드에 mock 구현을 남겨 두었지만, 제품은 기본적으로 데모 모드로 진입하지 않습니다.

각 AI service 파일의 구조는 동일합니다.
```
xxx.ts:
  - realXxx(): 실제 구현
  - generateXxx(input, onProgress?): 진입점, real/mock 자동 선택
```

## FFmpeg 처리 흐름

```
[자료 blob] → writeFile(가상 FS)
             → exec(트랜스코딩/이어 붙이기/장면 전환)
             → exec(자막 입히기)
             → exec(BGM 믹싱)
             → exec(최종 형식 변환)
             → readFile → Blob → download
```

## 영구 저장

```
Pinia store 변경
   ↓
watch (deep)
   ↓
saveProject() / saveAsset()
   ↓
IndexedDB (idb.ts)
   ↓
자동 reload UI
```

## 라우팅

```
/                  HomeView         프로젝트 목록
/script            ScriptView       1. 대본
/storyboard        StoryboardView   2. 콘티
/images            ImagesView       3. AI 이미지
/videos            VideosView       4. AI 영상
/edit              EditView         5. 편집
/caption           CaptionView      6. 자막
/export            ExportView       7. 내보내기
/settings          SettingsView     설정
```

사이드바의 StepNav는 현재 route에 따라 강조 표시되며, 프로젝트 상태에 따라 ✓를 표시합니다.

## 테마 시스템

모든 색상 / 간격 / 모서리 반경은 `src/style.css`의 `:root`에 정의되어 있습니다.
변수 하나를 바꾸면 사이트 전체에 적용됩니다.

## 주요 제약 사항

- **FFmpeg에는 COOP/COEP가 필수**: vite.config.ts에 headers가 이미 추가되어 있습니다.
- **IndexedDB는 비동기 방식**: 모든 IDB 작업은 Promise입니다.
- **교차 출처 격리**: SharedArrayBuffer에는 `crossOriginIsolated`가 필요합니다.
