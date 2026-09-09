import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeCredentialBundle } from '../credentials.mjs'
import { environmentForOwner } from '../manifest.mjs'
import { downstreamEnvironment, gatewayReadinessEnvironment } from '../process-runtime.mjs'
import { trustedProcessEnvironment } from '../trusted-runtime-config.mjs'
import {
  assertDevelopmentProcessEnvironment,
  auditDevelopmentProcessEnvironmentInputs,
  auditDevelopmentProcessEnvironments,
  developmentProcessConfigEnvironment,
  developmentProcessConfigurationOwners
} from '../development-process-config.mjs'

const root = path.resolve(import.meta.dirname, '../../../..')
const declarations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/local-runtime/relationships.json'), 'utf8'))
const owners = Object.keys(declarations.owners).sort()

/** Creates a complete clean-environment projection using the same production composition layers without touching host runtime state. */
function completeProjectionFixture() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-dev-process-config-'))
  const stackRoot = path.join(stateRoot, 'stacks', 'oes-local-0123456789abcdef')
  const caPath = path.join(stackRoot, 'credentials', 'mtls', 'ca.pem')
  fs.mkdirSync(path.dirname(caPath), { recursive: true })
  fs.writeFileSync(caPath, 'fixture-ca')
  const mtls = Object.fromEntries(owners.map((owner) => [owner, {
    OES_GRPC_TLS_ENABLED: 'true', OES_GRPC_TLS_MIN_VERSION: 'TLSv1.2', OES_GRPC_TLS_CA_PATH: caPath,
    OES_GRPC_TLS_CERT_PATH: path.join(stackRoot, owner, 'cert.pem'), OES_GRPC_TLS_KEY_PATH: path.join(stackRoot, owner, 'key.pem'),
    OES_WORKLOAD_SPIFFE_ID: `spiffe://local.oes.internal/ns/oes/sa/${owner}`
  }]))
  const mtlsReference = writeCredentialBundle(stackRoot, 'mtls', mtls)
  const providerOwners = (capability) => owners.filter((owner) => declarations.owners[owner].capabilities.includes(capability))
  const endpoints = [
    { provider: 'postgres', owners: providerOwners('database'), environment: { OES_POSTGRES_HOST: '127.0.0.1', OES_POSTGRES_PORT: '41001' }, credentialReference: { provider: 'postgres' } },
    { provider: 'minio', owners: providerOwners('object-store'), environment: { ASSET_S3_ENDPOINT: 'http://127.0.0.1:41002' }, credentialReference: { provider: 'minio' } },
    { provider: 'redis', owners: providerOwners('cache'), environment: { REDIS_HOST: '127.0.0.1', REDIS_PORT: '41003' }, credentialReference: { provider: 'redis' } },
    { provider: 'nats', owners: providerOwners('events'), environment: { NATS_URL: 'nats://127.0.0.1:41004' }, credentialReference: { provider: 'nats' } },
    { provider: 'mtls', owners: providerOwners('network-trust'), environment: { OES_GRPC_TLS_ENABLED: 'true' }, credentialReference: mtlsReference }
  ]
  const manifest = { profile: 'DEV', stateRoot, stackRoot, taskKey: 'task_fixture', runId: 'run_fixture', devStackId: 'machine_fixture', stackKey: 'oes-local-0123456789abcdef', owners, endpoints }
  const selectorPath = path.join(stateRoot, 'selectors.json')
  fs.writeFileSync(selectorPath, JSON.stringify({ selectors: owners.map((owner) => ({ inventoryEntryKey: owner, machinePrincipalId: `${owner}-principal`, machineWorkloadBindingId: `${owner}-binding`, machineWorkloadBindingVersion: '1' })) }))
  const providerEnvironment = {
    postgres: (owner) => ({ DATABASE_URL: `postgresql://${owner}:fixture@127.0.0.1:41001/${owner.replaceAll('-', '_')}` }),
    minio: () => ({ ASSET_S3_ENDPOINT: 'http://127.0.0.1:41002', ASSET_S3_ACCESS_KEY_ID: 'asset-access', ASSET_S3_SECRET_ACCESS_KEY: 'asset-secret', ASSET_S3_BUCKET: 'asset-bucket', ASSET_S3_FORCE_PATH_STYLE: 'true' }),
    redis: (owner) => ({ REDIS_HOST: '127.0.0.1', REDIS_PORT: '41003', REDIS_USERNAME: owner, REDIS_PASSWORD: 'redis-secret', OES_REDIS_NAMESPACE: `oes:${owner}`, TERMINAL_DEVICE_UNAVAILABLE_REDIS_CHANNEL: 'oes:events:terminal-device.unavailable' }),
    nats: (owner) => ({
      NATS_URL: 'nats://127.0.0.1:41004', NATS_USER: owner, NATS_PASSWORD: 'nats-secret',
      ...(owner === 'notification-service' ? { NATS_NOTIFICATION_USER: owner, NATS_NOTIFICATION_PASSWORD: 'nats-secret' } : {})
    }),
    mtls: (owner) => mtls[owner]
  }
  const ports = Object.fromEntries(owners.map((owner, index) => [owner, 42000 + index]))
  const environments = Object.fromEntries(owners.map((owner) => {
    const provider = environmentForOwner(manifest, owner, (reference, exactOwner) => providerEnvironment[reference === mtlsReference ? 'mtls' : reference.provider](exactOwner))
    const trusted = trustedProcessEnvironment({ root, manifest, owner, issuerPort: 43000, selectorPath })
    return [owner, {
      PATH: '/usr/bin', ...provider, ...downstreamEnvironment(owner, ports, declarations), ...trusted,
      MODULE_NAME: owner, GRPC_LISTEN_HOST: '127.0.0.1', GRPC_LISTEN_PORT: String(ports[owner]),
      SERVICE_REGISTRY_IP: '127.0.0.1', SERVICE_REGISTRY_PORT: String(ports[owner]),
      ...(owner === 'api-gateway' ? { SERVICE_PORT: String(ports[owner]), ...gatewayReadinessEnvironment(ports, declarations) } : {}),
      ...(owner === 'auth-service' ? { AUTH_HTTP_PORT: '43100', AUTH_EXECUTION_SIGNER_SOCKET_PATH: '/tmp/fixture.sock', AUTH_EXECUTION_KMS_KEY_REF: 'pkcs11:fixture' } : {})
    }]
  }))
  return { environments, manifest, stackRoot }
}

