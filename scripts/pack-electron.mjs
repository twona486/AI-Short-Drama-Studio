import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const electronExe = path.join(electronDist, 'electron.exe')

/**
 * electron-builder는 ZIP을 win-unpacked.tmp에 푼 뒤 win-unpacked로 이름을 바꾼다.
 * Windows 검색이나 Defender가 default_app.asar를 열어 둔 경우 이름 변경 시 EPERM이 발생할 수 있다.
 * 이미 압축을 푼 Electron을 새 출력 폴더에 복사해 이름 변경과 이전 파일 정리를 피한다.
 */
if (!fs.existsSync(electronExe)) {
  console.error(`[pack] Unpacked Electron executable not found: ${electronExe}`)
  console.error('[pack] Run npm install first')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const output = path.posix.join('release', `pack-${stamp}`)
fs.mkdirSync(path.join(root, output), { recursive: true })

console.log('[pack] Copying node_modules/electron/dist directly')
console.log(`[pack] electronDist = ${electronDist}`)
console.log(`[pack] output = ${output}`)

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'electron-builder',
    '--publish=never',
    `--config.electronDist=${electronDist}`,
    `--config.directories.output=${output}`
  ],
  { stdio: 'inherit', shell: true, cwd: root }
)

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 1))
  child.on('error', () => resolve(1))
})

if (code === 0) {
  const absOut = path.join(root, output)
  const installers = fs.readdirSync(absOut).filter((name) => name.toLowerCase().endsWith('.exe'))
  if (installers.length) {
    console.log('[pack] Installer files:')
    for (const name of installers) console.log(`  ${path.join(absOut, name)}`)
  }
}

process.exit(code)
