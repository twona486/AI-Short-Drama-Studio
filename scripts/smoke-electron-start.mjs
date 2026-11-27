import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packagedExecutable = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const verifyFallback = process.argv.includes('--verify-fallback')
const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = await mkdtemp(path.join(tmpdir(), 'drama-flow-startup-'))
const profile = path.join(fixture, 'profile')
const projects = path.join(fixture, 'projects')
const settings = {
  llms: [{ id: 'fixture', name: '기존 대본 연결', baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'fixture-model' }],
  activeLlmId: 'fixture',
  images: [{ id: 'draw', name: 'Draw Things', provider: 'draw-things', baseUrl: 'grpc://localhost',
    apiKey: '', model: 'qwen_image_2.1_q8p.ckpt', drawThingsSharedSecret: 'test-shared-secret' }],
  activeImageId: 'draw',
  videos: [{ id: 'ltx-local', name: 'LTX Desktop', provider: 'ltx-desktop', baseUrl: 'http://localhost:41955',
    apiKey: 'test-pairing-token', workflowId: 'ltx-2.3-fast' }],
  activeVideoId: 'ltx-local',
  autodlToken: 'test-autodl-token',
  music: { baseUrl: 'https://example.com', apiKey: 'test-music-key', model: 'music', models: ['music'] }
}
const damaged = JSON.stringify({ ...settings, music: { ...settings.music, models: { invalid: true } } })
const windows = process.platform === 'win32'
const command = packagedExecutable ? path.resolve(packagedExecutable) : process.execPath
const args = packagedExecutable
  ? [`--user-data-dir=${profile}`, '--remote-debugging-port=0']
  : [process.env.npm_execpath, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '0']

let child
let exited
let output = ''
let socket
let endpoint
let nextId = 0
const pending = new Map()
const rendererErrors = []
const config = 'document.querySelector("#app")?.__vue_app__?.config.globalProperties.$pinia.state.value.settings?.config'

async function until(probe, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let error
  while (Date.now() < deadline && child?.exitCode == null) {
    try {
      const result = await probe()
      if (result) return result
    } catch (cause) {
      error = cause
    }
    await delay(100)
  }
  throw new Error(message, { cause: error })
}

async function targets() {
  return (await fetch(endpoint, { signal: AbortSignal.timeout(2000) })).json()
}

function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Electron 응답이 없습니다. ${method}`))
    }, 4000)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      if (reply.error) reject(new Error(reply.error.message))
      else resolve(reply.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

async function launch() {
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true })
  child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, DRAMA_FLOW_DEV_USER_DATA_DIR: profile, DRAMA_FLOW_STARTUP_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !windows
  })
  exited = new Promise((resolve) => child.once('close', resolve))
  child.once('error', (error) => { output += error.message })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk.toString() })
  const port = await until(async () => (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
    'Electron 디버깅 포트를 열지 못했습니다.')
  endpoint = `http://127.0.0.1:${port}/json/list`
  const page = await until(async () => (await targets()).find((target) => target.type === 'page' && /^(aicut-app|http):/.test(target.url)),
    'Electron 첫 화면을 찾지 못했습니다.')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) })
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method === 'Runtime.exceptionThrown') {
      rendererErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    }
  })
  await send('Runtime.enable')
}

async function stop() {
  socket?.close()
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
  child = undefined
  socket = undefined
}

