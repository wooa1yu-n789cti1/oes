import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import {
  coordinationOrderedSetFingerprint,
  loadTrustedCoordinationIntegrationAuthorization,
  loadTrustedCoordinationIntegrationResults,
  planCoordinationIntegration,
  validateCoordinationIntegrationAuthorization
} from '../coordination-integration.ts'
import { stableOwnerTaskTempLeaf } from '../resource-topology.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import type {
  CoordinationDeliveryCandidate,
  CoordinationIntegrationAuthorization,
  CoordinationIntegrationItemResult,
  CoordinationIntegrationResultSet,
  CoordinationScopedRvResult,
  RemoteTrustRoots,
  TrustedAuthorizationReference
} from '../types.ts'
import type { OwnerResourceBinding, OwnerResourceReference } from '../resource-topology.types.ts'

const schema = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'schemas', name), 'utf8')
  ) as Record<string, unknown>

/** Runs one fixture Git command and returns literal stdout. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** Runs one fixture Git command while preserving stdout bytes for hash proofs. */
function gitRaw(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** Writes one canonically fingerprinted trusted artifact. */
function trustedRecord<T extends Record<string, unknown>>(
  root: string,
  name: string,
  value: T,
  field: keyof T & string
): { value: T; reference: TrustedAuthorizationReference } {
  value[field] = objectFingerprint(value, field) as T[keyof T & string]
  const path = join(root, name)
  const bytes = `${canonicalJson(value)}\n`
  writeFileSync(path, bytes)
  return {
    value,
    reference: { path, sha256: sha256(bytes), fingerprint: String(value[field]) }
  }
}

interface IntegrationFixture {
  repositoryRoot: string
  authorizationRoot: string
  trust: RemoteTrustRoots
  authorization: CoordinationIntegrationAuthorization
  authorizationReference: TrustedAuthorizationReference
  scopedRvRecords: CoordinationScopedRvResult[]
  baseSha: string
  candidateShas: string[]
  mergeShas: string[]
}

/** Builds a real two-candidate Git graph and protected integration evidence. */
function integrationFixture(
  t: TestContext,
  prTopology: 'AGGREGATE' | 'INDEPENDENT' = 'AGGREGATE'
): IntegrationFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-co-integration-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repositoryRoot = join(root, 'owner')
  const artifactRoot = join(root, 'artifacts')
  const authorizationRoot = join(root, 'authorization')
  mkdirSync(repositoryRoot)
  mkdirSync(artifactRoot)
  mkdirSync(authorizationRoot)
  git(repositoryRoot, ['init', '-b', 'main'])
  git(repositoryRoot, ['config', 'user.email', 'runtime@example.test'])
  git(repositoryRoot, ['config', 'user.name', 'Runtime Test'])
  writeFileSync(join(repositoryRoot, 'README.md'), '# fixture\n')
  git(repositoryRoot, ['add', 'README.md'])
  git(repositoryRoot, ['commit', '-m', 'base'])
  const baseSha = git(repositoryRoot, ['rev-parse', 'HEAD'])
  const candidates: Array<{ key: string; sha: string; patch: string; content: string }> = []
  for (const key of ['api', 'web']) {
    git(repositoryRoot, ['checkout', '-b', `codex/delivery/${key}`, baseSha])
    writeFileSync(join(repositoryRoot, `${key}.txt`), `${key}\n`)
    git(repositoryRoot, ['add', `${key}.txt`])
    git(repositoryRoot, ['commit', '-m', key])
    const candidateSha = git(repositoryRoot, ['rev-parse', 'HEAD'])
    const patch = sha256(
      gitRaw(repositoryRoot, [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        baseSha,
        candidateSha,
        '--'
      ])
    )
    const content = sha256(
      gitRaw(repositoryRoot, [
        'diff',
        '--raw',
        '--full-index',
        '--no-renames',
        baseSha,
        candidateSha,
        '--'
      ])
    )
    candidates.push({ key, sha: candidateSha, patch, content })
  }
  git(repositoryRoot, ['checkout', '-b', 'codex/coordination/release', baseSha])
  const mergeShas: string[] = []
  for (const candidate of candidates) {
    git(repositoryRoot, ['merge', '--no-ff', '--no-edit', candidate.sha])
    mergeShas.push(git(repositoryRoot, ['rev-parse', 'HEAD']))
  }

  const scopedRvRecords: CoordinationScopedRvResult[] = []
  const items: CoordinationDeliveryCandidate[] = candidates.map((candidate, order) => {
    const ownerTaskId = `/root/co/do-${candidate.key}`
    const rv = trustedRecord(
      authorizationRoot,
      `scoped-rv-${candidate.key}.json`,
      {
        schemaVersion: 2,
        kind: 'OES_COORDINATION_SCOPED_RV_RESULT',
        resultFingerprint: '',
        status: 'PASSED',
        coordinationKey: 'release',
        deliveryKey: candidate.key,
        deliveryOwnerTaskId: ownerTaskId,
        reviewerTaskId: `${ownerTaskId}/rv-1`,
        candidateSha: candidate.sha,
        patchFingerprint: candidate.patch,
        contentFingerprint: candidate.content
      } satisfies CoordinationScopedRvResult as unknown as Record<string, unknown>,
      'resultFingerprint'
    )
    const rvValue = rv.value as unknown as CoordinationScopedRvResult
    scopedRvRecords.push(rvValue)
    return {
      order,
      deliveryKey: candidate.key,
      ownerTaskId,
      baseSha,
      candidateSha: candidate.sha,
      patchFingerprint: candidate.patch,
      contentFingerprint: candidate.content,
      dependencies: order ? ['api'] : [],
      scopedRv: rv.reference,
      independentlyReleasable: true
    }
  })
  const authorizationRecord = trustedRecord(
    authorizationRoot,
    'coordination-integration-authorization.json',
    {
      schemaVersion: 2,
      kind: 'OES_COORDINATION_INTEGRATION_AUTHORIZATION',
      authorizationFingerprint: '',
      status: 'ISSUED',
      expectedState: 'COORDINATION_INTEGRATION_AUTHORIZED',
      stateVersion: 1,
      coordinationKey: 'release',
      coordinationOwnerTaskId: '/root/co',
      transitionId: 'coordination:integrate:1',
      confirmationFingerprint: 'a'.repeat(64),
      baseSha,
      aggregateBranch: 'codex/coordination/release',
      prTopology,
      independentPrExceptionConfirmed: prTopology === 'INDEPENDENT',
      orderedSetFingerprint: coordinationOrderedSetFingerprint(items),
      items
    } satisfies CoordinationIntegrationAuthorization as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  const authorization = authorizationRecord.value as unknown as CoordinationIntegrationAuthorization

  const ownerBinding: OwnerResourceBinding = {
    schemaVersion: 1,
    kind: 'OES_OWNER_RESOURCE_BINDING',
    bindingFingerprint: '',
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerTaskId: '/root/co',
    directParentTaskId: '/root',
    transitionId: authorization.transitionId,
    repositoryRoot,
    repositoryRemoteUrl: 'https://github.com/example/oes.git',
    ownerClone: repositoryRoot,
    ownerGitDirectory: join(repositoryRoot, '.git'),
    ownerRef: 'refs/heads/codex/coordination/release',
    artifactRoot,
    taskTempRoot: `/private/tmp/${stableOwnerTaskTempLeaf('/root/co')}`,
    deliveryPackagePath: join(artifactRoot, 'aggregate-delivery-package.json'),
    currentEvidenceManifestPath: join(artifactRoot, 'current.json'),
    checkpointBundlePath: join(artifactRoot, 'checkpoint.json'),
    gitBundlePath: join(artifactRoot, 'owner.bundle')
  }
  ownerBinding.bindingFingerprint = objectFingerprint(
    ownerBinding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  const ownerPath = join(artifactRoot, 'owner-resource-binding.json')
  const ownerBytes = `${canonicalJson(ownerBinding)}\n`
  writeFileSync(ownerPath, ownerBytes)
  const ownerReference: OwnerResourceReference = {
    path: ownerPath,
    sha256: sha256(ownerBytes),
    fingerprint: ownerBinding.bindingFingerprint
  }
  const trust: RemoteTrustRoots = {
    projectKey: 'oes',
    authorizationRoot,
    admissionRoot: join(root, 'admission'),
    profilePath: join(root, 'profile.toml'),
    profileSha256: 'b'.repeat(64),
    ownerTaskId: '/root/co',
    profileTransitionId: authorization.transitionId,
    profileExpectedState: 'DELIVERY_ACTIVE',
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerResourceBinding: ownerReference
  }
  return {
    repositoryRoot,
    authorizationRoot,
    trust,
    authorization,
    authorizationReference: authorizationRecord.reference,
    scopedRvRecords,
    baseSha,
    candidateShas: candidates.map((item) => item.sha),
    mergeShas
  }
}

/** Writes and reopens one trusted integration result set. */
function loadResults(
  fixture: IntegrationFixture,
  authorization: CoordinationIntegrationAuthorization,
  name: string,
  results: CoordinationIntegrationItemResult[]
): CoordinationIntegrationItemResult[] {
  const set = trustedRecord(
    fixture.authorizationRoot,
    name,
    {
      schemaVersion: 2,
      kind: 'OES_COORDINATION_INTEGRATION_RESULT_SET',
      resultSetFingerprint: '',
      authorizationFingerprint: authorization.authorizationFingerprint,
      coordinationKey: authorization.coordinationKey,
      coordinationOwnerTaskId: authorization.coordinationOwnerTaskId,
      transitionId: authorization.transitionId,
      results
    } satisfies CoordinationIntegrationResultSet as unknown as Record<string, unknown>,
    'resultSetFingerprint'
  )
  validateJsonSchema(
    schema('coordination-integration-result-set.schema.json'),
    set.value as unknown as CoordinationIntegrationResultSet
  )
  return loadTrustedCoordinationIntegrationResults(set.reference, authorization, fixture.trust)
}

const integrated = (
  fixture: IntegrationFixture,
  index: number,
  sha: string
): CoordinationIntegrationItemResult => ({
  order: index,
  deliveryKey: ['api', 'web'][index],
  candidateSha: fixture.candidateShas[index],
  state: 'INTEGRATED_VERIFIED',
  integratedSha: sha,
  failureCode: null
})

test('CO readiness reopens protected authorization/RV/results and verifies a real Git merge chain', (t) => {
  const fixture = integrationFixture(t)
  validateJsonSchema(
    schema('coordination-integration-authorization.schema.json'),
    fixture.authorization
  )
  fixture.scopedRvRecords.forEach((value) =>
    validateJsonSchema(schema('coordination-scoped-rv-result.schema.json'), value)
  )
  const loaded = loadTrustedCoordinationIntegrationAuthorization(
    fixture.authorizationReference,
    fixture.trust
  )
  const empty = loadResults(fixture, loaded.authorization, 'results-empty.json', [])
  assert.equal(
    planCoordinationIntegration(loaded.authorization, empty, loaded.repositoryRoot).nextItem
      ?.deliveryKey,
    'api'
  )

  git(fixture.repositoryRoot, ['checkout', 'main'])
  git(fixture.repositoryRoot, ['branch', '-f', 'codex/coordination/release', fixture.mergeShas[0]])
  const first = loadResults(fixture, loaded.authorization, 'results-first.json', [
    integrated(fixture, 0, fixture.mergeShas[0])
  ])
  assert.equal(
    planCoordinationIntegration(loaded.authorization, first, loaded.repositoryRoot).nextItem
      ?.deliveryKey,
    'web'
  )

  git(fixture.repositoryRoot, ['branch', '-f', 'codex/coordination/release', fixture.mergeShas[1]])
  const complete = loadResults(fixture, loaded.authorization, 'results-complete.json', [
    integrated(fixture, 0, fixture.mergeShas[0]),
    integrated(fixture, 1, fixture.mergeShas[1])
  ])
  const final = planCoordinationIntegration(loaded.authorization, complete, loaded.repositoryRoot)
  assert.equal(final.status, 'AGGREGATE_CANDIDATE_READY')
  assert.equal(final.pullRequestCount, 1)
})

test('caller-authored authorization/results and a non-merge SHA cannot reach READY', (t) => {
  const fixture = integrationFixture(t)
  assert.throws(
    () => planCoordinationIntegration(fixture.authorization, [], fixture.repositoryRoot),
    /COORDINATION_INTEGRATION_TRUSTED_INPUT_REQUIRED/
  )
  const loaded = loadTrustedCoordinationIntegrationAuthorization(
    fixture.authorizationReference,
    fixture.trust
  )
  git(fixture.repositoryRoot, ['checkout', 'main'])
  git(fixture.repositoryRoot, [
    'branch',
    '-f',
    'codex/coordination/release',
    fixture.candidateShas[0]
  ])
  const forged = loadResults(fixture, loaded.authorization, 'results-forged.json', [
    integrated(fixture, 0, fixture.candidateShas[0])
  ])
  assert.throws(
    () => planCoordinationIntegration(loaded.authorization, forged, loaded.repositoryRoot),
    /COORDINATION_INTEGRATION_MERGE_CHAIN_MISMATCH/
  )
})

test('scoped RV is bound to exact candidate and content fingerprints', (t) => {
  const fixture = integrationFixture(t)
  const rvPath = fixture.authorization.items[0].scopedRv.path
  const rv = JSON.parse(readFileSync(rvPath, 'utf8')) as CoordinationScopedRvResult
  rv.candidateSha = fixture.candidateShas[1]
  rv.resultFingerprint = objectFingerprint(
    rv as unknown as Record<string, unknown>,
    'resultFingerprint'
  )
  const bytes = `${canonicalJson(rv)}\n`
  writeFileSync(rvPath, bytes)
  const authorization = structuredClone(fixture.authorization)
  authorization.items[0].scopedRv = {
    path: rvPath,
    sha256: sha256(bytes),
    fingerprint: rv.resultFingerprint
  }
  authorization.orderedSetFingerprint = coordinationOrderedSetFingerprint(authorization.items)
  authorization.authorizationFingerprint = objectFingerprint(
    authorization as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  const authBytes = `${canonicalJson(authorization)}\n`
  writeFileSync(fixture.authorizationReference.path, authBytes)
  const reference = {
    path: fixture.authorizationReference.path,
    sha256: sha256(authBytes),
    fingerprint: authorization.authorizationFingerprint
  }
  assert.throws(
    () => loadTrustedCoordinationIntegrationAuthorization(reference, fixture.trust),
    /COORDINATION_SCOPED_RV_BINDING_MISMATCH/
  )
})

test('independent PR topology requires the exception and uses exact candidate heads', (t) => {
  const fixture = integrationFixture(t, 'INDEPENDENT')
  const loaded = loadTrustedCoordinationIntegrationAuthorization(
    fixture.authorizationReference,
    fixture.trust
  )
  const results = loadResults(fixture, loaded.authorization, 'results-independent.json', [
    integrated(fixture, 0, fixture.candidateShas[0]),
    integrated(fixture, 1, fixture.candidateShas[1])
  ])
  const plan = planCoordinationIntegration(loaded.authorization, results, loaded.repositoryRoot)
  assert.equal(plan.status, 'INDEPENDENT_PRS_READY')
  assert.equal(plan.pullRequestCount, 2)

  const invalid = structuredClone(fixture.authorization)
  invalid.independentPrExceptionConfirmed = false
  invalid.authorizationFingerprint = objectFingerprint(
    invalid as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  assert.throws(
    () => validateCoordinationIntegrationAuthorization(invalid),
    /COORDINATION_INDEPENDENT_PR_EXCEPTION_UNPROVEN/
  )
})

test('a trusted failed integration preserves the real verified prefix and blocks the suffix', (t) => {
  const fixture = integrationFixture(t)
  const loaded = loadTrustedCoordinationIntegrationAuthorization(
    fixture.authorizationReference,
    fixture.trust
  )
  git(fixture.repositoryRoot, ['checkout', 'main'])
  git(fixture.repositoryRoot, ['branch', '-f', 'codex/coordination/release', fixture.mergeShas[0]])
  const results = loadResults(fixture, loaded.authorization, 'results-failed.json', [
    integrated(fixture, 0, fixture.mergeShas[0]),
    {
      order: 1,
      deliveryKey: 'web',
      candidateSha: fixture.candidateShas[1],
      state: 'FAILED',
      integratedSha: null,
      failureCode: 'CONFLICT'
    }
  ])
  const plan = planCoordinationIntegration(loaded.authorization, results, loaded.repositoryRoot)
  assert.equal(plan.status, 'STOPPED_FAILURE')
  assert.deepEqual(plan.integratedPrefix, ['api'])
})
