import { existsSync } from 'node:fs'
import { RemoteCheckpointStore, RemoteMutationLock } from './checkpoint-store.ts'
import { loadRemoteBinding, validateRemoteBinding } from './binding.ts'
import { objectFingerprint, readJson, writeJsonAtomic } from './canonical.ts'
import { fail } from './errors.ts'
import { retryTransient, type RetryTiming } from './retry-policy.ts'
import type {
  RemoteAction,
  RemoteDriverBinding,
  RemoteDriverResult,
  RemoteReceipt,
  RemoteTruth,
  RemoteTrustRoots,
  RemoteVerification
} from './types.ts'

const MUTATING_ACTIONS = new Set<RemoteAction>(['publish-pr', 'merge-pr'])

export interface RemoteAdapter {
  preflight(binding: RemoteDriverBinding, truth: RemoteTruth): Promise<void>
  readTruth(binding: RemoteDriverBinding): Promise<RemoteTruth>
  mutate(binding: RemoteDriverBinding, truth: RemoteTruth): Promise<RemoteReceipt>
  verify(
    binding: RemoteDriverBinding,
    truth: RemoteTruth,
    receipt: RemoteReceipt
  ): Promise<RemoteVerification>
}

export interface RemoteDriverHooks {
  afterRemoteMutation?: (receipt: RemoteReceipt) => Promise<void> | void
  afterVerifiedCheckpoint?: () => Promise<void> | void
  retryTiming?: Partial<RetryTiming>
}

/** Determines whether remote truth already proves the bound mutation occurred. */
export function remoteMutationSatisfied(binding: RemoteDriverBinding, truth: RemoteTruth): boolean {
  if (binding.action === 'publish-pr') {
    return (
      truth.branchHead === binding.candidateSha &&
      truth.pullRequest?.state === 'OPEN' &&
      truth.pullRequest.draft === true &&
      (binding.pullRequest.number === null ||
        truth.pullRequest.number === binding.pullRequest.number) &&
      truth.pullRequest.baseRef === 'main' &&
      truth.pullRequest.headRef === binding.headRef &&
      truth.pullRequest.headSha === binding.candidateSha &&
      truth.pullRequest.title === binding.pullRequest.title &&
      truth.pullRequest.body === binding.pullRequest.body
    )
  }
  if (binding.action === 'merge-pr') {
    const exactPull = truth.pullRequest?.headSha === binding.candidateSha
    if (binding.admission?.mode === 'merge-queue')
      return Boolean(exactPull && (truth.pullRequest?.state === 'MERGED' || truth.mergeQueueEntry))
    return Boolean(
      exactPull && truth.pullRequest?.state === 'MERGED' && truth.pullRequest.mergeCommitSha
    )
  }
  return true
}

/** Builds a non-secret receipt from exact remote truth. */
function receiptFromTruth(
  binding: RemoteDriverBinding,
  truth: RemoteTruth,
  mutationPerformed: boolean,
  recoveredFromRemoteTruth: boolean,
  mutationReceipt: RemoteReceipt | null = null
): RemoteReceipt {
  return {
    action: binding.action,
    mutationPerformed,
    recoveredFromRemoteTruth,
    branchHead: truth.branchHead,
    pullRequestNumber: truth.pullRequest?.number ?? null,
    mergeCommitSha: truth.pullRequest?.mergeCommitSha ?? null,
    mergeGroupBaseSha:
      truth.mergeQueueEntry?.baseSha ??
      mutationReceipt?.mergeGroupBaseSha ??
      (binding.admission?.mode === 'merge-queue' && truth.pullRequest?.state === 'MERGED'
        ? (truth.pullMergeParents[0] ?? null)
        : (binding.admission?.mergeGroupBaseSha ?? null)),
    mergeGroupHeadSha:
      truth.mergeQueueEntry?.headSha ??
      mutationReceipt?.mergeGroupHeadSha ??
      (binding.admission?.mode === 'merge-queue' && truth.pullRequest?.state === 'MERGED'
        ? truth.pullRequest.mergeCommitSha
        : (binding.admission?.mergeGroupSha ?? null))
  }
}

