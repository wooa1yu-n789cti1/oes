import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fingerprint, sha256, writeAtomic } from './canonical.mjs'
import { reopenManifest, resolveResources } from './manifest.mjs'
import { RUNTIME_DOCKER_IMAGES } from './docker-driver.mjs'
import { runChecked } from './process.mjs'

/** Runs a binary-producing command without coercing its payload through UTF-8. */
function runBuffer(command, args, { input, timeout = 600000 } = {}) {
  const result = spawnSync(command, args, { input, timeout, maxBuffer: 1024 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const error = new Error(`COMMAND_FAILED command=${command} exit=${result.status}`)
    error.status = result.status
    error.stderr = result.stderr?.toString('utf8')
    throw error
  }
  return result.stdout
}

/** Verifies a shared DEV allocation still points at the exact live container. */
function assertAllocationContainer(resource) {
  if (resource.scope !== 'SHARED' || resource.containerScope !== 'SHARED') throw new Error(`DEV_BACKUP_ALLOCATION_SCOPE_INVALID kind=${resource.kind}`)
  const observed = JSON.parse(runChecked('docker', ['inspect', '--type', 'container', resource.containerName], { timeout: 20000 }).stdout)[0]
  if (observed.Id !== resource.containerObjectId || !observed.State.Running) throw new Error(`DEV_BACKUP_CONTAINER_IDENTITY_MISMATCH kind=${resource.kind}`)
  return observed
}

/** Reopens one sealed provider credential reference without returning it in evidence. */
function readCredential(reference) {
  const bytes = fs.readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) throw new Error('DEV_BACKUP_CREDENTIAL_REFERENCE_MISMATCH')
  return JSON.parse(bytes.toString('utf8'))
}

