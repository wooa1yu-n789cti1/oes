import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reopenCurrentStackManifest, reopenManifest } from '../manifest.mjs'
import { reconcileRuntime, startRuntime } from '../orchestrator.mjs'

const root = path.resolve(import.meta.dirname, '../../../..')

test('component publishes Stack authority before its reference-only Run consumer', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-state-component-'))
  const started = await startRuntime({ root, stateRoot, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['permission-service'], capabilities: [], taskKey: 'component_task', runId: 'component_run', devStackId: 'component_machine', driver: 'simulation' })
  const run = reopenManifest(started.file)
  const stack = reopenCurrentStackManifest(run.stackRoot)
  assert.equal(stack.manifest.stackKey, run.stackKey)
  assert.equal(run.resources.some((resource) => resource.scope === 'SHARED'), false)
  assert.equal(run.endpoints.find((endpoint) => endpoint.provider === 'postgres').source, 'STACK')
  reconcileRuntime({ manifestPath: started.file, cleanupResource: started.cleanup, releaseSlot: started.releaseSlot })
})
