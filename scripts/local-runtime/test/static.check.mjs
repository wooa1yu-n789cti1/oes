#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { developmentProcessConfigurationOwners } from '../src/development-process-config.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const json = (relative) => JSON.parse(read(relative))

/** Walks only active runtime and service execution surfaces, excluding tests and generated output. */
function activeFiles() {
  const roots = ['package.json', '.github/workflows', 'scripts/local-runtime', 'scripts/test-infrastructure', 'scripts/local', 'src/services']
  const files = []
  const visit = (relative) => {
    const absolute = path.join(root, relative)
    const stat = fs.statSync(absolute)
    if (stat.isFile()) return files.push(relative)
    for (const name of fs.readdirSync(absolute)) {
      if (['node_modules', 'dist', 'coverage', '__tests__', 'test'].includes(name)) continue
      const child = path.join(relative, name)
      const childStat = fs.statSync(path.join(root, child))
      if (childStat.isDirectory() || /\.(?:mjs|cjs|js|ts|json|ya?ml|sh)$/u.test(name)) visit(child)
    }
  }
  for (const entry of roots) if (fs.existsSync(path.join(root, entry))) visit(entry)
  return files
    .filter((file) => !/\.spec\.[cm]?[jt]s$/u.test(file))
    .filter((file) => file !== 'scripts/local-runtime/test/static.check.mjs')
}

const removed = [
  'docker-compose.yml',
  'docker-compose.infra.yml',
  'scripts/local/database-lifecycle.mjs',
  'scripts/local/worktree-env.mjs',
  'scripts/local/trusted-runtime.mjs',
  'scripts/local/trusted-runtime-dev-service.mjs',
  'scripts/local/trusted-runtime-issuer.mjs',
  'scripts/local/backend-start-preflight.mjs'
]
for (const relative of removed) assert.equal(fs.existsSync(path.join(root, relative)), false, `legacy runtime file remains: ${relative}`)

const sources = activeFiles().map((file) => ({ file, text: read(file) }))
for (const { file, text } of sources) {
  assert.doesNotMatch(text, /docker-compose(?:\.infra)?\.yml|COMPOSE_PROJECT_NAME|\.tmp\/oes-database-lifecycle|worktree-env\.mjs/u, `legacy runtime reference: ${file}`)
  assert.doesNotMatch(text, /prisma\s+(?:db\s+)?push|--accept-data-loss/u, `schema push authority remains: ${file}`)
}

const rootPackage = json('package.json')
for (const [name, command] of Object.entries(rootPackage.scripts)) {
  if (name.startsWith('local:trusted-runtime:')) assert.match(command, /(?:runtime:|scripts\/local-runtime\/launcher\.mjs)/u, `compatibility script does not delegate: ${name}`)
}
assert.equal(rootPackage.scripts['test:database-lifecycle'], undefined)
assert.equal(rootPackage.scripts['local-runtime:contract'], 'node --test scripts/local-runtime/test/*.contract.spec.mjs')
assert.equal(rootPackage.scripts['local-runtime:check'], 'pnpm local-runtime:test && pnpm local-runtime:contract && pnpm local-runtime:static')
assert.equal(rootPackage.scripts['runtime:seed:system-admin'], 'node scripts/local-runtime/launcher.mjs system-admin-seed')

for (const area of ['system', 'business']) {
  for (const owner of fs.readdirSync(path.join(root, 'src/services', area))) {
    const packagePath = path.join('src/services', area, owner, 'package.json')
    if (!fs.existsSync(path.join(root, packagePath))) continue
    const pkg = json(packagePath)
    assert.equal(pkg.scripts?.['prisma:push'], undefined, `${owner} retains prisma:push`)
    if (pkg.scripts?.['test:integration']) assert.equal(pkg.scripts['test:integration'], `pnpm --workspace-root test:run -- --type integration --owner ${pkg.name}`)
    assert.equal(fs.existsSync(path.join(root, 'src/services', area, owner, '.env.example')), false, `${owner} retains an unmanaged dotenv example`)
  }
}

const workflow = read('.github/workflows/ci.yml')
assert.match(workflow, /max-parallel:\s*2/u)
assert.match(workflow, /concurrency:\s*\n/u)
assert.match(workflow, /label=oes\.runtime\.task-key=/u)
assert.doesNotMatch(workflow, /docker compose|docker-compose/u)

