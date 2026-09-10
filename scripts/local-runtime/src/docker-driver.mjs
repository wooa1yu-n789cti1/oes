import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, randomSecret, sha256, writeAtomic } from './canonical.mjs'
import { writeCredentialBundle, writeMigratorCredentialBundle } from './credentials.mjs'
import { withExclusiveLock } from './locks.mjs'
import { runChecked } from './process.mjs'

const IMAGES = Object.freeze({
  postgres: 'postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
  redis: 'redis:7-alpine@sha256:8b81dd37ff027bec4e516d41acfbe9fe2460070dc6d4a4570a2ac5b9d59df065',
  nats: 'nats:2.10.26-alpine@sha256:d69eb29526c1d98afdfb2e2434763bef77b5f3c83e2e24769c13a4d104be475e',
  natsBox: 'natsio/nats-box:0.14.5@sha256:0784ab710aefaf6ef037ed797ee7dcde613c6ad208c4dbff1945fc7c1b5b5375',
  minio: 'minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e',
  minioClient: 'minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3',
  mysql: 'mysql:8.0@sha256:a3dff78d876222746a0bacc36dd7e4bf9e673c85fb7ee0d12ed25bd32c43c19b',
  nacos: 'nacos/nacos-server:v2.5.1@sha256:8987908cb94ed5f9d30522a64493d35732a6c05f216d667a7addb022f3d92e80',
  otel: 'otel/opentelemetry-collector-contrib:0.137.0@sha256:886722fe0f37af9d1fe24d29529253ec59fbf263b3b1df4facaf221373e19d23',
  tempo: 'grafana/tempo:2.8.2@sha256:0ef775495967cd5d7a6b2e146b6ea695d624803c8db8349fb8ce4164f719f9b7',
  loki: 'grafana/loki:3.5.3@sha256:3165cecce301ce5b9b6e3530284b080934a05cd5cafac3d3d82edcb887b45ecd',
  grafana: 'grafana/grafana:11.6.2@sha256:a3464c5dadc2e16aaeb813aead8c852e81cc7bbfa851c66d96f016d5257b9848'
})

export const RUNTIME_DOCKER_IMAGES = IMAGES
export const REDIS_RUNTIME_ACL_COMMAND_RULES = Object.freeze(['+@read', '+@write', '+ping', '+publish', '+subscribe', '+unsubscribe', '-@admin', '-@dangerous', '+multi', '+exec', '+discard'])

export const NACOS_MYSQL_JDBC_PARAMETERS = 'characterEncoding=utf8&connectTimeout=1000&socketTimeout=3000&autoReconnect=true&useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC'

/** Builds the complete Nacos container environment shared by persistent, run-scoped, and migration-fixture providers. */
export function nacosContainerEnvironment(mysqlHost, mysqlPassword, authToken, authIdentityValue) {
  return { MODE: 'standalone', PREFER_HOST_MODE: 'ip', SPRING_DATASOURCE_PLATFORM: 'mysql', MYSQL_SERVICE_HOST: mysqlHost, MYSQL_SERVICE_PORT: '3306', MYSQL_SERVICE_DB_NAME: 'nacos', MYSQL_SERVICE_USER: 'nacos', MYSQL_SERVICE_PASSWORD: mysqlPassword, MYSQL_SERVICE_DB_PARAM: NACOS_MYSQL_JDBC_PARAMETERS, NACOS_AUTH_ENABLE: 'true', NACOS_AUTH_TOKEN: authToken, NACOS_AUTH_IDENTITY_KEY: 'serverIdentity', NACOS_AUTH_IDENTITY_VALUE: authIdentityValue, JVM_XMS: '256m', JVM_XMX: '256m', JVM_XMN: '128m' }
}

/** Produces a Docker-safe exact resource suffix. */
function token(value, size = 24) { return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, size) }

/** Keeps run-owned Docker names readable while binding truncation to the full identity. */
export function exactResourceToken(value, size = 24) {
  const hash = sha256(value).slice(0, 12)
  return `${token(value, Math.max(1, size - hash.length - 1))}-${hash}`
}

/** Produces one unambiguous bounded shared-provider name from immutable Stack identity. */
export function sharedResourceName(devStackId, pool, provider) {
  if (!['dev', 'test'].includes(pool) || !/^[a-z0-9][a-z0-9-]*$/u.test(provider || '')) throw new Error('SHARED_RESOURCE_NAME_IDENTITY_INVALID')
  const name = `oes-v2-${exactResourceToken(devStackId, 32)}-${pool}-${provider}`
  if (name.length > 63 || !/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`SHARED_RESOURCE_NAME_INVALID name=${name}`)
  return name
}

/** Binds every run-owned identity to its accountable task and run pair. */
export function exactRunIdentity(context) { return `${context.taskKey}:${context.runId}` }

/** Derives every provider-owned logical child identifier from one exact Stack or Run owner identity. */
export function logicalResourceIdentity(context, provider, owner) {
  const identity = context.profile === 'DEV' ? context.devStackId : exactRunIdentity(context)
  const suffix = sha256([identity, owner].join(':')).slice(0, 12)
  if (provider === 'postgres') return { suffix, database: 'oes_' + suffix + '_' + token(owner, 20).replaceAll('-', '_'), migrator: 'm_' + suffix, runtime: 'r_' + suffix }
  if (provider === 'minio') return { suffix, bucket: 'oes-' + suffix, accessKey: 'a' + suffix, policy: 'p-' + suffix }
  if (provider === 'redis') return { suffix, user: 'u_' + suffix, namespace: 'oes:' + suffix, eventScope: sha256(identity).slice(0, 12) }
  throw new Error('LOGICAL_RESOURCE_PROVIDER_INVALID provider=' + provider)
}

/** Returns the exact Stack-owned provider directory for one pool and provider. */
function sharedProviderDirectory(context, provider) { return path.join(context.stackRoot, 'providers', context.pool, provider) }

/** Returns the exact Stack-private credential directory for one pool and provider. */
function sharedCredentialDirectory(context, provider) { return path.join(context.stackRoot, 'credentials', context.pool, provider) }

/** Selects persistent DEV or ephemeral Run credential publication. */
function runtimeCredentialRoot(context) { return context.profile === 'DEV' ? context.stackRoot : context.runDirectory }

/** Runs Docker without exposing secret-bearing arguments in evidence. */
function docker(args, options = {}) { return runChecked('docker', args, options) }

/** Returns one container inspection or null without name-based ownership inference. */
function inspectContainer(name) {
  const result = runChecked('docker', ['inspect', '--type', 'container', name], { timeout: 20000 })
  return JSON.parse(result.stdout)[0]
}

/** Reopens one Docker volume and returns its exact inspection value. */
function inspectVolume(name) {
  return JSON.parse(runChecked('docker', ['volume', 'inspect', name], { timeout: 20000 }).stdout)[0]
}

/** Fingerprints the immutable identity fields available for a Docker local volume. */
function volumeObjectId(value) {
  return fingerprint({ name: value.Name, createdAt: value.CreatedAt, driver: value.Driver, scope: value.Scope, labels: value.Labels || {} })
}

/** Creates one explicitly labelled volume and seals its reopenable identity. */
function createManagedVolume(name, resourceLabels) {
  docker(['volume', 'create', ...labelArgs(resourceLabels), name])
  const observed = inspectVolume(name)
  if (Object.entries(resourceLabels).some(([key, value]) => observed.Labels?.[key] !== value)) throw new Error(`VOLUME_LABEL_MISMATCH name=${name}`)
  return { name, objectId: volumeObjectId(observed), labels: resourceLabels, createdAt: observed.CreatedAt, driver: observed.Driver, scope: observed.Scope }
}

/** Requires a managed volume to retain its sealed name, metadata fingerprint and labels. */
function assertManagedVolumeIdentity(resource) {
  const observed = inspectVolume(resource.name)
  if (volumeObjectId(observed) !== resource.objectId || Object.entries(resource.labels).some(([key, value]) => observed.Labels?.[key] !== value)) throw new Error(`VOLUME_IDENTITY_MISMATCH name=${resource.name}`)
  return observed
}

/** Deletes one exact run-owned managed volume after reopening its sealed identity. */
function deleteManagedVolume(resource) {
  assertManagedVolumeIdentity(resource)
  docker(['volume', 'rm', resource.name])
}

/** Returns an exact published loopback endpoint after Docker authorizes it. */
function publishedPort(name, target) {
  const output = docker(['port', name, `${target}/tcp`]).stdout.trim()
  const match = output.match(/127\.0\.0\.1:(\d+)$/u)
  if (!match) throw new Error(`DOCKER_PUBLISHED_PORT_INVALID name=${name} target=${target}`)
  return Number(match[1])
}

/** Reopens every target port's current Docker-authorized loopback publication. */
function publishedPorts(name, targets) { return Object.fromEntries(targets.map((target) => [String(target), publishedPort(name, target)])) }

/** Polls one predicate until readiness or a bounded timeout. */
async function waitReady(check, description, timeoutMs = 120000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try { if (await check()) return } catch (error) { last = error }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`PROVIDER_READINESS_TIMEOUT provider=${description} last=${last?.message || 'not-ready'}`)
}

