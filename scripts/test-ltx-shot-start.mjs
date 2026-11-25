import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const source = readFileSync(new URL('../src/services/canvas/runner.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function prepareLtxShotStart(')
const end = source.indexOf('  if (!(shot.compiledVideoPrompt', start)
assert.ok(start >= 0 && end > start)
const { code } = await transform(
  `export function createRunner(deps) {
    const { useProjectStore, useAssetsStore, refreshShot, canvasVideoNodeForShot, videoProfileById,
      canvasVideoModelForShot, isLtxTask, isLtxProfile, shotNodeAspect, tryLoadRefImageBlob,
      getImageConfig, resolveImageAdapter, collectFrameRefBlobs, renderShotFrame, ensureNotCancelled,
      translate, aspectToSize, canvasVideoResolutionForShot, shotVideoAudio, generateVideo,
      setActiveProjectDir } = deps
    ${source.slice(start, end).replace('export async function generateShotVideo', 'async function generateShotVideo')}
    }
    return generateShotVideo
  }`,
  { loader: 'ts', format: 'esm' }
)
const { createRunner } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

function fixture({ firstFrameAssetId, imageAssetId, videoTaskId, imageKey = 'fixture' } = {}) {
  const image = new Blob(['frame'])
  const events = []
  const stored = new Map([['generated', image], ['existing', image]])
  const shot = { id: 'shot', index: 0, visualPrompt: 'Street scene', duration: 12, firstFrameAssetId, imageAssetId, videoTaskId }
  const project = {
    current: { id: 'p' },
    updateShot(_id, patch) {
      Object.assign(shot, patch)
      if (patch.firstFrameAssetId) events.push('assign start')
    },
    async save() { events.push('save') },
    assignShotVideo() {},
    patchCanvasNode() {}
  }
  const node = { id: 'shotVideo:shot', data: {} }
  const run = createRunner({
    useProjectStore: () => project,
    useAssetsStore: () => ({ async add() { return { id: 'mp4' } } }),
    refreshShot: () => ({ ...shot }),
    canvasVideoNodeForShot: () => node,
    videoProfileById: () => ({ id: 'ltx', provider: 'ltx-desktop' }),
    canvasVideoModelForShot: () => 'h3',
    isLtxTask: (id) => id?.startsWith('ltx-desktop:'),
    isLtxProfile: () => true,
    shotNodeAspect: () => '9:16',
    tryLoadRefImageBlob: (id) => stored.get(id),
    getImageConfig: () => ({ apiKey: imageKey, model: 'fixture-model', baseUrl: 'https://example.com' }),
    resolveImageAdapter: () => 'openai-images',
    async collectFrameRefBlobs(_shot, _project, _progress, videoNode) {
      assert.equal(videoNode, node)
      return { blobs: [image], labels: ['scene'], refs: ['scene-image'] }
    },
    async renderShotFrame(_shot, which, blobs, labels, _progress, _signal, context) {
      assert.equal(which, 'start')
      assert.deepEqual(blobs, [image])
      assert.deepEqual(labels, ['scene'])
      assert.deepEqual(context, { referenceIds: ['scene-image'], aspectRatio: '9:16' })
      events.push('render')
      return { id: 'generated' }
    },
    ensureNotCancelled: (signal) => signal?.throwIfAborted(),
    translate: (key) => key,
    aspectToSize: () => ({ width: 720, height: 1280 }),
    canvasVideoResolutionForShot: () => '720p',
    shotVideoAudio: () => true,
    async generateVideo(input) {
      events.push('video')
      assert.equal(input.imageBlob, videoTaskId ? undefined : image)
      assert.equal(input.resumeTaskId, videoTaskId)
      assert.equal(input.prompt, 'Street scene')
      return { blob: new Blob(['movie']), prompt: input.prompt }
    },
    setActiveProjectDir() {}
  })
  return { run: () => run(shot), events, shot }
}

test('시작 이미지가 없으면 참조로 만든 프레임을 저장한 뒤 LTX에 보내고 재실행 때 재사용합니다', async () => {
  const { run, events, shot } = fixture()
  await run()
  assert.equal(shot.firstFrameAssetId, 'generated')
  assert.deepEqual(events.slice(0, 4), ['render', 'assign start', 'save', 'video'])
  await run()
  assert.equal(events.filter((event) => event === 'render').length, 1)
})

test('읽을 수 없는 시작 프레임은 기존 샷 이미지로 대체하고, 재조회에는 이미지 연결이 필요 없습니다', async () => {
  for (const options of [
    { firstFrameAssetId: 'stale', imageAssetId: 'existing' },
    { videoTaskId: 'ltx-desktop:job' }
  ]) {
    const { run, events } = fixture({ ...options, imageKey: '' })
    await run()
    assert.deepEqual(events, ['video', 'save'])
  }
})

test('이미지 연결이 없으면 설정 안내를 반환하고 영상을 제출하지 않습니다', async () => {
  const { run, events } = fixture({ imageKey: '' })
  await assert.rejects(run(), /ltx.startImageSettings/)
  assert.deepEqual(events, [])
})
