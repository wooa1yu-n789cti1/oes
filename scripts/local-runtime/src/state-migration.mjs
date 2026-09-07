import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'
import { sharedResourceName } from './docker-driver.mjs'
import { publishStackManifest, reopenCurrentStackManifest, reopenStackManifest } from './manifest.mjs'
import { acquireMigrationBarrier, activeRuntimeAdmissions, assertNoSymlink, exactPathKey, resolveRuntimeLayout } from './state-layout.mjs'
import { runChecked } from './process.mjs'

/** Recursively inventories one state root without following symlinks. */
function inventoryTree(root) {
  const entries = []
  const visit = (current) => {
    const stat = fs.lstatSync(current)
    const relative = path.relative(root, current) || '.'
    if (stat.isSymbolicLink()) { entries.push({ path: relative, type: 'SYMLINK', target: fs.readlinkSync(current), mode: stat.mode & 0o777 }); return }
    if (stat.isFile()) { entries.push({ path: relative, type: 'FILE', size: stat.size, mode: stat.mode & 0o777, sha256: sha256(fs.readFileSync(current)) }); return }
    entries.push({ path: relative, type: 'DIRECTORY', mode: stat.mode & 0o777 })
    for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name))
  }
  visit(root)
  return entries
}

/** Captures read-only old-layout, lease, Run, bind, and provider identity evidence. */
export function inventoryStateLayout({ stateRoot, dockerObjects = [] }) {
  const root = path.resolve(stateRoot)
  if (!fs.existsSync(root)) throw new Error(`STATE_MIGRATION_SOURCE_MISSING path=${root}`)
  assertNoSymlink(root)
  const entries = inventoryTree(root)
  if (entries.some((entry) => entry.type === 'SYMLINK')) throw new Error('STATE_MIGRATION_SOURCE_SYMLINK')
  const activeRunFiles = entries.filter((entry) => entry.type === 'FILE' && /(?:^|\/)runs\/[^/]+\/[^/]+\/(?:manifest|transaction)\.json$/u.test(entry.path)).map((entry) => entry.path).filter((relative) => {
    const directory = path.dirname(path.join(root, relative))
    return !fs.existsSync(path.join(directory, 'cleanup.json')) && !fs.existsSync(path.join(directory, 'failed-cleanup.json'))
  })
  const runningDevProcessAuthorities = []
  for (const relative of activeRunFiles.filter((entry) => entry.endsWith('/manifest.json'))) {
    const value = readJson(path.join(root, relative))
    if (value.profile !== 'DEV') continue
    for (const endpoint of value.endpoints || []) {
      const match = String(endpoint.authority || '').match(/^pid:(\d+):/u)
      if (!match) continue
      try { process.kill(Number(match[1]), 0); runningDevProcessAuthorities.push({ path: relative, provider: endpoint.provider, pid: Number(match[1]) }) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  const leaseFiles = entries.filter((entry) => entry.type === 'FILE' && /(?:^|\/)leases\//u.test(entry.path)).map((entry) => entry.path)
  const normalizedDockerObjects = dockerObjects.map((object) => {
    const type = object.type || object.Type || 'container'
    const objectId = object.objectId || object.Id || (type === 'volume' ? fingerprint({ name: object.Name, createdAt: object.CreatedAt, driver: object.Driver, scope: object.Scope, labels: object.Labels || {} }) : undefined)
    return {
      type,
      objectId,
      name: String(object.name || object.Name || '').replace(/^\//u, ''),
      running: Boolean(object.running ?? object.State?.Running),
      labels: object.labels || object.Labels || object.Config?.Labels || {},
      mounts: (object.mounts || object.Mounts || []).map((mount) => ({ Type: mount.Type, Source: mount.Source ? path.resolve(mount.Source) : undefined, Destination: mount.Destination, Name: mount.Name, RW: mount.RW })).sort((left, right) => `${left.Type}:${left.Source || left.Name}:${left.Destination}`.localeCompare(`${right.Type}:${right.Source || right.Name}:${right.Destination}`))
    }
  }).sort((left, right) => `${left.type}:${left.objectId}`.localeCompare(`${right.type}:${right.objectId}`))
  const binds = []
  for (const object of normalizedDockerObjects) for (const mount of object.mounts) {
    if (mount.Type !== 'bind') continue
    const source = path.resolve(mount.Source)
    if (source === root || source.startsWith(`${root}${path.sep}`)) binds.push({ objectId: object.objectId, name: object.name, running: object.running, source, destination: mount.Destination })
  }
  const semaphoreFiles = entries.filter((entry) => entry.type === 'FILE' && /^semaphore\//u.test(entry.path)).map((entry) => entry.path)
  const controlLockFiles = entries.filter((entry) => entry.type === 'FILE' && /^locks\//u.test(entry.path)).map((entry) => entry.path)
  const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_INVENTORY', stateRoot: root, entries, activeRunFiles, runningDevProcessAuthorities, leaseFiles, semaphoreFiles, controlLockFiles, dockerObjects: normalizedDockerObjects, binds, sourceTreeFingerprint: fingerprint(entries) }
  return { ...raw, inventoryFingerprint: fingerprint(raw) }
}

/** Reopens one external DEV-data snapshot and proves exact logical-carrier coverage. */
function reopenDevBackupReference(reference, expectedDevStackId, stateRoot, expectedCarriers = []) {
  if (!reference || reference.type !== 'OES_DEV_STATE_BACKUP' || !path.isAbsolute(reference.path)) throw new Error('STATE_MIGRATION_DEV_BACKUP_REFERENCE_INVALID')
  const selected = path.resolve(reference.path)
  const root = path.resolve(stateRoot)
  if (selected === root || selected.startsWith(`${root}${path.sep}`)) throw new Error('STATE_MIGRATION_DEV_BACKUP_MUST_BE_EXTERNAL')
  const bytes = fs.readFileSync(selected)
  if (sha256(bytes) !== reference.sha256) throw new Error('STATE_MIGRATION_DEV_BACKUP_SHA_MISMATCH')
  const value = JSON.parse(bytes.toString('utf8'))
  if (value.kind !== 'OES_DEV_STATE_BACKUP' || value.backupFingerprint !== reference.fingerprint || value.backupFingerprint !== fingerprint(value, 'backupFingerprint') || value.devStackId !== expectedDevStackId || value.sourcesPreserved !== true || !value.backups?.length) throw new Error('STATE_MIGRATION_DEV_BACKUP_BINDING_MISMATCH')
  const expected = new Map(expectedCarriers.map((carrier) => [`${carrier.kind}:${carrier.logicalName}`, carrier]))
  const observed = new Map()
  for (const backup of value.backups) {
    if (!path.isAbsolute(backup.file) || sha256(fs.readFileSync(backup.file)) !== backup.sha256) throw new Error(`STATE_MIGRATION_DEV_BACKUP_ARCHIVE_MISMATCH kind=${backup.kind}`)
    const logicalName = backup.database || backup.bucket
    const key = `${backup.kind}:${logicalName}`
    if (!logicalName || observed.has(key)) throw new Error(`STATE_MIGRATION_DEV_BACKUP_DUPLICATE key=${key}`)
    const carrier = expected.get(key)
    if (!carrier || backup.containerName !== carrier.containerName || backup.containerObjectId !== carrier.containerObjectId) throw new Error(`STATE_MIGRATION_DEV_BACKUP_COVERAGE_MISMATCH key=${key}`)
    observed.set(key, backup)
  }
  const missing = [...expected.keys()].filter((key) => !observed.has(key))
  if (missing.length || observed.size !== expected.size) throw new Error(`STATE_MIGRATION_DEV_BACKUP_COVERAGE_MISMATCH missing=${missing.join(',')}`)
  return value
}

/** Enumerates every provider object identity file below one mapped provider tree. */
function providerIdentityFiles(root) {
  const files = []
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const selected = path.join(current, name)
      const stat = fs.lstatSync(selected)
      if (stat.isSymbolicLink()) throw new Error(`STATE_MIGRATION_SYMLINK_FORBIDDEN path=${selected}`)
      if (stat.isDirectory()) visit(selected)
      else if (/^(?:identity|network-identity)\.json$/u.test(name)) files.push(selected)
    }
  }
  visit(root)
  return files
}

/** Requires the complete legacy-compatible SHARED V2 label identity. */
function assertSharedV2Labels(labels, { devStackId, pool, provider, objectId }) {
  const expected = {
    'oes.runtime.version': '2',
    'oes.runtime.dev-stack-id': devStackId,
    'oes.runtime.scope': 'SHARED',
    'oes.runtime.pool': pool,
    'oes.runtime.provider': provider
  }
  const allowed = new Set(Object.keys(expected))
  const foreignLifecycle = Object.keys(labels || {}).some((key) => key.startsWith('com.docker.compose.'))
  const extraRuntime = Object.keys(labels || {}).filter((key) => key.startsWith('oes.runtime.') && !allowed.has(key))
  if (!labels || foreignLifecycle || extraRuntime.length || Object.entries(expected).some(([key, value]) => labels[key] !== value)) throw new Error(`STATE_MIGRATION_REQUIRED_LABEL_MISMATCH objectId=${objectId || 'UNKNOWN'}`)
}

/** Reopens a retired consumer credential binding without exposing its values. */
function reopenRetiredCredentialReference(reference, provider, stateRoot, owners) {
  if (!reference || !path.isAbsolute(reference.path) || !reference.sha256 || !reference.fingerprint) throw new Error(`STATE_MIGRATION_CREDENTIAL_REFERENCE_INVALID provider=${provider}`)
  const selected = path.resolve(reference.path)
  const root = path.resolve(stateRoot)
  if (selected !== root && !selected.startsWith(`${root}${path.sep}`)) throw new Error(`STATE_MIGRATION_CREDENTIAL_REFERENCE_ESCAPE provider=${provider}`)
  const bytes = fs.readFileSync(selected)
  if (sha256(bytes) !== reference.sha256) throw new Error(`STATE_MIGRATION_CREDENTIAL_REFERENCE_SHA_MISMATCH provider=${provider}`)
  const value = JSON.parse(bytes.toString('utf8'))
  if (value.provider !== provider || value.credentialFingerprint !== reference.fingerprint || value.credentialFingerprint !== fingerprint(value, 'credentialFingerprint') || !value.ownerEnvironments || typeof value.ownerEnvironments !== 'object') throw new Error(`STATE_MIGRATION_CREDENTIAL_REFERENCE_FINGERPRINT_MISMATCH provider=${provider}`)
  const expectedOwners = [...new Set(owners || [])].sort()
  const actualOwners = Object.keys(value.ownerEnvironments).sort()
  if (!expectedOwners.length || fingerprint(expectedOwners) !== fingerprint(actualOwners)) throw new Error(`STATE_MIGRATION_CREDENTIAL_OWNER_BOUNDARY_MISMATCH provider=${provider}`)
  if ((fs.statSync(selected).mode & 0o777) !== 0o600) throw new Error(`STATE_MIGRATION_CREDENTIAL_REFERENCE_MODE_INVALID provider=${provider}`)
  return { provider, type: reference.type || 'OES_RUNTIME_CREDENTIAL', path: selected, sha256: reference.sha256, fingerprint: reference.fingerprint, owners: expectedOwners }
}

/** Produces the closed-world state-layout mapping and fixed sibling activation paths. */
export function planStateLayoutMigration(inventory, { devStackId, providerSnapshots = [], providerPools = {}, devBackupReference = null } = {}) {
  if (inventory.inventoryFingerprint !== fingerprint(inventory, 'inventoryFingerprint')) throw new Error('STATE_MIGRATION_INVENTORY_FINGERPRINT_MISMATCH')
  const oldRoot = path.resolve(inventory.stateRoot)
  const token = inventory.inventoryFingerprint.slice(0, 12)
  const parent = path.dirname(oldRoot)
  const name = path.basename(oldRoot)
  const discoveredDevStackId = devStackId || (fs.existsSync(path.join(oldRoot, 'machine', 'dev-stack.json')) ? readJson(path.join(oldRoot, 'machine', 'dev-stack.json')).devStackId : undefined)
  if (!discoveredDevStackId) throw new Error('STATE_MIGRATION_DEV_STACK_ID_REQUIRED')
  const mappings = []
  const sharedRoot = path.join(oldRoot, 'shared', discoveredDevStackId)
  const sourceTopLevel = fs.readdirSync(oldRoot).sort()
  const allowedTopLevel = new Set(['machine', 'shared', 'leases', 'semaphore', 'locks', 'runs', 'restore', 'process-runtime'])
  const unknownTopLevel = sourceTopLevel.filter((entry) => !allowedTopLevel.has(entry))
  if (unknownTopLevel.length) throw new Error(`STATE_MIGRATION_UNRESOLVED_ENTRY entries=${unknownTopLevel.join(',')}`)
  const unresolvedRunPrivateFiles = inventory.entries.filter((entry) => entry.type === 'FILE' && /^runs\/[^/]+\/[^/]+\/(?:credentials|provider|orchestration)\//u.test(entry.path)).map((entry) => entry.path)
  if (unresolvedRunPrivateFiles.length) throw new Error(`STATE_MIGRATION_RUN_PRIVATE_STATE_UNRESOLVED entries=${unresolvedRunPrivateFiles.join(',')}`)
  const machineEntries = fs.existsSync(path.join(oldRoot, 'machine')) ? fs.readdirSync(path.join(oldRoot, 'machine')).sort() : []
  if (machineEntries.length !== 1 || machineEntries[0] !== 'dev-stack.json') throw new Error(`STATE_MIGRATION_MACHINE_IDENTITY_UNRESOLVED entries=${machineEntries.join(',')}`)
  const sharedIds = fs.existsSync(path.join(oldRoot, 'shared')) ? fs.readdirSync(path.join(oldRoot, 'shared')).sort() : []
  if (sharedIds.length !== 1 || sharedIds[0] !== discoveredDevStackId) throw new Error(`STATE_MIGRATION_SHARED_ROOT_MISMATCH entries=${sharedIds.join(',')}`)
  if (fs.existsSync(sharedRoot)) for (const provider of fs.readdirSync(sharedRoot).sort()) {
    if (provider === 'process-runtime') {
      mappings.push({ type: 'STACK_CREDENTIAL_TREE', provider, source: path.join(sharedRoot, provider), targetRelative: path.join('credentials', 'process-runtime') })
      continue
    }
    const identityPath = path.join(sharedRoot, provider, 'identity.json')
    const identity = fs.existsSync(identityPath) ? readJson(identityPath) : null
    const pool = providerPools[provider] || identity?.labels?.['oes.runtime.pool']
    if (!['dev', 'test'].includes(pool)) throw new Error(`STATE_MIGRATION_PROVIDER_POOL_REQUIRED provider=${provider}`)
    mappings.push({ type: provider === 'mtls' ? 'CREDENTIAL_TREE' : 'PROVIDER_TREE', provider, pool, source: path.join(sharedRoot, provider), targetRelative: path.join(provider === 'mtls' ? 'credentials' : 'providers', pool, provider) })
  }
  const rootProcessRuntime = path.join(oldRoot, 'process-runtime')
  if (fs.existsSync(rootProcessRuntime)) mappings.push({ type: 'STACK_CREDENTIAL_TREE', provider: 'process-runtime', source: rootProcessRuntime, targetRelative: path.join('credentials', 'process-runtime') })
  const runsRoot = path.join(oldRoot, 'runs')
  if (fs.existsSync(runsRoot)) mappings.push({ type: 'HISTORICAL_RUN_EVIDENCE', source: runsRoot, targetRelative: path.join('evidence', 'pre-activation-runs') })
  const restoreRoot = path.join(oldRoot, 'restore')
  if (fs.existsSync(restoreRoot)) mappings.push({ type: 'RESTORE_STATE', source: restoreRoot, targetRelative: 'restore' })
  const mappedPools = new Map(mappings.filter((mapping) => mapping.provider).map((mapping) => [mapping.provider, mapping.pool]))
  const retiredConsumerCredentialReferences = []
  let normalizedProviderSnapshots = providerSnapshots.map((snapshot) => {
    const provider = snapshot.resource?.provider || snapshot.endpoint?.provider
    const pool = snapshot.resource?.pool || snapshot.resource?.labels?.['oes.runtime.pool'] || snapshot.endpoint?.pool || providerPools[provider] || mappedPools.get(provider)
    if (!provider || !['dev', 'test'].includes(pool)) throw new Error(`STATE_MIGRATION_PROVIDER_POOL_REQUIRED provider=${provider || 'UNKNOWN'}`)
    const resource = snapshot.resource ? { ...snapshot.resource, pool } : undefined
    const endpoint = snapshot.endpoint ? { ...snapshot.endpoint, pool } : undefined
    if (resource && resource.scope !== 'SHARED') throw new Error(`STATE_MIGRATION_PROVIDER_SCOPE_INVALID provider=${provider}`)
    if (resource && ['container', 'network', 'volume'].includes(resource.kind)) assertSharedV2Labels(resource.labels, { devStackId: discoveredDevStackId, pool, provider, objectId: resource.objectId })
    if (resource?.volume) assertSharedV2Labels(resource.volume.labels, { devStackId: discoveredDevStackId, pool, provider, objectId: resource.volume.objectId })
    if (endpoint && (!endpoint.ready || !endpoint.authority)) throw new Error(`STATE_MIGRATION_PROVIDER_ENDPOINT_INVALID provider=${provider}`)
    if (endpoint?.credentialReference) {
      const reference = reopenRetiredCredentialReference(endpoint.credentialReference, provider, oldRoot, endpoint.owners)
      retiredConsumerCredentialReferences.push({ ...reference, pool })
      delete endpoint.credentialReference
    }
    return { ...(resource ? { resource } : {}), ...(endpoint ? { endpoint } : {}) }
  })
  const seenEndpoints = new Map()
  normalizedProviderSnapshots = normalizedProviderSnapshots.map((snapshot) => {
    if (!snapshot.endpoint) return snapshot
    const key = `${snapshot.endpoint.provider}:${snapshot.endpoint.pool}`
    const observed = fingerprint(snapshot.endpoint)
    if (seenEndpoints.has(key)) {
      if (seenEndpoints.get(key) !== observed) throw new Error(`STATE_MIGRATION_PROVIDER_ENDPOINT_CONFLICT provider=${snapshot.endpoint.provider}`)
      const { endpoint, ...resourceOnly } = snapshot
      return resourceOnly
    }
    seenEndpoints.set(key, observed)
    return snapshot
  }).filter((snapshot) => snapshot.resource || snapshot.endpoint)
  const resourceKeys = normalizedProviderSnapshots.filter((snapshot) => snapshot.resource).map((snapshot) => `${snapshot.resource.provider}:${snapshot.resource.pool}:${snapshot.resource.kind}:${snapshot.resource.objectId || snapshot.resource.name || snapshot.resource.database || snapshot.resource.bucket || snapshot.resource.owner}`)
  const endpointKeys = normalizedProviderSnapshots.filter((snapshot) => snapshot.endpoint).map((snapshot) => `${snapshot.endpoint.provider}:${snapshot.endpoint.pool}`)
  if (new Set(resourceKeys).size !== resourceKeys.length) throw new Error('STATE_MIGRATION_PROVIDER_RESOURCE_DUPLICATE')
  if (new Set(endpointKeys).size !== endpointKeys.length) throw new Error('STATE_MIGRATION_PROVIDER_ENDPOINT_DUPLICATE')
  const duplicateTargets = mappings.map((mapping) => mapping.targetRelative).filter((target, index, values) => values.indexOf(target) !== index)
  if (duplicateTargets.length) throw new Error(`STATE_MIGRATION_DUPLICATE_TARGET target=${duplicateTargets[0]}`)
  const providerMappings = mappings.filter((mapping) => mapping.type === 'PROVIDER_TREE')
  const identityResources = []
  for (const mapping of providerMappings) {
    const identityFiles = providerIdentityFiles(mapping.source)
    if (!identityFiles.length) throw new Error(`STATE_MIGRATION_PROVIDER_IDENTITY_REQUIRED provider=${mapping.provider}`)
    for (const identityFile of identityFiles) {
      const value = readJson(identityFile)
      const resource = normalizedProviderSnapshots.map((snapshot) => snapshot.resource).find((candidate) => candidate?.objectId === value.objectId && candidate.provider === value.provider)
      if (!resource || resource.scope !== 'SHARED' || resource.pool !== mapping.pool || (value.kind && resource.kind !== value.kind) || (value.name && resource.name !== value.name)) throw new Error(`STATE_MIGRATION_PROVIDER_SNAPSHOT_COVERAGE_REQUIRED provider=${value.provider || mapping.provider} objectId=${value.objectId || 'UNKNOWN'}`)
      assertSharedV2Labels(value.labels, { devStackId: discoveredDevStackId, pool: mapping.pool, provider: value.provider || mapping.provider, objectId: value.objectId })
      assertSharedV2Labels(resource.labels, { devStackId: discoveredDevStackId, pool: mapping.pool, provider: value.provider || mapping.provider, objectId: value.objectId })
      if (Object.entries(value.labels).some(([key, expected]) => resource.labels?.[key] !== expected)) throw new Error(`STATE_MIGRATION_PROVIDER_LABEL_MISMATCH provider=${value.provider || mapping.provider}`)
      if (Boolean(value.volume) !== Boolean(resource.volume)) throw new Error(`STATE_MIGRATION_VOLUME_IDENTITY_MISMATCH provider=${value.provider || mapping.provider}`)
      if (value.volume) {
        assertSharedV2Labels(value.volume.labels, { devStackId: discoveredDevStackId, pool: mapping.pool, provider: value.provider || mapping.provider, objectId: value.volume.objectId })
        if (fingerprint(value.volume) !== fingerprint(resource.volume)) throw new Error(`STATE_MIGRATION_VOLUME_IDENTITY_MISMATCH provider=${value.provider || mapping.provider}`)
      }
      identityResources.push({ provider: value.provider || mapping.provider, pool: mapping.pool, kind: value.kind || resource.kind, objectId: value.objectId, name: value.name || resource.name, source: identityFile, volume: value.volume || null })
    }
  }
  const identityObjectIds = new Set(identityResources.map((resource) => resource.objectId))
  for (const snapshot of normalizedProviderSnapshots) {
    const resource = snapshot.resource
    if (resource?.objectId && ['container', 'network'].includes(resource.kind) && !identityObjectIds.has(resource.objectId)) throw new Error(`STATE_MIGRATION_PROVIDER_IDENTITY_COVERAGE_REQUIRED objectId=${resource.objectId}`)
    const endpointObjectId = snapshot.endpoint?.authority?.match(/^docker:([^:]+):/u)?.[1]
    if (endpointObjectId && !identityObjectIds.has(endpointObjectId)) throw new Error(`STATE_MIGRATION_PROVIDER_ENDPOINT_OBJECT_MISMATCH objectId=${endpointObjectId}`)
  }
  const endpointProviders = new Set(normalizedProviderSnapshots.filter((snapshot) => snapshot.endpoint).map((snapshot) => `${snapshot.endpoint.provider}:${snapshot.endpoint.pool}`))
  const supportProviders = new Set(['nacos-mysql', 'tempo', 'loki', 'grafana'])
  for (const resource of identityResources.filter((identity) => identity.kind === 'container' && !supportProviders.has(identity.provider))) if (!endpointProviders.has(`${resource.provider}:${resource.pool}`)) throw new Error(`STATE_MIGRATION_PROVIDER_ENDPOINT_COVERAGE_REQUIRED provider=${resource.provider}`)
  for (const mapping of mappings.filter((candidate) => candidate.type === 'CREDENTIAL_TREE')) if (mapping.provider === 'mtls' && !endpointProviders.has(`mtls:${mapping.pool}`)) throw new Error('STATE_MIGRATION_PROVIDER_ENDPOINT_COVERAGE_REQUIRED provider=mtls')
  const snapshotObjectIds = new Set(normalizedProviderSnapshots.flatMap((snapshot) => [snapshot.resource?.objectId, snapshot.resource?.volume?.objectId]).filter(Boolean))
  if (snapshotObjectIds.size !== normalizedProviderSnapshots.flatMap((snapshot) => [snapshot.resource?.objectId, snapshot.resource?.volume?.objectId]).filter(Boolean).length) throw new Error('STATE_MIGRATION_DOCKER_OBJECT_ID_DUPLICATE')
  for (const object of inventory.dockerObjects || []) {
    if (!object.objectId || !snapshotObjectIds.has(object.objectId)) throw new Error(`STATE_MIGRATION_DOCKER_OBJECT_COVERAGE_REQUIRED objectId=${object.objectId || 'UNKNOWN'}`)
    const owner = normalizedProviderSnapshots.map((snapshot) => snapshot.resource).find((candidate) => candidate?.objectId === object.objectId || candidate?.volume?.objectId === object.objectId)
    const resource = owner?.objectId === object.objectId ? owner : owner?.volume
    if (!resource || object.type !== (owner?.volume?.objectId === object.objectId ? 'volume' : owner.kind)) throw new Error(`STATE_MIGRATION_DOCKER_OBJECT_TYPE_MISMATCH objectId=${object.objectId}`)
    assertSharedV2Labels(object.labels, { devStackId: discoveredDevStackId, pool: owner.pool, provider: owner.provider, objectId: object.objectId })
    if (Object.entries(object.labels).some(([key, expected]) => resource.labels?.[key] !== expected) || Object.entries(resource.labels || {}).some(([key, expected]) => object.labels?.[key] !== expected)) throw new Error(`STATE_MIGRATION_DOCKER_LABEL_MISMATCH objectId=${object.objectId}`)
    for (const mount of object.mounts || []) if (mount.Type === 'volume' && mount.Name && !normalizedProviderSnapshots.some((snapshot) => snapshot.resource?.volume?.name === mount.Name || (snapshot.resource?.kind === 'volume' && snapshot.resource?.name === mount.Name))) throw new Error(`STATE_MIGRATION_VOLUME_COVERAGE_REQUIRED name=${mount.Name}`)
  }
  for (const bind of inventory.binds || []) {
    const mapping = providerMappings.find((candidate) => bind.source === candidate.source || bind.source.startsWith(`${candidate.source}${path.sep}`))
    if (!mapping) throw new Error(`STATE_MIGRATION_BIND_MAPPING_REQUIRED source=${bind.source}`)
    if (!normalizedProviderSnapshots.some((snapshot) => snapshot.resource?.objectId === bind.objectId)) throw new Error(`STATE_MIGRATION_BIND_OBJECT_COVERAGE_REQUIRED objectId=${bind.objectId}`)
  }
  const absoluteReferences = []
  const collectReferences = (value, pointer = '$') => {
    if (Array.isArray(value)) return value.forEach((child, index) => collectReferences(child, `${pointer}[${index}]`))
    if (value && typeof value === 'object') return Object.entries(value).forEach(([key, child]) => collectReferences(child, `${pointer}.${key}`))
    if (typeof value === 'string' && path.isAbsolute(value) && (value === oldRoot || value.startsWith(`${oldRoot}${path.sep}`))) absoluteReferences.push({ pointer, path: path.resolve(value) })
  }
  normalizedProviderSnapshots.forEach((snapshot, index) => collectReferences(snapshot, `$[${index}]`))
  retiredConsumerCredentialReferences.forEach((reference, index) => collectReferences(reference, `$.retiredConsumerCredentialReferences[${index}]`))
  for (const reference of absoluteReferences) if (!mappings.some((mapping) => reference.path === mapping.source || reference.path.startsWith(`${mapping.source}${path.sep}`))) throw new Error(`STATE_MIGRATION_REFERENCE_MAPPING_REQUIRED pointer=${reference.pointer}`)
  const devDataCarriers = normalizedProviderSnapshots.filter((snapshot) => snapshot.resource?.pool === 'dev' && ['database', 'bucket'].includes(snapshot.resource.kind)).map(({ resource }) => {
    const logicalName = resource.database || resource.bucket
    const expectedProvider = resource.kind === 'database' ? 'postgres' : 'minio'
    if (resource.provider !== expectedProvider || !logicalName || !resource.containerName || !resource.containerObjectId) throw new Error(`STATE_MIGRATION_DEV_DATA_CARRIER_IDENTITY_REQUIRED kind=${resource.kind}`)
    const container = identityResources.find((identity) => identity.pool === 'dev' && identity.provider === expectedProvider && identity.kind === 'container' && identity.objectId === resource.containerObjectId && identity.name === resource.containerName)
    if (!container) throw new Error(`STATE_MIGRATION_DEV_DATA_CARRIER_CONTAINER_MISMATCH kind=${resource.kind} logicalName=${logicalName}`)
    return { provider: resource.provider, kind: resource.kind, logicalName, containerName: resource.containerName, containerObjectId: resource.containerObjectId }
  }).sort((left, right) => `${left.kind}:${left.logicalName}`.localeCompare(`${right.kind}:${right.logicalName}`))
  const carrierKeys = devDataCarriers.map((carrier) => `${carrier.kind}:${carrier.logicalName}`)
  if (new Set(carrierKeys).size !== carrierKeys.length) throw new Error('STATE_MIGRATION_DEV_DATA_CARRIER_DUPLICATE')
  const persistentDevProviders = identityResources.filter((resource) => resource.pool === 'dev' && resource.volume && ['postgres', 'minio'].includes(resource.provider))
  for (const provider of persistentDevProviders) if (!devDataCarriers.some((carrier) => carrier.provider === provider.provider && carrier.containerObjectId === provider.objectId)) throw new Error(`STATE_MIGRATION_DEV_DATA_CARRIER_UNACCOUNTED provider=${provider.provider} objectId=${provider.objectId}`)
  const hasDevData = persistentDevProviders.length > 0 || devDataCarriers.length > 0
  if (hasDevData) reopenDevBackupReference(devBackupReference, discoveredDevStackId, oldRoot, devDataCarriers)
  const coverage = {
    mappedSourceRoots: mappings.map((mapping) => ({ type: mapping.type, source: mapping.source, targetRelative: mapping.targetRelative })),
    consumedSourceRoots: ['machine/dev-stack.json', 'leases', 'semaphore', 'locks'],
    providerIdentities: identityResources,
    dockerObjectIds: (inventory.dockerObjects || []).map((object) => object.objectId),
    bindCount: (inventory.binds || []).length,
    absoluteReferenceCount: absoluteReferences.length,
    devDataCarriers,
    retiredConsumerCredentialReferences,
    unresolvedCount: 0
  }
  const raw = {
    schemaVersion: 3,
    kind: 'OES_RUNTIME_STATE_LAYOUT_MIGRATION_PLAN',
    inventoryReference: { type: inventory.kind, fingerprint: inventory.inventoryFingerprint, sourceTreeFingerprint: inventory.sourceTreeFingerprint },
    oldRoot,
    stagedRoot: path.join(parent, `${name}.next-${token}`),
    rollbackRoot: path.join(parent, `${name}.rollback-${token}`),
    journalPath: path.join(parent, `.${name}.activation-${token}.json`),
    devStackId: discoveredDevStackId,
    mappings,
    providerSnapshots: normalizedProviderSnapshots,
    devDataCarriers,
    coverage,
    devBackupReference,
    quiescence: { activeRunCount: inventory.activeRunFiles.length, activeStackLeaseCount: inventory.leaseFiles.length, runningDevProcessCount: (inventory.runningDevProcessAuthorities || []).length, semaphoreTicketCount: (inventory.semaphoreFiles || []).length, controlLockCount: (inventory.controlLockFiles || []).length, runningBindCount: inventory.binds.filter((item) => item.running).length },
    binds: inventory.binds
  }
  return { ...raw, planFingerprint: fingerprint(raw) }
}

/** Verifies every inventoried source path, mode, size, and digest before staging. */
function verifyInventory(inventory) {
  if (inventory.inventoryFingerprint !== fingerprint(inventory, 'inventoryFingerprint')) throw new Error('STATE_MIGRATION_INVENTORY_FINGERPRINT_MISMATCH')
  const observed = inventoryTree(inventory.stateRoot)
  if (fingerprint(observed) !== inventory.sourceTreeFingerprint) throw new Error('STATE_MIGRATION_SOURCE_CHANGED')
}

/** Recomputes every plan-controlled path before the staged tree can be written. */
function verifyPlanTopology(plan, inventory) {
  const oldRoot = path.resolve(inventory.stateRoot)
  const parent = path.dirname(oldRoot)
  const name = path.basename(oldRoot)
  const token = inventory.inventoryFingerprint.slice(0, 12)
  if (path.resolve(plan.oldRoot) !== oldRoot || path.resolve(plan.stagedRoot) !== path.join(parent, `${name}.next-${token}`) || path.resolve(plan.rollbackRoot) !== path.join(parent, `${name}.rollback-${token}`) || path.resolve(plan.journalPath) !== path.join(parent, `.${name}.activation-${token}.json`)) throw new Error('STATE_MIGRATION_PLAN_PATH_MISMATCH')
  exactPathKey(plan.devStackId, 'devStackId')
  for (const mapping of plan.mappings || []) {
    const source = path.resolve(mapping.source)
    const target = path.resolve(plan.stagedRoot, 'stacks', 'placeholder', mapping.targetRelative)
    const targetBase = path.resolve(plan.stagedRoot, 'stacks', 'placeholder')
    if ((source !== oldRoot && !source.startsWith(`${oldRoot}${path.sep}`)) || (target !== targetBase && !target.startsWith(`${targetBase}${path.sep}`))) throw new Error('STATE_MIGRATION_PLAN_MAPPING_ESCAPE')
  }
  for (const bind of plan.binds || []) if (path.resolve(bind.source) !== oldRoot && !path.resolve(bind.source).startsWith(`${oldRoot}${path.sep}`)) throw new Error('STATE_MIGRATION_PLAN_BIND_ESCAPE')
}

/** Copies one closed-world tree while preserving file bytes and modes and rejecting links. */
function copyTree(source, target) {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`STATE_MIGRATION_SYMLINK_FORBIDDEN path=${source}`)
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(target, stat.mode & 0o777)
    if (sha256(fs.readFileSync(source)) !== sha256(fs.readFileSync(target))) throw new Error(`STATE_MIGRATION_COPY_MISMATCH path=${source}`)
    return
  }
  fs.mkdirSync(target, { recursive: true, mode: stat.mode & 0o777 })
  for (const name of fs.readdirSync(source).sort()) copyTree(path.join(source, name), path.join(target, name))
}

/** Separates known provider bootstrap/owner secrets from copied provider state. */
function separateCopiedCredentials(stackRoot) {
  for (const pool of ['dev', 'test']) {
    const providersRoot = path.join(stackRoot, 'providers', pool)
    if (!fs.existsSync(providersRoot)) continue
    for (const provider of fs.readdirSync(providersRoot)) {
      const providerRoot = path.join(providersRoot, provider)
      const credentialsRoot = path.join(stackRoot, 'credentials', pool, provider)
      for (const name of ['bootstrap.json', 'credentials.json', 'grafana-bootstrap.json', 'owners']) {
        const source = path.join(providerRoot, name)
        if (!fs.existsSync(source)) continue
        const target = path.join(credentialsRoot, name)
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        if (fs.existsSync(target)) throw new Error(`STATE_MIGRATION_CREDENTIAL_TARGET_EXISTS path=${target}`)
        fs.renameSync(source, target)
      }
    }
  }
}

/** Rebinds copied manifest references to their final canonical post-activation paths. */
function rewriteFinalPaths(value, plan, stackKey) {
  if (Array.isArray(value)) return value.map((item) => rewriteFinalPaths(item, plan, stackKey))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteFinalPaths(child, plan, stackKey)]))
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value
  for (const mapping of plan.mappings) {
    if (value !== mapping.source && !value.startsWith(`${mapping.source}${path.sep}`)) continue
    const relative = path.relative(mapping.source, value)
    let targetRelative = mapping.targetRelative
    if (mapping.type === 'PROVIDER_TREE') {
      const first = relative.split(path.sep)[0]
      if (['bootstrap.json', 'credentials.json', 'grafana-bootstrap.json', 'owners'].includes(first)) targetRelative = path.join('credentials', mapping.pool, mapping.provider)
    }
    return path.join(plan.oldRoot, 'stacks', stackKey, targetRelative, relative)
  }
  return value
}

/** Moves stale restore confirmations/bindings aside and records why their target binding changed. */
export function invalidateRestoreBindings(stackRoot, planFingerprint) {
  const restoreRoot = path.join(stackRoot, 'restore')
  if (!fs.existsSync(restoreRoot)) return []
  const invalidated = []
  for (const name of fs.readdirSync(restoreRoot).sort()) {
    const source = path.join(restoreRoot, name)
    if (!fs.lstatSync(source).isFile() || !/(?:confirmation|binding).*\.json$/iu.test(name)) continue
    const bytes = fs.readFileSync(source)
    const target = path.join(restoreRoot, 'invalidated', name)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.renameSync(source, target)
    invalidated.push({ type: 'INVALIDATED_RESTORE_BINDING', priorPath: source, path: target, sha256: sha256(bytes), reason: 'STATE_LAYOUT_TARGET_BINDING_CHANGED', planFingerprint })
  }
  if (invalidated.length) writeAtomic(path.join(restoreRoot, 'invalidation.json'), { schemaVersion: 3, kind: 'OES_RUNTIME_RESTORE_BINDING_INVALIDATION', planFingerprint, invalidated })
  return invalidated
}

/** Fsyncs files and directories bottom-up so the staged tree is durable before activation. */
function fsyncTree(root) {
  const directories = []
  const visit = (current) => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`STATE_MIGRATION_SYMLINK_FORBIDDEN path=${current}`)
    if (stat.isDirectory()) { for (const name of fs.readdirSync(current)) visit(path.join(current, name)); directories.push(current); return }
    const fd = fs.openSync(current, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  visit(root)
  for (const directory of directories) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
}

/** Writes and reopens the parent-owned activation journal as the sole crash-recovery authority. */
function writeJournal(file, raw) {
  const value = { ...raw, journalFingerprint: fingerprint(raw) }
  writeAtomic(file, value)
  fsyncDirectory(path.dirname(file))
  return reopenJournal(file)
}

/** Fsyncs one directory so its most recent atomic entry rename is crash-durable. */
function fsyncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }

/** Reopens the activation journal and verifies its exact self binding. */
export function reopenJournal(file) {
  const value = readJson(file)
  if (value.kind !== 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION' || value.journalFingerprint !== fingerprint(value, 'journalFingerprint')) throw new Error(`STATE_MIGRATION_JOURNAL_INVALID path=${file}`)
  return value
}

/** Builds and verifies a same-filesystem canonical next root without mutating the configured old root. */
export async function stageStateLayoutMigration(plan, inventory, { identitySeed, hostBinding, faultAt } = {}) {
  if (plan.planFingerprint !== fingerprint(plan, 'planFingerprint') || plan.inventoryReference.fingerprint !== inventory.inventoryFingerprint) throw new Error('STATE_MIGRATION_PLAN_BINDING_MISMATCH')
  verifyPlanTopology(plan, inventory)
  if (Object.values(plan.quiescence).some((count) => Number(count) > 0)) throw new Error('STATE_MIGRATION_QUIESCENCE_REQUIRED')
  if (plan.devBackupReference) reopenDevBackupReference(plan.devBackupReference, plan.devStackId, plan.oldRoot, plan.devDataCarriers)
  verifyInventory(inventory)
  for (const selected of [plan.stagedRoot, plan.rollbackRoot, plan.journalPath]) if (fs.existsSync(selected)) throw new Error(`STATE_MIGRATION_TARGET_EXISTS path=${selected}`)
  fs.mkdirSync(plan.stagedRoot, { mode: 0o700 })
  if (fs.statSync(path.dirname(plan.oldRoot)).dev !== fs.statSync(plan.stagedRoot).dev) throw new Error('STATE_MIGRATION_CROSS_FILESYSTEM')
  try {
    const layout = await resolveRuntimeLayout({ stateRoot: plan.stagedRoot, profile: 'LOCAL_INTEGRATION', taskKey: 'state_migration', runId: 'staged_layout', explicitDevStackId: plan.devStackId, identitySeed, hostBinding })
    for (const mapping of plan.mappings) copyTree(mapping.source, path.join(layout.stackRoot, mapping.targetRelative))
    separateCopiedCredentials(layout.stackRoot)
    const resources = plan.providerSnapshots.filter((item) => item.resource).map((item) => {
      const resource = rewriteFinalPaths(item.resource, plan, layout.stackKey)
      resource.pool ||= resource.labels?.['oes.runtime.pool']
      return resource.labels?.['oes.runtime.version'] === '2' && !resource.labels?.['oes.runtime.stack-key']
        ? { ...resource, labelCompatibility: 'PRE_STACK_KEY_V2_EXACT' }
        : resource
    })
    const endpoints = plan.providerSnapshots.filter((item) => item.endpoint).map((item) => ({ ...rewriteFinalPaths(item.endpoint, plan, layout.stackKey), pool: item.endpoint.pool || item.resource?.pool || item.resource?.labels?.['oes.runtime.pool'] }))
    publishStackManifest(layout.stackRoot, { lifecycle: 'REGISTERED', stackKey: layout.stackKey, devStackId: layout.devStackId, identityKind: 'LOCAL', pools: [...new Set(resources.map((resource) => resource.pool).filter(Boolean))].sort(), resources, endpoints, leases: [], evidenceReferences: [], sourceInventoryFingerprint: inventory.inventoryFingerprint })
    const invalidatedRestoreBindings = invalidateRestoreBindings(layout.stackRoot, plan.planFingerprint)
    if (faultAt === 'before-fsync') throw new Error('STATE_MIGRATION_FAULT_BEFORE_FSYNC')
    fsyncTree(plan.stagedRoot)
    const stagedEntries = inventoryTree(plan.stagedRoot)
    const journalRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION', state: 'PREPARED', operationId: crypto.randomUUID(), planFingerprint: plan.planFingerprint, inventoryFingerprint: inventory.inventoryFingerprint, sourceTreeFingerprint: inventory.sourceTreeFingerprint, devBackupReference: plan.devBackupReference, devDataCarriers: plan.devDataCarriers, oldRoot: plan.oldRoot, stagedRoot: plan.stagedRoot, rollbackRoot: plan.rollbackRoot, stackKey: layout.stackKey, devStackId: layout.devStackId, stagedTreeFingerprint: fingerprint(stagedEntries), quiescence: plan.quiescence, binds: plan.binds.map((bind) => ({ ...bind, nextSource: rewriteFinalPaths(bind.source, plan, layout.stackKey) })), invalidatedRestoreBindings, transitions: [{ state: 'PREPARED', at: new Date().toISOString() }] }
    const journal = writeJournal(plan.journalPath, journalRaw)
    return { layout, journalPath: plan.journalPath, journal }
  } catch (error) {
    if (!fs.existsSync(plan.journalPath)) fs.rmSync(plan.stagedRoot, { recursive: true, force: true })
    throw error
  }
}

/** Advances one journal state durably while retaining its immutable operation binding. */
function transition(journalPath, state, extra = {}) {
  const current = reopenJournal(journalPath)
  const raw = { ...current, ...extra, state, transitions: [...current.transitions, { state, at: new Date().toISOString() }] }
  delete raw.journalFingerprint
  return writeJournal(journalPath, raw)
}

/** Fsyncs one parent directory after atomic sibling renames. */
function fsyncParent(target) { const fd = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }

/** Rewrites the staged pointer's absolute self path after its tree reaches the configured root. */
function relocateStackPointer(journal) {
  const stackRoot = path.join(journal.oldRoot, 'stacks', journal.stackKey)
  const pointerPath = path.join(stackRoot, 'current-manifest.json')
  const pointer = readJson(pointerPath)
  const relative = path.relative(journal.stagedRoot, pointer.path)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('STATE_MIGRATION_STACK_POINTER_ESCAPE')
  const raw = { ...pointer, path: path.join(journal.oldRoot, relative) }
  delete raw.pointerFingerprint
  writeAtomic(pointerPath, { ...raw, pointerFingerprint: fingerprint(raw) })
  fsyncDirectory(stackRoot)
  return reopenCurrentStackManifest(stackRoot)
}

/** Verifies the activated schema, registry, Stack descriptor, pointer, and referenced generation. */
function verifyCanonicalActivatedRoot(root, journal) {
  const schema = readJson(path.join(root, 'schema-version.json'))
  const registry = readJson(path.join(root, 'stack-registry.json'))
  const stack = readJson(path.join(root, 'stacks', journal.stackKey, 'stack.json'))
  if (schema.kind !== 'OES_RUNTIME_STATE_SCHEMA' || schema.layout !== 'MACHINE_STACK_RUN') throw new Error('STATE_MIGRATION_ACTIVATED_SCHEMA_INVALID')
  if (registry.stacks.length !== 1 || registry.stacks[0].stackKey !== journal.stackKey || registry.stacks[0].devStackId !== journal.devStackId) throw new Error('STATE_MIGRATION_ACTIVATED_REGISTRY_INVALID')
  if (stack.stackKey !== journal.stackKey || stack.devStackId !== journal.devStackId || stack.stackFingerprint !== fingerprint(stack, 'stackFingerprint')) throw new Error('STATE_MIGRATION_ACTIVATED_STACK_INVALID')
  reopenCurrentStackManifest(path.join(root, 'stacks', journal.stackKey))
  return true
}

/** Reopens one exact Docker container without using its mutable name as authority. */
function inspectDockerContainer(objectId) { return JSON.parse(runChecked('docker', ['inspect', '--type', 'container', objectId], { timeout: 20000 }).stdout)[0] }

/** Returns an exact Docker container or null only for Docker's explicit absence response. */
function inspectDockerContainerOrNull(objectId) {
  try { return inspectDockerContainer(objectId) } catch (error) {
    if (/no such (?:object|container)|not found/iu.test(`${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`)) return null
    throw error
  }
}

/** Inventories every Docker container so fresh quiescence includes newly introduced root binds. */
function observeDockerContainers() {
  const ids = runChecked('docker', ['ps', '--all', '--quiet'], { timeout: 20000 }).stdout.trim().split(/\s+/u).filter(Boolean)
  return ids.map((objectId) => inspectDockerContainer(objectId))
}

/** Recomputes quiescence while optionally discounting only sealed replacement-provider binds. */
function observeLiveQuiescence(journal, roots = [journal.oldRoot], allowedRunningObjectIds = []) {
  const dockerObjects = observeDockerContainers()
  const inventories = roots.filter((root) => fs.existsSync(root)).map((stateRoot) => inventoryStateLayout({ stateRoot, dockerObjects }))
  const allowed = new Set(allowedRunningObjectIds)
  return {
    activeRunCount: inventories.reduce((count, inventory) => count + inventory.activeRunFiles.length, 0),
    activeStackLeaseCount: inventories.reduce((count, inventory) => count + inventory.leaseFiles.length, 0),
    runningDevProcessCount: inventories.reduce((count, inventory) => count + inventory.runningDevProcessAuthorities.length, 0),
    semaphoreTicketCount: inventories.reduce((count, inventory) => count + inventory.semaphoreFiles.length, 0),
    controlLockCount: inventories.reduce((count, inventory) => count + inventory.controlLockFiles.length, 0),
    allocationAdmissionCount: activeRuntimeAdmissions(journal.oldRoot).length,
    runningBindCount: inventories.reduce((count, inventory) => count + inventory.binds.filter((bind) => bind.running && !allowed.has(bind.objectId)).length, 0)
  }
}

/** Fails closed unless every observed quiescence dimension is exactly zero. */
function assertQuiescent(observation) {
  const active = Object.entries(observation || {}).filter(([, count]) => Number(count) > 0)
  if (active.length) throw new Error(`STATE_MIGRATION_QUIESCENCE_REQUIRED ${active.map(([key, count]) => `${key}=${count}`).join(' ')}`)
}

/** Reconstructs a stopped provider with canonical binds and V2 Stack labels, without Compose metadata. */
function replacementContainerArgs(observed, binds, journal, name) {
  const args = ['create', '--name', name]
  const labels = Object.fromEntries(Object.entries(observed.Config.Labels || {}).filter(([key]) => key.startsWith('oes.runtime.')))
  labels['oes.runtime.stack-key'] = journal.stackKey
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
  for (const value of observed.Config.Env || []) args.push('--env', value)
  if (observed.Config.User) args.push('--user', observed.Config.User)
  if (observed.Config.WorkingDir) args.push('--workdir', observed.Config.WorkingDir)
  const bindingMap = new Map(binds.map((bind) => [`${path.resolve(bind.source)}:${bind.destination}`, bind.nextSource]))
  for (const mount of observed.Mounts || []) {
    if (mount.Type === 'bind') {
      const source = bindingMap.get(`${path.resolve(mount.Source)}:${mount.Destination}`) || mount.Source
      args.push('--mount', `type=bind,src=${source},dst=${mount.Destination}${mount.RW === false ? ',readonly' : ''}`)
    } else if (mount.Type === 'volume') args.push('--mount', `type=volume,src=${mount.Name},dst=${mount.Destination}${mount.RW === false ? ',readonly' : ''}`)
    else if (mount.Type === 'tmpfs') args.push('--tmpfs', mount.Destination)
  }
  for (const [containerPort, bindings] of Object.entries(observed.HostConfig.PortBindings || {})) for (const binding of bindings || []) args.push('--publish', `${binding.HostIp || '127.0.0.1'}:${binding.HostPort}:${containerPort}`)
  const networks = Object.entries(observed.NetworkSettings.Networks || {}).map(([network, attachment]) => ({
    network,
    aliases: (attachment.Aliases || []).filter((alias) => alias && alias !== observed.Id && alias !== name)
  }))
  if (networks.length) {
    args.push('--network', networks[0].network)
    for (const alias of networks[0].aliases) args.push('--network-alias', alias)
  }
  const restart = observed.HostConfig.RestartPolicy?.Name
  if (restart && restart !== 'no') args.push('--restart', restart === 'on-failure' && observed.HostConfig.RestartPolicy.MaximumRetryCount ? `${restart}:${observed.HostConfig.RestartPolicy.MaximumRetryCount}` : restart)
  if (observed.Config.Entrypoint?.length) args.push('--entrypoint', observed.Config.Entrypoint[0])
  args.push(observed.Config.Image, ...(observed.Config.Entrypoint?.slice(1) || []), ...(observed.Config.Cmd || []))
  return { args, labels, networks }
}

/** Produces the frozen canonical name for one necessarily replaced shared provider. */
export function migrationReplacementName(devStackId, pool, provider) {
  try { return sharedResourceName(devStackId, pool, provider) } catch (error) {
    if (error.message === 'SHARED_RESOURCE_NAME_IDENTITY_INVALID') throw new Error('STATE_MIGRATION_REPLACEMENT_IDENTITY_INVALID')
    throw new Error(error.message.replace('SHARED_RESOURCE_NAME_INVALID', 'STATE_MIGRATION_REPLACEMENT_NAME_INVALID'))
  }
}

/** Derives the frozen canonical replacement name from sealed Stack, pool, and provider identity. */
function canonicalReplacementName(observed, binds, journal) {
  const labels = observed.Config?.Labels || {}
  const stackRoot = path.join(journal.oldRoot, 'stacks', journal.stackKey)
  const relative = binds.length ? path.relative(stackRoot, binds[0].nextSource) : ''
  const components = relative.split(path.sep)
  const pool = labels['oes.runtime.pool'] || (components[0] === 'providers' ? components[1] : null)
  const provider = labels['oes.runtime.provider'] || (components[0] === 'providers' ? components[2] : null)
  const name = migrationReplacementName(journal.devStackId, pool, provider)
  return { name, pool, provider }
}

/** Replaces bind-affected providers while retaining stopped originals for pre-commit recovery. */
const dockerProviderLifecycle = {
  activate(binds, { journal, onProgress = () => {} }) {
    const byObject = new Map()
    for (const bind of binds) byObject.set(bind.objectId, [...(byObject.get(bind.objectId) || []), bind])
    const results = []
    for (const [oldObjectId, objectBinds] of byObject) {
      const before = inspectDockerContainer(oldObjectId)
      if (before.Id !== oldObjectId || before.State.Running || objectBinds.some((bind) => !(before.Mounts || []).some((mount) => mount.Type === 'bind' && path.resolve(mount.Source) === bind.source && mount.Destination === bind.destination))) throw new Error(`STATE_MIGRATION_BIND_OBJECT_MISMATCH objectId=${oldObjectId}`)
      const oldName = String(before.Name).replace(/^\//u, '')
      const canonical = canonicalReplacementName(before, objectBinds, journal)
      const backupName = `oes-v2-retained-${sha256(`${oldObjectId}:${journal.operationId}`).slice(0, 24)}`
      const replacement = replacementContainerArgs(before, objectBinds, journal, canonical.name)
      results.push({ oldObjectId, newObjectId: null, oldName, newName: canonical.name, backupName, provider: canonical.provider, pool: canonical.pool, labels: replacement.labels, networks: replacement.networks, binds: objectBinds.map((bind) => ({ oldSource: bind.source, source: bind.nextSource, destination: bind.destination })), stage: 'PLANNED', disposition: 'BIND_PROVIDER_REPLACEMENT_PLANNED' })
    }
    onProgress([...results])
    for (const record of results) {
      runChecked('docker', ['rename', record.oldObjectId, record.backupName], { timeout: 20000 })
      record.stage = 'OLD_RENAMED'
      onProgress([...results])
      const before = inspectDockerContainer(record.oldObjectId)
      const replacement = replacementContainerArgs(before, record.binds.map((bind) => ({ source: bind.oldSource, nextSource: bind.source, destination: bind.destination })), journal, record.newName)
      record.newObjectId = runChecked('docker', replacement.args, { timeout: 120000 }).stdout.trim()
      record.stage = 'NEW_CREATED'
      onProgress([...results])
      for (const attachment of replacement.networks.slice(1)) {
        const args = ['network', 'connect', ...attachment.aliases.flatMap((alias) => ['--alias', alias]), attachment.network, record.newObjectId]
        runChecked('docker', args, { timeout: 20000 })
      }
      const created = inspectDockerContainer(record.newObjectId)
      if (created.Id !== record.newObjectId || created.Config.Labels?.['oes.runtime.stack-key'] !== journal.stackKey || record.binds.some((bind) => !(created.Mounts || []).some((mount) => mount.Type === 'bind' && path.resolve(mount.Source) === bind.source && mount.Destination === bind.destination))) throw new Error(`STATE_MIGRATION_REPLACEMENT_IDENTITY_MISMATCH objectId=${record.newObjectId}`)
      runChecked('docker', ['start', record.newObjectId], { timeout: 120000 })
      if (!inspectDockerContainer(record.newObjectId).State.Running) throw new Error(`STATE_MIGRATION_BIND_PROVIDER_NOT_RUNNING objectId=${record.newObjectId}`)
      record.stage = 'NEW_RUNNING'
      record.disposition = 'BIND_PROVIDER_REPLACED_OLD_RETAINED'
      onProgress([...results])
    }
    return results
  },
  stop(records) {
    for (const record of [...(records || [])].reverse()) {
      let replacement = record.newObjectId ? inspectDockerContainerOrNull(record.newObjectId) : null
      if (!replacement) {
        const byName = inspectDockerContainerOrNull(record.newName)
        if (byName && byName.Id !== record.oldObjectId) replacement = byName
      }
      if (replacement) {
        if (replacement.Config.Labels?.['oes.runtime.stack-key'] !== record.labels['oes.runtime.stack-key'] || record.binds.some((bind) => !(replacement.Mounts || []).some((mount) => mount.Type === 'bind' && path.resolve(mount.Source) === bind.source && mount.Destination === bind.destination))) throw new Error(`STATE_MIGRATION_PROVIDER_IDENTITY_MISMATCH objectId=${replacement.Id}`)
        runChecked('docker', ['rm', '--force', replacement.Id], { timeout: 60000 })
      }
      const original = inspectDockerContainer(record.oldObjectId)
      const currentName = String(original.Name).replace(/^\//u, '')
      if (original.Id !== record.oldObjectId || ![record.backupName, record.oldName].includes(currentName)) throw new Error(`STATE_MIGRATION_ORIGINAL_IDENTITY_MISMATCH objectId=${record.oldObjectId}`)
      if (currentName === record.backupName) runChecked('docker', ['rename', record.oldObjectId, record.oldName], { timeout: 20000 })
    }
  },
  restart(records) {
    for (const record of records || []) {
      const original = inspectDockerContainer(record.oldObjectId)
      if (!original.State.Running) runChecked('docker', ['start', record.oldObjectId], { timeout: 120000 })
      if (!inspectDockerContainer(record.oldObjectId).State.Running) throw new Error(`STATE_MIGRATION_ORIGINAL_RESTART_FAILED objectId=${record.oldObjectId}`)
    }
  }
}

/** Rebinds manifest object references to exact replacements while retaining old/new audit identity. */
function applyProviderReplacements(value, records) {
  const replacements = (records || []).filter((record) => record.oldObjectId && record.newObjectId)
  const identities = new Map(replacements.map((record) => [record.oldObjectId, record.newObjectId]))
  const rewrite = (input) => {
    if (Array.isArray(input)) return input.map(rewrite)
    if (input && typeof input === 'object') {
      const output = Object.fromEntries(Object.entries(input).map(([key, child]) => [key, rewrite(child)]))
      const replacement = replacements.find((record) => input.objectId === record.oldObjectId)
      if (replacement) {
        output.objectId = replacement.newObjectId
        output.name = replacement.newName
        output.labels = replacement.labels
        output.replacement = { oldObjectId: replacement.oldObjectId, oldName: replacement.oldName, newObjectId: replacement.newObjectId, newName: replacement.newName, oldRetainedName: replacement.backupName, reason: 'STATE_LAYOUT_BIND_SOURCE_CHANGED' }
        delete output.labelCompatibility
      }
      return output
    }
    if (typeof input !== 'string') return input
    let output = input
    for (const [oldObjectId, newObjectId] of identities) output = output.replaceAll(oldObjectId, newObjectId)
    return output
  }
  return rewrite(value)
}

/** Rebinds each copied provider identity file to its exact activated replacement. */
function rewriteReplacementProviderIdentities(journal, records) {
  return (records || []).map((record) => {
    if (!record.oldObjectId || !record.newObjectId) return record
    const identityPath = path.join(journal.oldRoot, 'stacks', journal.stackKey, 'providers', record.pool, record.provider, 'identity.json')
    const priorBytes = fs.readFileSync(identityPath)
    const prior = JSON.parse(priorBytes.toString('utf8'))
    if (prior.provider !== record.provider || prior.kind !== 'container' || prior.objectId !== record.oldObjectId || prior.name !== record.oldName || prior.labels?.['oes.runtime.pool'] !== record.pool) throw new Error(`STATE_MIGRATION_PROVIDER_IDENTITY_FILE_MISMATCH provider=${record.provider}`)
    const next = { ...prior, name: record.newName, objectId: record.newObjectId, labels: record.labels }
    writeAtomic(identityPath, next)
    fsyncDirectory(path.dirname(identityPath))
    const nextBytes = fs.readFileSync(identityPath)
    const reopened = JSON.parse(nextBytes.toString('utf8'))
    if (reopened.objectId !== record.newObjectId || reopened.name !== record.newName || Object.entries(record.labels || {}).some(([key, expected]) => reopened.labels?.[key] !== expected)) throw new Error(`STATE_MIGRATION_PROVIDER_IDENTITY_REWRITE_FAILED provider=${record.provider}`)
    return { ...record, identityRewrite: { path: identityPath, priorSha256: sha256(priorBytes), sha256: sha256(nextBytes) } }
  })
}

/** Requires one complete replacement identity for every bind-affected old object. */
function validateCompletedProviderActivations(journal, records) {
  const expected = [...new Set((journal.binds || []).map((bind) => bind.objectId))].sort()
  const observed = [...new Set((records || []).map((record) => record.oldObjectId))].sort()
  if (fingerprint(expected) !== fingerprint(observed)) throw new Error('STATE_MIGRATION_PROVIDER_ACTIVATION_COVERAGE_MISMATCH')
  for (const record of records || []) {
    if (!record.oldObjectId || !record.newObjectId || !record.oldName || !record.newName || !record.backupName || !record.provider || !['dev', 'test'].includes(record.pool) || !record.labels || !record.binds?.length) throw new Error('STATE_MIGRATION_PROVIDER_MAPPING_INCOMPLETE')
  }
  return records
}

/** Reopens Docker-backed Stack endpoints and requires their exact containers to be running. */
function verifyDockerStackReadiness(stackManifest) {
  for (const endpoint of stackManifest.endpoints || []) {
    const objectId = endpoint.authority?.match(/^docker:([^:]+):/u)?.[1]
    if (!objectId) continue
    const observed = inspectDockerContainer(objectId)
    if (observed.Id !== objectId || !observed.State.Running) throw new Error(`STATE_MIGRATION_PROVIDER_READINESS_FAILED provider=${endpoint.provider}`)
  }
  return true
}

/** Reopens every journal-bound old/new provider identity and verifies retained-old plus ready-new mapping. */
function verifyActivatedProviderMappings(journal, stackManifest) {
  for (const record of journal.providerActivation || []) {
    if (!record.oldObjectId || !record.newObjectId || !record.oldName || !record.newName || !record.backupName) throw new Error('STATE_MIGRATION_PROVIDER_MAPPING_INCOMPLETE')
    const replacement = inspectDockerContainer(record.newObjectId)
    if (replacement.Id !== record.newObjectId || String(replacement.Name).replace(/^\//u, '') !== record.newName || !replacement.State.Running) throw new Error(`STATE_MIGRATION_REPLACEMENT_IDENTITY_MISMATCH objectId=${record.newObjectId}`)
    if (Object.entries(record.labels || {}).some(([key, expected]) => replacement.Config.Labels?.[key] !== expected) || record.binds.some((bind) => !(replacement.Mounts || []).some((mount) => mount.Type === 'bind' && path.resolve(mount.Source) === bind.source && mount.Destination === bind.destination))) throw new Error(`STATE_MIGRATION_REPLACEMENT_MAPPING_MISMATCH objectId=${record.newObjectId}`)
    const retained = inspectDockerContainer(record.oldObjectId)
    if (retained.Id !== record.oldObjectId || String(retained.Name).replace(/^\//u, '') !== record.backupName || retained.State.Running) throw new Error(`STATE_MIGRATION_RETAINED_PROVIDER_MISMATCH objectId=${record.oldObjectId}`)
    const identityPath = path.join(journal.oldRoot, 'stacks', journal.stackKey, 'providers', record.pool, record.provider, 'identity.json')
    const identityBytes = fs.readFileSync(identityPath)
    const identity = JSON.parse(identityBytes.toString('utf8'))
    if (record.identityRewrite?.path !== identityPath || record.identityRewrite.sha256 !== sha256(identityBytes) || identity.objectId !== record.newObjectId || identity.name !== record.newName || Object.entries(record.labels || {}).some(([key, expected]) => identity.labels?.[key] !== expected)) throw new Error(`STATE_MIGRATION_PROVIDER_IDENTITY_REOPEN_MISMATCH provider=${record.provider}`)
    const resource = (stackManifest.resources || []).find((candidate) => candidate.objectId === record.newObjectId)
    if (!resource || resource.name !== record.newName || resource.replacement?.oldObjectId !== record.oldObjectId || resource.replacement?.newObjectId !== record.newObjectId) throw new Error(`STATE_MIGRATION_STACK_PROVIDER_MAPPING_MISMATCH objectId=${record.newObjectId}`)
  }
  return true
}

/** Activates a PREPARED journal through the frozen rename sequence and durable COMMITTED boundary. */
export function activateStagedState({ journalPath, confirmation, faultAt, verifyNewRoot = () => true, verifyProviderReadiness = verifyDockerStackReadiness, observeQuiescence = observeLiveQuiescence, providerLifecycle = dockerProviderLifecycle, onDurabilityStep = () => {} }) {
  let journal = reopenJournal(journalPath)
  const barrier = acquireMigrationBarrier(journal.oldRoot, { operation: 'ACTIVATE', journalFingerprint: journal.journalFingerprint })
  try {
    journal = reopenJournal(journalPath)
    if (journal.state !== 'PREPARED') throw new Error(`STATE_MIGRATION_ACTIVATION_STATE_INVALID state=${journal.state}`)
    if (confirmation?.kind !== 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION' || confirmation.status !== 'CONFIRMED' || confirmation.journalFingerprint !== journal.journalFingerprint || confirmation.confirmationFingerprint !== fingerprint(confirmation, 'confirmationFingerprint')) throw new Error('STATE_MIGRATION_ACTIVATION_CONFIRMATION_INVALID')
    if (journal.devBackupReference) reopenDevBackupReference(journal.devBackupReference, journal.devStackId, journal.oldRoot, journal.devDataCarriers)
    assertQuiescent(observeQuiescence(journal))
    if (!fs.existsSync(journal.oldRoot) || !fs.existsSync(journal.stagedRoot) || fs.existsSync(journal.rollbackRoot)) throw new Error('STATE_MIGRATION_ACTIVATION_PATH_STATE_INVALID')
    if (fingerprint(inventoryTree(journal.oldRoot)) !== journal.sourceTreeFingerprint) throw new Error('STATE_MIGRATION_SOURCE_CHANGED')
    if (fingerprint(inventoryTree(journal.stagedRoot)) !== journal.stagedTreeFingerprint) throw new Error('STATE_MIGRATION_STAGED_TREE_CHANGED')
    fs.renameSync(journal.oldRoot, journal.rollbackRoot)
    fsyncParent(journal.oldRoot)
    journal = transition(journalPath, 'OLD_MOVED')
    if (faultAt === 'after-old-moved') throw new Error('STATE_MIGRATION_FAULT_AFTER_OLD_MOVED')
    fs.renameSync(journal.stagedRoot, journal.oldRoot)
    fsyncParent(journal.oldRoot)
    journal = transition(journalPath, 'NEW_PLACED')
    if (faultAt === 'after-new-placed') throw new Error('STATE_MIGRATION_FAULT_AFTER_NEW_PLACED')
    const relocated = relocateStackPointer(journal)
    onDurabilityStep('RELOCATED_POINTER_DIRECTORY_SYNCED', journal)
    let providerActivation = providerLifecycle.activate(journal.binds, { journal, stackManifest: relocated.manifest, onProgress: (records) => { journal = transition(journalPath, 'NEW_PLACED', { providerActivation: records }) } }) || []
    journal = transition(journalPath, 'NEW_PLACED', { providerActivation })
    if (faultAt === 'after-provider-activation') throw new Error('STATE_MIGRATION_FAULT_AFTER_PROVIDER_ACTIVATION')
    validateCompletedProviderActivations(journal, providerActivation)
    providerActivation = rewriteReplacementProviderIdentities(journal, providerActivation)
    journal = transition(journalPath, 'NEW_PLACED', { providerActivation })
    if (faultAt === 'after-provider-identity-rewrite') throw new Error('STATE_MIGRATION_FAULT_AFTER_PROVIDER_IDENTITY_REWRITE')
    const current = reopenCurrentStackManifest(path.join(journal.oldRoot, 'stacks', journal.stackKey)).manifest
    const draft = applyProviderReplacements({ ...current, lifecycle: 'REGISTERED', activationPlanFingerprint: journal.planFingerprint }, providerActivation)
    delete draft.schemaVersion
    delete draft.kind
    delete draft.generation
    delete draft.stackManifestFingerprint
    const published = publishStackManifest(path.join(journal.oldRoot, 'stacks', journal.stackKey), draft)
    fsyncDirectory(path.dirname(published.file))
    onDurabilityStep('MANIFEST_DIRECTORY_SYNCED', journal)
    fsyncDirectory(path.join(journal.oldRoot, 'stacks', journal.stackKey))
    onDurabilityStep('STACK_POINTER_DIRECTORY_SYNCED', journal)
    const reopenedPublication = reopenCurrentStackManifest(path.join(journal.oldRoot, 'stacks', journal.stackKey))
    if (reopenedPublication.pointer.generation !== published.reference.generation || reopenedPublication.pointer.sha256 !== published.reference.sha256 || reopenedPublication.pointer.fingerprint !== published.reference.fingerprint) throw new Error('STATE_MIGRATION_STACK_PUBLICATION_REOPEN_MISMATCH')
    onDurabilityStep('STACK_PUBLICATION_REOPENED', journal)
    if (!verifyProviderReadiness(published.manifest)) throw new Error('STATE_MIGRATION_PROVIDER_READINESS_FAILED')
    if (!verifyCanonicalActivatedRoot(journal.oldRoot, journal) || !verifyNewRoot(journal.oldRoot, journal)) throw new Error('STATE_MIGRATION_NEW_ROOT_VERIFICATION_FAILED')
    journal = transition(journalPath, 'COMMITTED', { activatedStackManifestReference: published.reference, committedRootTreeFingerprint: fingerprint(inventoryTree(journal.oldRoot)) })
    return journal
  } finally { barrier.release() }
}

/** Recovers pre-commit activation to old authority, or reopens committed new authority. */
export function recoverStateLayout({ journalPath, verifyNewRoot = () => true, verifyProviderReadiness = verifyDockerStackReadiness, verifyProviderMappings = verifyActivatedProviderMappings, providerLifecycle = dockerProviderLifecycle }) {
  let journal = reopenJournal(journalPath)
  const barrier = acquireMigrationBarrier(journal.oldRoot, { operation: 'RECOVER', journalFingerprint: journal.journalFingerprint })
  try {
    journal = reopenJournal(journalPath)
    if (journal.state === 'COMMITTED') {
      if (!fs.existsSync(journal.oldRoot) || !verifyCanonicalActivatedRoot(journal.oldRoot, journal) || !verifyNewRoot(journal.oldRoot, journal)) throw new Error('STATE_MIGRATION_COMMITTED_ROOT_INVALID')
      const activated = reopenStackManifest(journal.activatedStackManifestReference, { stackKey: journal.stackKey, devStackId: journal.devStackId })
      const current = reopenCurrentStackManifest(path.join(journal.oldRoot, 'stacks', journal.stackKey))
      if (current.pointer.generation !== journal.activatedStackManifestReference.generation || current.pointer.sha256 !== journal.activatedStackManifestReference.sha256 || current.pointer.fingerprint !== journal.activatedStackManifestReference.fingerprint) throw new Error('STATE_MIGRATION_ACTIVATED_GENERATION_MISMATCH')
      if (!verifyProviderMappings(journal, activated) || !verifyProviderReadiness(activated)) throw new Error('STATE_MIGRATION_COMMITTED_PROVIDER_VERIFICATION_FAILED')
      return { authority: 'NEW', state: 'COMMITTED', root: journal.oldRoot }
    }
    if (['RECOVERED_OLD', 'ROLLED_BACK'].includes(journal.state)) {
      if (!fs.existsSync(journal.oldRoot) || fingerprint(inventoryTree(journal.oldRoot)) !== journal.sourceTreeFingerprint) throw new Error('STATE_MIGRATION_RECOVERED_ROOT_INVALID')
      return { authority: 'OLD', state: journal.state, root: journal.oldRoot, quarantine: journal.quarantine || journal.retainedNewRoot || null }
    }
    const oldExists = fs.existsSync(journal.oldRoot)
    const stagedExists = fs.existsSync(journal.stagedRoot)
    const rollbackExists = fs.existsSync(journal.rollbackRoot)
    if (journal.state === 'PREPARED' && oldExists && stagedExists && !rollbackExists) return { authority: 'OLD', state: 'PREPARED', root: journal.oldRoot }
    const quarantine = `${journal.stagedRoot}.uncommitted-${journal.operationId}`
    providerLifecycle.stop(journal.providerActivation || [])
    if (rollbackExists) {
      if (oldExists) {
        if (fs.existsSync(quarantine)) throw new Error('STATE_MIGRATION_QUARANTINE_EXISTS')
        fs.renameSync(journal.oldRoot, quarantine)
      } else if (stagedExists) {
        if (fs.existsSync(quarantine)) throw new Error('STATE_MIGRATION_QUARANTINE_EXISTS')
        fs.renameSync(journal.stagedRoot, quarantine)
      }
      fs.renameSync(journal.rollbackRoot, journal.oldRoot)
      fsyncParent(journal.oldRoot)
    } else if (!oldExists || fingerprint(inventoryTree(journal.oldRoot)) !== journal.sourceTreeFingerprint) throw new Error('STATE_MIGRATION_ROLLBACK_ROOT_MISSING')
    providerLifecycle.restart(journal.providerActivation || [])
    journal = transition(journalPath, 'RECOVERED_OLD', { quarantine })
    return { authority: 'OLD', state: journal.state, root: journal.oldRoot, quarantine }
  } finally { barrier.release() }
}

/** Performs a confirmed whole-state rollback after COMMITTED while retaining the new tree for audit. */
export function rollbackCommittedState({ journalPath, confirmation, observeQuiescence = (journal, { allowedRunningObjectIds = [] } = {}) => observeLiveQuiescence(journal, [journal.oldRoot, journal.rollbackRoot], allowedRunningObjectIds), providerLifecycle = dockerProviderLifecycle }) {
  let journal = reopenJournal(journalPath)
  const barrier = acquireMigrationBarrier(journal.oldRoot, { operation: 'ROLLBACK', journalFingerprint: journal.journalFingerprint })
  try {
    journal = reopenJournal(journalPath)
    if (journal.state === 'ROLLED_BACK') {
      if (!fs.existsSync(journal.oldRoot) || fingerprint(inventoryTree(journal.oldRoot)) !== journal.sourceTreeFingerprint || !fs.existsSync(journal.retainedNewRoot)) throw new Error('STATE_MIGRATION_ROLLED_BACK_ROOT_INVALID')
      return journal
    }
    if (journal.state !== 'COMMITTED') throw new Error(`STATE_MIGRATION_ROLLBACK_STATE_INVALID state=${journal.state}`)
    if (confirmation?.kind !== 'OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION' || confirmation.status !== 'CONFIRMED' || confirmation.journalFingerprint !== journal.journalFingerprint || confirmation.confirmationFingerprint !== fingerprint(confirmation, 'confirmationFingerprint')) throw new Error('STATE_MIGRATION_ROLLBACK_CONFIRMATION_INVALID')
    const allowedRunningObjectIds = (journal.providerActivation || []).map((record) => record.newObjectId).filter(Boolean)
    assertQuiescent(observeQuiescence(journal, { allowedRunningObjectIds }))
    const retainedNewRoot = `${journal.stagedRoot}.rolled-back-${journal.operationId}`
    providerLifecycle.stop(journal.providerActivation || [])
    assertQuiescent(observeQuiescence(journal, { allowedRunningObjectIds: [] }))
    if (fs.existsSync(journal.rollbackRoot)) {
      if (fs.existsSync(journal.oldRoot)) {
        if (fs.existsSync(retainedNewRoot)) throw new Error('STATE_MIGRATION_RETAINED_NEW_ROOT_EXISTS')
        fs.renameSync(journal.oldRoot, retainedNewRoot)
      } else if (!fs.existsSync(retainedNewRoot)) throw new Error('STATE_MIGRATION_COMMITTED_ROOT_MISSING')
      fs.renameSync(journal.rollbackRoot, journal.oldRoot)
      fsyncParent(journal.oldRoot)
    } else if (!fs.existsSync(journal.oldRoot) || fingerprint(inventoryTree(journal.oldRoot)) !== journal.sourceTreeFingerprint || !fs.existsSync(retainedNewRoot)) throw new Error('STATE_MIGRATION_ROLLBACK_ROOT_MISSING')
    providerLifecycle.restart(journal.providerActivation || [])
    journal = transition(journalPath, 'ROLLED_BACK', { retainedNewRoot })
    return journal
  } finally { barrier.release() }
}