test('versioned DEV configuration contract covers the exact 22 declared owners', () => {
  assert.equal(owners.length, 22)
  assert.deepEqual(developmentProcessConfigurationOwners(), owners)
})

test('all 22 clean owner projections satisfy startup requirements and emit only value-free audit metadata', () => {
  const { environments } = completeProjectionFixture()
  const report = auditDevelopmentProcessEnvironments(environments, declarations)
  assert.equal(report.ownerCount, 22)
  assert.equal(report.owners.every((entry) => entry.required.length > 0), true)
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /asset-secret|redis-secret|nats-secret|postgresql:|pkcs11:fixture/u)
  assert.match(serialized, /SITE_PREVIEW_TOKEN_SECRET/u)
  assert.match(serialized, /NOTIFICATION_DELIVERY_PAYLOAD_KEY/u)
  const siteSecret = report.owners.find(({ owner }) => owner === 'site-service').required.find(({ key }) => key === 'SITE_PREVIEW_TOKEN_SECRET')
  const notificationSecret = report.owners.find(({ owner }) => owner === 'notification-service').required.find(({ key }) => key === 'NOTIFICATION_DELIVERY_PAYLOAD_KEY')
  const objectStoreSecret = report.owners.find(({ owner }) => owner === 'asset-service').required.find(({ key }) => key === 'ASSET_S3_SECRET_ACCESS_KEY')
  const notificationNatsPassword = report.owners.find(({ owner }) => owner === 'notification-service').required.find(({ key }) => key === 'NATS_NOTIFICATION_PASSWORD')
  const assetInterval = report.owners.find(({ owner }) => owner === 'asset-service').required.find(({ key }) => key === 'ASSET_MEDIA_LIFECYCLE_INTERVAL_MS')
  assert.deepEqual(siteSecret, { key: 'SITE_PREVIEW_TOKEN_SECRET', source: 'DEV_GENERATED_SECRET', sensitive: true })
  assert.deepEqual(notificationSecret, { key: 'NOTIFICATION_DELIVERY_PAYLOAD_KEY', source: 'DEV_GENERATED_SECRET', sensitive: true })
  assert.deepEqual(objectStoreSecret, { key: 'ASSET_S3_SECRET_ACCESS_KEY', source: 'PROVIDER_OBJECT_STORE', sensitive: true })
  assert.deepEqual(notificationNatsPassword, { key: 'NATS_NOTIFICATION_PASSWORD', source: 'PROVIDER_EVENTS', sensitive: true })
  assert.deepEqual(assetInterval, { key: 'ASSET_MEDIA_LIFECYCLE_INTERVAL_MS', source: 'DEV_DEFAULT', sensitive: false })
})

