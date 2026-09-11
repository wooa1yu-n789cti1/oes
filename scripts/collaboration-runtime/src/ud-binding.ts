import { closeSync, existsSync, openSync, realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { assertPathWithin, objectFingerprint, readJson, writeJsonAtomic } from './canonical.ts'
import { fail } from './errors.ts'
import type { RemoteTrustRoots } from './types.ts'

export interface UdBindingInput {
  projectKey: string
  taskId: string
  generation: number
  state: 'ACTIVE' | 'TERMINAL'
}

export interface UdBinding extends UdBindingInput {
  schemaVersion: 1
  kind: 'OES_CURRENT_UD_BINDING'
  bindingFingerprint: string
}

const PROJECT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Seals the single current UD identity without keeping a task or Proposal ledger. */
export function createUdBinding(
  input: UdBindingInput,
  previous: UdBinding | null = null
): UdBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('UD_BINDING_FIELDS_INVALID', 'UNKNOWN')
  if (
    typeof input.projectKey !== 'string' ||
    typeof input.taskId !== 'string' ||
    !PROJECT_KEY.test(input.projectKey) ||
    !input.taskId.trim() ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  )
    fail('UD_BINDING_FIELDS_INVALID', input.projectKey)
  if (previous) {
    validateUdBinding(previous)
    if (previous.projectKey !== input.projectKey)
      fail('UD_BINDING_PROJECT_IMMUTABLE', input.projectKey)
    if (previous.state === 'ACTIVE' && previous.taskId !== input.taskId)
      fail('UD_ALREADY_ACTIVE', previous.taskId)
    const sameIdentity = previous.taskId === input.taskId
    if (previous.state === 'TERMINAL' && sameIdentity && input.state === 'ACTIVE')
      fail('UD_TERMINAL_REACTIVATION_FORBIDDEN', input.taskId)
    if (sameIdentity && input.generation !== previous.generation)
      fail('UD_BINDING_GENERATION_INVALID', input.taskId)
    if (!sameIdentity && input.generation !== previous.generation + 1)
      fail('UD_BINDING_GENERATION_INVALID', input.taskId)
  } else if (input.generation !== 1) fail('UD_BINDING_GENERATION_INVALID', input.taskId)
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_CURRENT_UD_BINDING' as const,
    ...structuredClone(input)
  }
  return {
    ...base,
    bindingFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Reopens the single current UD binding and rejects a caller-resealed duplicate identity. */
export function validateUdBinding(value: UdBinding): UdBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('UD_BINDING_INVALID', 'UNKNOWN')
  const expected = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'OES_CURRENT_UD_BINDING' ||
    !PROJECT_KEY.test(value.projectKey) ||
    !value.taskId.trim() ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !['ACTIVE', 'TERMINAL'].includes(value.state) ||
    value.bindingFingerprint !== expected
  )
    fail('UD_BINDING_INVALID', value.projectKey)
  return structuredClone(value)
}

/** Marks the current UD terminal so a verified successor generation can be bound. */
export function terminateUdBinding(value: UdBinding): UdBinding {
  const current = validateUdBinding(value)
  return createUdBinding(
    {
      projectKey: current.projectKey,
      taskId: current.taskId,
      generation: current.generation,
      state: 'TERMINAL'
    },
    current
  )
}

/** Atomically owns the one current-UD file so concurrent starts cannot create two active UDs. */
export class FileUdBindingStore {
  readonly root: string
  readonly path: string
  readonly lockPath: string
  readonly projectKey: string

  constructor(trust: RemoteTrustRoots) {
    const root = trust.authorizationRoot
    if (!isAbsolute(root)) fail('UD_BINDING_TRUST_ROOT_INVALID', root)
    this.root = resolve(realpathSync(root))
    if (!PROJECT_KEY.test(trust.projectKey))
      fail('UD_BINDING_PROJECT_TRUST_INVALID', trust.projectKey)
    this.projectKey = trust.projectKey
    this.path = join(this.root, 'current-ud.json')
    this.lockPath = join(this.root, 'current-ud.lock')
    assertPathWithin(this.root, this.path)
    assertPathWithin(this.root, this.lockPath)
  }

  read(projectKey: string): UdBinding | null {
    if (!PROJECT_KEY.test(projectKey)) fail('UD_BINDING_FIELDS_INVALID', projectKey)
    if (projectKey !== this.projectKey) fail('UD_BINDING_PROJECT_TRUST_MISMATCH', projectKey)
    if (!existsSync(this.path)) return null
    if (resolve(realpathSync(this.path)) !== resolve(this.path))
      fail('UD_BINDING_PHYSICAL_ALIAS', this.path)
    const value = validateUdBinding(readJson<UdBinding>(this.path))
    if (value.projectKey !== projectKey) fail('UD_BINDING_PROJECT_MISMATCH', projectKey)
    return value
  }

  /** Controller-only compare-and-swap; the agent-facing CLI exposes read, never bind. */
  bind(input: UdBindingInput, expectedFingerprint: string | null): UdBinding {
    if (input.projectKey !== this.projectKey)
      fail('UD_BINDING_PROJECT_TRUST_MISMATCH', input.projectKey)
    let descriptor: number | null = null
    try {
      descriptor = openSync(this.lockPath, 'wx', 0o600)
    } catch {
      fail('UD_BINDING_BUSY', this.path)
    }
    try {
      const current = this.read(input.projectKey)
      if ((current?.bindingFingerprint ?? null) !== expectedFingerprint)
        fail('UD_BINDING_CAS_MISMATCH', current?.taskId ?? 'NONE')
      const next = createUdBinding(input, current)
      writeJsonAtomic(this.path, next)
      return next
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      unlinkSync(this.lockPath)
    }
  }
}
