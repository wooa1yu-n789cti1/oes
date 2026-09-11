import test, { after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AssignmentRuntimeStore,
  createAssignmentResult,
  createAssignmentResultArtifact,
  createDeliveryTopologyRequest,
  createDeliveryTopologySibling,
  createCoordinationWipAuthorityBinding,
  decideDeliveryTopology as decideDeliveryTopologyWithCoordination,
  validateAssignmentRuntimeState,
  validateDeliveryTopologyDecision as validateDeliveryTopologyDecisionWithCoordination
} from '../assignment-runtime.ts'
import type {
  ActiveChildAssignment,
  AssignmentResult,
  AssignmentResultArtifactPayload,
  AssignmentRuntimeInitialization,
  AssignmentRuntimeState,
  ChildAssignmentRequest,
  DeliveryTopologyRequest,
  DeliveryTopologySibling,
  CoordinationWipAuthorityBinding
} from '../assignment-runtime.types.ts'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import { validateJsonSchema } from '../schema-validation.ts'

const FP = {
  scope: 'a'.repeat(64),
  childScope: 'b'.repeat(64),
  root: 'c'.repeat(64),
  capability: 'd'.repeat(64)
}

const exactCoordinationStates = new Map<string, AssignmentRuntimeState>()
const defaultResultArtifactRoot = realpathSync(
  mkdtempSync(join(tmpdir(), 'oes-assignment-result-artifacts-'))
)
after(() => rmSync(defaultResultArtifactRoot, { recursive: true, force: true }))

const schema = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'schemas', name), 'utf8')
  ) as Record<string, unknown>

/** Creates one task-owned state root and removes it after the test. */
function runtime(t: TestContext, role: 'DO' | 'CO' = 'DO') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-assignment-runtime-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new AssignmentRuntimeStore(root, 'delivery-alpha')
  const initialization: AssignmentRuntimeInitialization = {
    owner: {
      role,
      taskId: role === 'DO' ? 'task-do-alpha' : 'task-sl-alpha',
      parentTaskId: 'task-parent'
    },
    coordinationKey: 'coordination-alpha',
    deliveryKey: 'delivery-alpha',
    transitionId: 'transition:alpha',
    scopeFingerprint: FP.scope,
    ceiling: {
      maxActiveDeliveryOwners: 3,
      maxActiveBoundedHelpersPerDelivery: 3,
      maxActiveReviewVerifiersPerDelivery: 1
    },
    nextLegalAction: 'DISPATCH_CHILD'
  }
  return { root, store, initialization, state: store.initialize(initialization) }
}

/** Creates one exact child dispatch request at a bound state version. */
function child(
  stateVersion: number,
  childTaskId: string,
  childKind: ChildAssignmentRequest['childKind'] = 'BOUNDED_HELPER',
  overrides: Partial<ChildAssignmentRequest> = {}
): ChildAssignmentRequest {
  return {
    expectedStateVersion: stateVersion,
    childTaskId,
    childKind,
    deliveryKey: 'delivery-alpha',
    expectedTypedResult: childKind === 'RV' ? 'SCOPED_RV_ACCEPTED' : 'SLICE_ACCEPTED',
    nextLegalActionOnResult: childKind === 'RV' ? 'PREPARE_AGGREGATE_REVIEW' : 'REVIEW_SLICE',
    scopeFingerprint: FP.childScope,
    resultArtifactRoot: defaultResultArtifactRoot,
    ...overrides
  }
}

/** Creates the exact self-hashed payload bound to one active assignment. */
function artifact(
  assignment: ActiveChildAssignment,
  overrides: Partial<AssignmentResultArtifactPayload> = {}
): AssignmentResultArtifactPayload {
  return createAssignmentResultArtifact({
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    scopeFingerprint: assignment.scopeFingerprint,
    ...overrides
  })
}

/** Writes one canonical result artifact and returns its exact outer reference. */
function writeArtifact(
  assignment: ActiveChildAssignment,
  payload = artifact(assignment),
  path = join(assignment.resultArtifactRoot, `${assignment.assignmentId}.json`)
) {
  const bytes = `${canonicalJson(payload)}\n`
  writeFileSync(path, bytes)
  return { path, sha256: sha256(bytes), fingerprint: payload.artifactFingerprint }
}

/** Creates a self-hashed result whose artifact already exists under the bound physical root. */
function result(
  assignment: ActiveChildAssignment,
  overrides: Partial<Omit<AssignmentResult, 'schemaVersion' | 'kind' | 'resultFingerprint'>> = {}
): AssignmentResult {
  return createAssignmentResult({
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    resultArtifact: writeArtifact(assignment),
    ...overrides
  })
}

/** Creates one complete independent sibling extraction binding. */
function sibling(
  deliveryKey = 'delivery-beta',
  writeSet = [`scripts/${deliveryKey}/**`],
  independent = true
): DeliveryTopologySibling {
  return createDeliveryTopologySibling({
    deliveryKey,
    objective: `Deliver ${deliveryKey}`,
    scope: [`scope:${deliveryKey}`],
    protectedScope: ['preserve:owners'],
    writeSet,
    dependencies: [],
    acceptance: [`accept:${deliveryKey}`],
    requiredCapabilityFingerprint: FP.capability,
    independenceProof: {
      independentCandidate: independent,
      independentReviewVerification: independent,
      independentPullRequest: independent,
      safeIndependentMainMerge: independent
    }
  })
}