test('system and business DEV subsets require only endpoints selected for that launch', () => {
  const { environments } = completeProjectionFixture()
  const system = owners.filter((owner) => !['sales-service', 'crm-service', 'srm-service', 'finance-service', 'procurement-service', 'wms-service', 'mes-service'].includes(owner))
  const business = owners.filter((owner) => !system.includes(owner))
  for (const selected of [system, business]) {
    const subset = Object.fromEntries(selected.map((owner) => [owner, environments[owner]]))
    for (const environment of Object.values(subset)) {
      for (const target of owners.filter((owner) => !selected.includes(owner))) {
        const stem = target.replace(/-service$/u, '').replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()
        delete environment[`${stem}_SERVICE_PORT`]
        delete environment[`${stem}_SERVICE_HOST`]
        delete environment[`GRPC_SERVICE_${stem}_URL`]
        delete environment[`${stem}_GRPC_URL`]
        delete environment[`${stem}_SERVICE_GRPC_URL`]
      }
    }
    assert.equal(auditDevelopmentProcessEnvironments(subset, declarations).ownerCount, selected.length)
  }
})

test('launcher supplies deterministic bounded DEV cadence defaults without reading ambient values', () => {
  const manifest = { profile: 'DEV', stackRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'oes-dev-defaults-')) }
  assert.deepEqual(developmentProcessConfigEnvironment(manifest, 'asset-service'), { ASSET_MEDIA_LIFECYCLE_INTERVAL_MS: '5000', ASSET_MEDIA_OUTBOX_INTERVAL_MS: '5000' })
  assert.deepEqual(developmentProcessConfigEnvironment(manifest, 'collaboration-service'), { COLLABORATION_OUTBOX_INTERVAL_MS: '5000' })
})

test('generated DEV secrets are stable, mode 0600, owner-scoped, and absent from audit output', () => {
  const manifest = { profile: 'DEV', stackRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'oes-dev-secrets-')) }
  const site = developmentProcessConfigEnvironment(manifest, 'site-service')
  const repeated = developmentProcessConfigEnvironment(manifest, 'site-service')
  const notification = developmentProcessConfigEnvironment(manifest, 'notification-service')
  assert.equal(site.SITE_PREVIEW_TOKEN_SECRET, repeated.SITE_PREVIEW_TOKEN_SECRET)
  assert.equal(Object.hasOwn(notification, 'SITE_PREVIEW_TOKEN_SECRET'), false)
  assert.equal(Object.hasOwn(site, 'NOTIFICATION_DELIVERY_PAYLOAD_KEY'), false)
  for (const filename of ['site-preview-token.key', 'notification-delivery-payload.key']) {
    const file = path.join(manifest.stackRoot, 'credentials', 'process-runtime', filename)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
  assert.throws(() => developmentProcessConfigEnvironment({ ...manifest, profile: 'CI' }, 'site-service'), /DEVELOPMENT_PROCESS_CONFIG_PROFILE_REQUIRED owner=site-service/u)
})

