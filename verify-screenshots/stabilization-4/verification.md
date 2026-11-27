# 안정화 문제 4건 확인

기준은 최신 `origin/main`의 `530545a`이며, 로컬 브랜치는 `fix/stabilization-4`입니다. 작업 공간은 `/Users/frost/orca/workspaces/AI-Short-Drama-Studio/shiner`입니다.

| 문제 | 수정 전 | 수정 후 | 앱 화면 |
|---|---|---|---|
| 일괄 실행 | 버튼이 확인 없이 생성 경계에 도달했습니다. | 그룹, 이미지·참조 이미지, 영상·시작/끝 프레임, 더빙, 영상 프롬프트 최적화가 대상과 개수를 표시합니다. 취소 응답에서는 생성 경계에 도달하지 않았습니다. | [그룹](after-group.png) · [이미지](after-images.png) · [영상과 프레임](after-videos.png) · [더빙](after-caption.png) · [프롬프트 최적화](after-optimize.png) |
| 대본 전환 | 확인 Promise의 응답이 오기 전에 다른 대본을 표시했습니다. | 취소 시 원래 대본과 편집 내용이 유지됩니다. 확인 호출 전수 점검에서 캔버스 대본 교체도 공용 확인 경로를 사용하도록 바꿨습니다. | [수정 전](before-script-switch.png) · [수정 후](after-script-switch.png) |
| 저장 폴더 복구 | SQLite가 지정 폴더를 열지 못한 뒤 부모 창 없는 모달이 먼저 열려 시작 검사에서 첫 화면을 찾지 못했습니다. | 첫 화면에 복구 안내와 두 선택지가 표시됩니다. 복구 폴더 사용은 기존 저장 설정을 보존합니다. 새 경로를 저장하고 앱이 다시 열리는 것까지 확인했습니다. | [첫 화면](recovery-start.png) · [새 저장 폴더](recovery-replacement.png) |
| ComfyUI 언어 전환 | 설정 진입 때 읽은 번역이 제목, 좌측 탭, 소개 문구에 남았습니다. | 다른 설정 섹션과 같은 반응형 getter를 적용했습니다. 양방향 전환에서 선택한 언어가 즉시 반영됐습니다. | [수정 전 한국어](before-comfyui-ko.png) · [수정 후 한국어](after-comfyui-ko.png) · [수정 전 중국어](before-comfyui-zh.png) · [수정 후 중국어](after-comfyui-zh.png) |

## 검증 결과

- `npm test` 78개, `npm run type-check`, `npm run build`, `npm run test:electron-start -- --verify-fallback` 통과.
- 격리 프로필과 시험 대본 2개, 샷 2개로 Electron 개발 앱을 실행했습니다. 기준·수정본의 생성 경계를 차단했고, 수정본의 네이티브 확인 창은 테스트용 취소 신호로 닫았습니다. 폴더 다시 선택은 임시 경로를 반환하는 선택기 응답으로 확인했습니다.
- 잠긴 화면에서는 네이티브 확인 창을 캡처할 수 없었습니다. PNG는 Electron 렌더러 화면이며 확인 창 문구와 취소 결과는 [재현 기록](reproduction.txt)에 있습니다. 수정 전 저장 폴더 문제는 첫 화면이 없어 시작 오류를 기록했습니다.
- 공급자와 모델에 따라 비용과 처리 시간이 달라져 확인 창에는 집계한 대상 수와 변동 안내를 표시합니다.
- 작업용 Electron과 Vite를 종료하고 각 프로세스 그룹이 비어 있는 것을 확인했습니다.

## 코드 커밋

- `2085fbc` 대본 전환 취소와 ComfyUI 설정 번역 갱신 수정
- `e9d86a6` 캔버스 대본 교체에서도 확인 응답을 기다리도록 수정
- `4037294` 유료·로컬 일괄 실행 확인과 저장 폴더 복구 안내 추가
