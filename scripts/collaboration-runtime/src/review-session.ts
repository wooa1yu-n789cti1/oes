import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, objectFingerprint, readJson, writeJsonAtomic } from './canonical.ts'
import { fail } from './errors.ts'
import { loadOwnerResourceBindingReference } from './resource-topology.ts'
import type { RemoteTrustRoots } from './types.ts'

export interface ReviewSessionInput {
  deliveryKey: string
  ownerTaskId: string
  reviewerAgentId: string
  candidateGenerations: string[]
  state: 'ACTIVE' | 'TERMINAL'
}

export interface ReviewSession extends ReviewSessionInput {
  schemaVersion: 1
  kind: 'OES_VISIBLE_RV_SUBAGENT_SESSION'
  transport: 'VISIBLE_SUBAGENT'
  sessionFingerprint: string
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SUBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REVIEW_SESSION_KEYS = [
  'schemaVersion',
  'kind',
  'transport',
  'deliveryKey',
  'ownerTaskId',
  'reviewerAgentId',
  'candidateGenerations',
  'state',
  'sessionFingerprint'
].sort()

/** Creates or advances the one viewable RV subagent retained across candidate generations. */
export function createReviewSession(
  input: ReviewSessionInput,
  previous: ReviewSession | null = null
): ReviewSession {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('RV_SESSION_FIELDS_INVALID', 'UNKNOWN')
  if (
    typeof input.deliveryKey !== 'string' ||
    typeof input.ownerTaskId !== 'string' ||
    typeof input.reviewerAgentId !== 'string' ||
    !Array.isArray(input.candidateGenerations) ||
    !KEY.test(input.deliveryKey) ||
    !input.ownerTaskId.trim() ||
    !input.reviewerAgentId.trim() ||
    !input.candidateGenerations.length ||
    input.candidateGenerations.some((subject) => !SUBJECT.test(subject)) ||
    new Set(input.candidateGenerations).size !== input.candidateGenerations.length ||
    !['ACTIVE', 'TERMINAL'].includes(input.state)
  )
    fail('RV_SESSION_FIELDS_INVALID', input.deliveryKey)
  if (previous) {
    validateReviewSession(previous)
    if (previous.deliveryKey !== input.deliveryKey || previous.ownerTaskId !== input.ownerTaskId)
      fail('RV_SESSION_OWNER_IMMUTABLE', input.deliveryKey)
    if (
      previous.state === 'TERMINAL' &&
      (input.state !== 'TERMINAL' ||
        previous.reviewerAgentId !== input.reviewerAgentId ||
        canonicalJson(previous.candidateGenerations) !== canonicalJson(input.candidateGenerations))
    )
      fail('RV_TERMINAL_MUTATION_FORBIDDEN', input.deliveryKey)
    if (previous.state === 'ACTIVE' && previous.reviewerAgentId !== input.reviewerAgentId)
      fail('ASSIGNMENT_RV_WIP_EXCEEDED', previous.reviewerAgentId)
    const prefix = input.candidateGenerations.slice(0, previous.candidateGenerations.length)
    if (canonicalJson(prefix) !== canonicalJson(previous.candidateGenerations))
      fail('RV_SESSION_GENERATION_HISTORY_CHANGED', input.deliveryKey)
  }
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_VISIBLE_RV_SUBAGENT_SESSION' as const,
    transport: 'VISIBLE_SUBAGENT' as const,
    ...structuredClone(input)
  }
  return {
    ...base,
    sessionFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Reopens a review session and rejects hidden or altered RV transport. */
export function validateReviewSession(value: ReviewSession): ReviewSession {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('RV_SESSION_INVALID', 'UNKNOWN')
  const expected = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'sessionFingerprint'
  )
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(REVIEW_SESSION_KEYS) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'OES_VISIBLE_RV_SUBAGENT_SESSION' ||
    value.transport !== 'VISIBLE_SUBAGENT' ||
    value.sessionFingerprint !== expected
  )
    fail('RV_SESSION_INVALID', value.deliveryKey)
  createReviewSession(
    {
      deliveryKey: value.deliveryKey,
      ownerTaskId: value.ownerTaskId,
      reviewerAgentId: value.reviewerAgentId,
      candidateGenerations: value.candidateGenerations,
      state: value.state
    },
    null
  )
  return structuredClone(value)
}

/** Atomically owns one delivery RV identity so lookup failure cannot create a duplicate reviewer. */
export class FileReviewSessionStore {
  readonly root: string
  readonly ownerTaskId: string

  constructor(trust: RemoteTrustRoots) {
    if (!trust.ownerResourceBinding) fail('RV_SESSION_OWNER_BINDING_REQUIRED', trust.ownerTaskId)
    const owner = loadOwnerResourceBindingReference(trust.ownerResourceBinding)
    if (owner.ownerTaskId !== trust.ownerTaskId)
      fail('RV_SESSION_OWNER_BINDING_MISMATCH', trust.ownerTaskId)
    this.ownerTaskId = owner.ownerTaskId
    this.root = join(owner.artifactRoot, 'review-sessions')
  }

  read(deliveryKey: string): ReviewSession | null {
    if (!KEY.test(deliveryKey)) fail('RV_SESSION_FIELDS_INVALID', deliveryKey)
    const path = join(this.root, `${deliveryKey}.rv-session.json`)
    return existsSync(path) ? validateReviewSession(readJson<ReviewSession>(path)) : null
  }

  bind(input: ReviewSessionInput, expectedFingerprint: string | null): ReviewSession {
    createReviewSession(input, null)
    if (input.ownerTaskId !== this.ownerTaskId)
      fail('RV_SESSION_OWNER_BINDING_MISMATCH', input.ownerTaskId)
    mkdirSync(this.root, { recursive: true })
    const path = join(this.root, `${input.deliveryKey}.rv-session.json`)
    const lockPath = join(this.root, `${input.deliveryKey}.rv-session.lock`)
    let descriptor: number | null = null
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch {
      fail('RV_SESSION_BUSY', path)
    }
    try {
      const current = this.read(input.deliveryKey)
      if ((current?.sessionFingerprint ?? null) !== expectedFingerprint)
        fail('RV_SESSION_CAS_MISMATCH', current?.reviewerAgentId ?? 'NONE')
      const next = createReviewSession(input, current)
      writeJsonAtomic(path, next)
      return next
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}
