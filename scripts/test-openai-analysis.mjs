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

const { useSettingsStore } = await server.ssrLoadModule('/src/stores/settings.ts')
const { getLlmConfig, getVisionConfig } = await server.ssrLoadModule('/src/services/ai/runtime.ts')
const { callLLM } = await server.ssrLoadModule('/src/services/ai/client.ts')
const { LLM_PROVIDERS, VISION_PROVIDERS, IMAGE_PROVIDERS, suggestedPresetModels, applyProviderPreset } =
  await server.ssrLoadModule('/src/services/ai/providers.ts')

function loadSettings(context, saved) {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network request')
  })
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => saved ? JSON.stringify(saved) : null, setItem() {} }
  })
  globalThis.window = { addEventListener() {} }
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

test('새 설치의 대본·비전과 추천 모델은 OpenAI를 사용해요', (context) => {
  const settings = loadSettings(context)
  for (const [config, presets] of [[settings.config.llm, LLM_PROVIDERS], [settings.config.vision, VISION_PROVIDERS]]) {
    const [openAi, ...manual] = presets
    assert.equal(openAi.id, 'openai')
    assert.equal(config.baseUrl, 'https://api.openai.com/v1')
    assert.equal(config.model, 'gpt-5.4-mini')
    assert.equal(config.apiKey, '')
    assert.deepEqual(config.models, ['gpt-5.4-mini'])
    assert.deepEqual(suggestedPresetModels(openAi, config.models), ['gpt-5.4'])
    assert.ok(manual.length > 1)
    for (const preset of manual.filter((item) => item.id !== 'custom')) {
      assert.deepEqual(suggestedPresetModels(preset, []), [])
      const selected = applyProviderPreset({ baseUrl: '', model: '', models: [] }, preset)
      assert.equal(selected.baseUrl, preset.baseUrl)
      assert.equal(selected.model, preset.defaultModel)
    }
  }
  assert.deepEqual(LLM_PROVIDERS.map(({ id }) => id), ['openai', 'deepseek', 'dashscope', 'volcengine', 'moonshot', 'zhipu', 'minimax', 'custom'])
  assert.equal(settings.config.visionEnabled, false)
  assert.equal(settings.config.image.model, 'doubao-seedream-4-0-250828')
  assert.equal(settings.config.video.workflowId, 'minimax_h3_lightx2v_v5_15s')
  assert.equal(settings.config.tts.model, 'qwen-audio-3.0-tts-flash')
  assert.ok(suggestedPresetModels(IMAGE_PROVIDERS[0], []).length)
})

test('기존 Qwen 연결의 모델과 키를 유지해요', (context) => {
  const baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const llm = { baseUrl, model: 'qwen-plus', models: ['qwen-plus', 'qwen-max'], apiKey: 'test-llm', provider: 'dashscope' }
  const vision = { baseUrl, model: 'qwen-vl-plus', models: ['qwen-vl-plus', 'qwen-vl-max'], apiKey: 'test-vision', provider: 'dashscope' }
  const settings = loadSettings(context, {
    llm,
    vision,
    visions: [{ id: 'vision-1', name: 'Qwen', ...vision }, { id: 'vision-2', name: 'Qwen (2)', baseUrl, model: 'qwen3-vl-plus' }],
    activeVisionId: 'vision-1',
    visionEnabled: true
  })
  assert.deepEqual(getLlmConfig().models, llm.models)
  assert.equal(getLlmConfig().model, llm.model)
  assert.equal(getLlmConfig().apiKey, llm.apiKey)
  assert.equal(getVisionConfig().model, vision.model)
  assert.equal(getVisionConfig().apiKey, vision.apiKey)
  assert.equal(getVisionConfig().baseUrl, vision.baseUrl)
  assert.deepEqual(getVisionConfig().models, vision.models)
  assert.equal(settings.config.activeVisionId, 'vision-1')
  assert.equal(settings.config.visionEnabled, true)
  settings.selectVision('vision-2')
  assert.equal(getVisionConfig().apiKey, '')
})

