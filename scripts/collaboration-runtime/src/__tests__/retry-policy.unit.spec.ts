import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CiRecoveryController,
  FileCiRecoveryReceiptStore,
  type CiFailureObservation,
  classifyExternalFailure,
  retryTransient
} from '../retry-policy.ts'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import type { RemoteTrustRoots, TrustedAuthorizationReference } from '../types.ts'

/** Creates one profile-derived CI trust context for immutable observation fixtures. */
function ciTrust(root: string): RemoteTrustRoots {
  const trust: RemoteTrustRoots = {
    projectKey: 'oes',
    authorizationRoot: join(root, 'trusted'),
    admissionRoot: join(root, 'admission'),
    profilePath: join(root, 'profile.toml'),
    profileSha256: 'a'.repeat(64),
    ownerTaskId: '/root/do/ci',
    profileTransitionId: 'ci-transition:1',
    profileExpectedState: 'DELIVERY_ACTIVE'
  }
  mkdirSync(trust.authorizationRoot, { recursive: true })
  mkdirSync(trust.admissionRoot, { recursive: true })
  return trust
}

/** Writes one trusted live-CI run/job observation and returns its immutable reference. */
function ciObservation(
  trust: RemoteTrustRoots,
  label: string,
  overrides: {
    candidateSha?: string
    runSha?: string
    jobSha?: string
    runId?: string
    jobRunId?: string
    jobId?: string
    transitionId?: string
    failureKind?: CiFailureObservation['failedJob']['failureKind']
  } = {}
): { observation: CiFailureObservation; reference: TrustedAuthorizationReference } {
  const candidateSha = overrides.candidateSha ?? 'a'.repeat(40)
  const runId = overrides.runId ?? 'workflow-run-42'
  const observation: CiFailureObservation = {
    schemaVersion: 1,
    kind: 'OES_CI_FAILED_JOB_OBSERVATION',
    observationFingerprint: '',
    status: 'VERIFIED',
    ownerTaskId: trust.ownerTaskId,
    transitionId: overrides.transitionId ?? trust.profileTransitionId,
    candidateSha,
    workflowRun: {
      id: runId,
      headSha: overrides.runSha ?? candidateSha,
      status: 'completed',
      conclusion: 'failure'
    },
    failedJob: {
      id: overrides.jobId ?? 'failed-job-7',
      workflowRunId: overrides.jobRunId ?? runId,
      headSha: overrides.jobSha ?? candidateSha,
      status: 'completed',
      conclusion: 'failure',
      failureKind: overrides.failureKind ?? 'infrastructure'
    }
  }
  observation.observationFingerprint = objectFingerprint(
    observation as unknown as Record<string, unknown>,
    'observationFingerprint'
  )
  const path = join(trust.authorizationRoot, `${label}.json`)
  writeFileSync(path, `${canonicalJson(observation)}\n`)
  return {
    observation,
    reference: {
      path,
      sha256: sha256(readFileSync(path)),
      fingerprint: observation.observationFingerprint
    }
  }
}

test('transient reads use bounded exponential backoff with jitter', async () => {
  let attempts = 0
  const delays: number[] = []
  const result = await retryTransient(
    async () => {
      attempts += 1
      if (attempts < 4) throw new Error('HTTP 503 service unavailable')
      return 'ok'
    },
    {
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      }
    }
  )
  assert.equal(result, 'ok')
  assert.equal(attempts, 4)
  assert.deepEqual(delays, [375, 750, 1500])
  assert.equal(classifyExternalFailure(new Error('type assertion failed')), 'PERMANENT')
})

test('permission failure stops immediately and transient exhaustion is bounded', async () => {
  let permissionAttempts = 0
  await assert.rejects(
    retryTransient(async () => {
      permissionAttempts += 1
      throw new Error('HTTP 403 resource not accessible')
    }),
    /EXTERNAL_PERMISSION_BLOCKER/
  )
  assert.equal(permissionAttempts, 1)

  let transientAttempts = 0
  await assert.rejects(
    retryTransient(
      async () => {
        transientAttempts += 1
        throw new Error('connection reset')
      },
      { random: () => 0, sleep: async () => undefined }
    ),
    /TRANSIENT_RETRY_EXHAUSTED/
  )
  assert.equal(transientAttempts, 4)
})

test('CI recovery reruns only one infrastructure-failed job on the unchanged SHA', () => {
  const sha = 'a'.repeat(40)
  const root = mkdtempSync(join(tmpdir(), 'oes-ci-recovery-'))
  const trust = ciTrust(root)
  const infrastructure = ciObservation(trust, 'infrastructure')
  const input = { candidateSha: sha, observation: infrastructure.reference }
  const first = new CiRecoveryController(
    new FileCiRecoveryReceiptStore(trust.admissionRoot),
    trust
  ).decide(input)
  assert.equal(first.action, 'RERUN_FAILED_JOB_ONCE')
  assert.equal(first.reason, 'SAME_SHA_INFRASTRUCTURE_FAILURE')
  assert.ok(first.rerunReceipt)

  const replay = new CiRecoveryController(
    new FileCiRecoveryReceiptStore(trust.admissionRoot),
    trust
  ).decide(input)
  assert.equal(replay.action, 'REPLAY_EXISTING_RERUN_RECEIPT')
  assert.equal(replay.reason, 'SAME_FAILURE_RERUN_ALREADY_RECORDED')
  assert.deepEqual(replay.rerunReceipt, first.rerunReceipt)

  const assertion = ciObservation(trust, 'assertion', { failureKind: 'assertion' })
  const controller = new CiRecoveryController(
    new FileCiRecoveryReceiptStore(trust.admissionRoot),
    trust
  )
  assert.equal(
    controller.decide({ candidateSha: sha, observation: assertion.reference }).action,
    'RETURN_TO_OWNER'
  )
  assert.equal(
    controller.decide({ candidateSha: 'b'.repeat(40), observation: infrastructure.reference })
      .action,
    'PRESERVE_BLOCKER'
  )
})

test('CI recovery rejects stale transition, false run/job relation, and run alias replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-ci-trust-'))
  const trust = ciTrust(root)
  const controller = new CiRecoveryController(
    new FileCiRecoveryReceiptStore(trust.admissionRoot),
    trust
  )
  const first = ciObservation(trust, 'first')
  assert.equal(
    controller.decide({
      candidateSha: first.observation.candidateSha,
      observation: first.reference
    }).action,
    'RERUN_FAILED_JOB_ONCE'
  )

  const stale = ciObservation(trust, 'stale', { transitionId: 'ci-transition:stale' })
  assert.throws(
    () =>
      controller.decide({
        candidateSha: stale.observation.candidateSha,
        observation: stale.reference
      }),
    /CI_OBSERVATION_OWNER_TRANSITION_MISMATCH/
  )
  const unrelated = ciObservation(trust, 'unrelated', { jobRunId: 'workflow-run-other' })
  assert.throws(
    () =>
      controller.decide({
        candidateSha: unrelated.observation.candidateSha,
        observation: unrelated.reference
      }),
    /CI_OBSERVATION_RUN_JOB_RELATION_INVALID/
  )
  const alias = ciObservation(trust, 'alias', {
    runId: 'workflow-run-alias',
    jobRunId: 'workflow-run-alias'
  })
  assert.throws(
    () =>
      controller.decide({
        candidateSha: alias.observation.candidateSha,
        observation: alias.reference
      }),
    /CI_RERUN_RECEIPT_REPLAY_MISMATCH/
  )
})
