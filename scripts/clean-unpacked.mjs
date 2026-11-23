import fs from 'node:fs'
import path from 'node:path'

const dirs = ['release/win-unpacked', 'release/win-unpacked.tmp']
const MAX_TRIES = 8

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeDir(target) {
  let last
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      return
    } catch (error) {
      last = error
      const code = error && error.code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES') {
        if (i < MAX_TRIES) sleep(400)
        continue
      }
      throw error
    }
  }
  const hint = [
    `[clean-unpacked] Could not remove ${target}`,
    'On Windows, EPERM can mean an editor, file browser, or antivirus is holding a previous build file such as resources/default_app.asar.',
    'Exclude release from editor file watching and reload the editor, or close the process holding the file before trying again.'
  ].join('\n')
  const err = new Error(hint)
  err.cause = last
  throw err
}

for (const dir of dirs) {
  const target = path.resolve(dir)
  if (!fs.existsSync(target)) continue
  removeDir(target)
  console.log(`[clean-unpacked] removed ${dir}`)
}
