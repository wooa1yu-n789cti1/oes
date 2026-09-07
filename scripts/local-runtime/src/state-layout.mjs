import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'
import { withExclusiveLock } from './locks.mjs'

const PATH_KEY = /^[a-z0-9][a-z0-9_-]{1,79}$/u
const LOWER_HEX_64 = /^[a-f0-9]{64}$/u
const MACHINE_DOMAIN = 'oes-runtime-v2-machine'
const CI_DOMAIN = 'oes-runtime-v2-ci-job'

/** Validates a versioned path key before it can select a state directory. */
export function exactPathKey(value, name = 'key') {
  if (!PATH_KEY.test(value || '') || value === '.' || value === '..') throw new Error(`STATE_PATH_KEY_INVALID key=${name}`)
  return value
}

/** Calculates the frozen byte-level identity digest for one lowercase-hex seed. */
export function identityDigest(domain, seed) {
  if (!LOWER_HEX_64.test(seed || '')) throw new Error('STATE_IDENTITY_SEED_INVALID')
  return sha256(Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0]), Buffer.from('v1', 'utf8'), Buffer.from([0]), Buffer.from(seed, 'hex')]))
}

/** Derives a versioned host binding without hostname, user, repository, task, or run metadata. */
export function stableHostBinding(explicit) {
  if (explicit) return { kind: explicit.kind || 'fixture-v1', value: String(explicit.value || '') }
  if (process.platform === 'darwin') {
    const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/u)
    if (match) return { kind: 'darwin-ioplatformuuid-v1', value: match[1].toLowerCase() }
  }
  if (process.platform === 'linux' && fs.existsSync('/etc/machine-id')) return { kind: 'linux-machine-id-v1', value: fs.readFileSync('/etc/machine-id', 'utf8').trim().toLowerCase() }
  throw new Error('STATE_HOST_BINDING_UNAVAILABLE')
}

/** Hashes the stable host binding with an explicit versioned domain. */
export function hostBindingHash(binding) {
  if (!binding?.kind || !binding?.value) throw new Error('STATE_HOST_BINDING_INVALID')
  return sha256(Buffer.concat([Buffer.from('oes-runtime-v2-host-binding', 'utf8'), Buffer.from([0]), Buffer.from('v1', 'utf8'), Buffer.from([0]), Buffer.from(binding.kind, 'utf8'), Buffer.from([0]), Buffer.from(binding.value, 'utf8')]))
}

/** Rejects symlink substitution for an existing state root or any existing descendant. */
export function assertNoSymlink(root, target = root) {
  const base = path.resolve(root)
  const selected = path.resolve(target)
  if (selected !== base && !selected.startsWith(`${base}${path.sep}`)) throw new Error(`STATE_PATH_ESCAPE path=${selected}`)
  if (!fs.existsSync(base)) return selected
  if (fs.lstatSync(base).isSymbolicLink()) throw new Error(`STATE_SYMLINK_FORBIDDEN path=${base}`)
  let cursor = base
  const relative = path.relative(base, selected)
  for (const component of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, component)
    if (!fs.existsSync(cursor)) break
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`STATE_SYMLINK_FORBIDDEN path=${cursor}`)
  }
  return selected
}

/** Fails closed when the pre-hierarchy flat layout is still the configured authority. */
export function assertCanonicalLayoutAdmission(stateRoot) {
  const legacy = ['machine/dev-stack.json', 'shared', 'leases', 'semaphore'].filter((relative) => fs.existsSync(path.join(stateRoot, relative)))
  if (legacy.length) throw new Error(`STATE_LAYOUT_MIGRATION_REQUIRED entries=${legacy.join(',')}`)
}

/** Returns all canonical Stack and Run paths for one accountable identity pair. */
export function stackPaths(stateRoot, stackKey, taskKey, runId) {
  exactPathKey(stackKey, 'stackKey')
  exactPathKey(taskKey, 'taskKey')
  exactPathKey(runId, 'runId')
  const stackRoot = assertNoSymlink(stateRoot, path.join(stateRoot, 'stacks', stackKey))
  return {
    stateRoot: path.resolve(stateRoot),
    stackRoot,
    runRoot: assertNoSymlink(stateRoot, path.join(stackRoot, 'runs', taskKey, runId)),
    leasesRoot: path.join(stackRoot, 'leases'),
    manifestsRoot: path.join(stackRoot, 'manifests'),
    evidenceRoot: path.join(stackRoot, 'evidence')
  }
}

