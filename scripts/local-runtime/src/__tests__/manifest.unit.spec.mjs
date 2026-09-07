import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { writeCredentialBundle, resolveCredentialReference } from '../credentials.mjs'
import { environmentForOwner, publishManifest, publishStackManifest, reopenManifest } from '../manifest.mjs'

test('manifest publication is readiness-gated, atomic and value-free', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-manifest-'))
  assert.throws(() => publishManifest(stateRoot, { lifecycle: 'ALLOCATING', endpoints: [] }), /MANIFEST_NOT_READY/)
  const stackRoot = path.join(stateRoot, 'stacks', 'oes-local-0123456789abcdef')
  const directory = path.join(stackRoot, 'runs', 'task_a', 'run_a')
  const reference = writeCredentialBundle(directory, 'postgres', { 'owner-a': { DATABASE_URL: 'postgresql://secret' } })
  const stack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey: 'oes-local-0123456789abcdef', devStackId: 'machine_a', resources: [{ provider: 'postgres', scope: 'SHARED', kind: 'container', objectId: 'abc' }], endpoints: [{ provider: 'postgres', ready: true, authority: 'docker:abc:5432/tcp', environment: { OES_POSTGRES_PORT: '31000' } }], leases: [] })
  const published = publishManifest(directory, { lifecycle: 'REGISTERED', profile: 'LOCAL_INTEGRATION', stateRoot, stackRoot, runDirectory: directory, stackKey: 'oes-local-0123456789abcdef', devStackId: 'machine_a', taskKey: 'task_a', runId: 'run_a', owners: ['owner-a'], resources: [], stackManifestReference: stack.reference, endpoints: [{ provider: 'postgres', source: 'STACK', ready: true, owners: ['owner-a'], credentialReference: reference }] })
  assert.equal(fs.existsSync(`${published.file}.tmp`), false)
  assert.doesNotMatch(fs.readFileSync(published.file, 'utf8'), /postgresql:\/\/secret/u)
  const reopened = reopenManifest(published.file, { taskKey: 'task_a', runId: 'run_a' })
  assert.deepEqual(environmentForOwner(reopened, 'owner-a', resolveCredentialReference), { NODE_ENV: 'test', OES_TASK_KEY: 'task_a', OES_RUN_ID: 'run_a', OES_DEV_STACK_ID: 'machine_a', OES_STACK_KEY: 'oes-local-0123456789abcdef', OES_POSTGRES_PORT: '31000', DATABASE_URL: 'postgresql://secret' })
  assert.equal(reopened.resources.length, 0)
  assert.equal(reopened.endpoints[0].authority, undefined)
  assert.throws(() => environmentForOwner(reopened, 'owner-b', resolveCredentialReference), /MANIFEST_OWNER_UNDECLARED/)
})

test('concurrent Stack publishers allocate distinct immutable generations', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-manifest-concurrent-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const moduleUrl = new URL('../manifest.mjs', import.meta.url).href
  const script = `import { publishStackManifest } from ${JSON.stringify(moduleUrl)}; const result = publishStackManifest(${JSON.stringify(stackRoot)}, { lifecycle: 'REGISTERED', stackKey: ${JSON.stringify(stackKey)}, devStackId: 'machine_a', resources: [], endpoints: [], leases: [] }); process.stdout.write(result.manifest.generation)`
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`publisher exit=${code} stderr=${stderr}`)))
  })
  const generations = await Promise.all(Array.from({ length: 8 }, run))
  assert.equal(new Set(generations).size, 8)
  assert.deepEqual(generations.sort(), Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(12, '0')))
  for (const generation of generations) assert.equal(fs.existsSync(path.join(stackRoot, 'manifests', `${generation}.json`)), true)
})
