import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const provenance = JSON.parse(
  readFileSync(new URL('../../runtime-config/workload-policy-provenance.json', import.meta.url), 'utf8')
)
const authPolicies = JSON.parse(
  readFileSync(
    new URL('../../runtime-config/auth-execution-workload-policies.json', import.meta.url),
    'utf8'
  )
)
const permissionPolicies = JSON.parse(
  readFileSync(
    new URL('../../runtime-config/permission-workload-issuance-policies.json', import.meta.url),
    'utf8'
  )
)

const GATEWAY_RUNTIME_ADDITIONS = Object.freeze([
  Object.freeze({
    audience: 'urn:oes:service:browser-activity-service',
    code: 'browser_activity.overview.read',
    source: 'docs/architecture/services/browser-activity-service.md#51-trusted-grpc-entry'
  }),
  Object.freeze({
    audience: 'urn:oes:service:crm-service',
    code: 'crm.account.read',
    source: 'docs/architecture/services/crm-service.md#18-trusted-grpc-inbound-boundary'
  }),
  Object.freeze({
    audience: 'urn:oes:service:hr-service',
    code: 'hr.employee.list',
    source: 'docs/architecture/services/hr-service.md#11-trusted-grpc-17-rpc-contractfrozen'
  }),
  Object.freeze({
    audience: 'urn:oes:service:mes-service',
    code: 'mes.production_spec.read',
    source: 'docs/contracts/mes-service/README.md#exact-32-rpc-matrix'
  }),
  Object.freeze({
    audience: 'urn:oes:service:party-service',
    code: 'party.internal.get_tenant_party_by_id',
    source: 'docs/architecture/services/party-service.md#10-trusted-grpc-inbound-boundary'
  }),
  Object.freeze({
    audience: 'urn:oes:service:site-service',
    code: 'site.management.read',
    source: 'docs/architecture/services/site-service.md#222-frozen-admin-rpc-authorization-map'
  })
])

test('binds each added Gateway audience to exact selector-v2 provenance', () => {
  const exactGatewayAdditions = provenance.additions.filter(
    ({ workload }) => workload === 'api-gateway'
  )
  for (const addition of exactGatewayAdditions) assertExactStableSource(addition)
  const gatewayAdditions = exactGatewayAdditions.map(
    ({ audience, code, source, selectorEntry, selectorVersion }) => ({
      audience,
      code,
      source,
      selectorEntry,
      selectorVersion
    })
  )

  assert.deepEqual(
    gatewayAdditions,
    GATEWAY_RUNTIME_ADDITIONS.map((addition) => ({
      ...addition,
      selectorEntry: 'api-gateway',
      selectorVersion: '2'
    }))
  )
  assert.equal(JSON.stringify(gatewayAdditions).includes('*'), false)
  const gatewayPolicy = authPolicies.find(
    ({ spiffeId }) => spiffeId === 'spiffe://local.oes.internal/ns/oes/sa/api-gateway'
  )
  for (const { audience } of GATEWAY_RUNTIME_ADDITIONS) {
    assert.ok(gatewayPolicy?.audiences.includes(audience), `Gateway audience is missing: ${audience}`)
  }
})

test('binds Public Entry permission checks to the exact SYSTEM workload policy and provenance', () => {
  const expected = {
    originalWorkloadSpiffeId:
      'spiffe://local.oes.internal/ns/oes/sa/public-entry-service',
    targetAudience: 'urn:oes:service:permission-service',
    permissionCodes: ['permission.internal.permission.check'],
    scopeLevel: 'SYSTEM',
    policyVersion: 'auth-login-owner-facts-v1'
  }
  const policy = permissionPolicies.find(
    ({ originalWorkloadSpiffeId, targetAudience }) =>
      originalWorkloadSpiffeId === expected.originalWorkloadSpiffeId &&
      targetAudience === expected.targetAudience
  )
  assert.deepEqual(policy, expected)

  const addition = provenance.additions.find(
    ({ workload, audience, code }) =>
      workload === 'public-entry-service' &&
      audience === expected.targetAudience &&
      code === expected.permissionCodes[0]
  )
  assert.deepEqual(addition, {
    workload: 'public-entry-service',
    audience: expected.targetAudience,
    code: expected.permissionCodes[0],
    source:
      'docs/architecture/services/permission-service.md#16-trusted-grpc-66-rpc-contractfrozen',
    selectorEntry: 'public-entry-service',
    selectorVersion: '1'
  })
  assertExactStableSource(addition)
})

/** Resolves one provenance fragment to an existing stable heading whose section contains its Code. */
function assertExactStableSource({ source, code }) {
  const [relativePath, fragment, extra] = source.split('#')
  assert.equal(extra, undefined)
  assert.ok(
    relativePath?.startsWith('docs/architecture/') || relativePath?.startsWith('docs/contracts/')
  )
  assert.ok(fragment)
  const document = readFileSync(new URL(`../../../../${relativePath}`, import.meta.url), 'utf8')
  const headings = [...document.matchAll(/^(#{1,6})\s+(.+)$/gmu)].map((match) => ({
    level: match[1].length,
    fragment: headingFragment(match[2]),
    offset: match.index,
    start: match.index + match[0].length
  }))
  const index = headings.findIndex((heading) => heading.fragment === fragment)
  assert.notEqual(index, -1, `stable source fragment is missing: ${source}`)
  const heading = headings[index]
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level)
  const section = document.slice(heading.start, next?.offset ?? document.length)
  assert.match(section, new RegExp(escapeRegExp(code), 'u'))
}

/** Mirrors the repository's GitHub-compatible heading fragments for stable Markdown references. */
function headingFragment(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s+/gu, '-')
}

/** Escapes one exact Permission Code before matching it inside its referenced stable section. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
