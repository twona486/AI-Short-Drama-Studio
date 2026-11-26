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
const { generateStoryboard } = await server.ssrLoadModule('/src/services/ai/storyboard.ts')
const { LLM_PROVIDERS, VISION_PROVIDERS, IMAGE_PROVIDERS, suggestedPresetModels, applyProviderPreset } =
  await server.ssrLoadModule('/src/services/ai/providers.ts')

function loadSettings(context, saved, { onSave = () => {}, desktop } = {}) {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network request')
  })
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => saved ? JSON.stringify(saved) : null, setItem: onSave }
  })
  globalThis.window = { desktop, addEventListener() {} }
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

test('저장된 중국어 기본 이름만 한국어로 바꾸고 다시 저장해요', (context) => {
  const makeProfile = (id, name, options = {}) => ({
    id, name, baseUrl: 'https://example.com/v1', apiKey: 'test-profile',
    model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], ...options
  })
  const workflowId = 'minimax_h3_lightx2v_v5_15s'
  const saved = {
    llms: [makeProfile('llm', '默认 LLM'), makeProfile('custom', '默认 LLM (회사)')],
    visions: [makeProfile('vision', '默认视觉')],
    images: [
      makeProfile('image', '默认生图'),
      makeProfile('comfy', 'ComfyUI 工作流', { adapter: { type: 'comfyui-prompt' } }),
      makeProfile('zealman-image', 'Zealman 生图 · A01-文生图-Qwen2512高清放大', {
        provider: 'zealman', model: 'API-A01-文生图-Qwen2512高清放大'
      })
    ],
    ttsProfiles: [makeProfile('tts', '默认配音')],
    videos: [
      { id: 'video', name: '默认视频', workflowId, baseUrl: 'https://autodl.art', apiKey: '' },
      { id: 'autodl', name: 'H3 图生视频 · 15 秒', workflowId, baseUrl: 'https://autodl.art', apiKey: '' },
      { id: 'unrelated', name: 'H3 图生视频 · 15 秒', workflowId, baseUrl: 'https://example.com', provider: 'custom', apiKey: '' },
      { id: 'zealman-video', name: 'U01-minimax_h3_light2v多图参考生视频加速版',
        workflowId: 'U01-minimax_h3_light2v多图参考生视频加速版', baseUrl: 'https://example.com', provider: 'zealman' }
    ],
    musics: [makeProfile('music', '默认配乐')],
    activeLlmId: 'llm',
    directorSkill: { name: '导演手册', filename: 'guide.md', body: 'Use dialogue to move the story forward.', importedAt: 1 }
  }
  const writes = []
  const { config } = loadSettings(context, saved, { onSave: (_key, value) => writes.push(JSON.parse(value)) })
  assert.equal(config.activeLlmId, 'llm')
  assert.equal(config.llm.model, 'deepseek-v4-flash')
  assert.equal(config.llm.apiKey, 'test-profile')
  assert.deepEqual(config.llms.map(({ name }) => name), ['기본 언어 모델', '默认 LLM (회사)'])
  assert.equal(config.visions[0].name, '기본 이미지 이해')
  assert.deepEqual(config.images.slice(0, 2).map(({ name }) => name), ['기본 이미지 생성', 'ComfyUI 워크플로'])
  assert.match(config.images[2].name, /^Zealman 이미지 생성/)
  assert.equal(config.ttsProfiles[0].name, '기본 더빙')
  assert.deepEqual(config.videos.slice(0, 3).map(({ name }) => name), ['기본 영상', 'H3 이미지→영상 · 15초', 'H3 图生视频 · 15 秒'])
  assert.match(config.videos[3].name, /^U01/)
  assert.notEqual(config.videos[3].name, saved.videos[3].name)
  assert.equal(config.musics[0].name, '기본 배경 음악')
  assert.equal(config.directorSkill.name, '감독 매뉴얼')
  assert.equal(writes.length, 1)
  const savedAgain = writes[0]
  for (const key of ['llms', 'visions', 'images', 'ttsProfiles', 'videos', 'musics']) {
    assert.deepEqual(savedAgain[key].map(({ name, ...rest }) => rest), saved[key].map(({ name, ...rest }) => rest))
  }
  assert.deepEqual({ ...savedAgain.directorSkill, name: saved.directorSkill.name }, saved.directorSkill)
  loadSettings(context, savedAgain, { onSave: (_key, value) => writes.push(JSON.parse(value)) })
  assert.equal(writes.length, 1)
})

test('데스크톱 설정 DB에도 바꾼 이름을 저장해요', async (context) => {
  const profile = {
    id: 'legacy', name: '默认 LLM', baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-deepseek', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash']
  }
  const writes = []
  const settings = loadSettings(context, null, { desktop: {
    isDesktop: true,
    async dbPath() { return 'test.sqlite' },
    async kvGet() { return JSON.stringify({ llms: [profile], activeLlmId: profile.id }) },
    async kvSet(_key, value) { writes.push(JSON.parse(value)) }
  } })
  await settings.ensureHydrated()
  assert.equal(writes.at(-1).activeLlmId, profile.id)
  const { options, ...savedProfile } = writes.at(-1).llms[0]
  assert.deepEqual(savedProfile, { ...profile, name: '기본 언어 모델' })
})

