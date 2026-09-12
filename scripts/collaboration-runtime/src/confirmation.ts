import { objectFingerprint } from './canonical.ts'
import { fail } from './errors.ts'
import { verifyTrustedReference } from './trusted-reference.ts'
import type { TrustedAuthorizationReference } from './types.ts'

export const CI_LEVELS = ['DOCS', 'SCOPED', 'FULL'] as const
export type CiLevel = (typeof CI_LEVELS)[number]

export const CONTINUOUS_ACTIONS = [
  'UD_AUDIT',
  'CANONICAL_WRITE',
  'IMPLEMENT',
  'REPAIR_WITHIN_SCOPE',
  'RV_CREATE_OR_REVIEW',
  'CI_RUN_OR_RERUN',
  'PUBLISH_PR',
  'MERGE_QUEUE_ENQUEUE',
  'MERGE_VERIFY',
  'TASK_OWNED_CLEANUP'
] as const
export type ContinuousAction = (typeof CONTINUOUS_ACTIONS)[number]

export interface DecisionCardInput {
  projectKey: string
  decisionKind: 'PROPOSAL' | 'DELIVERY'
  objective: string
  ownerTopology: 'DA_UD' | 'ONE_DO' | 'CO_WITH_DOS'
  executionMode: 'REPOSITORY' | 'HOST_LOCAL'
  scope: string[]
  protectedScope: string[]
  acceptance: string[]
  integrationContract: string[]
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  designImpact: 'NONE' | 'CANONICAL'
  coupling: 'COHESIVE' | 'INDEPENDENT_COORDINATED'
  prTopology: 'NONE' | 'ONE_DESIGN_PR' | 'ONE_DO_PR' | 'ONE_AGGREGATE_CO_PR' | 'INDEPENDENT_DO_PRS'
  approvedCiLevel: CiLevel
  stopPoint: string
}

