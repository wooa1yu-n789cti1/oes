#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyCommittedMigrations, applyFoundationSeeds, applyRunFixture, cleanProcessEnvironment, prepareDevelopmentArtifacts, reconcileMachineWorkloadSelectors } from './src/bootstrap.mjs'
import { loadRuntimeConfig } from './src/config.mjs'
import { resolveCredentialReference } from './src/credentials.mjs'
import { inventoryLegacyResources, planLegacyCleanup, applyLegacyCleanup, observeLegacyResidue, backupValidDevData, writeLegacyArtifact } from './src/legacy-reconcile.mjs'
import { environmentForOwner, reopenManifest } from './src/manifest.mjs'
import { resolveEndpoint } from './src/manifest.mjs'
import { reconcileRuntime, startRuntime, withRuntime } from './src/orchestrator.mjs'
import { planRuntime } from './src/planner.mjs'
import { runChecked } from './src/process.mjs'
import { startDevelopmentProcesses, stopDevelopmentProcesses } from './src/process-runtime.mjs'
import { backupDevelopmentState, restoreDevelopmentState } from './src/development-backup.mjs'
import { activateStagedState, inventoryStateLayout, planStateLayoutMigration, recoverStateLayout, rollbackCommittedState, stageStateLayoutMigration } from './src/state-migration.mjs'
import { planOperatorReconciliation, reopenOperatorAuthority, writeOperatorStatus } from './src/operator-status.mjs'
import { sha256, writeAtomic } from './src/canonical.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const BOOLEAN_OPTIONS = new Set(['migrate', 'foundation-seed'])
const INTENT_OPTIONS = ['profile', 'test-class', 'owner', 'owners', 'capabilities', 'task-key', 'run-id', 'dev-stack-id', 'state-root', 'machine-config', 'concurrency', 'driver']
const SUBCOMMAND_OPTIONS = Object.freeze({
  dev: [...INTENT_OPTIONS, 'scope'], plan: INTENT_OPTIONS, start: INTENT_OPTIONS,
  run: [...INTENT_OPTIONS, 'migrate', 'foundation-seed', 'fixture', 'timeout'],
  migrate: ['manifest'], 'foundation-seed': ['manifest'], fixture: ['manifest', 'fixture'],
  reconcile: ['manifest', 'transaction'], status: ['manifest'],
  'state-inventory': ['state-root', 'docker-observations', 'output'],
  'state-plan': ['inventory', 'provider-snapshots', 'provider-pools', 'dev-backup-record', 'dev-stack-id', 'output'],
  'state-stage': ['plan', 'inventory'], 'state-activate': ['journal', 'confirmation'],
  'state-recover': ['journal'], 'state-rollback': ['journal', 'confirmation'],
  'operator-status': ['observations', 'authority', 'output'],
  'dev-backup': ['manifest', 'output'], 'dev-restore': ['manifest', 'backup', 'confirmation'],
  'legacy-inventory': ['bindings', 'output'], 'legacy-plan': ['inventory', 'owner-task-id', 'output'],
  'legacy-backup': ['inventory', 'output'], 'legacy-apply': ['plan', 'confirmation', 'collaboration-binding', 'output'],
  'legacy-residue': ['plan', 'bindings', 'output']
})

/** Parses long options while preserving the command following `--`. */
export function parseArguments(argv) {
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  const separator = forwarded.indexOf('--')
  const command = separator >= 0 ? forwarded.slice(separator + 1) : []
  const tokens = separator >= 0 ? forwarded.slice(0, separator) : forwarded
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) throw new Error(`RUNTIME_ARGUMENT_INVALID value=${token}`)
    const [key, inline] = token.slice(2).split('=', 2)
    if (!key || inline === '') throw new Error(`RUNTIME_OPTION_VALUE_REQUIRED option=${token}`)
    const missingValue = tokens[index + 1]?.startsWith('--') || index + 1 === tokens.length
    if (inline === undefined && missingValue && !BOOLEAN_OPTIONS.has(key)) throw new Error(`RUNTIME_OPTION_VALUE_REQUIRED option=${token}`)
    options[key] = inline ?? (missingValue ? 'true' : tokens[++index])
  }
  return { options, command }
}