/** Creates one exact coordination-owned WIP authority and deletes its scratch store. */
function coordinationAuthority(activeDeliveryOwners = 1): CoordinationWipAuthorityBinding {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-assignment-coordination-authority-')))
  try {
    const store = new AssignmentRuntimeStore(root, 'coordination-authority')
    let state = store.initialize({
      owner: {
        role: 'CO',
        taskId: 'task-parent',
        parentTaskId: 'task-root'
      },
      coordinationKey: 'coordination-alpha',
      deliveryKey: 'coordination-authority',
      transitionId: 'transition:alpha',
      scopeFingerprint: FP.scope,
      ceiling: {
        maxActiveDeliveryOwners: 3,
        maxActiveBoundedHelpersPerDelivery: 3,
        maxActiveReviewVerifiersPerDelivery: 1
      },
      nextLegalAction: 'DISPATCH_CHILD'
    })
    for (let index = 0; index < activeDeliveryOwners; index += 1) {
      const deliveryKey = index === 0 ? 'delivery-alpha' : `delivery-active-${index + 1}`
      state = store.dispatchChild(
        child(state.stateVersion, `task-do-authority-${index + 1}`, 'DO', {
          deliveryKey
        })
      )
    }
    const authority = createCoordinationWipAuthorityBinding(state)
    exactCoordinationStates.set(authority.authorityFingerprint, state)
    return authority
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Returns the separately transported exact Coordination state for one request. */
function exactCoordinationState(request: DeliveryTopologyRequest): AssignmentRuntimeState {
  const state = exactCoordinationStates.get(request.coordinationWipAuthority.authorityFingerprint)
  if (!state) throw new Error('exact Coordination state fixture absent')
  return state
}

/** Decides a fixture request only after authenticating its exact Coordination state. */
function decideDeliveryTopology(request: DeliveryTopologyRequest) {
  return decideDeliveryTopologyWithCoordination(request, exactCoordinationState(request))
}

/** Revalidates a fixture decision against its separately transported Coordination state. */
function validateDeliveryTopologyDecision(
  decision: Parameters<typeof validateDeliveryTopologyDecisionWithCoordination>[0],
  request: DeliveryTopologyRequest
) {
  return validateDeliveryTopologyDecisionWithCoordination(
    decision,
    request,
    exactCoordinationState(request)
  )
}

/** Creates a request containing every canonical replan binding. */
function replanRequest(
  stateVersion: number,
  proposedSiblings: DeliveryTopologySibling[],
  overrides: Partial<Parameters<typeof createDeliveryTopologyRequest>[0]> = {}
): DeliveryTopologyRequest {
  const activeDeliveryOwners = overrides.oldTopology?.activeDeliveryOwners ?? 1
  return createDeliveryTopologyRequest({
    coordinationOwnerTaskId: 'task-parent',
    deliveryOwnerTaskId: 'task-do-alpha',
    coordinationKey: 'coordination-alpha',
    deliveryKey: 'delivery-alpha',
    transitionId: 'transition:alpha',
    stateVersion,
    scopeFingerprint: FP.scope,
    rootAuthorizationFingerprint: FP.root,
    coordinationWipAuthority: coordinationAuthority(activeDeliveryOwners),
    oldTopology: { activeDeliveryOwners: 1, deliveries: [] },
    delegationCeiling: {
      maxActiveDeliveryOwners: 3,
      maxActiveBoundedHelpersPerDelivery: 3,
      maxActiveReviewVerifiersPerDelivery: 1
    },
    retainedWriteSet: ['scripts/delivery-alpha/**'],
    currentResources: {
      ownerRef: 'refs/heads/codex/delivery/delivery-alpha',
      ownerClone: '/private/tmp/oes-do-delivery-alpha',
      taskTemp: '/private/tmp/oes-do-delivery-alpha-artifacts',
      deliveryPackagePath: '/private/tmp/oes-do-delivery-alpha-artifacts/delivery-package.json'
    },
    completedSlices: [
      {
        sliceId: 'slice-alpha',
        commitSha: '1'.repeat(40),
        candidateSha: '2'.repeat(40),
        evidenceFingerprints: ['3'.repeat(64)]
      }
    ],
    proposedSiblings,
    ...overrides
  })
}

test('initialization is exact, atomic, schema-valid, and idempotent', (t) => {
  const { store, initialization, state } = runtime(t)
  assert.equal(state.stateVersion, 1)
  assert.equal(state.status, 'ACTIVE')
  assert.deepEqual(state.wip, { activeDeliveryOwners: 0, deliveries: [] })
  assert.equal(store.initialize(initialization).recordFingerprint, state.recordFingerprint)
  validateJsonSchema(schema('assignment-runtime-state.schema.json'), state)
  assert.throws(
    () => store.initialize({ ...initialization, scopeFingerprint: '9'.repeat(64) }),
    /ASSIGNMENT_STATE_BINDING_CONFLICT/
  )
})

test('WAITING_ON_CHILD survives a fresh store instance with exact route fields', (t) => {
  const { root, store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  assert.equal(waiting.status, 'WAITING_ON_CHILD')
  assert.equal(waiting.nextLegalAction, 'CONSUME_DIRECT_ASSIGNMENT_RESULT')
  assert.deepEqual(waiting.wip.deliveries, [
    { deliveryKey: 'delivery-alpha', activeBoundedHelpers: 1, activeReviewVerifiers: 0 }
  ])
  assert.deepEqual(
    {
      directParent: waiting.activeAssignments[0].parentTaskId,
      child: waiting.activeAssignments[0].childTaskId,
      expected: waiting.activeAssignments[0].expectedTypedResult,
      next: waiting.activeAssignments[0].nextLegalActionOnResult
    },
    {
      directParent: 'task-do-alpha',
      child: 'task-helper-one',
      expected: 'SLICE_ACCEPTED',
      next: 'REVIEW_SLICE'
    }
  )
  const reopened = new AssignmentRuntimeStore(root, 'delivery-alpha').load()
  assert.deepEqual(reopened, waiting)
  assert.match(
    reopened.activeAssignments[0].resultArtifactRootIdentity.device,
    /^(?:0|[1-9][0-9]*)$/
  )
  assert.match(
    reopened.activeAssignments[0].resultArtifactRootIdentity.inode,
    /^(?:0|[1-9][0-9]*)$/
  )
  assert.deepEqual(reopened.activeAssignments[0].resultArtifactRootIdentity, {
    physicalPath: reopened.activeAssignments[0].resultArtifactRoot,
    device: reopened.activeAssignments[0].resultArtifactRootIdentity.device,
    inode: reopened.activeAssignments[0].resultArtifactRootIdentity.inode,
    fileType: 'DIRECTORY'
  })
  validateJsonSchema(schema('assignment-runtime-state.schema.json'), reopened)
})

test('exact duplicate dispatch is idempotent and a conflicting active child fails closed', (t) => {
  const { store, state } = runtime(t)
  const request = child(state.stateVersion, 'task-helper-one')
  const first = store.dispatchChild(request)
  const bytes = readFileSync(store.statePath)
  assert.deepEqual(store.dispatchChild(request), first)
  assert.deepEqual(readFileSync(store.statePath), bytes)
  assert.throws(
    () =>
      store.dispatchChild(
        child(first.stateVersion, 'task-helper-one', 'BOUNDED_HELPER', {
          scopeFingerprint: '7'.repeat(64)
        })
      ),
    /ASSIGNMENT_CHILD_ALREADY_ACTIVE/
  )
  assert.deepEqual(readFileSync(store.statePath), bytes)
})

test('direct result applies once and exact replay after restart returns the original receipt', (t) => {
  const { root, store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const value = result(waiting.activeAssignments[0])
  validateJsonSchema(schema('assignment-result.schema.json'), value)
  validateJsonSchema(
    schema('assignment-result-artifact.schema.json'),
    JSON.parse(readFileSync(value.resultArtifact.path, 'utf8'))
  )
  const receipt = store.consumeResult(value)
  const after = store.load()
  assert.equal(after.status, 'ACTIVE')
  assert.equal(after.activeAssignments.length, 0)
  assert.equal(after.resultTombstones.length, 1)
  assert.equal(receipt.nextLegalAction, 'REVIEW_SLICE')
  validateJsonSchema(schema('assignment-runtime-state.schema.json'), after)
  const bytes = readFileSync(store.statePath)
  const replayed = new AssignmentRuntimeStore(root, 'delivery-alpha').consumeResult(value)
  assert.deepEqual(replayed, receipt)
  assert.deepEqual(readFileSync(store.statePath), bytes)
})

test('result artifacts must exist, remain physical children, and bind exact assignment content', (t) => {
  const { root, store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const assignment = waiting.activeAssignments[0]
  const before = readFileSync(store.statePath)
  const payload = artifact(assignment)
  const payloadBytes = `${canonicalJson(payload)}\n`

  const missingPath = join(assignment.resultArtifactRoot, 'missing-result.json')
  const missing = createAssignmentResult({
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    resultArtifact: {
      path: missingPath,
      sha256: sha256(payloadBytes),
      fingerprint: payload.artifactFingerprint
    }
  })
  assert.throws(() => store.consumeResult(missing), /ASSIGNMENT_RESULT_ARTIFACT_ABSENT/)
  assert.deepEqual(readFileSync(store.statePath), before)

  const valid = result(assignment)
  writeFileSync(valid.resultArtifact.path, `${payloadBytes}tampered`)
  assert.throws(() => store.consumeResult(valid), /ASSIGNMENT_RESULT_ARTIFACT_SHA_MISMATCH/)
  assert.deepEqual(readFileSync(store.statePath), before)
  writeFileSync(valid.resultArtifact.path, payloadBytes)

  const aliasPath = join(assignment.resultArtifactRoot, 'result-alias.json')
  symlinkSync(valid.resultArtifact.path, aliasPath)
  const aliased = createAssignmentResult({
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    resultArtifact: { ...valid.resultArtifact, path: aliasPath }
  })
  assert.throws(() => store.consumeResult(aliased), /ASSIGNMENT_RESULT_ARTIFACT_PHYSICAL_ALIAS/)
  assert.deepEqual(readFileSync(store.statePath), before)

  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'oes-assignment-other-owner-')))
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }))
  const wrongOwnerPath = join(otherRoot, 'result.json')
  writeFileSync(wrongOwnerPath, payloadBytes)
  const wrongOwner = createAssignmentResult({
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    resultArtifact: { ...valid.resultArtifact, path: wrongOwnerPath }
  })
  assert.throws(
    () => store.consumeResult(wrongOwner),
    /ASSIGNMENT_RESULT_ARTIFACT_OUTSIDE_BOUND_ROOT/
  )
  assert.deepEqual(readFileSync(store.statePath), before)

  const mismatchedPayload = artifact(assignment, { childTaskId: 'task-helper-other' })
  const mismatchedReference = writeArtifact(
    assignment,
    mismatchedPayload,
    join(assignment.resultArtifactRoot, 'mismatched-result.json')
  )
  const mismatched = createAssignmentResult({
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    resultArtifact: mismatchedReference
  })
  assert.throws(
    () => store.consumeResult(mismatched),
    /ASSIGNMENT_RESULT_ARTIFACT_ASSIGNMENT_MISMATCH/
  )
  assert.deepEqual(readFileSync(store.statePath), before)

  const receipt = store.consumeResult(valid)
  assert.equal(receipt.remainingAssignments, 0)
  assert.equal(store.load().status, 'ACTIVE')
})

