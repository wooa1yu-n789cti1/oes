import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'
import { assertNoSymlink, stackPaths } from './state-layout.mjs'

/** Serializes immutable Stack generation allocation across launcher processes. */
function withStackPublicationLock(stackRoot, callback) {
  const lock = path.join(path.dirname(path.dirname(stackRoot)), 'locks', `stack-manifest-${path.basename(stackRoot)}.lock`)
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 30000
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); writeAtomic(path.join(lock, 'owner.json'), { pid: process.pid }); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try { const owner = readJson(path.join(lock, 'owner.json')); process.kill(owner.pid, 0) } catch { fs.rmSync(lock, { recursive: true, force: true }); continue }
      if (Date.now() >= deadline) throw new Error(`STACK_MANIFEST_LOCK_TIMEOUT path=${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return callback() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

/** Returns the canonical Run directory below its owning Stack. */
export function runDirectory(stateRoot, stackKey, taskKey, runId) { return stackPaths(stateRoot, stackKey, taskKey, runId).runRoot }

/** Creates a value-free byte/semantic reference to one sealed JSON artifact. */
export function artifactReference(file, value, type) {
  const absolute = path.resolve(file)
  return { type, ...(type === 'OES_RUNTIME_STACK_MANIFEST' ? { generation: value.generation } : {}), path: absolute, sha256: sha256(fs.readFileSync(absolute)), fingerprint: value.manifestFingerprint || value.stackManifestFingerprint || value.leaseFingerprint || value.recordFingerprint || fingerprint(value) }
}

/** Publishes one immutable Stack generation and atomically advances its reference-only pointer. */
export function publishStackManifest(stackRoot, draft) {
  return withStackPublicationLock(stackRoot, () => {
    const canonicalStackRoot = path.resolve(stackRoot)
    const stateRoot = path.dirname(path.dirname(canonicalStackRoot))
    assertNoSymlink(stateRoot, canonicalStackRoot)
    if (path.basename(canonicalStackRoot) !== draft.stackKey) throw new Error('STACK_MANIFEST_DIRECTORY_MISMATCH')
    if (draft.lifecycle !== 'REGISTERED') throw new Error(`STACK_MANIFEST_NOT_READY lifecycle=${draft.lifecycle}`)
    for (const resource of draft.resources || []) if (resource.scope !== 'SHARED') throw new Error(`STACK_MANIFEST_SCOPE_INVALID scope=${resource.scope}`)
    for (const endpoint of draft.endpoints || []) if (!endpoint.ready || !endpoint.authority) throw new Error(`STACK_MANIFEST_ENDPOINT_UNREADY provider=${endpoint.provider}`)
    const manifestsRoot = path.join(stackRoot, 'manifests')
    fs.mkdirSync(manifestsRoot, { recursive: true, mode: 0o700 })
    const generations = fs.readdirSync(manifestsRoot).map((name) => name.match(/^(\d+)\.json$/u)?.[1]).filter(Boolean).map(Number)
    const generation = String((generations.length ? Math.max(...generations) : 0) + 1).padStart(12, '0')
    const raw = { ...draft, schemaVersion: 3, kind: 'OES_RUNTIME_STACK_MANIFEST', generation }
    const manifest = { ...raw, stackManifestFingerprint: fingerprint(raw) }
    const file = path.join(manifestsRoot, `${generation}.json`)
    if (fs.existsSync(file)) throw new Error(`STACK_MANIFEST_GENERATION_EXISTS generation=${generation}`)
    writeAtomic(file, manifest)
    const reference = artifactReference(file, manifest, 'OES_RUNTIME_STACK_MANIFEST')
    const pointerRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_MANIFEST_POINTER', generation, ...reference }
    writeAtomic(path.join(stackRoot, 'current-manifest.json'), { ...pointerRaw, pointerFingerprint: fingerprint(pointerRaw) })
    return { file, manifest, reference }
  })
}

/** Reopens the exact Stack generation referenced by a Run or current pointer. */
export function reopenStackManifest(reference, expected = {}) {
  if (!reference || reference.type !== 'OES_RUNTIME_STACK_MANIFEST' || !/^\d{12}$/u.test(reference.generation || '') || !path.isAbsolute(reference.path) || path.basename(reference.path) !== `${reference.generation}.json`) throw new Error('STACK_MANIFEST_REFERENCE_INVALID')
  const bytes = fs.readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) throw new Error(`STACK_MANIFEST_REFERENCE_SHA_MISMATCH path=${reference.path}`)
  const value = JSON.parse(bytes.toString('utf8'))
  if (value.schemaVersion !== 3 || value.kind !== 'OES_RUNTIME_STACK_MANIFEST' || value.generation !== reference.generation || value.stackManifestFingerprint !== reference.fingerprint || value.stackManifestFingerprint !== fingerprint(value, 'stackManifestFingerprint')) throw new Error(`STACK_MANIFEST_FINGERPRINT_MISMATCH path=${reference.path}`)
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) throw new Error(`STACK_MANIFEST_IDENTITY_MISMATCH key=${key}`)
  return value
}

/** Reopens the current reference-only Stack pointer and its exact manifest. */
export function reopenCurrentStackManifest(stackRoot) {
  const pointerPath = path.join(stackRoot, 'current-manifest.json')
  const pointer = readJson(pointerPath)
  if (pointer.schemaVersion !== 3 || pointer.kind !== 'OES_RUNTIME_STACK_MANIFEST_POINTER' || pointer.pointerFingerprint !== fingerprint(pointer, 'pointerFingerprint')) throw new Error(`STACK_POINTER_FINGERPRINT_MISMATCH path=${pointerPath}`)
  const expectedManifestPath = path.join(path.resolve(stackRoot), 'manifests', `${pointer.generation}.json`)
  if (path.resolve(pointer.path) !== expectedManifestPath) throw new Error(`STACK_POINTER_PATH_MISMATCH path=${pointer.path}`)
  const manifest = reopenStackManifest(pointer, { stackKey: path.basename(stackRoot), generation: pointer.generation })
  return { pointer, manifest }
}

/** Seals and atomically publishes a Run manifest only after provider readiness. */
export function publishManifest(directory, draft) {
  if (draft.lifecycle !== 'REGISTERED') throw new Error(`MANIFEST_NOT_READY lifecycle=${draft.lifecycle}`)
  const expectedDirectory = runDirectory(draft.stateRoot, draft.stackKey, draft.taskKey, draft.runId)
  if (path.resolve(directory) !== expectedDirectory || path.resolve(draft.runDirectory) !== expectedDirectory) throw new Error('RUN_MANIFEST_DIRECTORY_MISMATCH')
  if (!draft.stackManifestReference) throw new Error('RUN_STACK_MANIFEST_REFERENCE_REQUIRED')
  const expectedStackManifestRoot = path.join(path.resolve(draft.stackRoot), 'manifests')
  if (!path.resolve(draft.stackManifestReference.path).startsWith(`${expectedStackManifestRoot}${path.sep}`)) throw new Error('RUN_STACK_MANIFEST_PATH_MISMATCH')
  reopenStackManifest(draft.stackManifestReference, { stackKey: draft.stackKey, devStackId: draft.devStackId })
  for (const endpoint of draft.endpoints || []) {
    if (!endpoint.ready) throw new Error(`MANIFEST_ENDPOINT_UNREADY provider=${endpoint.provider}`)
    if (endpoint.source === 'STACK' && endpoint.authority) throw new Error(`RUN_MANIFEST_SHARED_PAYLOAD_FORBIDDEN provider=${endpoint.provider}`)
    if (endpoint.source !== 'STACK' && !endpoint.authority) throw new Error(`MANIFEST_ENDPOINT_UNREADY provider=${endpoint.provider}`)
  }
  for (const resource of draft.resources || []) if (resource.scope === 'SHARED') throw new Error(`RUN_MANIFEST_SHARED_PAYLOAD_FORBIDDEN provider=${resource.provider}`)
  const raw = { ...draft, schemaVersion: 3, kind: 'OES_RUNTIME_RUN_MANIFEST' }
  const manifest = { ...raw, manifestFingerprint: fingerprint(raw) }
  const file = path.join(directory, 'manifest.json')
  writeAtomic(file, manifest)
  return { file, manifest, sha256: sha256(fs.readFileSync(file)) }
}

/** Reopens a Run manifest and verifies exact task/run and byte-level identity. */
export function reopenManifest(file, expected = {}) {
  const value = readJson(file)
  if (value.schemaVersion !== 3 || value.kind !== 'OES_RUNTIME_RUN_MANIFEST' || value.manifestFingerprint !== fingerprint(value, 'manifestFingerprint')) throw new Error(`MANIFEST_FINGERPRINT_MISMATCH path=${file}`)
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) throw new Error(`MANIFEST_IDENTITY_MISMATCH key=${key}`)
  const expectedFile = path.join(runDirectory(value.stateRoot, value.stackKey, value.taskKey, value.runId), 'manifest.json')
  if (path.resolve(file) !== expectedFile || path.resolve(value.runDirectory) !== path.dirname(expectedFile)) throw new Error('RUN_MANIFEST_DIRECTORY_MISMATCH')
  const expectedStackManifestRoot = path.join(path.resolve(value.stackRoot), 'manifests')
  if (!path.resolve(value.stackManifestReference.path).startsWith(`${expectedStackManifestRoot}${path.sep}`)) throw new Error('RUN_STACK_MANIFEST_PATH_MISMATCH')
  reopenStackManifest(value.stackManifestReference, { stackKey: value.stackKey, devStackId: value.devStackId })
  return value
}

/** Resolves one endpoint from Run truth plus its exact referenced Stack generation. */
export function resolveEndpoint(manifest, provider) {
  const binding = manifest.endpoints.find((endpoint) => endpoint.provider === provider)
  if (!binding) return undefined
  if (binding.source !== 'STACK') return binding
  const stack = reopenStackManifest(manifest.stackManifestReference, { stackKey: manifest.stackKey, devStackId: manifest.devStackId })
  const shared = stack.endpoints.find((endpoint) => endpoint.provider === provider && (!binding.pool || endpoint.pool === binding.pool))
  if (!shared) throw new Error(`STACK_ENDPOINT_REFERENCE_MISSING provider=${provider}`)
  return { ...shared, owners: binding.owners, credentialReference: binding.credentialReference || shared.credentialReference, source: 'STACK' }
}

/** Resolves Run-owned resources and, when requested, exact shared Stack resources without copying them. */
export function resolveResources(manifest, { includeStack = false } = {}) {
  if (!includeStack) return manifest.resources
  const stack = reopenStackManifest(manifest.stackManifestReference, { stackKey: manifest.stackKey, devStackId: manifest.devStackId })
  return [...stack.resources, ...manifest.resources]
}

/** Builds a secret-free minimal environment for exactly one owner process. */
export function environmentForOwner(manifest, owner, credentialResolver) {
  if (!manifest.owners.includes(owner)) throw new Error(`MANIFEST_OWNER_UNDECLARED owner=${owner}`)
  const output = { NODE_ENV: manifest.profile === 'DEV' ? 'development' : 'test', OES_TASK_KEY: manifest.taskKey, OES_RUN_ID: manifest.runId, OES_DEV_STACK_ID: manifest.devStackId, OES_STACK_KEY: manifest.stackKey }
  for (const binding of manifest.endpoints.filter((entry) => entry.owners.includes(owner))) {
    const endpoint = resolveEndpoint(manifest, binding.provider)
    Object.assign(output, endpoint.environment)
    if (endpoint.credentialReference) Object.assign(output, credentialResolver(endpoint.credentialReference, owner))
  }
  return output
}

/** Verifies that a manifest is below its declared Stack/Run roots without symlink substitution. */
export function assertManifestContainment(manifest) {
  const expected = runDirectory(manifest.stateRoot, manifest.stackKey, manifest.taskKey, manifest.runId)
  if (path.resolve(manifest.runDirectory) !== expected) throw new Error('RUN_MANIFEST_DIRECTORY_MISMATCH')
  assertNoSymlink(manifest.stateRoot, manifest.runDirectory)
  return true
}
