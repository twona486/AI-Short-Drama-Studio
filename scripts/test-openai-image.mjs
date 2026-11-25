import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  envFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  server: { middlewareMode: true, hmr: false }
})
after(() => server.close())

const { generateImage } = await server.ssrLoadModule('/src/services/ai/image.ts')
const { useSettingsStore } = await server.ssrLoadModule('/src/stores/settings.ts')
const { getImageConfig } = await server.ssrLoadModule('/src/services/ai/runtime.ts')
const { IMAGE_PROVIDERS, applyProviderPreset, suggestedPresetModels } = await server.ssrLoadModule('/src/services/ai/providers.ts')
const { openAiImageRequest, parseOpenAiImage, OPENAI_DEFAULT_IMAGE_MODEL } =
  await server.ssrLoadModule('/src/services/ai/openAiImage.ts')

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jixUAAAAASUVORK5CYII='
const success = () => Response.json({ data: [{ b64_json: png }] })
const input = { model: OPENAI_DEFAULT_IMAGE_MODEL, prompt: 'A train station', width: 1280, height: 720 }

function loadSettings(context, saved, desktop) {
  context.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request') })
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => saved ? JSON.stringify(saved) : null, setItem() {} }
  })
  globalThis.window = {
    desktop: desktop && {
      async dbPath() { return 'settings.db' },
      async kvGet() { return '{}' },
      async kvSet() {},
      ...desktop
    },
    addEventListener() {}
  }
  globalThis.document = { addEventListener() {} }
  context.after(() => {
    delete globalThis.localStorage
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    delete globalThis.window
    delete globalThis.document
  })
  setActivePinia(createPinia())
  return useSettingsStore()
}

test('새 연결은 OpenAI 모델만 선택하고 기존 공급업체는 수동 프리셋에 남깁니다', (context) => {
  const settings = loadSettings(context)
  assert.equal(settings.config.image.baseUrl, 'https://api.openai.com/v1')
  assert.equal(settings.config.image.apiKey, '')
  assert.equal(settings.config.image.model, OPENAI_DEFAULT_IMAGE_MODEL)
  assert.deepEqual(settings.config.image.models, [OPENAI_DEFAULT_IMAGE_MODEL])
  assert.equal(IMAGE_PROVIDERS[0].defaultModel, OPENAI_DEFAULT_IMAGE_MODEL)
  assert.deepEqual(suggestedPresetModels(IMAGE_PROVIDERS[0], settings.config.image.models), ['gpt-image-2.6-flare'])
  for (const preset of IMAGE_PROVIDERS.slice(1, -1)) {
    assert.ok(preset.models.length)
    assert.deepEqual(suggestedPresetModels(preset, []), [])
    assert.equal(applyProviderPreset({ baseUrl: '', model: '', models: [] }, preset).model, '')
  }
})

const savedSeedream = {
  id: 'seedream',
  name: 'Seedream',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: 'test-seedream',
  model: 'doubao-seedream-4-0-250828',
  models: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'],
  provider: 'volcengine',
  adapter: undefined,
  options: undefined
}
const savedOpenAi = {
  id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-openai', model: OPENAI_DEFAULT_IMAGE_MODEL, models: [OPENAI_DEFAULT_IMAGE_MODEL]
}

test('선택한 Seedream을 유지하고 연결 삭제 시 Seedream으로 자동 전환하지 않습니다', (context) => {
  const settings = loadSettings(context, { images: [savedSeedream, savedOpenAi], activeImageId: savedSeedream.id })
  assert.deepEqual(settings.config.images[0], savedSeedream)
  assert.equal(settings.config.activeImageId, savedSeedream.id)
  assert.equal(getImageConfig().apiKey, savedSeedream.apiKey)
  settings.selectImage(savedOpenAi.id)
  settings.removeImage(savedOpenAi.id)
  assert.equal(settings.config.image.model, OPENAI_DEFAULT_IMAGE_MODEL)
  assert.equal(settings.config.image.apiKey, '')
  assert.deepEqual(settings.config.images[0], savedSeedream)
})

