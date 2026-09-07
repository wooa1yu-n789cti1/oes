import fs from 'node:fs'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'
import { reopenManifest, reopenStackManifest } from './manifest.mjs'

const REQUIRED = ['oes.runtime.version', 'oes.runtime.stack-key', 'oes.runtime.dev-stack-id', 'oes.runtime.scope', 'oes.runtime.pool', 'oes.runtime.provider']

/** Returns the stable exact object identity used for manifest/observation joins. */
function objectIdentity(value) { return value.objectId || value.Id || value.id }

/** Reopens reference-only manifest inputs before using them as lifecycle authority. */
export function reopenOperatorAuthority({ stackReferences = [], runManifestPaths = [], leasePaths = [] }) {
  const stacks = stackReferences.map((reference) => reopenStackManifest(reference))
  const runs = runManifestPaths.map((file) => reopenManifest(file))
  const leases = leasePaths.filter((file) => fs.existsSync(file)).map((file) => {
    const bytes = fs.readFileSync(file)
    const value = readJson(file)
    if (value.kind !== 'OES_RUNTIME_STACK_LEASE' || value.leaseFingerprint !== fingerprint(value, 'leaseFingerprint')) throw new Error(`OPERATOR_LEASE_INVALID path=${file}`)
    return { ...value, path: file, sha256: sha256(bytes) }
  })
  return { stacks, runs, leases }
}

/** Classifies one Docker observation only through exact manifest, label, and lease joins. */
export function classifyRuntimeObject(observed, authority) {
  const labels = observed.labels || observed.Labels || observed.Config?.Labels || {}
  const objectId = objectIdentity(observed)
  if (labels['com.docker.compose.project'] || (labels['oes.runtime.version'] && labels['oes.runtime.version'] !== '2')) return { status: 'LEGACY', objectId, reason: 'LEGACY_LABEL_EVIDENCE' }
  if (!objectId) return { status: 'UNKNOWN', objectId, reason: 'INCOMPLETE_V2_IDENTITY' }
  if (!labels['oes.runtime.stack-key'] && REQUIRED.filter((key) => key !== 'oes.runtime.stack-key').every((key) => labels[key]) && labels['oes.runtime.scope'] === 'SHARED') {
    const matches = authority.stacks.flatMap((stack) => stack.resources.filter((resource) => resource.objectId === objectId && resource.scope === 'SHARED' && resource.labelCompatibility === 'PRE_STACK_KEY_V2_EXACT' && resource.provider === labels['oes.runtime.provider'] && (resource.pool || resource.labels?.['oes.runtime.pool']) === labels['oes.runtime.pool'] && stack.devStackId === labels['oes.runtime.dev-stack-id']).map((resource) => ({ stack, resource })))
    if (matches.length === 1) return { status: 'SHARED', objectId, stackKey: matches[0].stack.stackKey, provider: matches[0].resource.provider, manifestFingerprint: matches[0].stack.stackManifestFingerprint, activeLeaseCount: authority.leases.filter((lease) => lease.stackKey === matches[0].stack.stackKey).length, labelCompatibility: 'PRE_STACK_KEY_V2_EXACT' }
  }
  if (REQUIRED.some((key) => !labels[key])) return { status: 'UNKNOWN', objectId, reason: 'INCOMPLETE_V2_IDENTITY' }
  const scope = labels['oes.runtime.scope']
  const stackKey = labels['oes.runtime.stack-key']
  const devStackId = labels['oes.runtime.dev-stack-id']
  const provider = labels['oes.runtime.provider']
  if (scope === 'SHARED') {
    const stack = authority.stacks.find((candidate) => candidate.stackKey === stackKey && candidate.devStackId === devStackId)
    const resource = stack?.resources.find((candidate) => candidate.objectId === objectId && candidate.provider === provider && candidate.scope === 'SHARED' && (candidate.pool || candidate.labels?.['oes.runtime.pool'] || labels['oes.runtime.pool']) === labels['oes.runtime.pool'])
    return resource ? { status: 'SHARED', objectId, stackKey, provider, manifestFingerprint: stack.stackManifestFingerprint, activeLeaseCount: authority.leases.filter((lease) => lease.stackKey === stackKey && lease.devStackId === devStackId).length } : { status: 'UNKNOWN', objectId, reason: 'SHARED_MANIFEST_JOIN_MISSING' }
  }
  if (!['RUN', 'CI'].includes(scope)) return { status: 'UNKNOWN', objectId, reason: 'SCOPE_INVALID' }
  const taskKey = labels['oes.runtime.task-key']
  const runId = labels['oes.runtime.run-id']
  if (!taskKey || !runId) return { status: 'UNKNOWN', objectId, reason: 'RUN_LABEL_IDENTITY_MISSING' }
  const run = authority.runs.find((candidate) => candidate.stackKey === stackKey && candidate.devStackId === devStackId && candidate.taskKey === taskKey && candidate.runId === runId)
  const resource = run?.resources.find((candidate) => candidate.objectId === objectId && candidate.provider === provider && candidate.scope === scope)
  const lease = authority.leases.find((candidate) => candidate.stackKey === stackKey && candidate.taskKey === taskKey && candidate.runId === runId)
  if (!run || !resource) return { status: 'UNKNOWN', objectId, reason: 'RUN_MANIFEST_JOIN_MISSING' }
  if (scope === 'CI' && (!labels['oes.runtime.ci-job-fingerprint'] || labels['oes.runtime.ci-job-fingerprint'] !== run.jobFingerprint)) return { status: 'UNKNOWN', objectId, reason: 'CI_IDENTITY_JOIN_MISSING' }
  return { status: scope, objectId, stackKey, taskKey, runId, provider, manifestFingerprint: run.manifestFingerprint, leaseStatus: lease ? 'ACTIVE' : 'ABSENT' }
}

/** Produces fail-closed reconciliation decisions without broad name or label deletion. */
export function planOperatorReconciliation(observations, authority) {
  return observations.map((observed) => {
    const classification = classifyRuntimeObject(observed, authority)
    const eligible = ['RUN', 'CI'].includes(classification.status) && classification.leaseStatus === 'ABSENT'
    return { ...classification, action: eligible ? 'RECONCILE_EXACT_MANIFEST_RESOURCE' : 'PRESERVE', reason: eligible ? 'EXACT_TERMINAL_RUN_WITHOUT_LEASE' : classification.reason || classification.leaseStatus || classification.status }
  })
}

/** Applies only exact, preplanned terminal Run/CI reconciliation actions through an injected launcher adapter. */
export function applyOperatorReconciliation(plan, observations, reconcileExact) {
  const byId = new Map(observations.map((item) => [objectIdentity(item), item]))
  const results = []
  for (const decision of plan) {
    if (decision.action !== 'RECONCILE_EXACT_MANIFEST_RESOURCE') { results.push({ ...decision, disposition: 'PRESERVED' }); continue }
    const observed = byId.get(decision.objectId)
    if (!observed) throw new Error(`OPERATOR_OBJECT_OBSERVATION_MISSING objectId=${decision.objectId}`)
    results.push({ ...decision, ...reconcileExact(observed, decision) })
  }
  return results
}

/** Writes one secret-free operator projection as evidence, never as ownership authority. */
export function writeOperatorStatus(file, observations, authority) {
  const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_OPERATOR_STATUS', classifications: observations.map((item) => classifyRuntimeObject(item, authority)) }
  const value = { ...raw, recordFingerprint: fingerprint(raw) }
  writeAtomic(file, value)
  return value
}
