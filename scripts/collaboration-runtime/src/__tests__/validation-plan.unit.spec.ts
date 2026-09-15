import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { objectFingerprint } from '../canonical.ts'
import { createEvidenceKey, type CompleteEvidenceKeyInput } from '../evidence.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import {
  createValidationPlan,
  validateValidationPlan,
  type ValidationCommandRequest,
  type ValidationPlanInput,
  type ValidationTier
} from '../validation-plan.ts'

const hash = (char: string) => char.repeat(64)
const sha = (char: string) => char.repeat(40)
const schema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'schemas', 'validation-plan.schema.json'),
    'utf8'
  )
) as Record<string, unknown>

const evidenceInput = (
  coverageIds: string[],
  commandChar: string,
  candidateSha = sha('1'),
  candidateTreeSha = sha('2')
): CompleteEvidenceKeyInput => ({
  candidateSha,
  candidateTreeSha,
  dependencyCandidates: [],
  dependencyFingerprint: hash('a'),
  lockfileFingerprint: hash('b'),
  toolchainFingerprint: hash('c'),
  testConfigFingerprint: hash('d'),
  environmentFingerprint: hash('e'),
  literalInputsFingerprint: hash('f'),
  executionProfileFingerprint: hash('7'),
  commandFingerprint: hash(commandChar),
  commandVersion: `command-${commandChar}@1`,
  literalResultFingerprint: hash(commandChar),
  exitCode: 0,
  coverageIds
})

const command = (
  commandId: string,
  commandChar: string,
  tier: ValidationTier,
  coverageId: string,
  pathPattern: string,
  candidateSha = sha('1'),
  candidateTreeSha = sha('2')
): ValidationCommandRequest => {
  const previousInput = evidenceInput([coverageId], commandChar)
  return {
    commandId,
    command: `pnpm ${commandId}`,
    tier,
    coverage: [{ id: coverageId, pathPatterns: [pathPattern], contractSensitive: true }],
    previousEvidence: createEvidenceKey(previousInput),
    nextEvidence: evidenceInput([coverageId], commandChar, candidateSha, candidateTreeSha)
  }
}

const planInput = (
  tier: ValidationTier,
  commands: ValidationCommandRequest[]
): ValidationPlanInput => ({
  tier,
  gateContext: tier === 'FULL_GATE' ? 'DELIVERY' : 'NONE',
  changedPaths: [],
  dependencyChanged: false,
  profileChanged: false,
  commandChanged: false,
  contractChanged: false,
  semanticConflict: false,
  commands
})

const reseal = <T extends { planFingerprint: string }>(plan: T): T => {
  plan.planFingerprint = objectFingerprint(
    plan as unknown as Record<string, unknown>,
    'planFingerprint'
  )
  return plan
}

test('an exact unchanged full-gate key is reused instead of repeating the gate', () => {
  const input = planInput('FULL_GATE', [
    command('collaboration-runtime-check', '8', 'FULL_GATE', 'full-gate', 'scripts/**')
  ])
  const plan = createValidationPlan(input)
  assert.equal(plan.result, 'PLAN_READY')
  assert.equal(plan.runActions.length, 0)
  assert.equal(plan.reuseActions.length, 1)
  assert.equal(plan.reuseActions[0].driftDecision, 'REUSE_EXACT')
  assert.equal(validateValidationPlan(plan), plan)
  assert.doesNotThrow(() => validateJsonSchema(schema, plan))
})

test('governance-only main drift refreshes product, database and journey baselines without reruns', () => {
  const commands = [
    command('product-build', '8', 'CANDIDATE_AFFECTED', 'product', 'src/**', sha('a'), sha('b')),
    command(
      'database-check',
      '9',
      'CANDIDATE_AFFECTED',
      'database',
      'prisma/**',
      sha('a'),
      sha('b')
    ),
    command('journey', 'a', 'CANDIDATE_AFFECTED', 'journey', 'test/e2e/**', sha('a'), sha('b'))
  ]
  const input = planInput('CANDIDATE_AFFECTED', commands)
  input.changedPaths = ['docs/governance/codex-execution-model.md']
  const plan = createValidationPlan(input)
  assert.equal(plan.runActions.length, 0)
  assert.deepEqual(
    plan.reuseActions.map((action) => [action.commandId, action.driftDecision]),
    [
      ['database-check', 'REFRESH_BASELINE'],
      ['journey', 'REFRESH_BASELINE'],
      ['product-build', 'REFRESH_BASELINE']
    ]
  )
  assert.doesNotThrow(() => validateJsonSchema(schema, plan))
})

