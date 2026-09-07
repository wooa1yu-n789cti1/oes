import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fingerprint, writeAtomic } from '../canonical.mjs'
import { publishManifest, publishStackManifest } from '../manifest.mjs'
import { applyOperatorReconciliation, classifyRuntimeObject, planOperatorReconciliation, reopenOperatorAuthority } from '../operator-status.mjs'

function labels(scope, extra = {}) {
  return { 'oes.runtime.version': '2', 'oes.runtime.stack-key': 'oes-local-0123456789abcdef', 'oes.runtime.dev-stack-id': 'fixture_machine', 'oes.runtime.scope': scope, 'oes.runtime.pool': scope === 'CI' ? 'ci' : 'test', 'oes.runtime.provider': 'postgres', ...extra }
}

test('operator projection distinguishes SHARED, RUN, CI, LEGACY, and UNKNOWN through exact joins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-operator-status-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(root, 'stacks', stackKey)
  const stack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey, devStackId: 'fixture_machine', resources: [{ provider: 'postgres', kind: 'container', scope: 'SHARED', pool: 'test', objectId: 'shared-object' }, { provider: 'postgres', kind: 'container', scope: 'SHARED', pool: 'test', objectId: 'pre-stack-key-object', labelCompatibility: 'PRE_STACK_KEY_V2_EXACT' }], endpoints: [{ provider: 'postgres', pool: 'test', ready: true, authority: 'docker:shared-object:5432/tcp', environment: {} }], leases: [] })
  const runRoot = path.join(stackRoot, 'runs', 'task_a', 'run_a')
  const run = publishManifest(runRoot, { lifecycle: 'REGISTERED', profile: 'LOCAL_INTEGRATION', stateRoot: root, stackRoot, runDirectory: runRoot, stackKey, devStackId: 'fixture_machine', taskKey: 'task_a', runId: 'run_a', owners: [], resources: [{ provider: 'postgres', kind: 'container', scope: 'RUN', objectId: 'run-object' }], endpoints: [], stackManifestReference: stack.reference })
  const ciRoot = path.join(stackRoot, 'runs', 'task_ci', 'run_ci')
  const ci = publishManifest(ciRoot, { lifecycle: 'REGISTERED', profile: 'CI', stateRoot: root, stackRoot, runDirectory: ciRoot, stackKey, devStackId: 'fixture_machine', jobFingerprint: 'feedfacefeedface', taskKey: 'task_ci', runId: 'run_ci', owners: [], resources: [{ provider: 'postgres', kind: 'container', scope: 'CI', objectId: 'ci-object' }], endpoints: [], stackManifestReference: stack.reference })
  const cleanupRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_RUN_CLEANUP', stackKey, taskKey: 'task_ci', runId: 'run_ci', sourceFingerprint: ci.manifest.manifestFingerprint, cleanupResults: [], sharedLeaseCount: 0, result: 'RECONCILED' }
  writeAtomic(path.join(ciRoot, 'cleanup.json'), { ...cleanupRaw, recordFingerprint: fingerprint(cleanupRaw) })
  const leaseRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_LEASE', stackKey, devStackId: 'fixture_machine', taskKey: 'task_a', runId: 'run_a' }
  const leasePath = path.join(stackRoot, 'leases', 'task_a--run_a.json')
  writeAtomic(leasePath, { ...leaseRaw, leaseFingerprint: fingerprint(leaseRaw) })
  assert.throws(() => reopenOperatorAuthority({ stackReferences: [stack.reference], runManifestPaths: [run.file, ci.file], leasePaths: [] }), /OPERATOR_LEASE_AUTHORITY_INCOMPLETE/)
  const authority = reopenOperatorAuthority({ stackReferences: [stack.reference], runManifestPaths: [run.file, ci.file], leasePaths: [leasePath] })
  const observations = [
    { objectId: 'shared-object', labels: labels('SHARED') },
    { objectId: 'pre-stack-key-object', labels: { ...labels('SHARED'), 'oes.runtime.stack-key': undefined } },
    { objectId: 'run-object', labels: labels('RUN', { 'oes.runtime.task-key': 'task_a', 'oes.runtime.run-id': 'run_a' }) },
    { objectId: 'ci-object', labels: labels('CI', { 'oes.runtime.task-key': 'task_ci', 'oes.runtime.run-id': 'run_ci', 'oes.runtime.ci-job-fingerprint': 'feedfacefeedface' }) },
    { objectId: 'legacy-object', labels: { 'com.docker.compose.project': 'legacy' } },
    { objectId: 'unknown-object', labels: labels('RUN', { 'oes.runtime.task-key': 'other', 'oes.runtime.run-id': 'run_a' }) }
  ]
  assert.deepEqual(observations.map((item) => classifyRuntimeObject(item, authority).status), ['SHARED', 'SHARED', 'RUN', 'CI', 'LEGACY', 'UNKNOWN'])
  const plan = planOperatorReconciliation(observations, authority)
  assert.equal(plan.find((item) => item.objectId === 'run-object').action, 'PRESERVE')
  assert.equal(plan.find((item) => item.objectId === 'ci-object').action, 'RECONCILE_EXACT_MANIFEST_RESOURCE')
  assert.equal(plan.find((item) => item.objectId === 'unknown-object').action, 'PRESERVE')
  const applied = applyOperatorReconciliation(plan, observations, (_observed, decision) => ({ disposition: `RECONCILED_${decision.status}` }))
  assert.equal(applied.find((item) => item.objectId === 'ci-object').disposition, 'RECONCILED_CI')
  assert.equal(applied.find((item) => item.objectId === 'legacy-object').disposition, 'PRESERVED')
  fs.rmSync(leasePath)
  const unterminatedAuthority = reopenOperatorAuthority({ stackReferences: [stack.reference], runManifestPaths: [run.file], leasePaths: [] })
  const unterminated = planOperatorReconciliation([observations[2]], unterminatedAuthority)[0]
  assert.equal(unterminated.leaseStatus, 'ABSENT')
  assert.equal(unterminated.terminalStatus, 'ABSENT')
  assert.equal(unterminated.action, 'PRESERVE')
  const failedCleanupRaw = { ...cleanupRaw, result: 'PRESERVED_WITH_FINDINGS' }
  writeAtomic(path.join(ciRoot, 'cleanup.json'), { ...failedCleanupRaw, recordFingerprint: fingerprint(failedCleanupRaw) })
  const failedCleanupAuthority = reopenOperatorAuthority({ stackReferences: [stack.reference], runManifestPaths: [ci.file], leasePaths: [] })
  const failedCleanup = planOperatorReconciliation([observations[3]], failedCleanupAuthority)[0]
  assert.equal(failedCleanup.terminalStatus, 'FAILED')
  assert.equal(failedCleanup.action, 'PRESERVE')
})
