import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { developmentProcessConfigurationOwners, requiredDevelopmentProcessKeys } from '../src/development-process-config.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const declarations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8'))
const patterns = [
  /(?:required|requireEnv|req)\(['"]([A-Z][A-Z0-9_]+)['"]\)/gu,
  /requiredInterval\(process\.env\.([A-Z][A-Z0-9_]+)\)/gu,
  /require[A-Za-z]+\(process\.env\.([A-Z][A-Z0-9_]+)\)/gu,
  /encodedKey\s*=\s*process\.env\.([A-Z][A-Z0-9_]+)/gu
]

/** Resolves the exact owner source directory without scanning unrelated repository content. */
function ownerRoot(owner) {
  if (owner === 'api-gateway') return path.join(root, 'src/services/api-gateway/src')
  for (const area of ['system', 'business']) {
    const candidate = path.join(root, 'src/services', area, owner, 'src')
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`OWNER_SOURCE_MISSING owner=${owner}`)
}

/** Lists authored TypeScript sources while excluding tests, scripts, and generated output. */
function authoredSources(directory) {
  const output = []
  const visit = (current) => {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name)
      const stat = fs.statSync(file)
      if (stat.isDirectory()) {
        if (!['__tests__', 'test', 'scripts', 'dist', 'generated'].includes(name)) visit(file)
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) output.push(file)
    }
  }
  visit(directory)
  return output
}

/** Extracts direct fail-fast environment reads from one owner's authored startup composition. */
function directRequiredKeys(owner) {
  const keys = new Set()
  for (const file of authoredSources(ownerRoot(owner))) {
    const source = fs.readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) keys.add(match[1])
    }
  }
  return [...keys].sort()
}

test('every direct fail-fast service configuration read is covered by the 22-owner launcher audit contract', () => {
  const owners = developmentProcessConfigurationOwners()
  assert.equal(owners.length, 22)
  for (const owner of owners) {
    const contracted = new Set(requiredDevelopmentProcessKeys(owner, declarations))
    for (const key of directRequiredKeys(owner)) assert.equal(contracted.has(key), true, `unclassified startup key owner=${owner} key=${key}`)
  }
})

test('provider capabilities have complete startup projections for every declared owner', () => {
  const expected = {
    database: ['DATABASE_URL'],
    'object-store': ['ASSET_S3_ENDPOINT', 'ASSET_S3_ACCESS_KEY_ID', 'ASSET_S3_SECRET_ACCESS_KEY', 'ASSET_S3_BUCKET'],
    cache: ['REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD'],
    events: ['NATS_URL', 'NATS_USER', 'NATS_PASSWORD'],
    'network-trust': ['OES_GRPC_TLS_CA_PATH', 'OES_GRPC_TLS_CERT_PATH', 'OES_GRPC_TLS_KEY_PATH', 'OES_WORKLOAD_SPIFFE_ID']
  }
  for (const [owner, declaration] of Object.entries(declarations.owners)) {
    const contracted = new Set(requiredDevelopmentProcessKeys(owner, declarations))
    for (const capability of declaration.capabilities) {
      for (const key of expected[capability] || []) assert.equal(contracted.has(key), true, `provider projection missing owner=${owner} capability=${capability} key=${key}`)
    }
  }
})

test('every launcher selector prefix is audited as one complete owner-scoped identity tuple', () => {
  const prefixes = {
    'api-gateway': ['GATEWAY'],
    'auth-service': ['AUTH_FOUNDATION', 'AUTH_NOTIFICATION'],
    'crm-service': ['CRM_PARTY'],
    'hr-service': ['HR_PARTY'],
    'identity-service': ['IDENTITY_PARTY'],
    'public-entry-service': ['PUBLIC_ENTRY_FOUNDATION'],
    'srm-service': ['SRM_PARTY'],
    'tenant-org-service': ['TENANT_ORG_PARTY']
  }
  for (const [owner, ownerPrefixes] of Object.entries(prefixes)) {
    const contracted = new Set(requiredDevelopmentProcessKeys(owner, declarations))
    for (const prefix of ownerPrefixes) for (const suffix of ['MACHINE_PRINCIPAL_ID', 'MACHINE_WORKLOAD_BINDING_ID', 'MACHINE_WORKLOAD_BINDING_VERSION']) assert.equal(contracted.has(`${prefix}_${suffix}`), true, `selector projection missing owner=${owner} prefix=${prefix} suffix=${suffix}`)
  }
})

test('all 22 owner packages retain one launcher-compatible DEV entry', () => {
  for (const owner of developmentProcessConfigurationOwners()) {
    const packageFile = path.join(path.dirname(ownerRoot(owner)), 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    assert.match(packageJson.scripts?.dev || '', /dev:build[\s\S]*dev:start/u, `DEV entry missing owner=${owner}`)
  }
})