/** Constructs and atomically persists one verified result. */
function writeVerifiedResult(
  binding: RemoteDriverBinding,
  receipt: RemoteReceipt,
  verification: RemoteVerification,
  truth: RemoteTruth
): RemoteDriverResult {
  const result: RemoteDriverResult = {
    schemaVersion: 1,
    kind: 'OES_REMOTE_DRIVER_RESULT',
    bindingFingerprint: binding.bindingFingerprint,
    action: binding.action,
    ownerTaskId: binding.owner.taskId,
    singleUseNonce: binding.singleUseNonce,
    status: 'REMOTE_VERIFIED',
    phase: 'REMOTE_VERIFIED',
    receipt,
    verification,
    remoteTruth: truth,
    remoteMutation: MUTATING_ACTIONS.has(binding.action)
  }
  writeJsonAtomic(binding.resultPath, result)
  const reread = readJson<RemoteDriverResult>(binding.resultPath)
  if (
    objectFingerprint(reread as unknown as Record<string, unknown>, '__none__') !==
    objectFingerprint(result as unknown as Record<string, unknown>, '__none__')
  )
    fail('REMOTE_RESULT_READBACK_MISMATCH', binding.resultPath)
  return result
}

/** Verifies a persisted terminal result still belongs to the exact binding. */
function readVerifiedResult(binding: RemoteDriverBinding): RemoteDriverResult {
  if (!existsSync(binding.resultPath)) fail('VERIFIED_RESULT_ABSENT', binding.resultPath)
  const result = readJson<RemoteDriverResult>(binding.resultPath)
  if (
    result.kind !== 'OES_REMOTE_DRIVER_RESULT' ||
    result.bindingFingerprint !== binding.bindingFingerprint ||
    result.singleUseNonce !== binding.singleUseNonce ||
    result.ownerTaskId !== binding.owner.taskId ||
    result.action !== binding.action ||
    result.phase !== 'REMOTE_VERIFIED' ||
    result.receipt?.action !== binding.action ||
    result.status !== 'REMOTE_VERIFIED'
  )
    fail('VERIFIED_RESULT_BINDING_MISMATCH', binding.resultPath)
  return result
}

/** Executes one exact remote action with monotonic checkpoints and remote-truth recovery. */
export class RemoteDriver {
  readonly adapter: RemoteAdapter
  readonly hooks: RemoteDriverHooks
  readonly trust: RemoteTrustRoots

  constructor(adapter: RemoteAdapter, trust: RemoteTrustRoots, hooks: RemoteDriverHooks = {}) {
    this.adapter = adapter
    this.trust = trust
    this.hooks = hooks
  }

  /** Runs or idempotently resumes an exact binding. */
  async run(input: RemoteDriverBinding): Promise<RemoteDriverResult> {
    const binding = validateRemoteBinding(input, this.trust)
    return this.runBound(binding)
  }

  /** Runs the checkpoint transaction after any required serial admission is held. */
  private async runBound(binding: RemoteDriverBinding): Promise<RemoteDriverResult> {
    const lock = MUTATING_ACTIONS.has(binding.action) ? RemoteMutationLock.acquire(binding) : null
    try {
      return await this.runTransaction(binding)
    } finally {
      lock?.release()
    }
  }

