import { canonicalJson, objectFingerprint } from './canonical.ts'
import {
  assessContinuation,
  type CiLevel,
  type DecisionCardInput,
  type TrustedDecisionConfirmation
} from './confirmation.ts'
import { fail } from './errors.ts'

export const DO_ISSUE_KINDS = [
  'IMPLEMENTATION_DEFECT',
  'TEST_OR_CI_FINDING',
  'TOOL_OR_ENVIRONMENT_PROBLEM',
  'WITHIN_SCOPE_COMPLEXITY',
  'GOAL_OR_ACCEPTANCE_CHANGE',
  'CANONICAL_DESIGN_GAP',
  'DELIVERY_STRUCTURE_CHANGE',
  'ACTIVE_OWNER_CONFLICT'
] as const
export type DoIssueKind = (typeof DO_ISSUE_KINDS)[number]

export interface DoIssueInput {
  deliveryKey: string
  ownerTaskId: string
  affectedSlice: string
  issueKind: DoIssueKind
  summary: string
}

export interface DoIssueDecision {
  schemaVersion: 1
  kind: 'OES_DO_ISSUE_DECISION'
  deliveryKey: string
  ownerTaskId: string
  affectedSlice: string
  issueKind: DoIssueKind
  summary: string
  issueFingerprint: string
  decision: 'CONTINUE_ORIGINAL_DO' | 'RETURN_ONCE_TO_DA'
  pause: 'NONE' | 'AFFECTED_SLICE_ONLY'
  route: 'DO' | 'DA' | 'DA_UD_DA'
  allowedDaOutcomes: Array<'RESUME_ORIGINAL_DO' | 'REPLACE_WITH_NEW_DO' | 'DISPATCH_CO'>
  humanDecisionRequired: boolean
  nextAction: string
  decisionFingerprint: string
}

export interface DaReplanInput {
  issueDecision: DoIssueDecision
  currentIssue: DoIssueInput
  selectedOutcome: 'RESUME_ORIGINAL_DO' | 'REPLACE_WITH_NEW_DO' | 'DISPATCH_CO'
  originalResourcesPreserved: boolean
  completedEvidencePreserved: boolean
  independentSiblingCount: number
  confirmation: TrustedDecisionConfirmation
  currentDecision: DecisionCardInput
  requestedCiLevel: CiLevel
}

export interface DaReplanDecision {
  schemaVersion: 1
  kind: 'OES_DA_REPLAN_DECISION'
  deliveryKey: string
  ownerTaskId: string
  affectedSlice: string
  issueFingerprint: string
  selectedOutcome: DaReplanInput['selectedOutcome']
  originalDoDisposition: 'RESUME' | 'TERMINATE_BEFORE_REPLACEMENT' | 'RETAIN_AS_CO_CHILD'
  humanDecisionRequired: boolean
  nextAction: string
  decisionFingerprint: string
}