test('삭제된 활성 ID로 불러온 경우 Seedream을 자동 선택하지 않습니다', (context) => {
  const settings = loadSettings(context, { images: [savedSeedream], activeImageId: 'missing' })
  assert.equal(settings.config.image.model, OPENAI_DEFAULT_IMAGE_MODEL)
  assert.deepEqual(settings.config.images[0], savedSeedream)
})

test('이전 단일 연결에 저장한 Seedream 모델과 키를 유지합니다', (context) => {
  const { id, name, ...image } = savedSeedream
  const settings = loadSettings(context, { image })
  assert.equal(settings.config.image.model, image.model)
  assert.equal(settings.config.image.apiKey, image.apiKey)
  assert.deepEqual(settings.config.image.models, image.models)
})

test('이미지 연결에서 현재 모델을 지워도 수동 프리셋을 선택하지 않습니다', (context) => {
  const settings = loadSettings(context, {
    images: [{ ...savedOpenAi, models: [OPENAI_DEFAULT_IMAGE_MODEL, savedSeedream.model] }],
    activeImageId: savedOpenAi.id
  })
  settings.removeModel('image', OPENAI_DEFAULT_IMAGE_MODEL)
  assert.equal(getImageConfig().model, '')
  assert.deepEqual(settings.config.image.models, [savedSeedream.model])
})

test('GPT Image 비율을 지원 크기에 매핑합니다', async () => {
  for (const [aspectRatio, size] of Object.entries({
    '16:9': '1536x864', '9:16': '864x1536', '1:1': '1024x1024',
    '4:3': '1280x960', '21:9': '1792x768'
  })) {
    const request = await openAiImageRequest({ ...input, aspectRatio })
    assert.equal(JSON.parse(request.body).size, size)
    const older = await openAiImageRequest({ ...input, aspectRatio, model: 'gpt-image-1.5' })
    assert.equal(JSON.parse(older.body).size, aspectRatio === '9:16' ? '1024x1536' : aspectRatio === '1:1' ? '1024x1024' : '1536x1024')
  }
  const inferred = await openAiImageRequest({ ...input, width: 500, height: 900 })
  assert.equal(JSON.parse(inferred.body).size, '864x1536')
})

test('공식 생성 요청과 base64 PNG 응답을 처리합니다', async (context) => {
  const settings = loadSettings(context)
  settings.patchImage({ apiKey: 'test-openai' })
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/images/generations')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, 'Bearer test-openai')
    assert.match(init.headers['Content-Type'], /application\/json/)
    const { prompt, ...fields } = JSON.parse(init.body)
    assert.match(prompt, /^A train station/)
    assert.deepEqual(fields, {
      model: OPENAI_DEFAULT_IMAGE_MODEL, size: '1536x864', quality: 'medium',
      output_format: 'png', background: 'auto', n: 1
    })
    return success()
  })
  const result = await generateImage(input)
  assert.equal(result.mimeType, 'image/png')
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), Buffer.from(png, 'base64'))
  assert.throws(() => parseOpenAiImage({ data: [{ url: 'https://example.com/image.png' }] }), /응답/)
  assert.throws(() => parseOpenAiImage({ data: [{ b64_json: '!!!' }] }), /응답/)
})