try {
  assert.ok(packagedExecutable || process.env.npm_execpath, 'npm run test:electron-start로 실행해야 합니다.')
  await mkdir(profile)
  await mkdir(projects)
  await writeFile(path.join(profile, 'storage-root.json'), JSON.stringify({ root: projects }))
  await writeFile(path.join(projects, 'settings.json'), JSON.stringify(settings))
  await launch()
  await until(() => evaluate(`window.desktop?.isDesktop && (${config})?.llm.apiKey === 'test-key'
    && document.querySelector('a[href^="https://github.com/"]') !== null`), '기존 설정으로 첫 화면을 열지 못했습니다.')
  assert.equal(await evaluate(`(${config}).activeLlmId`), 'fixture')
  assert.equal(await evaluate(`(${config}).music.apiKey`), 'test-music-key')

  const initialPages = (await targets()).filter(({ type }) => type === 'page').map(({ id }) => id).sort()
  const initialUrl = await evaluate('location.href')
  assert.equal(await evaluate("window.open('about:blank', '_blank') === null"), true)
  await evaluate(`(() => {
    const link = document.createElement('a')
    link.href = 'data:text/plain,blocked'
    document.body.append(link)
    link.click()
    link.remove()
  })()`)
  await delay(250)
  assert.equal(await evaluate('location.href'), initialUrl)
  assert.equal(await evaluate('window.desktop?.isDesktop'), true)
  assert.deepEqual((await targets()).filter(({ type }) => type === 'page').map(({ id }) => id).sort(), initialPages)

  const ttsError = await evaluate("window.desktop.openAiTts({ requestId: 'smoke' })")
  assert.deepEqual(ttsError, { kind: 'keyRequired' })
  const savedFields = `[ (${config}).llm.apiKey, (${config}).activeLlmId, (${config}).music.apiKey,
    (${config}).video.apiKey, (${config}).activeVideoId, (${config}).image.drawThingsSharedSecret,
    (${config}).activeImageId, (${config}).autodlToken ]`
  const expectedFields = ['test-key', 'fixture', 'test-music-key', 'test-pairing-token', 'ltx-local',
    'test-shared-secret', 'draw', 'test-autodl-token']
  await until(() => evaluate(`(() => {
    const mirror = JSON.parse(localStorage.getItem('ai-cut:settings') || '{}')
    return mirror.activeLlmId === 'fixture' &&
      !JSON.stringify(mirror).match(/"(?:apiKey|autodlToken|drawThingsSharedSecret|encryptedElevenLabsKey|headers)"/)
  })()`), '설정 미러에 비밀 필드가 남아 있습니다.')
  assert.deepEqual(await evaluate(savedFields), expectedFields)
  const grpc = await evaluate("window.desktop.drawThingsRequest({ kind: 'check', baseUrl: 'grpc://127.0.0.1:1' })")
  assert.equal(grpc.kind, 'offline')

  await stop()
  await launch()
  await until(() => evaluate(`(${config}).llm.apiKey === 'test-key'`), '암호화한 설정을 다시 읽지 못했습니다.')
  assert.deepEqual(await evaluate(savedFields), expectedFields)
  await stop()

  const db = new DatabaseSync(path.join(projects, 'app.db'))
  try {
    const { value } = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get()
    assert.equal(JSON.parse(value).schemaVersion, 1)
    assert.doesNotMatch(value, /test-key|test-music-key|test-pairing-token|test-shared-secret|test-autodl-token/)
    db.prepare("UPDATE kv SET value = ? WHERE key = 'settings'").run(damaged)
  } finally {
    db.close()
  }
  await launch()
  await until(() => evaluate("document.querySelector('.toast.kind-warning')?.textContent.includes('백업을 만들었습니다')"),
    '손상된 설정의 백업 알림이 표시되지 않았습니다.')
  assert.deepEqual(await evaluate(`[ (${config}).llm.apiKey, (${config}).activeLlmId, (${config}).music.apiKey ]`),
    ['test-key', 'fixture', 'test-music-key'])
  assert.equal(await evaluate(`(${config}).music.models.includes('music-3.0')`), false)
  const backups = (await readdir(projects)).filter((file) => /^settings\.broken-.*\.json$/.test(file))
  assert.equal(backups.length, 1)
  assert.equal(JSON.parse(await readFile(path.join(projects, backups[0]), 'utf8')).schemaVersion, 1)
  await evaluate("window.dispatchEvent(new Event('beforeunload'))")
  assert.equal(await evaluate("window.desktop.kvGet('settings')"), damaged)
  assert.equal(JSON.parse(await readFile(path.join(projects, 'settings.json'), 'utf8')).schemaVersion, 1)

  if (verifyFallback) {
    await stop()
    const preference = path.join(profile, 'storage-root.json')
    const unavailable = JSON.stringify({ root: path.join(fixture, 'unavailable') })
    await writeFile(preference, unavailable)
    await launch()
    await until(() => evaluate(`Boolean((${config}) && document.querySelector('.app-root'))`),
      '저장 폴더 없이 첫 화면을 열지 못했습니다.')
    await until(() => evaluate("document.querySelector('.storage-recovery')?.textContent.includes('기존 저장 폴더 설정은 보존했습니다')"),
      '복구 안내를 찾지 못했습니다.')
    assert.equal(await evaluate("document.querySelector('.storage-recovery button:last-child')?.textContent.trim()"), '저장 폴더 다시 선택')
    await evaluate("document.querySelector('.storage-recovery button').click()")
    assert.equal(await evaluate("document.querySelector('.storage-recovery')"), null)
    assert.equal(await realpath(await evaluate('window.desktop.getRoot()')), await realpath(path.join(profile, 'Recovery')))
    assert.equal(await readFile(preference, 'utf8'), unavailable)
    assert.match(output, /저장 폴더를 열지 못했습니다/)
    console.log('저장 폴더가 없어도 첫 화면을 열고 기존 저장 폴더 설정을 보존했습니다.')
  }

  assert.deepEqual(rendererErrors, [])
  assert.doesNotMatch(output, /Uncaught Exception|startup failed|Unable to load preload script/i)
  console.log(`${packagedExecutable ? '패키징된' : '개발 모드'} Electron 앱에서 첫 화면, 저장된 연결, 팝업 차단, 설정 복구를 확인했습니다.`)
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 })
}