test('replacing the dispatch-time result root preserves exact assignment and WIP state', (t) => {
  const { store, state } = runtime(t)
  const resultRoot = realpathSync(mkdtempSync(join(tmpdir(), 'oes-assignment-replaced-root-')))
  const originalRoot = `${resultRoot}-dispatch-object`
  t.after(() => {
    rmSync(resultRoot, { recursive: true, force: true })
    rmSync(originalRoot, { recursive: true, force: true })
  })
  const waiting = store.dispatchChild(
    child(state.stateVersion, 'task-helper-replaced-root', 'BOUNDED_HELPER', {
      resultArtifactRoot: resultRoot
    })
  )
  const assignment = waiting.activeAssignments[0]
  const before = readFileSync(store.statePath)
  renameSync(resultRoot, originalRoot)
  mkdirSync(resultRoot)
  const replacementResult = result(assignment)
  assert.throws(
    () => store.consumeResult(replacementResult),
    /ASSIGNMENT_RESULT_ARTIFACT_ROOT_IDENTITY_MISMATCH/
  )
  assert.deepEqual(readFileSync(store.statePath), before)
  const after = store.load()
  assert.equal(after.status, 'WAITING_ON_CHILD')
  assert.equal(after.activeAssignments.length, 1)
  assert.deepEqual(after.wip, waiting.wip)
})