test('intersecting paths run only matching commands and refresh unrelated command evidence', () => {
  const input = planInput('FOCUSED_DEVELOPMENT', [
    command(
      'runtime-unit',
      '8',
      'FOCUSED_DEVELOPMENT',
      'runtime',
      'scripts/collaboration-runtime/src/**',
      sha('a'),
      sha('b')
    ),
    command(
      'docs-lint',
      '9',
      'FOCUSED_DEVELOPMENT',
      'governance',
      'docs/governance/**',
      sha('a'),
      sha('b')
    )
  ])
  input.changedPaths = ['scripts/collaboration-runtime/src/evidence.ts']
  const plan = createValidationPlan(input)
  assert.deepEqual(
    plan.runActions.map((action) => action.commandId),
    ['runtime-unit']
  )
  assert.deepEqual(
    plan.reuseActions.map((action) => action.commandId),
    ['docs-lint']
  )
  assert.equal(plan.runActions[0].driftDecision, 'FOCUSED')
  assert.equal(plan.reuseActions[0].driftDecision, 'REFRESH_BASELINE')
})

test('contract, dependency, profile and command changes invalidate every command in the tier', () => {
  for (const field of [
    'contractChanged',
    'dependencyChanged',
    'profileChanged',
    'commandChanged'
  ] as const) {
    const input = planInput('CANDIDATE_AFFECTED', [
      command('contract', '8', 'CANDIDATE_AFFECTED', 'contract', 'docs/contracts/**'),
      command('journey', '9', 'CANDIDATE_AFFECTED', 'journey', 'test/e2e/**')
    ])
    input[field] = true
    const plan = createValidationPlan(input)
    assert.equal(plan.reuseActions.length, 0, field)
    assert.deepEqual(
      plan.runActions.map((action) => action.commandId),
      ['contract', 'journey'],
      field
    )
    assert.equal(plan.invalidatedEvidenceFingerprints.length, 2, field)
  }
})

test('a missing prior result schedules execution at only the requested lifecycle tier', () => {
  const request = command(
    'affected-contract',
    '8',
    'CANDIDATE_AFFECTED',
    'contract',
    'docs/contracts/**'
  )
  request.previousEvidence = null
  const plan = createValidationPlan(planInput('CANDIDATE_AFFECTED', [request]))
  assert.equal(plan.runActions.length, 1)
  assert.equal(plan.runActions[0].tier, 'CANDIDATE_AFFECTED')
  assert.equal(plan.runActions[0].driftDecision, 'FULL')
})

test('a semantic conflict returns DESIGN_GAP with no runnable or reusable actions', () => {
  const input = planInput('CANDIDATE_AFFECTED', [
    command('contract', '8', 'CANDIDATE_AFFECTED', 'contract', 'docs/contracts/**')
  ])
  input.semanticConflict = true
  const plan = createValidationPlan(input)
  assert.equal(plan.result, 'DESIGN_GAP')
  assert.deepEqual(plan.runActions, [])
  assert.deepEqual(plan.reuseActions, [])
  assert.deepEqual(plan.designGap?.commandIds, ['contract'])
  assert.doesNotThrow(() => validateJsonSchema(schema, plan))
})