test('손상된 필드만 복구하고 설정 원문은 덮어쓰지 않습니다', async (context) => {
  const raw = JSON.stringify({
    llms: [{ id: 'work', name: '업무 연결', baseUrl: 'https://example.com/v1', apiKey: 'test-key',
      model: 'valid-model', models: ['other-model', false] }],
    activeLlmId: 'work',
    video: { baseUrl: { invalid: true }, apiKey: 'test-video-key', workflowId: 'custom-workflow' },
    autoSaveInterval: 'invalid'
  })
  const backups = []
  const writes = []
  const settings = loadSettings(context, null, {
    onSave: (_key, value) => writes.push(value),
    desktop: {
      isDesktop: true,
      async dbPath() { return 'test.sqlite' },
      async kvGet() { return raw },
      async kvSet(_key, value) { writes.push(value) },
      async backupSettings(text) { backups.push(text); return 'backup.json' }
    }
  })
  await settings.ensureHydrated()
  assert.equal(settings.config.activeLlmId, 'work')
  assert.equal(settings.config.llm.apiKey, 'test-key')
  assert.deepEqual(settings.config.llm.models, ['other-model', 'valid-model'])
  assert.equal(settings.config.video.apiKey, 'test-video-key')
  assert.equal(typeof settings.config.video.baseUrl, 'string')
  assert.equal(typeof settings.config.autoSaveInterval, 'number')
  settings.update({ debug: true })
  await assert.rejects(settings.flush(), /기존 설정을 보존했습니다/)
  assert.deepEqual(backups, [raw])
  assert.deepEqual(writes, [])
})

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
  assert.equal(settings.config.image.model, 'gpt-image-2.6-sunburst')
  assert.equal(settings.config.video.workflowId, 'minimax_h3_lightx2v_v5_15s')
  assert.equal(settings.config.tts.model, 'eleven_v4')
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

test('저장된 스타일 표시명으로 캐릭터·장면·스토리보드를 차례로 추출해요', async (context) => {
  const settings = loadSettings(context)
  settings.patchLlm({ apiKey: 'test-openai' })
  const prompts = []
  const shot = {
    title: '벽시계 아래', subjectNames: ['지우'], sceneName: '역 대합실',
    visualPrompt: 'Early light slants over pale floor tiles.', duration: 6,
    videoPrompt: '0–3s: A wide shot tracks Jiwoo into the waiting room. 3–6s: The camera settles as Jiwoo stops under the clock.',
    continuity: '빈 대합실 → 지우가 시계 아래에 멈춘다 → 시계 아래에 선 지우.',
    audioMode: 'h3-dialogue', voiceover: '지우: 아직 늦지 않았어.'
  }
  globalThis.fetch = async (_url, init) => {
    const { messages } = JSON.parse(init.body)
    const system = messages.find(({ role }) => role === 'system').content
    prompts.push(system)
    const answer = system.includes('Extract only physical filming locations')
      ? { h3Aesthetic: 'Layered transparent washes and a soft gray palette.', scenes: [{ name: '역 대합실', description: '천장이 높고 회색 타일 바닥이 펼쳐진 공간이에요.', mainAnchor: '벽시계', lighting: '새벽빛' }] }
      : system.includes('소품만 추출')
        ? { props: [] }
        : system.includes('Check only jumps')
          ? { issues: [] }
          : system.includes('Return JSON: {"shots"')
            ? { shots: [shot] }
            : { subjects: [{ name: '지우', kind: 'person', description: '오래된 점퍼를 입어요.' }] }
    return Response.json(completion(JSON.stringify(answer)))
  }
  const input = {
    topic: '새벽 역',
    content: '# 새벽 역\n\n## 장면 1 | 역 대합실\n\n지우가 벽시계 아래에 멈춰 선다.\n\n**지우:** 아직 늦지 않았어.',
    style: '🖌 수채화',
    shotDuration: 6,
    maxShotDuration: 10,
    allowedShotDurations: [2, 3, 4, 5, 6, 8, 10],
    aspectRatio: '16:9',
    mode: 'extract'
  }
  const subjects = (await generateStoryboard({ ...input, extractStartAt: 'subjects', extractStopAfter: 'subjects' })).result.subjects
  assert.deepEqual(subjects.map(({ name }) => name), ['지우'])
  const { scenes } = (await generateStoryboard({ ...input, extractStartAt: 'scenes', extractStopAfter: 'scenes', existingSubjects: subjects })).result
  assert.deepEqual(scenes.map(({ name }) => name), ['역 대합실'])
  assert.ok(prompts.some((prompt) => prompt.includes('Style ID: watercolor')))
  const shots = (await generateStoryboard({
    ...input,
    extractStartAt: 'shots',
    extractStopAfter: 'shots',
    existingSubjects: subjects,
    existingScenes: scenes
  })).result.shots
  assert.ok(prompts.some((prompt) => prompt.includes('allows at most 10 seconds per shot') && prompt.includes('2, 3, 4, 5, 6, 8, 10')))
  assert.equal(shots[0].title, '벽시계 아래')
  assert.match(shots[0].visualPrompt, /Watercolor/)
  assert.match(shots[0].voiceover, /아직 늦지 않았어/)
})

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
