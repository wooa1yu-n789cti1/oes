#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  applyCommittedMigrations,
  applyFoundationSeeds,
  prepareDevelopmentArtifacts,
  reconcileMachineWorkloadSelectors
} from './src/bootstrap.mjs'
import { loadRuntimeConfig } from './src/config.mjs'
import {
  backendPreparationPath,
  fullDevelopmentOwners,
  reopenBackendPreparation,
  reopenBackendSession,
  writeBackendPreparation,
  writeBackendSession
} from './src/development-session.mjs'
import { backupDevelopmentState } from './src/development-backup.mjs'
import { findReusableDevInfrastructure } from './ensure-dev-infrastructure.mjs'
import { acquireExclusiveLease } from './src/locks.mjs'
import { reopenManifest } from './src/manifest.mjs'
import {
  cleanupDevelopmentProcessResources,
  startDevelopmentProcesses,
  stopDevelopmentProcesses
} from './src/process-runtime.mjs'

const root = path.resolve(import.meta.dirname, '../..')

/** Writes deterministic operator output for the one-shot prepare and long-running start modes. */
function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Returns the one reusable full DEV manifest created by `pnpm infra`. */
function requireInfrastructure(stateRoot, owners) {
  const reusable = findReusableDevInfrastructure({ stateRoot, owners })
  if (!reusable) throw new Error('DEV_INFRASTRUCTURE_REQUIRED run=pnpm infra')
  return reusable
}

/** Deletes only the session record published by the current backend process. */
function removeOwnedSession(session) {
  if (!session?.path || !fs.existsSync(session.path)) return
  const reopened = reopenBackendSession(path.dirname(path.dirname(session.path)))
  if (reopened?.record.recordFingerprint !== session.record.recordFingerprint)
    throw new Error('BACKEND_SESSION_RECORD_CHANGED')
  fs.rmSync(session.path)
}

/** Validates that an old session still belongs to the current DEV stack before exact cleanup. */
export function validateStaleSessionManifest(sessionRecord, sessionManifest, preparation) {
  if (
    sessionManifest.profile !== 'DEV' ||
    sessionManifest.manifestFingerprint !== sessionRecord.manifestFingerprint ||
    sessionManifest.stackKey !== preparation.manifest.stackKey ||
    sessionManifest.taskKey !== preparation.manifest.taskKey
  )
    throw new Error('BACKEND_STALE_SESSION_PREPARATION_MISMATCH')
  return sessionManifest
}

/** Cleans an exact stale session after proving that its recorded process is no longer live. */
export function reconcileStaleSession(stateRoot, preparation) {
  const observed = reopenBackendSession(stateRoot)
  if (!observed) return null
  let live = true
  try {
    process.kill(observed.record.pid, 0)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    live = false
  }
  if (live) throw new Error(`BACKEND_ALREADY_RUNNING pid=${observed.record.pid}`)
  const sessionManifest = validateStaleSessionManifest(
    observed.record,
    reopenManifest(observed.record.manifestPath),
    preparation
  )
  const cleanupResults = cleanupDevelopmentProcessResources(
    observed.record.resources || [],
    sessionManifest
  )
  fs.rmSync(observed.recordPath)
  return { status: 'STALE_BACKEND_RECONCILED', cleanupResults: cleanupResults.length }
}

