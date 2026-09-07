import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishManifest, publishStackManifest } from '../src/manifest.mjs'

test('contract rejects shared payload duplication and unsealed Stack references', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-state-contract-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(root, 'stacks', stackKey)
  const runRoot = path.join(stackRoot, 'runs', 'contract_task', 'contract_run')
  const stack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey, devStackId: 'contract_machine', resources: [], endpoints: [], leases: [] })
  const draft = { lifecycle: 'REGISTERED', profile: 'LOCAL_INTEGRATION', stateRoot: root, stackRoot, runDirectory: runRoot, stackKey, devStackId: 'contract_machine', taskKey: 'contract_task', runId: 'contract_run', owners: [], endpoints: [], resources: [{ provider: 'postgres', scope: 'SHARED', objectId: 'forbidden' }], stackManifestReference: stack.reference }
  assert.throws(() => publishManifest(runRoot, draft), /RUN_MANIFEST_SHARED_PAYLOAD_FORBIDDEN/)
  assert.throws(() => publishManifest(runRoot, { ...draft, resources: [], stackManifestReference: { ...stack.reference, sha256: '0'.repeat(64) } }), /STACK_MANIFEST_REFERENCE_SHA_MISMATCH/)
})
