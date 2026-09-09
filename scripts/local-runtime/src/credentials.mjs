import fs from 'node:fs'
import path from 'node:path'
import { fingerprint, readJson, sha256, writeAtomic } from './canonical.mjs'

/** Writes one run credential bundle with mode 0600 and returns a value-free reference. */
export function writeCredentialBundle(runDirectory, provider, ownerEnvironments) {
  const raw = { schemaVersion: 2, provider, ownerEnvironments }
  const value = { ...raw, credentialFingerprint: fingerprint(raw) }
  const file = path.join(runDirectory, 'credentials', `${provider}.json`)
  writeAtomic(file, value, 0o600)
  return { path: file, sha256: sha256(fs.readFileSync(file)), fingerprint: value.credentialFingerprint }
}

/** Writes a launcher-private migrator bundle outside all business-process credential references. */
export function writeMigratorCredentialBundle(context, ownerEnvironments) {
  const directory = context.profile === 'DEV'
    ? path.join(context.stackRoot, 'credentials', 'launcher')
    : path.join(context.runDirectory, 'orchestration')
  const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_LAUNCHER_MIGRATOR_CREDENTIAL', provider: 'postgres', ownerEnvironments }
  const value = { ...raw, credentialFingerprint: fingerprint(raw) }
  const file = path.join(directory, 'postgres-migrators.json')
  writeAtomic(file, value, 0o600)
  return { path: file, sha256: sha256(fs.readFileSync(file)), fingerprint: value.credentialFingerprint }
}

/** Resolves launcher-only migrator authority from its deterministic private location. */
export function resolveMigratorCredential(manifest, owner) {
  const file = manifest.profile === 'DEV'
    ? path.join(manifest.stackRoot, 'credentials', 'launcher', 'postgres-migrators.json')
    : path.join(manifest.runDirectory, 'orchestration', 'postgres-migrators.json')
  const bytes = fs.readFileSync(file)
  const value = JSON.parse(bytes.toString('utf8'))
  if (value.schemaVersion !== 3 || value.kind !== 'OES_RUNTIME_LAUNCHER_MIGRATOR_CREDENTIAL' || value.provider !== 'postgres' || value.credentialFingerprint !== fingerprint(value, 'credentialFingerprint')) throw new Error(`MIGRATOR_CREDENTIAL_FINGERPRINT_MISMATCH path=${file}`)
  const environment = value.ownerEnvironments[owner]
  if (!environment?.DATABASE_URL || Object.keys(environment).some((key) => key !== 'DATABASE_URL')) throw new Error(`MIGRATOR_CREDENTIAL_OWNER_DENIED owner=${owner}`)
  return environment
}

/** Reopens one credential reference and exposes only the exact requesting owner's provider-scoped values. */
export function resolveCredentialReference(reference, owner, expectedProvider = undefined) {
  const bytes = fs.readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) throw new Error(`CREDENTIAL_REFERENCE_SHA_MISMATCH path=${reference.path}`)
  const value = readJson(reference.path)
  if (value.credentialFingerprint !== reference.fingerprint || value.credentialFingerprint !== fingerprint(value, 'credentialFingerprint')) throw new Error(`CREDENTIAL_REFERENCE_FINGERPRINT_MISMATCH path=${reference.path}`)
  if (expectedProvider && value.provider !== expectedProvider) throw new Error(`CREDENTIAL_REFERENCE_PROVIDER_MISMATCH expected=${expectedProvider}`)
  const environment = value.ownerEnvironments[owner]
  if (!environment) throw new Error(`CREDENTIAL_OWNER_DENIED owner=${owner} provider=${value.provider}`)
  return environment
}