const driver = read('scripts/local-runtime/src/docker-driver.mjs')
assert.match(driver, /127\.0\.0\.1::\$\{port\}/u)
assert.doesNotMatch(driver, /--publish['"],\s*['"](?:127\.0\.0\.1:)?\d+:/u)
const activeLocalRuntime = sources.filter(({ file }) => file.startsWith('scripts/local-runtime/')).map(({ text }) => text).join('\n')
assert.doesNotMatch(activeLocalRuntime, /OES_MIGRATOR_DATABASE_URL/u, 'business runtime surface retains migrator environment authority')
const hierarchyRuntime = sources.filter(({ file }) => file.startsWith('scripts/local-runtime/') && !['scripts/local-runtime/src/state-layout.mjs', 'scripts/local-runtime/src/state-migration.mjs', 'scripts/local-runtime/src/legacy-reconcile.mjs'].includes(file)).map(({ text }) => text).join('\n')
assert.doesNotMatch(hierarchyRuntime, /path\.join\([^\n]*(?:stateRoot|manifest\.stateRoot)[^\n]*['"](?:shared|runs|leases|semaphore)['"]/u, 'active runtime retains a flat machine-root authority path')
for (const label of ['oes.runtime.stack-key', 'oes.runtime.dev-stack-id', 'oes.runtime.scope', 'oes.runtime.pool', 'oes.runtime.provider', 'oes.runtime.ci-job-fingerprint']) assert.match(driver, new RegExp(label.replaceAll('.', '\\.'), 'u'), `Docker identity label missing: ${label}`)
assert.match(read('scripts/local-runtime/launcher.mjs'), /state-inventory[\s\S]*state-plan[\s\S]*state-stage[\s\S]*state-activate[\s\S]*state-recover[\s\S]*state-rollback/u)
assert.match(read('docs/runbooks/local-development-and-test-runtime.md'), /runtime:state:inventory[\s\S]*runtime:state:activate[\s\S]*runtime:state:recover[\s\S]*runtime:state:rollback/u)
const aliasBoundaries = activeLocalRuntime.match(/mc alias set -- [^;\n`]*"\$(?:MINIO_ROOT_PASSWORD|A_SECRET)"/gu) || []
const userAddBoundaries = activeLocalRuntime.match(/mc admin user add -- [^;&\n`]*"\$MINIO_USER_SECRET"/gu) || []
assert.equal(aliasBoundaries.length, 6, 'all active MinIO aliases must terminate option parsing before credentials')
assert.equal(userAddBoundaries.length, 1, 'all active MinIO user creation paths must terminate option parsing before credentials')
assert.doesNotMatch(activeLocalRuntime, /mc alias set (?!--)|mc admin user add (?!--)/u, 'active MinIO credentials must not be parsed as CLI flags')
const leadingDashFixture = '-deterministic-leading-dash-secret'
for (const invocation of [...aliasBoundaries, ...userAddBoundaries]) {
  const expanded = invocation.replace(/"\$(?:MINIO_ROOT_PASSWORD|A_SECRET|MINIO_USER_SECRET)"/u, leadingDashFixture).split(/\s+/u)
  assert.ok(expanded.indexOf('--') < expanded.indexOf(leadingDashFixture), `leading-dash fixture must remain positional: ${invocation}`)
}
const processRuntime = read('scripts/local-runtime/src/process-runtime.mjs')
for (const binding of ['AUTH_EXECUTION_SIGNER_SOCKET_PATH', 'AUTH_EXECUTION_KMS_KEY_REF', 'AUTH_HTTP_PORT', 'GATEWAY_READINESS_TARGETS', 'issuer-server.mjs']) assert.match(processRuntime, new RegExp(binding, 'u'))
const declarations = json('scripts/local-runtime/relationships.json')
assert.deepEqual(developmentProcessConfigurationOwners(), Object.keys(declarations.owners).sort(), 'DEV process configuration contract must cover every declared owner')
assert.ok(processRuntime.indexOf('auditDevelopmentProcessEnvironments(environments, declarations)') < processRuntime.indexOf("spawn('pnpm', ['--filter', owner, 'dev']"), 'all selected owner environments must be audited before service spawn')
assert.ok(processRuntime.indexOf('auditDevelopmentProcessEnvironmentInputs(environments, declarations)') < processRuntime.indexOf('signer = await startProtectedSigner(root, manifest, signal)'), 'all non-runtime-derived owner inputs must be audited before protected signer startup')
const developmentConfig = read('scripts/local-runtime/src/development-process-config.mjs')
for (const key of ['ASSET_MEDIA_LIFECYCLE_INTERVAL_MS', 'ASSET_MEDIA_OUTBOX_INTERVAL_MS', 'COLLABORATION_OUTBOX_INTERVAL_MS', 'SITE_PREVIEW_TOKEN_SECRET']) assert.match(developmentConfig, new RegExp(key, 'u'), `DEV process configuration gap is not classified: ${key}`)
assert.doesNotMatch(developmentConfig, /console\.|process\.env/u, 'DEV process configuration must not read ambient values or log secret-bearing environments')
assert.match(read('scripts/local-runtime/src/bootstrap.mjs'), /prisma['"],\s*['"]migrate['"],\s*['"]deploy/u)
const systemAdminBootstrap = read('scripts/local-runtime/src/bootstrap.mjs')
assert.match(systemAdminBootstrap, /buildSystemAdminSeedRuntimeBinding/u)
assert.match(systemAdminBootstrap, /verifySystemAdminSeedRuntimeBinding/u)
assert.match(systemAdminBootstrap, /SYSTEM_ADMIN_SEED_DATABASE_ALLOCATION_MISMATCH/u)
assert.match(systemAdminBootstrap, /logicalResourceIdentity\(manifest, 'postgres', target\.owner\)/u)
const systemAdminLauncher = read('scripts/local-runtime/launcher.mjs')
assert.match(systemAdminLauncher, /system-admin-seed[\s\S]*runSystemAdminSeed/u)
assert.match(systemAdminLauncher, /apply[\s\S]*validate[\s\S]*runSystemAdminSeed/u)
const systemAdminSeed = read('scripts/local/seed-system-admin.mjs')
assert.match(systemAdminSeed, /SYSTEM_ADMIN_SEED_MANIFEST_BINDING_REQUIRED/u)
assert.match(systemAdminSeed, /legacy-fixed-database-boundary/u)
assert.doesNotMatch(systemAdminSeed, /console\.log\([^\n]*(?:DATABASE_URL|OES_SYSTEM_ADMIN_SEED_BINDING)/u)

process.stdout.write(`LOCAL_RUNTIME_STATIC_OK files=${sources.length} services=${Object.keys(json('scripts/local-runtime/relationships.json').owners).length}\n`)
