# 외부 연결 주소 정책

| 연결 | 허용 주소 | 요청의 Host |
| --- | --- | --- |
| 언어 모델과 OpenAI 호환 게이트웨이 | HTTPS 또는 로컬·사설망·Tailscale HTTP. HTTP는 `localhost`, 사설 IPv4, Tailscale `100.64.0.0/10`, `*.local`, `*.ts.net`을 허용합니다. | 설정 주소의 Host를 사용합니다. |
| LTX Desktop | 같은 로컬·사설망·Tailscale 주소에 HTTP 또는 HTTPS를 사용합니다. 기본 포트는 41955입니다. | 입력한 Host 오버라이드가 우선입니다. Tailscale IP나 `*.ts.net` 연결의 기본값은 `localhost:<포트>`입니다. 그 외 기본값은 접속한 IP와 포트입니다. |
| Draw Things | 같은 로컬·사설망·Tailscale 주소를 사용합니다. HTTP의 기본 포트는 7860, gRPC의 기본 포트는 7859입니다. | 설정 주소의 Host를 사용합니다. |
| AutoDL, ComfyUI, 사용자 지정 프록시 | 연결의 HTTP 또는 HTTPS 주소를 사용합니다. | 설정 주소의 Host를 사용합니다. |
| DashScope 영상 프록시 | 지정된 HTTPS API 도메인과 영상 생성·상태 조회 경로를 사용합니다. | API 주소의 Host를 사용합니다. |
| 외부 영상 다운로드 | 공용 HTTPS 주소를 사용합니다. 리디렉션마다 DNS를 다시 확인합니다. | 다운로드 주소의 Host를 사용합니다. |

로컬 연결에서 주소를 확인하고 접속할 IPv4를 고정합니다. `*.local`은 사설 IPv4, `*.ts.net`은 Tailscale IPv4로 해석되어야 합니다. 언어 모델 HTTP에서 IP를 직접 입력하면 다른 Mac에서 실행 중인 서버에도 연결할 수 있습니다. 공개 언어 모델에는 HTTPS가 필요합니다.

## 데스크톱 설정 저장

기존 평문 설정은 정상적으로 읽은 뒤 SQLite의 `settings` 레코드를 `schemaVersion: 1` 암호화 형식으로 저장합니다. API 키, LTX Desktop 페어링 토큰과 공유 키는 운영체제 자격 증명 저장소를 사용하는 Electron `safeStorage`로 보호합니다. Windows에서는 운영체제에서 보호한 암호화 키가 프로필에 기록된 뒤 기존 설정을 교체합니다. 데스크톱 앱은 설정을 성공적으로 저장한 다음 브라우저 미러에서 키, 토큰과 사용자 지정 인증 헤더를 제거합니다. 다른 운영체제 계정이나 장치에 복사한 암호화 설정은 해당 환경의 자격 증명 저장소에서 읽지 못할 수 있습니다.