  /** Executes the complete remote read-mutate-checkpoint transaction while its lock is held. */
  private async runTransaction(binding: RemoteDriverBinding): Promise<RemoteDriverResult> {
    const store = new RemoteCheckpointStore(binding)
    let checkpoint = store.read()
    if (checkpoint?.phase === 'REMOTE_VERIFIED') {
      if (existsSync(binding.resultPath)) return readVerifiedResult(binding)
      const receipt = checkpoint.receipt
      if (!receipt) fail('REMOTE_RECEIPT_ABSENT', binding.action)
      const truth = await this.readTruth(binding)
      if (MUTATING_ACTIONS.has(binding.action) && !remoteMutationSatisfied(binding, truth))
        fail('REMOTE_TRUTH_DRIFT_AFTER_MUTATION', binding.action)
      const verification = await retryTransient(
        () => this.adapter.verify(binding, truth, receipt),
        this.hooks.retryTiming
      )
      if (!verification.passed)
        fail('TERMINAL_CHECKPOINT_REMOTE_VERIFICATION_FAILED', binding.action)
      return writeVerifiedResult(binding, receipt, verification, truth)
    }

    let truth = await this.readTruth(binding)
    if (!checkpoint) {
      await retryTransient(() => this.adapter.preflight(binding, truth), this.hooks.retryTiming)
      truth = await this.readTruth(binding)
      checkpoint = store.advance('REMOTE_PREFLIGHT_VERIFIED', truth, null)
    }

    const mutating = MUTATING_ACTIONS.has(binding.action)
    let receipt = checkpoint.receipt
    if (checkpoint.phase === 'REMOTE_PREFLIGHT_VERIFIED') {
      if (mutating) {
        const alreadySatisfied = remoteMutationSatisfied(binding, truth)
        if (!alreadySatisfied) {
          const mutationReceipt = await retryTransient(async () => {
            const currentTruth = await this.readTruth(binding)
            if (remoteMutationSatisfied(binding, currentTruth))
              return receiptFromTruth(binding, currentTruth, false, true)
            return this.adapter.mutate(binding, currentTruth)
          }, this.hooks.retryTiming)
          receipt = mutationReceipt
          await this.hooks.afterRemoteMutation?.(receipt)
          truth = await this.readTruth(binding)
          if (!remoteMutationSatisfied(binding, truth))
            fail('REMOTE_MUTATION_NOT_OBSERVED', binding.action)
          receipt = receiptFromTruth(
            binding,
            truth,
            mutationReceipt.mutationPerformed,
            mutationReceipt.recoveredFromRemoteTruth,
            mutationReceipt
          )
        } else receipt = receiptFromTruth(binding, truth, false, true)
      } else receipt = receiptFromTruth(binding, truth, false, false)
      checkpoint = store.advance('REMOTE_MUTATION_RECORDED', truth, receipt)
    } else if (mutating && !remoteMutationSatisfied(binding, truth))
      fail('REMOTE_TRUTH_DRIFT_AFTER_MUTATION', binding.action)

    receipt = checkpoint.receipt ?? receipt
    if (!receipt) fail('REMOTE_RECEIPT_ABSENT', binding.action)
    if (checkpoint.phase === 'REMOTE_MUTATION_RECORDED')
      checkpoint = store.advance('REMOTE_VERIFICATION_PENDING', truth, receipt)

    truth = await this.readTruth(binding)
    const verification = await retryTransient(
      () => this.adapter.verify(binding, truth, receipt),
      this.hooks.retryTiming
    )
    if (!verification.passed) {
      const pending: RemoteDriverResult = {
        schemaVersion: 1,
        kind: 'OES_REMOTE_DRIVER_RESULT',
        bindingFingerprint: binding.bindingFingerprint,
        action: binding.action,
        ownerTaskId: binding.owner.taskId,
        singleUseNonce: binding.singleUseNonce,
        status: 'REMOTE_VERIFICATION_PENDING',
        phase: 'REMOTE_VERIFICATION_PENDING',
        receipt,
        verification,
        remoteTruth: truth,
        remoteMutation: mutating
      }
      writeJsonAtomic(binding.resultPath, pending)
      return pending
    }

    checkpoint = store.advance('REMOTE_VERIFIED', truth, receipt)
    await this.hooks.afterVerifiedCheckpoint?.()
    return writeVerifiedResult(binding, receipt, verification, truth)
  }

  /** Reads remote truth with the bounded transient policy used at every recovery boundary. */
  private readTruth(binding: RemoteDriverBinding): Promise<RemoteTruth> {
    return retryTransient(() => this.adapter.readTruth(binding), this.hooks.retryTiming)
  }
}

/** Loads and executes one binding through a supplied adapter. */
export async function runRemoteBinding(
  path: string,
  adapter: RemoteAdapter,
  trust: RemoteTrustRoots
): Promise<RemoteDriverResult> {
  return new RemoteDriver(adapter, trust).run(loadRemoteBinding(path, trust))
}
