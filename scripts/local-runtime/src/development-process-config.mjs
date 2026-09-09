import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from './canonical.mjs'
import { assertNoSymlink } from './state-layout.mjs'

export const DEVELOPMENT_PROCESS_CONFIG_SCHEMA_VERSION = 1

const COMMON_REQUIREMENTS = Object.freeze([
  'NODE_ENV', 'OES_TASK_KEY', 'OES_RUN_ID', 'OES_DEV_STACK_ID', 'OES_STACK_KEY',
  'MODULE_NAME', 'GRPC_LISTEN_HOST', 'GRPC_LISTEN_PORT', 'SERVICE_REGISTRY_IP',
  'SERVICE_REGISTRY_PORT', 'AUTH_EXECUTION_ISSUER', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS'
])

const CAPABILITY_REQUIREMENTS = Object.freeze({
  database: ['DATABASE_URL'],
  'object-store': ['ASSET_S3_ENDPOINT', 'ASSET_S3_ACCESS_KEY_ID', 'ASSET_S3_SECRET_ACCESS_KEY', 'ASSET_S3_BUCKET', 'ASSET_S3_FORCE_PATH_STYLE'],
  cache: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD', 'OES_REDIS_NAMESPACE', 'TERMINAL_DEVICE_UNAVAILABLE_REDIS_CHANNEL'],
  events: ['NATS_URL', 'NATS_USER', 'NATS_PASSWORD'],
  'network-trust': ['OES_GRPC_TLS_ENABLED', 'OES_GRPC_TLS_MIN_VERSION', 'OES_GRPC_TLS_CA_PATH', 'OES_GRPC_TLS_CERT_PATH', 'OES_GRPC_TLS_KEY_PATH', 'OES_WORKLOAD_SPIFFE_ID']
})

const OWNER_REQUIREMENTS = Object.freeze({
  'api-gateway': ['GATEWAY_TERMINAL_DEVICE_PEER_SPIFFE_ID', 'GATEWAY_MACHINE_PRINCIPAL_ID', 'GATEWAY_MACHINE_WORKLOAD_BINDING_ID', 'GATEWAY_MACHINE_WORKLOAD_BINDING_VERSION'],
  'asset-service': ['ASSET_MEDIA_LIFECYCLE_INTERVAL_MS', 'ASSET_MEDIA_OUTBOX_INTERVAL_MS'],
  'auth-service': ['AUTH_EXECUTION_KMS_KEY_REF', 'AUTH_EXECUTION_SIGNER_SOCKET_PATH', 'AUTH_EXECUTION_WORKLOAD_POLICIES', 'AUTH_PERMISSION_WORKLOAD_ISSUANCE_POLICY_VERSION', 'AUTH_FOUNDATION_MACHINE_PRINCIPAL_ID', 'AUTH_FOUNDATION_MACHINE_WORKLOAD_BINDING_ID', 'AUTH_FOUNDATION_MACHINE_WORKLOAD_BINDING_VERSION', 'AUTH_NOTIFICATION_MACHINE_PRINCIPAL_ID', 'AUTH_NOTIFICATION_MACHINE_WORKLOAD_BINDING_ID', 'AUTH_NOTIFICATION_MACHINE_WORKLOAD_BINDING_VERSION'],
  'browser-activity-service': [],
  'collaboration-service': ['COLLABORATION_OUTBOX_INTERVAL_MS'],
  'crm-service': ['CRM_PARTY_MACHINE_PRINCIPAL_ID', 'CRM_PARTY_MACHINE_WORKLOAD_BINDING_ID', 'CRM_PARTY_MACHINE_WORKLOAD_BINDING_VERSION'],
  'finance-service': [],
  'hr-service': ['HR_PARTY_MACHINE_PRINCIPAL_ID', 'HR_PARTY_MACHINE_WORKLOAD_BINDING_ID', 'HR_PARTY_MACHINE_WORKLOAD_BINDING_VERSION'],
  'identity-service': ['IDENTITY_PARTY_MACHINE_PRINCIPAL_ID', 'IDENTITY_PARTY_MACHINE_WORKLOAD_BINDING_ID', 'IDENTITY_PARTY_MACHINE_WORKLOAD_BINDING_VERSION'],
  'item-master-service': [],
  'mes-service': [],
  'notification-service': ['AUTH_NOTIFICATION_AUTH_SPIFFE_ID', 'NOTIFICATION_DELIVERY_PAYLOAD_KEY'],
  'party-service': [],
  'permission-service': ['PERMISSION_AUTH_SERVICE_SPIFFE_ID', 'PERMISSION_WORKLOAD_ISSUANCE_POLICIES'],
  'procurement-service': [],
  'public-entry-service': ['PUBLIC_ENTRY_FOUNDATION_MACHINE_PRINCIPAL_ID', 'PUBLIC_ENTRY_FOUNDATION_MACHINE_WORKLOAD_BINDING_ID', 'PUBLIC_ENTRY_FOUNDATION_MACHINE_WORKLOAD_BINDING_VERSION'],
  'sales-service': [],
  'site-service': ['SITE_PREVIEW_TOKEN_SECRET'],
  'srm-service': ['SRM_PARTY_MACHINE_PRINCIPAL_ID', 'SRM_PARTY_MACHINE_WORKLOAD_BINDING_ID', 'SRM_PARTY_MACHINE_WORKLOAD_BINDING_VERSION'],
  'tenant-org-service': ['TENANT_ORG_GATEWAY_SPIFFE_ID', 'TENANT_ORG_AUTH_SPIFFE_ID', 'TENANT_ORG_PUBLIC_ENTRY_SPIFFE_ID', 'TENANT_ORG_PARTY_MACHINE_PRINCIPAL_ID', 'TENANT_ORG_PARTY_MACHINE_WORKLOAD_BINDING_ID', 'TENANT_ORG_PARTY_MACHINE_WORKLOAD_BINDING_VERSION'],
  'terminal-device-service': ['GATEWAY_TERMINAL_DEVICE_SPIFFE_ID'],
  'wms-service': []
})

