import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, readJson, sha256 } from './canonical.mjs'
import { assertNoSymlink, exactPathKey } from './state-layout.mjs'

/** Encodes one task/run identity pair into an injective canonical lease filename. */
export function stackLeaseFileName(taskKey, runId) {
  exactPathKey(taskKey, 'taskKey')
  exactPathKey(runId, 'runId')
  return `${taskKey.length}-${taskKey}--${runId.length}-${runId}.json`
}

/** Returns the canonical Stack lease file for one exact task/run identity pair. */
export function stackLeasePath(stackRoot, taskKey, runId) {
  const root = path.resolve(stackRoot)
  exactPathKey(path.basename(root), 'stackKey')
  return path.join(root, 'leases', stackLeaseFileName(taskKey, runId))
}

/** Reopens one Stack lease only when its bytes, identities, and canonical path all agree. */
export function reopenStackLease(file, expected) {
  if (!expected?.stackRoot) throw new Error('STACK_LEASE_EXPECTED_ROOT_REQUIRED')
  const stackRoot = path.resolve(expected.stackRoot)
  const absolute = path.resolve(file)
  assertNoSymlink(stackRoot, absolute)
  const value = readJson(absolute)
  if (value.schemaVersion !== 3 || value.kind !== 'OES_RUNTIME_STACK_LEASE' || value.leaseFingerprint !== fingerprint(value, 'leaseFingerprint')) throw new Error(`STACK_LEASE_FINGERPRINT_MISMATCH path=${absolute}`)
  exactPathKey(value.stackKey, 'stackKey')
  exactPathKey(value.devStackId, 'devStackId')
  exactPathKey(value.taskKey, 'taskKey')
  exactPathKey(value.runId, 'runId')
  const expectedPath = stackLeasePath(stackRoot, value.taskKey, value.runId)
  if (absolute !== expectedPath) throw new Error(`STACK_LEASE_PATH_MISMATCH path=${absolute}`)
  if (value.stackKey !== path.basename(stackRoot)) throw new Error(`STACK_LEASE_IDENTITY_MISMATCH key=stackKey`)
  for (const key of ['stackKey', 'devStackId', 'taskKey', 'runId']) {
    if (expected[key] !== undefined && value[key] !== expected[key]) throw new Error(`STACK_LEASE_IDENTITY_MISMATCH key=${key}`)
  }
  return { ...value, path: absolute, sha256: sha256(fs.readFileSync(absolute)) }
}

/** Enumerates the complete exact lease authority for one Stack and rejects unknown entries. */
export function reopenStackLeases(stackRoot, expected = {}) {
  const root = path.resolve(stackRoot)
  const leasesRoot = path.join(root, 'leases')
  if (!fs.existsSync(leasesRoot)) return []
  assertNoSymlink(root, leasesRoot)
  return fs.readdirSync(leasesRoot).sort().map((name) => {
    if (!name.endsWith('.json')) throw new Error(`STACK_LEASE_ENTRY_INVALID path=${path.join(leasesRoot, name)}`)
    return reopenStackLease(path.join(leasesRoot, name), { ...expected, stackRoot: root })
  })
}

/** Removes one exact lease only after reopening its complete semantic identity. */
export function removeStackLease(file, expected) {
  const lease = reopenStackLease(file, expected)
  fs.unlinkSync(lease.path)
  return lease
}
