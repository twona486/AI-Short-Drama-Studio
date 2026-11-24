/**
 * 현재 LLM 연결에서 대본 일부를 단일 샷으로 만들 수 있는지 확인한다.
 *
 * 실행 방법
 *   node scripts/diagnose-storyboard-llm.mjs [project.json]
 *
 * Documents/AI-Cut/app.db에서 활성 LLM 설정을 읽는다. API 키는 출력하거나 저장하지 않는다.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.join(os.homedir(), 'Documents', 'AI-Cut')
const defaultProject = path.join(root, '333_p_mtivvuw3', 'project.json')
const projectPath = path.resolve(process.argv[2] || defaultProject)
const dbPath = path.join(root, 'app.db')

if (!existsSync(projectPath)) throw new Error(`Project not found: ${projectPath}`)
if (!existsSync(dbPath)) throw new Error(`Settings database not found: ${dbPath}`)

const db = new DatabaseSync(dbPath, { readOnly: true })
const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('settings')
db.close()
if (!row?.value) throw new Error('No settings record in app.db')

const settings = JSON.parse(row.value)
const profiles = Array.isArray(settings.llms) ? settings.llms : []
const active = profiles.find((item) => item.id === settings.activeLlmId) || settings.llm || profiles[0]
if (!active?.baseUrl || !active?.apiKey || !active?.model) {
  throw new Error('The active LLM is missing its endpoint, API key, or model name')
}

const project = JSON.parse(await readFile(projectPath, 'utf8'))
const script = String(project?.script?.content || '').trim()
if (!script) throw new Error('The project has no script body')
const looksLikeBrief =
  script.length < 300 &&
  /(?:类型|主题|主角|要求|时长|画幅|장르|주제|주인공|요구 사항|길이|화면 비율|Genre|Theme|Protagonist|Requirements|Duration|Aspect ratio)[：:]/i.test(script) &&
  !/(?:^|\n)#{1,4}\s+|(?:内景|外景|실내|실외|INT[.]?|EXT[.]?)\s*[｜|]/im.test(script)

// 화면과 제작 파서를 거치지 않고 샷 하나를 생성해 모델과 API 연결을 검증한다.
const messages = [
  {
    role: 'system',
    content:
      'You are a film storyboard director. Design one filmable, dynamic shot from the supplied script excerpt. Include opening framing, a trigger, continuous action and reactions, camera movement, and closing framing. Return only the shot, with no template or commentary.'
  },
  {
    role: 'user',
    content: `Design the first shot from the following script. Write the shot title, framing and camera movement, visual action, audio or dialogue, and suggested duration in Korean.\n\n${script.slice(0, 5000)}`
  }
]

const body = {
  model: active.model,
  messages,
  temperature: 0.35,
  max_tokens: 1200
}
const url = `${String(active.baseUrl).replace(/\/+$/, '')}/chat/completions`
const started = performance.now()
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 120_000)
let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${active.apiKey}`
    },
    body: JSON.stringify(body),
    signal: controller.signal
  })
} finally {
  clearTimeout(timer)
}
const elapsedMs = Math.round(performance.now() - started)
const responseText = await response.text()
if (!response.ok) {
  throw new Error(`LLM HTTP ${response.status}，${elapsedMs}ms：${responseText.slice(0, 500)}`)
}

const data = JSON.parse(responseText)
const message = data?.choices?.[0]?.message || {}
const content = String(message.content || message.reasoning_content || '').trim()
if (!content) throw new Error(`LLM responded successfully in ${elapsedMs} ms but returned an empty body`)

const reportDir = path.join(process.cwd(), 'diagnostics')
await mkdir(reportDir, { recursive: true })
const reportPath = path.join(reportDir, 'storyboard-llm-result.txt')
const report = [
  `project=${projectPath}`,
  `model=${data.model || active.model}`,
  `elapsedMs=${elapsedMs}`,
  `scriptChars=${script.length}`,
  `responseChars=${content.length}`,
  '',
  content
].join('\n')
await writeFile(reportPath, report, 'utf8')

console.log(`${data.model || active.model} returned ${content.length} characters in ${elapsedMs} ms.`)
if (looksLikeBrief) {
  console.log('The input appears to be a creative brief. The model had to infer missing story details.')
}
console.log(`Raw result: ${reportPath}`)
console.log('---')
console.log(content)