/** Rejects unknown subcommands/options and child commands outside the run boundary. */
function validateCommandSurface(subcommand, options, command) {
  if (!subcommand) return
  const allowed = SUBCOMMAND_OPTIONS[subcommand]
  if (!allowed) throw new Error(`RUNTIME_SUBCOMMAND_INVALID subcommand=${subcommand}`)
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`RUNTIME_OPTION_INVALID subcommand=${subcommand} options=${unknown.join(',')}`)
  if (subcommand !== 'run' && command.length) throw new Error(`RUNTIME_COMMAND_FORBIDDEN subcommand=${subcommand}`)
}

/** Splits one comma-separated option into a stable unique list. */
function list(value) { return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))] }

/** Converts CLI options into one explicit launcher intent. */
function intentFrom(options) {
  return {
    root,
    profile: options.profile || 'LOCAL_INTEGRATION',
    testClass: options['test-class'] || 'integration',
    owners: list(options.owners || options.owner),
    capabilities: list(options.capabilities),
    taskKey: options['task-key'],
    runId: options['run-id'],
    devStackId: options['dev-stack-id'],
    stateRoot: options['state-root'],
    machineConfigPath: options['machine-config'],
    concurrency: options.concurrency,
    driver: options.driver || 'docker'
  }
}

/** Writes deterministic JSON output without credential values. */
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

/** Resolves the exact owner environment from a registered manifest. */
function ownerEnvironment(manifest, owner) {
  return { ...cleanProcessEnvironment(), ...environmentForOwner(manifest, owner, resolveCredentialReference), OES_RUNTIME_MANIFEST: path.join(manifest.runDirectory, 'manifest.json') }
}

