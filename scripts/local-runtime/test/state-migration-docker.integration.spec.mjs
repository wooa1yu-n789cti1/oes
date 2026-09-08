import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fingerprint, writeAtomic } from '../src/canonical.mjs'
import { activateStagedState, inventoryStateLayout, migrationReplacementName, planStateLayoutMigration, recoverStateLayout, rollbackCommittedState, stageStateLayoutMigration } from '../src/state-migration.mjs'

const MYSQL_IMAGE = 'mysql:8.0@sha256:a3dff78d876222746a0bacc36dd7e4bf9e673c85fb7ee0d12ed25bd32c43c19b'
const NACOS_IMAGE = 'nacos/nacos-server:v2.5.1@sha256:8987908cb94ed5f9d30522a64493d35732a6c05f216d667a7addb022f3d92e80'
const enabled = process.env.OES_REAL_DOCKER_STATE_MIGRATION === '1'

/** Runs one Docker command and returns its literal standard output. */
function docker(args, { allowFailure = false, timeout = 180000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout })
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`DOCKER_FIXTURE_COMMAND_FAILED args=${JSON.stringify(args)} status=${result.status} stderr=${result.stderr}`)
  return result
}

/** Polls one synchronous predicate until it returns a truthy result. */
function waitFor(check, description, timeoutMs = 180000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try { if (check()) return } catch (error) { if (error.fatal) throw error; lastError = error }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  throw new Error(`DOCKER_FIXTURE_READINESS_TIMEOUT description=${description} last=${lastError?.message || 'not-ready'}`)
}