test('wrong-route, stale, unexpected, and unknown results preserve exact state bytes', (t) => {
  const { store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const assignment = waiting.activeAssignments[0]
  const cases: Array<[AssignmentResult, RegExp]> = [
    [result(assignment, { parentTaskId: 'task-wrong-parent' }), /WRONG_PARENT/],
    [result(assignment, { childTaskId: 'task-wrong-child' }), /WRONG_CHILD/],
    [result(assignment, { transitionId: 'transition:wrong' }), /WRONG_TRANSITION/],
    [
      result(assignment, { dispatchStateVersion: assignment.dispatchStateVersion + 1 }),
      /STALE_STATE/
    ],
    [result(assignment, { typedResult: 'WRONG_RESULT' }), /UNEXPECTED_TYPE/],
    [result(assignment, { assignmentId: '8'.repeat(64) }), /ASSIGNMENT_RESULT_STALE_OR_UNKNOWN/]
  ]
  for (const [value, expected] of cases) {
    const before = readFileSync(store.statePath)
    assert.throws(() => store.consumeResult(value), expected)
    assert.deepEqual(readFileSync(store.statePath), before)
  }
})

test('a conflicting duplicate result fails without replacing the accepted tombstone', (t) => {
  const { store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const accepted = result(waiting.activeAssignments[0])
  store.consumeResult(accepted)
  const before = readFileSync(store.statePath)
  const conflict = result(waiting.activeAssignments[0], {
    resultArtifact: {
      path: '/tmp/conflicting-result.json',
      sha256: 'e'.repeat(64),
      fingerprint: '4'.repeat(64)
    }
  })
  assert.throws(() => store.consumeResult(conflict), /ASSIGNMENT_RESULT_CONFLICT/)
  assert.deepEqual(readFileSync(store.statePath), before)
})

test('parallel child results may arrive in either order and recompute WIP after each result', (t) => {
  const { store, state } = runtime(t)
  const one = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const two = store.dispatchChild(child(one.stateVersion, 'task-helper-two'))
  const review = store.dispatchChild(child(two.stateVersion, 'task-rv-one', 'RV'))
  assert.deepEqual(review.wip.deliveries, [
    { deliveryKey: 'delivery-alpha', activeBoundedHelpers: 2, activeReviewVerifiers: 1 }
  ])
  const secondAssignment = review.activeAssignments.find(
    (assignment) => assignment.childTaskId === 'task-helper-two'
  )!
  const secondReceipt = store.consumeResult(result(secondAssignment))
  assert.equal(secondReceipt.remainingAssignments, 2)
  assert.deepEqual(secondReceipt.wip.deliveries, [
    { deliveryKey: 'delivery-alpha', activeBoundedHelpers: 1, activeReviewVerifiers: 1 }
  ])
  const firstAssignment = review.activeAssignments.find(
    (assignment) => assignment.childTaskId === 'task-helper-one'
  )!
  store.consumeResult(result(firstAssignment))
  const reviewAssignment = review.activeAssignments.find(
    (assignment) => assignment.childTaskId === 'task-rv-one'
  )!
  const finalReceipt = store.consumeResult(result(reviewAssignment))
  assert.equal(finalReceipt.remainingAssignments, 0)
  assert.equal(store.load().status, 'ACTIVE')
})

test('canonical 3 DOs, 3 bounded helpers per delivery, and 1 RV ceilings never mutate on overflow', (t) => {
  const delivery = runtime(t)
  let state = delivery.state
  for (let index = 1; index <= 3; index += 1)
    state = delivery.store.dispatchChild(child(state.stateVersion, `task-helper-${index}`))
  let before = readFileSync(delivery.store.statePath)
  assert.throws(
    () => delivery.store.dispatchChild(child(state.stateVersion, 'task-helper-four')),
    /BOUNDED_HELPER_WIP_EXCEEDED/
  )
  assert.deepEqual(readFileSync(delivery.store.statePath), before)
  state = delivery.store.dispatchChild(child(state.stateVersion, 'task-rv-one', 'RV'))
  before = readFileSync(delivery.store.statePath)
  assert.throws(
    () => delivery.store.dispatchChild(child(state.stateVersion, 'task-rv-two', 'RV')),
    /RV_WIP_EXCEEDED/
  )
  assert.deepEqual(readFileSync(delivery.store.statePath), before)

  const coordination = runtime(t, 'CO')
  state = coordination.state
  for (let index = 1; index <= 3; index += 1)
    state = coordination.store.dispatchChild(
      child(state.stateVersion, `task-do-${index}`, 'DO', {
        deliveryKey: `delivery-${index}`
      })
    )
  before = readFileSync(coordination.store.statePath)
  assert.throws(
    () =>
      coordination.store.dispatchChild(
        child(state.stateVersion, 'task-do-four', 'DO', {
          deliveryKey: 'delivery-four'
        })
      ),
    /DO_WIP_EXCEEDED/
  )
  assert.deepEqual(readFileSync(coordination.store.statePath), before)
})

test('completed RV generations retain one child identity instead of dispatching a duplicate RV', (t) => {
  const { store, state } = runtime(t)
  const first = store.dispatchChild(child(state.stateVersion, 'task-rv-stable', 'RV'))
  store.consumeResult(result(first.activeAssignments[0]))
  const completed = store.load()
  const before = readFileSync(store.statePath)
  assert.throws(
    () => store.dispatchChild(child(completed.stateVersion, 'task-rv-duplicate', 'RV')),
    /ASSIGNMENT_RV_IDENTITY_CHANGED/
  )
  assert.deepEqual(readFileSync(store.statePath), before)

  const nextGeneration = store.dispatchChild(
    child(completed.stateVersion, 'task-rv-stable', 'RV', {
      scopeFingerprint: '9'.repeat(64)
    })
  )
  assert.equal(
    nextGeneration.activeAssignments.find((assignment) => assignment.childKind === 'RV')
      ?.childTaskId,
    'task-rv-stable'
  )
  assert.equal(
    nextGeneration.resultTombstones.find(
      (tombstone) => tombstone.assignment.childKind === 'RV'
    )?.assignment.childTaskId,
    'task-rv-stable'
  )
})

test('self-child and duplicate active Delivery Ownership fail before any state bytes change', (t) => {
  const delivery = runtime(t)
  let before = readFileSync(delivery.store.statePath)
  assert.throws(
    () => delivery.store.dispatchChild(child(delivery.state.stateVersion, 'task-do-alpha')),
    /ASSIGNMENT_SELF_CHILD_ROUTE/
  )
  assert.deepEqual(readFileSync(delivery.store.statePath), before)

  const coordination = runtime(t, 'CO')
  const first = coordination.store.dispatchChild(
    child(coordination.state.stateVersion, 'task-do-first', 'DO', {
      deliveryKey: 'delivery-duplicate'
    })
  )
  before = readFileSync(coordination.store.statePath)
  assert.throws(
    () =>
      coordination.store.dispatchChild(
        child(first.stateVersion, 'task-do-second', 'DO', {
          deliveryKey: 'delivery-duplicate'
        })
      ),
    /ASSIGNMENT_DUPLICATE_ACTIVE_DO/
  )
  assert.deepEqual(readFileSync(coordination.store.statePath), before)
})

test('persisted self-routes and duplicate active Delivery Owners fail on reopen', (t) => {
  const delivery = runtime(t)
  const deliveryWaiting = delivery.store.dispatchChild(
    child(delivery.state.stateVersion, 'task-helper-one')
  )
  const selfRouted = structuredClone(deliveryWaiting)
  const selfAssignment = selfRouted.activeAssignments[0]
  selfAssignment.childTaskId = selfRouted.owner.taskId
  selfAssignment.requestFingerprint = objectFingerprint(
    {
      expectedStateVersion: selfAssignment.dispatchStateVersion - 1,
      childTaskId: selfAssignment.childTaskId,
      childKind: selfAssignment.childKind,
      deliveryKey: selfAssignment.deliveryKey,
      expectedTypedResult: selfAssignment.expectedTypedResult,
      nextLegalActionOnResult: selfAssignment.nextLegalActionOnResult,
      scopeFingerprint: selfAssignment.scopeFingerprint,
      resultArtifactRoot: selfAssignment.resultArtifactRoot
    },
    '__none__'
  )
  selfAssignment.assignmentId = objectFingerprint(
    selfAssignment as unknown as Record<string, unknown>,
    'assignmentId'
  )
  selfRouted.recordFingerprint = objectFingerprint(
    selfRouted as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  assert.throws(() => validateAssignmentRuntimeState(selfRouted), /ASSIGNMENT_SELF_CHILD_ROUTE/)

  const coordination = runtime(t, 'CO')
  let coordinationState = coordination.store.dispatchChild(
    child(coordination.state.stateVersion, 'task-do-one', 'DO', {
      deliveryKey: 'delivery-one'
    })
  )
  coordinationState = coordination.store.dispatchChild(
    child(coordinationState.stateVersion, 'task-do-two', 'DO', {
      deliveryKey: 'delivery-two'
    })
  )
  const duplicated = structuredClone(coordinationState)
  const second = duplicated.activeAssignments.find(
    (assignment) => assignment.childTaskId === 'task-do-two'
  )!
  second.deliveryKey = 'delivery-one'
  second.requestFingerprint = objectFingerprint(
    {
      expectedStateVersion: second.dispatchStateVersion - 1,
      childTaskId: second.childTaskId,
      childKind: second.childKind,
      deliveryKey: second.deliveryKey,
      expectedTypedResult: second.expectedTypedResult,
      nextLegalActionOnResult: second.nextLegalActionOnResult,
      scopeFingerprint: second.scopeFingerprint,
      resultArtifactRoot: second.resultArtifactRoot
    },
    '__none__'
  )
  second.assignmentId = objectFingerprint(
    second as unknown as Record<string, unknown>,
    'assignmentId'
  )
  duplicated.activeAssignments.sort((left, right) =>
    left.assignmentId.localeCompare(right.assignmentId)
  )
  duplicated.recordFingerprint = objectFingerprint(
    duplicated as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  assert.throws(() => validateAssignmentRuntimeState(duplicated), /ASSIGNMENT_DUPLICATE_ACTIVE_DO/)
})

test('role-invalid dispatch, stale CAS, and immediate SQLite contention fail closed', (t) => {
  const { store, state } = runtime(t)
  const before = readFileSync(store.statePath)
  assert.throws(
    () => store.dispatchChild(child(state.stateVersion, 'task-do-one', 'DO')),
    /OWNER_CHILD_ROUTE_INVALID/
  )
  assert.throws(
    () =>
      store.dispatchChild(
        child(state.stateVersion, 'task-helper-other-delivery', 'BOUNDED_HELPER', {
          deliveryKey: 'delivery-other'
        })
      ),
    /DO_SCOPE_MISMATCH/
  )
  assert.throws(
    () => store.dispatchChild(child(state.stateVersion + 1, 'task-helper-one')),
    /STATE_VERSION_MISMATCH/
  )
  const competing = new DatabaseSync(store.statePath)
  competing.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
  try {
    assert.throws(
      () => store.dispatchChild(child(state.stateVersion, 'task-helper-one')),
      /ASSIGNMENT_STATE_BUSY/
    )
  } finally {
    competing.exec('ROLLBACK')
    competing.close()
  }
  assert.deepEqual(readFileSync(store.statePath), before)
})

test('tampered state fingerprint and recomputed but false WIP both fail on reopen', (t) => {
  const { store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const tampered = { ...waiting, nextLegalAction: 'WRONG_ACTION' }
  const database = new DatabaseSync(store.statePath)
  database
    .prepare('UPDATE assignment_runtime_state SET record_json = ? WHERE delivery_key = ?')
    .run(JSON.stringify(tampered), 'delivery-alpha')
  assert.throws(() => store.load(), /ASSIGNMENT_STATE_FINGERPRINT_MISMATCH/)
  const falseWip: AssignmentRuntimeState = {
    ...waiting,
    wip: { activeDeliveryOwners: 0, deliveries: [] },
    recordFingerprint: ''
  }
  falseWip.recordFingerprint = objectFingerprint(
    falseWip as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  database
    .prepare('UPDATE assignment_runtime_state SET record_json = ? WHERE delivery_key = ?')
    .run(JSON.stringify(falseWip), 'delivery-alpha')
  database.close()
  assert.throws(() => validateAssignmentRuntimeState(falseWip), /WIP_SNAPSHOT_MISMATCH/)
})

test('result-root device and inode remain canonical decimal strings across direct and SQLite validation', (t) => {
  const { store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const reseal = (field: 'device' | 'inode', value: string | number): AssignmentRuntimeState => {
    const candidate = structuredClone(waiting)
    candidate.activeAssignments[0].resultArtifactRootIdentity[field] = value as never
    candidate.activeAssignments[0].assignmentId = objectFingerprint(
      candidate.activeAssignments[0] as unknown as Record<string, unknown>,
      'assignmentId'
    )
    candidate.recordFingerprint = objectFingerprint(
      candidate as unknown as Record<string, unknown>,
      'recordFingerprint'
    )
    return candidate
  }
  const database = new DatabaseSync(store.statePath)
  const update = database.prepare(
    'UPDATE assignment_runtime_state SET record_json = ? WHERE delivery_key = ?'
  )
  const largeDecimal = '18446744073709551615'
  for (const field of ['device', 'inode'] as const) {
    const valid = reseal(field, largeDecimal)
    assert.equal(
      validateAssignmentRuntimeState(valid).activeAssignments[0].resultArtifactRootIdentity[field],
      largeDecimal
    )
    validateJsonSchema(schema('assignment-runtime-state.schema.json'), valid)
    update.run(JSON.stringify(valid), 'delivery-alpha')
    assert.equal(store.load().activeAssignments[0].resultArtifactRootIdentity[field], largeDecimal)

    const numeric = reseal(field, 123)
    assert.throws(
      () => validateJsonSchema(schema('assignment-runtime-state.schema.json'), numeric),
      /JSON_SCHEMA_VALIDATION_FAILED/
    )
    assert.throws(
      () => validateAssignmentRuntimeState(numeric),
      field === 'device'
        ? /ASSIGNMENT_RESULT_ARTIFACT_ROOT_DEVICE_INVALID/
        : /ASSIGNMENT_RESULT_ARTIFACT_ROOT_INODE_INVALID/
    )
    update.run(JSON.stringify(numeric), 'delivery-alpha')
    assert.throws(
      () => store.load(),
      field === 'device'
        ? /ASSIGNMENT_RESULT_ARTIFACT_ROOT_DEVICE_INVALID/
        : /ASSIGNMENT_RESULT_ARTIFACT_ROOT_INODE_INVALID/
    )
  }
  database.close()
})

test('complete independent proof within the ceiling yields exact DELIVERY_TOPOLOGY_REQUIRED', () => {
  const request = replanRequest(1, [sibling()])
  const decision = decideDeliveryTopology(request)
  assert.equal(decision.decision, 'DELIVERY_TOPOLOGY_REQUIRED')
  assert.equal(decision.newTopology.activeDeliveryOwners, 2)
  assert.equal(decision.nextLegalAction, 'RETURN_DELIVERY_TOPOLOGY_REQUIRED_TO_DA')
  assert.equal(decision.request.invalidationConditions.length, 9)
  validateDeliveryTopologyDecision(decision, request)
  validateJsonSchema(schema('assignment-delivery-topology.schema.json'), request)
  validateJsonSchema(schema('assignment-delivery-topology.schema.json'), decision)
})

test('incomplete independence proof preserves one atomic Delivery Owner', () => {
  const request = replanRequest(1, [sibling('delivery-beta', ['scripts/beta/**'], false)])
  const decision = decideDeliveryTopology(request)
  assert.equal(decision.decision, 'ATOMIC_CONTINUATION')
  assert.equal(decision.newTopology.activeDeliveryOwners, 1)
  assert.equal(decision.nextLegalAction, 'CONTINUE_ORIGINAL_DELIVERY_WITH_BOUNDED_HELPERS')
})

test('proven sibling WIP overflow and write conflicts fail instead of changing topology', () => {
  assert.throws(
    () =>
      decideDeliveryTopology(
        replanRequest(1, [sibling()], {
          oldTopology: { activeDeliveryOwners: 3, deliveries: [] }
        })
      ),
    /DELIVERY_TOPOLOGY_WIP_CEILING_EXCEEDED/
  )
  assert.throws(
    () =>
      decideDeliveryTopology(
        replanRequest(1, [
          sibling('delivery-beta', ['scripts/shared/**']),
          sibling('delivery-gamma', ['scripts/shared/runtime.ts'])
        ])
      ),
    /DELIVERY_TOPOLOGY_WRITE_SET_CONFLICT/
  )
  assert.throws(
    () =>
      decideDeliveryTopology(
        replanRequest(1, [sibling('delivery-beta', ['scripts/delivery-alpha/runtime/**'])])
      ),
    /DELIVERY_TOPOLOGY_RETAINED_WRITE_SET_CONFLICT/
  )
  assert.throws(
    () => sibling('delivery-beta', ['scripts/shared/*.ts']),
    /DELIVERY_TOPOLOGY_WRITE_RANGE_INVALID/
  )
})

test('Coordination WIP authority rejects a false old topology before a replan decision', () => {
  const authority = coordinationAuthority(3)
  assert.throws(
    () =>
      replanRequest(1, [sibling()], {
        coordinationWipAuthority: authority,
        oldTopology: { activeDeliveryOwners: 1, deliveries: [] }
      }),
    /DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_MISMATCH/
  )
  const tampered = {
    ...authority,
    coordinationStateVersion: authority.coordinationStateVersion + 1
  }
  assert.throws(
    () =>
      replanRequest(1, [sibling()], {
        coordinationWipAuthority: tampered
      }),
    /DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_FINGERPRINT_MISMATCH/
  )

  const exactRequest = replanRequest(1, [sibling()], {
    oldTopology: { activeDeliveryOwners: 3, deliveries: [] }
  })
  const exactState = exactCoordinationState(exactRequest)
  const forgedAuthority = {
    ...exactRequest.coordinationWipAuthority,
    activeDeliveryOwners: 1,
    activeDeliveryKeys: ['delivery-alpha'],
    authorityFingerprint: ''
  }
  forgedAuthority.authorityFingerprint = objectFingerprint(
    forgedAuthority as unknown as Record<string, unknown>,
    'authorityFingerprint'
  )
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    requestFingerprint: _requestFingerprint,
    invalidationConditions: _invalidationConditions,
    ...exactInput
  } = exactRequest
  const forgedRequest = createDeliveryTopologyRequest({
    ...exactInput,
    coordinationWipAuthority: forgedAuthority,
    oldTopology: { activeDeliveryOwners: 1, deliveries: [] }
  })
  assert.throws(
    () => decideDeliveryTopologyWithCoordination(forgedRequest, exactState),
    /DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_NOT_EXACT_STATE/
  )
})

test('any exact replan binding change invalidates the prior decision', () => {
  const request = replanRequest(1, [sibling()])
  const decision = decideDeliveryTopology(request)
  const changed = replanRequest(2, [sibling()])
  assert.throws(
    () => validateDeliveryTopologyDecision(decision, changed),
    /DELIVERY_TOPOLOGY_DECISION_INVALIDATED/
  )
  const tampered = { ...decision, reason: 'changed' }
  assert.throws(
    () => validateDeliveryTopologyDecision(tampered, request),
    /DELIVERY_TOPOLOGY_DECISION_FINGERPRINT_MISMATCH/
  )
})

test('persisted replan marker is idempotent, blocks expansion, and preserves in-flight results', (t) => {
  const { store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const request = replanRequest(waiting.stateVersion, [sibling()], {
    oldTopology: {
      activeDeliveryOwners: 1,
      deliveries: [
        { deliveryKey: 'delivery-alpha', activeBoundedHelpers: 1, activeReviewVerifiers: 0 }
      ]
    }
  })
  const decision = store.recordDeliveryTopologyDecision(request, exactCoordinationState(request))
  const marked = store.load()
  assert.equal(marked.status, 'DELIVERY_TOPOLOGY_REQUIRED')
  assert.equal(marked.deliveryTopology?.decisionFingerprint, decision.decisionFingerprint)
  validateJsonSchema(schema('assignment-runtime-state.schema.json'), marked)
  const markedBytes = readFileSync(store.statePath)
  assert.deepEqual(
    store.recordDeliveryTopologyDecision(request, exactCoordinationState(request)),
    decision
  )
  assert.deepEqual(readFileSync(store.statePath), markedBytes)
  assert.throws(
    () => store.dispatchChild(child(marked.stateVersion, 'task-helper-two')),
    /DISPATCH_AFTER_DELIVERY_TOPOLOGY/
  )
  const receipt = store.consumeResult(result(waiting.activeAssignments[0]))
  assert.equal(receipt.remainingAssignments, 0)
  const invalidated = store.load()
  assert.equal(invalidated.status, 'ACTIVE')
  assert.equal(invalidated.deliveryTopology, null)
  assert.equal(invalidated.nextLegalAction, 'REEVALUATE_DELIVERY_TOPOLOGY')
  validateJsonSchema(schema('assignment-runtime-state.schema.json'), invalidated)
  assert.throws(
    () => store.recordDeliveryTopologyDecision(request, exactCoordinationState(request)),
    /DELIVERY_TOPOLOGY_STATE_VERSION_MISMATCH/
  )
})

test('atomic continuation marker remains dispatchable and is superseded only by a new state binding', (t) => {
  const { store, state } = runtime(t)
  const request = replanRequest(state.stateVersion, [])
  const decision = store.recordDeliveryTopologyDecision(request, exactCoordinationState(request))
  assert.equal(decision.decision, 'ATOMIC_CONTINUATION')
  const recorded = store.load()
  assert.equal(recorded.status, 'ACTIVE')
  const waiting = store.dispatchChild(child(recorded.stateVersion, 'task-helper-one'))
  assert.equal(waiting.status, 'WAITING_ON_CHILD')
  assert.equal(waiting.deliveryTopology, null)
  assert.throws(
    () => store.recordDeliveryTopologyDecision(request, exactCoordinationState(request)),
    /DELIVERY_TOPOLOGY_STATE_VERSION_MISMATCH/
  )
})

test('schema and runtime both reject open or malformed assignment contracts', (t) => {
  const { store, state } = runtime(t)
  const waiting = store.dispatchChild(child(state.stateVersion, 'task-helper-one'))
  const value = result(waiting.activeAssignments[0])
  assert.throws(
    () => validateJsonSchema(schema('assignment-result.schema.json'), { ...value, extra: true }),
    /additionalProperties/
  )
  const traversalResult = {
    ...value,
    resultArtifact: {
      ...value.resultArtifact,
      path: `${value.resultArtifact.path}/../outside-result.json`
    }
  }
  assert.throws(
    () => validateJsonSchema(schema('assignment-result.schema.json'), traversalResult),
    /JSON_SCHEMA_VALIDATION_FAILED/
  )
  assert.throws(
    () =>
      createAssignmentResult({
        assignmentId: traversalResult.assignmentId,
        parentTaskId: traversalResult.parentTaskId,
        childTaskId: traversalResult.childTaskId,
        transitionId: traversalResult.transitionId,
        dispatchStateVersion: traversalResult.dispatchStateVersion,
        typedResult: traversalResult.typedResult,
        resultArtifact: traversalResult.resultArtifact
      }),
    /ASSIGNMENT_RESULT_ARTIFACT_PATH_INVALID/
  )
  const wrongRootType = structuredClone(waiting)
  wrongRootType.activeAssignments[0].resultArtifactRootIdentity.fileType = 'FILE' as never
  wrongRootType.activeAssignments[0].assignmentId = objectFingerprint(
    wrongRootType.activeAssignments[0] as unknown as Record<string, unknown>,
    'assignmentId'
  )
  wrongRootType.recordFingerprint = objectFingerprint(
    wrongRootType as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  assert.throws(
    () => validateJsonSchema(schema('assignment-runtime-state.schema.json'), wrongRootType),
    /JSON_SCHEMA_VALIDATION_FAILED/
  )
  assert.throws(
    () => validateAssignmentRuntimeState(wrongRootType),
    /ASSIGNMENT_RESULT_ARTIFACT_ROOT_TYPE_INVALID/
  )
  const request = replanRequest(waiting.stateVersion, [sibling()], {
    oldTopology: {
      activeDeliveryOwners: 1,
      deliveries: [
        { deliveryKey: 'delivery-alpha', activeBoundedHelpers: 1, activeReviewVerifiers: 0 }
      ]
    }
  })
  const malformed = {
    ...request,
    invalidationConditions: request.invalidationConditions.slice(1)
  }
  assert.throws(
    () => validateJsonSchema(schema('assignment-delivery-topology.schema.json'), malformed),
    /minItems|contains/
  )
  const openWriteGlob = structuredClone(request)
  openWriteGlob.proposedSiblings[0].writeSet = ['scripts/shared/*.ts']
  assert.throws(
    () => validateJsonSchema(schema('assignment-delivery-topology.schema.json'), openWriteGlob),
    /pattern|not/
  )
})
