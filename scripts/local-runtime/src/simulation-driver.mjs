import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, sha256, writeAtomic } from './canonical.mjs'
import { writeCredentialBundle } from './credentials.mjs'

let nextPort = 31000

/** Provisions deterministic filesystem-backed providers for orchestration fault tests. */
export async function provisionSimulatedProvider(provider, context) {
  const shared = context.profile === 'DEV' || (context.profile === 'LOCAL_INTEGRATION' && ['postgres', 'minio'].includes(provider))
  const resourceRoot = shared ? path.join(context.stackRoot, 'providers', context.pool, provider, 'simulation') : path.join(context.runDirectory, 'provider', provider, 'simulation')
  fs.mkdirSync(resourceRoot, { recursive: true, mode: 0o700 })
  const objectId = sha256(`${resourceRoot}:${provider}`).padEnd(64, '0').slice(0, 64)
  const runScope = context.profile === 'CI' ? 'CI' : 'RUN'
  const physical = { provider, kind: 'simulated-provider', scope: shared ? 'SHARED' : runScope, name: `${context.pool}-${provider}`, objectId, path: resourceRoot, cleanup: shared ? 'PRESERVE_SHARED' : 'DELETE_EXACT' }
  const allocations = []
  const ownerEnvironments = {}
  const providerOwners = context.providerOwners?.[provider] || context.owners
  for (const owner of providerOwners) {
    const persistent = context.profile === 'DEV'
    const suffix = sha256(`${persistent ? context.devStackId : `${context.taskKey}:${context.runId}`}:${owner}:${provider}`).slice(0, 12)
    const allocationPath = path.join(resourceRoot, `${suffix}.json`)
    writeAtomic(allocationPath, { provider, owner, taskKey: context.taskKey, runId: context.runId })
    allocations.push({ provider, kind: 'simulated-logical', scope: persistent ? 'SHARED' : runScope, owner, objectId: sha256(allocationPath), path: allocationPath, cleanup: persistent ? 'PRESERVE_SHARED' : 'DELETE_EXACT' })
    ownerEnvironments[owner] = { [`OES_${provider.toUpperCase().replaceAll('-', '_')}_CREDENTIAL`]: `secret-${suffix}` }
  }
  const reference = writeCredentialBundle(context.profile === 'DEV' ? context.stackRoot : context.runDirectory, provider, ownerEnvironments)
  const port = nextPort++
  return { resources: [physical, ...allocations], endpoints: [{ provider, authority: `simulation:${objectId}`, host: '127.0.0.1', port, ready: true, owners: providerOwners, environment: { [`OES_${provider.toUpperCase().replaceAll('-', '_')}_ENDPOINT`]: `http://127.0.0.1:${port}` }, credentialReference: reference }] }
}

/** Removes only exact run-owned simulator resources and preserves shared roots. */
export function cleanupSimulatedResource(resource) {
  if (resource.cleanup === 'PRESERVE_SHARED') return { resource, disposition: 'PRESERVED_SHARED', exitStatus: 0 }
  if (!resource.path || !fs.existsSync(resource.path)) return { resource, disposition: 'ALREADY_ABSENT', exitStatus: 0 }
  if (resource.kind === 'simulated-logical') {
    const bytes = fs.readFileSync(resource.path)
    if (sha256(resource.path) !== resource.objectId || fingerprint(JSON.parse(bytes)) === '') return { resource, disposition: 'PRESERVED_IDENTITY_MISMATCH', exitStatus: 1 }
    fs.rmSync(resource.path)
  } else fs.rmSync(resource.path, { recursive: true, force: true })
  return { resource, disposition: 'DELETED_EXACT', exitStatus: 0 }
}
