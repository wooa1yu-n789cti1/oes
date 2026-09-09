import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArguments, waitForDevelopmentTermination } from '../../launcher.mjs'

test('launcher parses options after pnpm separator and preserves a later command separator', () => {
  assert.deepEqual(parseArguments(['--', '--state-root', '/fixture/runtime-v2']), {
    options: { 'state-root': '/fixture/runtime-v2' },
    command: []
  })
  assert.deepEqual(parseArguments(['--', '--owner', 'auth-service', '--', 'pnpm', 'test']), {
    options: { owner: 'auth-service' },
    command: ['pnpm', 'test']
  })
  assert.throws(() => parseArguments(['positional']), /RUNTIME_ARGUMENT_INVALID/)
  assert.throws(() => parseArguments(['--profile=']), /RUNTIME_OPTION_VALUE_REQUIRED/)
  assert.throws(() => parseArguments(['--profile', '--owner', 'auth-service']), /RUNTIME_OPTION_VALUE_REQUIRED/)
})

test('launcher termination wait propagates signer liveness failure and accepts operator abort', async () => {
  const failure = new Error('SIGNER_FUNCTIONAL_PROBE_FAILED')
  await assert.rejects(waitForDevelopmentTermination(new AbortController().signal, Promise.reject(failure)), /SIGNER_FUNCTIONAL_PROBE_FAILED/u)
  const controller = new AbortController()
  const waiting = waitForDevelopmentTermination(controller.signal, new Promise(() => {}))
  controller.abort()
  await waiting
})
