# FFmpeg Core 로컬 배치

네트워크에서 CDN 접속이 느리거나 차단되는 경우 FFmpeg core를 로컬에 다운로드할 수 있습니다.

## 한 번에 다운로드

```bash
node scripts/download-ffmpeg-core.cjs
```

기본적으로 jsdelivr에서 ESM 버전을 가져옵니다. 중국 내 네트워크에서는 `--source=npmmirror`를 추가할 수 있습니다.

선택 가능한 소스:
- `jsdelivr` (기본값, 국제)
- `unpkg` (국제)
- `npmmirror` (중국 내 미러, 중국 내 사용자에게 권장)

```bash
node scripts/download-ffmpeg-core.cjs --source=npmmirror
```

다운로드한 파일은 `src/assets/ffmpeg/`에 저장되며, Vite에서 `?url` import를 통해 참조합니다.

## 수동으로 파일 배치

자동 다운로드에 실패하면 아래 주소에서 파일 2개를 직접 다운로드하여 **`src/assets/ffmpeg/`** 디렉터리에 넣을 수 있습니다.

- `ffmpeg-core.esm.js` (~110 KB)  ← 반드시 **ESM 버전**이어야 하며, UMD 버전은 사용할 수 없습니다.
- `ffmpeg-core.wasm` (~30 MB)

주의 1: `@ffmpeg/ffmpeg` 0.12.10은 module worker 사용을 강제하며, module worker는 `importScripts`를 지원하지 않습니다.
따라서 UMD 버전 core는 사용할 수 없고, 반드시 ESM 버전(`dist/esm/ffmpeg-core.js`)을 사용해야 합니다.

주의 2: 파일은 반드시 `src/assets/ffmpeg/`에 넣어야 하며, **`public/`에 넣으면 안 됩니다**.
Vite는 source code에서 public/ 아래 파일을 참조하는 것을 금지하며, 다음 오류가 발생합니다.
> "This file is in /public and will be copied as-is ... should not be imported from source code"

주소(택일):

```
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm

https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js
https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm

https://registry.npmmirror.com/@ffmpeg/core@0.12.10/files/dist/esm/ffmpeg-core.js
https://registry.npmmirror.com/@ffmpeg/core@0.12.10/files/dist/esm/ffmpeg-core.wasm
```

## 우선순위

FFmpeg 클라이언트는 다음 순서로 core를 찾습니다.

1. **로컬** `src/assets/ffmpeg/ffmpeg-core.esm.js` + `.wasm` (?url import 사용, 네트워크 사용 없음)
2. jsDelivr CDN (ESM)
3. unpkg CDN (ESM)
4. npmmirror CDN (ESM)

## 로컬 배치가 필요한 이유

- **중국 내에서는 CDN 접속이 자주 차단되거나 시간 초과됨** → 로컬 방식이 가장 빠르고 안정적입니다.
- **COEP 제한** → `Cross-Origin-Embedder-Policy: require-corp`는 CORP 헤더가 없는 교차 출처 리소스를 거부하며, 로컬 리소스는 별도 조치 없이 사용할 수 있습니다.
- **완전한 오프라인 사용** → 한 번 실행하면 core가 브라우저 캐시에 저장되어, 다음 실행부터 즉시 로드됩니다.

