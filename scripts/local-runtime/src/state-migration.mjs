import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'
import { publishStackManifest, reopenCurrentStackManifest } from './manifest.mjs'
import { assertNoSymlink, exactPathKey, resolveRuntimeLayout } from './state-layout.mjs'
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
  const leaseFiles = entries.filter((entry) => entry.type === 'FILE' && /(?:^|\/)leases\/.*\.json$/u.test(entry.path)).map((entry) => entry.path)
  const binds = []
  for (const object of dockerObjects) for (const mount of object.mounts || object.Mounts || []) {
    if (mount.Type !== 'bind') continue
    const source = path.resolve(mount.Source)
    if (source === root || source.startsWith(`${root}${path.sep}`)) binds.push({ objectId: object.objectId || object.Id, name: object.name || object.Name, running: Boolean(object.running ?? object.State?.Running), source, destination: mount.Destination })
  }
  const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_INVENTORY', stateRoot: root, entries, activeRunFiles, leaseFiles, binds, sourceTreeFingerprint: fingerprint(entries) }
  return { ...raw, inventoryFingerprint: fingerprint(raw) }
}

/** Reopens one external DEV-data snapshot and verifies every retained archive byte. */
function reopenDevBackupReference(reference, expectedDevStackId, stateRoot) {
  if (!reference || reference.type !== 'OES_DEV_STATE_BACKUP' || !path.isAbsolute(reference.path)) throw new Error('STATE_MIGRATION_DEV_BACKUP_REFERENCE_INVALID')
  const selected = path.resolve(reference.path)
  const root = path.resolve(stateRoot)
  if (selected === root || selected.startsWith(`${root}${path.sep}`)) throw new Error('STATE_MIGRATION_DEV_BACKUP_MUST_BE_EXTERNAL')
  const bytes = fs.readFileSync(selected)
  if (sha256(bytes) !== reference.sha256) throw new Error('STATE_MIGRATION_DEV_BACKUP_SHA_MISMATCH')
  const value = JSON.parse(bytes.toString('utf8'))
  if (value.kind !== 'OES_DEV_STATE_BACKUP' || value.backupFingerprint !== reference.fingerprint || value.backupFingerprint !== fingerprint(value, 'backupFingerprint') || value.devStackId !== expectedDevStackId || value.sourcesPreserved !== true || !value.backups?.length) throw new Error('STATE_MIGRATION_DEV_BACKUP_BINDING_MISMATCH')
  for (const backup of value.backups) {
    if (!path.isAbsolute(backup.file) || sha256(fs.readFileSync(backup.file)) !== backup.sha256) throw new Error(`STATE_MIGRATION_DEV_BACKUP_ARCHIVE_MISMATCH kind=${backup.kind}`)
  }
  return value
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
  if (fs.existsSync(sharedRoot)) for (const provider of fs.readdirSync(sharedRoot).sort()) {
    const identityPath = path.join(sharedRoot, provider, 'identity.json')
    const identity = fs.existsSync(identityPath) ? readJson(identityPath) : null
    const pool = providerPools[provider] || identity?.labels?.['oes.runtime.pool']
    if (!['dev', 'test'].includes(pool)) throw new Error(`STATE_MIGRATION_PROVIDER_POOL_REQUIRED provider=${provider}`)
    mappings.push({ type: provider === 'mtls' ? 'CREDENTIAL_TREE' : 'PROVIDER_TREE', provider, pool, source: path.join(sharedRoot, provider), targetRelative: path.join(provider === 'mtls' ? 'credentials' : 'providers', pool, provider) })
  }
  const runsRoot = path.join(oldRoot, 'runs')
  if (fs.existsSync(runsRoot)) mappings.push({ type: 'HISTORICAL_RUN_EVIDENCE', source: runsRoot, targetRelative: path.join('evidence', 'pre-activation-runs') })
  const restoreRoot = path.join(oldRoot, 'restore')
  if (fs.existsSync(restoreRoot)) mappings.push({ type: 'RESTORE_STATE', source: restoreRoot, targetRelative: 'restore' })
  const mappedPools = new Map(mappings.filter((mapping) => mapping.provider).map((mapping) => [mapping.provider, mapping.pool]))
  const normalizedProviderSnapshots = providerSnapshots.map((snapshot) => {
    const provider = snapshot.resource?.provider || snapshot.endpoint?.provider
    const pool = snapshot.resource?.pool || snapshot.resource?.labels?.['oes.runtime.pool'] || snapshot.endpoint?.pool || providerPools[provider] || mappedPools.get(provider)
    if (!provider || !['dev', 'test'].includes(pool)) throw new Error(`STATE_MIGRATION_PROVIDER_POOL_REQUIRED provider=${provider || 'UNKNOWN'}`)
    const resource = snapshot.resource ? { ...snapshot.resource, pool } : undefined
    const endpoint = snapshot.endpoint ? { ...snapshot.endpoint, pool } : undefined
    if (resource && resource.scope !== 'SHARED') throw new Error(`STATE_MIGRATION_PROVIDER_SCOPE_INVALID provider=${provider}`)
    if (endpoint && (!endpoint.ready || !endpoint.authority)) throw new Error(`STATE_MIGRATION_PROVIDER_ENDPOINT_INVALID provider=${provider}`)
    return { ...(resource ? { resource } : {}), ...(endpoint ? { endpoint } : {}) }
  })
  const hasDevData = normalizedProviderSnapshots.some((snapshot) => snapshot.resource?.pool === 'dev' && ['database', 'bucket'].includes(snapshot.resource.kind))
  if (hasDevData) reopenDevBackupReference(devBackupReference, discoveredDevStackId, oldRoot)
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
    devBackupReference,
    quiescence: { activeRunCount: inventory.activeRunFiles.length, activeStackLeaseCount: inventory.leaseFiles.length, runningBindCount: inventory.binds.filter((item) => item.running).length },
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
  return reopenJournal(file)
}

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
  if (plan.quiescence.activeRunCount || plan.quiescence.activeStackLeaseCount || plan.quiescence.runningBindCount) throw new Error('STATE_MIGRATION_QUIESCENCE_REQUIRED')
  if (plan.devBackupReference) reopenDevBackupReference(plan.devBackupReference, plan.devStackId, plan.oldRoot)
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
    const journalRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION', state: 'PREPARED', operationId: crypto.randomUUID(), planFingerprint: plan.planFingerprint, inventoryFingerprint: inventory.inventoryFingerprint, sourceTreeFingerprint: inventory.sourceTreeFingerprint, devBackupReference: plan.devBackupReference, oldRoot: plan.oldRoot, stagedRoot: plan.stagedRoot, rollbackRoot: plan.rollbackRoot, stackKey: layout.stackKey, devStackId: layout.devStackId, stagedTreeFingerprint: fingerprint(stagedEntries), quiescence: plan.quiescence, binds: plan.binds.map((bind) => ({ ...bind, nextSource: rewriteFinalPaths(bind.source, plan, layout.stackKey) })), invalidatedRestoreBindings, transitions: [{ state: 'PREPARED', at: new Date().toISOString() }] }
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
      const backupName = `${oldName}-pre-layout-${journal.operationId.slice(0, 8)}`
      const replacement = replacementContainerArgs(before, objectBinds, journal, oldName)
      results.push({ oldObjectId, newObjectId: null, oldName, backupName, labels: replacement.labels, networks: replacement.networks, binds: objectBinds.map((bind) => ({ oldSource: bind.source, source: bind.nextSource, destination: bind.destination })), stage: 'PLANNED', disposition: 'BIND_PROVIDER_REPLACEMENT_PLANNED' })
    }
    onProgress([...results])
    for (const record of results) {
      runChecked('docker', ['rename', record.oldObjectId, record.backupName], { timeout: 20000 })
      record.stage = 'OLD_RENAMED'
      onProgress([...results])
      const before = inspectDockerContainer(record.oldObjectId)
      const replacement = replacementContainerArgs(before, record.binds.map((bind) => ({ source: bind.oldSource, nextSource: bind.source, destination: bind.destination })), journal, record.oldName)
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
        const byName = inspectDockerContainerOrNull(record.oldName)
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
        output.labels = replacement.labels
        output.replacement = { oldObjectId: replacement.oldObjectId, newObjectId: replacement.newObjectId, oldRetainedName: replacement.backupName, reason: 'STATE_LAYOUT_BIND_SOURCE_CHANGED' }
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

/** Activates a PREPARED journal through the frozen rename sequence and durable COMMITTED boundary. */
export function activateStagedState({ journalPath, confirmation, faultAt, verifyNewRoot = () => true, verifyProviderReadiness = verifyDockerStackReadiness, observeQuiescence = (journal) => journal.quiescence, providerLifecycle = dockerProviderLifecycle }) {
  let journal = reopenJournal(journalPath)
  const lock = path.join(path.dirname(journal.oldRoot), `.${path.basename(journal.oldRoot)}.migration.lock`)
  try { fs.mkdirSync(lock, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') throw new Error('STATE_MIGRATION_LOCK_HELD'); throw error }
  try {
    if (journal.state !== 'PREPARED') throw new Error(`STATE_MIGRATION_ACTIVATION_STATE_INVALID state=${journal.state}`)
    if (confirmation?.kind !== 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION' || confirmation.status !== 'CONFIRMED' || confirmation.journalFingerprint !== journal.journalFingerprint || confirmation.confirmationFingerprint !== fingerprint(confirmation, 'confirmationFingerprint')) throw new Error('STATE_MIGRATION_ACTIVATION_CONFIRMATION_INVALID')
    if (journal.devBackupReference) reopenDevBackupReference(journal.devBackupReference, journal.devStackId, journal.oldRoot)
    const quiescence = observeQuiescence(journal)
    if (quiescence.activeRunCount || quiescence.activeStackLeaseCount || quiescence.runningBindCount) throw new Error('STATE_MIGRATION_QUIESCENCE_REQUIRED')
    if (!fs.existsSync(journal.oldRoot) || !fs.existsSync(journal.stagedRoot) || fs.existsSync(journal.rollbackRoot)) throw new Error('STATE_MIGRATION_ACTIVATION_PATH_STATE_INVALID')
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
    const providerActivation = providerLifecycle.activate(journal.binds, { journal, stackManifest: relocated.manifest, onProgress: (records) => { journal = transition(journalPath, 'NEW_PLACED', { providerActivation: records }) } }) || []
    journal = transition(journalPath, 'NEW_PLACED', { providerActivation })
    if (faultAt === 'after-provider-activation') throw new Error('STATE_MIGRATION_FAULT_AFTER_PROVIDER_ACTIVATION')
    const current = reopenCurrentStackManifest(path.join(journal.oldRoot, 'stacks', journal.stackKey)).manifest
    const draft = applyProviderReplacements({ ...current, lifecycle: 'REGISTERED', activationPlanFingerprint: journal.planFingerprint }, providerActivation)
    delete draft.schemaVersion
    delete draft.kind
    delete draft.generation
    delete draft.stackManifestFingerprint
    const published = publishStackManifest(path.join(journal.oldRoot, 'stacks', journal.stackKey), draft)
    if (!verifyProviderReadiness(published.manifest)) throw new Error('STATE_MIGRATION_PROVIDER_READINESS_FAILED')
    if (!verifyCanonicalActivatedRoot(journal.oldRoot, journal) || !verifyNewRoot(journal.oldRoot, journal)) throw new Error('STATE_MIGRATION_NEW_ROOT_VERIFICATION_FAILED')
    journal = transition(journalPath, 'COMMITTED', { activatedStackManifestReference: published.reference, committedRootTreeFingerprint: fingerprint(inventoryTree(journal.oldRoot)) })
    return journal
  } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

/** Recovers pre-commit activation to old authority, or reopens committed new authority. */
export function recoverStateLayout({ journalPath, verifyNewRoot = () => true, providerLifecycle = dockerProviderLifecycle }) {
  let journal = reopenJournal(journalPath)
  if (journal.state === 'COMMITTED') {
    if (!fs.existsSync(journal.oldRoot) || !verifyCanonicalActivatedRoot(journal.oldRoot, journal) || !verifyNewRoot(journal.oldRoot, journal)) throw new Error('STATE_MIGRATION_COMMITTED_ROOT_INVALID')
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
}

/** Performs a confirmed whole-state rollback after COMMITTED while retaining the new tree for audit. */
export function rollbackCommittedState({ journalPath, confirmation, providerLifecycle = dockerProviderLifecycle }) {
  let journal = reopenJournal(journalPath)
  if (journal.state === 'ROLLED_BACK') {
    if (!fs.existsSync(journal.oldRoot) || fingerprint(inventoryTree(journal.oldRoot)) !== journal.sourceTreeFingerprint || !fs.existsSync(journal.retainedNewRoot)) throw new Error('STATE_MIGRATION_ROLLED_BACK_ROOT_INVALID')
    return journal
  }
  if (journal.state !== 'COMMITTED') throw new Error(`STATE_MIGRATION_ROLLBACK_STATE_INVALID state=${journal.state}`)
  if (confirmation?.kind !== 'OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION' || confirmation.status !== 'CONFIRMED' || confirmation.journalFingerprint !== journal.journalFingerprint || confirmation.confirmationFingerprint !== fingerprint(confirmation, 'confirmationFingerprint')) throw new Error('STATE_MIGRATION_ROLLBACK_CONFIRMATION_INVALID')
  const retainedNewRoot = `${journal.stagedRoot}.rolled-back-${journal.operationId}`
  providerLifecycle.stop(journal.providerActivation || [])
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
}
