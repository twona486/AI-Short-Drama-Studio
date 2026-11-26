/**
 * AutoDL 결과 파싱과 Node에서의 COS 영상 다운로드를 검증한다.
 * 실행 방법은 node scripts/test-video-result.mjs이다.
 * 라이브 검사는 TEST_LIVE_VIDEO_RESULT=1로 켜고 AUTODL_TOKEN과 TASK_ID를 직접 지정한다.
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SAMPLE_RESULTS = [
  {
    type: 'video',
    output_type: 'output',
    url: 'https://codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com/comfyui/outputs/2026/08/25/fbb7ef58-20a5-48e7-b984-9da4ea88203e/b81b3c26-68f3-45e9-9b50-8fe86f3df053.mp4',
    file_type: 'mp4',
    alias: 'final_video',
    description: 'Final generated video'
  }
]

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i

function resultUrl(r) {
  const candidates = [r?.url, r?.video_url, r?.videoUrl, r?.file_url, r?.filename]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return ''
}

function pickWorkflowVideoResult(results) {
  const scored = results
    .map((r) => {
      const url = resultUrl(r)
      if (!url) return null
      const type = String(r?.type ?? r?.raw?.type ?? '').toLowerCase()
      const blobText = JSON.stringify(r).toLowerCase()
      let score = 0
      if (VIDEO_EXT_RE.test(url)) score += 100
      if (IMAGE_EXT_RE.test(url)) score -= 100
      if (/video/.test(type)) score += 40
      if (type === 'image' && !VIDEO_EXT_RE.test(url)) score -= 30
      if (/mp4|webm|mov|video/.test(blobText) && VIDEO_EXT_RE.test(url)) score += 10
      return { url, type, score }
    })
    .filter(Boolean)
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 50 || !/^https?:\/\//i.test(best.url)) return null
  return best
}

function unwrapTaskPayload(json) {
  if (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) return json.data
  return json
}

function harvestMediaItems(value, out = [], depth = 0) {
  if (value == null || depth > 8) return out
  if (typeof value === 'string') {
    const url = value.trim()
    if (/^https?:\/\//i.test(url)) out.push({ url })
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestMediaItems(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    if (value.url || value.video_url || value.videoUrl || value.filename || value.file_url) out.push(value)
    for (const nested of Object.values(value)) harvestMediaItems(nested, out, depth + 1)
  }
  return out
}

function collectWorkflowResults(json) {
  const data = unwrapTaskPayload(json)
  const buckets = [data?.results, json?.results, json?.data, data, json]
  const seen = new Set()
  const out = []
  for (const bucket of buckets) {
    for (const item of harvestMediaItems(bucket)) {
      const url = resultUrl(item)
      const key = url || JSON.stringify(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

function mask(token) {
  const s = String(token || '')
  if (s.length < 8) return s ? '(too short)' : '(empty)'
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`
}

async function downloadHead(url) {
  const started = Date.now()
  const res = await fetch(url, { redirect: 'follow' })
  const buf = Buffer.from(await res.arrayBuffer())
  const head = buf.subarray(0, 12)
  const ascii = head.subarray(4, 8).toString('ascii')
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    size: buf.length,
    ms: Date.now() - started,
    magic: [...head].map((n) => n.toString(16).padStart(2, '0')).join(' '),
    isMp4: ascii === 'ftyp'
  }
}

async function main() {
  console.log('\n=== 1) Parse the sample results array ===')
  const pickedRaw = pickWorkflowVideoResult(SAMPLE_RESULTS)
  assert.equal(pickedRaw?.url, SAMPLE_RESULTS[0].url)

  const envelopes = [
    { code: 'Success', data: { status: 'SUCCESS', results: SAMPLE_RESULTS } },
    { code: 'Success', data: { status: 'RUNNING', results: SAMPLE_RESULTS } },
    { code: 'Success', data: SAMPLE_RESULTS },
    SAMPLE_RESULTS
  ]
  for (const [i, env] of envelopes.entries()) {
    const results = collectWorkflowResults(env)
    const picked = pickWorkflowVideoResult(results)
    assert.equal(picked?.url, SAMPLE_RESULTS[0].url, `envelope ${i + 1}`)
  }

  if (process.env.TEST_LIVE_VIDEO_RESULT !== '1') return
  const outDir = join(process.cwd(), 'tmp')
  mkdirSync(outDir, { recursive: true })
  const videoUrl = SAMPLE_RESULTS[0].url
  console.log('\n=== 2) Download COS MP4 from Node ===')
  console.log('url:', videoUrl)
  try {
    const info = await downloadHead(videoUrl)
    console.log(info)
    writeFileSync(join(outDir, 'video-result-test.json'), JSON.stringify(info, null, 2))
    if (info.ok && info.isMp4) console.log('Downloaded a valid MP4.')
    else if (info.ok) console.log('Downloaded the file, but its header is not MP4.')
    else console.log('Download failed.')
  } catch (e) {
    console.log('Download error:', e?.message || e)
  }

  const token = process.env.AUTODL_TOKEN || ''
  const taskId = process.env.TASK_ID || ''
  console.log('\n=== 3) Poll AutoDL ===')
  console.log('token:', mask(token))
  if (!token) {
    console.log('Skipping polling. Set AUTODL_TOKEN to run it.')
    return
  }
  if (!taskId) {
    console.log('No TASK_ID set. Checking the AutoDL token only.')
    const ping = await fetch('https://autodl.art/api/v1/comfyui/comfyui_workflow/result/ping-test', {
      headers: { Authorization: token }
    })
    const text = await ping.text()
    console.log('poll ping status:', ping.status, text.slice(0, 300))
    return
  }
  const poll = await fetch(
    `https://autodl.art/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`,
    { headers: { Authorization: token } }
  )
  const text = await poll.text()
  console.log('poll status:', poll.status)
  console.log('poll body:', text.slice(0, 800))
  try {
    const json = JSON.parse(text)
    const results = collectWorkflowResults(json)
    const picked = pickWorkflowVideoResult(results)
    console.log('parsed status:', unwrapTaskPayload(json)?.status)
    console.log('picked:', picked)
  } catch {
    console.log('Poll response was not JSON')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
