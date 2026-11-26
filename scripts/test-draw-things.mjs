import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Server, ServerCredentials } from '@grpc/grpc-js'
import { ByteBuffer } from 'flatbuffers'
import protobuf from 'protobufjs'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

const { Reader, Writer } = protobuf
const windowEvents = { addEventListener() {}, removeEventListener() {} }
globalThis.window = { ...windowEvents }
globalThis.document = { ...windowEvents }
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} } })
const vite = await createServer({
  configFile: false, envFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const { createDrawThingsQueue } = await vite.ssrLoadModule('/electron/draw-things.ts')
const { lanOrigin, pinAddress } = await vite.ssrLoadModule('/electron/lan-origin.ts')
const {
  DRAW_THINGS_MODELS, DRAW_THINGS_PROVIDER, DRAW_THINGS_URL, drawThingsEditAlternative, drawThingsInputError, drawThingsPreset, drawThingsReferenceCapability, drawThingsSize
} = await vite.ssrLoadModule('/src/services/ai/drawThingsOptions.ts')
const { applyProviderPreset, IMAGE_PROVIDERS } = await vite.ssrLoadModule('/src/services/ai/providers.ts')
const { endpointReady, namedModelGroups, useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')
const { generateImage } = await vite.ssrLoadModule('/src/services/ai/image.ts')
const { generateVideo } = await vite.ssrLoadModule('/src/services/ai/video.ts')
const { refreshDrawThingsModels } = await vite.ssrLoadModule('/src/services/ai/drawThings.ts')
const { checkDrawThings } = await vite.ssrLoadModule('/src/services/ai/drawThingsConnection.ts')
const { observeMediaPrompts } = await vite.ssrLoadModule('/src/services/ai/mediaPromptObserver.ts')
const [qwen, edit, flux] = DRAW_THINGS_MODELS
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgSEAAAAASUVORK5CYII=', 'base64')
const job = (baseUrl, model, id = 'test', prompt = 'A rainy street.') => (
  { kind: 'generate', baseUrl, id, model, prompt, width: 1344, height: 768 }
)

test('한국어 장면 묘사는 영어로 보내고 대사와 간판 원문은 보존합니다', async (context) => {
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  settings.addLlm({
    name: 'Fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'mock-key',
    model: 'fixture-model', models: ['fixture-model']
  })
  settings.addImage({
    name: 'Draw Things', provider: DRAW_THINGS_PROVIDER, baseUrl: DRAW_THINGS_URL, model: flux, models: [flux]
  })
  const sent = []
  let sentVideo
  const observed = []
  let translations = 0
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    translations++
    const { messages } = JSON.parse(options.body)
    const original = messages.at(-1).content
    const markers = original.match(/DFS_MEDIA_LITERAL_\d+_END/g) || []
    const content = markers.length
      ? `An empty rural railway platform at dawn. A sign reads ${markers[0]}.${markers[1] ? ` A narrator says in Korean: ${markers[1]}.` : ''}`
      : translations === 1 ? 'An empty rural railway platform at dawn.' : '영어로 옮기지 않은 설명'
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
  })
  globalThis.window.desktop = {
    isDesktop: true,
    async kvSet() {},
    onDrawThingsProgress: () => () => {},
    async ltxDesktopRequest({ operation }) {
      sentVideo = operation
      return { kind: 'http', status: 422 }
    },
    async drawThingsRequest(request) {
      sent.push(request)
      return { kind: 'image', data: Uint8Array.from(png).buffer, mimeType: 'image/png' }
    }
  }
  context.after(() => { delete globalThis.window.desktop })
  const signal = observeMediaPrompts(undefined, (kind, prompt) => observed.push({ kind, prompt }))
  const source = '텅 빈 새벽 지방역 승강장과 선로. 간판: 「새벽역」'
  const input = { prompt: source, width: 1280, height: 720, aspectRatio: '16:9', style: 'cinematic', signal }
  const first = await generateImage(input)
  await generateImage(input)
  assert.equal(first.prompt, source)
  assert.equal(input.prompt, source)
  assert.equal(translations, 1)
  assert.equal(sent[0].prompt, 'An empty rural railway platform at dawn. A sign reads "새벽역".')
  assert.equal(sent[0].prompt, sent[1].prompt)
  assert.deepEqual([sent[0].width, sent[0].height], [1344, 768])
  assert.deepEqual(observed[0], { kind: 'image', prompt: sent[0].prompt })

  const videoProfileId = settings.addVideo({
    name: 'Fixture LTX Desktop', provider: 'ltx-desktop', apiKey: 'mock-token',
    baseUrl: 'http://127.0.0.1:41955', workflowId: 'ltx-2.3-fast'
  })
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = `data:image/png;base64,${png.toString('base64')}`
      this.onload()
    }
  }
  context.after(() => { delete globalThis.FileReader })
  await assert.rejects(generateVideo({
    ...input, videoProfileId, duration: 5, imageBlob: new Blob([png], { type: 'image/png' }),
    prompt: `${source}\nA narrator says in Korean: "기차가 곧 도착합니다."`
  }))
  assert.equal(sentVideo.kind, 'submit')
  assert.match(sentVideo.prompt, /"기차가 곧 도착합니다\."/)
  assert.equal(observed.at(-1).kind, 'video')
  await assert.rejects(generateImage({ ...input, prompt: '번역 오류' }), /영어로 옮기지 못했습니다/)
  assert.equal(sent.length, 2)
  settings.update({ translateMediaPrompts: false })
  await generateImage(input)
  assert.equal(sent[2].prompt, source)
  assert.equal(translations, 3)
})

