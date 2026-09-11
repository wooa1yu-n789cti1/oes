import { objectFingerprint } from './canonical.ts'
import {
  materialDecisionFingerprint,
  requireTrustedDecisionConfirmation,
  type DecisionCardInput,
  type TrustedDecisionConfirmation
} from './confirmation.ts'
import { fail } from './errors.ts'

export const TEST_CLASSES = [
  'STATIC',
  'UNIT',
  'COMPONENT',
  'CONTRACT',
  'INTEGRATION',
  'JOURNEY'
] as const
export type TestClass = (typeof TEST_CLASSES)[number]

export interface VerificationTopologyInput {
  candidateSha: string
  ownerRole: 'UD' | 'DO' | 'CO'
  changedRiskClasses: TestClass[]
  selfTestClasses: TestClass[]
  rvClasses: TestClass[]
  ciClasses: TestClass[]
  pullRequestCandidateExists: boolean
  fullRequired: boolean
  fullReason: string | null
  estimatedFullCost: string | null
  confirmation: TrustedDecisionConfirmation
  currentDecision: DecisionCardInput
}

export interface VerificationTopology {
  schemaVersion: 2
  kind: 'OES_V2_VERIFICATION_TOPOLOGY'
  candidateSha: string
  doSelfTest: { owner: 'UD' | 'DO' | 'CO'; classes: TestClass[] }
  rv: { owner: 'RV'; independent: true; exactCandidateSha: string; classes: TestClass[] }
  ci: { requiredStatus: 'Baseline Checks'; exactCandidateSha: string; classes: TestClass[] }
  parallelRvAndCi: boolean
  fullDisposition: 'NOT_REQUIRED' | 'HUMAN_CONFIRMATION_REQUIRED' | 'CONFIRMED'
  fullReason: string | null
  estimatedFullCost: string | null
  confirmationFingerprint: string
  runnable: boolean
  planFingerprint: string
}

const SHA = /^[0-9a-f]{40}$/

/** Builds the three-layer, exact-candidate verification topology without mechanically selecting every class. */
export function createVerificationTopology(input: VerificationTopologyInput): VerificationTopology {
  if (!SHA.test(input.candidateSha)) fail('VERIFICATION_CANDIDATE_SHA_INVALID', input.candidateSha)
  const confirmation = requireTrustedDecisionConfirmation(input.confirmation)
  const card = confirmation.card
  if (card.executionMode !== 'REPOSITORY')
    fail('VERIFICATION_REPOSITORY_CONFIRMATION_REQUIRED', card.cardFingerprint)
  if (
    (card.decisionKind === 'PROPOSAL' && input.ownerRole !== 'UD') ||
    (card.decisionKind === 'DELIVERY' && input.ownerRole === 'UD')
  )
    fail('VERIFICATION_OWNER_DECISION_MISMATCH', input.ownerRole)
  for (const [name, values] of Object.entries({
    selfTestClasses: input.selfTestClasses,
    rvClasses: input.rvClasses,
    ciClasses: input.ciClasses,
    changedRiskClasses: input.changedRiskClasses
  })) {
    if (
      new Set(values).size !== values.length ||
      values.some((value) => !TEST_CLASSES.includes(value))
    )
      fail('VERIFICATION_CLASS_SET_INVALID', name)
  }
  const covered = new Set([...input.selfTestClasses, ...input.rvClasses, ...input.ciClasses])
  const missing = input.changedRiskClasses.filter((value) => !covered.has(value))
  if (missing.length) fail('VERIFICATION_RISK_UNCOVERED', missing.join(','))
  if (input.fullRequired && (!input.fullReason?.trim() || !input.estimatedFullCost?.trim()))
    fail('VERIFICATION_FULL_DISCLOSURE_REQUIRED', input.candidateSha)
  const currentMaterialDecisionFingerprint = materialDecisionFingerprint(input.currentDecision)
  const fullAuthorized =
    card.approvedCiLevel === 'FULL' &&
    card.materialDecisionFingerprint === currentMaterialDecisionFingerprint
  if (
    !input.fullRequired &&
    card.materialDecisionFingerprint !== currentMaterialDecisionFingerprint
  )
    fail('VERIFICATION_MATERIAL_DECISION_MISMATCH', input.candidateSha)
  const fullDisposition: VerificationTopology['fullDisposition'] = !input.fullRequired
    ? 'NOT_REQUIRED'
    : fullAuthorized
      ? 'CONFIRMED'
      : 'HUMAN_CONFIRMATION_REQUIRED'
  const base = {
    schemaVersion: 2 as const,
    kind: 'OES_V2_VERIFICATION_TOPOLOGY' as const,
    candidateSha: input.candidateSha,
    doSelfTest: { owner: input.ownerRole, classes: input.selfTestClasses },
    rv: {
      owner: 'RV' as const,
      independent: true as const,
      exactCandidateSha: input.candidateSha,
      classes: input.rvClasses
    },
    ci: {
      requiredStatus: 'Baseline Checks' as const,
      exactCandidateSha: input.candidateSha,
      classes: input.ciClasses
    },
    parallelRvAndCi: input.pullRequestCandidateExists,
    fullDisposition,
    fullReason: input.fullReason,
    estimatedFullCost: input.estimatedFullCost,
    confirmationFingerprint: confirmation.receipt.confirmationFingerprint,
    runnable: fullDisposition !== 'HUMAN_CONFIRMATION_REQUIRED'
  }
  return {
    ...base,
    planFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}
