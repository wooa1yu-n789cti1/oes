import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executionCapabilities } from '../capabilities.ts'
import { assessContinuation, createDecisionCard, decisionInputFromCard } from '../confirmation.ts'
import {
  createDeliveryLifecycleCleanupResult,
  planDeliveryLifecycle
} from '../delivery-lifecycle.ts'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import { RuntimeContractError } from '../errors.ts'
import { decideDaReplan, decideDoIssue, validateDoIssueDecision } from '../replan.ts'
import {
  createReviewSession,
  FileReviewSessionStore,
  validateReviewSession
} from '../review-session.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import { createUdBinding, FileUdBindingStore, terminateUdBinding } from '../ud-binding.ts'
import {
  deliveryDecisionInput,
  fixtureTrust,
  persistTrustedConfirmation
} from './trusted-confirmation-fixture.ts'

const schema = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'schemas', name), 'utf8')
  ) as Record<string, unknown>

/** Creates one representative delivery decision card. */
function decisionCard() {
  return createDecisionCard(deliveryDecisionInput())
}

test('one trusted confirmation authorizes repair, RV, CI, Merge Queue, merge and cleanup', () => {
  const { confirmation } = persistTrustedConfirmation()
  const card = confirmation.card
  validateJsonSchema(schema('decision-card.schema.json'), card)
  for (const requestedAction of card.coveredActions) {
    assert.equal(
      assessContinuation({
        confirmation,
        currentDecision: decisionInputFromCard(card),
        requestedAction,
        requestedCiLevel: 'FULL',
        resourceOwnership: 'EXACT_TASK_OWNED'
      }).decision,
      'CONTINUE_AUTONOMOUSLY'
    )
  }
  assert.throws(
    () =>
      assessContinuation({
        confirmation: structuredClone(confirmation),
        currentDecision: decisionInputFromCard(card),
        requestedAction: 'IMPLEMENT',
        requestedCiLevel: 'FULL',
        resourceOwnership: 'EXACT_TASK_OWNED'
      }),
    /TRUSTED_HUMAN_CONFIRMATION_REQUIRED/
  )
})

test('only material bounds or a higher CI level return to Human', () => {
  const { confirmation } = persistTrustedConfirmation()
  const currentDecision = decisionInputFromCard(confirmation.card)
  currentDecision.scope = ['expanded collaboration runtime']
  const result = assessContinuation({
    confirmation,
    currentDecision,
    requestedAction: 'REPAIR_WITHIN_SCOPE',
    requestedCiLevel: 'FULL',
    resourceOwnership: 'EXACT_TASK_OWNED'
  })
  assert.deepEqual(result.reasons, ['SCOPE_CHANGED'])
  assert.equal(result.nextAction, 'PRESENT_ONE_DECISION_CARD')
  assert.throws(
    () =>
      assessContinuation({
        confirmation,
        currentDecision: decisionInputFromCard(confirmation.card),
        requestedAction: 'REPAIR_WITHIN_SCOPE',
        requestedCiLevel: 'BOGUS' as never,
        resourceOwnership: 'EXACT_TASK_OWNED'
      }),
    /CONTINUATION_CI_LEVEL_INVALID/
  )
})

test('a changed delivery topology returns to Human instead of reusing the DO confirmation', () => {
  const { confirmation } = persistTrustedConfirmation(
    deliveryDecisionInput({ integrationContract: ['integrate the delivery'] })
  )
  const currentDecision = decisionInputFromCard(confirmation.card)
  currentDecision.ownerTopology = 'CO_WITH_DOS'
  currentDecision.coupling = 'INDEPENDENT_COORDINATED'
  currentDecision.prTopology = 'ONE_AGGREGATE_CO_PR'
  const result = assessContinuation({
    confirmation,
    currentDecision,
    requestedAction: 'IMPLEMENT',
    requestedCiLevel: 'FULL',
    resourceOwnership: 'EXACT_TASK_OWNED'
  })
  assert.deepEqual(result.reasons, ['DELIVERY_TOPOLOGY_CHANGED'])
  assert.equal(result.decision, 'HUMAN_DECISION_REQUIRED')
  assert.equal(result.nextAction, 'PRESENT_ONE_DECISION_CARD')
})

