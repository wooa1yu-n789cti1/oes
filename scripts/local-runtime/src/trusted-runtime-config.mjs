import fs from 'node:fs'
import { resolveEndpoint } from './manifest.mjs'
import path from 'node:path'
import { validate, WORKLOAD_POLICY_VERSION } from '../../local/workload-policy-profile.mjs'
import { developmentProcessConfigEnvironment } from './development-process-config.mjs'

const SELECTOR_PREFIXES = Object.freeze({
  'api-gateway': ['GATEWAY'],
  'auth-service': ['AUTH_FOUNDATION', 'AUTH_NOTIFICATION'],
  'crm-service': ['CRM_PARTY'],
  'hr-service': ['HR_PARTY'],
  'identity-service': ['IDENTITY_PARTY'],
  'public-entry-service': ['PUBLIC_ENTRY_FOUNDATION'],
  'srm-service': ['SRM_PARTY'],
  'tenant-org-service': ['TENANT_ORG_PARTY']
})

/** Loads and validates the versioned workload registries without accepting runtime authority. */
export function loadWorkloadPolicies(root) {
  const auth = JSON.parse(fs.readFileSync(path.join(root, 'scripts/local/runtime-config/auth-execution-workload-policies.json'), 'utf8'))
  const permission = JSON.parse(fs.readFileSync(path.join(root, 'scripts/local/runtime-config/permission-workload-issuance-policies.json'), 'utf8'))
  validate(auth, permission)
  return { auth: structuredClone(auth), permission: structuredClone(permission) }
}

/** Reopens the exact task-owned selector profile when the identity bootstrap produced one. */
export function loadMachineSelectors(selectorPath) {
  if (!selectorPath || !fs.existsSync(selectorPath)) return new Map()
  const profile = JSON.parse(fs.readFileSync(selectorPath, 'utf8'))
  if (!Array.isArray(profile.selectors)) throw new Error('MACHINE_SELECTOR_PROFILE_INVALID')
  const selectors = new Map()
  for (const selector of profile.selectors) {
    if (!selector.inventoryEntryKey || selectors.has(selector.inventoryEntryKey)) throw new Error('MACHINE_SELECTOR_PROFILE_DUPLICATE')
    for (const key of ['machinePrincipalId', 'machineWorkloadBindingId', 'machineWorkloadBindingVersion']) if (!String(selector[key] || '').trim()) throw new Error(`MACHINE_SELECTOR_PROFILE_VALUE_INVALID key=${key}`)
    selectors.set(selector.inventoryEntryKey, Object.freeze({ ...selector }))
  }
  return selectors
}

/** Adds only the Human-OBO facts whose machine owners were transactionally provisioned. */
export function bindHumanOboPolicies(authPolicies, selectors) {
  const policies = structuredClone(authPolicies)
  const bindings = [
    ['api-gateway', ['urn:oes:service:identity-service', 'urn:oes:service:permission-service', 'urn:oes:service:public-entry-service', 'urn:oes:service:collaboration-service', 'urn:oes:service:tenant-org-service']],
    ['collaboration-service', ['urn:oes:service:identity-service', 'urn:oes:service:permission-service']],
    ['public-entry-service', ['urn:oes:service:hr-service', 'urn:oes:service:identity-service', 'urn:oes:service:permission-service', 'urn:oes:service:tenant-org-service']]
  ]
  for (const [owner, targetAudiences] of bindings) {
    const selector = selectors.get(owner)
    if (!selector) continue
    const spiffeId = `spiffe://local.oes.internal/ns/oes/sa/${owner}`
    const policy = policies.find((entry) => entry.spiffeId === spiffeId)
    if (!policy) throw new Error(`TRUSTED_RUNTIME_AUTH_POLICY_MISSING owner=${owner}`)
    policy.audiences = [...new Set([...policy.audiences, ...targetAudiences])]
    policy.humanObo = {
      selfAudience: `urn:oes:service:${owner}`,
      actorMachinePrincipalId: selector.machinePrincipalId,
      actorBindingId: selector.machineWorkloadBindingId,
      actorBindingVersion: selector.machineWorkloadBindingVersion,
      targetAudiences
    }
  }
  return policies
}

