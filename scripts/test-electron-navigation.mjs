import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['electron/window-navigation.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false
})
const { guardWindowNavigation } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'))

test('앱의 팝업을 거부하고 HTTP(S) 링크만 시스템 브라우저에 위임합니다', () => {
  const opened = []
  const handlers = new Map()
  let popup
  const entry = new URL('aicut-app://app/index.html')
  guardWindowNavigation({
    setWindowOpenHandler(handler) { popup = handler },
    on(event, handler) { handlers.set(event, handler) }
  }, entry, async (url) => { opened.push(url) })

  for (const url of ['http://example.com/', 'https://example.com/', 'file:///sample', 'about:blank', 'mailto:help@example.com', entry.href]) {
    assert.deepEqual(popup({ url }), { action: 'deny' })
  }

  function navigate(url) {
    let prevented = false
    handlers.get('will-navigate')({ url, preventDefault() { prevented = true } })
    return prevented
  }

  assert.equal(navigate(entry.href + '#/settings'), false)
  assert.equal(navigate('https://example.com/next'), true)
  assert.equal(navigate('file:///sample'), true)
  assert.deepEqual(opened, ['http://example.com/', 'https://example.com/', 'https://example.com/next'])
})
