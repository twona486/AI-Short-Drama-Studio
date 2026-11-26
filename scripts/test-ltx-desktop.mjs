import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
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
  let startSlow
  let closeSlow
  const slowStarted = new Promise((resolve) => { startSlow = resolve })
  const slowClosed = new Promise((resolve) => { closeSlow = resolve })
  const slowPath = signedPath.replace('clip-1', 'slow')
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
      if (req.url === '/api/generations/malformed') return res.end('<html>Invalid response</html>')
      if (req.url === slowPath) {
        res.on('close', closeSlow)
        res.writeHead(200, { 'Content-Type': 'video/mp4' })
        res.write(mp4)
        startSlow()
        return
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
  try {
    assert.deepEqual(await readFile(download.path), mp4)
  } finally {
    await rm(download.path, { force: true })
  }
  const malformed = await call({ kind: 'status', id: 'malformed' })
  assert.deepEqual(malformed, { kind: 'invalidResponse' })
  assert.equal(ltxDesktopError(malformed), 'ltxDesktop.invalidResponse')
  const controller = new AbortController()
  const slow = requestLtxDesktop({ baseUrl, hostOverride: 'localhost:41955', token,
    operation: { kind: 'download', path: slowPath } }, controller.signal)
  await slowStarted
  controller.abort()
  await assert.rejects(slow, { name: 'AbortError' })
  await slowClosed
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
  const removed = []
  context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.get('path'), '/tmp/fixture.mp4')
    return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } })
  })
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
          if (calls.length === 1) return { kind: 'offline' }
          if (calls.length === 2) return { kind: 'http', status: 503 }
          const path = calls.length === 3 ? signedPath : signedPath.replace('exp=123', 'exp=456')
          return { kind: 'completed', path }
        }
        if (operation.path === signedPath) return { kind: 'http', status: 403 }
        return { kind: 'video', path: '/tmp/fixture.mp4' }
      },
      async remove(path) { removed.push(path) },
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
  for (const delay of [3000, 6000, 12000, 24000]) {
    context.mock.timers.tick(delay - 1)
    await setImmediate()
    const count = calls.length
    context.mock.timers.tick(1)
    await setImmediate()
    assert.ok(calls.length > count)
  }
  const result = await pending
  assert.deepEqual(calls, [
    { kind: 'status', id: 'job-1' }, { kind: 'status', id: 'job-1' },
    { kind: 'status', id: 'job-1' }, { kind: 'download', path: signedPath },
    { kind: 'status', id: 'job-1' }, { kind: 'download', path: signedPath.replace('exp=123', 'exp=456') }
  ])
  assert.deepEqual(removed, ['/tmp/fixture.mp4'])
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


