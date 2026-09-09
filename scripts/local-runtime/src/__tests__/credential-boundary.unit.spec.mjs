import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveCredentialReference, resolveMigratorCredential, writeCredentialBundle, writeMigratorCredentialBundle } from '../credentials.mjs'
import { environmentForOwner, publishManifest, publishStackManifest } from '../manifest.mjs'

test('business owner environment exposes runtime PostgreSQL authority and never migrator authority', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-credential-boundary-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const runRoot = path.join(stackRoot, 'runs', 'task_a', 'run_a')
  const runtimeReference = writeCredentialBundle(runRoot, 'postgres', { 'owner-a': { DATABASE_URL: 'postgresql://runtime:runtime-secret@127.0.0.1:5432/db' } })
  const context = { profile: 'LOCAL_INTEGRATION', stackRoot, runDirectory: runRoot }
  writeMigratorCredentialBundle(context, { 'owner-a': { DATABASE_URL: 'postgresql://migrator:migrator-secret@127.0.0.1:5432/db' } })
  const stack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey, devStackId: 'fixture_machine', resources: [{ provider: 'postgres', kind: 'container', scope: 'SHARED', objectId: 'postgres-object' }], endpoints: [{ provider: 'postgres', ready: true, authority: 'docker:postgres-object:5432/tcp', environment: { OES_POSTGRES_PORT: '5432' } }], leases: [] })
  const manifest = publishManifest(runRoot, { lifecycle: 'REGISTERED', profile: 'LOCAL_INTEGRATION', stateRoot, stackRoot, runDirectory: runRoot, stackKey, devStackId: 'fixture_machine', taskKey: 'task_a', runId: 'run_a', owners: ['owner-a'], resources: [], stackManifestReference: stack.reference, endpoints: [{ provider: 'postgres', source: 'STACK', ready: true, owners: ['owner-a'], credentialReference: runtimeReference }] }).manifest
  const runtime = environmentForOwner(manifest, 'owner-a', resolveCredentialReference)
  assert.equal(new URL(runtime.DATABASE_URL).username, 'runtime')
  assert.throws(() => resolveCredentialReference(runtimeReference, 'owner-a', 'minio'), /CREDENTIAL_REFERENCE_PROVIDER_MISMATCH/u)
  assert.equal(Object.keys(runtime).some((key) => /MIGRATOR/u.test(key)), false)
  assert.doesNotMatch(JSON.stringify(manifest), /migrator-secret|OES_MIGRATOR_DATABASE_URL/u)
  const migrator = resolveMigratorCredential(manifest, 'owner-a')
  assert.equal(new URL(migrator.DATABASE_URL).username, 'migrator')
})
