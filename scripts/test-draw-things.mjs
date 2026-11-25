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
const {
  DRAW_THINGS_MODELS, DRAW_THINGS_PROVIDER, DRAW_THINGS_URL, drawThingsInputError, drawThingsSize
} = await vite.ssrLoadModule('/src/services/ai/drawThingsOptions.ts')
const { applyProviderPreset, IMAGE_PROVIDERS } = await vite.ssrLoadModule('/src/services/ai/providers.ts')
const { endpointReady, useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')
const { generateImage } = await vite.ssrLoadModule('/src/services/ai/image.ts')
const [qwen, edit, flux] = DRAW_THINGS_MODELS
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgSEAAAAASUVORK5CYII=', 'base64')
const job = (baseUrl, model, id = 'test', prompt = 'A rainy street.') => (
  { kind: 'generate', baseUrl, id, model, prompt, width: 1344, height: 768 }
)

async function httpFixture(context, handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

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
  assert.deepEqual(drawThingsSize('9:16', 1080, 1920), [768, 1344])
  assert.deepEqual(drawThingsSize('1:1', 1000, 1000), [1024, 1024])
  assert.equal(drawThingsInputError(qwen, 1), 'drawThings.textOnly')
  assert.equal(drawThingsInputError(edit, 0), 'drawThings.referenceRequired')
  assert.equal(drawThingsInputError(flux, 2), 'drawThings.multipleReferences')
  assert.equal(drawThingsInputError(edit, 4, true), undefined)
  assert.equal(drawThingsInputError(flux, 5, true), 'drawThings.referenceLimit')
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
  await queue.request(1, { ...job(baseUrl, edit), reference })
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
  assert.equal(i2i.body.strength, 1)
  await assert.rejects(generateImage({ ...input, referenceImages: [new Blob(), new Blob()] }), /한 장만/)
  assert.deepEqual(await queue.request(1, job(baseUrl, qwen, 'err', 'missing')), { kind: 'missingModel' })
  assert.deepEqual(await queue.request(1, job(baseUrl, qwen, 'err', 'invalid')), { kind: 'invalidResponse' })
})

test('HTTP 생성은 순서대로 보내고 대기 중인 요청은 전송 전에 취소', async (context) => {
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
    await setImmediate()
    assert.deepEqual(prompts, ['first'])
  } finally {
    release()
  }
  assert.equal((await first).kind, 'image')
  assert.equal((await last).kind, 'image')
  assert.deepEqual(prompts, ['first', 'last'])
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

test('gRPC 로컬 모델 목록, 순서 있는 여러 장 참조, 진행 단계, 이미지 텐서와 취소', { timeout: 12000 }, async (context) => {
  const server = new Server()
  context.after(() => server.forceShutdown())
  const protocols = Object.fromEntries(['Echo', 'GenerateImage'].map((method) => [method, {
    path: `/ImageGenerationService/${method}`,
    requestStream: false, responseStream: method === 'GenerateImage',
    requestDeserialize: (bytes) => bytes, responseSerialize: (bytes) => bytes
  }]))
  const requests = []
  let needKey = false
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
      if (needKey) response.uint32(32).bool(true)
      const models = JSON.stringify([{ file: edit }, { file: flux }, { file: qwen }, { file: 'irrelevant.ckpt' }])
      response.uint32(26).fork().uint32(10).bytes(Buffer.from(models)).ldelim()
      reply(null, Buffer.from(response.finish()))
    },
    GenerateImage(call) {
      const req = scan(call.request)
      requests.push(req)
      const prompt = req.get(5)[0].toString()
      const progress = Writer.create().uint32(18).fork().uint32(26).fork().uint32(8).int32(2).ldelim().ldelim()
      call.write(Buffer.from(progress.finish()))
      if (prompt === 'cancel') {
        call.on('cancelled', cancelled)
        begin()
        return
      }
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
  needKey = false

  const pixels = (colour) => {
    const rgba = new Uint8Array(128 * 128 * 4)
    rgba.set(colour)
    return rgba.buffer
  }
  const request = {
    ...job(baseUrl, edit), width: 128, height: 128,
    referencePixels: [pixels([255, 0, 0, 255]), pixels([0, 255, 0, 255]), pixels([0, 0, 255, 255])]
  }
  const progress = []
  const result = await queue.request(1, request, (value) => progress.push(value))
  assert.equal(result.kind, 'pixels')
  assert.deepEqual([...new Uint8Array(result.data)], [255, 0, 128, 255])
  assert.deepEqual(progress, [undefined, { step: 3, total: 30 }])
  const sent = requests[0]
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
  const alphaResult = await queue.request(1, {
    ...request, model: qwen, prompt: 'transparent', referencePixels: []
  })
  assert.deepEqual([...new Uint8Array(alphaResult.data)], [255, 0, 128, 128])
  assert.equal(requests[2].has(1), false)

  compressed = true
  assert.deepEqual(await queue.request(1, { ...request, model: flux }), { kind: 'grpcCompression' })
  compressed = false
  const active = queue.request(1, { ...request, prompt: 'cancel' })
  await streaming
  queue.cancel(1, request.id)
  assert.deepEqual(await active, { kind: 'cancelled' })
  await cancellation
  assert.equal((await queue.request(1, request)).kind, 'pixels')
})