test('execution mode controls covered actions and contradictory topologies are rejected', () => {
  const proposal = createDecisionCard(
    deliveryDecisionInput({
      decisionKind: 'PROPOSAL',
      ownerTopology: 'DA_UD',
      executionMode: 'REPOSITORY',
      designImpact: 'CANONICAL',
      prTopology: 'ONE_DESIGN_PR',
      approvedCiLevel: 'DOCS',
      scope: ['canonical design']
    })
  )
  validateJsonSchema(schema('decision-card.schema.json'), proposal)
  const hostLocal = createDecisionCard(
    deliveryDecisionInput({ executionMode: 'HOST_LOCAL', prTopology: 'NONE' })
  )
  assert.doesNotMatch(hostLocal.coveredActions.join(','), /CI_RUN|PUBLISH|MERGE/)
  assert.throws(
    () =>
      createDecisionCard(
        deliveryDecisionInput({
          ownerTopology: 'DA_UD',
          designImpact: 'CANONICAL',
          prTopology: 'ONE_DESIGN_PR'
        })
      ),
    /DECISION_CARD_TOPOLOGY_INVALID/
  )
})

test('one profile-derived project UD binding rejects a second active UD and permits a successor', () => {
  const first = createUdBinding({
    projectKey: 'oes',
    taskId: 'ud-1',
    generation: 1,
    state: 'ACTIVE'
  })
  validateJsonSchema(schema('ud-binding.schema.json'), first)
  assert.throws(
    () =>
      createUdBinding({ projectKey: 'oes', taskId: 'ud-2', generation: 2, state: 'ACTIVE' }, first),
    (error: unknown) =>
      error instanceof RuntimeContractError &&
      error.code === 'UD_ALREADY_ACTIVE' &&
      error.nextAction === 'SEND_PROPOSAL_TO_BOUND_UD'
  )
  const terminal = terminateUdBinding(first)
  const successor = createUdBinding(
    { projectKey: 'oes', taskId: 'ud-2', generation: 2, state: 'ACTIVE' },
    terminal
  )
  assert.equal(successor.taskId, 'ud-2')

  const root = mkdtempSync(join(tmpdir(), 'oes-ud-binding-test-'))
  const store = new FileUdBindingStore(fixtureTrust(root))
  const stored = store.bind(
    { projectKey: 'oes', taskId: 'ud-1', generation: 1, state: 'ACTIVE' },
    null
  )
  assert.equal(store.read('oes')?.taskId, 'ud-1')
  assert.throws(
    () =>
      store.bind(
        { projectKey: 'oes', taskId: 'ud-2', generation: 2, state: 'ACTIVE' },
        stored.bindingFingerprint
      ),
    /UD_ALREADY_ACTIVE/
  )
})

