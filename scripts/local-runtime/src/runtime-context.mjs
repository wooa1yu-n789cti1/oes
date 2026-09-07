import path from 'node:path'
import { resolveCredentialReference } from './credentials.mjs'
import { environmentForOwner, reopenManifest, resolveResources } from './manifest.mjs'

/** Normalizes one explicit task identity without deriving it from a worktree. */
export function normalizeTaskKey(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/gu, '_').slice(0, 80)
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/u.test(normalized)) throw new Error('RUNTIME_TASK_KEY_INVALID')
  return normalized
}

/** Loads one exact owner's environment from an explicitly injected manifest path. */
export function loadRuntimeOwnerContext(owner, environment = process.env) {
  const manifestPath = environment.OES_RUNTIME_MANIFEST?.trim()
  if (!manifestPath || !path.isAbsolute(manifestPath)) throw new Error('RUNTIME_MANIFEST_REQUIRED')
  const manifest = reopenManifest(manifestPath)
  const ownerEnvironment = environmentForOwner(manifest, owner, resolveCredentialReference)
  const databaseUrl = ownerEnvironment.DATABASE_URL
  const database = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) : null
  const allocations = database ? resolveResources(manifest, { includeStack: true }).filter((resource) => resource.kind === 'database' && resource.database === database) : []
  if (database && allocations.length !== 1) throw new Error(`RUNTIME_DATABASE_ALLOCATION_NOT_EXACT owner=${owner}`)
  return { manifest, manifestPath, taskKey: normalizeTaskKey(manifest.taskKey), environment: ownerEnvironment, databaseUrl, databaseAllocation: allocations[0] || null }
}
