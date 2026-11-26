import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
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
const { recommendElevenLabsVoice } = await vite.ssrLoadModule('/src/services/ai/elevenLabsTts.ts')

test('원문, 캐릭터 선택, 말투를 한국어 PCM 요청에 반영하고 립싱크에서 WAV를 읽습니다', async (context) => {
  const text = '11시 30분에 USB-C 케이블 3개를 가져와 주세요.'
  const voice = '9XzsrrLgecsKnylK9yxi'
  const subject = { id: 'cast', name: '지연', elevenLabsVoiceId: voice, voicePrompt: '차분한 젊은 여성' }
  const shot = { voiceover: `지연: ${text}`, ttsInstruction: '속삭이듯, 불안하게' }
  const delivery = elevenLabsShotSpeech(shot, { subjects: [subject] }, 'fallback')
  assert.equal(delivery.voice, voice)
  assert.equal(delivery.text, text)
  assert.equal(recommendElevenLabsVoice('', '승객').name, 'JasonK')
  assert.equal(recommendElevenLabsVoice('젊고 부드러운 여성').name, 'Siyeong')
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers['xi-api-key'], 'test-key')
    const body = JSON.parse(init.body)
    assert.equal(body.language_code, 'ko')
    assert.equal(body.model_id, 'eleven_v4')
    assert.equal(body.text, `[whispers] [anxiously] ${text}`)
    return new Response(new Uint8Array(48_000), { headers: { 'character-cost': '18' } })
  })
  const result = await requestElevenLabs('test-key', { kind: 'speech', model: 'eleven_v4', ...delivery }, new AbortController().signal)
  assert.equal(result.kind, 'speech')
  assert.equal(result.durationMs, 1000)
  assert.equal(result.credits, 18)
  const wav = result.wav.buffer.slice(result.wav.byteOffset, result.wav.byteOffset + result.wav.byteLength)
  assert.equal(lipSyncPcm(wav).byteLength, 48_000)
  assert.equal(joinLipSyncWavs([wav]).duration, 2)
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
  await assert.rejects(pending, /취소했습니다/)
})
