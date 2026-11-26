import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'

const server = await createServer({
  configFile: false,
  envFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  server: { middlewareMode: true, hmr: false }
})
after(() => server.close())

const { requestLtx } = await server.ssrLoadModule('/electron/ltx.ts')
const { ltxRequestBody, pollLtxJob } = await server.ssrLoadModule('/src/services/ai/ltxJob.ts')
const { ltxDuration, ltxDurationOptions, ltxCost } = await server.ssrLoadModule('/src/services/ai/ltxOptions.ts')
const { generateVideo } = await server.ssrLoadModule('/src/services/ai/video.ts')
const { useSettingsStore } = await server.ssrLoadModule('/src/stores/settings.ts')
const { saveAsset, setActiveProjectDir } = await server.ssrLoadModule('/src/services/storage/fs.ts')

const image = 'data:image/png;base64,aGVsbG8='
const resultUrl = 'https://storage.googleapis.com/video.mp4'
const body = ltxRequestBody({
  first: image, last: image, prompt: ' Run forward. ', model: 'ltx-2-3-fast',
  duration: 6, resolution: '1080p', portrait: true, audio: false
})

test('문서의 가로·세로 해상도와 초 단가로 요청을 구성합니다', async () => {
  assert.deepEqual(body, {
    image_uri: image, last_frame_uri: image, prompt: 'Run forward.', model: 'ltx-2-3-fast',
    duration: 6, resolution: '1080x1920', fps: 24, generate_audio: false
  })
  assert.deepEqual(ltxDurationOptions('ltx-2-5-pro'), [6, 8, 10])
  assert.equal(ltxCost('ltx-2-3-fast', '1080p', 6), '0.36')
  let calls = 0
  const fetcher = async (url, options) => {
    calls++
    assert.equal(url, 'https://api.ltx.io/v2/image-to-video')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer fake')
    assert.deepEqual(JSON.parse(options.body), body)
    return Response.json({ id: 'job123' }, { status: 202 })
  }
  assert.deepEqual(await requestLtx(fetcher, { apiKey: 'fake', body }), { kind: 'submitted', id: 'job123' })
  assert.deepEqual(await requestLtx(fetcher, { apiKey: 'fake', body: { ...body, duration: 7 } }), { kind: 'invalid' })
  assert.equal(calls, 1)
})

test('조회 응답을 해석하고 원격 오류에서 민감한 원문을 전달하지 않습니다', async () => {
  const fixtures = [
    [Response.json({ status: 'pending' }), { kind: 'pending' }],
    [Response.json({ status: 'processing' }), { kind: 'processing' }],
    [Response.json({ status: 'completed', result: { video_url: resultUrl } }), { kind: 'completed', url: resultUrl }],
    [Response.json({ status: 'failed', error: { type: 'insufficient_funds_error', message: 'secret' } }),
      { kind: 'failed', reason: 'funds' }],
    [new Response(null, { status: 429, headers: { 'Retry-After': '22' } }),
      { kind: 'http', status: 429, retryAfterMs: 22000 }]
  ]
  for (const [response, expected] of fixtures) {
    const reply = await requestLtx(async (url, options) => {
      assert.equal(url, 'https://api.ltx.io/v2/image-to-video/job123')
      assert.equal(options.method, 'GET')
      assert.equal(options.body, undefined)
      return response
    }, { apiKey: 'fake', jobId: 'job123' })
    assert.deepEqual(reply, expected)
  }
})

test('일시 오류에서 대기하고 다운로드 실패 뒤 서명 URL을 다시 조회합니다', async () => {
  const replies = [
    { kind: 'http', status: 429, retryAfterMs: 22000 },
    { kind: 'pending' },
    { kind: 'processing' },
    { kind: 'completed', url: resultUrl + '?old' },
    { kind: 'completed', url: resultUrl + '?fresh' }
  ]
  const delays = []
  const states = []
  const urls = []
  const result = await pollLtxJob({
    status: async () => replies.shift(),
    download: async (url) => {
      urls.push(url)
      if (url.endsWith('?old')) throw new Error('expired')
      return 'video'
    },
    wait: async (ms) => delays.push(ms),
    progress: (state) => states.push(state),
    failure: () => assert.fail('unexpected failure'),
    timeout: () => assert.fail('unexpected timeout')
  })
  assert.equal(result, 'video')
  assert.equal(delays[1], 22000)
  assert.ok(delays.every((ms) => ms >= 5000))
  assert.deepEqual(states, ['pending', 'processing', 'downloading', 'downloading'])
  assert.deepEqual(urls, [resultUrl + '?old', resultUrl + '?fresh'])
})