const NON_SECRET_DEFAULTS = Object.freeze({
  'asset-service': Object.freeze({ ASSET_MEDIA_LIFECYCLE_INTERVAL_MS: '5000', ASSET_MEDIA_OUTBOX_INTERVAL_MS: '5000' }),
  'collaboration-service': Object.freeze({ COLLABORATION_OUTBOX_INTERVAL_MS: '5000' })
})

const GENERATED_SECRETS = Object.freeze({
  'notification-service': Object.freeze({ NOTIFICATION_DELIVERY_PAYLOAD_KEY: Object.freeze({ filename: 'notification-delivery-payload.key', minimumLength: 1 }) }),
  'site-service': Object.freeze({ SITE_PREVIEW_TOKEN_SECRET: Object.freeze({ filename: 'site-preview-token.key', minimumLength: 32 }) })
})

const SENSITIVE_KEY = /(PASSWORD|SECRET|TOKEN|DATABASE_URL|PRIVATE_KEY|ACCESS_KEY_ID|KMS_KEY_REF)$/u
const INTEGER_KEY = /(?:_PORT|_INTERVAL_MS)$/u

/** Classifies one required key by its owning projection boundary without inspecting its value. */
function configurationSource(owner, key, declarations) {
  if (Object.hasOwn(NON_SECRET_DEFAULTS[owner] || {}, key)) return 'DEV_DEFAULT'
  if (Object.hasOwn(GENERATED_SECRETS[owner] || {}, key)) return 'DEV_GENERATED_SECRET'
  for (const capability of declarations.owners[owner].capabilities || []) if ((CAPABILITY_REQUIREMENTS[capability] || []).includes(key)) return `PROVIDER_${capability.toUpperCase().replaceAll('-', '_')}`
  if (COMMON_REQUIREMENTS.includes(key)) return 'LAUNCHER_COMMON'
  if (/(?:_SERVICE_(?:HOST|PORT|GRPC_URL)|_GRPC_URL)$|^GRPC_SERVICE_/u.test(key)) return 'OWNER_ENDPOINT'
  return 'TRUSTED_OWNER'
}

/** Returns every versioned owner in the DEV process configuration contract. */
export function developmentProcessConfigurationOwners() {
  return Object.keys(OWNER_REQUIREMENTS).sort()
}

/** Creates or reopens one owner-scoped DEV secret below the Stack credential root. */
function reopenDevelopmentSecret(manifest, owner, key, specification) {
  if (manifest.profile !== 'DEV') throw new Error(`DEVELOPMENT_PROCESS_CONFIG_PROFILE_REQUIRED owner=${owner}`)
  if (!path.isAbsolute(manifest.stackRoot || '')) throw new Error(`DEVELOPMENT_PROCESS_CONFIG_STACK_ROOT_INVALID owner=${owner}`)
  const file = path.join(manifest.stackRoot, 'credentials', 'process-runtime', specification.filename)
  assertNoSymlink(manifest.stackRoot, file)
  if (!fs.existsSync(file)) writeAtomic(file, crypto.randomBytes(32).toString('base64url'), 0o600)
  assertNoSymlink(manifest.stackRoot, file)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`DEVELOPMENT_PROCESS_SECRET_FILE_INVALID owner=${owner} key=${key}`)
  const value = fs.readFileSync(file, 'utf8')
  if (value.length < specification.minimumLength || value.trim() !== value) throw new Error(`DEVELOPMENT_PROCESS_SECRET_VALUE_INVALID owner=${owner} key=${key}`)
  return value
}

