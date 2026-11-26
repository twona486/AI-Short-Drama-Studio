import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { once } from 'node:events'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { createServer } from 'vite'
import WebSocket, { WebSocketServer } from 'ws'

const vite = await createServer({
  configFile: false,
  envFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const { requestOpenAiTts, splitSpeech, pcmToWav } = await vite.ssrLoadModule('/electron/openai-tts.ts')
const { useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')
const { getTtsConfig } = await vite.ssrLoadModule('/src/services/ai/runtime.ts')
const { generateSpeech } = await vite.ssrLoadModule('/src/services/ai/tts.ts')
const { saveAsset, setActiveProjectDir } = await vite.ssrLoadModule('/src/services/storage/fs.ts')
const { openAiShotSpeech } = await vite.ssrLoadModule('/src/services/ai/shotSpeech.ts')
const { useProjectStore } = await vite.ssrLoadModule('/src/stores/project.ts')
const { needsExternalTts } = await vite.ssrLoadModule('/src/utils/shot.ts')

const request = {
  apiKey: 'test-openai-tts-key',
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  text: '배송은 11:30에 시작해요. USB-C 3.5mm 모델도 확인해 주세요!',
  instruction: '차분하게'
}

async function mockRealtime(context, output = 'completed') {
  const calls = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => server.close(resolve)))
  server.on('connection', (socket, incoming) => {
    calls.push(incoming.headers.authorization)
    socket.on('message', (data) => {
      const event = JSON.parse(data)
      calls.push(event)
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      if (event.type !== 'response.create' || output === 'wait') return
      if (output === 'error') {
        socket.send(JSON.stringify({ type: 'error', error: { code: 'invalid_api_key', message: request.apiKey } }))
        return
      }
      if (output !== 'empty') {
        for (const sample of [1, 2]) {
          const delta = Buffer.alloc(24000, sample).toString('base64')
          socket.send(JSON.stringify({ type: 'response.output_audio.delta', delta }))
        }
      }
      socket.send(JSON.stringify({ type: 'response.done', response: { status: output === 'empty' ? 'completed' : output } }))
    })
  })
  const connect = (url, options) => {
    assert.equal(url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini')
    return new WebSocket(`ws://127.0.0.1:${server.address().port}`, options)
  }
  return { calls, connect, server }
}

test('한국어·숫자·영문이 섞인 원고와 말투를 보내고 오디오를 WAV로 합칩니다', async (context) => {
  const { calls, connect } = await mockRealtime(context)
  const text = (request.text + '\n').repeat(15)
  const chunks = splitSpeech(text)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 400))
  assert.equal(splitSpeech('🙂'.repeat(401)).map((chunk) => Array.from(chunk).length).join(','), '400,1')
  const { wav, durationMs } = await requestOpenAiTts({ ...request, text }, new AbortController().signal, connect)
  const sessions = calls.filter((call) => call.type === 'session.update')
  const responses = calls.filter((call) => call.type === 'response.create')
  assert.equal(sessions.length, chunks.length)
  assert.equal(calls[0], 'Bearer test-openai-tts-key')
  assert.deepEqual(sessions[0].session.audio.output, { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' })
  assert.match(sessions[0].session.instructions, /차분하게/)
  assert.deepEqual(responses.map((call) => call.response.input[0].content[0].text), chunks)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(20), 1)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 24000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), wav.length - 44)
  assert.equal(wav[44], 1)
  assert.equal(wav[24044], 2)
  assert.equal(durationMs, chunks.length * 1000)
  assert.throws(() => pcmToWav(Buffer.alloc(1)), /PCM/)
})

for (const [output, expected] of [
  ['error', /API 키 또는/],
  ['incomplete', /요청이 실패했습니다/],
  ['empty', /올바른 PCM/]
]) {
  test(`Realtime ${output} 결과를 오류로 표시하고 서버 원문을 숨깁니다`, async (context) => {
    const { connect } = await mockRealtime(context, output)
    await assert.rejects(requestOpenAiTts(request, new AbortController().signal, connect), (error) => {
      assert.match(error.message, expected)
      assert.doesNotMatch(error.message, /test-openai-tts-key/)
      return true
    })
  })
}

test('취소 시 오디오 소켓을 닫습니다', async (context) => {
  const { connect, server } = await mockRealtime(context, 'wait')
  const opened = once(server, 'connection')
  const controller = new AbortController()
  const pending = requestOpenAiTts(request, controller.signal, connect)
  const [socket] = await opened
  const closed = once(socket, 'close')
  controller.abort()
  await assert.rejects(pending, /취소됐습니다/)
  await closed
})

