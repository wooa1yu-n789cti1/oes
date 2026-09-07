import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveCredentialReference, resolveMigratorCredential } from './credentials.mjs'
import { reopenManifest, resolveEndpoint, resolveResources } from './manifest.mjs'
import { runChecked } from './process.mjs'
import { finalizePostgresRuntimePrivileges, queryPostgresDatabase } from './docker-driver.mjs'

/** Returns a minimal inherited process environment with runtime bindings stripped. */
export function cleanProcessEnvironment(source = process.env) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'SHELL', 'TERM', 'CI', 'NODE_OPTIONS', 'PNPM_HOME', 'COREPACK_HOME', 'LANG', 'LC_ALL']
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}

/** Discovers the exact committed Prisma migration owner for each selected service. */
export function discoverMigrationOwners(root, owners) {
  const results = []
  for (const owner of owners) {
    const packageFiles = []
    for (const base of ['src/services/system', 'src/services/business', 'src/services']) {
      const candidate = path.join(root, base, owner, 'package.json')
      if (fs.existsSync(candidate)) packageFiles.push(candidate)
    }
    const packageFile = [...new Set(packageFiles)][0]
    if (!packageFile) continue
    const schema = path.join(path.dirname(packageFile), 'prisma', 'schema.prisma')
    if (!fs.existsSync(schema)) continue
    const migrations = path.join(path.dirname(schema), 'migrations')
    if (!fs.existsSync(migrations)) throw new Error(`COMMITTED_MIGRATIONS_REQUIRED owner=${owner}`)
    results.push({ owner, packageFile, schema, migrations })
  }
  return results
}

/** Loads and digest-validates one committed Prisma baseline-resolution declaration. */
export function loadBaselineResolvePlan(service) {
  const target = path.join(service.migrations, 'baseline-resolve.json')
  if (!fs.existsSync(target)) return undefined
  const plan = JSON.parse(fs.readFileSync(target, 'utf8'))
  if (plan.strategy !== 'PRISMA_BASELINE_RESOLVE' || !/^[0-9A-Za-z_-]+$/u.test(plan.baselineMigration) || !/^[a-f0-9]{64}$/u.test(plan.baselineSha256) || !Array.isArray(plan.supersededMigrations) || plan.supersededMigrations.length === 0) throw new Error(`BASELINE_RESOLVE_PLAN_INVALID owner=${service.owner}`)
  const entries = [...plan.supersededMigrations, { name: plan.baselineMigration, sha256: plan.baselineSha256 }]
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error(`BASELINE_RESOLVE_PLAN_DUPLICATE owner=${service.owner}`)
  for (const entry of entries) {
    if (!/^[0-9A-Za-z_-]+$/u.test(entry.name) || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`BASELINE_RESOLVE_ENTRY_INVALID owner=${service.owner}`)
    const migrationPath = path.join(service.migrations, entry.name, 'migration.sql')
    if (!fs.existsSync(migrationPath)) throw new Error(`BASELINE_RESOLVE_MIGRATION_MISSING owner=${service.owner} migration=${entry.name}`)
    const actual = crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex')
    if (actual !== entry.sha256) throw new Error(`BASELINE_RESOLVE_DIGEST_MISMATCH owner=${service.owner} migration=${entry.name}`)
  }
  return plan
}

/** Selects the fail-closed baseline operation from exact migration history and schema presence. */
export function baselineResolutionAction(plan, appliedMigrations, userTableCount) {
  if (!plan) return 'NONE'
  if (!Number.isInteger(userTableCount) || userTableCount < 0) throw new Error('BASELINE_RESOLVE_TABLE_COUNT_INVALID')
  const applied = new Set(appliedMigrations)
  const superseded = plan.supersededMigrations.map((entry) => entry.name)
  if (applied.has(plan.baselineMigration)) {
    const missing = superseded.filter((name) => !applied.has(name))
    if (missing.length > 0) throw new Error(`BASELINE_HISTORY_INCOMPLETE missing=${missing.join(',')}`)
    return 'PRESENT'
  }
  return userTableCount === 0 ? 'APPLY_EMPTY_BASELINE' : 'ADOPT_MATCHING_SCHEMA'
}