async function httpFixture(context, handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('Draw Things 주소 검증에서 사설망과 Tailscale을 허용합니다', async () => {
  for (const port of ['7860', '7859']) {
    for (const address of ['100.64.0.1', '100.127.255.254', '192.168.1.90']) {
      const origin = lanOrigin(address, port)
      assert.equal(origin.port, port)
      assert.equal(await pinAddress(origin), address)
    }
    assert.equal(lanOrigin('studio.tailnet.ts.net', port).origin, `http://studio.tailnet.ts.net:${port}`)
  }
  const queue = createDrawThingsQueue()
  for (const baseUrl of ['http://100.63.255.255', 'grpc://100.128.0.0']) {
    assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl }), { kind: 'unsafeAddress' })
  }
})

test('설치 기본값, 로컬 프리셋, 비율과 모델별 참조 제한', () => {
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  assert.equal(settings.config.image.baseUrl, 'https://api.openai.com/v1')
  assert.match(settings.config.image.model, /^gpt-image/)
  const preset = IMAGE_PROVIDERS.find((item) => item.id === DRAW_THINGS_PROVIDER)
  const local = applyProviderPreset({ baseUrl: '', model: '', models: [] }, preset)
  assert.deepEqual(local, { provider: DRAW_THINGS_PROVIDER, baseUrl: DRAW_THINGS_URL, apiKey: '', model: qwen, models: DRAW_THINGS_MODELS })
  assert.equal(endpointReady({ ...local, baseUrl: 'http://192.168.1.90:7860' }), true)
  assert.deepEqual(drawThingsSize('16:9', 1920, 1080), [1344, 768])
  const klein = drawThingsPreset('flux_2_klein_4b_q8p.ckpt')
  assert.deepEqual([klein.steps, klein.cfg_scale, klein.sampler_name], [4, 1, 'DDIM Trailing'])
  assert.deepEqual(drawThingsSize('9:16', 1080, 1920), [768, 1344])
  assert.deepEqual(drawThingsSize('1:1', 1000, 1000), [1024, 1024])
  assert.deepEqual(drawThingsReferenceCapability(qwen), { min: 0, max: 1 })
  assert.deepEqual(drawThingsReferenceCapability(qwen, true), { min: 0, max: 4 })
  assert.deepEqual(drawThingsReferenceCapability(edit, true), { min: 1, max: 4 })
  assert.equal(drawThingsInputError(qwen, 1), undefined)
  assert.equal(drawThingsInputError(qwen, 4, true), undefined)
  assert.equal(drawThingsInputError(qwen, 5, true), 'drawThings.referenceLimit')
  assert.equal(drawThingsEditAlternative([qwen, flux, edit], qwen, 2, true), edit)
  assert.equal(drawThingsEditAlternative([qwen, flux, edit], qwen, 2, false), undefined)
  assert.equal(drawThingsInputError(edit, 0), 'drawThings.referenceRequired')
  assert.equal(drawThingsInputError(flux, 2), 'drawThings.multipleReferences')
  assert.equal(drawThingsInputError(edit, 4, true), undefined)
  assert.equal(drawThingsInputError(flux, 5, true), 'drawThings.referenceLimit')
})

