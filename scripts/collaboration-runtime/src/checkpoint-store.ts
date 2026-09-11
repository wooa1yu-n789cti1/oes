import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  assertPathWithin,
  canonicalJson,
  objectFingerprint,
  readJson,
  writeJsonAtomic
} from './canonical.ts'
import { fail } from './errors.ts'
import {
  REMOTE_PHASES,
  type RemoteCheckpoint,
  type RemoteDriverBinding,
  type RemoteReceipt,
  type RemotePhase,
  type RemoteTruth
} from './types.ts'

interface RemoteMutationLockRecord {
  schemaVersion: 1
  kind: 'OES_REMOTE_MUTATION_LOCK'
  bindingFingerprint: string
  action: RemoteDriverBinding['action']
  singleUseNonce: string
  ownerTaskId: string
  pid: number
  lockId: string
  createdAt: string
  lockFingerprint: string
}

const LOCK_KEYS = [
  'schemaVersion',
  'kind',
  'bindingFingerprint',
  'action',
  'singleUseNonce',
  'ownerTaskId',
  'pid',
  'lockId',
  'createdAt',
  'lockFingerprint'
].sort()

/** Returns whether the recorded lock holder still exists on this host. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

/** Validates one complete owner-local mutation lock record. */
function validateMutationLock(
  value: RemoteMutationLockRecord,
  path: string
): RemoteMutationLockRecord {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(LOCK_KEYS) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'OES_REMOTE_MUTATION_LOCK' ||
    !value.bindingFingerprint.match(/^[0-9a-f]{64}$/) ||
    !value.singleUseNonce.trim() ||
    !value.ownerTaskId.trim() ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !value.lockId.trim() ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    objectFingerprint(value as unknown as Record<string, unknown>, 'lockFingerprint') !==
      value.lockFingerprint
  )
    fail('REMOTE_ACTION_LOCK_INVALID', path)
  return value
}