/** Builds the mandatory V2 identity labels for one managed runtime resource. */
export function runtimeLabels(context, scope, provider) {
  return {
    'oes.runtime.version': '2',
    'oes.runtime.stack-key': context.stackKey,
    'oes.runtime.dev-stack-id': context.devStackId,
    'oes.runtime.scope': scope,
    'oes.runtime.pool': context.pool,
    'oes.runtime.provider': provider,
    ...(['RUN', 'CI'].includes(scope) ? { 'oes.runtime.task-key': context.taskKey, 'oes.runtime.run-id': context.runId } : {}),
    ...(scope === 'CI' ? { 'oes.runtime.ci-job-fingerprint': context.jobFingerprint, 'oes.runtime.ci-job-identity': context.jobIdentity } : {})
  }
}

/** Converts labels to exact Docker create arguments. */
function labelArgs(values) { return Object.entries(values).flatMap(([key, value]) => ['--label', `${key}=${value}`]) }

/** Recognizes Docker's explicit host-port allocation failures without masking other restart errors. */
export function isPublishedPortCollision(error) {
  return /port is already allocated|address already in use|failed to bind host port/iu.test(`${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`)
}

/** Builds one complete Docker create command from sealed provider inputs. */
function sharedContainerArgs({ name, resourceLabels, image, ports, command, environment, volume, volumeTarget, mounts, tmpfs, network }) {
  const args = ['run', '--detach', '--name', name, ...labelArgs(resourceLabels), ...ports.flatMap((port) => ['--publish', `127.0.0.1::${port}`])]
  if (network) args.push('--network', network, '--network-alias', resourceLabels['oes.runtime.provider'])
  if (volume) args.push('--volume', `${volume.name}:${volumeTarget}`)
  for (const mount of mounts) args.push('--volume', mount)
  for (const target of tmpfs) args.push('--tmpfs', target)
  for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`)
  args.push(image, ...command)
  return args
}

/** Requires a reopened resource to retain its sealed Docker identity and labels. */
export function assertDockerIdentity(resource) {
  const observed = inspectContainer(resource.name)
  if (observed.Id !== resource.objectId) throw new Error(`RESOURCE_OBJECT_ID_MISMATCH name=${resource.name}`)
  for (const [key, value] of Object.entries(resource.labels)) if (observed.Config.Labels?.[key] !== value) throw new Error(`RESOURCE_LABEL_MISMATCH name=${resource.name} label=${key}`)
  return observed
}

/** Creates or reopens one shared provider container bound only to devStackId. */
async function ensureSharedContainer({ context, provider, image, targetPort, targetPorts, command = [], environment = {}, volumeTarget, mounts = [], tmpfs = [], network }) {
  const name = sharedResourceName(context.devStackId, context.pool, provider)
  const providerDirectory = sharedProviderDirectory(context, provider)
  const identityPath = path.join(providerDirectory, 'identity.json')
  const ports = targetPorts || [targetPort]
  if (fs.existsSync(identityPath)) {
    const expected = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
    const observed = assertDockerIdentity(expected)
    const wasStopped = !observed.State.Running
    if (!observed.State.Running) {
      try {
        docker(['start', name])
      } catch (error) {
        if (!isPublishedPortCollision(error)) throw error
        const transactionPath = path.join(providerDirectory, 'restart-transaction.json')
        writeAtomic(transactionPath, { schemaVersion: 2, kind: 'OES_SHARED_PROVIDER_PORT_REALLOCATION', lifecycle: 'ALLOCATING', provider, name, previousObjectId: expected.objectId, labels: expected.labels })
        assertDockerIdentity(expected)
        docker(['rm', expected.objectId])
        const args = sharedContainerArgs({ name, resourceLabels: expected.labels, image, ports, command, environment, volume: expected.volume, volumeTarget, mounts, tmpfs, network })
        docker(args, { timeout: 180000 })
        const replacement = inspectContainer(name)
        const resource = { ...expected, objectId: replacement.Id, publishedPorts: publishedPorts(name, ports) }
        writeAtomic(identityPath, resource)
        writeAtomic(transactionPath, { schemaVersion: 2, kind: 'OES_SHARED_PROVIDER_PORT_REALLOCATION', lifecycle: 'REGISTERED', provider, name, previousObjectId: expected.objectId, replacementObjectId: resource.objectId, labels: expected.labels })
        fs.rmSync(transactionPath)
        return { resource, created: false, portReallocated: true, providerDirectory }
      }
    }
    const currentPublishedPorts = publishedPorts(name, ports)
    const portReallocated = wasStopped && fingerprint(expected.publishedPorts || {}) !== fingerprint(currentPublishedPorts)
    const resource = { ...expected, publishedPorts: currentPublishedPorts }
    if (fingerprint(resource) !== fingerprint(expected)) writeAtomic(identityPath, resource)
    if (portReallocated) {
      const event = { schemaVersion: 2, kind: 'OES_SHARED_PROVIDER_PORT_REALLOCATION', lifecycle: 'REGISTERED', provider, name, objectId: resource.objectId, previousPublishedPorts: expected.publishedPorts || null, publishedPorts: currentPublishedPorts }
      writeAtomic(path.join(providerDirectory, 'last-port-reallocation.json'), { ...event, recordFingerprint: fingerprint(event) })
    }
    return { resource, created: false, portReallocated, providerDirectory }
  }
  fs.mkdirSync(providerDirectory, { recursive: true, mode: 0o700 })
  const resourceLabels = runtimeLabels(context, 'SHARED', provider)
  const volume = volumeTarget ? createManagedVolume(`${name}-data`, resourceLabels) : null
  const args = sharedContainerArgs({ name, resourceLabels, image, ports, command, environment, volume, volumeTarget, mounts, tmpfs, network })
  try { docker(args, { timeout: 180000 }) } catch (error) {
    if (volume) deleteManagedVolume(volume)
    throw error
  }
  const observed = inspectContainer(name)
  const resource = { provider, scope: 'SHARED', kind: 'container', name, objectId: observed.Id, labels: resourceLabels, volume, publishedPorts: publishedPorts(name, ports), cleanup: 'PRESERVE_SHARED' }
  writeAtomic(identityPath, resource)
  return { resource, created: true, providerDirectory }
}

/** Creates or reopens one exact devStack-scoped Docker network. */
function ensureSharedNetwork(context, provider) {
  const directory = sharedProviderDirectory(context, provider)
  const identityPath = path.join(directory, 'network-identity.json')
  if (fs.existsSync(identityPath)) {
    const expected = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
    const observed = JSON.parse(docker(['network', 'inspect', expected.objectId]).stdout)[0]
    if (observed.Id !== expected.objectId || Object.entries(expected.labels).some(([key, value]) => observed.Labels?.[key] !== value)) throw new Error(`SHARED_NETWORK_IDENTITY_MISMATCH provider=${provider}`)
    return expected
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const name = sharedResourceName(context.devStackId, context.pool, provider)
  const resourceLabels = runtimeLabels(context, 'SHARED', provider)
  docker(['network', 'create', ...labelArgs(resourceLabels), name])
  const resource = { provider, scope: 'SHARED', kind: 'network', name, objectId: docker(['network', 'inspect', '--format', '{{.Id}}', name]).stdout.trim(), labels: resourceLabels, cleanup: 'PRESERVE_SHARED' }
  writeAtomic(identityPath, resource)
  return resource
}

/** Creates one run-owned provider container with dynamic endpoint authority. */
async function createRunContainer({ context, provider, image, targetPort, targetPorts, command = [], environment = {}, volumeTarget, mounts = [], network }) {
  const scope = context.profile === 'CI' ? 'CI' : 'RUN'
  const name = context.profile === 'CI'
    ? `oes-v2-ci-${context.jobFingerprint}-${exactResourceToken(exactRunIdentity(context))}-${provider}`
    : `oes-v2-${exactResourceToken(exactRunIdentity(context))}-${provider}`
  const resourceLabels = runtimeLabels(context, scope, provider)
  const volume = volumeTarget ? createManagedVolume(`${name}-data`, resourceLabels) : null
  const ports = targetPorts || [targetPort]
  const args = ['run', '--detach', '--name', name, ...labelArgs(resourceLabels), ...ports.flatMap((port) => ['--publish', `127.0.0.1::${port}`])]
  if (network) args.push('--network', network)
  if (volume) args.push('--volume', `${volume.name}:${volumeTarget}`)
  for (const mount of mounts) args.push('--volume', mount)
  for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`)
  args.push(image, ...command)
  try { docker(args, { timeout: 180000 }) } catch (error) {
    if (volume) deleteManagedVolume(volume)
    throw error
  }
  const observed = inspectContainer(name)
  return { provider, scope, kind: 'container', name, objectId: observed.Id, labels: resourceLabels, volume, cleanup: 'DELETE_EXACT' }
}

/** Returns the exact owners authorized for one provider by the sealed plan. */
function ownersFor(context, provider) { return context.providerOwners?.[provider] || context.owners }

