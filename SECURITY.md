# 보안 안내

## API Key 원칙

이 저장소는 실제 API Key, Token, Cookie, 비공개 서비스 주소 또는 개인 설정을 제공하지 않으며, 이러한 정보를 제출해서도 안 됩니다.

- 로컬 개발 시 `.env.example`을 `.env`로 복사하고, 실제 값은 `.env`에만 작성하세요.
- `.env`, `.env.*`, 개인 키 및 일반적인 자격 증명 파일은 `.gitignore`에서 제외하도록 설정되어 있습니다.
- 설정 페이지에서 내보낸 로컬 컴퓨터 설정, 로그, 진단 파일 또는 프로젝트 미디어 자료를 공개 저장소에 제출하지 마세요.
- 공개 설치 패키지를 배포할 때는 빌드 환경에 실제 `VITE_*_API_KEY`를 설정하지 마세요.

Vite의 `VITE_*` 변수는 프런트엔드 빌드 변수입니다. 빌드 시 실제 Key를 입력하면 JavaScript 산출물에 포함될 수 있습니다. 공개 배포 버전에서는 Key를 비워 두고, 각 사용자가 자신의 컴퓨터에서 구성하도록 해야 합니다.

## 제출 전 검사

```bash
git status --short
git ls-files ".env*" "*.pem" "*.key" "*.p12" "*.pfx"
npm run security:check
npm run build
```

빌드 명령은 `scripts/assert-pack-clean.mjs`를 실행하여 `dist`에 현재 컴퓨터의 `.env` 값이 포함되어 있는지 검사합니다. 그러나 이 검사는 Git 이력 스캔을 대체할 수 없으며, 모든 형태의 자격 증명을 식별하지도 못합니다.

공개 저장소에 푸시하기 전에 Gitleaks 또는 TruffleHog를 추가로 실행하는 것을 권장합니다.

```bash
gitleaks git --redact
```

## Key가 커밋 이력에 포함된 적이 있는 경우

현재 파일에서 삭제하는 것만으로는 충분하지 않습니다. 즉시 다음 조치를 취해야 합니다.

1. 해당 서비스 제공업체의 관리 화면에서 Key를 폐기하고 다시 생성하세요.
2. `git filter-repo` 또는 BFG를 사용하여 전체 Git 이력을 정리하세요.
3. 이력 스캔을 다시 실행하세요.
4. 유출이 없음을 확인한 후에만 공개 저장소에 푸시하세요.

## 취약점 보고

공개 Issue에 유효한 자격 증명, 사용자 미디어 자료 또는 재현 가능한 민감 데이터를 붙여 넣지 마세요. 관리자는 GitHub 저장소에서 Private vulnerability reporting을 활성화하여 보안 보고를 받을 수 있습니다.