const DECISION_INPUT_KEYS = [
  'projectKey',
  'decisionKind',
  'objective',
  'ownerTopology',
  'executionMode',
  'scope',
  'protectedScope',
  'acceptance',
  'integrationContract',
  'risk',
  'designImpact',
  'coupling',
  'prTopology',
  'approvedCiLevel',
  'stopPoint'
] as const
const PROJECT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Rejects malformed or contradictory card fields before any fingerprint exists. */
function validateDecisionCardInput(input: DecisionCardInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('DECISION_CARD_FIELDS_INVALID', 'UNKNOWN')
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...DECISION_INPUT_KEYS].sort()))
    fail('DECISION_CARD_FIELDS_INVALID', input.objective ?? 'UNKNOWN')
  if (
    !PROJECT_KEY.test(input.projectKey) ||
    typeof input.objective !== 'string' ||
    !Array.isArray(input.scope) ||
    !Array.isArray(input.protectedScope) ||
    !Array.isArray(input.acceptance) ||
    !Array.isArray(input.integrationContract) ||
    typeof input.stopPoint !== 'string' ||
    !['PROPOSAL', 'DELIVERY'].includes(input.decisionKind) ||
    !['DA_UD', 'ONE_DO', 'CO_WITH_DOS'].includes(input.ownerTopology) ||
    !['REPOSITORY', 'HOST_LOCAL'].includes(input.executionMode) ||
    !['LOW', 'MEDIUM', 'HIGH'].includes(input.risk) ||
    !['NONE', 'CANONICAL'].includes(input.designImpact) ||
    !['COHESIVE', 'INDEPENDENT_COORDINATED'].includes(input.coupling) ||
    !['NONE', 'ONE_DESIGN_PR', 'ONE_DO_PR', 'ONE_AGGREGATE_CO_PR', 'INDEPENDENT_DO_PRS'].includes(
      input.prTopology
    ) ||
    !CI_LEVELS.includes(input.approvedCiLevel)
  )
    fail('DECISION_CARD_FIELDS_INVALID', input.objective ?? 'UNKNOWN')
  if (
    !input.objective.trim() ||
    !input.scope.length ||
    input.scope.some((value) => !value.trim()) ||
    !input.protectedScope.length ||
    input.protectedScope.some((value) => !value.trim()) ||
    !input.acceptance.length ||
    input.acceptance.some((value) => !value.trim()) ||
    input.integrationContract.some((value) => !value.trim()) ||
    !input.stopPoint.trim()
  )
    fail('DECISION_CARD_SCOPE_INVALID', input.objective)
  if (
    new Set(input.scope).size !== input.scope.length ||
    new Set(input.protectedScope).size !== input.protectedScope.length ||
    new Set(input.acceptance).size !== input.acceptance.length ||
    new Set(input.integrationContract).size !== input.integrationContract.length
  )
    fail('DECISION_CARD_SCOPE_DUPLICATE', input.objective)
  const proposalTopologyValid =
    input.decisionKind === 'PROPOSAL' &&
    input.ownerTopology === 'DA_UD' &&
    input.executionMode === 'REPOSITORY' &&
    input.designImpact === 'CANONICAL' &&
    input.coupling === 'COHESIVE' &&
    input.prTopology === 'ONE_DESIGN_PR' &&
    input.integrationContract.length === 0
  const deliveryTopologyValid =
    input.decisionKind === 'DELIVERY' &&
    input.ownerTopology !== 'DA_UD' &&
    input.designImpact === 'NONE' &&
    (input.executionMode === 'HOST_LOCAL'
      ? input.prTopology === 'NONE'
      : input.prTopology !== 'NONE' && input.prTopology !== 'ONE_DESIGN_PR') &&
    (input.ownerTopology === 'ONE_DO'
      ? input.coupling === 'COHESIVE' && ['NONE', 'ONE_DO_PR'].includes(input.prTopology)
      : input.coupling === 'INDEPENDENT_COORDINATED' &&
        input.integrationContract.length > 0 &&
        ['NONE', 'ONE_AGGREGATE_CO_PR', 'INDEPENDENT_DO_PRS'].includes(input.prTopology))
  if (!proposalTopologyValid && !deliveryTopologyValid)
    fail('DECISION_CARD_TOPOLOGY_INVALID', input.objective)
}

export interface DecisionCard extends DecisionCardInput {
  schemaVersion: 2
  kind: 'OES_DECISION_CARD'
  coveredActions: ContinuousAction[]
  scopeFingerprint: string
  materialDecisionFingerprint: string
  cardFingerprint: string
}

export interface HumanConfirmationReceipt {
  schemaVersion: 1
  kind: 'OES_HUMAN_CONFIRMATION_RECEIPT'
  projectKey: string
  decision: 'CONFIRMED'
  confirmedBy: 'HUMAN'
  confirmedAt: string
  card: TrustedAuthorizationReference
  confirmationFingerprint: string
}

export interface TrustedDecisionConfirmation {
  reference: TrustedAuthorizationReference
  receipt: HumanConfirmationReceipt
  card: DecisionCard
}

export interface ContinuationAssessmentInput {
  confirmation: TrustedDecisionConfirmation
  currentDecision: DecisionCardInput
  requestedAction: ContinuousAction
  requestedCiLevel: CiLevel
  resourceOwnership: 'EXACT_TASK_OWNED' | 'UNOWNED_OR_AMBIGUOUS'
}

export interface ContinuationAssessment {
  decision: 'CONTINUE_AUTONOMOUSLY' | 'HUMAN_DECISION_REQUIRED'
  reasons: string[]
  nextAction: 'EXECUTE_REQUESTED_ACTION' | 'PRESENT_ONE_DECISION_CARD'
}

const trustedConfirmations = new WeakMap<object, string>()