test('저장한 암호문은 해당 Draw Things 연결에서만 전달합니다', async (context) => {
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  const baseUrl = 'grpc://100.64.0.1:7859'
  const profile = settings.addImage({
    name: 'Draw Things', baseUrl, provider: DRAW_THINGS_PROVIDER, model: qwen, models: [qwen]
  })
  const encryptedSharedSecret = 'mock-ciphertext'
  settings.patchImage({ drawThingsSharedSecret: encryptedSharedSecret })
  settings.selectImageModel(profile, flux)
  assert.equal(settings.config.image.drawThingsSharedSecret, encryptedSharedSecret)
  const calls = []
  globalThis.window.desktop = {
    isDesktop: true,
    async kvSet() {},
    async drawThingsRequest(request) {
      calls.push(request)
      return { kind: 'ready' }
    }
  }
  context.after(() => { delete globalThis.window.desktop })
  await checkDrawThings(baseUrl, settings.config.image.drawThingsSharedSecret)
  await checkDrawThings(DRAW_THINGS_URL, settings.config.image.drawThingsSharedSecret)
  assert.equal(calls[0].encryptedSharedSecret, encryptedSharedSecret)
  assert.equal(calls[1].encryptedSharedSecret, undefined)
  settings.patchImage({ baseUrl: 'grpc://192.168.1.2:7859' })
  assert.equal(settings.config.image.drawThingsSharedSecret, undefined)
})

test('서버 목록을 우선하고 새로고침으로 제거된 모델을 다시 선택할 수 없게 합니다', async (context) => {
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  const baseUrl = 'grpc://100.64.0.1:7859'
  const profile = settings.addImage({
    name: 'Fixture', baseUrl, provider: DRAW_THINGS_PROVIDER, model: qwen, models: DRAW_THINGS_MODELS
  })
  let models = [qwen, 'qwen_image_2.1_i8x.ckpt']
  globalThis.window.desktop = {
    isDesktop: true,
    async kvSet() {},
    async drawThingsRequest() { return { kind: 'ready', models } }
  }
  context.after(() => { delete globalThis.window.desktop })
  const choices = () => namedModelGroups(settings.config.images).find((item) => item.id === profile).models
  await refreshDrawThingsModels(profile, baseUrl)
  assert.deepEqual(choices(), models)
  settings.selectImageModel(profile, edit)
  assert.equal(settings.config.image.model, qwen)
  models = []
  await refreshDrawThingsModels(profile, baseUrl)
  assert.deepEqual(choices(), [])
  assert.equal(settings.config.image.model, '')
  models = undefined
  await refreshDrawThingsModels(profile, baseUrl)
  assert.deepEqual(choices(), DRAW_THINGS_MODELS)
})

