import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packagedExecutable = process.argv[2]
const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = await mkdtemp(path.join(tmpdir(), 'drama-flow-startup-'))
const profile = path.join(fixture, 'profile')
const projects = path.join(fixture, 'projects')
await mkdir(profile)
await writeFile(path.join(profile, 'storage-root.json'), JSON.stringify({ root: projects }))

const windows = process.platform === 'win32'
const command = packagedExecutable ? path.resolve(packagedExecutable) : process.execPath
const args = packagedExecutable
  ? [`--user-data-dir=${profile}`]
  : [process.env.npm_execpath, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '0']

let child
let exited
let output = ''
try {
  assert.ok(packagedExecutable || process.env.npm_execpath, 'npm run test:electron-start로 실행해야 합니다.')
  child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, DRAMA_FLOW_DEV_USER_DATA_DIR: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !windows
  })
  exited = new Promise((resolve) => child.once('close', resolve))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Electron 시작 확인 시간이 초과됐습니다.')), 60_000)
    function finish(error) {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const read = (chunk) => {
      output += chunk.toString()
      if (/Uncaught Exception|A JavaScript error occurred in the main process|Unable to load preload script/i.test(output)) {
        finish(new Error('Electron 시작 중 오류가 발생했습니다.'))
      } else if (/\[electron\] preload .* desktop api via preload\.cjs/.test(output)) {
        finish()
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('error', finish)
    child.once('close', (code) => finish(new Error(`Electron이 첫 화면을 로드하기 전에 종료됐습니다. 종료 코드 ${code}.`)))
  })
  await access(path.join(projects, 'app.db'))
  console.log(packagedExecutable ? '패키징된 Electron 앱이 첫 화면을 로드했습니다.' : '개발 모드 Electron 앱이 첫 화면을 로드했습니다.')
} catch (error) {
  console.error(output)
  throw error
} finally {
  if (child?.pid) {
    if (windows) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  await exited
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 })
}