/** Computes the material scope identity that survives candidate-only repairs. */
export function decisionScopeFingerprint(
  value: Pick<DecisionCardInput, 'scope' | 'protectedScope'>
): string {
  return objectFingerprint({ scope: value.scope, protectedScope: value.protectedScope }, '__none__')
}

/** Computes the shared Human decision identity while retaining the confirmed delivery topology. */
export function materialDecisionFingerprint(value: DecisionCardInput): string {
  validateDecisionCardInput(value)
  return objectFingerprint(
    {
      projectKey: value.projectKey,
      decisionKind: value.decisionKind,
      objective: value.objective,
      executionMode: value.executionMode,
      scope: [...value.scope].sort(),
      protectedScope: [...value.protectedScope].sort(),
      acceptance: [...value.acceptance].sort(),
      integrationContract: [...value.integrationContract].sort(),
      risk: value.risk,
      designImpact: value.designImpact,
      ownerTopology: value.ownerTopology,
      coupling: value.coupling,
      prTopology: value.prTopology,
      approvedCiLevel: value.approvedCiLevel,
      stopPoint: value.stopPoint
    },
    '__none__'
  )
}

/** Generates the only Human card used to authorize one bounded Proposal or delivery. */
export function createDecisionCard(input: DecisionCardInput): DecisionCard {
  validateDecisionCardInput(input)
  const repositoryActions: ContinuousAction[] = [
    'PUBLISH_PR',
    'MERGE_QUEUE_ENQUEUE',
    'MERGE_VERIFY'
  ]
  const coveredActions: ContinuousAction[] =
    input.decisionKind === 'PROPOSAL'
      ? [
          'UD_AUDIT',
          'CANONICAL_WRITE',
          'RV_CREATE_OR_REVIEW',
          'CI_RUN_OR_RERUN',
          ...repositoryActions,
          'TASK_OWNED_CLEANUP'
        ]
      : [
          'IMPLEMENT',
          'REPAIR_WITHIN_SCOPE',
          'RV_CREATE_OR_REVIEW',
          ...(input.executionMode === 'REPOSITORY'
            ? (['CI_RUN_OR_RERUN', ...repositoryActions] as ContinuousAction[])
            : []),
          'TASK_OWNED_CLEANUP'
        ]
  const base = {
    schemaVersion: 2 as const,
    kind: 'OES_DECISION_CARD' as const,
    ...structuredClone(input),
    coveredActions,
    scopeFingerprint: decisionScopeFingerprint(input),
    materialDecisionFingerprint: materialDecisionFingerprint(input)
  }
  return {
    ...base,
    cardFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Validates an existing decision card without treating its self-hash as Human approval. */
export function validateDecisionCard(card: DecisionCard): DecisionCard {
  if (!card || typeof card !== 'object' || Array.isArray(card))
    fail('DECISION_CARD_FIELDS_INVALID', 'UNKNOWN')
  if (
    JSON.stringify(Object.keys(card).sort()) !==
    JSON.stringify(
      [
        ...DECISION_INPUT_KEYS,
        'schemaVersion',
        'kind',
        'coveredActions',
        'scopeFingerprint',
        'materialDecisionFingerprint',
        'cardFingerprint'
      ].sort()
    )
  )
    fail('DECISION_CARD_FIELDS_INVALID', card.objective ?? 'UNKNOWN')
  const expected = createDecisionCard(decisionInputFromCard(card))
  if (
    card.schemaVersion !== expected.schemaVersion ||
    card.kind !== expected.kind ||
    card.cardFingerprint !== expected.cardFingerprint ||
    objectFingerprint(card as unknown as Record<string, unknown>, 'cardFingerprint') !==
      card.cardFingerprint ||
    JSON.stringify(card.coveredActions) !== JSON.stringify(expected.coveredActions) ||
    card.scopeFingerprint !== expected.scopeFingerprint ||
    card.materialDecisionFingerprint !== expected.materialDecisionFingerprint
  )
    fail('DECISION_CARD_FINGERPRINT_MISMATCH', card.objective)
  return structuredClone(card)
}

/** Seals a controller-issued Human confirmation record; trust is established only by reopening it. */
export function createHumanConfirmationReceipt(
  input: Omit<
    HumanConfirmationReceipt,
    'schemaVersion' | 'kind' | 'decision' | 'confirmedBy' | 'confirmationFingerprint'
  >
): HumanConfirmationReceipt {
  if (!PROJECT_KEY.test(input.projectKey) || !Number.isFinite(Date.parse(input.confirmedAt)))
    fail('HUMAN_CONFIRMATION_FIELDS_INVALID', input.projectKey)
  validateReferenceShape(input.card, 'humanConfirmation.card')
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_HUMAN_CONFIRMATION_RECEIPT' as const,
    projectKey: input.projectKey,
    decision: 'CONFIRMED' as const,
    confirmedBy: 'HUMAN' as const,
    confirmedAt: input.confirmedAt,
    card: structuredClone(input.card)
  }
  return {
    ...base,
    confirmationFingerprint: objectFingerprint(
      base as unknown as Record<string, unknown>,
      '__none__'
    )
  }
}

/** Reopens a controller-owned receipt and its exact card under the verified authorization root. */
export function loadTrustedDecisionConfirmation(
  reference: TrustedAuthorizationReference,
  authorizationRoot: string
): TrustedDecisionConfirmation {
  const raw = verifyTrustedReference(reference, authorizationRoot, 'confirmationFingerprint')
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'projectKey',
    'decision',
    'confirmedBy',
    'confirmedAt',
    'card',
    'confirmationFingerprint'
  ].sort()
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(expectedKeys))
    fail('HUMAN_CONFIRMATION_FIELDS_INVALID', reference.path)
  const receipt = raw as unknown as HumanConfirmationReceipt
  validateReferenceShape(receipt.card, 'humanConfirmation.card')
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'OES_HUMAN_CONFIRMATION_RECEIPT' ||
    receipt.decision !== 'CONFIRMED' ||
    receipt.confirmedBy !== 'HUMAN' ||
    !PROJECT_KEY.test(receipt.projectKey) ||
    !Number.isFinite(Date.parse(receipt.confirmedAt))
  )
    fail('HUMAN_CONFIRMATION_INVALID', reference.path)
  const card = validateDecisionCard(
    verifyTrustedReference(
      receipt.card,
      authorizationRoot,
      'cardFingerprint'
    ) as unknown as DecisionCard
  )
  if (card.projectKey !== receipt.projectKey)
    fail('HUMAN_CONFIRMATION_CARD_BINDING_MISMATCH', receipt.projectKey)
  const trusted = deepFreeze({
    reference: structuredClone(reference),
    receipt: structuredClone(receipt),
    card
  })
  trustedConfirmations.set(trusted, JSON.stringify(reference))
  return trusted
}