test('pre-spawn audit fails closed for missing, illegal, and permission-drifted configuration without secret values', () => {
  const { environments, manifest } = completeProjectionFixture()
  const missing = structuredClone(environments['asset-service'])
  delete missing.ASSET_MEDIA_LIFECYCLE_INTERVAL_MS
  assert.throws(() => assertDevelopmentProcessEnvironment('asset-service', missing, declarations), /^Error: DEVELOPMENT_PROCESS_CONFIG_MISSING owner=asset-service key=ASSET_MEDIA_LIFECYCLE_INTERVAL_MS$/u)
  assert.throws(() => assertDevelopmentProcessEnvironment('collaboration-service', { ...environments['collaboration-service'], COLLABORATION_OUTBOX_INTERVAL_MS: '99' }, declarations), /DEVELOPMENT_PROCESS_CONFIG_INVALID owner=collaboration-service key=COLLABORATION_OUTBOX_INTERVAL_MS/u)
  assert.throws(() => assertDevelopmentProcessEnvironment('asset-service', { ...environments['asset-service'], OES_GRPC_TLS_ENABLED: 'false' }, declarations), /DEVELOPMENT_PROCESS_CONFIG_INVALID owner=asset-service key=OES_GRPC_TLS_ENABLED/u)
  assert.throws(() => assertDevelopmentProcessEnvironment('asset-service', { ...environments['asset-service'], OES_GRPC_TLS_MIN_VERSION: 'TLSv1.3' }, declarations), /DEVELOPMENT_PROCESS_CONFIG_INVALID owner=asset-service key=OES_GRPC_TLS_MIN_VERSION/u)
  assert.throws(() => assertDevelopmentProcessEnvironment('asset-service', { ...environments['asset-service'], OES_WORKLOAD_SPIFFE_ID: 'https://invalid.example' }, declarations), /DEVELOPMENT_PROCESS_CONFIG_INVALID owner=asset-service key=OES_WORKLOAD_SPIFFE_ID/u)
  const missingNotificationAlias = structuredClone(environments['notification-service'])
  delete missingNotificationAlias.NATS_NOTIFICATION_USER
  assert.throws(() => assertDevelopmentProcessEnvironment('notification-service', missingNotificationAlias, declarations), /DEVELOPMENT_PROCESS_CONFIG_MISSING owner=notification-service key=NATS_NOTIFICATION_USER/u)
  const signerPending = structuredClone(environments)
  delete signerPending['auth-service'].AUTH_EXECUTION_KMS_KEY_REF
  delete signerPending['auth-service'].AUTH_EXECUTION_SIGNER_SOCKET_PATH
  assert.equal(auditDevelopmentProcessEnvironmentInputs(signerPending, declarations).ownerCount, 22)
  assert.throws(() => auditDevelopmentProcessEnvironments(signerPending, declarations), /DEVELOPMENT_PROCESS_CONFIG_MISSING owner=auth-service key=AUTH_EXECUTION_KMS_KEY_REF/u)
  delete signerPending['auth-service'].AUTH_EXECUTION_WORKLOAD_POLICIES
  assert.throws(() => auditDevelopmentProcessEnvironmentInputs(signerPending, declarations), /DEVELOPMENT_PROCESS_CONFIG_MISSING owner=auth-service key=AUTH_EXECUTION_WORKLOAD_POLICIES/u)
  assert.throws(() => assertDevelopmentProcessEnvironment('asset-service', environments['asset-service'], declarations, owners, ['DATABASE_URL']), /DEVELOPMENT_PROCESS_CONFIG_DEFERRED_KEY_INVALID owner=asset-service key=DATABASE_URL/u)
  const secretFile = path.join(manifest.stackRoot, 'credentials', 'process-runtime', 'site-preview-token.key')
  fs.chmodSync(secretFile, 0o644)
  assert.throws(() => developmentProcessConfigEnvironment(manifest, 'site-service'), /DEVELOPMENT_PROCESS_SECRET_FILE_INVALID owner=site-service key=SITE_PREVIEW_TOKEN_SECRET/u)
  fs.rmSync(path.dirname(secretFile), { recursive: true, force: true })
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-dev-secret-foreign-'))
  fs.symlinkSync(foreign, path.dirname(secretFile))
  assert.throws(() => developmentProcessConfigEnvironment(manifest, 'site-service'), /STATE_SYMLINK_FORBIDDEN/u)
})

test('notification DEV secret must decode to the exact 32-byte service invariant', () => {
  const manifest = { profile: 'DEV', stackRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'oes-dev-notification-secret-')) }
  const directory = path.join(manifest.stackRoot, 'credentials', 'process-runtime')
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'notification-delivery-payload.key')
  fs.writeFileSync(file, 'legacy-invalid-key', { mode: 0o600 })
  assert.throws(() => developmentProcessConfigEnvironment(manifest, 'notification-service'), /^Error: DEVELOPMENT_PROCESS_SECRET_VALUE_INVALID owner=notification-service key=NOTIFICATION_DELIVERY_PAYLOAD_KEY$/u)
  fs.writeFileSync(file, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 })
  assert.equal(Buffer.from(developmentProcessConfigEnvironment(manifest, 'notification-service').NOTIFICATION_DELIVERY_PAYLOAD_KEY, 'base64').length, 32)
})