/** Publishes one complete lock without replacing an existing owner transaction. */
function publishLock(path: string, value: RemoteMutationLockRecord): boolean {
  const temporary = `${path}.${process.pid}.${value.lockId}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    try {
      linkSync(temporary, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    try {
      unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Holds the complete read-mutate-checkpoint transaction for one owner at a time. */
export class RemoteMutationLock {
  readonly path: string
  readonly record: RemoteMutationLockRecord
  private held = true

  private constructor(path: string, record: RemoteMutationLockRecord) {
    this.path = path
    this.record = record
  }

  static acquire(binding: RemoteDriverBinding): RemoteMutationLock {
    const lockRoot = join(binding.artifactRoot, 'remote-actions')
    mkdirSync(lockRoot, { recursive: true })
    if (realpathSync(lockRoot) !== resolve(lockRoot))
      fail('REMOTE_ACTION_LOCK_PHYSICAL_ALIAS', lockRoot)
    const path = join(lockRoot, '.mutation.lock')
    assertPathWithin(binding.artifactRoot, path)
    const raw = {
      schemaVersion: 1 as const,
      kind: 'OES_REMOTE_MUTATION_LOCK' as const,
      bindingFingerprint: binding.bindingFingerprint,
      action: binding.action,
      singleUseNonce: binding.singleUseNonce,
      ownerTaskId: binding.owner.taskId,
      pid: process.pid,
      lockId: randomUUID(),
      createdAt: new Date().toISOString()
    }
    const record: RemoteMutationLockRecord = {
      ...raw,
      lockFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (publishLock(path, record)) return new RemoteMutationLock(path, record)
      const existing = validateMutationLock(
        JSON.parse(readFileSync(path, 'utf8')) as RemoteMutationLockRecord,
        path
      )
      if (
        existing.bindingFingerprint !== binding.bindingFingerprint ||
        existing.action !== binding.action ||
        existing.singleUseNonce !== binding.singleUseNonce ||
        existing.ownerTaskId !== binding.owner.taskId
      )
        fail('REMOTE_ACTION_BUSY', `${existing.ownerTaskId}:${existing.action}`)
      if (processExists(existing.pid))
        fail('REMOTE_ACTION_BUSY', `${existing.pid}:${binding.action}`)
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    fail('REMOTE_ACTION_BUSY', binding.action)
  }

  /** Releases only the exact lock instance created by this process. */
  release(): void {
    if (!this.held) return
    const current = validateMutationLock(
      JSON.parse(readFileSync(this.path, 'utf8')) as RemoteMutationLockRecord,
      this.path
    )
    if (
      current.lockId !== this.record.lockId ||
      current.lockFingerprint !== this.record.lockFingerprint
    )
      fail('REMOTE_ACTION_LOCK_OWNERSHIP_LOST', this.path)
    unlinkSync(this.path)
    this.held = false
  }
}

/** Persists monotonic remote checkpoints for one exact binding. */
export class RemoteCheckpointStore {
  readonly binding: RemoteDriverBinding

  constructor(binding: RemoteDriverBinding) {
    this.binding = binding
  }

  /** Reads and validates the current checkpoint when present. */
  read(): RemoteCheckpoint | null {
    if (!existsSync(this.binding.checkpointPath)) return null
    const checkpoint = readJson<RemoteCheckpoint>(this.binding.checkpointPath)
    if (checkpoint.kind !== 'OES_REMOTE_DRIVER_CHECKPOINT' || checkpoint.schemaVersion !== 1) {
      fail('INVALID_CHECKPOINT_KIND', this.binding.checkpointPath)
    }
    const exactKeys = [
      'schemaVersion',
      'kind',
      'bindingFingerprint',
      'action',
      'singleUseNonce',
      'phase',
      'receipt',
      'remoteTruthFingerprint',
      'updatedAt'
    ]
    if (Object.keys(checkpoint).some((key) => !exactKeys.includes(key)))
      fail('CHECKPOINT_UNDECLARED_FIELD', this.binding.checkpointPath)
    if (
      checkpoint.bindingFingerprint !== this.binding.bindingFingerprint ||
      checkpoint.action !== this.binding.action ||
      checkpoint.singleUseNonce !== this.binding.singleUseNonce
    ) {
      fail('CHECKPOINT_BINDING_MISMATCH', this.binding.checkpointPath)
    }
    if (!REMOTE_PHASES.includes(checkpoint.phase))
      fail('CHECKPOINT_PHASE_INVALID', String(checkpoint.phase))
    if (!/^[0-9a-f]{64}$/.test(checkpoint.remoteTruthFingerprint))
      fail('CHECKPOINT_TRUTH_FINGERPRINT_INVALID', this.binding.checkpointPath)
    if (checkpoint.phase === 'REMOTE_PREFLIGHT_VERIFIED' && checkpoint.receipt !== null)
      fail('CHECKPOINT_PREMATURE_RECEIPT', this.binding.checkpointPath)
    if (checkpoint.phase !== 'REMOTE_PREFLIGHT_VERIFIED') {
      if (!checkpoint.receipt || checkpoint.receipt.action !== this.binding.action)
        fail('CHECKPOINT_RECEIPT_MISMATCH', this.binding.checkpointPath)
    }
    return checkpoint
  }

  /** Advances exactly one monotonic checkpoint phase with atomic readback. */
  advance(phase: RemotePhase, truth: RemoteTruth, receipt: RemoteReceipt | null): RemoteCheckpoint {
    const current = this.read()
    const nextIndex = REMOTE_PHASES.indexOf(phase)
    const currentIndex = current ? REMOTE_PHASES.indexOf(current.phase) : -1
    if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
      fail('INVALID_CHECKPOINT_TRANSITION', `${current?.phase ?? 'NONE'} -> ${phase}`)
    }
    if (nextIndex === currentIndex) return current as RemoteCheckpoint
    const checkpoint: RemoteCheckpoint = {
      schemaVersion: 1,
      kind: 'OES_REMOTE_DRIVER_CHECKPOINT',
      bindingFingerprint: this.binding.bindingFingerprint,
      action: this.binding.action,
      singleUseNonce: this.binding.singleUseNonce,
      phase,
      receipt,
      remoteTruthFingerprint: objectFingerprint(
        truth as unknown as Record<string, unknown>,
        '__none__'
      ),
      updatedAt: new Date().toISOString()
    }
    writeJsonAtomic(this.binding.checkpointPath, checkpoint)
    return this.read() as RemoteCheckpoint
  }
}
