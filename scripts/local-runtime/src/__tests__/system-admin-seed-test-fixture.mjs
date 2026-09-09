import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCredentialBundle } from '../credentials.mjs'
import { logicalResourceIdentity } from '../docker-driver.mjs'
import { publishManifest, publishStackManifest } from '../manifest.mjs'

export const SYSTEM_ADMIN_FIXTURE_TARGETS = Object.freeze({
  identityService: { owner: 'identity-service', envKey: 'OES_IDENTITY_DATABASE_URL' },
  authService: { owner: 'auth-service', envKey: 'OES_AUTH_DATABASE_URL' },
  permissionService: { owner: 'permission-service', envKey: 'OES_PERMISSION_DATABASE_URL' }
})

/** Publishes one self-contained value-bearing test manifest with value-free runtime authority. */
export function createSystemAdminSeedManifestFixture({ host = '127.0.0.1', port = '35432', profile = 'LOCAL_INTEGRATION', taskKey = 'system_admin_task', runId = 'system_admin_run', logicalIdentityMismatchOwner = null } = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-system-admin-binding-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const devStackId = 'system_admin_fixture'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const runDirectory = path.join(stackRoot, 'runs', taskKey, runId)
  const ownerEnvironments = {}
  const resources = []
  const secrets = []
  for (const target of Object.values(SYSTEM_ADMIN_FIXTURE_TARGETS)) {
    const { suffix, database, runtime, migrator } = logicalResourceIdentity({ profile, devStackId, taskKey, runId }, 'postgres', target.owner)
    const password = `fixture-secret-${suffix}`
    secrets.push(password)
    ownerEnvironments[target.owner] = { DATABASE_URL: `postgresql://${runtime}:${encodeURIComponent(password)}@${host}:${port}/${database}?schema=public` }
    resources.push({ provider: 'postgres', kind: 'database', scope: profile === 'DEV' ? 'SHARED' : 'RUN', owner: target.owner, database: target.owner === logicalIdentityMismatchOwner ? `${database}_foreign` : database, runtime, migrator, objectId: `database-${suffix}` })
  }
  const credentialReference = writeCredentialBundle(profile === 'DEV' ? stackRoot : runDirectory, 'postgres', ownerEnvironments)
  const endpoint = {
    provider: 'postgres',
    ready: true,
    authority: 'fixture:postgres',
    host,
    port: Number(port),
    owners: Object.values(SYSTEM_ADMIN_FIXTURE_TARGETS).map(({ owner }) => owner),
    environment: { OES_POSTGRES_HOST: host, OES_POSTGRES_PORT: port },
    credentialReference
  }
  const stack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey, devStackId, resources: profile === 'DEV' ? resources : [], endpoints: profile === 'DEV' ? [endpoint] : [], leases: [] })
  const published = publishManifest(runDirectory, {
    lifecycle: 'REGISTERED',
    profile,
    stateRoot,
    stackRoot,
    runDirectory,
    stackKey,
    devStackId,
    taskKey,
    runId,
    owners: Object.values(SYSTEM_ADMIN_FIXTURE_TARGETS).map(({ owner }) => owner),
    resources: profile === 'DEV' ? [] : resources,
    stackManifestReference: stack.reference,
    endpoints: [profile === 'DEV'
      ? { provider: 'postgres', source: 'STACK', ready: true, owners: endpoint.owners }
      : { ...endpoint, source: 'RUN' }]
  })
  return { ...published, stateRoot, stackRoot, runDirectory, taskKey, runId, stackKey, devStackId, ownerEnvironments, resources, credentialReference, secrets }
}
