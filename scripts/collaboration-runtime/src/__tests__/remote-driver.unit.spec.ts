import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { RemoteDriver, type RemoteAdapter } from '../remote-driver.ts'
import { RemoteMutationLock } from '../checkpoint-store.ts'
import { objectFingerprint, writeJsonAtomic } from '../canonical.ts'
import type {
  RemoteDriverBinding,
  RemoteReceipt,
  RemoteTruth,
  RemoteVerification
} from '../types.ts'
import { authorizeRemoteBinding, remoteBinding, remoteTrust } from './helpers.ts'

class FakeRemote implements RemoteAdapter {
  truth: RemoteTruth
  mutationCount = 0
  preflightCount = 0
  verificationPassed = true

  constructor(binding: RemoteDriverBinding) {
    this.truth = {
      branchHead: null,
      mergeQueueEntry: null,
      mainHead: binding.integrationBase,
      pullRequest: null,
      requiredChecks: [
        {
          id: 1,
          sha: binding.candidateSha,
          name: 'Baseline Checks',
          status: 'completed',
          conclusion: 'success'
        }
      ],
      mainParents: [],
      pullMergeParents: [],
      reviewGate: {
        annotations: 0,
        issueComments: 0,
        reviewComments: 0,
        blockingReviews: 0,
        unresolvedThreads: 0
      }
    }
  }

  async preflight(): Promise<void> {
    this.preflightCount += 1
  }

  async readTruth(): Promise<RemoteTruth> {
    return structuredClone(this.truth)
  }

  async mutate(binding: RemoteDriverBinding): Promise<RemoteReceipt> {
    this.mutationCount += 1
    this.truth.branchHead = binding.candidateSha
    this.truth.pullRequest = {
      number: 12,
      state: 'OPEN',
      draft: true,
      baseRef: 'main',
      headRef: binding.headRef,
      headSha: binding.candidateSha,
      mergeCommitSha: null,
      title: binding.pullRequest.title,
      body: binding.pullRequest.body
    }
    return {
      action: binding.action,
      mutationPerformed: true,
      recoveredFromRemoteTruth: false,
      branchHead: binding.candidateSha,
      pullRequestNumber: 12,
      mergeCommitSha: null
    }
  }

  async verify(): Promise<RemoteVerification> {
    return {
      passed: this.verificationPassed,
      status: this.verificationPassed ? 'PR_READY' : 'PENDING',
      literalResult: this.truth.pullRequest
    }
  }
}

test('remote mutation success followed by process loss resumes from truth without repeating mutation', async () => {
  const binding = remoteBinding()
  const remote = new FakeRemote(binding)
  const first = new RemoteDriver(remote, remoteTrust(binding), {
    afterRemoteMutation: () => {
      throw new Error('simulated process loss after remote success')
    }
  })
  await assert.rejects(first.run(binding), /simulated process loss/)
  assert.equal(remote.mutationCount, 1)
  assert.equal(existsSync(binding.resultPath), false)

  const resumed = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(resumed.status, 'REMOTE_VERIFIED')
  assert.equal(resumed.receipt.recoveredFromRemoteTruth, true)
  assert.equal(resumed.receipt.mutationPerformed, false)
  assert.equal(remote.mutationCount, 1)
  assert.equal(remote.preflightCount, 1)

  const idempotent = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.deepEqual(idempotent, resumed)
  assert.equal(remote.mutationCount, 1)
})

test('remote mutation lock covers read-mutate-checkpoint and rejects concurrent duplicate execution', async () => {
  const binding = remoteBinding()
  let entered!: () => void
  let release!: () => void
  const mutationEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const mutationRelease = new Promise<void>((resolve) => {
    release = resolve
  })
  class BlockingRemote extends FakeRemote {
    override async mutate(current: RemoteDriverBinding): Promise<RemoteReceipt> {
      entered()
      await mutationRelease
      return super.mutate(current)
    }
  }
  const remote = new BlockingRemote(binding)
  const first = new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  await mutationEntered
  await assert.rejects(
    new RemoteDriver(remote, remoteTrust(binding)).run(binding),
    /REMOTE_ACTION_BUSY/
  )
  release()
  const result = await first
  assert.equal(result.status, 'REMOTE_VERIFIED')
  assert.equal(remote.mutationCount, 1)
})

test('same binding reclaims a dead lock while a different binding fails closed', async () => {
  const binding = remoteBinding()
  const held = RemoteMutationLock.acquire(binding)
  const other = structuredClone(binding)
  other.bindingFingerprint = 'f'.repeat(64)
  other.singleUseNonce = 'other-nonce'
  assert.throws(() => RemoteMutationLock.acquire(other), /REMOTE_ACTION_BUSY/)
  const stale = JSON.parse(readFileSync(held.path, 'utf8')) as Record<string, unknown>
  stale.pid = 2147483647
  stale.lockFingerprint = objectFingerprint(stale, 'lockFingerprint')
  writeJsonAtomic(held.path, stale)
  const remote = new FakeRemote(binding)
  const result = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(result.status, 'REMOTE_VERIFIED')
  assert.equal(remote.mutationCount, 1)
})

