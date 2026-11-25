import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

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