/** Requires an object obtained from the trusted receipt loader in this process. */
export function requireTrustedDecisionConfirmation(
  value: TrustedDecisionConfirmation
): TrustedDecisionConfirmation {
  if (!value || trustedConfirmations.get(value) !== JSON.stringify(value.reference))
    fail('TRUSTED_HUMAN_CONFIRMATION_REQUIRED', 'decision confirmation')
  return value
}

/** Reuses one confirmation until the material decision bounds actually change. */
export function assessContinuation(input: ContinuationAssessmentInput): ContinuationAssessment {
  const confirmation = requireTrustedDecisionConfirmation(input.confirmation)
  const card = confirmation.card
  if (!CONTINUOUS_ACTIONS.includes(input.requestedAction))
    fail('CONTINUATION_ACTION_INVALID', String(input.requestedAction))
  if (!CI_LEVELS.includes(input.requestedCiLevel))
    fail('CONTINUATION_CI_LEVEL_INVALID', String(input.requestedCiLevel))
  validateDecisionCardInput(input.currentDecision)
  if (!['EXACT_TASK_OWNED', 'UNOWNED_OR_AMBIGUOUS'].includes(input.resourceOwnership))
    fail('CONTINUATION_RESOURCE_OWNERSHIP_INVALID', String(input.resourceOwnership))
  const reasons: string[] = []
  if (!card.coveredActions.includes(input.requestedAction)) reasons.push('ACTION_NOT_COVERED')
  const confirmedInput = decisionInputFromCard(card)
  if (input.currentDecision.objective !== confirmedInput.objective)
    reasons.push('OBJECTIVE_CHANGED')
  if (
    input.currentDecision.designImpact !== confirmedInput.designImpact ||
    input.currentDecision.decisionKind !== confirmedInput.decisionKind
  )
    reasons.push('CANONICAL_DESIGN_CHANGED')
  if (
    decisionScopeFingerprint(input.currentDecision) !== card.scopeFingerprint ||
    JSON.stringify([...input.currentDecision.acceptance].sort()) !==
      JSON.stringify([...confirmedInput.acceptance].sort())
  )
    reasons.push('SCOPE_CHANGED')
  if (
    input.currentDecision.risk !== confirmedInput.risk ||
    input.currentDecision.projectKey !== confirmedInput.projectKey ||
    input.currentDecision.executionMode !== confirmedInput.executionMode ||
    JSON.stringify([...input.currentDecision.integrationContract].sort()) !==
      JSON.stringify([...confirmedInput.integrationContract].sort()) ||
    input.currentDecision.stopPoint !== confirmedInput.stopPoint
  )
    reasons.push('DELIVERY_BOUNDS_CHANGED')
  if (
    input.currentDecision.ownerTopology !== confirmedInput.ownerTopology ||
    input.currentDecision.coupling !== confirmedInput.coupling ||
    input.currentDecision.prTopology !== confirmedInput.prTopology
  )
    reasons.push('DELIVERY_TOPOLOGY_CHANGED')
  if (input.resourceOwnership === 'UNOWNED_OR_AMBIGUOUS')
    reasons.push('UNOWNED_OR_AMBIGUOUS_DESTRUCTIVE_RESOURCE')
  if (CI_LEVELS.indexOf(input.requestedCiLevel) > CI_LEVELS.indexOf(card.approvedCiLevel))
    reasons.push('CI_LEVEL_INCREASED')
  return reasons.length
    ? {
        decision: 'HUMAN_DECISION_REQUIRED',
        reasons: [...new Set(reasons)],
        nextAction: 'PRESENT_ONE_DECISION_CARD'
      }
    : {
        decision: 'CONTINUE_AUTONOMOUSLY',
        reasons: [],
        nextAction: 'EXECUTE_REQUESTED_ACTION'
      }
}

/** Extracts only the Human-visible material fields from a sealed card. */
export function decisionInputFromCard(card: DecisionCard): DecisionCardInput {
  return {
    projectKey: card.projectKey,
    decisionKind: card.decisionKind,
    objective: card.objective,
    ownerTopology: card.ownerTopology,
    executionMode: card.executionMode,
    scope: [...card.scope],
    protectedScope: [...card.protectedScope],
    acceptance: [...card.acceptance],
    integrationContract: [...card.integrationContract],
    risk: card.risk,
    designImpact: card.designImpact,
    coupling: card.coupling,
    prTopology: card.prTopology,
    approvedCiLevel: card.approvedCiLevel,
    stopPoint: card.stopPoint
  }
}

/** Validates the immutable three-field reference shape before using the generic trust loader. */
function validateReferenceShape(value: TrustedAuthorizationReference, field: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['fingerprint', 'path', 'sha256']) ||
    typeof value.path !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint)
  )
    fail('HUMAN_CONFIRMATION_REFERENCE_INVALID', field)
}

/** Freezes reopened trusted values so their in-process trust mark cannot survive mutation. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