test('transient mutation response loss rereads remote truth before any retry', async () => {
  const binding = remoteBinding()
  class LostResponseRemote extends FakeRemote {
    override async mutate(current: RemoteDriverBinding): Promise<RemoteReceipt> {
      await super.mutate(current)
      throw new Error('HTTP 503 response lost after remote success')
    }
  }
  const remote = new LostResponseRemote(binding)
  const result = await new RemoteDriver(remote, remoteTrust(binding), {
    retryTiming: { random: () => 0, sleep: async () => undefined }
  }).run(binding)
  assert.equal(result.status, 'REMOTE_VERIFIED')
  assert.equal(result.receipt.recoveredFromRemoteTruth, true)
  assert.equal(result.receipt.mutationPerformed, false)
  assert.equal(remote.mutationCount, 1)
})

test('verification pending resumes only verification and preserves the mutation receipt', async () => {
  const binding = remoteBinding()
  const remote = new FakeRemote(binding)
  remote.verificationPassed = false
  const pending = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(pending.status, 'REMOTE_VERIFICATION_PENDING')
  assert.equal(remote.mutationCount, 1)
  remote.verificationPassed = true
  const verified = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(verified.status, 'REMOTE_VERIFIED')
  assert.equal(remote.mutationCount, 1)
})

test('terminal checkpoint reconstructs a missing result from exact remote truth', async () => {
  const binding = remoteBinding()
  const remote = new FakeRemote(binding)
  const interrupted = new RemoteDriver(remote, remoteTrust(binding), {
    afterVerifiedCheckpoint: () => {
      throw new Error('simulated result-write loss')
    }
  })
  await assert.rejects(interrupted.run(binding), /simulated result-write loss/)
  assert.equal(existsSync(binding.resultPath), false)
  const resumed = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(resumed.status, 'REMOTE_VERIFIED')
  assert.equal(remote.mutationCount, 1)
})

test('binding drift fails before any remote action', async () => {
  const binding = remoteBinding()
  binding.stateVersion += 1
  const remote = new FakeRemote(binding)
  await assert.rejects(
    new RemoteDriver(remote, remoteTrust(binding)).run(binding),
    /BINDING_FINGERPRINT_MISMATCH/
  )
  assert.equal(remote.preflightCount, 0)
  assert.equal(remote.mutationCount, 0)
})

class QueueRemote implements RemoteAdapter {
  truth: RemoteTruth
  mutationCount = 0

  constructor(binding: RemoteDriverBinding) {
    this.truth = {
      branchHead: binding.candidateSha,
      mergeQueueEntry: null,
      mainHead: binding.integrationBase,
      pullRequest: {
        number: 77,
        state: 'OPEN',
        draft: false,
        baseRef: 'main',
        headRef: binding.headRef,
        headSha: binding.candidateSha,
        mergeCommitSha: null,
        title: binding.pullRequest.title,
        body: binding.pullRequest.body
      },
      requiredChecks: [
        {
          id: 1,
          sha: binding.candidateSha,
          name: 'Baseline Checks',
          status: 'completed',
          conclusion: 'success'
        }
      ],
      mainParents: [],
      pullMergeParents: [],
      reviewGate: {
        annotations: 0,
        issueComments: 0,
        reviewComments: 0,
        blockingReviews: 0,
        unresolvedThreads: 0
      }
    }
  }

  async preflight(): Promise<void> {}
  async readTruth(): Promise<RemoteTruth> {
    return structuredClone(this.truth)
  }
  async mutate(binding: RemoteDriverBinding): Promise<RemoteReceipt> {
    this.mutationCount += 1
    this.truth.mergeQueueEntry = {
      id: 'queue-entry-1',
      position: 1,
      state: 'AWAITING_CHECKS',
      baseSha: binding.integrationBase,
      headSha: '7'.repeat(40)
    }
    return {
      action: binding.action,
      mutationPerformed: true,
      recoveredFromRemoteTruth: false,
      branchHead: binding.candidateSha,
      pullRequestNumber: 77,
      mergeCommitSha: null,
      mergeGroupBaseSha: binding.integrationBase,
      mergeGroupHeadSha: '7'.repeat(40)
    }
  }
  async verify(): Promise<RemoteVerification> {
    const passed = this.truth.pullRequest?.state === 'MERGED'
    return {
      passed,
      status: passed ? 'MERGED' : 'QUEUED',
      literalResult: this.truth.mergeQueueEntry
    }
  }
}

