import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createSystemAdminSeedManifestFixture } from '../src/__tests__/system-admin-seed-test-fixture.mjs'

const root = path.resolve(import.meta.dirname, '../../..')

test('launcher dry-run passes one authorized manifest binding to the seed without logging secrets', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  const result = spawnSync(process.execPath, [
    'scripts/local-runtime/launcher.mjs',
    'system-admin-seed',
    '--manifest', fixture.file
  ], { cwd: root, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, result.stderr)
  const outer = JSON.parse(result.stdout)
  assert.equal(outer.stage, 'SYSTEM_ADMIN_SEED')
  assert.match(outer.output, /"mode": "launcher-manifest"/u)
  for (const resource of fixture.resources) assert.match(outer.output, new RegExp(resource.database, 'u'))
  for (const secret of fixture.secrets) assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, 'u'))
})

test('direct seed entry does not admit dynamic V2 targets without launcher binding', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  const environment = { ...process.env }
  for (const [owner, value] of Object.entries(fixture.ownerEnvironments)) {
    const key = owner === 'identity-service' ? 'OES_IDENTITY_DATABASE_URL' : owner === 'auth-service' ? 'OES_AUTH_DATABASE_URL' : 'OES_PERMISSION_DATABASE_URL'
    environment[key] = value.DATABASE_URL
  }
  const result = spawnSync(process.execPath, ['scripts/local/seed-system-admin.mjs'], { cwd: root, env: environment, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /must target database identitydb/u)
  for (const secret of fixture.secrets) assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, 'u'))
})