test('새 설치 설정, 공식 언어 모델 키 재사용, 기존 DashScope 연결을 검증합니다', async (context) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let saved = null
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: () => saved, setItem() {} }
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
  const settings = useSettingsStore()
  assert.equal(getTtsConfig().model, 'eleven_v4')
  assert.deepEqual(settings.config.tts.models, ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3'])
  await assert.rejects(generateSpeech({ text: request.text }), /ElevenLabs API 키/)
  settings.addTts({
    name: 'OpenAI TTS', baseUrl: 'https://api.openai.com/v1',
    model: request.model, models: [request.model], provider: 'openai'
  })
  assert.equal(getTtsConfig().voice, 'marin')
  settings.patchLlm({ baseUrl: 'https://api.openai.com/v1', apiKey: 'test-llm-key' })
  settings.patchTts({ reuseOpenAiLlmKey: true })
  assert.equal(getTtsConfig().apiKey, 'test-llm-key')
  settings.patchLlm({ baseUrl: 'https://proxy.example/v1', apiKey: 'test-proxy-key' })
  assert.equal(getTtsConfig().apiKey, '')

  settings.patchTts({ reuseOpenAiLlmKey: false, apiKey: request.apiKey })
  const project = useProjectStore()
  project.current = {
    id: 'tts-fallback-fixture',
    settings: {},
    shots: [{ id: 'shot', audioMode: 'h3-dialogue', voiceover: request.text, duration: 5 }],
    canvas: { nodes: [] }
  }
  await nextTick()
  settings.addVideo({ name: 'Silent', provider: 'custom', baseUrl: 'http://localhost:8199', workflowId: 'silent' })
  await nextTick()
  const [shot] = project.current.shots
  assert.equal(shot.audioMode, 'tts')
  assert.ok(needsExternalTts(shot, project.current))
  const wav = pcmToWav(Buffer.alloc(96000)).wav
  const files = new Map()
  globalThis.window = { desktop: {
    isDesktop: true,
    async kvSet() {},
    async join(...parts) { return posix.join(...parts) },
    async exists(path) { return files.has(path) },
    async writeBuffer(path, buffer) { files.set(path, Buffer.from(buffer)) },
    async writeText(path, text) { files.set(path, text) },
    async openAiTts(payload) {
      assert.equal(payload.text, request.text)
      assert.equal(payload.apiKey, request.apiKey)
      return { wav, durationMs: 2000 }
    }
  } }
  try {
    const result = await generateSpeech(openAiShotSpeech(shot, project.current))
    assert.equal(result.mimeType, 'audio/wav')
    assert.equal(result.durationMs, 2000)
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), wav)
    setActiveProjectDir('/fixture-project')
    await saveAsset({ id: 'dub', kind: 'audio', source: 'ai-generated', mimeType: result.mimeType }, result.blob)
    assert.deepEqual(files.get('/fixture-project/assets/audio/dub.wav'), wav)
  } finally {
    globalThis.window = { addEventListener() {} }
  }

  saved = JSON.stringify({ tts: { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    apiKey: 'test-dashscope-key', model: 'qwen3-tts-flash', models: ['qwen3-tts-flash'], voice: 'Cherry' } })
  setActivePinia(createPinia())
  const legacy = useSettingsStore()
  assert.deepEqual(legacy.config.tts.models, ['qwen3-tts-flash'])
  assert.equal(getTtsConfig().openAi, false)
  assert.equal(getTtsConfig().voice, 'Cherry')
  assert.equal(getTtsConfig().apiKey, 'test-dashscope-key')
})

test('캐릭터 음성 태그, 사용자가 지정한 목소리, 샷 말투를 유지합니다', () => {
  const character = { name: '민서', voicePrompt: 'Female, late 20s, calm' }
  const project = { subjects: [character], settings: { ttsVoice: 'echo' } }
  const shot = { voiceover: `민서: ${request.text}`, duration: 8, ttsInstruction: '조용하게' }
  assert.equal(openAiShotSpeech(shot, project).voice, 'marin')
  assert.equal(openAiShotSpeech(shot, project).text, request.text)
  character.openAiTtsVoice = 'sage'
  const result = openAiShotSpeech(shot, project)
  assert.equal(result.voice, 'sage')
  assert.match(result.instruction, /조용하게/)
  assert.equal(openAiShotSpeech({ ...shot, voiceover: '공지: 11:30에 시작해요.' }, project).text, '공지: 11:30에 시작해요.')
})
