import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const supervisorUrl = new URL('../service-development.mjs', import.meta.url).href

/** Starts the supervisor against a fixture package and captures its exact terminal behavior. */
function launchFixture(scripts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-service-development-'))
  const packageFile = path.join(directory, 'package.json')
  fs.writeFileSync(packageFile, JSON.stringify({ name: 'fixture-service', scripts }))
  const source = [
    `import { runServiceDevelopment } from ${JSON.stringify(supervisorUrl)}`,
    `const result = await runServiceDevelopment({ owner: 'fixture-service', packageFile: ${JSON.stringify(packageFile)} })`,
    'process.exitCode = result.exitCode'
  ].join(';')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, closed, output: () => stdout + stderr }
}

/** Waits for both fixture roles without relying on a fixed startup delay. */
async function waitForOutput(attempt, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (expected.every((value) => attempt.output().includes(value))) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`FIXTURE_OUTPUT_TIMEOUT output=${attempt.output()}`)
}

test('operator SIGTERM stops both child roles successfully without lifecycle failure noise', async () => {
  const attempt = launchFixture({
    'dev:build': `node -e "console.log('build-ready'); setInterval(() => {}, 1000)"`,
    'dev:start': `node -e "console.log('run-ready'); setInterval(() => {}, 1000)"`
  })
  await waitForOutput(attempt, ['build-ready', 'run-ready'])
  attempt.child.kill('SIGTERM')
  const result = await attempt.closed
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /ELIFECYCLE|ERR_PNPM|exited with code|kill EPERM/u
  )
})

test('an unexpected compiler failure remains a non-zero service failure', async () => {
  const attempt = launchFixture({
    'dev:build': `node -e "console.error('compile-failed'); process.exit(7)"`,
    'dev:start': `node -e "setInterval(() => {}, 1000)"`
  })
  const result = await attempt.closed
  assert.equal(result.code, 7)
  assert.match(result.stderr, /compile-failed/u)
  assert.match(result.stderr, /unexpected-exit role=build exit=7/u)
})