test('HTTP 연결, 모델 전환, 한 장 편집 요청과 응답 오류', async (context) => {
  const calls = []
  const baseUrl = await httpFixture(context, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
    calls.push({ path: req.url, authorization: req.headers.authorization, body })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/sdapi/v1/options') return res.end(JSON.stringify({ width: 1024, height: 1024 }))
    if (body.prompt === 'missing') {
      res.statusCode = 422
      return res.end(JSON.stringify({ detail: 'Missing files for model' }))
    }
    if (body.prompt === 'invalid') return res.end(JSON.stringify({ images: ['AAAA'] }))
    res.end(JSON.stringify({ images: [png.toString('base64')] }))
  })
  const queue = createDrawThingsQueue()
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl }), { kind: 'ready' })
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl: 'https://example.com' }), { kind: 'unsafeAddress' })
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl: 'grpc://172.32.0.5' }), { kind: 'unsafeAddress' })
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl: 'http://127.0.0.1:1' }), { kind: 'offline' })

  // Test the same persisted model choice used by the canvas picker and the normal image service.
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  const profile = settings.addImage({
    name: 'Draw Things', provider: DRAW_THINGS_PROVIDER, baseUrl, model: qwen, models: DRAW_THINGS_MODELS
  })
  const callbacks = new Map()
  globalThis.window = {
    ...windowEvents,
    desktop: {
      isDesktop: true,
      dbPath: async () => 'settings.db',
      kvGet: async () => null,
      kvSet: async () => {},
      drawThingsRequest: (request) => queue.request(1, request, (progress) => callbacks.get(request.id)?.(progress)),
      onDrawThingsProgress: (id, callback) => (callbacks.set(id, callback), () => callbacks.delete(id)),
      cancelDrawThings: (id) => queue.cancel(1, id)
    }
  }
  context.after(() => { globalThis.window = { ...windowEvents } })
  const input = { prompt: 'A rainy street.', style: 'cinematic', width: 1920, height: 1080, aspectRatio: '16:9' }
  const progress = []
  const first = await generateImage(input, (label) => progress.push(label))
  settings.selectImageModel(profile, flux)
  const second = await generateImage(input)
  assert.deepEqual(Buffer.from(await first.blob.arrayBuffer()), png)
  assert.deepEqual(Buffer.from(await second.blob.arrayBuffer()), png)
  assert.equal(first.mimeType, 'image/png')
  assert.ok(progress.some(label => label.includes('순서')))
  assert.ok(progress.some(label => label.includes('Draw Things에서 이미지를 생성')))
  const reference = png.toString('base64')
  await queue.request(1, { ...job(baseUrl, edit), reference, sharedSecret: 'mock-secret' })
  const [, t2i, repeat, i2i] = calls
  assert.deepEqual(calls.map((call) => call.path), [
    '/sdapi/v1/options', '/sdapi/v1/txt2img', '/sdapi/v1/txt2img', '/sdapi/v1/img2img'
  ])
  assert.ok(calls.every((call) => call.authorization === undefined))
  assert.equal(t2i.body.prompt, repeat.body.prompt)
  assert.equal(t2i.body.model, qwen)
  assert.equal(repeat.body.model, flux)
  assert.equal(t2i.body.width, 1344)
  assert.equal(t2i.body.height, 768)
  assert.equal(t2i.body.steps, 40)
  assert.equal(t2i.body.cfg_scale, 1)
  assert.equal(t2i.body.sampler_name, 'DDIM Trailing')
  assert.equal('init_images' in t2i.body, false)
  assert.equal(repeat.body.steps, 4)
  assert.equal(i2i.body.model, edit)
  assert.equal(i2i.body.steps, 30)
  assert.equal(i2i.body.cfg_scale, 4)
  assert.equal(i2i.body.sampler_name, 'UniPC Trailing')
  assert.deepEqual(i2i.body.init_images, [reference])
  assert.equal('sharedSecret' in i2i.body, false)
  assert.equal(i2i.body.strength, 1)
  assert.equal((await queue.request(1, { ...job(baseUrl, qwen), reference })).kind, 'image')
  assert.equal(calls.at(-1).path, '/sdapi/v1/img2img')
  assert.equal(calls.at(-1).body.model, qwen)
  assert.deepEqual(calls.at(-1).body.init_images, [reference])
  await assert.rejects(generateImage({ ...input, referenceImages: [new Blob(), new Blob()] }), /한 장만/)
  assert.deepEqual(await queue.request(1, job(baseUrl, qwen, 'err', 'missing')), { kind: 'missingModel' })
  assert.deepEqual(await queue.request(1, job(baseUrl, qwen, 'err', 'invalid')), { kind: 'invalidResponse' })
})

