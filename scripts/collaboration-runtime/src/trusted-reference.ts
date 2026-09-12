import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { assertPathWithin, objectFingerprint, sha256 } from './canonical.ts'
import { fail } from './errors.ts'
import type { TrustedAuthorizationReference } from './types.ts'

const DIGEST = /^[0-9a-f]{64}$/

/** Reopens one immutable artifact reference inside an issuer-controlled authorization root. */
export function verifyTrustedReference(
  reference: TrustedAuthorizationReference,
  authorizationRoot: string,
  fingerprintField: string
): Record<string, unknown> {
  if (
    !reference ||
    typeof reference !== 'object' ||
    Array.isArray(reference) ||
    Object.keys(reference).sort().join(',') !== 'fingerprint,path,sha256'
  )
    fail('AUTHORIZATION_REFERENCE_FIELDS_INVALID', 'authorizationReference')
  if (!isAbsolute(reference.path)) fail('AUTHORIZATION_PATH_NOT_ABSOLUTE', reference.path)
  assertPathWithin(authorizationRoot, reference.path)
  assertPathWithin(realpathSync(authorizationRoot), realpathSync(reference.path))
  if (!DIGEST.test(reference.sha256)) fail('INVALID_BINDING_FINGERPRINT', 'authorization.sha256')
  if (!DIGEST.test(reference.fingerprint))
    fail('INVALID_BINDING_FINGERPRINT', 'authorization.fingerprint')
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) fail('AUTHORIZATION_SHA_MISMATCH', reference.path)
  const record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  if (record[fingerprintField] !== reference.fingerprint)
    fail('AUTHORIZATION_FINGERPRINT_MISMATCH', reference.path)
  if (objectFingerprint(record, fingerprintField) !== reference.fingerprint)
    fail('AUTHORIZATION_CANONICAL_FINGERPRINT_MISMATCH', reference.path)
  return record
}