/** Reopens a DO issue decision before DA is allowed to select a new owner topology. */
export function validateDoIssueDecision(value: DoIssueDecision): DoIssueDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('DO_ISSUE_DECISION_INVALID', 'UNKNOWN')
  const keys = [
    'schemaVersion',
    'kind',
    'deliveryKey',
    'ownerTaskId',
    'affectedSlice',
    'issueKind',
    'summary',
    'issueFingerprint',
    'decision',
    'pause',
    'route',
    'allowedDaOutcomes',
    'humanDecisionRequired',
    'nextAction',
    'decisionFingerprint'
  ].sort()
  const fingerprint = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'decisionFingerprint'
  )
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'OES_DO_ISSUE_DECISION' ||
    !['CONTINUE_ORIGINAL_DO', 'RETURN_ONCE_TO_DA'].includes(value.decision) ||
    !['NONE', 'AFFECTED_SLICE_ONLY'].includes(value.pause) ||
    !['DO', 'DA', 'DA_UD_DA'].includes(value.route) ||
    !Array.isArray(value.allowedDaOutcomes) ||
    value.issueFingerprint !== issueFingerprint(issueFromDecision(value)) ||
    value.decisionFingerprint !== fingerprint
  )
    fail('DO_ISSUE_DECISION_INVALID', value.nextAction ?? 'UNKNOWN')
  const expected = decideDoIssue(issueFromDecision(value))
  if (canonicalJson(value) !== canonicalJson(expected))
    fail('DO_ISSUE_DECISION_INVALID', value.issueFingerprint)
  const local = value.decision === 'CONTINUE_ORIGINAL_DO'
  if (
    (local &&
      (value.pause !== 'NONE' ||
        value.route !== 'DO' ||
        value.allowedDaOutcomes.length !== 0 ||
        value.humanDecisionRequired ||
        value.nextAction !== 'FIX_AND_CONTINUE_CONFIRMED_DELIVERY')) ||
    (!local &&
      (value.pause !== 'AFFECTED_SLICE_ONLY' ||
        value.route === 'DO' ||
        JSON.stringify(value.allowedDaOutcomes) !==
          JSON.stringify(['RESUME_ORIGINAL_DO', 'REPLACE_WITH_NEW_DO', 'DISPATCH_CO'])))
  )
    fail('DO_ISSUE_DECISION_INVALID', value.nextAction)
  return structuredClone(value)
}