/** Projects only deployment-owned selector references into their exact owner process. */
export function selectorEnvironment(owner, selectors) {
  const prefixes = SELECTOR_PREFIXES[owner] || []
  if (!prefixes.length) return {}
  const selector = selectors.get(owner)
  if (!selector) return {}
  return Object.fromEntries(prefixes.flatMap((prefix) => [
    [`${prefix}_MACHINE_PRINCIPAL_ID`, selector.machinePrincipalId],
    [`${prefix}_MACHINE_WORKLOAD_BINDING_ID`, selector.machineWorkloadBindingId],
    [`${prefix}_MACHINE_WORKLOAD_BINDING_VERSION`, selector.machineWorkloadBindingVersion]
  ]))
}

/** Produces the trust, owner, and DEV configuration bindings for one exact host process. */
export function trustedProcessEnvironment({ root, manifest, owner, issuerPort, selectorPath }) {
  const { auth, permission } = loadWorkloadPolicies(root)
  const selectors = loadMachineSelectors(selectorPath)
  const boundAuth = bindHumanOboPolicies(auth, selectors)
  const issuer = `https://issuer.local.oes.internal:${issuerPort}`
  const common = {
    AUTH_EXECUTION_WORKLOAD_POLICIES: JSON.stringify(boundAuth),
    AUTH_EXECUTION_ISSUER: issuer,
    NODE_EXTRA_CA_CERTS: environmentCaPath(manifest, owner),
    NODE_OPTIONS: `--require=${path.join(root, 'scripts/local/runtime-config/issuer-dns.cjs')}`,
    ...selectorEnvironment(owner, selectors)
  }
  const exact = {
    'api-gateway': {
      GATEWAY_TERMINAL_DEVICE_PEER_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/terminal-device-service'
    },
    'auth-service': {
      AUTH_PERMISSION_WORKLOAD_ISSUANCE_POLICY_VERSION: WORKLOAD_POLICY_VERSION
    },
    'notification-service': {
      AUTH_NOTIFICATION_AUTH_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/auth-service'
    },
    'permission-service': {
      PERMISSION_AUTH_SERVICE_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/auth-service',
      PERMISSION_WORKLOAD_ISSUANCE_POLICIES: JSON.stringify(permission)
    },
    'tenant-org-service': {
      TENANT_ORG_GATEWAY_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/api-gateway',
      TENANT_ORG_AUTH_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/auth-service',
      TENANT_ORG_PUBLIC_ENTRY_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/public-entry-service'
    },
    'terminal-device-service': {
      GATEWAY_TERMINAL_DEVICE_SPIFFE_ID: 'spiffe://local.oes.internal/ns/oes/sa/api-gateway'
    }
  }
  return { ...common, ...(exact[owner] || {}), ...developmentProcessConfigEnvironment(manifest, owner) }
}

/** Resolves the owner-specific CA from the sealed mTLS credential reference. */
function environmentCaPath(manifest, owner) {
  const endpoint = resolveEndpoint(manifest, 'mtls')
  if (endpoint && !endpoint.owners.includes(owner)) throw new Error(`MTLS_CREDENTIAL_REFERENCE_MISSING owner=${owner}`)
  if (!endpoint?.credentialReference?.path) throw new Error(`MTLS_CREDENTIAL_REFERENCE_MISSING owner=${owner}`)
  const bundle = JSON.parse(fs.readFileSync(endpoint.credentialReference.path, 'utf8'))
  const caPath = bundle.ownerEnvironments?.[owner]?.OES_GRPC_TLS_CA_PATH
  if (!caPath) throw new Error(`MTLS_CA_PATH_MISSING owner=${owner}`)
  return caPath
}