/** Reconciles only partially created Docker objects carrying this run and provider's exact V2 labels. */
function cleanupPartialProviderDockerObjects(provider, context) {
  const providerNames = new Set([provider, ...(provider === 'nacos' ? ['nacos-mysql'] : [])])
  const filter = ['--filter', 'label=oes.runtime.version=2', '--filter', `label=oes.runtime.task-key=${context.taskKey}`, '--filter', `label=oes.runtime.run-id=${context.runId}`]
  const ids = docker(['ps', '-aq', ...filter]).stdout.trim().split(/\s+/u).filter(Boolean)
  const containers = ids.map((id) => JSON.parse(docker(['inspect', '--type', 'container', id]).stdout)[0]).filter((item) => providerNames.has(item.Config?.Labels?.['oes.runtime.provider']))
  const volumes = [...new Set(containers.flatMap((item) => (item.Mounts || []).filter((mount) => mount.Type === 'volume').map((mount) => mount.Name)))].map((name) => {
    const observed = inspectVolume(name)
    return { name, objectId: volumeObjectId(observed), labels: observed.Labels || {}, createdAt: observed.CreatedAt, driver: observed.Driver, scope: observed.Scope }
  })
  const removed = []
  for (const item of containers.reverse()) {
    const observedLabels = item.Config?.Labels || {}
    if (observedLabels['oes.runtime.version'] !== '2' || observedLabels['oes.runtime.task-key'] !== context.taskKey || observedLabels['oes.runtime.run-id'] !== context.runId || !providerNames.has(observedLabels['oes.runtime.provider'])) throw new Error(`PARTIAL_PROVIDER_IDENTITY_MISMATCH objectId=${item.Id}`)
    docker(['rm', '--force', item.Id])
    removed.push({ type: 'container', objectId: item.Id, name: String(item.Name).replace(/^\//u, '') })
  }
  const networkIds = docker(['network', 'ls', '-q', ...filter]).stdout.trim().split(/\s+/u).filter(Boolean)
  for (const id of networkIds) {
    const item = JSON.parse(docker(['network', 'inspect', id]).stdout)[0]
    if (!providerNames.has(item.Labels?.['oes.runtime.provider'])) continue
    if (Object.keys(item.Containers || {}).length) throw new Error(`PARTIAL_PROVIDER_NETWORK_ATTACHED objectId=${item.Id}`)
    docker(['network', 'rm', item.Id])
    removed.push({ type: 'network', objectId: item.Id, name: item.Name })
  }
  for (const volume of volumes) {
    if (volume.labels['oes.runtime.version'] !== '2' || volume.labels['oes.runtime.task-key'] !== context.taskKey || volume.labels['oes.runtime.run-id'] !== context.runId || !providerNames.has(volume.labels['oes.runtime.provider'])) throw new Error(`PARTIAL_PROVIDER_VOLUME_IDENTITY_MISMATCH name=${volume.name}`)
    deleteManagedVolume(volume)
    removed.push({ type: 'volume', objectId: volume.objectId, name: volume.name })
  }
  const record = { schemaVersion: 2, kind: 'OES_PARTIAL_PROVIDER_RECONCILIATION', provider, taskKey: context.taskKey, runId: context.runId, removed, exitStatus: 0 }
  writeAtomic(path.join(context.runDirectory, 'provider', `${provider}-partial-cleanup.json`), record)
  return record
}

/** Starts PostgreSQL and creates per-owner migrator/runtime roles and databases. */
async function provisionPostgres(context, shared) {
  const rootUser = 'oes_provisioner'
  const credentialPath = path.join(sharedCredentialDirectory(context, 'postgres'), 'bootstrap.json')
  let rootPassword
  let container
  if (shared && fs.existsSync(credentialPath)) {
    rootPassword = JSON.parse(fs.readFileSync(credentialPath, 'utf8')).rootPassword
    container = (await ensureSharedContainer({ context, provider: 'postgres', image: IMAGES.postgres, targetPort: 5432, environment: { POSTGRES_USER: rootUser, POSTGRES_PASSWORD: rootPassword, POSTGRES_DB: 'postgres' }, volumeTarget: '/var/lib/postgresql/data' })).resource
  } else {
    rootPassword = randomSecret()
    if (shared) {
      writeAtomic(credentialPath, { rootUser, rootPassword }, 0o600)
      container = (await ensureSharedContainer({ context, provider: 'postgres', image: IMAGES.postgres, targetPort: 5432, environment: { POSTGRES_USER: rootUser, POSTGRES_PASSWORD: rootPassword, POSTGRES_DB: 'postgres' }, volumeTarget: '/var/lib/postgresql/data' })).resource
    } else {
      container = await createRunContainer({ context, provider: 'postgres', image: IMAGES.postgres, targetPort: 5432, environment: { POSTGRES_USER: rootUser, POSTGRES_PASSWORD: rootPassword, POSTGRES_DB: 'postgres' }, volumeTarget: '/var/lib/postgresql/data' })
    }
  }
  let stableReadinessCount = 0
  await waitReady(() => {
    try {
      const result = runChecked('docker', ['exec', '-e', `PGPASSWORD=${rootPassword}`, container.name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', rootUser, '-d', 'postgres', '-c', 'SELECT 1'], { timeout: 10000 })
      stableReadinessCount = result.stdout.includes('(1 row)') ? stableReadinessCount + 1 : 0
      return stableReadinessCount >= 2
    } catch {
      stableReadinessCount = 0
      return false
    }
  }, 'postgres')
  const rootCredentialPath = shared ? credentialPath : path.join(context.runDirectory, 'provider', 'postgres-bootstrap.json')
  if (!shared) writeAtomic(rootCredentialPath, { rootUser, rootPassword }, 0o600)
  const rootCredentialReference = { path: rootCredentialPath, sha256: sha256(fs.readFileSync(rootCredentialPath)) }
  const port = publishedPort(container.name, 5432)
  const ownerEnvironments = {}
  const migratorEnvironments = {}
  const allocations = []
  for (const owner of ownersFor(context, 'postgres')) {
    const persistent = context.profile === 'DEV'
    const { suffix, database, migrator, runtime } = logicalResourceIdentity(context, 'postgres', owner)
    const ownerCredentialPath = persistent ? path.join(sharedCredentialDirectory(context, 'postgres'), 'owners', `${owner}.json`) : null
    const persisted = ownerCredentialPath && fs.existsSync(ownerCredentialPath) ? JSON.parse(fs.readFileSync(ownerCredentialPath, 'utf8')) : null
    const migratorPassword = persisted?.migratorPassword || randomSecret()
    const runtimePassword = persisted?.runtimePassword || randomSecret()
    if (ownerCredentialPath && !persisted) writeAtomic(ownerCredentialPath, { database, migrator, migratorPassword, runtime, runtimePassword }, 0o600)
    const execSql = (sql) => docker(['exec', '-e', `PGPASSWORD=${rootPassword}`, container.name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', rootUser, '-d', 'postgres', '-c', sql])
    const roleExists = (role) => execSql(`SELECT 1 FROM pg_roles WHERE rolname='${role}'`).stdout.includes('1')
    const databaseExists = () => execSql(`SELECT 1 FROM pg_database WHERE datname='${database}'`).stdout.includes('1')
    if (!roleExists(migrator)) execSql(`CREATE ROLE ${migrator} LOGIN PASSWORD '${migratorPassword}'`)
    else execSql(`ALTER ROLE ${migrator} LOGIN PASSWORD '${migratorPassword}'`)
    if (!roleExists(runtime)) execSql(`CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}'`)
    else execSql(`ALTER ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}'`)
    if (!databaseExists()) execSql(`CREATE DATABASE ${database} OWNER ${migrator}`)
    execSql(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`)
    execSql(`GRANT CONNECT ON DATABASE ${database} TO ${migrator}, ${runtime}`)
    const migratorUrl = `postgresql://${migrator}:${encodeURIComponent(migratorPassword)}@127.0.0.1:${port}/${database}?schema=public`
    const runtimeUrl = `postgresql://${runtime}:${encodeURIComponent(runtimePassword)}@127.0.0.1:${port}/${database}?schema=public`
    ownerEnvironments[owner] = { DATABASE_URL: runtimeUrl }
    migratorEnvironments[owner] = { DATABASE_URL: migratorUrl }
    allocations.push({ provider: 'postgres', kind: 'database', scope: persistent ? 'SHARED' : context.profile === 'CI' ? 'CI' : 'RUN', owner, database, migrator, runtime, containerName: container.name, containerObjectId: container.objectId, containerScope: container.scope, rootCredentialReference, cleanup: persistent ? 'PRESERVE_SHARED' : 'DROP_EXACT' })
  }
  const reference = writeCredentialBundle(runtimeCredentialRoot(context), 'postgres', ownerEnvironments)
  writeMigratorCredentialBundle(context, migratorEnvironments)
  return {
    resources: [container, ...allocations],
    endpoints: [{ provider: 'postgres', authority: `docker:${container.objectId}:5432/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'postgres'), environment: { OES_POSTGRES_HOST: '127.0.0.1', OES_POSTGRES_PORT: String(port) }, credentialReference: reference }]
  }
}

/** Starts shared or job-private MinIO and creates one policy-scoped bucket/user per Asset owner. */
async function provisionMinio(context, shared) {
  const rootUser = 'oes_root'
  const credentialPath = path.join(sharedCredentialDirectory(context, 'minio'), 'bootstrap.json')
  let rootPassword
  let container
  if (shared && fs.existsSync(credentialPath)) {
    rootPassword = JSON.parse(fs.readFileSync(credentialPath, 'utf8')).rootPassword
    container = (await ensureSharedContainer({ context, provider: 'minio', image: IMAGES.minio, targetPort: 9000, command: ['server', '/data', '--console-address', ':9001'], environment: { MINIO_ROOT_USER: rootUser, MINIO_ROOT_PASSWORD: rootPassword }, volumeTarget: '/data' })).resource
  } else {
    rootPassword = randomSecret()
    if (shared) {
      writeAtomic(credentialPath, { rootUser, rootPassword }, 0o600)
      container = (await ensureSharedContainer({ context, provider: 'minio', image: IMAGES.minio, targetPort: 9000, command: ['server', '/data', '--console-address', ':9001'], environment: { MINIO_ROOT_USER: rootUser, MINIO_ROOT_PASSWORD: rootPassword }, volumeTarget: '/data' })).resource
    } else {
      container = await createRunContainer({ context, provider: 'minio', image: IMAGES.minio, targetPort: 9000, command: ['server', '/data', '--console-address', ':9001'], environment: { MINIO_ROOT_USER: rootUser, MINIO_ROOT_PASSWORD: rootPassword }, volumeTarget: '/data' })
    }
  }
  const port = publishedPort(container.name, 9000)
  const endpoint = `http://127.0.0.1:${port}`
  await waitReady(async () => (await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(2000) })).ok, 'minio')
  const adminCredentialPath = shared ? credentialPath : path.join(context.runDirectory, 'provider', 'minio-bootstrap.json')
  if (!shared) writeAtomic(adminCredentialPath, { rootUser, rootPassword }, 0o600)
  const adminBytes = fs.readFileSync(adminCredentialPath)
  const adminCredentialReference = { path: adminCredentialPath, sha256: sha256(adminBytes) }
  const ownerEnvironments = {}
  const allocations = []
  for (const owner of ownersFor(context, 'minio')) {
    if (owner !== 'asset-service') throw new Error(`MINIO_OWNER_DENIED owner=${owner}`)
    const persistent = context.profile === 'DEV'
    const { suffix, bucket, accessKey, policy } = logicalResourceIdentity(context, 'minio', owner)
    const ownerCredentialPath = persistent ? path.join(sharedCredentialDirectory(context, 'minio'), 'owners', `${owner}.json`) : null
    const persisted = ownerCredentialPath && fs.existsSync(ownerCredentialPath) ? JSON.parse(fs.readFileSync(ownerCredentialPath, 'utf8')) : null
    const secretKey = persisted?.secretKey || randomSecret()
    if (ownerCredentialPath && !persisted) writeAtomic(ownerCredentialPath, { bucket, accessKey, secretKey }, 0o600)
    const policyPath = path.join(context.runDirectory, 'provider', `minio-policy-${suffix}.json`)
    writeAtomic(policyPath, { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`] }, { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }] })
    const script = `mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing local/${bucket} >/dev/null && mc admin user add -- local ${accessKey} "$MINIO_USER_SECRET" >/dev/null && (mc admin policy info local ${policy} >/dev/null 2>&1 || mc admin policy create local ${policy} /policy.json >/dev/null) && mc admin policy attach local ${policy} --user ${accessKey} >/dev/null`
    docker(['run', '--rm', '--network', `container:${container.name}`, '--env', `MINIO_ROOT_USER=${rootUser}`, '--env', `MINIO_ROOT_PASSWORD=${rootPassword}`, '--env', `MINIO_USER_SECRET=${secretKey}`, '--volume', `${policyPath}:/policy.json:ro`, '--entrypoint', 'sh', IMAGES.minioClient, '-ec', script], { timeout: 120000 })
    ownerEnvironments[owner] = { ASSET_S3_ENDPOINT: endpoint, ASSET_S3_ACCESS_KEY_ID: accessKey, ASSET_S3_SECRET_ACCESS_KEY: secretKey, ASSET_S3_BUCKET: bucket, ASSET_S3_FORCE_PATH_STYLE: 'true' }
    allocations.push({ provider: 'minio', kind: 'bucket', scope: persistent ? 'SHARED' : context.profile === 'CI' ? 'CI' : 'RUN', owner, bucket, accessKey, policy, containerName: container.name, containerObjectId: container.objectId, containerScope: container.scope, adminCredentialReference, cleanup: persistent ? 'PRESERVE_SHARED' : 'DELETE_LOGICAL_EXACT' })
  }
  const reference = writeCredentialBundle(runtimeCredentialRoot(context), 'minio', ownerEnvironments)
  return { resources: [container, ...allocations], endpoints: [{ provider: 'minio', authority: `docker:${container.objectId}:9000/tcp`, host: '127.0.0.1', port, ready: true, owners: Object.keys(ownerEnvironments), environment: { ASSET_S3_ENDPOINT: endpoint }, credentialReference: reference }] }
}

/** Starts shared DEV or run-private Redis with per-owner ACL users and namespaces. */
async function provisionRedis(context, shared) {
  const bootstrapPath = path.join(sharedCredentialDirectory(context, 'redis'), 'bootstrap.json')
  const persistedBootstrap = shared && fs.existsSync(bootstrapPath) ? JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) : null
  const adminPassword = persistedBootstrap?.adminPassword || randomSecret()
  if (shared && !persistedBootstrap) writeAtomic(bootstrapPath, { adminPassword }, 0o600)
  const container = shared ? (await ensureSharedContainer({ context, provider: 'redis', image: IMAGES.redis, targetPort: 6379, command: ['redis-server', '--requirepass', adminPassword], volumeTarget: '/data' })).resource : await createRunContainer({ context, provider: 'redis', image: IMAGES.redis, targetPort: 6379, command: ['redis-server', '--requirepass', adminPassword] })
  await waitReady(() => docker(['exec', container.name, 'redis-cli', '-a', adminPassword, 'PING']).stdout.includes('PONG'), 'redis')
  const port = publishedPort(container.name, 6379)
  const ownerEnvironments = {}
  const allocations = []
  for (const owner of ownersFor(context, 'redis')) {
    const { suffix, user, namespace, eventScope } = logicalResourceIdentity(context, 'redis', owner)
    const ownerCredentialPath = shared ? path.join(sharedCredentialDirectory(context, 'redis'), 'owners', `${owner}.json`) : null
    const persisted = ownerCredentialPath && fs.existsSync(ownerCredentialPath) ? JSON.parse(fs.readFileSync(ownerCredentialPath, 'utf8')) : null
    const password = persisted?.password || randomSecret()
    const terminalDeviceUnavailableChannel = `oes:${eventScope}:events:terminal-device.unavailable`
    if (ownerCredentialPath && !persisted) writeAtomic(ownerCredentialPath, { user, password, namespace }, 0o600)
    docker(['exec', container.name, 'redis-cli', '-a', adminPassword, 'ACL', 'SETUSER', user, 'resetkeys', 'resetchannels', 'on', `>${password}`, `~${namespace}:*`, `&${terminalDeviceUnavailableChannel}`, ...REDIS_RUNTIME_ACL_COMMAND_RULES])
    ownerEnvironments[owner] = { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port), REDIS_USERNAME: user, REDIS_PASSWORD: password, OES_REDIS_NAMESPACE: namespace, TERMINAL_DEVICE_UNAVAILABLE_REDIS_CHANNEL: terminalDeviceUnavailableChannel }
    allocations.push({ provider: 'redis', kind: 'acl-user', scope: shared ? 'SHARED' : context.profile === 'CI' ? 'CI' : 'RUN', owner, user, namespace, containerName: container.name, containerObjectId: container.objectId, containerScope: container.scope, cleanup: shared ? 'PRESERVE_SHARED' : 'DELETED_WITH_OWNED_CONTAINER' })
  }
  const reference = writeCredentialBundle(runtimeCredentialRoot(context), 'redis', ownerEnvironments)
  return { resources: [container, ...allocations], endpoints: [{ provider: 'redis', authority: `docker:${container.objectId}:6379/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'redis'), environment: { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port) }, credentialReference: reference }] }
}

/** Starts shared DEV or run-private NATS with frozen topology and owner-scoped credentials. */
async function provisionNats(context, shared) {
  const secret = () => `s${randomSecret(24).replace(/[^a-zA-Z0-9]/gu, '')}`
  const identity = shared ? context.devStackId : exactRunIdentity(context)
  const credentialsPath = shared ? path.join(sharedCredentialDirectory(context, 'nats'), 'credentials.json') : null
  const stored = credentialsPath && fs.existsSync(credentialsPath) ? JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) : null
  const credentials = stored || {
    NATS_COLLABORATION_USER: `collaboration_${sha256(identity).slice(0, 8)}`, NATS_COLLABORATION_PASSWORD: secret(),
    NATS_ASSET_USER: `asset_${sha256(identity).slice(0, 8)}`, NATS_ASSET_PASSWORD: secret(),
    NATS_SITE_USER: `site_${sha256(identity).slice(0, 8)}`, NATS_SITE_PASSWORD: secret(),
    NATS_NOTIFICATION_USER: `notification_${sha256(identity).slice(0, 8)}`, NATS_NOTIFICATION_PASSWORD: secret(),
    NATS_NOTIFICATION_REPLAY_USER: `replay_${sha256(identity).slice(0, 8)}`, NATS_NOTIFICATION_REPLAY_PASSWORD: secret(),
    NATS_NOTIFICATION_RECOVERY_USER: `recovery_${sha256(identity).slice(0, 8)}`, NATS_NOTIFICATION_RECOVERY_PASSWORD: secret(),
    NATS_OPERATOR_USER: `operator_${sha256(identity).slice(0, 8)}`, NATS_OPERATOR_PASSWORD: secret(),
    NATS_NOTIFICATION_REPLAY_ASSIGNED_CREATE_SUBJECT: "'$JS.API.CONSUMER.CREATE.OES_BUSINESS_EVENTS notification-service__replay__runtime__assigned.oes.events.collaboration.task.assigned'",
    NATS_NOTIFICATION_REPLAY_COMPLETED_CREATE_SUBJECT: "'$JS.API.CONSUMER.CREATE.OES_BUSINESS_EVENTS notification-service__replay__runtime__completed.oes.events.collaboration.task.completed'",
    NATS_NOTIFICATION_REPLAY_CANCELLED_CREATE_SUBJECT: "'$JS.API.CONSUMER.CREATE.OES_BUSINESS_EVENTS notification-service__replay__runtime__cancelled.oes.events.collaboration.task.cancelled'",
    NATS_NOTIFICATION_REPLAY_ASSIGNED_INFO_SUBJECT: "'$JS.API.CONSUMER.INFO.OES_BUSINESS_EVENTS notification-service__replay__runtime__assigned'",
    NATS_NOTIFICATION_REPLAY_COMPLETED_INFO_SUBJECT: "'$JS.API.CONSUMER.INFO.OES_BUSINESS_EVENTS notification-service__replay__runtime__completed'",
    NATS_NOTIFICATION_REPLAY_CANCELLED_INFO_SUBJECT: "'$JS.API.CONSUMER.INFO.OES_BUSINESS_EVENTS notification-service__replay__runtime__cancelled'",
    NATS_NOTIFICATION_REPLAY_ASSIGNED_DELETE_SUBJECT: "'$JS.API.CONSUMER.DELETE.OES_BUSINESS_EVENTS notification-service__replay__runtime__assigned'",
    NATS_NOTIFICATION_REPLAY_COMPLETED_DELETE_SUBJECT: "'$JS.API.CONSUMER.DELETE.OES_BUSINESS_EVENTS notification-service__replay__runtime__completed'",
    NATS_NOTIFICATION_REPLAY_CANCELLED_DELETE_SUBJECT: "'$JS.API.CONSUMER.DELETE.OES_BUSINESS_EVENTS notification-service__replay__runtime__cancelled'",
    NATS_NOTIFICATION_REPLAY_ASSIGNED_NEXT_SUBJECT: "'$JS.API.CONSUMER.MSG.NEXT.OES_BUSINESS_EVENTS notification-service__replay__runtime__assigned'",
    NATS_NOTIFICATION_REPLAY_COMPLETED_NEXT_SUBJECT: "'$JS.API.CONSUMER.MSG.NEXT.OES_BUSINESS_EVENTS notification-service__replay__runtime__completed'",
    NATS_NOTIFICATION_REPLAY_CANCELLED_NEXT_SUBJECT: "'$JS.API.CONSUMER.MSG.NEXT.OES_BUSINESS_EVENTS notification-service__replay__runtime__cancelled'",
    NATS_NOTIFICATION_REPLAY_ASSIGNED_ACK_SUBJECT: "'$JS.ACK.OES_BUSINESS_EVENTS.notification-service__replay__runtime__assigned.>'",
    NATS_NOTIFICATION_REPLAY_COMPLETED_ACK_SUBJECT: "'$JS.ACK.OES_BUSINESS_EVENTS.notification-service__replay__runtime__completed.>'",
    NATS_NOTIFICATION_REPLAY_CANCELLED_ACK_SUBJECT: "'$JS.ACK.OES_BUSINESS_EVENTS.notification-service__replay__runtime__cancelled.>'"
  }
  if (credentialsPath && !stored) writeAtomic(credentialsPath, credentials, 0o600)
  const ownerEnvironments = {
    'collaboration-service': { NATS_USER: credentials.NATS_COLLABORATION_USER, NATS_PASSWORD: credentials.NATS_COLLABORATION_PASSWORD, NATS_COLLABORATION_USER: credentials.NATS_COLLABORATION_USER, NATS_COLLABORATION_PASSWORD: credentials.NATS_COLLABORATION_PASSWORD },
    'asset-service': { NATS_USER: credentials.NATS_ASSET_USER, NATS_PASSWORD: credentials.NATS_ASSET_PASSWORD, NATS_ASSET_USER: credentials.NATS_ASSET_USER, NATS_ASSET_PASSWORD: credentials.NATS_ASSET_PASSWORD },
    'site-service': { NATS_USER: credentials.NATS_SITE_USER, NATS_PASSWORD: credentials.NATS_SITE_PASSWORD, NATS_SITE_USER: credentials.NATS_SITE_USER, NATS_SITE_PASSWORD: credentials.NATS_SITE_PASSWORD },
    'notification-service': { NATS_USER: credentials.NATS_NOTIFICATION_USER, NATS_PASSWORD: credentials.NATS_NOTIFICATION_PASSWORD, NATS_NOTIFICATION_USER: credentials.NATS_NOTIFICATION_USER, NATS_NOTIFICATION_PASSWORD: credentials.NATS_NOTIFICATION_PASSWORD, NATS_NOTIFICATION_REPLAY_USER: credentials.NATS_NOTIFICATION_REPLAY_USER, NATS_NOTIFICATION_REPLAY_PASSWORD: credentials.NATS_NOTIFICATION_REPLAY_PASSWORD, NATS_NOTIFICATION_RECOVERY_USER: credentials.NATS_NOTIFICATION_RECOVERY_USER, NATS_NOTIFICATION_RECOVERY_PASSWORD: credentials.NATS_NOTIFICATION_RECOVERY_PASSWORD }
  }
  const selected = Object.fromEntries(ownersFor(context, 'nats').map((owner) => {
    if (!ownerEnvironments[owner]) throw new Error(`NATS_OWNER_DENIED owner=${owner}`)
    return [owner, ownerEnvironments[owner]]
  }))
  const configPath = shared ? path.join(sharedProviderDirectory(context, 'nats'), 'nats-server.conf') : path.join(context.runDirectory, 'provider', 'nats-server.conf')
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(context.root, 'docker/nats/nats-server.conf'), configPath)
  fs.chmodSync(configPath, 0o600)
  const container = shared ? (await ensureSharedContainer({ context, provider: 'nats', image: IMAGES.nats, targetPorts: [4222, 8222], command: ['-c', '/etc/nats/nats-server.conf'], environment: credentials, mounts: [`${configPath}:/etc/nats/nats-server.conf:ro`], volumeTarget: '/data' })).resource : await createRunContainer({ context, provider: 'nats', image: IMAGES.nats, targetPorts: [4222, 8222], command: ['-c', '/etc/nats/nats-server.conf'], environment: credentials, mounts: [`${configPath}:/etc/nats/nats-server.conf:ro`], volumeTarget: '/data' })
  await waitReady(() => docker(['exec', container.name, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8222/healthz?js-enabled-only']).stdout.includes('ok'), 'nats')
  const port = publishedPort(container.name, 4222)
  const bootstrapEnvironment = { NATS_URL: 'nats://127.0.0.1:4222', NATS_OPERATOR_USER: credentials.NATS_OPERATOR_USER, NATS_OPERATOR_PASSWORD: credentials.NATS_OPERATOR_PASSWORD }
  docker(['run', '--rm', '--network', `container:${container.name}`, ...Object.entries(bootstrapEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--volume', `${path.join(context.root, 'docker/nats/bootstrap.sh')}:/etc/nats/bootstrap.sh:ro`, '--volume', `${path.join(context.root, 'docker/nats/topology')}:/etc/nats/topology:ro`, IMAGES.natsBox, 'sh', '/etc/nats/bootstrap.sh'], { timeout: 120000 })
  for (const environment of Object.values(selected)) environment.NATS_URL = `nats://127.0.0.1:${port}`
  const reference = writeCredentialBundle(runtimeCredentialRoot(context), 'nats', selected)
  return { resources: [container], endpoints: [{ provider: 'nats', authority: `docker:${container.objectId}:4222/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'nats'), environment: { NATS_URL: `nats://127.0.0.1:${port}` }, credentialReference: reference }] }
}

/** Creates a stable DEV or per-run CA and SPIFFE URI certificate for each owner. */
async function provisionMtls(context, shared) {
  const directory = shared ? sharedCredentialDirectory(context, 'mtls') : path.join(context.runDirectory, 'provider', 'mtls')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const caKey = path.join(directory, 'ca.key')
  const ca = path.join(directory, 'ca.pem')
  if (!fs.existsSync(caKey) || !fs.existsSync(ca)) {
    runChecked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=oes-${shared ? token(context.devStackId) : exactResourceToken(exactRunIdentity(context))}`, '-keyout', caKey, '-out', ca, '-days', shared ? '3650' : '2'], { timeout: 60000 })
    fs.chmodSync(caKey, 0o600)
  }
  const ownerEnvironments = {}
  const certificates = []
  for (const owner of ownersFor(context, 'mtls')) {
    const ownerDirectory = path.join(directory, owner)
    fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 })
    const key = path.join(ownerDirectory, 'key.pem')
    const csr = path.join(ownerDirectory, 'request.csr')
    const cert = path.join(ownerDirectory, 'cert.pem')
    const ext = path.join(ownerDirectory, 'ext.cnf')
    const spiffe = shared ? `spiffe://local.oes.internal/ns/oes/sa/${owner}` : `spiffe://local.oes.internal/task/${context.taskKey}/run/${context.runId}/sa/${owner}`
    const dnsNames = [`${owner}.localhost`, ...(owner === 'auth-service' ? ['issuer.local.oes.internal'] : [])]
    const subjectAltName = [`URI:${spiffe}`, ...dnsNames.map((name) => `DNS:${name}`)].join(',')
    writeAtomic(ext, `subjectAltName=${subjectAltName}\nextendedKeyUsage=clientAuth,serverAuth\n`)
    const existingSans = fs.existsSync(cert) ? runChecked('openssl', ['x509', '-in', cert, '-noout', '-text'], { timeout: 10000 }).stdout : ''
    const requiresReissue = !fs.existsSync(key) || !fs.existsSync(cert) || !existingSans.includes(`URI:${spiffe}`) || dnsNames.some((name) => !existingSans.includes(`DNS:${name}`))
    if (requiresReissue) {
      runChecked('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${owner}`, '-keyout', key, '-out', csr])
      runChecked('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', shared ? '365' : '2', '-extfile', ext])
    }
    fs.chmodSync(key, 0o600)
    ownerEnvironments[owner] = { OES_GRPC_TLS_ENABLED: 'true', OES_GRPC_TLS_MIN_VERSION: 'TLSv1.2', OES_GRPC_TLS_CA_PATH: ca, OES_GRPC_TLS_CERT_PATH: cert, OES_GRPC_TLS_KEY_PATH: key, OES_WORKLOAD_SPIFFE_ID: spiffe }
    const files = [key, csr, cert, ext].map((file) => ({ path: file, sha256: sha256(fs.readFileSync(file)) }))
    certificates.push({ provider: 'mtls', kind: 'certificate', scope: shared ? 'SHARED' : context.profile === 'CI' ? 'CI' : 'RUN', owner, ca, cert, key, spiffe, files, cleanup: shared ? 'PRESERVE_SHARED' : 'DELETE_FILES_EXACT' })
  }
  const reference = writeCredentialBundle(runtimeCredentialRoot(context), 'mtls', ownerEnvironments)
  return { resources: certificates, endpoints: [{ provider: 'mtls', authority: `filesystem:${sha256(fs.readFileSync(ca))}`, ready: true, owners: ownersFor(context, 'mtls'), environment: { OES_GRPC_TLS_ENABLED: 'true' }, credentialReference: reference }] }
}

/** Starts a temporary health-enabled OTel Collector. */
async function provisionOtel(context) {
  const config = path.join(context.runDirectory, 'provider', 'otel.yaml')
  writeAtomic(config, 'extensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  extensions: [health_check]\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n')
  const container = await createRunContainer({ context, provider: 'otel', image: IMAGES.otel, targetPorts: [4318, 13133], command: ['--config=/etc/otel/config.yaml'], mounts: [`${config}:/etc/otel/config.yaml:ro`] })
  const healthPort = publishedPort(container.name, 13133)
  await waitReady(async () => (await fetch(`http://127.0.0.1:${healthPort}/`, { signal: AbortSignal.timeout(2000) })).ok, 'otel')
  const port = publishedPort(container.name, 4318)
  return { resources: [container], endpoints: [{ provider: 'otel', authority: `docker:${container.objectId}:4318/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'otel'), environment: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }, credentialReference: null }] }
}

/** Starts the complete long-lived DEV observability stack on one devStack-scoped network. */
async function provisionOtelFull(context) {
  const directory = sharedProviderDirectory(context, 'otel-full')
  const configDirectory = path.join(directory, 'config')
  const logDirectory = path.join(directory, 'logs')
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 })
  for (const name of ['collector-config.yaml', 'tempo.yaml', 'loki.yaml']) fs.copyFileSync(path.join(context.root, 'docker/otel', name), path.join(configDirectory, name))
  const datasourceDirectory = path.join(configDirectory, 'grafana-datasources')
  fs.mkdirSync(datasourceDirectory, { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(context.root, 'docker/grafana/provisioning/datasources/datasources.yaml'), path.join(datasourceDirectory, 'datasources.yaml'))
  const credentialPath = path.join(sharedCredentialDirectory(context, 'otel-full'), 'grafana-bootstrap.json')
  const stored = fs.existsSync(credentialPath) ? JSON.parse(fs.readFileSync(credentialPath, 'utf8')) : null
  const grafanaCredentials = stored || { user: 'admin', password: randomSecret(24) }
  if (!stored) writeAtomic(credentialPath, grafanaCredentials, 0o600)
  const network = ensureSharedNetwork(context, 'otel-full')
  const tempo = (await ensureSharedContainer({ context, provider: 'tempo', image: IMAGES.tempo, targetPort: 3200, network: network.name, command: ['-config.file=/etc/tempo/tempo.yaml'], mounts: [`${path.join(configDirectory, 'tempo.yaml')}:/etc/tempo/tempo.yaml:ro`], tmpfs: ['/tmp/tempo:mode=1777,uid=0,gid=0'] })).resource
  const loki = (await ensureSharedContainer({ context, provider: 'loki', image: IMAGES.loki, targetPort: 3100, network: network.name, command: ['-config.file=/etc/loki/loki.yaml'], mounts: [`${path.join(configDirectory, 'loki.yaml')}:/etc/loki/loki.yaml:ro`], tmpfs: ['/tmp/loki:mode=1777,uid=0,gid=0'] })).resource
  const grafana = (await ensureSharedContainer({ context, provider: 'grafana', image: IMAGES.grafana, targetPort: 3000, network: network.name, environment: { GF_SECURITY_ADMIN_USER: grafanaCredentials.user, GF_SECURITY_ADMIN_PASSWORD: grafanaCredentials.password, GF_AUTH_ANONYMOUS_ENABLED: 'true', GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer' }, mounts: [`${datasourceDirectory}:/etc/grafana/provisioning/datasources:ro`], volumeTarget: '/var/lib/grafana' })).resource
  const collector = (await ensureSharedContainer({ context, provider: 'otel-full', image: IMAGES.otel, targetPorts: [4317, 4318, 13133], network: network.name, command: ['--config=/etc/otelcol-contrib/config.yaml'], mounts: [`${path.join(configDirectory, 'collector-config.yaml')}:/etc/otelcol-contrib/config.yaml:ro`, `${logDirectory}:/var/log/oes`] })).resource
  const tempoPort = publishedPort(tempo.name, 3200)
  const lokiPort = publishedPort(loki.name, 3100)
  const grafanaPort = publishedPort(grafana.name, 3000)
  const healthPort = publishedPort(collector.name, 13133)
  await Promise.all([
    waitReady(async () => (await fetch(`http://127.0.0.1:${tempoPort}/ready`, { signal: AbortSignal.timeout(2000) })).ok, 'tempo', 180000),
    waitReady(async () => (await fetch(`http://127.0.0.1:${lokiPort}/ready`, { signal: AbortSignal.timeout(2000) })).ok, 'loki', 180000),
    waitReady(async () => (await fetch(`http://127.0.0.1:${grafanaPort}/api/health`, { signal: AbortSignal.timeout(2000) })).ok, 'grafana', 180000),
    waitReady(async () => (await fetch(`http://127.0.0.1:${healthPort}/`, { signal: AbortSignal.timeout(2000) })).ok, 'otel-full', 180000)
  ])
  const port = publishedPort(collector.name, 4318)
  return { resources: [network, tempo, loki, grafana, collector], endpoints: [{ provider: 'otel-full', authority: `docker:${collector.objectId}:4318/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'otel-full'), environment: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }, credentialReference: null, operatorEndpoints: { grafana: `http://127.0.0.1:${grafanaPort}`, loki: `http://127.0.0.1:${lokiPort}`, tempo: `http://127.0.0.1:${tempoPort}` } }] }
}

/** Starts a temporary MySQL-backed Nacos pair and publishes only after both containers are running. */
async function provisionNacos(context, shared) {
  if (shared) {
    const providerDirectory = sharedProviderDirectory(context, 'nacos')
    const credentialPath = path.join(sharedCredentialDirectory(context, 'nacos'), 'bootstrap.json')
    const stored = fs.existsSync(credentialPath) ? JSON.parse(fs.readFileSync(credentialPath, 'utf8')) : null
    const credentials = stored || { rootPassword: randomSecret(), nacosPassword: randomSecret(), username: `runtime_${sha256(context.devStackId).slice(0, 8)}`, password: randomSecret(24), authToken: Buffer.from(randomSecret(48)).toString('base64').slice(0, 64), authIdentityValue: randomSecret() }
    if (!stored) writeAtomic(credentialPath, credentials, 0o600)
    const schemaPath = path.join(providerDirectory, 'mysql-schema.sql')
    fs.mkdirSync(providerDirectory, { recursive: true, mode: 0o700 })
    fs.copyFileSync(path.join(context.root, 'docker/nacos/mysql-schema.sql'), schemaPath)
    const network = ensureSharedNetwork(context, 'nacos')
    const mysql = (await ensureSharedContainer({ context, provider: 'nacos-mysql', image: IMAGES.mysql, targetPort: 3306, network: network.name, environment: { MYSQL_ROOT_PASSWORD: credentials.rootPassword, MYSQL_DATABASE: 'nacos', MYSQL_USER: 'nacos', MYSQL_PASSWORD: credentials.nacosPassword }, mounts: [`${schemaPath}:/docker-entrypoint-initdb.d/01-nacos-schema.sql:ro`], volumeTarget: '/var/lib/mysql' })).resource
    await waitReady(() => docker(['exec', mysql.name, 'mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root', `-p${credentials.rootPassword}`, '--silent']).status === 0, 'nacos-mysql', 180000)
    const passwordHash = runChecked('htpasswd', ['-bnBC', '10', '', credentials.password]).stdout.trim().replace(/^:/u, '')
    docker(['exec', '-e', `MYSQL_PWD=${credentials.nacosPassword}`, mysql.name, 'mysql', '-h', '127.0.0.1', '-u', 'nacos', 'nacos', '-e', `INSERT INTO users(username,password,enabled) VALUES ('${credentials.username}','${passwordHash}',TRUE) ON DUPLICATE KEY UPDATE password=VALUES(password),enabled=TRUE; INSERT INTO roles(username,role) VALUES ('${credentials.username}','ROLE_ADMIN') ON DUPLICATE KEY UPDATE role=VALUES(role);`])
    const nacos = (await ensureSharedContainer({ context, provider: 'nacos', image: IMAGES.nacos, targetPort: 8848, network: network.name, environment: nacosContainerEnvironment(mysql.name, credentials.nacosPassword, credentials.authToken, credentials.authIdentityValue) })).resource
    const port = publishedPort(nacos.name, 8848)
    await waitReady(async () => { const response = await fetch(`http://127.0.0.1:${port}/nacos/v1/console/health/readiness`, { signal: AbortSignal.timeout(2000) }); return response.ok && /^(?:OK|UP)$/u.test((await response.text()).trim()) }, 'nacos', 180000)
    const ownerEnvironments = Object.fromEntries(ownersFor(context, 'nacos').map((owner) => [owner, { NACOS_SERVER: `127.0.0.1:${port}`, NACOS_USERNAME: credentials.username, NACOS_PASSWORD: credentials.password }]))
    const reference = writeCredentialBundle(runtimeCredentialRoot(context), 'nacos', ownerEnvironments)
    return { resources: [network, mysql, nacos], endpoints: [{ provider: 'nacos', authority: `docker:${nacos.objectId}:8848/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'nacos'), environment: { NACOS_SERVER: `127.0.0.1:${port}` }, credentialReference: reference }] }
  }
  const runScope = context.profile === 'CI' ? 'CI' : 'RUN'
  const network = context.profile === 'CI' ? `oes-v2-ci-${context.jobFingerprint}-${exactResourceToken(exactRunIdentity(context))}-nacos` : `oes-v2-${exactResourceToken(exactRunIdentity(context))}-nacos`
  const networkLabels = runtimeLabels(context, runScope, 'nacos')
  docker(['network', 'create', ...labelArgs(networkLabels), network])
  const rootPassword = randomSecret()
  const nacosPassword = randomSecret()
  const mysql = await createRunContainer({ context, provider: 'nacos-mysql', image: IMAGES.mysql, targetPort: 3306, network, environment: { MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_DATABASE: 'nacos', MYSQL_USER: 'nacos', MYSQL_PASSWORD: nacosPassword }, mounts: [`${path.join(context.root, 'docker/nacos/mysql-schema.sql')}:/docker-entrypoint-initdb.d/01-nacos-schema.sql:ro`], volumeTarget: '/var/lib/mysql' })
  await waitReady(() => docker(['exec', mysql.name, 'mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root', `-p${rootPassword}`, '--silent']).status === 0, 'nacos-mysql', 180000)
  const username = `runtime_${sha256(exactRunIdentity(context)).slice(0, 8)}`
  const password = randomSecret(24)
  const passwordHash = runChecked('htpasswd', ['-bnBC', '10', '', password]).stdout.trim().replace(/^:/u, '')
  docker(['exec', '-e', `MYSQL_PWD=${nacosPassword}`, mysql.name, 'mysql', '-h', '127.0.0.1', '-u', 'nacos', 'nacos', '-e', `INSERT INTO users(username,password,enabled) VALUES ('${username}','${passwordHash}',TRUE) ON DUPLICATE KEY UPDATE password=VALUES(password),enabled=TRUE; INSERT INTO roles(username,role) VALUES ('${username}','ROLE_ADMIN') ON DUPLICATE KEY UPDATE role=VALUES(role);`])
  const authToken = Buffer.from(randomSecret(48)).toString('base64').slice(0, 64)
  const nacos = await createRunContainer({ context, provider: 'nacos', image: IMAGES.nacos, targetPort: 8848, network, environment: nacosContainerEnvironment(mysql.name, nacosPassword, authToken, randomSecret()) })
  const port = publishedPort(nacos.name, 8848)
  await waitReady(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/nacos/v1/console/health/readiness`, { signal: AbortSignal.timeout(2000) })
    return response.ok && /^(?:OK|UP)$/u.test((await response.text()).trim())
  }, 'nacos', 180000)
  const ownerEnvironments = Object.fromEntries(ownersFor(context, 'nacos').map((owner) => [owner, { NACOS_SERVER: `127.0.0.1:${port}`, NACOS_USERNAME: username, NACOS_PASSWORD: password }]))
  const reference = writeCredentialBundle(context.runDirectory, 'nacos', ownerEnvironments)
  return { resources: [{ provider: 'nacos', scope: runScope, kind: 'network', name: network, objectId: docker(['network', 'inspect', '--format', '{{.Id}}', network]).stdout.trim(), labels: networkLabels, cleanup: 'DELETE_EXACT' }, mysql, nacos], endpoints: [{ provider: 'nacos', authority: `docker:${nacos.objectId}:8848/tcp`, host: '127.0.0.1', port, ready: true, owners: ownersFor(context, 'nacos'), environment: { NACOS_SERVER: `127.0.0.1:${port}` }, credentialReference: reference }] }
}

/** Provisions one declared provider and returns exact resources and ready endpoints. */
export async function provisionDockerProvider(provider, context) {
  const shared = context.profile === 'DEV' || (context.profile === 'LOCAL_INTEGRATION' && ['postgres', 'minio'].includes(provider))
  const provision = async () => {
    try {
      if (provider === 'postgres') return await provisionPostgres(context, shared)
      if (provider === 'minio') return await provisionMinio(context, shared)
      if (provider === 'redis') return await provisionRedis(context, shared)
      if (provider === 'nats') return await provisionNats(context, shared)
      if (provider === 'mtls') return await provisionMtls(context, shared)
      if (provider === 'otel') return await provisionOtel(context)
      if (provider === 'otel-full') return await provisionOtelFull(context)
      if (provider === 'nacos') return await provisionNacos(context, shared)
      throw new Error(`DOCKER_PROVIDER_UNSUPPORTED provider=${provider}`)
    } catch (error) {
      if (!shared) cleanupPartialProviderDockerObjects(provider === 'otel-full' ? 'otel' : provider, context)
      throw error
    }
  }
  return shared ? withExclusiveLock(path.join(context.stateRoot, 'locks', 'providers', `${context.devStackId}-${provider}.lock`), provision, { timeoutMs: 300000 }) : provision()
}

/** Reconciles one exact owned resource and preserves any identity drift. */
export function cleanupDockerResource(resource, context) {
  try {
    if (resource.cleanup === 'PRESERVE_SHARED') return { resource, disposition: 'PRESERVED_SHARED', exitStatus: 0 }
    if (resource.cleanup === 'DELETED_WITH_OWNED_CONTAINER') return { resource, disposition: 'DELETED_WITH_OWNED_CONTAINER', exitStatus: 0 }
    if (resource.kind === 'database') {
      if (resource.containerScope === 'RUN') return { resource, disposition: 'DELETED_WITH_OWNED_CONTAINER', exitStatus: 0 }
      const bootstrapBytes = fs.readFileSync(resource.rootCredentialReference.path)
      if (sha256(bootstrapBytes) !== resource.rootCredentialReference.sha256) throw new Error('POSTGRES_ROOT_CREDENTIAL_REFERENCE_MISMATCH')
      const bootstrap = JSON.parse(bootstrapBytes.toString('utf8'))
      const container = inspectContainer(resource.containerName)
      if (container.Id !== resource.containerObjectId) throw new Error('DATABASE_CONTAINER_ID_MISMATCH')
      docker(['exec', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'oes_provisioner', '-d', 'postgres', '-c', `DROP DATABASE ${resource.database} WITH (FORCE)`])
      docker(['exec', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'oes_provisioner', '-d', 'postgres', '-c', `DROP ROLE ${resource.runtime}; DROP ROLE ${resource.migrator}`])
      return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
    }
    if (resource.kind === 'bucket') {
      const bytes = fs.readFileSync(resource.adminCredentialReference.path)
      if (sha256(bytes) !== resource.adminCredentialReference.sha256) throw new Error('MINIO_ADMIN_CREDENTIAL_REFERENCE_MISMATCH')
      const admin = JSON.parse(bytes.toString('utf8'))
      const container = inspectContainer(resource.containerName)
      if (container.Id !== resource.containerObjectId) throw new Error('MINIO_CONTAINER_ID_MISMATCH')
      const script = `mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc rm --recursive --force local/${resource.bucket} >/dev/null 2>&1 || true; mc rb --force local/${resource.bucket} >/dev/null; mc admin policy detach local ${resource.policy} --user ${resource.accessKey} >/dev/null 2>&1 || true; mc admin user remove local ${resource.accessKey} >/dev/null; mc admin policy remove local ${resource.policy} >/dev/null`
      docker(['run', '--rm', '--network', `container:${resource.containerName}`, '--env', `MINIO_ROOT_USER=${admin.rootUser}`, '--env', `MINIO_ROOT_PASSWORD=${admin.rootPassword}`, '--entrypoint', 'sh', IMAGES.minioClient, '-ec', script], { timeout: 120000 })
      return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
    }
    if (resource.kind === 'certificate') {
      if (!Array.isArray(resource.files) || resource.files.length !== 4) throw new Error('CERTIFICATE_FILE_IDENTITY_REQUIRED')
      for (const file of resource.files) {
        if (!fs.existsSync(file.path)) continue
        if (sha256(fs.readFileSync(file.path)) !== file.sha256) throw new Error(`CERTIFICATE_FILE_IDENTITY_MISMATCH path=${file.path}`)
        fs.rmSync(file.path)
      }
      return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
    }
    if (resource.kind === 'directory') {
      const bytes = fs.readFileSync(resource.marker)
      if (sha256(bytes) !== resource.objectId) throw new Error('DIRECTORY_RESOURCE_MARKER_MISMATCH')
      const marker = JSON.parse(bytes.toString('utf8'))
      if (marker.path !== resource.path || fingerprint(marker.labels) !== fingerprint(resource.labels)) throw new Error('DIRECTORY_RESOURCE_IDENTITY_MISMATCH')
      fs.rmSync(resource.path, { recursive: true })
      return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
    }
    if (resource.kind === 'container') {
      assertDockerIdentity(resource)
      docker(['rm', '--force', resource.name])
      if (resource.volume) {
        if (typeof resource.volume !== 'object') throw new Error('VOLUME_EXACT_IDENTITY_REQUIRED')
        deleteManagedVolume(resource.volume)
      }
      return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
    }
    if (resource.kind === 'network') {
      const observed = JSON.parse(docker(['network', 'inspect', resource.name]).stdout)[0]
      if (observed.Id !== resource.objectId || Object.entries(resource.labels).some(([key, value]) => observed.Labels?.[key] !== value)) throw new Error('NETWORK_IDENTITY_MISMATCH')
      if (Object.keys(observed.Containers || {}).length) throw new Error('NETWORK_ATTACHED_PRESERVE')
      docker(['network', 'rm', resource.name])
      return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
    }
    return { resource, disposition: 'PRESERVED_UNKNOWN', exitStatus: 0 }
  } catch (error) {
    return { resource, disposition: 'PRESERVED_IDENTITY_OR_CLEANUP_FAILURE', reason: error.message, exitStatus: 1 }
  }
}

/** Observes whether one exact run-owned Docker/logical/file resource remains after reconciliation. */
export function observeDockerResourceResidue(resource) {
  const key = `${resource.provider}:${resource.kind}:${resource.objectId || resource.database || resource.bucket || resource.user || resource.owner || resource.name}`
  if (!['RUN', 'CI'].includes(resource.scope)) return { key, applicable: false, present: false, observation: 'SHARED_OUTSIDE_RUN_DELETE_SET' }
  const inspectAbsent = (callback) => {
    try { return { present: true, observed: callback() } } catch (error) {
      if (/no such (?:object|container|volume|network)|not found/iu.test(`${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`)) return { present: false, observed: null }
      throw error
    }
  }
  if (resource.kind === 'container') {
    const observed = inspectAbsent(() => inspectContainer(resource.name))
    return { key, applicable: true, present: observed.present, observation: observed.present ? `container:${observed.observed.Id}` : 'ABSENT' }
  }
  if (resource.kind === 'network') {
    const observed = inspectAbsent(() => JSON.parse(docker(['network', 'inspect', resource.objectId]).stdout)[0])
    return { key, applicable: true, present: observed.present, observation: observed.present ? `network:${observed.observed.Id}` : 'ABSENT' }
  }
  if (resource.kind === 'certificate') {
    const paths = [...(resource.files || []).map((entry) => entry.path), resource.ca].filter(Boolean)
    const remaining = paths.filter((file) => fs.existsSync(file))
    return { key, applicable: true, present: remaining.length > 0, observation: remaining }
  }
  if (resource.kind === 'database') {
    if (['RUN', 'CI'].includes(resource.containerScope)) {
      const observed = inspectAbsent(() => inspectContainer(resource.containerName))
      return { key, applicable: true, present: observed.present, observation: observed.present ? `container:${observed.observed.Id}` : 'ABSENT_WITH_RUN_CONTAINER' }
    }
    const bytes = fs.readFileSync(resource.rootCredentialReference.path)
    if (sha256(bytes) !== resource.rootCredentialReference.sha256) throw new Error('POSTGRES_ROOT_CREDENTIAL_REFERENCE_MISMATCH')
    const bootstrap = JSON.parse(bytes.toString('utf8'))
    const sql = `SELECT (SELECT count(*) FROM pg_database WHERE datname='${resource.database}') + (SELECT count(*) FROM pg_roles WHERE rolname IN ('${resource.runtime}','${resource.migrator}'));`
    const count = Number(docker(['exec', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'psql', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-U', 'oes_provisioner', '-d', 'postgres', '-c', sql]).stdout.trim())
    return { key, applicable: true, present: count !== 0, observation: { databaseOrRoleCount: count } }
  }
  if (resource.kind === 'bucket') {
    if (['RUN', 'CI'].includes(resource.containerScope)) {
      const observed = inspectAbsent(() => inspectContainer(resource.containerName))
      return { key, applicable: true, present: observed.present, observation: observed.present ? `container:${observed.observed.Id}` : 'ABSENT_WITH_RUN_CONTAINER' }
    }
    const bytes = fs.readFileSync(resource.adminCredentialReference.path)
    if (sha256(bytes) !== resource.adminCredentialReference.sha256) throw new Error('MINIO_ADMIN_CREDENTIAL_REFERENCE_MISMATCH')
    const admin = JSON.parse(bytes.toString('utf8'))
    const script = `mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc stat local/${resource.bucket} >/dev/null 2>&1 && echo bucket || true; mc admin user info local ${resource.accessKey} >/dev/null 2>&1 && echo user || true; mc admin policy info local ${resource.policy} >/dev/null 2>&1 && echo policy || true`
    const remaining = docker(['run', '--rm', '--network', `container:${resource.containerName}`, '--env', `MINIO_ROOT_USER=${admin.rootUser}`, '--env', `MINIO_ROOT_PASSWORD=${admin.rootPassword}`, '--entrypoint', 'sh', IMAGES.minioClient, '-ec', script], { timeout: 120000 }).stdout.trim().split(/\s+/u).filter(Boolean)
    return { key, applicable: true, present: remaining.length > 0, observation: remaining }
  }
  if (resource.kind === 'acl-user') {
    const observed = inspectAbsent(() => inspectContainer(resource.containerName))
    return { key, applicable: true, present: observed.present, observation: observed.present ? `container:${observed.observed.Id}` : 'ABSENT_WITH_RUN_CONTAINER' }
  }
  return { key, applicable: true, present: false, observation: 'NO_INDEPENDENT_RESIDUE_SURFACE' }
}

/** Grants one service runtime role only DML/sequence access after migrator-owned deployment. */
export function finalizePostgresRuntimePrivileges(resource, manifest) {
  const reference = resource.rootCredentialReference
  if (!reference) throw new Error(`POSTGRES_ROOT_CREDENTIAL_REFERENCE_MISSING database=${resource.database}`)
  const bytes = fs.readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) throw new Error('POSTGRES_ROOT_CREDENTIAL_REFERENCE_MISMATCH')
  const bootstrap = JSON.parse(bytes.toString('utf8'))
  const observed = inspectContainer(resource.containerName)
  if (observed.Id !== resource.containerObjectId) throw new Error('POSTGRES_CONTAINER_ID_MISMATCH')
  const sql = `GRANT USAGE ON SCHEMA public TO ${resource.runtime}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${resource.runtime}; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${resource.runtime}; ALTER DEFAULT PRIVILEGES FOR ROLE ${resource.migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${resource.runtime}; ALTER DEFAULT PRIVILEGES FOR ROLE ${resource.migrator} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${resource.runtime};`
  docker(['exec', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'oes_provisioner', '-d', resource.database, '-c', sql])
  return { database: resource.database, runtime: resource.runtime, manifestFingerprint: manifest.manifestFingerprint, exitStatus: 0 }
}

/** Queries one exact runtime-owned PostgreSQL database through its sealed provisioner binding. */
export function queryPostgresDatabase(resource, sql) {
  const reference = resource.rootCredentialReference
  if (!reference) throw new Error(`POSTGRES_ROOT_CREDENTIAL_REFERENCE_MISSING database=${resource.database}`)
  const bytes = fs.readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) throw new Error('POSTGRES_ROOT_CREDENTIAL_REFERENCE_MISMATCH')
  const bootstrap = JSON.parse(bytes.toString('utf8'))
  const observed = inspectContainer(resource.containerName)
  if (observed.Id !== resource.containerObjectId) throw new Error('POSTGRES_CONTAINER_ID_MISMATCH')
  return docker(['exec', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'psql', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-U', 'oes_provisioner', '-d', resource.database, '-c', sql]).stdout.trim()
}
