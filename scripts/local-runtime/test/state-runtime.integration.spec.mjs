import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveCredentialReference } from '../src/credentials.mjs'
import { environmentForOwner, resolveResources } from '../src/manifest.mjs'
import { withRuntime } from '../src/orchestrator.mjs'

const root = path.resolve(import.meta.dirname, '../../..')

test('integration preserves shared physical provider while isolating concurrent Run allocations', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-state-integration-'))
  const base = { root, stateRoot, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['permission-service'], capabilities: [], devStackId: 'integration_machine', driver: 'simulation', concurrency: 2 }
  const observed = []
  const credentials = []
  await Promise.all(['a', 'b'].map((side) => withRuntime({ ...base, taskKey: `integration_${side}`, runId: `run_${side}` }, async (manifest) => { observed.push(manifest); credentials.push(environmentForOwner(manifest, 'permission-service', resolveCredentialReference).OES_POSTGRES_CREDENTIAL); await new Promise((resolve) => setTimeout(resolve, 30)) })))
  const physical = observed.map((manifest) => resolveResources(manifest, { includeStack: true }).find((resource) => resource.kind === 'simulated-provider').objectId)
  assert.equal(new Set(physical).size, 1)
  assert.equal(new Set(credentials).size, 2)
  assert.ok(observed.flatMap((manifest) => manifest.resources).every((resource) => !resource.path || !fs.existsSync(resource.path)))
})