/** Runs all finite code-generation, migration, seed, and selector work against persistent DEV infrastructure. */
async function prepareBackend() {
  const config = loadRuntimeConfig({ root, profile: 'DEV', explicit: {} })
  const owners = fullDevelopmentOwners(root)
  const lock = await acquireExclusiveLease(
    path.join(config.stateRoot, 'locks', 'development-backend-session.lock'),
    { kind: 'DEV_BACKEND_PREPARE' },
    { timeoutMs: 5_000 }
  )
  try {
    const infrastructure = requireInfrastructure(config.stateRoot, owners)
    fs.rmSync(backendPreparationPath(config.stateRoot), { force: true })
    process.stdout.write('[local-runtime] stage=DEVELOPMENT_BACKUP\n')
    const backup = backupDevelopmentState(infrastructure.manifestPath)
    const backupRecordPath = path.join(
      infrastructure.manifest.stackRoot,
      'evidence',
      'backups',
      `pre-migration-${infrastructure.manifest.runId}`,
      'backup-record.json'
    )
    if (!fs.existsSync(backupRecordPath)) throw new Error('BACKEND_PREPARATION_BACKUP_REQUIRED')
    const artifacts = prepareDevelopmentArtifacts(infrastructure.manifestPath, { root })
    const migrations = applyCommittedMigrations(infrastructure.manifestPath, { root })
    const seeds = applyFoundationSeeds(infrastructure.manifestPath, { root })
    const selectors = reconcileMachineWorkloadSelectors(infrastructure.manifestPath, { root })
    if (!selectors?.path) throw new Error('BACKEND_PREPARATION_SELECTORS_REQUIRED')
    const preparation = writeBackendPreparation({
      root,
      stateRoot: config.stateRoot,
      manifestPath: infrastructure.manifestPath,
      selectorPath: selectors.path
    })
    emit({
      status: 'BACKEND_PREPARED',
      manifestPath: infrastructure.manifestPath,
      preparationPath: preparation.path,
      inputFingerprint: preparation.record.inputFingerprint,
      backupRecordPath,
      backupFingerprint: backup.backupFingerprint,
      artifactSteps: artifacts.length,
      migrationSteps: migrations.length,
      seedSteps: seeds.length,
      selectorCount: selectors.selectorCount
    })
  } finally {
    lock.release()
  }
}

/** Starts only host backend processes from a sealed preparation and leaves infrastructure registered on exit. */
async function startBackend() {
  const config = loadRuntimeConfig({ root, profile: 'DEV', explicit: {} })
  const lock = await acquireExclusiveLease(
    path.join(config.stateRoot, 'locks', 'development-backend-session.lock'),
    { kind: 'DEV_BACKEND_START' },
    { timeoutMs: 5_000 }
  )
  const controller = new AbortController()
  const interrupt = () => {
    if (!controller.signal.aborted) controller.abort(new Error('DEVELOPMENT_INTERRUPTED'))
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let processes
  let session
  let primaryError
  try {
    const preparation = reopenBackendPreparation({ root, stateRoot: config.stateRoot })
    reconcileStaleSession(config.stateRoot, preparation)
    process.stdout.write('[local-runtime] stage=HOST_PROCESSES_START\n')
    processes = await startDevelopmentProcesses(preparation.record.manifestPath, {
      root,
      selectorPath: preparation.record.selectorReference.path,
      signal: controller.signal,
      publishProcessManifest: false
    })
    const endpoints = [...processes.processEndpoints, ...processes.issuerEndpoints]
    session = writeBackendSession({
      stateRoot: config.stateRoot,
      preparation,
      pid: process.pid,
      endpoints,
      resources: processes.resources
    })
    const gateway = processes.processEndpoints.find(
      (endpoint) => endpoint.host === 'api-gateway.localhost'
    )
    if (!gateway) throw new Error('BACKEND_GATEWAY_ENDPOINT_REQUIRED')
    emit({
      status: 'BACKEND_READY',
      manifestPath: preparation.record.manifestPath,
      sessionPath: session.path,
      gateway: `http://127.0.0.1:${gateway.port}/api/v1`,
      owners: preparation.manifest.owners
    })
    if (!controller.signal.aborted) {
      const interrupted = new Promise((resolve) =>
        controller.signal.addEventListener('abort', resolve, { once: true })
      )
      if (processes.liveness) await Promise.race([interrupted, processes.liveness])
      else await interrupted
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      primaryError = error
      throw error
    }
  } finally {
    processes?.stopLiveness?.()
    let cleanupError
    if (processes) {
      try {
        await stopDevelopmentProcesses(processes.children)
        cleanupDevelopmentProcessResources(processes.resources, processes.manifest)
      } catch (error) {
        cleanupError = error
      }
    }
    if (!cleanupError) removeOwnedSession(session)
    lock.release()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (cleanupError) {
      if (primaryError)
        throw new AggregateError(
          [primaryError, cleanupError],
          'BACKEND_EXECUTION_AND_CLEANUP_FAILED'
        )
      throw cleanupError
    }
  }
  emit({ status: 'BACKEND_STOPPED', reason: 'operator-interrupt' })
}

/** Dispatches the explicit one-shot prepare or long-running backend-only mode. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['prepare', 'start'].includes(argv[0]))
    throw new Error('DEV_BACKEND_SESSION_USAGE expected=prepare|start')
  if (argv[0] === 'prepare') return prepareBackend()
  return startBackend()
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || error}\n`)
    process.exitCode = 1
  }
}
