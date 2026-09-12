import { canonicalJson, objectFingerprint } from './canonical.ts'
import {
  materialDecisionFingerprint,
  requireTrustedDecisionConfirmation,
  type DecisionCardInput,
  type TrustedDecisionConfirmation
} from './confirmation.ts'
import { fail } from './errors.ts'

export const ACTIVE_TASK_ROLES = ['DA', 'UD', 'DO', 'CO', 'RV'] as const
export type ActiveTaskRole = (typeof ACTIVE_TASK_ROLES)[number]

export interface DeliveryWorkstream {
  key: string
  independentlyOwnable: boolean
  independentlyReleasable: boolean
  acceptance: string[]
  writeSet: string[]
  dependencies: string[]
}

export interface RoutingDecisionInput {
  projectKey: string
  objective: string
  scope: string[]
  protectedScope: string[]
  acceptance: string[]
  integrationContract: string[]
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  approvedCiLevel: 'DOCS' | 'SCOPED' | 'FULL'
  stopPoint: string
  stateful: boolean
  executionMode: 'REPOSITORY' | 'HOST_LOCAL'
  repositoryModification: boolean
  stableDesignChange: boolean
  confirmation: TrustedDecisionConfirmation | null
  realParallelism: boolean
  crossDeliveryIntegration: boolean
  requestedPrTopology: 'DEFAULT' | 'INDEPENDENT'
  workstreams: DeliveryWorkstream[]
}

