import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'
import { reopenManifest } from './manifest.mjs'
import { reopenStackLease, stackLeasePath } from './stack-lease.mjs'

const PREPARATION_INPUT_DIRECTORIES = [
  'scripts/local/runtime-config',
  'src/common/src',
  'src/services/system/collaboration-service/scripts',
  'src/services/system/permission-service/src/scripts'
]
const PREPARATION_INPUT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
  'scripts/local-runtime/relationships.json',
  'scripts/local-runtime/src/bootstrap.mjs',
  'scripts/local/machine-workload-inventory.mjs',
  'src/common/package.json',
  'src/common/tsconfig.json'
]
const IGNORED_INPUT_DIRECTORIES = new Set(['.git', '.turbo', 'dist', 'node_modules'])

/** Returns the fixed preparation record path for the local development backend. */
export function backendPreparationPath(stateRoot) {
  return path.join(stateRoot, 'development', 'backend-preparation.json')
}

/** Returns the fixed live backend session record path consumed by the Web launcher. */
export function backendSessionPath(stateRoot) {
  return path.join(stateRoot, 'development', 'backend-session.json')
}

/** Returns every process owner in the repository's canonical full development order. */
export function fullDevelopmentOwners(root) {
  return Object.keys(
    JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8'))
      .owners
  )
}

/** Finds one service package without accepting ambiguous workspace locations. */
function servicePackage(root, owner) {
  const matches = ['src/services/system', 'src/services/business', 'src/services']
    .map((base) => path.join(root, base, owner, 'package.json'))
    .filter((candidate) => fs.existsSync(candidate))
  const unique = [...new Set(matches)]
  if (unique.length !== 1) throw new Error(`DEVELOPMENT_SERVICE_PACKAGE_AMBIGUOUS owner=${owner}`)
  return unique[0]
}

/** Adds a stable file inventory while excluding generated build and dependency directories. */
function collectFiles(target, files) {
  if (!fs.existsSync(target)) return
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) throw new Error(`DEVELOPMENT_PREPARATION_INPUT_SYMLINK path=${target}`)
  if (stat.isFile()) {
    files.add(path.resolve(target))
    return
  }
  if (!stat.isDirectory()) return
  for (const name of fs.readdirSync(target).sort()) {
    if (IGNORED_INPUT_DIRECTORIES.has(name)) continue
    collectFiles(path.join(target, name), files)
  }
}

/** Hashes every source/configuration byte whose change requires backend preparation to run again. */
export function developmentPreparationInput(root, owners) {
  const files = new Set()
  for (const relative of PREPARATION_INPUT_FILES) collectFiles(path.join(root, relative), files)
  for (const relative of PREPARATION_INPUT_DIRECTORIES)
    collectFiles(path.join(root, relative), files)
  for (const owner of owners) {
    const packageFile = servicePackage(root, owner)
    collectFiles(packageFile, files)
    collectFiles(path.join(path.dirname(packageFile), 'prisma', 'schema.prisma'), files)
    collectFiles(path.join(path.dirname(packageFile), 'prisma', 'migrations'), files)
  }
  const hash = crypto.createHash('sha256')
  const relativeFiles = [...files]
    .map((file) => path.relative(root, file))
    .sort((left, right) => left.localeCompare(right))
  for (const relative of relativeFiles)
    hash
      .update(relative)
      .update('\0')
      .update(fs.readFileSync(path.join(root, relative)))
      .update('\0')
  return { fingerprint: hash.digest('hex'), files: relativeFiles }
}

/** Publishes one sealed preparation record bound to the exact infrastructure manifest and inputs. */
export function writeBackendPreparation({ root, stateRoot, manifestPath, selectorPath }) {
  const manifest = reopenManifest(manifestPath)
  const input = developmentPreparationInput(root, manifest.owners)
  const selectorBytes = fs.readFileSync(selectorPath)
  const raw = {
    schemaVersion: 1,
    kind: 'OES_DEV_BACKEND_PREPARATION',
    manifestPath: path.resolve(manifestPath),
    manifestFingerprint: manifest.manifestFingerprint,
    stackKey: manifest.stackKey,
    taskKey: manifest.taskKey,
    runId: manifest.runId,
    owners: manifest.owners,
    inputFingerprint: input.fingerprint,
    inputFileCount: input.files.length,
    selectorReference: { path: path.resolve(selectorPath), sha256: sha256(selectorBytes) },
    preparedAt: new Date().toISOString()
  }
  const record = { ...raw, recordFingerprint: fingerprint(raw) }
  const output = backendPreparationPath(stateRoot)
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  writeAtomic(output, record)
  return { path: output, record }
}

