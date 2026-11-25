import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  envFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const { requestLtxDesktop, desktopOrigin, desktopHostHeader } = await vite.ssrLoadModule('/electron/ltx-desktop.ts')
const { generateVideo } = await vite.ssrLoadModule('/src/services/ai/video.ts')
const { useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')
const { saveAsset, setActiveProjectDir } = await vite.ssrLoadModule('/src/services/storage/fs.ts')
const { ltxDesktopError } = await vite.ssrLoadModule('/src/services/ai/ltxDesktopOptions.ts')

const token = 'fixture-device-session'
const image = 'data:image/png;base64,aGVsbG8='
const signedPath = '/api/assets/clip-1/bytes?exp=123&did=d1&sig=fixture'
const mp4 = Buffer.alloc(2048)
mp4.write('ftyp', 4)

test('사설망과 Tailscale의 주소 및 기본 Host를 검증합니다', async () => {
  assert.equal(desktopOrigin('studio.local:21955').origin, 'http://studio.local:21955')
  const magic = desktopOrigin('studio.tailnet.ts.net:21955')
  assert.equal(magic.origin, 'http://studio.tailnet.ts.net:21955')
  assert.equal(desktopHostHeader(magic, '100.127.1.2'), 'localhost:21955')
  const tailnet = desktopOrigin('100.64.0.1')
  assert.equal(desktopHostHeader(tailnet, '100.64.0.1'), 'localhost:41955')
  assert.equal(desktopHostHeader(tailnet, '100.64.0.1', '192.168.20.4:41955'), '192.168.20.4:41955')
  for (const ip of ['100.64.0.1', '100.127.255.254', '10.2.3.4', '172.16.2.4', '172.31.9.9', '192.168.1.4', '127.0.0.1']) {
    assert.equal(desktopOrigin(ip).origin, `http://${ip}:41955`)
  }
  for (const baseUrl of [
    '8.8.8.8:41955', '100.63.255.255', '100.128.0.0', '172.32.0.1:41955', 'example.com:41955', 'http://studio.local@8.8.8.8:41955',
    'http://192.168.1.4:41955/api', 'http://192.168.1.4:41955/?t=secret'
  ]) {
    assert.deepEqual(await requestLtxDesktop({ baseUrl, operation: { kind: 'check' }, token }), { kind: 'unsafeAddress' })
  }
})

test('페어링, 파일 업로드, 대기열, 진행률, 서명 MP4, 취소, 미실행 오류를 모의 서버로 확인합니다', async (context) => {
  let status = 'queued'
  let assets = 0
  const calls = []
  const server = http.createServer(async (req, res) => {
    try {
      calls.push(req.url)
      assert.equal(req.headers.host, 'localhost:41955')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const json = (object) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(object))
      }
      if (req.url === '/api/pairing/exchange') {
        assert.deepEqual(JSON.parse(bytes), { code: 'grant' })
        return json({ token, device_id: 'd1' })
      }
      if (req.url === signedPath) {
        assert.equal(req.headers.authorization, undefined)
        res.setHeader('Content-Type', 'video/mp4')
        return res.end(mp4)
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401
        return json({})
      }
      if (req.url === '/api/session') return json({ status: 'ok' })
      if (req.url === '/api/generate/models-specs') {
        return json({
          active_offering: 'ltx-2.5-fast',
          downloaded_local_models: [{
            model: 'ltx-2.5-fast',
            spec: { supported_resolutions_durations: { '720p': { fps_to_durations: { 24: [5, 6] } } } }
          }]
        })
      }
      if (req.url === '/api/assets/upload') {
        assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/)
        assert.match(bytes.toString(), /name="file"; filename="frame.png"/)
        assert.match(bytes.toString(), /Content-Type: image\/png\r\n\r\nhello/)
        return json({ id: `asset-${++assets}` })
      }
      if (req.url === '/api/generations/image-to-video') {
        assert.deepEqual(JSON.parse(bytes), {
          contract_version: 1,
          params: { model: 'ltx-2.5-fast', prompt: 'Move.', aspectRatio: '9:16', duration: 5, resolution: '720p', fps: 24 },
          inputs: { startFrame: { assetId: 'asset-1' }, endFrame: { assetId: 'asset-2' } }
        })
        return json({ id: 'job-1', status })
      }
      if (req.url === '/api/generation-queue') {
        return json({ active: [
          { generation: { id: 'other' }, progress: { progress: 81 } },
          { generation: { id: 'job-1' }, progress: { progress: 24, remainingSeconds: 35 } }
        ] })
      }
      if (req.url === '/api/generations/job-1/cancel') {
        assert.equal(req.method, 'POST')
        status = 'cancelled'
      }
      return json({ id: 'job-1', status, outputs: [{ media_kind: 'video', mime_type: 'video/mp4', bytes_url: signedPath }] })
    } catch (error) {
      res.statusCode = 500
      res.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = (operation, session = token) => requestLtxDesktop({ baseUrl, hostOverride: 'localhost:41955', token: session, operation })
  assert.deepEqual(await call({ kind: 'pair', code: baseUrl + '/pairing?t=grant' }, ''), { kind: 'paired', token })
  assert.deepEqual(await call({ kind: 'pair', code: 'http://192.168.1.11:14141/pairing?t=grant' }, ''), { kind: 'paired', token })
  assert.deepEqual(await requestLtxDesktop({
    baseUrl, hostOverride: 'localhost:41955\r\nBad: value', token, operation: { kind: 'check' }
  }), { kind: 'invalidHostOverride' })
  assert.deepEqual(await call({ kind: 'check' }), { kind: 'ready' })
  const denied = await call({ kind: 'check' }, 'revoked')
  assert.equal(ltxDesktopError(denied), 'ltxDesktop.unpaired')
  const submit = { kind: 'submit', first: image, last: image, model: 'ltx-2.5-fast', prompt: 'Move.', aspect: '9:16', duration: 5, resolution: '720p' }
  assert.deepEqual(await call({ ...submit, duration: 8 }), { kind: 'unsupported' })
  assert.deepEqual(await call(submit), { kind: 'submitted', id: 'job-1' })
  assert.deepEqual(await call({ kind: 'status', id: 'job-1' }), { kind: 'pending' })
  status = 'running'
  assert.deepEqual(await call({ kind: 'status', id: 'job-1' }), { kind: 'processing', percent: 24, remainingSeconds: 35 })
  status = 'succeeded'
  assert.deepEqual(await call({ kind: 'status', id: 'job-1' }), { kind: 'completed', path: signedPath })
  const download = await call({ kind: 'download', path: signedPath })
  assert.equal(download.kind, 'video')
  assert.deepEqual(Buffer.from(download.data), mp4)
  assert.deepEqual(await call({ kind: 'download', path: 'http://192.168.1.2/a.mp4' }), { kind: 'invalid' })
  assert.deepEqual(await call({ kind: 'cancel', id: 'job-1' }), { kind: 'failed', code: 'cancelled' })
  assert.equal(calls.filter((url) => url === '/api/assets/upload').length, 2)
  await new Promise((resolve) => server.close(resolve))
  const offline = await call({ kind: 'check' })
  assert.deepEqual(offline, { kind: 'offline' })
  assert.equal(ltxDesktopError(offline), 'ltxDesktop.offline')
})

test('저장된 LAN 작업 ID로 결과만 받아 프로젝트 MP4 경로에 기록합니다', async (context) => {
  const files = new Map()
  const calls = []
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.document = { addEventListener() {} }
  globalThis.window = {
    addEventListener() {},
    desktop: {
      isDesktop: true,
      async ltxDesktopRequest({ operation, baseUrl, hostOverride }) {
        assert.equal(hostOverride, 'localhost:41955')
        assert.equal(baseUrl, 'studio.local:41955')
        calls.push(operation)
        if (operation.kind === 'status') {
          const path = calls.length === 1 ? signedPath : signedPath.replace('exp=123', 'exp=456')
          return { kind: 'completed', path }
        }
        if (operation.path === signedPath) return { kind: 'http', status: 403 }
        return { kind: 'video', data: Uint8Array.from(mp4).buffer }
      },
      async exists(path) { return files.has(path) },
      async writeText(path, data) { files.set(path, data) },
      async writeBuffer(path, data) { files.set(path, data) },
      async join(...parts) { return parts.join('/') },
      async kvGet() { return '{}' },
      async kvSet() {},
      async dbPath() { return '/project/app.db' }
    }
  }
  context.after(() => {
    delete globalThis.window
    delete globalThis.document
    setActiveProjectDir(null)
  })
  setActivePinia(createPinia())
  const profileId = useSettingsStore().addVideo({
    name: 'LTX Desktop', provider: 'ltx-desktop', apiKey: token,
    workflowId: 'ltx-2.3-fast', baseUrl: 'studio.local:41955'
  })
  useSettingsStore().patchVideo({ ltxHostOverride: 'localhost:41955' })
  const pending = generateVideo({
    prompt: '', duration: 5, width: 1280, height: 720,
    videoProfileId: profileId, resumeTaskId: 'ltx-desktop:job-1'
  })
  context.mock.timers.tick(3000)
  await setImmediate()
  context.mock.timers.tick(3000)
  const result = await pending
  assert.deepEqual(calls, [
    { kind: 'status', id: 'job-1' }, { kind: 'download', path: signedPath },
    { kind: 'status', id: 'job-1' }, { kind: 'download', path: signedPath.replace('exp=123', 'exp=456') }
  ])
  assert.equal(result.mimeType, 'video/mp4')
  setActiveProjectDir('/project')
  await saveAsset({
    id: 'clip', kind: 'video', source: 'ai-generated', mimeType: result.mimeType, filename: 'clip.mp4'
  }, result.blob)
  assert.deepEqual(Buffer.from(files.get('/project/assets/videos/clip.mp4')), mp4)
})

test('LAN 호스트를 변경하면 이전 호스트에 해당하는 페어링 세션을 지웁니다', (context) => {
  globalThis.window = { addEventListener() {} }
  globalThis.document = { addEventListener() {} }
  context.after(() => { delete globalThis.window; delete globalThis.document })
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  settings.addVideo({
    name: 'LTX Desktop', provider: 'ltx-desktop', apiKey: token,
    workflowId: 'ltx-2.3-fast', baseUrl: 'studio.local:41955'
  })
  settings.patchVideo({ workflowId: 'ltx-2.5-fast' })
  assert.equal(settings.config.video.apiKey, token)
  settings.patchVideo({ baseUrl: '192.168.20.4:41955' })
  assert.equal(settings.config.video.apiKey, '')
})