/** Creates and reopens the canonical machine/Stack identity before any provider mutation. */
export async function resolveRuntimeLayout({ stateRoot, profile, taskKey, runId, explicitDevStackId, identitySeed, ciSeed, hostBinding, ciJobIdentity }) {
  const root = path.resolve(stateRoot)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  assertNoSymlink(root)
  assertCanonicalLayoutAdmission(root)
  exactPathKey(taskKey, 'taskKey')
  exactPathKey(runId, 'runId')
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true, mode: 0o700 })
  return withExclusiveLock(path.join(root, 'locks', 'state-layout.lock'), async () => {
    writeOrVerifySchema(root)
    if (profile === 'CI') return resolveCiLayout({ root, taskKey, runId, seed: ciSeed, ciJobIdentity })
    return resolveMachineLayout({ root, taskKey, runId, explicitDevStackId, seed: identitySeed, hostBinding })
  })
}

/** Publishes or verifies the global state schema marker. */
function writeOrVerifySchema(root) {
  const file = path.join(root, 'schema-version.json')
  if (!fs.existsSync(file)) writeAtomic(file, { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_SCHEMA', layout: 'MACHINE_STACK_RUN', pathKeyVersion: 1 })
  const value = readJson(file)
  if (value.schemaVersion !== 3 || value.kind !== 'OES_RUNTIME_STATE_SCHEMA' || value.layout !== 'MACHINE_STACK_RUN') throw new Error('STATE_SCHEMA_MISMATCH')
  for (const directory of ['semaphores', 'stacks']) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 })
}

