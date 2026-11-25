import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const vite = await createServer({
  configFile: false, envFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const { videoDurationCapability: caps, shotDurationWarning, nearestVideoDuration } =
  await vite.ssrLoadModule('/src/services/ai/videoDuration.ts')
const { normalizeStoryboard } = await vite.ssrLoadModule('/src/services/ai/storyboard.ts')

test('모델과 해상도에 따라 허용 길이와 상한을 선택합니다', () => {
  assert.equal(caps().max, 15)
  assert.equal(caps({ model: 'h3-v5' }).max, 10)
  assert.equal(caps({ model: 'wan-prime' }).max, 30)
  assert.equal(caps({ profile: { workflowId: 'grok-imagine-1.5-video' } }).durations[0], 6)
  assert.equal(caps({ profile: { provider: 'ltx', workflowId: 'ltx-2-5-fast' } }).max, 20)
  assert.deepEqual(caps({ profile: { provider: 'ltx', workflowId: 'ltx-2-5-pro' } }).durations, [6, 8, 10])
  for (const workflowId of ['ltx-2.3-fast', 'ltx-2.5-fast']) {
    const profile = { provider: 'ltx-desktop', workflowId }
    assert.deepEqual(caps({ profile, resolution: '720p' }).durations, [2, 3, 4, 5, 6, 8, 10])
    assert.equal(caps({ profile, resolution: '1080p' }).max, 10)
    assert.equal(caps({ profile, resolution: '540p' }).max, 20)
  }
})

test('기존 샷 경고는 저장 길이와 현재 모델의 최대 길이를 비교합니다', () => {
  const existing = { duration: 12 }
  const lan = caps({ profile: { provider: 'ltx-desktop', workflowId: 'ltx-2.5-fast' } })
  assert.equal(shotDurationWarning(existing.duration, lan.max), true)
  assert.equal(nearestVideoDuration(existing.duration, lan.durations), 10)
  assert.equal(existing.duration, 12)
  assert.equal(shotDurationWarning(existing.duration, caps().max), false)
  assert.equal(shotDurationWarning(10, lan.max), false)
})

test('추출 후 너무 긴 샷을 나누고 화자와 원문 순서를 보존합니다', () => {
  const original = '가나다라마바사아자차카타파하'.repeat(4)
  const durations = [5, 6, 8, 10]
  const { shots } = normalizeStoryboard({
    shots: [{ title: '역 앞', duration: 14, voiceover: '수연: ' + original, visualPrompt: 'Wide view of a station.' }]
  }, { maxShotDuration: 10, allowedShotDurations: durations })
  assert.ok(shots.length > 1)
  assert.ok(shots.every((shot) => durations.includes(shot.duration)))
  assert.ok(shots.every((shot) => shot.voiceover.startsWith('수연:')))
  assert.equal(shots.map((shot) => shot.voiceover.replace(/^수연:\s*/, '')).join(''), original)
  assert.ok(shots.every((shot) => shot.voiceover.replace(/^수연:\s*/, '').length <= shot.duration * 4))
})

test('음성 능력표에서 LTX는 지원하고 무음 연결은 미지원입니다', () => {
  assert.equal(caps({ profile: { provider: 'autodl' } }).voice, 'supported')
  assert.equal(caps({ profile: { provider: 'ltx-desktop' } }).voice, 'supported')
  assert.equal(caps({ profile: { provider: 'ltx' } }).voice, 'supported')
  assert.equal(caps({ profile: { provider: 'custom' } }).voice, 'unsupported')
  assert.equal(caps({ profile: { provider: 'custom', options: { videoAudio: true } } }).voice, 'supported')
  assert.equal(caps({ profile: { provider: 'autodl', options: { videoAudio: false } } }).voice, 'unsupported')
})

test('미지원 연결의 샷은 TTS로 전환하고 노드별 지원 연결과 무음 선택은 유지합니다', async (context) => {
  globalThis.window = { addEventListener() {} }
  globalThis.document = { addEventListener() {} }
  context.after(() => { delete globalThis.window; delete globalThis.document })
  const { useProjectStore } = await vite.ssrLoadModule('/src/stores/project.ts')
  const { useSettingsStore } = await vite.ssrLoadModule('/src/stores/settings.ts')
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  await settings.ensureHydrated()
  const supported = settings.config.activeVideoId
  const project = useProjectStore()
  project.current = {
    id: 'fixture',
    shots: [
      { id: 'a', audioMode: 'h3-dialogue', videoAssetId: 'previous' },
      { id: 'b', audioMode: 'h3-voiceover' },
      { id: 'c', audioMode: 'none' }
    ],
    canvas: { nodes: [{ type: 'shotVideo', data: { shotId: 'b', videoProfileId: supported } }] }
  }
  await nextTick()
  settings.addVideo({ name: 'Silent', provider: 'custom', baseUrl: 'http://localhost:8199', workflowId: 'silent' })
  await nextTick()
  assert.deepEqual(project.current.shots.map((shot) => shot.audioMode), ['tts', 'h3-voiceover', 'none'])
  assert.equal(project.current.shots[0].videoAssetId, 'previous')
  assert.equal(project.shotSupportsVideoVoice(project.current.shots[0]), false)
  assert.equal(project.shotSupportsVideoVoice(project.current.shots[1]), true)
  project.setShotAudioMode('a', 'h3-voiceover')
  assert.equal(project.current.shots[0].audioMode, 'tts')
})

const { ltxShotPrompt, ltxShotSpeechTooFast } = await vite.ssrLoadModule('/src/services/ai/ltxShotPrompt.ts')
test('LTX 프롬프트는 원어 대사를 인용하고 TTS에는 대사를 넣지 않습니다', () => {
  const shot = {
    audioMode: 'h3-dialogue',
    voiceover: '지우: 기차가 곧 도착해요.\n민지: 좋아요.',
    compiledVideoPrompt: 'Steam drifts across the platform.\nJiwoo says "기차가 곧 도착해요."\n<d>이전 대사</d>'
  }
  const dialogue = ltxShotPrompt(shot, 'Soft and urgent.')
  assert.match(dialogue, /지우 says in Korean: "기차가 곧 도착해요\."/)
  assert.match(dialogue, /민지 says in Korean: "좋아요\."/)
  assert.match(dialogue, /Soft and urgent/)
  assert.doesNotMatch(dialogue, /이전 대사|\n/)
  const dub = ltxShotPrompt({ ...shot, audioMode: 'tts' })
  assert.match(dub, /no speech, ambient sound only/)
  assert.doesNotMatch(dub, /도착해요|좋아요|이전 대사/)
  assert.match(ltxShotPrompt({ ...shot, audioMode: 'h3-voiceover' }), /off-screen narrator/)
  assert.match(ltxShotPrompt({ ...shot, voiceover: '' }), /no speech, ambient sound only/)
  assert.equal(ltxShotSpeechTooFast(shot, 1), true)
  assert.equal(ltxShotSpeechTooFast(shot, 5), false)
  assert.equal(ltxShotSpeechTooFast({ ...shot, audioMode: 'tts' }, 1), false)
})