test('the same visible RV subagent serially reviews candidate generations without duplication', () => {
  const first = createReviewSession({
    deliveryKey: 'runtime',
    ownerTaskId: '/root/do-runtime',
    reviewerAgentId: '/root/do-runtime/rv',
    candidateGenerations: ['1'.repeat(40)],
    state: 'ACTIVE'
  })
  validateJsonSchema(schema('review-session.schema.json'), first)
  const second = createReviewSession(
    {
      deliveryKey: 'runtime',
      ownerTaskId: '/root/do-runtime',
      reviewerAgentId: '/root/do-runtime/rv',
      candidateGenerations: ['1'.repeat(40), '2'.repeat(40)],
      state: 'ACTIVE'
    },
    first
  )
  assert.equal(second.reviewerAgentId, first.reviewerAgentId)
  assert.throws(
    () =>
      createReviewSession(
        {
          deliveryKey: second.deliveryKey,
          ownerTaskId: second.ownerTaskId,
          reviewerAgentId: '/root/do-runtime/rv-duplicate',
          candidateGenerations: second.candidateGenerations,
          state: second.state
        },
        first
      ),
    /ASSIGNMENT_RV_WIP_EXCEEDED/
  )
  const terminal = createReviewSession(
    {
      deliveryKey: second.deliveryKey,
      ownerTaskId: second.ownerTaskId,
      reviewerAgentId: second.reviewerAgentId,
      candidateGenerations: second.candidateGenerations,
      state: 'TERMINAL'
    },
    second
  )
  assert.throws(
    () =>
      createReviewSession(
        {
          deliveryKey: terminal.deliveryKey,
          ownerTaskId: terminal.ownerTaskId,
          reviewerAgentId: terminal.reviewerAgentId,
          candidateGenerations: terminal.candidateGenerations,
          state: 'ACTIVE'
        },
        terminal
      ),
    /RV_TERMINAL_MUTATION_FORBIDDEN/
  )
  assert.throws(
    () =>
      createReviewSession(
        {
          deliveryKey: terminal.deliveryKey,
          ownerTaskId: terminal.ownerTaskId,
          reviewerAgentId: terminal.reviewerAgentId,
          candidateGenerations: [...terminal.candidateGenerations, '3'.repeat(40)],
          state: 'TERMINAL'
        },
        terminal
      ),
    /RV_TERMINAL_MUTATION_FORBIDDEN/
  )
  const resealedWithExtraField = {
    ...terminal,
    undeclared: true
  } as unknown as Record<string, unknown>
  resealedWithExtraField.sessionFingerprint = objectFingerprint(
    resealedWithExtraField,
    'sessionFingerprint'
  )
  assert.throws(() => validateReviewSession(resealedWithExtraField as never), /RV_SESSION_INVALID/)
  const store = new FileReviewSessionStore(
    fixtureTrust(mkdtempSync(join(tmpdir(), 'oes-rv-binding-test-')))
  )
  const stored = store.bind(
    {
      deliveryKey: first.deliveryKey,
      ownerTaskId: first.ownerTaskId,
      reviewerAgentId: first.reviewerAgentId,
      candidateGenerations: first.candidateGenerations,
      state: first.state
    },
    null
  )
  assert.equal(store.read('runtime')?.sessionFingerprint, stored.sessionFingerprint)
})

test('DO handles normal friction and returns only boundary changes once to DA', () => {
  const replanDecision = deliveryDecisionInput({
    integrationContract: ['preserve runtime then integrate docs']
  })
  const replanConfirmation = persistTrustedConfirmation(replanDecision).confirmation
  const base = {
    deliveryKey: 'runtime',
    ownerTaskId: '/root/do-runtime',
    affectedSlice: 'verification',
    summary: 'bounded issue'
  }
  assert.equal(
    decideDoIssue({ ...base, issueKind: 'TOOL_OR_ENVIRONMENT_PROBLEM' }).decision,
    'CONTINUE_ORIGINAL_DO'
  )
  const gap = decideDoIssue({ ...base, issueKind: 'CANONICAL_DESIGN_GAP' })
  assert.equal(gap.route, 'DA_UD_DA')
  assert.equal(gap.pause, 'AFFECTED_SLICE_ONLY')
  const topology = decideDoIssue({ ...base, issueKind: 'DELIVERY_STRUCTURE_CHANGE' })
  assert.throws(
    () => validateDoIssueDecision({ ...topology, nextAction: 'DISPATCH_NEW_DO_DIRECTLY' }),
    /DO_ISSUE_DECISION_INVALID/
  )
  const alteredIssueKind = {
    ...topology,
    issueKind: 'GOAL_OR_ACCEPTANCE_CHANGE'
  } as typeof topology
  alteredIssueKind.issueFingerprint = objectFingerprint(
    {
      deliveryKey: alteredIssueKind.deliveryKey,
      ownerTaskId: alteredIssueKind.ownerTaskId,
      affectedSlice: alteredIssueKind.affectedSlice,
      issueKind: alteredIssueKind.issueKind,
      summary: alteredIssueKind.summary
    },
    '__none__'
  )
  alteredIssueKind.decisionFingerprint = objectFingerprint(
    alteredIssueKind as unknown as Record<string, unknown>,
    'decisionFingerprint'
  )
  assert.throws(() => validateDoIssueDecision(alteredIssueKind), /DO_ISSUE_DECISION_INVALID/)
  const coordination = decideDaReplan({
    issueDecision: topology,
    currentIssue: { ...base, issueKind: 'DELIVERY_STRUCTURE_CHANGE' },
    selectedOutcome: 'DISPATCH_CO',
    originalResourcesPreserved: true,
    completedEvidencePreserved: true,
    independentSiblingCount: 1,
    confirmation: replanConfirmation,
    currentDecision: deliveryDecisionInput({
      ownerTopology: 'CO_WITH_DOS',
      coupling: 'INDEPENDENT_COORDINATED',
      prTopology: 'ONE_AGGREGATE_CO_PR',
      integrationContract: replanDecision.integrationContract
    }),
    requestedCiLevel: 'FULL'
  })
  assert.equal(coordination.originalDoDisposition, 'RETAIN_AS_CO_CHILD')
  assert.equal(coordination.humanDecisionRequired, true)
  assert.equal(coordination.issueFingerprint, topology.issueFingerprint)
  assert.throws(
    () =>
      decideDaReplan({
        issueDecision: topology,
        currentIssue: {
          ...base,
          affectedSlice: 'different-delivery-slice',
          issueKind: 'DELIVERY_STRUCTURE_CHANGE'
        },
        selectedOutcome: 'RESUME_ORIGINAL_DO',
        originalResourcesPreserved: true,
        completedEvidencePreserved: true,
        independentSiblingCount: 0,
        confirmation: replanConfirmation,
        currentDecision: replanDecision,
        requestedCiLevel: 'FULL'
      }),
    /DA_REPLAN_ISSUE_BINDING_MISMATCH/
  )
})