/** Applies or adopts one sealed baseline before Prisma deploys later committed migrations. */
function prepareBaselineResolution(service, allocation, environment, root) {
  const plan = loadBaselineResolvePlan(service)
  if (!plan) return undefined
  const migrationTableExists = queryPostgresDatabase(allocation, `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL`)
  const appliedMigrations = migrationTableExists === 't'
    ? queryPostgresDatabase(allocation, 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name').split(/\r?\n/u).filter(Boolean)
    : []
  const userTableCount = Number(queryPostgresDatabase(allocation, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`))
  const action = baselineResolutionAction(plan, appliedMigrations, userTableCount)
  if (action === 'PRESENT') return { owner: service.owner, stage: 'BASELINE_PRESENT', action, exitStatus: 0 }
  if (action === 'APPLY_EMPTY_BASELINE') {
    const baselineFile = path.join(service.migrations, plan.baselineMigration, 'migration.sql')
    runChecked('pnpm', ['exec', 'prisma', 'db', 'execute', '--file', baselineFile, '--schema', service.schema], { cwd: root, env: environment, timeout: 300000 })
  } else {
    runChecked('pnpm', ['exec', 'prisma', 'migrate', 'diff', '--exit-code', '--from-url', environment.DATABASE_URL, '--to-schema-datamodel', service.schema], { cwd: root, env: environment, timeout: 300000 })
  }
  const applied = new Set(appliedMigrations)
  const targets = [...plan.supersededMigrations.map((entry) => entry.name), plan.baselineMigration]
  for (const migration of targets) {
    if (applied.has(migration)) continue
    runChecked('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--applied', migration, '--schema', service.schema], { cwd: root, env: environment, timeout: 300000 })
  }
  return { owner: service.owner, stage: 'BASELINE_RESOLVED', action, targets, exitStatus: 0 }
}

/** Generates selected Prisma clients and builds shared contracts before host DEV processes start. */
export function prepareDevelopmentArtifacts(manifestPath, { root }) {
  const manifest = reopenManifest(manifestPath)
  const results = []
  for (const [command, args] of [['pnpm', ['proto:gen']], ['pnpm', ['common:build']]]) {
    const result = runChecked(command, args, { cwd: root, env: cleanProcessEnvironment(), timeout: 600000 })
    results.push({ stage: 'DEVELOPMENT_BUILD', command: [command, ...args], exitStatus: result.status, output: result.stdout })
  }
  for (const service of discoverMigrationOwners(root, manifest.owners)) {
    const packageJson = JSON.parse(fs.readFileSync(service.packageFile, 'utf8'))
    if (!packageJson.scripts?.['prisma:generate']) continue
    const command = ['pnpm', '--filter', service.owner, 'prisma:generate']
    const result = runChecked(command[0], command.slice(1), { cwd: root, env: cleanProcessEnvironment(), timeout: 600000 })
    results.push({ owner: service.owner, stage: 'PRISMA_CLIENT_GENERATE', command, exitStatus: result.status, output: result.stdout })
  }
  return results
}

/** Applies committed migrations using migrator authority and then grants runtime-only access. */
export function applyCommittedMigrations(manifestPath, { root }) {
  const manifest = reopenManifest(manifestPath)
  const postgres = resolveEndpoint(manifest, 'postgres')
  if (!postgres) return []
  const results = []
  for (const service of discoverMigrationOwners(root, manifest.owners)) {
    const credentials = resolveMigratorCredential(manifest, service.owner)
    const environment = { ...cleanProcessEnvironment(), NODE_ENV: manifest.profile === 'DEV' ? 'development' : 'test', DATABASE_URL: credentials.DATABASE_URL, OES_TASK_KEY: manifest.taskKey, OES_RUN_ID: manifest.runId }
    const allocation = resolveResources(manifest, { includeStack: true }).find((resource) => resource.kind === 'database' && resource.runtime && resource.database && resource.database === new URL(credentials.DATABASE_URL).pathname.slice(1))
    if (!allocation) throw new Error(`MIGRATION_DATABASE_ALLOCATION_MISSING owner=${service.owner}`)
    const baseline = prepareBaselineResolution(service, allocation, environment, root)
    if (baseline) results.push(baseline)
    const result = runChecked('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', service.schema], { cwd: root, env: environment, timeout: 300000 })
    finalizePostgresRuntimePrivileges(allocation, manifest)
    results.push({ owner: service.owner, schema: path.relative(root, service.schema), command: ['pnpm', 'exec', 'prisma', 'migrate', 'deploy', '--schema', path.relative(root, service.schema)], exitStatus: result.status, output: result.stdout })
  }
  return results
}

/** Executes versioned Foundation Seed separately from run/test fixtures. */
export function applyFoundationSeeds(manifestPath, { root }) {
  const manifest = reopenManifest(manifestPath)
  const postgres = resolveEndpoint(manifest, 'postgres')
  if (!postgres) return []
  const declarations = {
    'permission-service': ['pnpm', ['--filter', 'permission-service', 'seed:apply', '--', '--apply']],
    'collaboration-service': ['pnpm', ['--filter', 'collaboration-service', 'seed:p1']]
  }
  const results = []
  for (const owner of manifest.owners) {
    const declared = declarations[owner]
    if (!declared) continue
    const credentials = resolveCredentialReference(postgres.credentialReference, owner)
    const result = runChecked(declared[0], declared[1], { cwd: root, env: { ...cleanProcessEnvironment(), NODE_ENV: manifest.profile === 'DEV' ? 'development' : 'test', DATABASE_URL: credentials.DATABASE_URL, OES_TASK_KEY: manifest.taskKey, OES_RUN_ID: manifest.runId }, timeout: 300000 })
    results.push({ owner, stage: 'FOUNDATION_SEED', command: declared, exitStatus: result.status, output: result.stdout })
  }
  return results
}

/** Reconciles versioned machine owner facts in Identity and writes a task-owned selector profile. */
export function reconcileMachineWorkloadSelectors(manifestPath, { root }) {
  const manifest = reopenManifest(manifestPath)
  if (!manifest.owners.includes('identity-service')) return null
  const postgres = resolveEndpoint(manifest, 'postgres')
  if (!postgres) throw new Error('MACHINE_SELECTOR_POSTGRES_REQUIRED')
  const credentials = resolveCredentialReference(postgres.credentialReference, 'identity-service')
  const output = path.join(manifest.runDirectory, 'bootstrap', 'machine-selectors-v2.json')
  const command = [
    process.execPath,
    path.join(root, 'scripts/local/machine-workload-inventory.mjs'),
    '--manifest', 'scripts/local/runtime-config/machine-workload-inventory/v2.json',
    '--previous-manifest', 'scripts/local/runtime-config/machine-workload-inventory/v1.json',
    '--deployment-revision', `local-${manifest.taskKey}-${manifest.runId}`,
    '--output', output
  ]
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
  const result = runChecked(command[0], command.slice(1), { cwd: root, env: { ...cleanProcessEnvironment(), NODE_ENV: 'development', DATABASE_URL: credentials.DATABASE_URL, OES_TASK_KEY: manifest.taskKey, OES_RUN_ID: manifest.runId }, timeout: 600000 })
  const selector = JSON.parse(fs.readFileSync(output, 'utf8'))
  if (!Array.isArray(selector.selectors) || selector.selectors.length === 0) throw new Error('MACHINE_SELECTOR_PROFILE_EMPTY')
  return { path: output, command, exitStatus: result.status, output: result.stdout, selectorCount: selector.selectors.length }
}

/** Builds the explicit multi-database environment for the declared tenant-web test fixture. */
export function tenantWebFixtureEnvironment(manifestPath) {
  const manifest = reopenManifest(manifestPath)
  const postgres = resolveEndpoint(manifest, 'postgres')
  if (!postgres) throw new Error('FIXTURE_POSTGRES_REQUIRED')
  const bindings = { AUTH_DATABASE_URL: 'auth-service', IDENTITY_DATABASE_URL: 'identity-service', PERMISSION_DATABASE_URL: 'permission-service', ITEM_MASTER_DATABASE_URL: 'item-master-service', TENANT_ORG_DATABASE_URL: 'tenant-org-service', PARTY_DATABASE_URL: 'party-service', HR_DATABASE_URL: 'hr-service' }
  const environment = { ...cleanProcessEnvironment(), NODE_ENV: 'test', OES_TASK_KEY: manifest.taskKey, OES_RUN_ID: manifest.runId }
  const databases = {}
  let port
  for (const [key, owner] of Object.entries(bindings)) {
    const credentials = resolveCredentialReference(postgres.credentialReference, owner)
    environment[key] = credentials.DATABASE_URL
    const url = new URL(credentials.DATABASE_URL)
    databases[key] = url.pathname.slice(1)
    port ??= url.port || '5432'
  }
  environment.OES_TENANT_WEB_AUTH_SEED_BINDING = JSON.stringify({ taskKey: manifest.taskKey, port, databases })
  return environment
}

/** Executes one named run/test fixture only after explicit selection. */
export function applyRunFixture(manifestPath, fixture, { root }) {
  if (fixture !== 'tenant-web-auth') throw new Error(`RUNTIME_FIXTURE_UNKNOWN fixture=${fixture}`)
  const environment = tenantWebFixtureEnvironment(manifestPath)
  const result = runChecked('node', ['scripts/local/seed-tenant-web-auth-test-data.mjs'], { cwd: root, env: environment, timeout: 600000 })
  return [{ fixture, stage: 'RUN_TEST_FIXTURE', command: ['node', 'scripts/local/seed-tenant-web-auth-test-data.mjs'], exitStatus: result.status, output: result.stdout }]
}
