import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hostBindingHash, identityDigest, resolveRuntimeLayout } from '../state-layout.mjs'

const zeroSeed = '0'.repeat(64)
const host = { kind: 'fixture-v1', value: 'host-a' }

test('machine and CI identity derivation obey frozen byte-level golden vectors', () => {
  assert.equal(identityDigest('oes-runtime-v2-machine', zeroSeed), 'ad78d2ede145adf19d093b2dcc9f27cc216ed8771092f5469cd90598d7918585')
  assert.equal(identityDigest('oes-runtime-v2-ci-job', zeroSeed), '74e5d1cdc287241c776d818c23b2bbea59c12fc8a3eb9c5d51caf149af2a0178')
  assert.equal(hostBindingHash(host), 'beb72cc63c27c55677ee885b24f50dc577a29fec7a6c22b4c9f75fd4f766fa32')
})

test('local machine root contains one registry Stack and nests each Run beneath it', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-layout-local-'))
  const layout = await resolveRuntimeLayout({ stateRoot, profile: 'LOCAL_INTEGRATION', taskKey: 'task_a', runId: 'run_a', explicitDevStackId: 'fixture_machine', identitySeed: zeroSeed, hostBinding: host })
  assert.equal(layout.stackKey, 'oes-local-ad78d2ede145adf1')
  assert.equal(layout.runRoot, path.join(layout.stackRoot, 'runs', 'task_a', 'run_a'))
  assert.equal(fs.statSync(path.join(stateRoot, 'machine-identity.json')).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateRoot, 'stack-registry.json'), 'utf8')).stacks, [{ devStackId: 'fixture_machine', stackKey: layout.stackKey }])
  await assert.rejects(resolveRuntimeLayout({ stateRoot, profile: 'LOCAL_INTEGRATION', taskKey: 'task_b', runId: 'run_b', explicitDevStackId: 'fixture_machine', hostBinding: { kind: 'fixture-v1', value: 'host-b' } }), /STATE_HOST_BINDING_MISMATCH/)
})

test('CI identity stays job-private and never enters the developer Stack registry', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-layout-ci-'))
  const layout = await resolveRuntimeLayout({ stateRoot, profile: 'CI', taskKey: 'task_ci', runId: 'run_ci', ciSeed: zeroSeed, ciJobIdentity: 'job-42' })
  assert.equal(layout.stackKey, 'oes-ci-74e5d1cdc287241c')
  assert.equal(layout.jobFingerprint, '74e5d1cdc287241c')
  assert.equal(fs.existsSync(path.join(stateRoot, 'stack-registry.json')), false)
})

test('flat pre-hierarchy state is rejected before registry or provider mutation', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-layout-flat-'))
  fs.mkdirSync(path.join(stateRoot, 'shared'))
  await assert.rejects(resolveRuntimeLayout({ stateRoot, profile: 'LOCAL_INTEGRATION', taskKey: 'task_a', runId: 'run_a', identitySeed: zeroSeed, hostBinding: host }), /STATE_LAYOUT_MIGRATION_REQUIRED/)
  assert.equal(fs.existsSync(path.join(stateRoot, 'stack-registry.json')), false)
})