/** Resolves the one machine-local Stack and its one-to-one registry entry. */
function resolveMachineLayout({ root, taskKey, runId, explicitDevStackId, seed, hostBinding }) {
  const identityPath = path.join(root, 'machine-identity.json')
  const binding = stableHostBinding(hostBinding)
  const bindingHash = hostBindingHash(binding)
  if (!fs.existsSync(identityPath)) {
    const machineSeed = seed || crypto.randomBytes(32).toString('hex')
    const fullDigest = identityDigest(MACHINE_DOMAIN, machineSeed)
    writeAtomic(identityPath, { schemaVersion: 3, kind: 'OES_RUNTIME_MACHINE_IDENTITY', seedEncoding: 'lowercase-hex', seed: machineSeed, fullDigest, machineFingerprint: fullDigest.slice(0, 16), hostBindingKind: binding.kind, hostBindingHash: bindingHash }, 0o600)
  }
  const identity = readJson(identityPath)
  const recomputed = identityDigest(MACHINE_DOMAIN, identity.seed)
  if (identity.schemaVersion !== 3 || identity.kind !== 'OES_RUNTIME_MACHINE_IDENTITY' || identity.seedEncoding !== 'lowercase-hex' || identity.fullDigest !== recomputed || identity.machineFingerprint !== recomputed.slice(0, 16)) throw new Error('STATE_MACHINE_IDENTITY_MISMATCH')
  if (identity.hostBindingKind !== binding.kind || identity.hostBindingHash !== bindingHash) throw new Error('STATE_HOST_BINDING_MISMATCH')
  const stackKey = exactPathKey(`oes-local-${identity.machineFingerprint}`, 'stackKey')
  const devStackId = exactPathKey(explicitDevStackId || `machine_${identity.fullDigest.slice(0, 24)}`, 'devStackId')
  const registryPath = path.join(root, 'stack-registry.json')
  if (!fs.existsSync(registryPath)) writeAtomic(registryPath, { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_REGISTRY', machineDigest: identity.fullDigest, stacks: [{ stackKey, devStackId }] })
  const registry = readJson(registryPath)
  const keys = registry.stacks?.map((entry) => entry.stackKey) || []
  const ids = registry.stacks?.map((entry) => entry.devStackId) || []
  if (registry.schemaVersion !== 3 || registry.kind !== 'OES_RUNTIME_STACK_REGISTRY' || registry.machineDigest !== identity.fullDigest || new Set(keys).size !== keys.length || new Set(ids).size !== ids.length || registry.stacks.length !== 1 || registry.stacks[0].stackKey !== stackKey || registry.stacks[0].devStackId !== devStackId) throw new Error('STATE_STACK_REGISTRY_MISMATCH')
  return initializeStack({ root, stackKey, devStackId, taskKey, runId, identityKind: 'LOCAL', identityFingerprint: identity.machineFingerprint, identityDigest: identity.fullDigest })
}

/** Resolves a job-private CI identity without writing the developer-machine registry. */
function resolveCiLayout({ root, taskKey, runId, seed, ciJobIdentity }) {
  const identityPath = path.join(root, 'ci-job-identity.json')
  if (!fs.existsSync(identityPath)) {
    const jobSeed = seed || crypto.randomBytes(32).toString('hex')
    const fullDigest = identityDigest(CI_DOMAIN, jobSeed)
    const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_CI_JOB_IDENTITY', seedEncoding: 'lowercase-hex', seed: jobSeed, fullDigest, jobFingerprint: fullDigest.slice(0, 16), jobIdentity: String(ciJobIdentity || process.env.GITHUB_RUN_ID || process.env.CI_JOB_ID || 'job-private') }
    writeAtomic(identityPath, { ...raw, identityFingerprint: fingerprint(raw) }, 0o600)
  }
  const identity = readJson(identityPath)
  const recomputed = identityDigest(CI_DOMAIN, identity.seed)
  if (identity.schemaVersion !== 3 || identity.kind !== 'OES_RUNTIME_CI_JOB_IDENTITY' || identity.fullDigest !== recomputed || identity.jobFingerprint !== recomputed.slice(0, 16) || identity.identityFingerprint !== fingerprint(identity, 'identityFingerprint')) throw new Error('STATE_CI_IDENTITY_MISMATCH')
  const stackKey = exactPathKey(`oes-ci-${identity.jobFingerprint}`, 'stackKey')
  const devStackId = exactPathKey(`ci_${identity.fullDigest.slice(0, 24)}`, 'devStackId')
  return initializeStack({ root, stackKey, devStackId, taskKey, runId, identityKind: 'CI', identityFingerprint: identity.jobFingerprint, identityDigest: identity.fullDigest, jobIdentity: identity.jobIdentity })
}

/** Initializes one Stack descriptor plus only its canonical child directories. */
function initializeStack({ root, stackKey, devStackId, taskKey, runId, identityKind, identityFingerprint, identityDigest, jobIdentity }) {
  const paths = stackPaths(root, stackKey, taskKey, runId)
  fs.mkdirSync(paths.stackRoot, { recursive: true, mode: 0o700 })
  assertNoSymlink(root, paths.stackRoot)
  const stackPath = path.join(paths.stackRoot, 'stack.json')
  const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK', stackKey, devStackId, identityKind, identityFingerprint, identityDigest, ...(jobIdentity ? { jobIdentity } : {}) }
  if (!fs.existsSync(stackPath)) writeAtomic(stackPath, { ...raw, stackFingerprint: fingerprint(raw) })
  const stack = readJson(stackPath)
  if (stack.stackFingerprint !== fingerprint(stack, 'stackFingerprint') || fingerprint(stack, 'stackFingerprint') !== fingerprint({ ...raw, stackFingerprint: fingerprint(raw) }, 'stackFingerprint')) throw new Error('STATE_STACK_DESCRIPTOR_MISMATCH')
  for (const directory of ['providers/dev', 'providers/test', 'credentials', 'leases', 'manifests', 'restore', 'evidence', 'runs']) fs.mkdirSync(path.join(paths.stackRoot, directory), { recursive: true, mode: 0o700 })
  return { ...paths, stackKey, devStackId, identityKind, machineFingerprint: identityKind === 'LOCAL' ? identityFingerprint : undefined, jobFingerprint: identityKind === 'CI' ? identityFingerprint : undefined, jobIdentity }
}

/** Returns a stable fixture host binding for isolated tests without reading host metadata. */
export function fixtureHostBinding(value = os.platform()) { return { kind: 'fixture-v1', value } }
