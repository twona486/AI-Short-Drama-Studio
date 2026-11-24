/**
 * 下载 FFmpeg core 到 src/assets/ffmpeg/
 *
 * 실행 방법
 *   node scripts/download-ffmpeg-core.cjs
 *   # 다운로드 서버 지정
 *   node scripts/download-ffmpeg-core.cjs --source=jsdelivr
 *
 * 다운로드 서버는 jsdelivr, unpkg, npmmirror 중에서 선택한다.
 *
 * 첫 로딩에 실패하면 이 스크립트로 코어를 미리 받아
 * 오프라인에서 사용할 수 있다.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const CORE_VERSION = '0.12.10'
// Vite 소스에서 public의 파일을 직접 가져올 수 없으므로 src/assets/ffmpeg에 보관한다.
// ?url import로 Vite가 처리한 URL을 얻는다.
const OUT_DIR = path.join(__dirname, '..', 'src', 'assets', 'ffmpeg')

const SOURCES = {
  jsdelivr: {
    base: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  },
  unpkg: {
    base: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  },
  npmmirror: {
    base: `https://registry.npmmirror.com/@ffmpeg/core/${CORE_VERSION}/files/dist/esm`,
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out = { source: 'jsdelivr' }
  for (const a of args) {
    if (a.startsWith('--source=')) out.source = a.slice(9)
    if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'User-Agent': 'node-ai-cut/0.1' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      let lastLog = 0
      res.on('data', (chunk) => {
        downloaded += chunk.length
        const now = Date.now()
        if (now - lastLog > 500 && total > 0) {
          const pct = ((downloaded / total) * 100).toFixed(1)
          process.stdout.write(
            `\r  → ${path.basename(dest)}  ${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(
              total / 1024 / 1024
            ).toFixed(1)}MB  (${pct}%)`
          )
          lastLog = now
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n')
          resolve()
        })
      })
    })
    req.on('error', (err) => {
      file.close()
      try {
        fs.unlinkSync(dest)
      } catch {}
      reject(err)
    })
    req.setTimeout(120000, () => {
      req.destroy(new Error('Download timed out after 120 seconds'))
    })
  })
}

async function main() {
  const args = parseArgs()
  if (args.help) {
    console.log(`
Download FFmpeg core to public/ffmpeg/.

Usage:
  node scripts/download-ffmpeg-core.cjs
  node scripts/download-ffmpeg-core.cjs --source=jsdelivr
  node scripts/download-ffmpeg-core.cjs --source=unpkg
  node scripts/download-ffmpeg-core.cjs --source=npmmirror

Sources:
  - jsdelivr (default, cdn.jsdelivr.net)
  - unpkg     (unpkg.com)
  - npmmirror (registry.npmmirror.com)
`)
    return
  }

  const src = SOURCES[args.source]
  if (!src) {
    console.error(`Unknown source ${args.source}. Available sources: ${Object.keys(SOURCES).join(', ')}`)
    process.exit(1)
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  }

  console.log(`\nDownloading FFmpeg core v${CORE_VERSION}`)
  console.log(`Destination: ${OUT_DIR}`)
  console.log(`Source: ${args.source}\n`)

  for (const file of src.files) {
    const url = `${src.base}/${file}`
    const dest = path.join(OUT_DIR, file)
    process.stdout.write(`Downloading ${file}...\n`)
    try {
      await download(url, dest)
      const size = fs.statSync(dest).size
      console.log(`  ✓ ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`)
    } catch (e) {
      console.error(`  Could not download ${file}: ${e.message}`)
      process.exit(1)
    }
  }

  // Vite가 ESM 코어를 UMD로 처리하지 않도록 .esm.js 확장자를 사용한다.
  const esmSrc = path.join(OUT_DIR, 'ffmpeg-core.js')
  const esmDest = path.join(OUT_DIR, 'ffmpeg-core.esm.js')
  if (fs.existsSync(esmSrc)) {
    if (fs.existsSync(esmDest)) {
      fs.unlinkSync(esmSrc)
    } else {
      fs.renameSync(esmSrc, esmDest)
      console.log(`  ↻ ffmpeg-core.js → ffmpeg-core.esm.js`)
    }
  }

  console.log(`\n✅ 完成！文件已放到 src/assets/ffmpeg/`)
  console.log(`\n下一步：重启 npm run dev，FFmpeg 会优先用本地文件。\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