test('저장한 작업 ID로 재조회하고 다운로드한 MP4를 프로젝트 에셋 경로에 기록합니다', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.get('path'), '/tmp/result.mp4')
    return new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } })
  })
  const keys = new Map()
  const files = new Map()
  const controller = new AbortController()
  let savedTaskId
  let submissions = 0
  const bytes = new Uint8Array(2048)
  bytes.set([102, 116, 121, 112], 4)
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.window = {
    addEventListener() {},
    desktop: {
      isDesktop: true,
      async ltxRequest(request) {
        if ('body' in request) {
          submissions++
          assert.equal(request.body.resolution, '1280x720')
          assert.equal(request.body.image_uri, image)
          controller.abort()
          return { kind: 'submitted', id: 'job123' }
        }
        assert.equal(request.apiKey, 'fake')
        assert.equal(request.jobId, 'job123')
        return { kind: 'completed', url: resultUrl }
      },
      async downloadToTemp(url) {
        assert.equal(url, resultUrl)
        files.set('/tmp/result.mp4', bytes.buffer)
        return '/tmp/result.mp4'
      },
      async readBuffer(path) { return files.get(path) },
      async remove(path) { files.delete(path) },
      async getRoot() { return '/store' },
      async ensureProjectDir() { return '/store/project' },
      async writeBuffer(path, buffer) { files.set(path, buffer) },
      async exists(path) { return files.has(path) },
      async writeText(path, text) { files.set(path, text) },
      async join(...parts) { return parts.join('/') },
      async kvGet(key) { return keys.get(key) ?? null },
      async kvSet(key, value) { keys.set(key, value) },
      async dbPath() { return '/store/app.db' }
    }
  }
  globalThis.document = { addEventListener() {} }
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = image
      this.onload()
    }
  }
  context.after(() => {
    delete globalThis.window
    delete globalThis.document
    delete globalThis.FileReader
    setActiveProjectDir(null)
  })
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  await settings.ensureHydrated()
  const profileId = settings.addVideo({
    name: 'LTX', provider: 'ltx', workflowId: 'ltx-2-3-fast', baseUrl: 'https://api.ltx.io', apiKey: 'fake'
  })
  await assert.rejects(generateVideo({
    prompt: 'Run forward.', duration: 6, width: 1280, height: 720,
    imageBlob: new Blob(['test'], { type: 'image/png' }),
    videoProfileId: profileId, signal: controller.signal,
    async onTaskSubmitted(id) { savedTaskId = id }
  }), { name: 'AbortError' })
  assert.equal(savedTaskId, 'ltx:job123')
  const pending = generateVideo({
    prompt: '', duration: 6, width: 1280, height: 720,
    videoProfileId: profileId, resumeTaskId: savedTaskId,
    onTaskSubmitted() { assert.fail('already submitted') }
  })
  context.mock.timers.tick(6000)
  const output = await pending
  assert.equal(output.mimeType, 'video/mp4')
  assert.equal(submissions, 1)
  assert.equal(files.has('/tmp/result.mp4'), false)
  setActiveProjectDir('/store/project')
  await saveAsset({
    id: 'video_fixture', kind: 'video', source: 'ai-generated', mimeType: 'video/mp4',
    filename: 'fixture.mp4', projectId: 'project', size: bytes.length, createdAt: Date.now()
  }, output.blob)
  const saved = [...files].find(([path]) => path.endsWith('/video_fixture.mp4'))
  assert.ok(saved)
  assert.deepEqual(new Uint8Array(saved[1]), bytes)
})

test('기본 12초는 LAN 로컬 모델과 클라우드 Pro에서 10초로 매핑합니다', () => {
  for (const model of ['ltx-2.3-fast', 'ltx-2.5-fast', 'ltx-2-3-pro', 'ltx-2-5-pro']) {
    assert.equal(ltxDuration(12, model), 10)
  }
  assert.equal(ltxDuration(12, 'ltx-2-3-fast'), 12)
})