/** Builds the exact legacy-layout Nacos and Nacos-MySQL fixture plus its migration inputs. */
async function createFixture(baseDirectory, scenario, registerCleanup) {
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const devStackId = `fixture-${token}`
  const parent = fs.mkdtempSync(path.join(baseDirectory, `${scenario}-`))
  const stateRoot = path.join(parent, 'runtime-v2')
  const networkName = `oes-v2-fixture-${token}-nacos`
  const mysqlName = `oes-v2-legacy-${token}-nacos-mysql`
  const nacosName = `oes-v2-legacy-${token}-nacos`
  const volumeName = `oes-v2-fixture-${token}-nacos-mysql-data`
  const rootPassword = `Root-${token}-A9!`
  const nacosPassword = `Nacos-${token}-A9!`
  const authToken = Buffer.from(`fixture-auth-token-${token}-0123456789abcdef`).toString('base64')
  const parentStat = fs.lstatSync(parent)
  const fixtureIdentity = { scenario, token, devStackId, parent, parentIdentity: { realpath: fs.realpathSync(parent), dev: parentStat.dev, ino: parentStat.ino }, stateRoot, networkName, mysqlName, nacosName, volumeName, rootPassword, nacosPassword, containers: [], networks: [], volumes: [], journalPaths: [] }
  registerCleanup(fixtureIdentity)
  const providerRoot = path.join(stateRoot, 'shared', devStackId)
  const schemaPath = path.join(providerRoot, 'nacos', 'mysql-schema.sql')
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true })
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../../docker/nacos/mysql-schema.sql'), schemaPath)
  writeAtomic(path.join(stateRoot, 'machine', 'dev-stack.json'), { schemaVersion: 2, devStackId })
  const labels = (provider) => ({ 'oes.runtime.version': '2', 'oes.runtime.dev-stack-id': devStackId, 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'dev', 'oes.runtime.provider': provider })
  const labelArgs = (values) => Object.entries(values).flatMap(([key, value]) => ['--label', `${key}=${value}`])
  const networkId = docker(['network', 'create', ...labelArgs(labels('nacos')), networkName]).stdout.trim()
  fixtureIdentity.networks.push({ objectId: networkId, name: networkName, provider: 'nacos' })
  docker(['volume', 'create', ...labelArgs(labels('nacos-mysql')), volumeName])
  const createdVolume = JSON.parse(docker(['volume', 'inspect', volumeName]).stdout)[0]
  fixtureIdentity.volumes.push({ name: volumeName, provider: 'nacos-mysql', objectId: fingerprint({ name: createdVolume.Name, createdAt: createdVolume.CreatedAt, driver: createdVolume.Driver, scope: createdVolume.Scope, labels: createdVolume.Labels || {} }) })
  const mysqlId = docker(['run', '--detach', '--name', mysqlName, ...labelArgs(labels('nacos-mysql')), '--network', networkName, '--network-alias', 'nacos-mysql', '--mount', `type=volume,src=${volumeName},dst=/var/lib/mysql`, '--mount', `type=bind,src=${schemaPath},dst=/docker-entrypoint-initdb.d/01-nacos-schema.sql,readonly`, '--env', `MYSQL_ROOT_PASSWORD=${rootPassword}`, '--env', 'MYSQL_DATABASE=nacos', '--env', 'MYSQL_USER=nacos', '--env', `MYSQL_PASSWORD=${nacosPassword}`, MYSQL_IMAGE]).stdout.trim()
  fixtureIdentity.containers.push({ objectId: mysqlId, names: [mysqlName], provider: 'nacos-mysql' })
  waitFor(() => docker(['exec', mysqlName, 'mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root', `-p${rootPassword}`, '--silent'], { allowFailure: true, timeout: 10000 }).status === 0, `${scenario}-mysql-initial`)
  const nacosId = docker(['run', '--detach', '--name', nacosName, ...labelArgs(labels('nacos')), '--network', networkName, '--network-alias', 'nacos', '--publish', '127.0.0.1::8848', '--env', 'MODE=standalone', '--env', 'PREFER_HOST_MODE=ip', '--env', 'SPRING_DATASOURCE_PLATFORM=mysql', '--env', `MYSQL_SERVICE_HOST=${mysqlName}`, '--env', 'MYSQL_SERVICE_PORT=3306', '--env', 'MYSQL_SERVICE_DB_NAME=nacos', '--env', 'MYSQL_SERVICE_USER=nacos', '--env', `MYSQL_SERVICE_PASSWORD=${nacosPassword}`, '--env', 'MYSQL_SERVICE_DB_PARAM=characterEncoding=utf8&connectTimeout=1000&socketTimeout=3000&autoReconnect=true&useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC', '--env', 'NACOS_AUTH_ENABLE=true', '--env', `NACOS_AUTH_TOKEN=${authToken}`, '--env', 'NACOS_AUTH_IDENTITY_KEY=serverIdentity', '--env', `NACOS_AUTH_IDENTITY_VALUE=${token}`, '--env', 'JVM_XMS=256m', '--env', 'JVM_XMX=256m', '--env', 'JVM_XMN=128m', NACOS_IMAGE]).stdout.trim()
  fixtureIdentity.containers.push({ objectId: nacosId, names: [nacosName], provider: 'nacos' })
  const nacosPort = docker(['port', nacosName, '8848/tcp']).stdout.trim().match(/127\.0\.0\.1:(\d+)$/u)?.[1]
  assert.ok(nacosPort)
  try {
    waitFor(() => {
      const state = JSON.parse(docker(['inspect', '--type', 'container', nacosName]).stdout)[0].State
      if (!state.Running) { const failure = new Error(`NACOS_FIXTURE_EXITED status=${state.Status} exitCode=${state.ExitCode}`); failure.fatal = true; throw failure }
      return spawnSync('curl', ['--fail', '--silent', '--show-error', `http://127.0.0.1:${nacosPort}/nacos/v1/console/health/readiness`], { encoding: 'utf8', timeout: 5000 }).status === 0
    }, `${scenario}-nacos-initial`)
  } catch (error) {
    const inspection = docker(['inspect', '--type', 'container', nacosName], { allowFailure: true }).stdout
    const logResult = docker(['logs', '--tail', '200', nacosName], { allowFailure: true })
    const logs = `${logResult.stdout}\n${logResult.stderr}`
    throw new Error(`${error.message}\nNACOS_INSPECT=${inspection}\nNACOS_LOGS=${logs}`)
  }
  docker(['stop', '--time', '20', mysqlName])
  assert.equal(JSON.parse(docker(['inspect', '--type', 'container', nacosName]).stdout)[0].State.Running, true)
  const mysql = JSON.parse(docker(['inspect', '--type', 'container', mysqlName]).stdout)[0]
  const nacos = JSON.parse(docker(['inspect', '--type', 'container', nacosName]).stdout)[0]
  const network = JSON.parse(docker(['network', 'inspect', networkName]).stdout)[0]
  const volume = JSON.parse(docker(['volume', 'inspect', volumeName]).stdout)[0]
  const volumeObjectId = fingerprint({ name: volume.Name, createdAt: volume.CreatedAt, driver: volume.Driver, scope: volume.Scope, labels: volume.Labels || {} })
  const mysqlResource = { provider: 'nacos-mysql', kind: 'container', scope: 'SHARED', pool: 'dev', objectId: mysql.Id, name: mysqlName, labels: mysql.Config.Labels, volume: { name: volumeName, objectId: volumeObjectId, labels: volume.Labels, createdAt: volume.CreatedAt, driver: volume.Driver, scope: volume.Scope } }
  const nacosResource = { provider: 'nacos', kind: 'container', scope: 'SHARED', pool: 'dev', objectId: nacos.Id, name: nacosName, labels: nacos.Config.Labels }
  const networkResource = { provider: 'nacos', kind: 'network', scope: 'SHARED', pool: 'dev', objectId: network.Id, name: networkName, labels: network.Labels }
  writeAtomic(path.join(providerRoot, 'nacos-mysql', 'identity.json'), mysqlResource)
  writeAtomic(path.join(providerRoot, 'nacos', 'identity.json'), nacosResource)
  writeAtomic(path.join(providerRoot, 'nacos', 'network-identity.json'), networkResource)
  const dockerObjects = [{ ...mysql, type: 'container' }, { ...nacos, type: 'container' }, { ...network, type: 'network' }, { ...volume, type: 'volume' }]
  const providerSnapshots = [
    { resource: networkResource },
    { resource: mysqlResource },
    { resource: nacosResource },
    { endpoint: { provider: 'nacos', pool: 'dev', ready: true, authority: `docker:${nacos.Id}:8848/tcp`, host: '127.0.0.1', port: Number(nacosPort), owners: ['fixture-owner'], environment: { NACOS_SERVER: `127.0.0.1:${nacosPort}` } } }
  ]
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: '0'.repeat(64), hostBinding: { kind: 'fixture-v1', value: `docker-${token}` } })
  fixtureIdentity.journalPaths.push(staged.journalPath)
  return { ...fixtureIdentity, nacosPort, mysqlId: mysql.Id, nacosId: nacos.Id, inventory, plan, staged }
}

