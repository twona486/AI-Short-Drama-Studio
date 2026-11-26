import assert from 'node:assert/strict'
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

const { requestElevenLabs } = await vite.ssrLoadModule('/electron/elevenlabs-tts.ts')
const { elevenLabsShotSpeech } = await vite.ssrLoadModule('/src/services/ai/shotSpeech.ts')
const { joinLipSyncWavs, lipSyncPcm } = await vite.ssrLoadModule('/src/services/ai/lipSyncWav.ts')
const { elevenLabsTaggedText, recommendElevenLabsVoice } = await vite.ssrLoadModule('/src/services/ai/elevenLabsTts.ts')

const { directElevenLabsDelivery, recommendProjectElevenLabsVoice } =
  await vite.ssrLoadModule('/src/services/ai/elevenLabsDelivery.ts')
const { useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')

test('원문, 캐릭터 선택, 말투를 한국어 PCM 요청에 반영하고 립싱크에서 WAV를 읽습니다', async (context) => {
  const text = '11시 30분에 USB-C 케이블 3개를 가져와 주세요.'
  const voice = 'fixture-voice'
  const subject = { id: 'cast', name: '지연', elevenLabsVoiceId: voice, voicePrompt: '차분한 젊은 여성' }
  const shot = { voiceover: `지연: ${text}`, ttsInstruction: '속삭이듯, 불안하게' }
  const previous = { id: 'previous', voiceover: '지연: 그만… 정말요?!\n다시 말해 주세요.' }
  Object.assign(shot, { id: 'current' })
  const delivery = elevenLabsShotSpeech(shot, { subjects: [subject], shots: [previous, shot] })
  assert.equal(delivery.voice, voice)
  assert.equal(delivery.text, text)
  assert.equal(delivery.delivery.previousText, '그만… 정말요?!\n다시 말해 주세요.')
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers['xi-api-key'], 'test-key')
    const body = JSON.parse(init.body)
    assert.equal(body.language_code, 'ko')
    assert.equal(body.model_id, 'eleven_v4')
    assert.equal(body.text, `[whispers] [anxiously] ${text}`)
    assert.deepEqual(body.voice_settings, { stability: 0.4, similarity_boost: 0.75 })
    assert.equal(body.previous_text, delivery.delivery.previousText)
    return new Response(new Uint8Array(48_000), { headers: { 'character-cost': '18' } })
  })
  const result = await requestElevenLabs('test-key', { kind: 'speech', model: 'eleven_v4', voice,
    text: elevenLabsTaggedText(delivery.text, delivery.instruction), previousText: delivery.delivery.previousText }, new AbortController().signal)
  assert.equal(result.kind, 'speech')
  assert.equal(result.durationMs, 1000)
  assert.equal(result.credits, 18)
  const wav = result.wav.buffer.slice(result.wav.byteOffset, result.wav.byteOffset + result.wav.byteLength)
  assert.equal(lipSyncPcm(wav).byteLength, 48_000)
  const lipSync = joinLipSyncWavs([wav])
  assert.equal(lipSync.duration, 1)
  assert.equal(lipSync.uploadDuration, 50 / 24)
})

test('공유 라이브러리에서 한국어와 검색어를 사용하고 요청을 취소합니다', async (context) => {
  const controller = new AbortController()
  const voice = { voice_id: 'fixture', name: 'Voice', gender: 'female', age: 'young', descriptive: 'soft' }
  const fetch = context.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url)
    assert.equal(request.pathname, '/v1/shared-voices')
    assert.equal(request.searchParams.get('language'), 'ko')
    assert.equal(request.searchParams.get('search'), '지연')
    assert.equal(request.searchParams.get('page'), '2')
    return new Response(JSON.stringify({ voices: [voice], has_more: true }))
  })
  const operation = { kind: 'voices', source: 'library', search: '지연', cursor: '2' }
  const result = await requestElevenLabs('test-key', operation, controller.signal)
  assert.deepEqual(result, {
    kind: 'voices', next: '3', voices: [{ id: 'fixture', name: 'Voice', korean: true, traits: 'female young soft' }]
  })
  fetch.mock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  const pending = requestElevenLabs('test-key', operation, controller.signal)
  controller.abort()
  assert.deepEqual(await pending, { kind: 'cancelled' })
})

test('언어 모델이 장면 맥락을 보고 태그만 붙이며 직접 쓴 태그는 그대로 보냅니다', async (context) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: () => null, setItem() {} }
  })
  globalThis.window = { addEventListener() {} }
  context.after(() => {
    delete globalThis.window
    delete globalThis.localStorage
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
  })
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  settings.addLlm({ name: 'fixture', baseUrl: 'https://example.com/v1', apiKey: 'fake', model: 'fixture', models: ['fixture'] })
  const text = '아직이야… 정말 몰랐어?\n뒤로 가!'
  const instruction = '서울 표준어, 자연스러운 한국 드라마 대사 억양.'
  const delivery = { scene: '한밤중 승강장', voiceDescription: '중년 남성', nextDialogue: '연우: 알겠습니다.' }
  const fetch = context.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { messages } = JSON.parse(init.body)
    assert.deepEqual(JSON.parse(messages[1].content), {
      instruction, dialogue: text, scene: delivery.scene, voice: delivery.voiceDescription, nextDialogue: delivery.nextDialogue
    })
    return new Response(JSON.stringify({
      choices: [{ message: { content: '[calm] [standard Seoul Korean accent]' } }]
    }))
  })
  assert.equal(await directElevenLabsDelivery(text, instruction, delivery),
    `[calm] [standard Seoul Korean accent] ${text}`)
  const explicit = '[whispers] [Sighs] [calm] [firmly] [slowly]'
  assert.equal(await directElevenLabsDelivery(text, `조용하게 ${explicit}`, delivery), `${explicit} ${text}`)
  assert.equal(fetch.mock.callCount(), 1)
})

test('한국어 음색 추천에서 기존에 선택한 목소리와 다른 자동 캐스팅을 사용합니다', () => {
  const voices = [
    { id: 'unavailable', korean: false, traits: 'female young soft' },
    { id: 'manual', korean: true, traits: 'female young soft' },
    { id: 'soft', korean: true, traits: 'female young soft' },
    { id: 'calm', korean: true, traits: 'female young calm' }
  ]
  const subjects = [
    { id: 'a', voicePrompt: '젊고 부드러운 여성' },
    { id: 'b', voicePrompt: '젊고 부드러운 여성' },
    { id: 'c', elevenLabsVoiceId: 'manual' }
  ]
  assert.equal(recommendElevenLabsVoice('젊고 부드러운 여성', voices)?.id, 'manual')
  assert.equal(recommendProjectElevenLabsVoice(subjects, 'a', voices, ''), 'soft')
  assert.equal(recommendProjectElevenLabsVoice(subjects, 'b', voices, ''), 'calm')
  assert.equal(recommendProjectElevenLabsVoice(subjects, 'c', voices, ''), 'manual')
})

test('공유 목소리를 선택하면 계정에 추가해 돌려받은 목소리 ID를 사용합니다', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/voices/add/owner/shared-voice')
    assert.deepEqual(JSON.parse(init.body), { new_name: '한국어 목소리' })
    return new Response(JSON.stringify({ voice_id: 'account-voice' }))
  })
  assert.deepEqual(await requestElevenLabs('test-key', {
    kind: 'addVoice', publicUserId: 'owner', voice: 'shared-voice', name: ' 한국어 목소리 '
  }, new AbortController().signal), { kind: 'addVoice', voice: 'account-voice' })
})
