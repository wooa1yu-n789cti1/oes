import assert from 'node:assert/strict'
import test from 'node:test'
import { decideRouting, validateRoutingDecision } from '../routing.ts'
import {
  deliveryDecisionInput,
  persistTrustedConfirmation
} from './trusted-confirmation-fixture.ts'

const stream = (key: string) => ({
  key,
  independentlyOwnable: true,
  independentlyReleasable: true,
  acceptance: ['accepted'],
  writeSet: [`src/${key}/**`],
  dependencies: [] as string[]
})
const base = {
  projectKey: 'oes',
  objective: 'Deliver routed work',
  scope: ['src/one/**'],
  protectedScope: ['product behavior'],
  acceptance: ['accepted'],
  integrationContract: [] as string[],
  risk: 'MEDIUM' as const,
  approvedCiLevel: 'SCOPED' as const,
  stopPoint: 'terminal delivery disposal',
  stateful: true,
  executionMode: 'REPOSITORY' as const,
  repositoryModification: true,
  stableDesignChange: false,
  confirmation: null,
  realParallelism: false,
  crossDeliveryIntegration: false,
  requestedPrTopology: 'DEFAULT' as const,
  workstreams: [stream('one')]
}

test('read-only discussion creates no role or Git topology', () => {
  const result = validateRoutingDecision(
    decideRouting({ ...base, stateful: false, workstreams: [] })
  )
  assert.equal(result.route, 'DISCUSSION')
  assert.deepEqual(result.activeRoles, [])
})

test('one cohesive delivery routes to one DO regardless of size', () => {
  const result = decideRouting({
    ...base,
    scope: ['src/one/**', 'src/two/**'],
    workstreams: [stream('one'), { ...stream('two'), independentlyOwnable: false }],
    realParallelism: true
  })
  assert.equal(result.route, 'DO')
  assert.equal(result.prTopology, 'ONE_DO_PR')
})

test('CO requires independent workstreams and defaults to one aggregate PR', () => {
  const result = decideRouting({
    ...base,
    scope: ['src/one/**', 'src/two/**'],
    integrationContract: ['integrate one before two'],
    workstreams: [stream('one'), stream('two')],
    realParallelism: true
  })
  assert.equal(result.route, 'CO')
  assert.equal(result.prTopology, 'ONE_AGGREGATE_CO_PR')
})

test('independent PR exception is proposed before confirmation and cleared only by its trusted card', () => {
  const request = {
    ...base,
    scope: ['src/one/**', 'src/two/**'],
    integrationContract: ['integrate both units'],
    workstreams: [stream('one'), stream('two')],
    realParallelism: true,
    requestedPrTopology: 'INDEPENDENT' as const
  }
  const proposed = decideRouting(request)
  assert.equal(proposed.prTopology, 'INDEPENDENT_DO_PRS')
  assert.equal(proposed.nextGate, 'DECISION_CONFIRMATION')
  const { confirmation } = persistTrustedConfirmation(
    deliveryDecisionInput({
      ownerTopology: 'CO_WITH_DOS',
      coupling: 'INDEPENDENT_COORDINATED',
      prTopology: 'INDEPENDENT_DO_PRS',
      objective: request.objective,
      scope: request.scope,
      acceptance: request.acceptance,
      integrationContract: request.integrationContract,
      approvedCiLevel: request.approvedCiLevel
    })
  )
  assert.equal(decideRouting({ ...request, confirmation }).nextGate, 'NONE')
})

test('a trusted confirmation cannot cross owner or PR topology boundaries', () => {
  const request = {
    ...base,
    scope: ['src/one/**', 'src/two/**'],
    integrationContract: ['integrate both units'],
    workstreams: [stream('one'), stream('two')],
    realParallelism: true
  }
  const oneDo = persistTrustedConfirmation(
    deliveryDecisionInput({
      objective: request.objective,
      scope: request.scope,
      acceptance: request.acceptance,
      integrationContract: request.integrationContract
    })
  ).confirmation
  assert.throws(
    () => decideRouting({ ...request, confirmation: oneDo }),
    /ROUTING_CONFIRMATION_MISMATCH/
  )

  const co = persistTrustedConfirmation(
    deliveryDecisionInput({
      ownerTopology: 'CO_WITH_DOS',
      coupling: 'INDEPENDENT_COORDINATED',
      prTopology: 'ONE_AGGREGATE_CO_PR',
      objective: request.objective,
      scope: request.scope,
      acceptance: request.acceptance,
      integrationContract: request.integrationContract
    })
  ).confirmation
  assert.throws(
    () =>
      decideRouting({
        ...base,
        scope: request.scope,
        integrationContract: request.integrationContract,
        workstreams: request.workstreams,
        confirmation: co
      }),
    /ROUTING_CONFIRMATION_MISMATCH/
  )

  const independentPr = persistTrustedConfirmation(
    deliveryDecisionInput({
      ownerTopology: 'CO_WITH_DOS',
      coupling: 'INDEPENDENT_COORDINATED',
      prTopology: 'INDEPENDENT_DO_PRS',
      objective: request.objective,
      scope: request.scope,
      acceptance: request.acceptance,
      integrationContract: request.integrationContract
    })
  ).confirmation
  assert.throws(
    () => decideRouting({ ...request, confirmation: independentPr, requestedPrTopology: 'DEFAULT' }),
    /ROUTING_CONFIRMATION_MISMATCH/
  )
})

test('host-local DO and CO create no Git resources and repository writes require rerouting', () => {
  const one = decideRouting({
    ...base,
    executionMode: 'HOST_LOCAL',
    repositoryModification: false
  })
  assert.equal(one.route, 'DO')
  assert.equal(one.executionMode, 'HOST_LOCAL')
  assert.equal(one.prTopology, 'NONE')
  const coordinated = decideRouting({
    ...base,
    executionMode: 'HOST_LOCAL',
    repositoryModification: false,
    workstreams: [stream('one'), stream('two')],
    scope: ['src/one/**', 'src/two/**'],
    integrationContract: ['integrate both units'],
    crossDeliveryIntegration: true
  })
  assert.equal(coordinated.route, 'CO')
  assert.equal(coordinated.prTopology, 'NONE')
  assert.throws(
    () =>
      decideRouting({
        ...base,
        executionMode: 'HOST_LOCAL',
        repositoryModification: true
      }),
    /HOST_LOCAL_REPOSITORY_MODIFICATION_REQUIRES_REROUTE/
  )
})

test('design impact routes DA to the unique UD behind one decision confirmation', () => {
  const result = decideRouting({ ...base, stableDesignChange: true })
  assert.equal(result.route, 'DA_UD')
  assert.deepEqual(result.activeRoles, ['DA', 'UD'])
  assert.equal(result.nextGate, 'DECISION_CONFIRMATION')
  const { confirmation } = persistTrustedConfirmation(
    deliveryDecisionInput({
      decisionKind: 'PROPOSAL',
      ownerTopology: 'DA_UD',
      executionMode: 'REPOSITORY',
      designImpact: 'CANONICAL',
      prTopology: 'ONE_DESIGN_PR',
      approvedCiLevel: base.approvedCiLevel,
      objective: base.objective,
      scope: base.scope,
      acceptance: base.acceptance,
      integrationContract: []
    })
  )
  assert.equal(decideRouting({ ...base, stableDesignChange: true, confirmation }).nextGate, 'NONE')
})
