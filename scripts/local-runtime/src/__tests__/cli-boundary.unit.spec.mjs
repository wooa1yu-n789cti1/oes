import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../../../..')

/** Executes pnpm exactly as documented and retains literal output for assertions. */
function pnpm(args, environment = {}) {
  return spawnSync('pnpm', args, { cwd: root, env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 120000 })
}

test('documented pnpm launcher separator forwards options instead of turning them into a command', () => {
  const result = pnpm(['runtime:plan', '--', '--profile', 'CI', '--test-class', 'integration', '--owner', 'asset-service', '--capabilities', 'object-store', '--task-key', 'cli_boundary', '--run-id', 'plan'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"profile": "CI"/u)
  assert.match(result.stdout, /"object-store"/u)
  const unknown = pnpm(['runtime:plan', '--', '--unknown', 'value'])
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /RUNTIME_OPTION_INVALID/u)
})

test('documented simulation A0 never spawns Docker after pnpm forwarding', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-cli-boundary-'))
  const bin = path.join(directory, 'bin')
  const sentinel = path.join(directory, 'docker-spawned')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf 'docker invoked\\n' > '${sentinel}'\nexit 97\n`, { mode: 0o700 })
  const stateRoot = path.join(directory, 'runtime-v2')
  const output = path.join(directory, 'a0.json')
  const result = pnpm(['runtime:a0', '--', '--driver', 'simulation', '--scenario', 'events', '--batch', 'cli_boundary', '--state-root', stateRoot, '--output', output], { PATH: `${bin}:${process.env.PATH}` })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"driver": "simulation"/u)
  assert.equal(fs.existsSync(sentinel), false)
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).driver, 'simulation')
})
