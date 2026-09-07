import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCommittedMigrations } from '../../local-runtime/src/bootstrap.mjs'
import { resolveCredentialReference } from '../../local-runtime/src/credentials.mjs'
import { environmentForOwner, resolveEndpoint } from '../../local-runtime/src/manifest.mjs'
import { withRuntime } from '../../local-runtime/src/orchestrator.mjs'

/** Resolves test ownership only from an explicit CI binding or the runner-created fallback. */
export function resolveIntegrationTaskKey(_root, explicit, fallback) {
  const value = explicit || fallback
  const normalized = String(value).replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 80)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/u.test(normalized)) throw new Error('INTEGRATION_TASK_KEY_INVALID')
  return normalized
}

/** Selects explicit provider capabilities from the immutable owner relationship. */
export function integrationCapabilities(ownerNames) {
  const values = new Set()
  if (ownerNames.some((owner) => ['collaboration-service', 'notification-service', 'site-service'].includes(owner))) values.add('events')
  if (ownerNames.includes('asset-service')) values.add('object-store')
  if (ownerNames.some((owner) => ['collaboration-service', 'notification-service', 'api-gateway'].includes(owner))) values.add('network-trust')
  return [...values].sort()
}

/** Restricts infrastructure allocation to owners declared by the unified host-service runtime. */
export function selectDeclaredRuntimeOwners(ownerNames, declarations) {
  const declared = new Set(Object.keys(declarations.owners || {}))
  const selected = new Set(ownerNames.filter((owner) => declared.has(owner)))
  if (selected.has('notification-service') && declared.has('collaboration-service')) selected.add('collaboration-service')
  return [...selected].sort()
}

/** Builds one service's minimal Integration environment from the ready manifest. */
export function integrationEnvironmentForOwner(manifest, ownerName, resolver = resolveCredentialReference) {
  const environment = environmentForOwner(manifest, ownerName, resolver)
  if (ownerName === 'notification-service') {
    const nats = resolveEndpoint(manifest, 'nats')
    if (nats?.credentialReference) {
      const publisher = resolver(nats.credentialReference, 'collaboration-service')
      environment.NATS_COLLABORATION_USER = publisher.NATS_COLLABORATION_USER
      environment.NATS_COLLABORATION_PASSWORD = publisher.NATS_COLLABORATION_PASSWORD
    }
  }
  if (environment.DATABASE_URL) {
    environment.OES_INTEGRATION_DATABASE_URL = environment.DATABASE_URL
    environment[`${ownerName.replace(/-service$/u, '').replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()}_DATABASE_URL`] = environment.DATABASE_URL
  }
  if (ownerName === 'collaboration-service') {
    environment.EVENT_BUS_LIVE = 'true'
    environment.COLLABORATION_OUTBOX_INTERVAL_MS = '300000'
  }
  if (ownerName === 'notification-service') environment.NOTIFICATION_EVENT_LIVE_TEST = 'true'
  environment.NOTIFICATION_DELIVERY_PAYLOAD_KEY = crypto.createHash('sha256').update(`oes-integration:${manifest.taskKey}:${manifest.runId}:${ownerName}`).digest('base64')
  return environment
}

/** Runs selected Integration groups through the unified orchestration core and always reconciles. */
export async function withIntegrationRuntime({ root, ownerNames, runTests, taskKey, adapters = {} }) {
  const declarations = adapters.declarations || JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8'))
  const runtimeOwners = selectDeclaredRuntimeOwners(ownerNames, declarations)
  const runtimeOwnerSet = new Set(runtimeOwners)
  if (runtimeOwners.length === 0) return runTests(() => ({}))
  const profile = adapters.profile || (process.env.GITHUB_ACTIONS === 'true' ? 'CI' : 'LOCAL_INTEGRATION')
  const runId = adapters.runId || `run_${crypto.randomUUID().replaceAll('-', '')}`
  const stateRoot = adapters.stateRoot || (profile === 'CI' ? path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'oes-runtime-v2') : undefined)
  const executeWithRuntime = adapters.withRuntime || withRuntime
  const migrate = adapters.applyCommittedMigrations || applyCommittedMigrations
  return executeWithRuntime({
    root,
    profile,
    testClass: 'integration',
    owners: runtimeOwners,
    capabilities: integrationCapabilities(runtimeOwners),
    taskKey: resolveIntegrationTaskKey(root, taskKey, `test_${process.pid}`),
    runId,
    stateRoot,
    driver: adapters.driver || 'docker',
    concurrency: adapters.concurrency
  }, async (manifest, manifestPath) => {
    migrate(manifestPath, { root })
    return runTests((ownerName) => runtimeOwnerSet.has(ownerName) ? integrationEnvironmentForOwner(manifest, ownerName, adapters.resolveCredentialReference || resolveCredentialReference) : {})
  }, adapters.orchestration || {})
}