/** Projects only validated launcher-owned defaults and generated secrets for one DEV owner. */
export function developmentProcessConfigEnvironment(manifest, owner) {
  if (!Object.hasOwn(OWNER_REQUIREMENTS, owner)) throw new Error(`DEVELOPMENT_PROCESS_CONFIG_OWNER_UNKNOWN owner=${owner}`)
  if (manifest.profile !== 'DEV') throw new Error(`DEVELOPMENT_PROCESS_CONFIG_PROFILE_REQUIRED owner=${owner}`)
  const secrets = Object.fromEntries(Object.entries(GENERATED_SECRETS[owner] || {}).map(([key, specification]) => [key, reopenDevelopmentSecret(manifest, owner, key, specification)]))
  return { ...(NON_SECRET_DEFAULTS[owner] || {}), ...secrets }
}

/** Returns all environment keys required for one owner without exposing any values. */
export function requiredDevelopmentProcessKeys(owner, declarations, selectedOwners = Object.keys(declarations.owners || {})) {
  const declaration = declarations.owners?.[owner]
  if (!declaration || !Object.hasOwn(OWNER_REQUIREMENTS, owner)) throw new Error(`DEVELOPMENT_PROCESS_CONFIG_OWNER_UNKNOWN owner=${owner}`)
  const capabilities = declaration.capabilities || []
  const provider = capabilities.flatMap((capability) => CAPABILITY_REQUIREMENTS[capability] || [])
  const selected = new Set(selectedOwners)
  const downstream = [owner, ...(declaration.downstreams || []).filter((target) => selected.has(target))].flatMap((target) => {
    const stem = target.replace(/-service$/u, '').replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()
    return [`GRPC_SERVICE_${stem}_URL`, `${stem}_GRPC_URL`, `${stem}_SERVICE_GRPC_URL`, `${stem}_SERVICE_HOST`, `${stem}_SERVICE_PORT`]
  })
  return [...new Set([...COMMON_REQUIREMENTS, ...provider, ...downstream, ...OWNER_REQUIREMENTS[owner]])].sort()
}

/** Validates one fully composed owner environment before the launcher spawns any business service. */
export function assertDevelopmentProcessEnvironment(owner, environment, declarations, selectedOwners) {
  const required = requiredDevelopmentProcessKeys(owner, declarations, selectedOwners)
  for (const key of required) {
    const value = environment[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`DEVELOPMENT_PROCESS_CONFIG_MISSING owner=${owner} key=${key}`)
    if (INTEGER_KEY.test(key)) {
      const number = Number(value)
      const interval = key.endsWith('_INTERVAL_MS')
      if (!Number.isSafeInteger(number) || number < (interval ? 100 : 1) || number > (interval ? 300_000 : 65_535)) throw new Error(`DEVELOPMENT_PROCESS_CONFIG_INVALID owner=${owner} key=${key}`)
    }
    if (key === 'NODE_ENV' && value !== 'development') throw new Error(`DEVELOPMENT_PROCESS_CONFIG_INVALID owner=${owner} key=${key}`)
  }
  for (const key of ['AUTH_EXECUTION_WORKLOAD_POLICIES', 'PERMISSION_WORKLOAD_ISSUANCE_POLICIES'].filter((candidate) => required.includes(candidate))) {
    try { if (!Array.isArray(JSON.parse(environment[key]))) throw new Error('not-array') } catch { throw new Error(`DEVELOPMENT_PROCESS_CONFIG_INVALID owner=${owner} key=${key}`) }
  }
  return true
}

/** Builds the value-free 22-owner configuration contract report for one selected DEV process set. */
export function developmentProcessConfigurationAudit(declarations, selectedOwners = developmentProcessConfigurationOwners()) {
  const declaredOwners = Object.keys(declarations.owners || {}).sort()
  const contractOwners = developmentProcessConfigurationOwners()
  if (declaredOwners.join('\0') !== contractOwners.join('\0')) throw new Error('DEVELOPMENT_PROCESS_CONFIG_OWNER_SET_MISMATCH')
  const selected = [...new Set(selectedOwners)].sort()
  for (const owner of selected) if (!Object.hasOwn(declarations.owners, owner)) throw new Error(`DEVELOPMENT_PROCESS_CONFIG_OWNER_UNKNOWN owner=${owner}`)
  return Object.freeze({
    schemaVersion: DEVELOPMENT_PROCESS_CONFIG_SCHEMA_VERSION,
    ownerCount: selected.length,
    owners: selected.map((owner) => ({
      owner,
      required: requiredDevelopmentProcessKeys(owner, declarations, selected).map((key) => {
        const source = configurationSource(owner, key, declarations)
        return { key, source, sensitive: source === 'DEV_GENERATED_SECRET' || SENSITIVE_KEY.test(key) }
      })
    }))
  })
}

/** Audits a complete selected DEV process set and returns only value-free configuration metadata. */
export function auditDevelopmentProcessEnvironments(environments, declarations) {
  const selectedOwners = Object.keys(environments).sort()
  for (const owner of selectedOwners) assertDevelopmentProcessEnvironment(owner, environments[owner], declarations, selectedOwners)
  return developmentProcessConfigurationAudit(declarations, selectedOwners)
}