export interface RoutingDecision {
  schemaVersion: 3
  kind: 'OES_V3_ROUTING_DECISION'
  route: 'DISCUSSION' | 'DA_UD' | 'DO' | 'CO'
  executionMode: 'NONE' | 'REPOSITORY' | 'HOST_LOCAL'
  activeRoles: ActiveTaskRole[]
  deliveryOwnerCount: number
  prTopology: 'NONE' | 'ONE_DO_PR' | 'ONE_AGGREGATE_CO_PR' | 'INDEPENDENT_DO_PRS'
  nextGate: 'NONE' | 'DECISION_CONFIRMATION'
  reason: string
  decisionFingerprint: string
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Selects the smallest V2 owner topology from scope, design impact, coupling, and explicit PR choice. */
export function decideRouting(input: RoutingDecisionInput): RoutingDecision {
  if (!['REPOSITORY', 'HOST_LOCAL'].includes(input.executionMode))
    fail('ROUTING_EXECUTION_MODE_INVALID', String(input.executionMode))
  if (input.executionMode === 'HOST_LOCAL' && input.repositoryModification)
    fail('HOST_LOCAL_REPOSITORY_MODIFICATION_REQUIRES_REROUTE', 'REPOSITORY')
  if (!Array.isArray(input.workstreams)) fail('ROUTING_WORKSTREAMS_INVALID', 'not an array')
  const keys = new Set<string>()
  for (const stream of input.workstreams) {
    if (!KEY.test(stream.key) || keys.has(stream.key))
      fail('ROUTING_WORKSTREAM_KEY_INVALID', stream.key)
    keys.add(stream.key)
    if (!stream.acceptance.length || !stream.writeSet.length)
      fail('ROUTING_WORKSTREAM_UNBOUNDED', stream.key)
    for (const dependency of stream.dependencies)
      if (dependency === stream.key || !KEY.test(dependency))
        fail('ROUTING_DEPENDENCY_INVALID', `${stream.key}:${dependency}`)
  }
  for (const stream of input.workstreams)
    for (const dependency of stream.dependencies)
      if (!keys.has(dependency)) fail('ROUTING_DEPENDENCY_UNKNOWN', `${stream.key}:${dependency}`)

  if (input.stateful && !input.stableDesignChange) {
    for (const stream of input.workstreams) {
      if (
        stream.writeSet.some((path) => !input.scope.includes(path)) ||
        stream.acceptance.some((criterion) => !input.acceptance.includes(criterion))
      )
        fail('ROUTING_MATERIAL_SCOPE_MISMATCH', stream.key)
    }
  }

  if (!input.stateful)
    return seal({
      route: 'DISCUSSION',
      executionMode: 'NONE',
      activeRoles: [],
      deliveryOwnerCount: 0,
      prTopology: 'NONE',
      nextGate: 'NONE',
      reason: 'read-only discussion creates no task, branch, worktree, candidate, or pull request'
    })
  if (input.stableDesignChange) {
    const currentDecision = decisionForRoute(input, {
      decisionKind: 'PROPOSAL',
      ownerTopology: 'DA_UD',
      coupling: 'COHESIVE',
      designImpact: 'CANONICAL',
      prTopology: 'ONE_DESIGN_PR'
    })
    const confirmed = confirmationMatches(input.confirmation, currentDecision)
    return seal({
      route: 'DA_UD',
      executionMode: 'NONE',
      activeRoles: ['DA', 'UD'],
      deliveryOwnerCount: 0,
      prTopology: 'NONE',
      nextGate: confirmed ? 'NONE' : 'DECISION_CONFIRMATION',
      reason:
        'stable design changes require a DA Proposal and independent UD canonical audit before delivery'
    })
  }
  if (!input.workstreams.length) fail('ROUTING_STATEFUL_SCOPE_EMPTY', 'workstreams')
  const multipleIndependent =
    input.workstreams.length > 1 && input.workstreams.every((item) => item.independentlyOwnable)
  const coordinationJustified =
    multipleIndependent && (input.realParallelism || input.crossDeliveryIntegration)
  if (!coordinationJustified) {
    const prTopology = input.executionMode === 'REPOSITORY' ? 'ONE_DO_PR' : 'NONE'
    const currentDecision = decisionForRoute(input, {
      decisionKind: 'DELIVERY',
      ownerTopology: 'ONE_DO',
      coupling: 'COHESIVE',
      designImpact: 'NONE',
      prTopology
    })
    const confirmed = confirmationMatches(input.confirmation, currentDecision)
    return seal({
      route: 'DO',
      executionMode: input.executionMode,
      activeRoles: ['DO'],
      deliveryOwnerCount: 1,
      prTopology,
      nextGate: confirmed ? 'NONE' : 'DECISION_CONFIRMATION',
      reason:
        input.workstreams.length > 1
          ? 'size or multiple atomic slices alone does not justify CO; one DO owns the cohesive delivery'
          : input.executionMode === 'REPOSITORY'
            ? 'one cohesive repository delivery has one DO and one pull request'
            : 'one cohesive host-local operation has one DO, local verification, and no Git resources'
    })
  }
  const independentAllowed =
    input.requestedPrTopology === 'INDEPENDENT' &&
    input.workstreams.every((item) => item.independentlyReleasable)
  const prTopology =
    input.executionMode === 'HOST_LOCAL'
      ? 'NONE'
      : independentAllowed
        ? 'INDEPENDENT_DO_PRS'
        : 'ONE_AGGREGATE_CO_PR'
  const currentDecision = decisionForRoute(input, {
    decisionKind: 'DELIVERY',
    ownerTopology: 'CO_WITH_DOS',
    coupling: 'INDEPENDENT_COORDINATED',
    designImpact: 'NONE',
    prTopology
  })
  const confirmed = confirmationMatches(input.confirmation, currentDecision)
  return seal({
    route: 'CO',
    executionMode: input.executionMode,
    activeRoles: ['CO', 'DO'],
    deliveryOwnerCount: input.workstreams.length,
    prTopology,
    nextGate: confirmed ? 'NONE' : 'DECISION_CONFIRMATION',
    reason:
      input.executionMode === 'HOST_LOCAL'
        ? 'CO coordinates at least two independently ownable host-local workstreams with real parallelism or cross-operation integration and no Git resources'
        : independentAllowed
          ? 'the Human-confirmed exception uses independently releasable DO pull requests'
          : 'CO integrates independently ownable deliveries into one aggregate candidate and pull request'
  })
}

/** Accepts confirmation only when its trusted card authorizes the exact selected topology. */
function confirmationMatches(
  confirmation: TrustedDecisionConfirmation | null,
  expected: DecisionCardInput
): boolean {
  if (!confirmation) return false
  const card = requireTrustedDecisionConfirmation(confirmation).card
  if (
    card.decisionKind !== expected.decisionKind ||
    card.executionMode !== expected.executionMode ||
    card.ownerTopology !== expected.ownerTopology ||
    card.coupling !== expected.coupling ||
    card.prTopology !== expected.prTopology ||
    card.materialDecisionFingerprint !== materialDecisionFingerprint(expected)
  )
    fail('ROUTING_CONFIRMATION_MISMATCH', card.cardFingerprint)
  return true
}

/** Builds the exact current Human decision bounds from the selected route and workstream facts. */
function decisionForRoute(
  input: RoutingDecisionInput,
  route: Pick<
    DecisionCardInput,
    'decisionKind' | 'ownerTopology' | 'coupling' | 'designImpact' | 'prTopology'
  >
): DecisionCardInput {
  return {
    projectKey: input.projectKey,
    objective: input.objective,
    scope: [...input.scope],
    protectedScope: [...input.protectedScope],
    acceptance: [...input.acceptance],
    integrationContract: route.decisionKind === 'DELIVERY' ? [...input.integrationContract] : [],
    risk: input.risk,
    approvedCiLevel: input.approvedCiLevel,
    stopPoint: input.stopPoint,
    executionMode: route.decisionKind === 'PROPOSAL' ? 'REPOSITORY' : input.executionMode,
    ...route
  }
}

/** Adds the immutable routing record and fingerprint to a routing decision. */
function seal(
  value: Omit<RoutingDecision, 'schemaVersion' | 'kind' | 'decisionFingerprint'>
): RoutingDecision {
  const base = { schemaVersion: 3 as const, kind: 'OES_V3_ROUTING_DECISION' as const, ...value }
  return {
    ...base,
    decisionFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Verifies a persisted decision is canonical and unchanged. */
export function validateRoutingDecision(value: RoutingDecision): RoutingDecision {
  if (value.schemaVersion !== 3 || value.kind !== 'OES_V3_ROUTING_DECISION')
    fail('ROUTING_DECISION_KIND_INVALID', String(value.schemaVersion))
  if (canonicalJson(value.activeRoles) !== canonicalJson([...new Set(value.activeRoles)]))
    fail('ROUTING_ROLE_SET_INVALID', value.activeRoles.join(','))
  if (value.activeRoles.some((role) => !ACTIVE_TASK_ROLES.includes(role)))
    fail('ROUTING_ROLE_INVALID', value.activeRoles.join(','))
  const expected = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'decisionFingerprint'
  )
  if (expected !== value.decisionFingerprint)
    fail('ROUTING_DECISION_FINGERPRINT_MISMATCH', expected)
  return value
}