test('native queue admission is recovered from queue truth without enqueueing twice', async () => {
  const base = remoteBinding({
    action: 'merge-pr',
    pullRequest: {
      baseRef: 'main',
      draft: false,
      number: 77,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: ''
    },
    mergeAuthorizationFingerprint: 'f'.repeat(64),
    admission: { mode: 'merge-queue', lockPath: null, mergeGroupSha: null, mergeGroupBaseSha: null }
  })
  const binding = base
  binding.bindingFingerprint = (await import('../canonical.ts')).objectFingerprint(
    binding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  const remote = new QueueRemote(binding)
  await assert.rejects(
    new RemoteDriver(remote, remoteTrust(binding), {
      afterRemoteMutation: () => {
        throw new Error('queue process loss')
      }
    }).run(binding),
    /queue process loss/
  )
  const pending = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(pending.status, 'REMOTE_VERIFICATION_PENDING')
  assert.equal(pending.receipt.recoveredFromRemoteTruth, true)
  assert.equal(remote.mutationCount, 1)
  if (!remote.truth.pullRequest) throw new Error('test pull absent')
  remote.truth.pullRequest.state = 'MERGED'
  remote.truth.pullRequest.mergeCommitSha = '8'.repeat(40)
  remote.truth.mergeQueueEntry = null
  const verified = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(verified.status, 'REMOTE_VERIFIED')
  assert.equal(remote.mutationCount, 1)
})

test('a queue merge that completes during first readback preserves the mutation receipt', async () => {
  const binding = remoteBinding({
    action: 'merge-pr',
    pullRequest: {
      baseRef: 'main',
      draft: false,
      number: 77,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: ''
    },
    mergeAuthorizationFingerprint: 'f'.repeat(64),
    admission: { mode: 'merge-queue', lockPath: null, mergeGroupSha: null, mergeGroupBaseSha: null }
  })
  class FastQueueRemote extends QueueRemote {
    override async mutate(current: RemoteDriverBinding): Promise<RemoteReceipt> {
      const receipt = await super.mutate(current)
      if (!this.truth.pullRequest) throw new Error('test pull absent')
      this.truth.pullRequest.state = 'MERGED'
      this.truth.pullRequest.mergeCommitSha = '7'.repeat(40)
      this.truth.pullMergeParents = [current.integrationBase, current.candidateSha]
      this.truth.mergeQueueEntry = null
      return receipt
    }
  }
  const remote = new FastQueueRemote(binding)
  const result = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(result.status, 'REMOTE_VERIFIED')
  assert.equal(result.receipt.mergeGroupBaseSha, binding.integrationBase)
  assert.equal(result.receipt.mergeGroupHeadSha, '7'.repeat(40))
  assert.equal(remote.mutationCount, 1)
})

test('process loss after a fast queue merge reconstructs group inputs from merged truth', async () => {
  const binding = remoteBinding({
    action: 'merge-pr',
    pullRequest: {
      baseRef: 'main',
      draft: false,
      number: 77,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: ''
    },
    mergeAuthorizationFingerprint: 'f'.repeat(64),
    admission: { mode: 'merge-queue', lockPath: null, mergeGroupSha: null, mergeGroupBaseSha: null }
  })
  class FastMergedRemote extends QueueRemote {
    override async mutate(current: RemoteDriverBinding): Promise<RemoteReceipt> {
      const receipt = await super.mutate(current)
      if (!this.truth.pullRequest) throw new Error('test pull absent')
      this.truth.pullRequest.state = 'MERGED'
      this.truth.pullRequest.mergeCommitSha = '7'.repeat(40)
      this.truth.pullMergeParents = [current.integrationBase, current.candidateSha]
      this.truth.mergeQueueEntry = null
      return receipt
    }
  }
  const remote = new FastMergedRemote(binding)
  await assert.rejects(
    new RemoteDriver(remote, remoteTrust(binding), {
      afterRemoteMutation: () => {
        throw new Error('fast merge process loss')
      }
    }).run(binding),
    /fast merge process loss/
  )
  const result = await new RemoteDriver(remote, remoteTrust(binding)).run(binding)
  assert.equal(result.status, 'REMOTE_VERIFIED')
  assert.equal(result.receipt.recoveredFromRemoteTruth, true)
  assert.equal(result.receipt.mergeGroupBaseSha, binding.integrationBase)
  assert.equal(result.receipt.mergeGroupHeadSha, '7'.repeat(40))
  assert.equal(remote.mutationCount, 1)
})

test('direct serial merge is unavailable and points to Merge Queue', async () => {
  const binding = remoteBinding({
    action: 'merge-pr',
    pullRequest: {
      baseRef: 'main',
      draft: false,
      number: 9,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    },
    mergeAuthorizationFingerprint: 'f'.repeat(64),
    admission: {
      mode: 'merge-queue',
      lockPath: null,
      mergeGroupSha: null,
      mergeGroupBaseSha: null
    }
  })
  ;(binding.admission as unknown as { mode: string }).mode = 'serial-latest-main'
  authorizeRemoteBinding(binding)
  await assert.rejects(
    new RemoteDriver(new FakeRemote(binding), remoteTrust(binding)).run(binding),
    /MERGE_QUEUE_REQUIRED/
  )
})