test('한국어 립싱크의 단일 화자, WAV, Remote 계약, 재조회, 후반 작업 중복 방지를 검증합니다', async (context) => {
  const { pcmToWav } = await vite.ssrLoadModule('/electron/openai-tts.ts')
  const { generateShotVideo, generateShotAudio } = await vite.ssrLoadModule('/src/services/canvas/runner.ts')
  const { useProjectStore } = await vite.ssrLoadModule('/src/stores/project.ts')
  const { useAssetsStore } = await vite.ssrLoadModule('/src/stores/assets.ts')
  const { needsExternalTts, shotPlaybackDuration } = await vite.ssrLoadModule('/src/utils/shot.ts')
  const { buildTimelineFromShots, buildTimelineCaptionCues, clipAudioSelection, clipCaptionDuration, clipLipSyncDuration } = await vite.ssrLoadModule('/src/utils/timeline.ts')
  const { toSRT } = await vite.ssrLoadModule('/src/services/ffmpeg/subtitle.ts')
  const { joinLipSyncWavs } = await vite.ssrLoadModule('/src/services/ai/lipSyncWav.ts')

  const requests = []
  const submitted = []
  const uploaded = []
  let supportsAudio = true
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    const json = (response) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(response))
    }
    if (req.url === signedPath) return res.end(mp4)
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401
      return json({})
    }
    if (req.url === '/api/generate/models-specs') {
      return json({ downloaded_local_models: [{ model: 'ltx-2.5-fast', spec: {
        capabilities: { a2v: supportsAudio },
        aspect_specs: { '16:9': {
          a2v_supported_resolutions_durations: {
            '540p': { fps_to_durations: { 24: [2, 20] } },
            '1080p': { fps_to_durations: { 24: [2, 10] } }
          }
        } }
      } }] })
    }
    if (req.url === '/api/assets/upload') {
      const name = bytes.toString().match(/filename="([^"]+)"/)?.[1]
      const bodyStart = bytes.indexOf('\r\n\r\n') + 4
      const boundary = req.headers['content-type']?.split('boundary=')[1]
      if (!boundary || !name) { res.statusCode = 422; return json({}) }
      const body = bytes.subarray(bodyStart, bytes.lastIndexOf(`\r\n--${boundary}--`))
      uploaded.push({ name, body })
      const kind = name === 'dialogue.wav' ? 'audio' : 'image'
      return json({ id: kind, media_kind: kind })
    }
    if (req.url === '/api/generations/audio-to-video') {
      const body = JSON.parse(bytes)
      submitted.push(body)
      const { params, inputs } = body
      if (body.contract_version !== 1 || Object.keys(body).sort().join() !== 'contract_version,inputs,params' ||
          Object.keys(params).sort().join() !== 'aspectRatio,fps,model,prompt,resolution' ||
          params.model !== 'ltx-2.5-fast' || params.fps !== 24 || params.aspectRatio !== '16:9' || params.resolution !== '540p' ||
          Object.keys(inputs).sort().join() !== 'audio,startFrame' || inputs.audio.assetId !== 'audio' ||
          inputs.startFrame?.assetId !== 'image') {
        res.statusCode = 422
        return json({})
      }
      return json({ id: 'lip-job' })
    }
    if (req.url === '/api/generations/lip-job') {
      return json({ id: 'lip-job', status: 'succeeded', outputs: [{ media_kind: 'video', mime_type: 'video/mp4', bytes_url: signedPath }] })
    }
    res.statusCode = 404
    return json({})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const realFetch = globalThis.fetch
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!String(url).startsWith('aicuts://')) return realFetch(url, init)
    const file = new URL(url).searchParams.get('path')
    return new Response(await readFile(file), { headers: { 'Content-Type': 'video/mp4' } })
  })
  const generated = []
  let speechSamples = 55_200
  let frameReads = 0
  globalThis.window = {
    addEventListener() {},
    desktop: {
      isDesktop: true,
      ltxDesktopRequest(request) {
        requests.push(request.operation)
        return requestLtxDesktop(request)
      },
      async kvGet() { return '{}' },
      async kvSet() {},
      async remove(path) { await rm(path, { force: true }) },
      async openAiTts({ text, voice }) {
        generated.push({ text, voice })
        return pcmToWav(Buffer.alloc(speechSamples * 2, voice === 'marin' ? 1 : 2))
      }
    }
  }
  globalThis.document = { addEventListener() {} }
  globalThis.FileReader = class {
    async readAsDataURL(blob) {
      this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`
      this.onload()
    }
  }
  context.after(() => {
    delete globalThis.window
    delete globalThis.document
    delete globalThis.FileReader
  })
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  const profileId = settings.addVideo({
    name: 'LTX Desktop', provider: 'ltx-desktop', baseUrl, apiKey: token, workflowId: 'ltx-2.5-fast'
  })
  settings.addTts({
    name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: token,
    model: 'gpt-realtime-2.1-mini', models: ['gpt-realtime-2.1-mini']
  })
  const project = useProjectStore()
  const store = useAssetsStore()
  context.mock.method(store, 'getBlob', async (id) => {
    assert.equal(id, 'keyframe')
    frameReads++
    return new Blob(['hello'], { type: 'image/png' })
  })
  context.mock.method(store, 'add', async (blob, kind) => {
    assert.equal(kind, 'video')
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), mp4)
    return { id: 'lip-video', kind }
  })
  const persisted = []
  context.mock.method(project, 'save', async () => {
    const shot = project.current.shots[0]
    persisted.push({ id: shot.videoTaskId, duration: shot.lipSyncTask?.duration })
  })
  const shot = {
    id: 'shot1', index: 0, title: '인사', duration: 6, cameraMovement: 'push',
    audioMode: 'h3-dialogue', voiceover: 'Minji: 안녕하세요. Jungwoo: 네, 반가워요.',
    visualPrompt: 'Two actors stand silent in a wide shot.', compiledVideoPrompt: 'Beat 1 (0–4s): No speech. Minji keeps her mouth closed.',
    firstFrameAssetId: 'keyframe',
    imageAssetId: 'keyframe', videoProfileId: profileId
  }
  project.current = {
    id: 'project', shots: [shot], canvas: undefined,
    subjects: [
      { id: 'minji', name: 'Minji', description: 'Short hair and a blue jacket. She stays silent.', openAiTtsVoice: 'marin' },
      { id: 'jungwoo', name: 'Jungwoo', openAiTtsVoice: 'cedar' }
    ],
    settings: { aspectRatio: '16:9', ttsVoice: 'marin' }, timeline: []
  }
  project.current.timeline = buildTimelineFromShots(project.current)
  project.current.captionSrt = toSRT(buildTimelineCaptionCues(project.current))
  assert.equal(await project.checkShotLipSync(shot), true)
  assert.equal(project.shotSupportsLipSync(shot), true)
  project.setShotAudioMode(shot.id, 'ltx-lip-sync')
  assert.equal(needsExternalTts(project.current.shots[0], project.current), false)
  await assert.rejects(generateShotAudio(project.current.shots[0]), /별도의 더빙/)
  assert.deepEqual(generated, [])
  requests.length = 0
  await assert.rejects(generateShotVideo(shot), /한 명의 화자/)
  assert.deepEqual(requests, [])
  assert.deepEqual(generated, [])
  project.updateShot(shot.id, { videoTaskId: 'ltx-desktop:previous-i2v' })
  await assert.rejects(generateShotVideo(shot), /이전 영상 작업/)
  assert.deepEqual(requests, [])
  project.updateShot(shot.id, { videoTaskId: undefined, voiceover: 'Minji: 안녕하세요.\nMinji: 반가워요.' })
  project.current.captionSrt = toSRT(buildTimelineCaptionCues(project.current))
  const result = await generateShotVideo(shot)
  assert.equal(result.id, 'lip-video')
  assert.deepEqual(generated, [{ text: '안녕하세요.\n반가워요.', voice: 'marin' }])
  assert.deepEqual(uploaded.map(({ name }) => name), ['dialogue.wav', 'frame.png'])
  assert.equal(uploaded[1].body.toString(), 'hello')
  const wav = uploaded[0].body
  assert.equal(wav.readUInt32LE(24), 24_000)
  assert.equal(wav.readUInt32LE(40), 116_000)
  const pcm = wav.subarray(44)
  assert.deepEqual(pcm, Buffer.concat([
    Buffer.alloc(110_400, 1), Buffer.alloc(5_600)
  ]))
  for (const samples of [48_000, 49_000, 49_001, 55_200, 57_000, 72_000]) {
    const source = Uint8Array.from(pcmToWav(Buffer.alloc(samples * 2, 1)).wav).buffer
    const { duration, uploadDuration } = joinLipSyncWavs([source])
    const generatedFrames = Math.floor((Math.floor(uploadDuration * 24) - 1) / 8) * 8 + 1
    assert.equal(duration, samples / 24_000)
    assert.ok(generatedFrames / 24 >= duration)
    assert.ok(uploadDuration - duration <= 0.4)
  }
  assert.match(submitted[0].params.prompt, /Minji \(Short hair and a blue jacket\) looks at the camera and speaks/)
  assert.doesNotMatch(submitted[0].params.prompt, /beat|silent|no speech|mouth closed|wide shot/i)
  assert.equal(requests.filter(({ kind }) => kind === 'submitAudio').length, 1)
  assert.equal(requests.filter(({ kind }) => kind === 'submit').length, 0)
  assert.doesNotMatch(submitted[0].params.prompt, /[가-힣\n]/)
  assert.deepEqual(persisted, [{ id: 'ltx-desktop:lip-job', duration: 2.3 }, { id: undefined, duration: undefined }])
  assert.equal(shotPlaybackDuration(project.current.shots[0]), 2.3)
  assert.equal(project.current.shots[0].duration, 6)
  assert.equal(project.current.timeline[0].duration, 2.3)
  assert.match(project.current.captionSrt, /00:00:02,300/)
  assert.deepEqual(clipAudioSelection(project.current, { ...project.current.timeline[0], voiceAssetId: 'old-dub' }, false), {
    keepSource: true, embeddedLipSync: true, voiceAssetId: undefined
  })
  assert.equal(clipCaptionDuration(project.current, { ...project.current.timeline[0], duration: 6 }), 2.3)
  assert.equal(clipLipSyncDuration(project.current, { ...project.current.timeline[0], assetId: 'older-video' }), undefined)
  project.setShotAudioMode(shot.id, 'tts')
  assert.equal(needsExternalTts(project.current.shots[0], project.current), false)

  project.updateShot(shot.id, { videoTaskId: 'ltx-desktop:lip-job', lipSyncTask: { id: 'ltx-desktop:lip-job', duration: 2.3 } })
  requests.length = 0
  await generateShotVideo(project.current.shots[0])
  assert.deepEqual(requests.map(({ kind }) => kind), ['status', 'download'])
  assert.equal(generated.length, 1)
  assert.equal(frameReads, 1)

  project.setShotAudioMode(shot.id, 'ltx-lip-sync')
  speechSamples = 24_000 * 21
  await assert.rejects(generateShotVideo(project.current.shots[0]), /최대 20초를 초과합니다.*대사를 여러 샷으로/)
  project.current.settings.defaultVideoResolution = '1080p'
  await assert.rejects(generateShotVideo(project.current.shots[0]), /최대 10초를 초과합니다/)
  speechSamples = 237_600
  await assert.rejects(generateShotVideo(project.current.shots[0]), /무음을 넣으면 립싱크 최대 10초를 초과합니다/)
  assert.equal(submitted.length, 1)
  supportsAudio = false
  assert.equal(await project.checkShotLipSync(project.current.shots[0]), false)
  assert.equal(project.shotSupportsLipSync(project.current.shots[0]), false)
  await assert.rejects(generateShotVideo(project.current.shots[0]), /Audio to Video/)
  assert.equal(generated.length, 4)
})