test('archive requires a controller-owned exact cleanup result, not caller booleans', () => {
  const authorizationRoot = mkdtempSync(join(tmpdir(), 'oes-lifecycle-test-'))
  const trust = fixtureTrust(authorizationRoot)
  const ownerBinding = readFileSync(trust.ownerResourceBinding!.path, 'utf8')
  const packagePath = (JSON.parse(ownerBinding) as { deliveryPackagePath: string })
    .deliveryPackagePath
  const result = createDeliveryLifecycleCleanupResult({
    deliveryKey: 'runtime',
    ownerTaskId: trust.ownerTaskId,
    executionMode: 'REPOSITORY',
    terminalPackageFingerprint: 'a'.repeat(64),
    reviewSessionFingerprint: 'b'.repeat(64),
    reviewerTaskId: '/root/do-runtime/rv',
    packagePath
  })
  const path = join(trust.authorizationRoot, 'delivery-cleanup-result.json')
  const bytes = `${canonicalJson(result)}\n`
  writeFileSync(path, bytes)
  const final = planDeliveryLifecycle(
    {
      deliveryPackage: null,
      executionMode: 'REPOSITORY',
      cleanupResult: {
        path,
        sha256: sha256(bytes),
        fingerprint: result.resultFingerprint
      }
    },
    trust
  )
  assert.equal(final.action, 'ARCHIVE_DO')
  assert.equal(final.confirmationRequired, false)
})

test('agent-facing merge stage exposes the actual Merge Queue driver command only', () => {
  const capabilities = executionCapabilities('MERGE')
  assert.equal(capabilities.length, 1)
  assert.equal(capabilities[0].operation, 'enqueue')
  assert.match(capabilities[0].tool, /oes-remote-driver.*MERGE_QUEUE_BINDING/)
})

test('card self-hash alone is not a confirmation', () => {
  const card = decisionCard()
  assert.throws(
    () =>
      assessContinuation({
        confirmation: { reference: {} as never, receipt: {} as never, card },
        currentDecision: decisionInputFromCard(card),
        requestedAction: 'IMPLEMENT',
        requestedCiLevel: 'FULL',
        resourceOwnership: 'EXACT_TASK_OWNED'
      }),
    /TRUSTED_HUMAN_CONFIRMATION_REQUIRED/
  )
})