/** Keeps normal delivery friction with the DO and returns only ownership/design boundaries to DA. */
export function decideDoIssue(input: DoIssueInput): DoIssueDecision {
  validateDoIssueInput(input)
  const local = [
    'IMPLEMENTATION_DEFECT',
    'TEST_OR_CI_FINDING',
    'TOOL_OR_ENVIRONMENT_PROBLEM',
    'WITHIN_SCOPE_COMPLEXITY'
  ].includes(input.issueKind)
  const designGap = input.issueKind === 'CANONICAL_DESIGN_GAP'
  const base = local
    ? {
        schemaVersion: 1 as const,
        kind: 'OES_DO_ISSUE_DECISION' as const,
        ...structuredClone(input),
        issueFingerprint: issueFingerprint(input),
        decision: 'CONTINUE_ORIGINAL_DO' as const,
        pause: 'NONE' as const,
        route: 'DO' as const,
        allowedDaOutcomes: [],
        humanDecisionRequired: false,
        nextAction: 'FIX_AND_CONTINUE_CONFIRMED_DELIVERY'
      }
    : {
        schemaVersion: 1 as const,
        kind: 'OES_DO_ISSUE_DECISION' as const,
        ...structuredClone(input),
        issueFingerprint: issueFingerprint(input),
        decision: 'RETURN_ONCE_TO_DA' as const,
        pause: 'AFFECTED_SLICE_ONLY' as const,
        route: designGap ? ('DA_UD_DA' as const) : ('DA' as const),
        allowedDaOutcomes: [
          'RESUME_ORIGINAL_DO' as const,
          'REPLACE_WITH_NEW_DO' as const,
          'DISPATCH_CO' as const
        ],
        humanDecisionRequired: input.issueKind === 'GOAL_OR_ACCEPTANCE_CHANGE' || designGap,
        nextAction: designGap
          ? 'RETURN_ONE_BOUNDED_GAP_TO_DA_FOR_UD'
          : 'RETURN_ONE_BOUNDED_REPLAN_TO_DA'
      }
  return {
    ...base,
    decisionFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Applies DA's topology choice without duplicating the original DO or discarding completed work. */
export function decideDaReplan(input: DaReplanInput): DaReplanDecision {
  const issueDecision = validateDoIssueDecision(input.issueDecision)
  validateDoIssueInput(input.currentIssue)
  if (
    issueDecision.issueFingerprint !== issueFingerprint(input.currentIssue) ||
    issueDecision.deliveryKey !== input.currentIssue.deliveryKey ||
    issueDecision.ownerTaskId !== input.currentIssue.ownerTaskId ||
    issueDecision.affectedSlice !== input.currentIssue.affectedSlice
  )
    fail('DA_REPLAN_ISSUE_BINDING_MISMATCH', input.currentIssue.deliveryKey)
  if (
    issueDecision.decision !== 'RETURN_ONCE_TO_DA' ||
    !issueDecision.allowedDaOutcomes.includes(input.selectedOutcome)
  )
    fail('DA_REPLAN_RETURN_REQUIRED', input.selectedOutcome)
  if (!input.originalResourcesPreserved || !input.completedEvidencePreserved)
    fail('DA_REPLAN_ORIGINAL_WORK_MUST_BE_PRESERVED', input.selectedOutcome)
  if (
    input.selectedOutcome === 'DISPATCH_CO' &&
    (!Number.isSafeInteger(input.independentSiblingCount) || input.independentSiblingCount < 1)
  )
    fail('DA_REPLAN_CO_REQUIRES_INDEPENDENT_SIBLING', String(input.independentSiblingCount))
  const selected =
    input.selectedOutcome === 'RESUME_ORIGINAL_DO'
      ? {
          originalDoDisposition: 'RESUME' as const,
          nextAction: 'RETURN_DECISION_TO_ORIGINAL_DO'
        }
      : input.selectedOutcome === 'REPLACE_WITH_NEW_DO'
        ? {
            originalDoDisposition: 'TERMINATE_BEFORE_REPLACEMENT' as const,
            nextAction: 'TERMINATE_ORIGINAL_DO_THEN_DISPATCH_REPLACEMENT'
          }
        : {
            originalDoDisposition: 'RETAIN_AS_CO_CHILD' as const,
            nextAction: 'DISPATCH_CO_WITH_ORIGINAL_DO_AND_INDEPENDENT_SIBLINGS'
          }
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_DA_REPLAN_DECISION' as const,
    deliveryKey: issueDecision.deliveryKey,
    ownerTaskId: issueDecision.ownerTaskId,
    affectedSlice: issueDecision.affectedSlice,
    issueFingerprint: issueDecision.issueFingerprint,
    selectedOutcome: input.selectedOutcome,
    ...selected,
    humanDecisionRequired:
      issueDecision.humanDecisionRequired ||
      assessContinuation({
        confirmation: input.confirmation,
        currentDecision: input.currentDecision,
        requestedAction: 'IMPLEMENT',
        requestedCiLevel: input.requestedCiLevel,
        resourceOwnership: 'EXACT_TASK_OWNED'
      }).decision === 'HUMAN_DECISION_REQUIRED'
  }
  return {
    ...base,
    decisionFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Validates the exact DO issue fields before classification or DA reuse. */
function validateDoIssueInput(input: DoIssueInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('DO_ISSUE_FIELDS_INVALID', 'UNKNOWN')
  if (
    JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify(
        ['deliveryKey', 'ownerTaskId', 'affectedSlice', 'issueKind', 'summary'].sort()
      ) ||
    typeof input.deliveryKey !== 'string' ||
    typeof input.ownerTaskId !== 'string' ||
    typeof input.affectedSlice !== 'string' ||
    typeof input.summary !== 'string' ||
    !input.deliveryKey.trim() ||
    !input.ownerTaskId.trim() ||
    !input.affectedSlice.trim() ||
    !input.summary.trim()
  )
    fail('DO_ISSUE_FIELDS_INVALID', input.deliveryKey ?? 'UNKNOWN')
  if (!DO_ISSUE_KINDS.includes(input.issueKind))
    fail('DO_ISSUE_KIND_INVALID', String(input.issueKind))
}

/** Computes the issue identity carried from the reporting DO into DA's topology decision. */
function issueFingerprint(input: DoIssueInput): string {
  validateDoIssueInput(input)
  return objectFingerprint(input as unknown as Record<string, unknown>, '__none__')
}

/** Reconstructs the exact original issue from a persisted issue decision. */
function issueFromDecision(value: DoIssueDecision): DoIssueInput {
  return {
    deliveryKey: value.deliveryKey,
    ownerTaskId: value.ownerTaskId,
    affectedSlice: value.affectedSlice,
    issueKind: value.issueKind,
    summary: value.summary
  }
}