/** Reopens fixture containers, DNS aliases, and Nacos readiness for the selected authority. */
function verifyFixtureAuthority(fixture, authority, journal) {
  const targetRecord = (journal.providerActivation || []).find((record) => record.oldObjectId === fixture.mysqlId)
  const mysqlId = authority === 'NEW' ? targetRecord.newObjectId : fixture.mysqlId
  const mysqlName = authority === 'NEW' ? targetRecord.newName : fixture.mysqlName
  const mysql = JSON.parse(docker(['inspect', '--type', 'container', mysqlId]).stdout)[0]
  const nacos = JSON.parse(docker(['inspect', '--type', 'container', fixture.nacosId]).stdout)[0]
  assert.equal(String(mysql.Name).replace(/^\//u, ''), mysqlName)
  assert.equal(mysql.State.Running, true)
  assert.equal(nacos.State.Running, true)
  assert.deepEqual((nacos.Config.Env || []).filter((entry) => entry.startsWith('MYSQL_SERVICE_HOST=')), [`MYSQL_SERVICE_HOST=${fixture.mysqlName}`])
  assert.ok(mysql.NetworkSettings.Networks[fixture.networkName].Aliases.includes(fixture.mysqlName) || mysqlName === fixture.mysqlName)
  waitFor(() => docker(['exec', mysqlId, 'mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root', `-p${fixture.rootPassword}`, '--silent'], { allowFailure: true, timeout: 10000 }).status === 0, `${fixture.scenario}-${authority.toLowerCase()}-mysql`)
  waitFor(() => docker(['exec', fixture.nacosId, 'getent', 'hosts', fixture.mysqlName], { allowFailure: true, timeout: 10000 }).status === 0, `${fixture.scenario}-${authority.toLowerCase()}-dns`)
  waitFor(() => spawnSync('curl', ['--fail', '--silent', '--show-error', `http://127.0.0.1:${fixture.nacosPort}/nacos/v1/console/health/readiness`], { encoding: 'utf8', timeout: 5000 }).status === 0, `${fixture.scenario}-${authority.toLowerCase()}-nacos`)
  return { mysqlId, mysqlName, aliases: mysql.NetworkSettings.Networks[fixture.networkName].Aliases, nacosId: nacos.Id }
}

/** Deletes only the exact container, network, volume, and filesystem roster created by one fixture. */
function cleanupFixture(fixture) {
  const containers = new Map(fixture.containers.map((record) => [record.objectId, record]))
  for (const journalPath of fixture.journalPaths) {
    if (!fs.existsSync(journalPath)) continue
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    for (const record of journal.providerActivation || []) {
      const original = containers.get(record.oldObjectId)
      if (original) containers.set(record.oldObjectId, { ...original, names: [...new Set([...original.names, record.oldName, record.backupName])] })
      if (record.newObjectId) containers.set(record.newObjectId, { objectId: record.newObjectId, names: [record.newName], provider: record.provider })
    }
  }
  for (const record of [...containers.values()].reverse()) {
    const result = docker(['inspect', '--type', 'container', record.objectId], { allowFailure: true })
    if (result.status !== 0) { assert.match(`${result.stdout}\n${result.stderr}`, /no such (?:object|container)|not found/iu); continue }
    const observed = JSON.parse(result.stdout)[0]
    assert.equal(observed.Id, record.objectId)
    assert.equal(record.names.includes(String(observed.Name).replace(/^\//u, '')), true)
    assert.equal(observed.Config.Labels['oes.runtime.dev-stack-id'], fixture.devStackId)
    assert.equal(observed.Config.Labels['oes.runtime.provider'], record.provider)
    docker(['rm', '--force', record.objectId])
  }
  for (const record of fixture.networks) {
    const result = docker(['network', 'inspect', record.objectId], { allowFailure: true })
    if (result.status !== 0) { assert.match(`${result.stdout}\n${result.stderr}`, /no such network|not found/iu); continue }
    const observed = JSON.parse(result.stdout)[0]
    assert.equal(observed.Id, record.objectId)
    assert.equal(observed.Name, record.name)
    assert.equal(observed.Labels['oes.runtime.dev-stack-id'], fixture.devStackId)
    assert.equal(observed.Labels['oes.runtime.provider'], record.provider)
    docker(['network', 'rm', record.objectId])
  }
  for (const record of fixture.volumes) {
    const result = docker(['volume', 'inspect', record.name], { allowFailure: true })
    if (result.status !== 0) { assert.match(`${result.stdout}\n${result.stderr}`, /no such volume|not found/iu); continue }
    const observed = JSON.parse(result.stdout)[0]
    assert.equal(fingerprint({ name: observed.Name, createdAt: observed.CreatedAt, driver: observed.Driver, scope: observed.Scope, labels: observed.Labels || {} }), record.objectId)
    assert.equal(observed.Labels['oes.runtime.dev-stack-id'], fixture.devStackId)
    assert.equal(observed.Labels['oes.runtime.provider'], record.provider)
    docker(['volume', 'rm', record.name])
  }
  const parentStat = fs.lstatSync(fixture.parent)
  assert.equal(parentStat.isSymbolicLink(), false)
  assert.equal(fs.realpathSync(fixture.parent), fixture.parentIdentity.realpath)
  assert.equal(parentStat.dev, fixture.parentIdentity.dev)
  assert.equal(parentStat.ino, fixture.parentIdentity.ino)
  fs.rmSync(fixture.parent, { recursive: true, force: true })
}

test('real Docker preserves Nacos to replaced Nacos-MySQL identity through activation, recovery, and rollback', { skip: !enabled, timeout: 900000 }, async (context) => {
  const baseDirectory = process.env.OES_DOCKER_MIGRATION_FIXTURE_ROOT ? path.resolve(process.env.OES_DOCKER_MIGRATION_FIXTURE_ROOT) : os.tmpdir()
  fs.mkdirSync(baseDirectory, { recursive: true })
  const fixtures = []
  context.after(() => { for (const fixture of fixtures.reverse()) cleanupFixture(fixture) })

  const preCommit = await createFixture(baseDirectory, 'precommit', (fixture) => fixtures.push(fixture))
  assert.equal(preCommit.plan.providerDependencies.length, 1)
  assert.equal(preCommit.plan.providerDependencies[0].hostname, preCommit.mysqlName)
  assert.throws(() => activateStagedState({ journalPath: preCommit.staged.journalPath, confirmation: { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', status: 'CONFIRMED', journalFingerprint: preCommit.staged.journal.journalFingerprint, confirmationFingerprint: fingerprint({ schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', status: 'CONFIRMED', journalFingerprint: preCommit.staged.journal.journalFingerprint }) }, faultAt: 'after-provider-activation' }), /STATE_MIGRATION_FAULT_AFTER_PROVIDER_ACTIVATION/u)
  const recovered = recoverStateLayout({ journalPath: preCommit.staged.journalPath })
  assert.equal(recovered.authority, 'OLD')
  const recoveredIdentity = verifyFixtureAuthority(preCommit, 'OLD', JSON.parse(fs.readFileSync(preCommit.staged.journalPath, 'utf8')))
  assert.equal(recoveredIdentity.mysqlId, preCommit.mysqlId)
  assert.equal(recoverStateLayout({ journalPath: preCommit.staged.journalPath }).state, 'RECOVERED_OLD')

  const committedFixture = await createFixture(baseDirectory, 'committed', (fixture) => fixtures.push(fixture))
  const activationRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', status: 'CONFIRMED', journalFingerprint: committedFixture.staged.journal.journalFingerprint }
  const activated = activateStagedState({ journalPath: committedFixture.staged.journalPath, confirmation: { ...activationRaw, confirmationFingerprint: fingerprint(activationRaw) } })
  assert.equal(activated.state, 'COMMITTED')
  const activatedIdentity = verifyFixtureAuthority(committedFixture, 'NEW', activated)
  assert.notEqual(activatedIdentity.mysqlId, committedFixture.mysqlId)
  assert.ok(activatedIdentity.aliases.includes(committedFixture.mysqlName))
  assert.equal(recoverStateLayout({ journalPath: committedFixture.staged.journalPath }).authority, 'NEW')
  const rollbackRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', status: 'CONFIRMED', journalFingerprint: activated.journalFingerprint }
  const rolledBack = rollbackCommittedState({ journalPath: committedFixture.staged.journalPath, confirmation: { ...rollbackRaw, confirmationFingerprint: fingerprint(rollbackRaw) } })
  assert.equal(rolledBack.state, 'ROLLED_BACK')
  const rolledBackIdentity = verifyFixtureAuthority(committedFixture, 'OLD', rolledBack)
  assert.equal(rolledBackIdentity.mysqlId, committedFixture.mysqlId)
  assert.equal(recoverStateLayout({ journalPath: committedFixture.staged.journalPath }).state, 'ROLLED_BACK')
})
