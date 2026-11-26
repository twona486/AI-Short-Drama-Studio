import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const { finalAnswerText } = await load('../src/services/ai/finalAnswer.ts')
assert.equal(finalAnswerText('<think>{"actions":["wrong"]}</think>正式答案'), '正式答案')
assert.equal(finalAnswerText('<analysis>内部 JSON {"actions":["wrong"]}'), '')
assert.equal(finalAnswerText([{ type: 'reasoning', text: '草稿' }, { type: 'text', text: '正文' }]), '正文')
assert.equal(finalAnswerText(null), '')
assert.equal(finalAnswerText('{"shots":[]}'), '{"shots":[]}')

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/services/ai/openAiRouter.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm'
})
const { normalizeRouterBaseUrl } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
assert.equal(normalizeRouterBaseUrl('https://api.example.com/'), 'https://api.example.com/v1')
assert.equal(normalizeRouterBaseUrl('https://api.example.com/openai/v1/chat/completions/'), 'https://api.example.com/openai/v1')
assert.equal(normalizeRouterBaseUrl('http://127.0.0.1:8181/custom'), 'http://127.0.0.1:8181/custom')
assert.equal(normalizeRouterBaseUrl('http://192.168.1.4:11434'), 'http://192.168.1.4:11434/v1')
assert.equal(normalizeRouterBaseUrl('http://100.127.0.5:11434'), 'http://100.127.0.5:11434/v1')
assert.equal(normalizeRouterBaseUrl('http://worker.example.ts.net'), 'http://worker.example.ts.net/v1')
assert.throws(() => normalizeRouterBaseUrl('http://100.128.0.5:11434'), { kind: 'protocol' })
assert.throws(() => normalizeRouterBaseUrl('http://api.example.com/v1'), { kind: 'protocol' })
assert.throws(() => normalizeRouterBaseUrl('https://api.example.com/v1?key=example'), { kind: 'credentials' })

console.log('통과 · OpenAI 호환 게이트웨이 주소와 추론 출력 분리')
