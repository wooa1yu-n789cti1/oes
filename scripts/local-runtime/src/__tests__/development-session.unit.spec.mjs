import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  backendPreparationPath,
  backendSessionPath,
  developmentPreparationInput,
  fullDevelopmentOwners
} from '../development-session.mjs'
import { cleanupDevelopmentProcessResources } from '../process-runtime.mjs'
import { validateStaleSessionManifest } from '../../dev-backend-session.mjs'

function write(root, relative, contents) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

test('backend preparation paths are fixed below the runtime state root', () => {
  assert.equal(
    backendPreparationPath('/state'),
    path.join('/state', 'development', 'backend-preparation.json')
  )
  assert.equal(
    backendSessionPath('/state'),
    path.join('/state', 'development', 'backend-session.json')
  )
})

test('backend preparation fingerprint changes only for finite preparation inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-backend-preparation-'))
  write(root, 'package.json', '{}\n')
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write(
    root,
    'scripts/local-runtime/relationships.json',
    JSON.stringify({
      owners: { 'fixture-service': { downstreams: [] } }
    })
  )
  write(root, 'scripts/local-runtime/src/bootstrap.mjs', 'export const fixture = true\n')
  write(root, 'src/common/src/fixture.ts', 'export const common = 1\n')
  write(root, 'src/services/system/fixture-service/package.json', '{"name":"fixture-service"}\n')
  write(root, 'src/services/system/fixture-service/prisma/schema.prisma', 'datasource db {}\n')

  const owners = fullDevelopmentOwners(root)
  const baseline = developmentPreparationInput(root, owners)
  assert.deepEqual(owners, ['fixture-service'])
  assert.deepEqual(developmentPreparationInput(root, owners), baseline)

  write(root, 'src/services/system/fixture-service/src/runtime.ts', 'export const runtime = 2\n')
  assert.deepEqual(developmentPreparationInput(root, owners), baseline)

  write(
    root,
    'src/services/system/fixture-service/prisma/schema.prisma',
    'datasource db { provider = "postgresql" }\n'
  )
  assert.notEqual(developmentPreparationInput(root, owners).fingerprint, baseline.fingerprint)
})

test('stale backend session cleanup accepts an older manifest from the same DEV stack', () => {
  const sessionManifest = {
    profile: 'DEV',
    manifestFingerprint: 'old-manifest',
    stackKey: 'stack-a',
    taskKey: 'developer-dev'
  }
  const observed = validateStaleSessionManifest(
    { manifestFingerprint: 'old-manifest', preparationRecordFingerprint: 'old-preparation' },
    sessionManifest,
    {
      record: { recordFingerprint: 'new-preparation' },
      manifest: { stackKey: 'stack-a', taskKey: 'developer-dev' }
    }
  )
  assert.equal(observed, sessionManifest)
})

test('stale backend session cleanup rejects a manifest from another stack', () => {
  assert.throws(
    () =>
      validateStaleSessionManifest(
        { manifestFingerprint: 'old-manifest' },
        {
          profile: 'DEV',
          manifestFingerprint: 'old-manifest',
          stackKey: 'stack-b',
          taskKey: 'developer-dev'
        },
        { manifest: { stackKey: 'stack-a', taskKey: 'developer-dev' } }
      ),
    /BACKEND_STALE_SESSION_PREPARATION_MISMATCH/u
  )
})

test('stale backend cleanup treats an already absent runtime directory as reconciled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-stale-backend-cleanup-'))
  const results = cleanupDevelopmentProcessResources(
    [
      {
        scope: 'RUN',
        kind: 'directory',
        provider: 'execution-token-signer',
        path: path.join(root, 'already-absent')
      }
    ],
    {}
  )
  assert.equal(results.length, 1)
  assert.equal(results[0].disposition, 'ALREADY_ABSENT')
  assert.equal(results[0].exitStatus, 0)
})
