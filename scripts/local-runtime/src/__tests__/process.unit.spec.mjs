import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { runChecked } from '../process.mjs'

test('runChecked captures output for machine-readable callers by default', () => {
  const result = runChecked(process.execPath, ['-e', "process.stdout.write('captured-out'); process.stderr.write('captured-err')"])
  assert.equal(result.stdout, 'captured-out')
  assert.equal(result.stderr, 'captured-err')
  assert.equal(result.status, 0)
})

test('runCheckedVisible inherits both output streams for the launcher wrapper', () => {
  const moduleUrl = new URL('../process.mjs', import.meta.url).href
  const source = [
    `import { runCheckedVisible } from ${JSON.stringify(moduleUrl)}`,
    "runCheckedVisible(process.execPath, ['-e', \"process.stdout.write('visible-out'); process.stderr.write('visible-err')\"] )"
  ].join(';')
  const attempt = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8'
  })
  assert.equal(attempt.status, 0)
  assert.equal(attempt.stdout, 'visible-out')
  assert.equal(attempt.stderr, 'visible-err')
})

test('runChecked reports a child signal as its conventional exit status', () => {
  assert.throws(
    () => runChecked(process.execPath, ['-e', "process.kill(process.pid, 'SIGINT')"]),
    (error) => error.status === 130 && error.signal === 'SIGINT' && /exit=130 signal=SIGINT/u.test(error.message)
  )
})