/** Implements the unified launcher command surface. */
export async function main(argv = process.argv.slice(2)) {
  const subcommand = argv[0]
  const { options, command } = parseArguments(argv.slice(1))
  validateCommandSurface(subcommand, options, command)
  if (subcommand === 'dev') {
    const scopes = {
      system: ['permission-service','identity-service','hr-service','auth-service','collaboration-service','asset-service','item-master-service','notification-service','public-entry-service','party-service','site-service','tenant-org-service','terminal-device-service','browser-activity-service','api-gateway'],
      business: ['sales-service','crm-service','srm-service','finance-service','procurement-service','wms-service','mes-service'],
      full: Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8')).owners)
    }
    const explicitOwners = list(options.owners || options.owner)
    const owners = explicitOwners.length ? explicitOwners : scopes[options.scope || 'full']
    if (!owners) throw new Error(`DEV_SCOPE_INVALID scope=${options.scope}`)
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error('DEVELOPMENT_INTERRUPTED'))
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let started
    let processes
    try {
      started = await startRuntime({ ...intentFrom({ ...options, profile: 'DEV', 'test-class': 'integration', owners: owners.join(','), 'task-key': options['task-key'] || 'developer_dev' }), owners })
      if (controller.signal.aborted) throw controller.signal.reason
      backupDevelopmentState(started.file)
      if (controller.signal.aborted) throw controller.signal.reason
      prepareDevelopmentArtifacts(started.file, { root })
      if (controller.signal.aborted) throw controller.signal.reason
      applyCommittedMigrations(started.file, { root })
      if (controller.signal.aborted) throw controller.signal.reason
      applyFoundationSeeds(started.file, { root })
      if (controller.signal.aborted) throw controller.signal.reason
      const selectors = reconcileMachineWorkloadSelectors(started.file, { root })
      if (controller.signal.aborted) throw controller.signal.reason
      processes = await startDevelopmentProcesses(started.file, { root, selectorPath: selectors?.path, signal: controller.signal })
      emit({ status: 'DEV_READY', manifestPath: processes.manifestPath, manifestFingerprint: processes.manifest.manifestFingerprint, owners })
      if (!controller.signal.aborted) await new Promise((resolvePromise) => controller.signal.addEventListener('abort', resolvePromise, { once: true }))
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      if (processes) await stopDevelopmentProcesses(processes.children)
      if (started) reconcileRuntime({ manifestPath: started.file, cleanupResource: started.cleanup, releaseSlot: started.releaseSlot, releaseRunLock: started.releaseRunLock, releaseDevLock: started.releaseDevLock })
    }
    return
  }
  if (subcommand === 'plan') {
    const intent = intentFrom(options)
    const config = loadRuntimeConfig({ root, profile: intent.profile, explicit: { concurrency: intent.concurrency }, machineConfigPath: intent.machineConfigPath, stateRoot: intent.stateRoot })
    emit({ config, plan: planRuntime(intent) })
    return
  }
  if (subcommand === 'start') {
    const started = await startRuntime(intentFrom(options))
    emit({ status: 'REGISTERED', manifestPath: started.file, manifestFingerprint: started.manifest.manifestFingerprint, taskKey: started.manifest.taskKey, runId: started.manifest.runId, profile: started.manifest.profile })
    return
  }
  if (subcommand === 'run') {
    if (!command.length) throw new Error('RUNTIME_COMMAND_REQUIRED')
    const owner = options.owner
    if (!owner) throw new Error('RUNTIME_COMMAND_OWNER_REQUIRED')
    await withRuntime(intentFrom(options), async (manifest, manifestPath) => {
      if (options.migrate === 'true') applyCommittedMigrations(manifestPath, { root })
      if (options['foundation-seed'] === 'true') applyFoundationSeeds(manifestPath, { root })
      if (options.fixture) applyRunFixture(manifestPath, options.fixture, { root })
      const result = runChecked(command[0], command.slice(1), { cwd: root, env: ownerEnvironment(manifest, owner), timeout: Number(options.timeout || 600000) })
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      emit({ status: 'COMMAND_COMPLETE', exitStatus: result.status, manifestFingerprint: manifest.manifestFingerprint })
    })
    return
  }
  if (['migrate', 'foundation-seed', 'fixture'].includes(subcommand)) {
    const manifestPath = path.resolve(options.manifest || '')
    const result = subcommand === 'migrate' ? applyCommittedMigrations(manifestPath, { root }) : subcommand === 'foundation-seed' ? applyFoundationSeeds(manifestPath, { root }) : applyRunFixture(manifestPath, options.fixture, { root })
    emit({ status: 'COMPLETE', stage: subcommand, results: result })
    return
  }
  if (subcommand === 'reconcile') {
    const manifestPath = options.manifest ? path.resolve(options.manifest) : null
    const transactionPath = options.transaction ? path.resolve(options.transaction) : null
    emit(reconcileRuntime({ manifestPath, transactionPath }))
    return
  }
  if (subcommand === 'status') {
    const manifest = reopenManifest(path.resolve(options.manifest || ''))
    emit({ status: manifest.lifecycle, profile: manifest.profile, stackKey: manifest.stackKey, taskKey: manifest.taskKey, runId: manifest.runId, devStackId: manifest.devStackId, manifestFingerprint: manifest.manifestFingerprint, providers: manifest.endpoints.map((binding) => { const endpoint = resolveEndpoint(manifest, binding.provider); return { provider: endpoint.provider, source: binding.source, authority: endpoint.authority, ready: endpoint.ready } }) })
    return
  }
  if (subcommand === 'state-inventory') {
    const dockerObjects = options['docker-observations'] ? JSON.parse(fs.readFileSync(path.resolve(options['docker-observations']), 'utf8')) : []
    const value = inventoryStateLayout({ stateRoot: path.resolve(options['state-root']), dockerObjects })
    if (options.output) writeAtomic(path.resolve(options.output), value)
    emit(value)
    return
  }
  if (subcommand === 'state-plan') {
    const inventory = JSON.parse(fs.readFileSync(path.resolve(options.inventory), 'utf8'))
    const providerSnapshots = options['provider-snapshots'] ? JSON.parse(fs.readFileSync(path.resolve(options['provider-snapshots']), 'utf8')) : []
    const providerPools = options['provider-pools'] ? JSON.parse(fs.readFileSync(path.resolve(options['provider-pools']), 'utf8')) : {}
    let devBackupReference = null
    if (options['dev-backup-record']) {
      const backupPath = path.resolve(options['dev-backup-record'])
      const bytes = fs.readFileSync(backupPath)
      const backup = JSON.parse(bytes.toString('utf8'))
      devBackupReference = { type: 'OES_DEV_STATE_BACKUP', path: backupPath, sha256: sha256(bytes), fingerprint: backup.backupFingerprint }
    }
    const value = planStateLayoutMigration(inventory, { devStackId: options['dev-stack-id'], providerSnapshots, providerPools, devBackupReference })
    if (options.output) writeAtomic(path.resolve(options.output), value)
    emit(value)
    return
  }
  if (subcommand === 'state-stage') {
    const plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), 'utf8'))
    const inventory = JSON.parse(fs.readFileSync(path.resolve(options.inventory), 'utf8'))
    emit(await stageStateLayoutMigration(plan, inventory))
    return
  }
  if (subcommand === 'state-activate') {
    const confirmation = JSON.parse(fs.readFileSync(path.resolve(options.confirmation), 'utf8'))
    emit(activateStagedState({ journalPath: path.resolve(options.journal), confirmation }))
    return
  }
  if (subcommand === 'state-recover') {
    emit(recoverStateLayout({ journalPath: path.resolve(options.journal) }))
    return
  }
  if (subcommand === 'state-rollback') {
    const confirmation = JSON.parse(fs.readFileSync(path.resolve(options.confirmation), 'utf8'))
    emit(rollbackCommittedState({ journalPath: path.resolve(options.journal), confirmation }))
    return
  }
  if (subcommand === 'operator-status') {
    const observations = JSON.parse(fs.readFileSync(path.resolve(options.observations), 'utf8'))
    const references = JSON.parse(fs.readFileSync(path.resolve(options.authority), 'utf8'))
    const authority = reopenOperatorAuthority(references)
    const output = path.resolve(options.output)
    const status = writeOperatorStatus(output, observations, authority)
    emit({ ...status, reconciliationPlan: planOperatorReconciliation(observations, authority), output })
    return
  }
  if (subcommand === 'dev-backup') {
    const manifestPath = path.resolve(options.manifest || '')
    emit(backupDevelopmentState(manifestPath, { outputDirectory: options.output }))
    return
  }
  if (subcommand === 'dev-restore') {
    const manifestPath = path.resolve(options.manifest || '')
    const record = JSON.parse(fs.readFileSync(path.resolve(options.backup || ''), 'utf8'))
    const confirmation = JSON.parse(fs.readFileSync(path.resolve(options.confirmation || ''), 'utf8'))
    emit(restoreDevelopmentState(manifestPath, record, confirmation))
    return
  }
  if (subcommand === 'legacy-inventory') {
    const value = inventoryLegacyResources({ bindingsPath: options.bindings })
    if (options.output) writeLegacyArtifact(options.output, value)
    emit(value)
    return
  }
  if (subcommand === 'legacy-plan') {
    const inventory = JSON.parse(fs.readFileSync(path.resolve(options.inventory), 'utf8'))
    const value = planLegacyCleanup(inventory, { ownerTaskId: options['owner-task-id'] })
    if (options.output) writeLegacyArtifact(options.output, value)
    emit(value)
    return
  }
  if (subcommand === 'legacy-backup') {
    const inventory = JSON.parse(fs.readFileSync(path.resolve(options.inventory), 'utf8'))
    const value = backupValidDevData({ inventory, outputDirectory: path.resolve(options.output) })
    writeLegacyArtifact(path.join(path.resolve(options.output), 'backup-record.json'), value)
    emit(value)
    return
  }
  if (subcommand === 'legacy-apply') {
    const planPath = path.resolve(options.plan)
    const confirmationPath = path.resolve(options.confirmation)
    const collaborationBindingPath = process.env.OES_LEGACY_CLEANUP_CURRENT_BINDING
    if (!collaborationBindingPath || !path.isAbsolute(collaborationBindingPath)) throw new Error('LEGACY_CLEANUP_CURRENT_BINDING_REQUIRED')
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    const confirmation = JSON.parse(fs.readFileSync(confirmationPath, 'utf8'))
    const value = applyLegacyCleanup({ plan, planPath, confirmation, confirmationPath, collaborationBindingPath })
    if (options.output) writeLegacyArtifact(options.output, value)
    emit(value)
    return
  }
  if (subcommand === 'legacy-residue') {
    const plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), 'utf8'))
    const inventory = inventoryLegacyResources({ bindingsPath: options.bindings })
    const value = observeLegacyResidue(plan, inventory)
    if (options.output) writeLegacyArtifact(options.output, value)
    emit(value)
    return
  }
  emit({
    launcher: 'OES local runtime v2',
    commands: ['dev', 'plan', 'start', 'run', 'migrate', 'foundation-seed', 'fixture', 'status', 'reconcile', 'dev-backup', 'dev-restore', 'state-inventory', 'state-plan', 'state-stage', 'state-activate', 'state-recover', 'state-rollback', 'operator-status', 'legacy-inventory', 'legacy-plan', 'legacy-backup', 'legacy-apply', 'legacy-residue'],
    identity: 'Pass --task-key and optionally --run-id; worktree paths never derive ownership.',
    examples: [
      'node scripts/local-runtime/launcher.mjs plan --profile LOCAL_INTEGRATION --test-class integration --owner asset-service --capabilities object-store',
      'node scripts/local-runtime/launcher.mjs run --profile CI --test-class integration --owner permission-service --task-key ci_job --migrate -- pnpm --filter permission-service test:integration'
    ]
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.stack || error.message || error}\n`); process.exitCode = 1 })