function completion(content) {
  return {
    model: 'resolved-model',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 19, completion_tokens: 8, total_tokens: 27 }
  }
}

test('모델에 맞는 토큰·샘플링 필드로 대본을 요청하고 응답을 읽어요', async (context) => {
  const settings = loadSettings(context)
  const bodies = []
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-openai')
    bodies.push({ url, body: JSON.parse(init.body) })
    return Response.json(completion('인물: 오늘 같이 가요.'))
  }
  const messages = [{ role: 'user', content: 'Write dialogue in Korean.' }]
  settings.patchLlm({ apiKey: 'test-openai' })
  const result = await callLLM({ messages, temperature: 0.4, maxTokens: 100 })
  assert.deepEqual(result, {
    model: 'resolved-model', content: '인물: 오늘 같이 가요.', finishReason: 'stop',
    usage: { promptTokens: 19, completionTokens: 8, totalTokens: 27 }
  })
  assert.deepEqual(bodies.shift(), {
    url: 'https://api.openai.com/v1/chat/completions',
    body: { model: 'gpt-5.4-mini', messages, temperature: 0.4, reasoning_effort: 'none', max_completion_tokens: 100 }
  })
  await callLLM({ messages, model: 'gpt-5.4', useProviderOutputLimit: true })
  assert.deepEqual(bodies.shift().body, { model: 'gpt-5.4', messages, temperature: 0.7, reasoning_effort: 'none' })
  await callLLM({ messages, model: 'gpt-5-mini', maxTokens: 100 })
  assert.deepEqual(bodies.shift().body, { model: 'gpt-5-mini', messages, max_completion_tokens: 100 })
  await callLLM({ messages, model: 'gpt-4.1', maxTokens: 100 })
  assert.deepEqual(bodies.shift().body, { model: 'gpt-4.1', messages, temperature: 0.7, max_completion_tokens: 100 })
  settings.patchLlm({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' })
  await callLLM({ messages, temperature: 0.2, maxTokens: 100 })
  assert.deepEqual(bodies.shift().body, { model: 'deepseek-chat', messages, temperature: 0.2, max_tokens: 100 })
})

test('데스크톱에서 URL·base64 이미지 파트를 넘기고 JSON 모드 거부 후 다시 요청해요', async (context) => {
  const settings = loadSettings(context)
  settings.patchVision({ apiKey: 'test-vision' })
  const bodies = []
  window.desktop = {
    isDesktop: true,
    async kvSet() {},
    async llmFetch({ url, authorization, body }) {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions')
      assert.equal(authorization, 'Bearer test-vision')
      bodies.push(JSON.parse(body))
      if (bodies.length === 1) return { ok: false, status: 400, text: 'Unsupported response_format' }
      if (bodies.length === 2) return { ok: true, status: 200, text: JSON.stringify(completion('이미지를 확인했어요.')) }
      return { ok: true, status: 200, text: JSON.stringify(completion('{"description":"고양이가 보여요."}')) }
    }
  }
  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'Describe these images in Korean.' },
    { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
  ] }]
  const result = await callLLM({ provider: 'vision', messages, jsonMode: true })
  assert.deepEqual(JSON.parse(result.content), { description: '고양이가 보여요.' })
  assert.equal(bodies.length, 3)
  assert.match(bodies[0].messages[0].content, /JSON/)
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' })
  assert.ok(bodies.slice(1).every((body) => !Object.hasOwn(body, 'response_format')))
  assert.deepEqual(bodies.map((body) => body.max_completion_tokens), [8192, 8192, 12000])
  assert.equal(bodies.at(-1).temperature, 0)
  for (const body of bodies) {
    assert.deepEqual(body.messages[1], messages[0])
    assert.equal(body.model, 'gpt-5.4-mini')
    assert.equal(body.reasoning_effort, 'none')
    assert.ok(!Object.hasOwn(body, 'max_tokens'))
  }
})