/** Reopens preparation only when its manifest, lease, selectors, and source inputs remain exact. */
export function reopenBackendPreparation({ root, stateRoot }) {
  const recordPath = backendPreparationPath(stateRoot)
  if (!fs.existsSync(recordPath))
    throw new Error('BACKEND_PREPARATION_REQUIRED run=pnpm backend:prepare')
  const record = readJson(recordPath)
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'OES_DEV_BACKEND_PREPARATION' ||
    record.recordFingerprint !== fingerprint(record, 'recordFingerprint')
  )
    throw new Error(`BACKEND_PREPARATION_RECORD_INVALID path=${recordPath}`)
  const manifest = reopenManifest(record.manifestPath)
  if (
    manifest.profile !== 'DEV' ||
    manifest.manifestFingerprint !== record.manifestFingerprint ||
    manifest.stackKey !== record.stackKey ||
    manifest.taskKey !== record.taskKey ||
    manifest.runId !== record.runId ||
    manifest.endpoints.some((endpoint) => endpoint.source !== 'STACK') ||
    fs.existsSync(path.join(manifest.runDirectory, 'cleanup.json'))
  )
    throw new Error(
      'BACKEND_PREPARATION_INFRASTRUCTURE_STALE run=pnpm infra && pnpm backend:prepare'
    )
  reopenStackLease(stackLeasePath(manifest.stackRoot, manifest.taskKey, manifest.runId), {
    stackRoot: manifest.stackRoot,
    stackKey: manifest.stackKey,
    devStackId: manifest.devStackId,
    taskKey: manifest.taskKey,
    runId: manifest.runId
  })
  const currentInput = developmentPreparationInput(root, manifest.owners)
  if (currentInput.fingerprint !== record.inputFingerprint)
    throw new Error('BACKEND_PREPARATION_INPUTS_STALE run=pnpm backend:prepare')
  if (
    !path.isAbsolute(record.selectorReference?.path) ||
    !fs.existsSync(record.selectorReference.path) ||
    sha256(fs.readFileSync(record.selectorReference.path)) !== record.selectorReference.sha256
  )
    throw new Error('BACKEND_PREPARATION_SELECTORS_STALE run=pnpm backend:prepare')
  return { recordPath, record, manifest }
}

/** Seals a live backend session record without copying credentials from its preparation manifest. */
export function writeBackendSession({ stateRoot, preparation, pid, endpoints, resources }) {
  const raw = {
    schemaVersion: 1,
    kind: 'OES_DEV_BACKEND_SESSION',
    pid,
    preparationRecordFingerprint: preparation.record.recordFingerprint,
    manifestPath: preparation.record.manifestPath,
    manifestFingerprint: preparation.record.manifestFingerprint,
    endpoints,
    resources,
    startedAt: new Date().toISOString()
  }
  const record = { ...raw, recordFingerprint: fingerprint(raw) }
  const output = backendSessionPath(stateRoot)
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  writeAtomic(output, record)
  return { path: output, record }
}

/** Reopens the optional live-session record and rejects every unsealed value. */
export function reopenBackendSession(stateRoot) {
  const recordPath = backendSessionPath(stateRoot)
  if (!fs.existsSync(recordPath)) return null
  const record = readJson(recordPath)
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'OES_DEV_BACKEND_SESSION' ||
    record.recordFingerprint !== fingerprint(record, 'recordFingerprint')
  )
    throw new Error(`BACKEND_SESSION_RECORD_INVALID path=${recordPath}`)
  return { recordPath, record }
}
