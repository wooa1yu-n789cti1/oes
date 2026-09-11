import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVerificationTopology,
  type VerificationTopologyInput
} from '../verification-topology.ts'
import {
  deliveryDecisionInput,
  persistTrustedConfirmation
} from './trusted-confirmation-fixture.ts'

const currentDecision = deliveryDecisionInput()

const confirmationAt = (approvedCiLevel: 'DOCS' | 'SCOPED' | 'FULL') =>
  persistTrustedConfirmation(deliveryDecisionInput({ approvedCiLevel })).confirmation

test('RV and Baseline Checks run in parallel on the same exact PR candidate', () => {
  const sha = 'a'.repeat(40)
  const plan = createVerificationTopology({
    candidateSha: sha,
    ownerRole: 'DO',
    changedRiskClasses: ['STATIC', 'UNIT'],
    selfTestClasses: ['UNIT'],
    rvClasses: ['STATIC'],
    ciClasses: ['STATIC', 'UNIT'],
    pullRequestCandidateExists: true,
    fullRequired: false,
    fullReason: null,
    estimatedFullCost: null,
    confirmation: confirmationAt('SCOPED'),
    currentDecision: deliveryDecisionInput({ approvedCiLevel: 'SCOPED' })
  })
  assert.equal(plan.rv.exactCandidateSha, sha)
  assert.equal(plan.ci.exactCandidateSha, sha)
  assert.equal(plan.parallelRvAndCi, true)
  assert.equal(plan.ci.requiredStatus, 'Baseline Checks')
})

test('PR-triggered FULL remains non-runnable until disclosed confirmation', () => {
  const plan = createVerificationTopology({
    candidateSha: 'b'.repeat(40),
    ownerRole: 'CO',
    changedRiskClasses: ['INTEGRATION'],
    selfTestClasses: ['INTEGRATION'],
    rvClasses: ['INTEGRATION'],
    ciClasses: ['INTEGRATION'],
    pullRequestCandidateExists: true,
    fullRequired: true,
    fullReason: 'global selector changed',
    estimatedFullCost: '45 minutes',
    confirmation: confirmationAt('SCOPED'),
    currentDecision: deliveryDecisionInput({ approvedCiLevel: 'SCOPED' })
  })
  assert.equal(plan.fullDisposition, 'HUMAN_CONFIRMATION_REQUIRED')
  assert.equal(plan.runnable, false)
})

test('one FULL confirmation survives candidate repair generations within the confirmed scope', () => {
  const input: Omit<VerificationTopologyInput, 'candidateSha'> = {
    ownerRole: 'DO',
    changedRiskClasses: ['INTEGRATION'],
    selfTestClasses: ['INTEGRATION'],
    rvClasses: ['INTEGRATION'],
    ciClasses: ['INTEGRATION'],
    pullRequestCandidateExists: true,
    fullRequired: true,
    fullReason: 'confirmed cross-service coverage',
    estimatedFullCost: '45 minutes',
    confirmation: confirmationAt('FULL'),
    currentDecision
  }
  assert.equal(
    createVerificationTopology({ ...input, candidateSha: 'c'.repeat(40) }).runnable,
    true
  )
  assert.equal(
    createVerificationTopology({ ...input, candidateSha: 'd'.repeat(40) }).runnable,
    true
  )
})

test('FULL authorization is rejected when current scope drifts from the trusted card', () => {
  const plan = createVerificationTopology({
    candidateSha: 'e'.repeat(40),
    ownerRole: 'DO',
    changedRiskClasses: ['INTEGRATION'],
    selfTestClasses: ['INTEGRATION'],
    rvClasses: ['INTEGRATION'],
    ciClasses: ['INTEGRATION'],
    pullRequestCandidateExists: true,
    fullRequired: true,
    fullReason: 'scope drift',
    estimatedFullCost: '45 minutes',
    confirmation: confirmationAt('FULL'),
    currentDecision: deliveryDecisionInput({ scope: ['different scope'] })
  })
  assert.equal(plan.fullDisposition, 'HUMAN_CONFIRMATION_REQUIRED')
})