test('데스크톱 편집은 다섯 장의 큰 참조를 바이너리 멀티파트로 보내고 PNG를 읽습니다', async (context) => {
  const referenceImages = Array.from({ length: 5 }, (_, index) =>
    new Blob([new Uint8Array(2_000_000).fill(index)], { type: 'image/png' })
  )
  const settings = loadSettings(context, undefined, {
    isDesktop: true,
    async autodlFetch(opts) {
      assert.equal(opts.url, 'https://api.openai.com/v1/images/edits')
      assert.equal(opts.method, 'POST')
      assert.equal(opts.authorization, 'Bearer test-openai')
      assert.equal(opts.timeoutMs, 600_000)
      assert.equal(opts.bodyBase64, undefined)
      assert.match(opts.contentType, /^multipart\/form-data; boundary=/)
      const form = await new Response(opts.bodyBytes, { headers: { 'Content-Type': opts.contentType } }).formData()
      assert.equal(form.get('model'), OPENAI_DEFAULT_IMAGE_MODEL)
      assert.equal(form.get('size'), '864x1536')
      assert.equal(form.get('quality'), 'medium')
      assert.equal(form.get('output_format'), 'png')
      assert.equal(form.get('background'), 'auto')
      assert.equal(form.get('response_format'), null)
      assert.equal(form.get('input_fidelity'), null)
      const files = form.getAll('image[]')
      assert.equal(files.length, 5)
      for (const [index, file] of files.entries()) {
        assert.equal(file.name, `ref_${index + 1}.png`)
        assert.equal(file.type, 'image/png')
        assert.equal(file.size, 2_000_000)
        assert.equal(new Uint8Array(await file.slice(0, 1).arrayBuffer())[0], index)
      }
      return { ok: true, status: 200, text: await success().text() }
    }
  })
  settings.patchImage({ apiKey: 'test-openai' })
  const result = await generateImage({ ...input, aspectRatio: '9:16', referenceImages })
  await settings.flush()
  assert.equal(result.blob.type, 'image/png')
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), Buffer.from(png, 'base64'))
})

test('편집 참조 제한은 16장입니다', async () => {
  const reference = new Blob([Buffer.from(png, 'base64')], { type: 'image/png' })
  const refs = Array(16).fill(reference)
  const request = await openAiImageRequest({ ...input, referenceImages: refs })
  assert.equal(request.form.getAll('image[]').length, 16)
  await assert.rejects(openAiImageRequest({ ...input, referenceImages: [...refs, reference] }), /16장/)
})

test('큰 참조 묶음은 업로드 한도에 맞춰 일부만 줄입니다', async (context) => {
  class LargeReference extends Blob {
    get size() { return 40_000_000 }
  }
  const source = new LargeReference(['source'], { type: 'image/png' })
  const smaller = new Blob(['smaller'], { type: 'image/webp' })
  const kept = new Blob([new Uint8Array(9_000_000)], { type: 'image/png' })
  const close = context.mock.fn()
  const drawImage = context.mock.fn()
  globalThis.createImageBitmap = async (blob) => {
    assert.equal(blob, source)
    return { width: 3072, height: 1536, close }
  }
  const canvas = {
    getContext: () => ({ drawImage }),
    toBlob: (callback, mime) => {
      assert.equal(mime, 'image/webp')
      callback(smaller)
    }
  }
  globalThis.document = { createElement: () => canvas }
  context.after(() => {
    delete globalThis.createImageBitmap
    delete globalThis.document
  })
  const { form } = await openAiImageRequest({ ...input, referenceImages: [source, kept] })
  const [reducedFile, keptFile] = form.getAll('image[]')
  assert.equal(reducedFile.name, 'ref_1.webp')
  assert.equal(reducedFile.size, smaller.size)
  assert.equal(keptFile.size, kept.size)
  assert.deepEqual([canvas.width, canvas.height], [1536, 768])
  assert.equal(close.mock.callCount(), 1)
  assert.equal(drawImage.mock.callCount(), 1)
})

test('데스크톱에서 취소하면 실행 중인 메인 프로세스 요청도 취소합니다', async (context) => {
  const controller = new AbortController()
  const { promise: started, resolve: start } = Promise.withResolvers()
  const { promise: response, reject: cancel } = Promise.withResolvers()
  const settings = loadSettings(context, undefined, {
    isDesktop: true,
    autodlFetch(opts) {
      start(opts.requestId)
      return response
    },
    cancelProviderFetch(requestId) {
      void started.then((startedId) => {
        assert.ok(startedId)
        assert.equal(requestId, startedId)
        cancel(new Error('Native request aborted'))
      })
    }
  })
  settings.patchImage({ apiKey: 'test-openai' })
  const generation = generateImage({ ...input, signal: controller.signal })
  await started
  controller.abort()
  await assert.rejects(generation, { name: 'AbortError' })
  await settings.flush()
})
