import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({
  entryPoints: ['src/utils/enterShortcut.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const { runEnterShortcut } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)

function checkEnter(properties, expectedCalls) {
  const calls = []
  runEnterShortcut({
    isComposing: false,
    keyCode: 13,
    repeat: false,
    preventDefault: () => calls.push('preventDefault'),
    ...properties
  }, () => calls.push('action'))
  assert.deepEqual(calls, expectedCalls)
}

checkEnter({ isComposing: true }, [])
checkEnter({ keyCode: 229 }, [])
checkEnter({ isComposing: true, keyCode: 229 }, [])
checkEnter({ repeat: true }, ['preventDefault'])
checkEnter({}, ['preventDefault', 'action'])

console.log('PASS: IME confirmation remains unhandled, repeated Enter does not send, and ordinary Enter sends once')