test('mixed tiers, invalid gate contexts, duplicate commands and candidate drift fail closed', () => {
  const mixed = planInput('FOCUSED_DEVELOPMENT', [
    command('wrong-tier', '8', 'CANDIDATE_AFFECTED', 'runtime', 'scripts/**')
  ])
  assert.throws(() => createValidationPlan(mixed), /VALIDATION_PLAN_COMMAND_TIER_MISMATCH/)

  const invalidGate = planInput('FULL_GATE', [
    command('full', '8', 'FULL_GATE', 'full', 'scripts/**')
  ])
  invalidGate.gateContext = 'NONE'
  assert.throws(() => createValidationPlan(invalidGate), /VALIDATION_PLAN_GATE_CONTEXT_INVALID/)

  const invalidFocusedGate = planInput('FOCUSED_DEVELOPMENT', [
    command('focused', '8', 'FOCUSED_DEVELOPMENT', 'runtime', 'scripts/**')
  ])
  invalidFocusedGate.gateContext = 'DELIVERY'
  assert.throws(
    () => createValidationPlan(invalidFocusedGate),
    /VALIDATION_PLAN_GATE_CONTEXT_INVALID/
  )

  const duplicate = command('duplicate', '8', 'FOCUSED_DEVELOPMENT', 'runtime', 'scripts/**')
  assert.throws(
    () => createValidationPlan(planInput('FOCUSED_DEVELOPMENT', [duplicate, duplicate])),
    /VALIDATION_PLAN_COMMAND_DUPLICATE/
  )

  const mismatch = planInput('FOCUSED_DEVELOPMENT', [
    command('one', '8', 'FOCUSED_DEVELOPMENT', 'one', 'one/**'),
    command('two', '9', 'FOCUSED_DEVELOPMENT', 'two', 'two/**', sha('a'), sha('b'))
  ])
  assert.throws(() => createValidationPlan(mismatch), /VALIDATION_PLAN_CANDIDATE_MISMATCH/)
})

test('altered persisted validation plans fail their self-hash check', () => {
  const plan = createValidationPlan(
    planInput('FULL_GATE', [command('full', '8', 'FULL_GATE', 'full', 'scripts/**')])
  )
  plan.gateContext = 'COORDINATION'
  assert.throws(() => validateValidationPlan(plan), /VALIDATION_PLAN_FINGERPRINT_MISMATCH/)
})

test('re-sealing cannot make semantically invalid persisted plans valid', () => {
  const full = createValidationPlan(
    planInput('FULL_GATE', [command('full', '8', 'FULL_GATE', 'full', 'scripts/**')])
  )
  full.gateContext = 'NONE'
  reseal(full)
  assert.throws(() => validateValidationPlan(full), /VALIDATION_PLAN_GATE_CONTEXT_INVALID/)
  assert.throws(() => validateJsonSchema(schema, full), /JSON_SCHEMA_VALIDATION_FAILED/)

  const actionMismatch = createValidationPlan(
    planInput('FULL_GATE', [command('full', '8', 'FULL_GATE', 'full', 'scripts/**')])
  )
  actionMismatch.reuseActions[0].tier = 'CANDIDATE_AFFECTED'
  reseal(actionMismatch)
  assert.throws(
    () => validateValidationPlan(actionMismatch),
    /VALIDATION_PLAN_ACTION_TIER_MISMATCH/
  )
  assert.throws(() => validateJsonSchema(schema, actionMismatch), /JSON_SCHEMA_VALIDATION_FAILED/)
})

test('non-full persisted plans require NONE context in runtime and schema', () => {
  const plan = createValidationPlan(
    planInput('FOCUSED_DEVELOPMENT', [
      command('focused', '8', 'FOCUSED_DEVELOPMENT', 'runtime', 'scripts/**')
    ])
  )
  plan.gateContext = 'DELIVERY'
  reseal(plan)
  assert.throws(() => validateValidationPlan(plan), /VALIDATION_PLAN_GATE_CONTEXT_INVALID/)
  assert.throws(() => validateJsonSchema(schema, plan), /JSON_SCHEMA_VALIDATION_FAILED/)
})

test('persisted plans reject malformed changed paths even after re-sealing', () => {
  const plan = createValidationPlan(
    planInput('FOCUSED_DEVELOPMENT', [
      command('focused', '8', 'FOCUSED_DEVELOPMENT', 'runtime', 'scripts/**')
    ])
  )
  plan.changedPaths = ['../scripts/collaboration-runtime/src/evidence.ts']
  reseal(plan)
  assert.throws(() => validateValidationPlan(plan), /VALIDATION_PLAN_CHANGED_PATH_INVALID/)
  assert.throws(() => validateJsonSchema(schema, plan), /JSON_SCHEMA_VALIDATION_FAILED/)
})