/** Snapshots every selected shared DEV database and bucket before migration or fixture writes. */
export function backupDevelopmentState(manifestPath, { outputDirectory } = {}) {
  const manifest = reopenManifest(manifestPath)
  if (manifest.profile !== 'DEV') throw new Error('DEV_BACKUP_PROFILE_REQUIRED')
  const output = path.resolve(outputDirectory || path.join(manifest.stackRoot, 'evidence', 'backups', `pre-migration-${manifest.runId}`))
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  const backups = []
  const stackResources = resolveResources(manifest, { includeStack: true })
  for (const resource of stackResources.filter((item) => item.kind === 'database')) {
    assertAllocationContainer(resource)
    const bootstrap = readCredential(resource.rootCredentialReference)
    const file = path.join(output, `${resource.database}.dump`)
    const bytes = runBuffer('docker', ['exec', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'pg_dump', '-U', bootstrap.rootUser, '--format=custom', resource.database])
    if (!bytes.length) throw new Error(`DEV_BACKUP_EMPTY database=${resource.database}`)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    backups.push({ kind: 'database', database: resource.database, containerName: resource.containerName, containerObjectId: resource.containerObjectId, file, sha256: sha256(bytes), restoreCommand: ['docker', 'exec', '-i', resource.containerName, 'pg_restore', '-U', bootstrap.rootUser, '--clean', '--if-exists', '--dbname', resource.database] })
  }
  for (const resource of stackResources.filter((item) => item.kind === 'bucket')) {
    assertAllocationContainer(resource)
    const admin = readCredential(resource.adminCredentialReference)
    const temporary = path.join(output, `.${resource.bucket}.mirror`)
    const file = path.join(output, `${resource.bucket}.tar.gz`)
    if (fs.existsSync(temporary)) throw new Error(`DEV_BACKUP_TEMPORARY_EXISTS bucket=${resource.bucket}`)
    fs.mkdirSync(temporary, { mode: 0o700 })
    try {
      runChecked('docker', ['run', '--rm', '--network', `container:${resource.containerName}`, '--user', `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`, '--env', `MINIO_ROOT_USER=${admin.rootUser}`, '--env', `MINIO_ROOT_PASSWORD=${admin.rootPassword}`, '--env', 'HOME=/tmp', '--tmpfs', '/tmp', '--volume', `${temporary}:/backup`, '--entrypoint', 'sh', RUNTIME_DOCKER_IMAGES.minioClient, '-ec', `mkdir -p /backup/data; mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror local/${resource.bucket} /backup/data >/dev/null`], { timeout: 600000 })
      runChecked('tar', ['-C', temporary, '-czf', file, 'data'], { timeout: 600000 })
      fs.chmodSync(file, 0o600)
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
    backups.push({ kind: 'bucket', bucket: resource.bucket, containerName: resource.containerName, containerObjectId: resource.containerObjectId, file, sha256: sha256(fs.readFileSync(file)), restoreCommand: ['mc', 'mirror', '--overwrite', '/backup/data', `local/${resource.bucket}`] })
  }
  const raw = { schemaVersion: 3, kind: 'OES_DEV_STATE_BACKUP', manifestFingerprint: manifest.manifestFingerprint, stackKey: manifest.stackKey, devStackId: manifest.devStackId, taskKey: manifest.taskKey, runId: manifest.runId, sourcesPreserved: true, backups }
  const record = { ...raw, backupFingerprint: fingerprint(raw) }
  writeAtomic(path.join(output, 'backup-record.json'), record)
  return record
}

/** Restores a sealed DEV snapshot only after a separate exact confirmation and target reopen. */
export function restoreDevelopmentState(manifestPath, record, confirmation) {
  if (record.backupFingerprint !== fingerprint(record, 'backupFingerprint')) throw new Error('DEV_BACKUP_FINGERPRINT_MISMATCH')
  if (confirmation.kind !== 'OES_DEV_RESTORE_CONFIRMATION' || confirmation.status !== 'CONFIRMED' || confirmation.backupFingerprint !== record.backupFingerprint || confirmation.confirmationFingerprint !== fingerprint(confirmation, 'confirmationFingerprint')) throw new Error('DEV_RESTORE_CONFIRMATION_INVALID')
  const manifest = reopenManifest(manifestPath)
  if (manifest.profile !== 'DEV' || manifest.devStackId !== record.devStackId) throw new Error('DEV_RESTORE_TARGET_MISMATCH')
  const resources = new Map(resolveResources(manifest, { includeStack: true }).filter((resource) => ['database', 'bucket'].includes(resource.kind)).map((resource) => [`${resource.kind}:${resource.database || resource.bucket}`, resource]))
  const results = []
  for (const backup of record.backups) {
    const bytes = fs.readFileSync(backup.file)
    if (sha256(bytes) !== backup.sha256) throw new Error(`DEV_RESTORE_ARCHIVE_MISMATCH kind=${backup.kind}`)
    const key = `${backup.kind}:${backup.database || backup.bucket}`
    const resource = resources.get(key)
    if (!resource || resource.containerObjectId !== backup.containerObjectId || resource.containerName !== backup.containerName) throw new Error(`DEV_RESTORE_ALLOCATION_MISMATCH key=${key}`)
    assertAllocationContainer(resource)
    if (backup.kind === 'database') {
      const bootstrap = readCredential(resource.rootCredentialReference)
      runBuffer('docker', ['exec', '-i', '-e', `PGPASSWORD=${bootstrap.rootPassword}`, resource.containerName, 'pg_restore', '-U', bootstrap.rootUser, '--clean', '--if-exists', '--dbname', resource.database], { input: bytes })
    } else {
      const admin = readCredential(resource.adminCredentialReference)
      const temporary = `${backup.file}.restore-${process.pid}`
      fs.mkdirSync(temporary, { mode: 0o700 })
      try {
        runChecked('tar', ['-C', temporary, '-xzf', backup.file], { timeout: 600000 })
        runChecked('docker', ['run', '--rm', '--network', `container:${resource.containerName}`, '--env', `MINIO_ROOT_USER=${admin.rootUser}`, '--env', `MINIO_ROOT_PASSWORD=${admin.rootPassword}`, '--volume', `${temporary}:/backup:ro`, '--entrypoint', 'sh', RUNTIME_DOCKER_IMAGES.minioClient, '-ec', `mc alias set -- local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc mirror --overwrite /backup/data local/${resource.bucket} >/dev/null`], { timeout: 600000 })
      } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
    }
    results.push({ key, disposition: 'RESTORED_EXACT', exitStatus: 0 })
  }
  const raw = { schemaVersion: 3, kind: 'OES_DEV_STATE_RESTORE_RESULT', backupFingerprint: record.backupFingerprint, manifestFingerprint: manifest.manifestFingerprint, results }
  return { ...raw, resultFingerprint: fingerprint(raw) }
}