test('HTTP 생성은 대기 및 실행 중 취소를 처리하고 응답이 늦어도 다음 작업을 실행', async (context) => {
  let start
  const started = new Promise((resolve) => { start = resolve })
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const prompts = []
  const baseUrl = await httpFixture(context, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { prompt } = JSON.parse(Buffer.concat(chunks))
    prompts.push(prompt)
    if (prompt === 'first') {
      start()
      await blocked
    }
    res.end(JSON.stringify({ images: [png.toString('base64')] }))
  })
  const queue = createDrawThingsQueue()
  const first = queue.request(1, job(baseUrl, qwen, 'first', 'first'))
  await started
  const queued = queue.request(1, job(baseUrl, flux, 'queued', 'queued'))
  const last = queue.request(2, job(baseUrl, flux, 'last', 'last'))
  try {
    queue.cancel(2, 'queued')
    queue.cancel(1, 'queued')
    queue.cancel(1, 'first')
    assert.deepEqual(await queued, { kind: 'cancelled' })
    assert.deepEqual(await first, { kind: 'cancelled' })
    assert.equal((await last).kind, 'image')
    assert.deepEqual(prompts, ['first', 'last'])
  } finally {
    release()
  }
})

function scan(bytes) {
  const r = Reader.create(bytes)
  const values = new Map()
  while (r.pos < r.len) {
    const tag = r.uint32()
    const wire = tag & 7
    const index = tag >>> 3
    let result
    if (wire === 2) result = Buffer.from(r.bytes())
    else if (wire === 0) result = r.uint32()
    else if (wire === 5) result = r.float()
    else {
      r.skipType(wire)
      continue
    }
    values.set(index, [...(values.get(index) || []), result])
  }
  return values
}

test('gRPC 인증, 모델 목록, 참조 크기, 진행 단계, 대기열, 제한 시간과 취소', { timeout: 12000 }, async (context) => {
  const server = new Server({ 'grpc.max_receive_message_length': 32 * 1024 * 1024 })
  context.after(() => server.forceShutdown())
  const protocols = Object.fromEntries(['Echo', 'GenerateImage'].map((method) => [method, {
    path: `/ImageGenerationService/${method}`,
    requestStream: false, responseStream: method === 'GenerateImage',
    requestDeserialize: (bytes) => bytes, responseSerialize: (bytes) => bytes
  }]))
  const requests = []
  let needKey = false
  let rawFiles = []
  let echoModels = [edit, flux, qwen, 'irrelevant.ckpt']
  const sharedSecret = 'mock-shared-secret'
  let compressed = false
  let cancelled
  const cancellation = new Promise(resolve => { cancelled = resolve })
  let begin
  const streaming = new Promise(resolve => { begin = resolve })
  server.addService(protocols, {
    Echo(call, reply) {
      const req = scan(call.request)
      assert.equal(req.get(1)[0].toString(), 'Drama Flow Studio')
      const response = Writer.create().uint32(10).string('HELLO Drama Flow Studio')
      if (needKey && req.get(2)?.[0].toString() !== sharedSecret) response.uint32(32).bool(true)
      for (const file of rawFiles) response.uint32(18).string(file)
      if (echoModels) {
        const models = JSON.stringify(echoModels.map((file) => ({ file })))
        response.uint32(26).fork().uint32(10).bytes(Buffer.from(models)).ldelim()
      }
      reply(null, Buffer.from(response.finish()))
    },
    GenerateImage(call) {
      const req = scan(call.request)
      requests.push(req)
      const prompt = req.get(5)[0].toString()
      if (needKey && req.get(13)?.[0].toString() !== sharedSecret) {
        call.destroy(new Error('Missing test credential'))
        return
      }
      const progress = Writer.create().uint32(18).fork().uint32(26).fork().uint32(8).int32(2).ldelim().ldelim()
      call.write(Buffer.from(progress.finish()))
      if (prompt === 'cancel') {
        call.on('cancelled', cancelled)
        begin()
        return
      }
      if (prompt === 'timeout') return
      const alpha = prompt === 'transparent'
      const samples = alpha ? [0x3800, 0x3c00, 0xbc00, 0] : [0x3c00, 0xbc00, 0]
      const tensor = Buffer.alloc(68 + 2 * samples.length)
      const header = [compressed ? 1012247 : 0, 1, 2, 0x20000, 0, 1, 1, 1, samples.length]
      header.forEach((value, i) => tensor.writeUInt32LE(value, i * 4))
      samples.forEach((value, i) => tensor.writeUInt16LE(value, 68 + i * 2))
      const part = (bytes, more) => Buffer.from(Writer.create().uint32(10).bytes(bytes).uint32(64).uint32(more).finish())
      call.write(part(tensor.subarray(0, 35), 1))
      call.write(part(tensor.subarray(35), 0))
      call.end()
    }
  })
  const port = await new Promise((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value))
  )
  const baseUrl = `grpc://127.0.0.1:${port}`
  const queue = createDrawThingsQueue()
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl }), { kind: 'ready', models: [edit, flux, qwen] })
  needKey = true
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl }), { kind: 'grpcSecret' })
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl, sharedSecret: 'mock-wrong' }), { kind: 'grpcSecret' })
  assert.equal((await queue.request(1, { kind: 'check', baseUrl, sharedSecret })).kind, 'ready')

  const pixels = (colour) => {
    const rgba = new Uint8Array(128 * 128 * 4)
    rgba.set(colour)
    return rgba.buffer
  }
  const request = {
    ...job(baseUrl, edit), width: 128, height: 128, sharedSecret,
    referencePixels: [pixels([255, 0, 0, 255]), pixels([0, 255, 0, 255]), pixels([0, 0, 255, 255])]
  }
  const progress = []
  const result = await queue.request(1, request, (value) => progress.push(value))
  assert.equal(result.kind, 'pixels')
  assert.deepEqual([...new Uint8Array(result.data)], [255, 0, 128, 255])
  assert.deepEqual(progress, [undefined, { step: 3, total: 30 }])
  const sent = requests[0]
  assert.equal(sent.get(13)[0].toString() === sharedSecret, true)
  const primary = sent.get(1)[0]
  assert.equal(primary.readUInt32LE(24), 128)
  assert.equal(primary.readUInt32LE(28), 128)
  assert.equal(primary.readUInt16LE(68), 0x3c00)
  const hints = scan(sent.get(4)[0])
  assert.equal(hints.get(1)[0].toString(), 'shuffle')
  const others = hints.get(2).map(scan)
  assert.equal(others.length, 2)
  assert.equal(others[0].get(1)[0].readUInt16LE(70), 0x3c00)
  assert.equal(others[1].get(1)[0].readUInt16LE(72), 0x3c00)
  assert.equal(others[0].get(2)[0], 1)
  const flatbuffer = new ByteBuffer(sent.get(7)[0])
  const root = flatbuffer.readInt32(0)
  const field = (id) => root + flatbuffer.__offset(root, 4 + 2 * id)
  assert.equal(flatbuffer.readUint32(field(4)), 30)
  assert.equal(flatbuffer.readFloat32(field(5)), 4)
  assert.equal(flatbuffer.readInt8(field(8)), 17)
  assert.equal(flatbuffer.__string(field(7)), edit)

  const fluxResult = await queue.request(1, { ...request, model: flux })
  assert.deepEqual([...new Uint8Array(fluxResult.data)], [255, 0, 128, 255])
  assert.equal(scan(requests[1].get(4)[0]).get(2).length, 2)
  const fluxConfig = new ByteBuffer(requests[1].get(7)[0])
  const fluxRoot = fluxConfig.readInt32(0)
  const fluxField = (id) => fluxRoot + fluxConfig.__offset(fluxRoot, 4 + 2 * id)
  assert.equal(fluxConfig.readUint32(fluxField(4)), 4)
  assert.equal(fluxConfig.readFloat32(fluxField(5)), 1)
  assert.equal(fluxConfig.readInt8(fluxField(8)), 16)
  const alphaResult = await queue.request(1, {
    ...request, model: qwen, prompt: 'transparent', referencePixels: []
  })
  assert.deepEqual([...new Uint8Array(alphaResult.data)], [255, 0, 128, 128])
  assert.equal(requests[2].has(1), false)
  assert.equal(requests[2].has(8), false)

  compressed = true
  assert.deepEqual(await queue.request(1, { ...request, model: flux }), { kind: 'grpcCompression' })
  compressed = false
  const active = queue.request(1, { ...request, prompt: 'cancel' })
  await streaming
  const held = queue.request(1, { ...request, id: 'held' })
  await setImmediate()
  assert.equal(requests.at(-1).get(5)[0].toString(), 'cancel')
  queue.cancel(1, 'held')
  assert.deepEqual(await held, { kind: 'cancelled' })
  queue.cancel(1, request.id)
  assert.deepEqual(await active, { kind: 'cancelled' })
  await cancellation
  assert.equal((await queue.request(1, request)).kind, 'pixels')

  const shortDeadline = createDrawThingsQueue({ probeMs: 1000, generationMs: 150 })
  assert.deepEqual(await shortDeadline.request(1, { ...request, prompt: 'timeout' }), { kind: 'timeout' })
  assert.equal((await shortDeadline.request(1, request)).kind, 'pixels')
  assert.deepEqual(await queue.request(1, {
    ...request, width: 2048, height: 2048, referencePixels: Array(4).fill(new ArrayBuffer(0))
  }), { kind: 'referenceTooLarge' })
  const large = new ArrayBuffer(1344 * 768 * 4)
  assert.equal((await queue.request(1, {
    ...request, width: 1344, height: 768, referencePixels: Array(4).fill(large)
  })).kind, 'pixels')

  rawFiles = [flux, qwen, 'qwen_3_vl_8b_instruct_q8p.ckpt', 'qwen_image_2.1_vae_f16.ckpt']
  echoModels = [flux]
  const attempted = requests.length
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl, sharedSecret }), {
    kind: 'ready', models: [flux], incompleteModels: [qwen], missingComponents: ['qwen_3_vl_8b_instruct_i8x.ckpt']
  })
  assert.deepEqual(await queue.request(1, { ...request, model: qwen, referencePixels: [] }), {
    kind: 'modelIncomplete', models: [flux], missingComponents: ['qwen_3_vl_8b_instruct_i8x.ckpt']
  })
  assert.deepEqual(await queue.request(1, request), { kind: 'modelUnavailable', models: [flux] })
  assert.equal(requests.length, attempted)
  rawFiles.push('qwen_3_vl_8b_instruct_i8x.ckpt')
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl, sharedSecret }), {
    kind: 'ready', models: [flux, qwen], unverifiedModels: [qwen]
  })
  assert.equal(drawThingsInputError(qwen, 0, true), undefined)
  assert.equal(drawThingsInputError(edit, 0, true), 'drawThings.referenceRequired')
  const recovered = { ...request, model: qwen, width: 1344, height: 768, referencePixels: [] }
  assert.equal((await queue.request(1, recovered)).kind, 'pixels')
  const recoveredWire = requests.at(-1)
  const models = JSON.parse(scan(recoveredWire.get(8)[0]).get(1)[0].toString())
  assert.deepEqual(models, [{
    name: 'Qwen Image 2.1', file: qwen, version: 'qwen_image_2.1',
    text_encoder: 'qwen_3_vl_8b_instruct_i8x.ckpt', autoencoder: 'qwen_image_2.1_vae_f16.ckpt',
    prefix: '', modifier: 'kontext', default_scale: 24, hires_fix_scale: 40,
    upcast_attention: false, high_precision_autoencoder: true, hugging_face_link: 'Qwen/Qwen-Image-2.1',
    objective: { u: { condition_scale: 1000 } },
    noise_discretization: { rf: { _0: { sigma_min: 0, sigma_max: 1, condition_scale: 1000, shift_terminal: 0.02 } } }
  }])
  const qwenConfig = new ByteBuffer(recoveredWire.get(7)[0])
  const qwenRoot = qwenConfig.readInt32(0)
  const qwenOffset = (id) => qwenConfig.__offset(qwenRoot, 4 + 2 * id)
  assert.equal(qwenConfig.readUint16(qwenRoot + qwenOffset(1)), 21)
  assert.equal(qwenConfig.readUint16(qwenRoot + qwenOffset(2)), 12)
  assert.equal(qwenConfig.readUint32(qwenRoot + qwenOffset(4)), 40)
  assert.equal(qwenConfig.readFloat32(qwenRoot + qwenOffset(5)), 1)
  assert.equal(qwenConfig.readFloat32(qwenRoot + qwenOffset(6)), 1)
  assert.equal(qwenConfig.__string(qwenRoot + qwenOffset(7)), qwen)
  assert.equal(qwenConfig.readInt8(qwenRoot + qwenOffset(8)), 16)
  assert.equal(qwenConfig.readInt8(qwenRoot + qwenOffset(17)), 2)
  for (const id of [11, 18, 49, 53, 71, 75]) assert.equal(qwenOffset(id), 0)
  assert.equal(recoveredWire.get(6)[0].toString(), '')

  assert.equal((await queue.request(1, { ...request, model: qwen })).kind, 'pixels')
  const qwenEditWire = requests.at(-1)
  assert.equal(qwenEditWire.get(1)[0].readUInt32LE(32), 3)
  assert.equal(scan(qwenEditWire.get(4)[0]).get(1)[0].toString(), 'shuffle')
  assert.equal(scan(qwenEditWire.get(4)[0]).get(2).length, 2)
  assert.deepEqual(JSON.parse(scan(qwenEditWire.get(8)[0]).get(1)[0].toString()), models)

  const unknown = 'qwen_image_2.1_bf16.ckpt'
  rawFiles.push(unknown)
  const warnings = []
  assert.equal((await queue.request(1, { ...recovered, model: unknown }, value => warnings.push(value))).kind, 'pixels')
  assert.deepEqual(warnings, [undefined, { warning: 'unverifiedModel' }, { step: 3, total: 40 }])
  assert.equal(requests.at(-1).has(8), false)
  echoModels = []
  rawFiles = []
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl, sharedSecret }), { kind: 'ready', models: [] })
  echoModels = undefined
  rawFiles = [
    'qwen_image_2.1_i8x.ckpt', 'qwen_image_2.1_f16.ckpt', 'qwen_image_2.1_vae_f16.ckpt',
    'qwen_3_vl_8b_instruct_i8x.ckpt', 'qwen_3_vl_8b_instruct_f16.ckpt'
  ]
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl, sharedSecret }), {
    kind: 'ready', models: ['qwen_image_2.1_i8x.ckpt', 'qwen_image_2.1_f16.ckpt'],
    unverifiedModels: ['qwen_image_2.1_i8x.ckpt', 'qwen_image_2.1_f16.ckpt']
  })
  rawFiles = []
  assert.deepEqual(await queue.request(1, { kind: 'check', baseUrl, sharedSecret }), { kind: 'ready' })
})
