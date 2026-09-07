import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const base = new URL('../..', import.meta.url)
const repo = new URL('../../../..', import.meta.url)
const readBase = (path) => readFileSync(new URL(path, base), 'utf8')
const readRepo = (path) => readFileSync(new URL(path, repo), 'utf8')

// The one authoritative CI workflow retains the stable aggregate status and risk planner.
const workflow = readRepo('.github/workflows/ci.yml')
assert.match(workflow, /^name: CI$/m)
for (const event of [
  'pull_request:',
  'merge_group:',
  'workflow_dispatch:',
  'release:',
  'schedule:'
])
  assert.match(workflow, new RegExp(event))
assert.match(workflow, /^  change-plan:$/m)
assert.match(workflow, /^  baseline:$/m)
assert.match(workflow, /^    name: Baseline Checks$/m)
assert.match(workflow, /scripts\/test-infrastructure\/src\/change-plan\.mjs/)
assert.match(workflow, /scripts\/test-infrastructure\/src\/gate\.mjs/)
assert.match(workflow, /confirmation-required/)
assert.match(workflow, /ci-full-approved-/)
assert.doesNotMatch(workflow, /test:risk|test:l2|test:design-gap|test-matrix|l2-test-runner|Shadow/)

const workspaceInstalls = [
  ['needs-web-install', 'pnpm --dir app/web install --frozen-lockfile'],
  ['needs-pda-install', 'pnpm --dir app/pda install --frozen-lockfile']
]
const orderedSmoke = [
  'pnpm generated:all',
  'pnpm common:build',
  'pnpm --filter @oes/site-runtime-kit build',
  'pnpm test:run -- --type contract'
]

/** Extracts only Main Quick Smoke through the next top-level workflow job heading. */
const extractQuickSmoke = (source) => {
  const job = source.match(/^  quick-smoke:\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:[ \t]*$)/m)?.[0]
  assert.ok(job, 'authoritative CI must define the main quick-smoke job')
  return job
}

/** Enforces workspace setup and dependency ordering within Main Quick Smoke itself. */
const assertQuickSmokeContract = (source) => {
  const quickSmoke = extractQuickSmoke(source)
  for (const [workspaceOutput, installCommand] of workspaceInstalls) {
    assert.match(
      quickSmoke,
      new RegExp(
        `- if: \\$\\{\\{ needs\\.change-plan\\.outputs\\.${workspaceOutput} == 'true' \\}\\}\\n` +
          `\\s+run: ${installCommand.replaceAll('/', '\\/')}`
      ),
      `main quick smoke must conditionally install the ${workspaceOutput} workspace`
    )
    assert.ok(
      quickSmoke.indexOf(installCommand) < quickSmoke.indexOf('pnpm test:run'),
      `${workspaceOutput} install must precede selected quick-smoke tests`
    )
  }
  for (let index = 1; index < orderedSmoke.length; index += 1)
    assert.ok(
      quickSmoke.indexOf(orderedSmoke[index]) > quickSmoke.indexOf(orderedSmoke[index - 1]),
      `quick smoke order invalid at ${orderedSmoke[index]}`
    )
  return quickSmoke
}

/** Applies one regression mutation only to the extracted Main Quick Smoke job. */
const mutateQuickSmoke = (source, mutation) => {
  const quickSmoke = extractQuickSmoke(source)
  return source.replace(quickSmoke, mutation(quickSmoke))
}

assertQuickSmokeContract(workflow)
for (const [workspaceOutput, installCommand] of workspaceInstalls) {
  const installBlock = new RegExp(
    `      - if: \\$\\{\\{ needs\\.change-plan\\.outputs\\.${workspaceOutput} == 'true' \\}\\}\\n` +
      `        run: ${installCommand.replaceAll('/', '\\/')}\\n`
  )
  assert.throws(
    () =>
      assertQuickSmokeContract(mutateQuickSmoke(workflow, (job) => job.replace(installBlock, ''))),
    new RegExp(`must conditionally install the ${workspaceOutput} workspace`),
    `removing ${workspaceOutput} from quick smoke must fail`
  )
}

const lateWebInstall = mutateQuickSmoke(workflow, (job) => {
  const install =
    "      - if: ${{ needs.change-plan.outputs.needs-web-install == 'true' }}\n" +
    '        run: pnpm --dir app/web install --frozen-lockfile\n'
  return `${job.replace(install, '')}${install}`
})
assert.throws(
  () => assertQuickSmokeContract(lateWebInstall),
  /needs-web-install install must precede selected quick-smoke tests/,
  'moving the web install after selected quick-smoke tests must fail'
)

const decoyJobMutation = mutateQuickSmoke(workflow, (job) => {
  let brokenJob = job
  for (const [workspaceOutput, installCommand] of workspaceInstalls) {
    brokenJob = brokenJob.replace(
      '      - if: $' +
        `{{ needs.change-plan.outputs.${workspaceOutput} == 'true' }}\n` +
        `        run: ${installCommand}\n`,
      ''
    )
  }
  orderedSmoke.forEach((command, index) => {
    brokenJob = brokenJob.replace(command, `echo removed-smoke-command-${index}`)
  })
  const decoyJob = [
    '  decoy-job:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    "      - if: ${{ needs.change-plan.outputs.needs-web-install == 'true' }}",
    '        run: pnpm --dir app/web install --frozen-lockfile',
    "      - if: ${{ needs.change-plan.outputs.needs-pda-install == 'true' }}",
    '        run: pnpm --dir app/pda install --frozen-lockfile',
    '      - run: pnpm generated:all',
    '      - run: |',
    '          pnpm common:build',
    '          pnpm --filter @oes/site-runtime-kit build',
    '          pnpm test:run -- --type contract --plan .tmp/change-plan.json',
    ''
  ].join('\n')
  return `${brokenJob}${decoyJob}`
})
assert.throws(
  () => assertQuickSmokeContract(decoyJobMutation),
  /must conditionally install the needs-web-install workspace/,
  'an intervening top-level decoy job must not satisfy the quick-smoke contract'
)
console.log(
  'main quick-smoke regression mutations: PASS web-omission pda-omission late-install cross-job-decoy'
)

const journey = workflow.match(/^  journey:\n[\s\S]*?(?=^  quick-smoke:)/m)?.[0]
assert.ok(journey, 'authoritative CI must define the candidate Journey job')
const orderedJourney = [
  'pnpm generated:all',
  'pnpm common:build',
  'pnpm --filter api-gateway build',
  'pnpm --filter @oes/site-runtime-kit build',
  'pnpm test:run -- --type journey'
]
for (let index = 1; index < orderedJourney.length; index += 1)
  assert.ok(
    journey.indexOf(orderedJourney[index]) > journey.indexOf(orderedJourney[index - 1]),
    `journey dependency order invalid at ${orderedJourney[index]}`
  )

assert.equal(existsSync(new URL('.github/workflows/ci-optimized-shadow.yml', repo)), false)
assert.equal(existsSync(new URL('scripts/local/test-matrix.mjs', repo)), false)
assert.equal(existsSync(new URL('scripts/local/l2-test-runner.mjs', repo)), false)

// V2 is a replacement: one exact role set and no active legacy role vocabulary.
const routing = readBase('src/routing.ts')
const types = readBase('src/types.ts')
assert.match(routing, /ACTIVE_TASK_ROLES = \['DA', 'UD', 'DO', 'CO', 'RV'\] as const/)
assert.match(types, /role: 'DA' \| 'UD' \| 'DO' \| 'CO' \| 'RV'/)
assert.match(
  types,
  /REMOTE_ACTIONS = \[\s*'preflight',\s*'publish-pr',\s*'verify-pr',\s*'merge-pr',\s*'verify-main'\s*\] as const/
)

const activeFramework = [
  readRepo('AGENTS.md'),
  readRepo('docs/governance/codex-execution-model.md'),
  readRepo('docs/governance/document-governance.md'),
  readRepo('docs/runbooks/collaboration-runtime.md'),
  readRepo('docs/runbooks/collaboration-runtime-assignment.md'),
  readRepo('docs/runbooks/collaboration-runtime-validation.md'),
  readRepo('docs/plans/index.md'),
  readRepo('docs/plans/designs/README.md'),
  readRepo('docs/plans/deliveries/README.md'),
  readBase('README.md'),
  readBase('profile/README.md'),
  ...readdirSync(new URL('src', base), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => readBase(`src/${entry.name}`)),
  ...readdirSync(new URL('schemas', base))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readBase(`schemas/${name}`))
].join('\n')
const legacyRolePattern = new RegExp(
  [
    'DELIVERY_' + 'OWNER',
    'COORDINATION_' + 'OWNER',
    'REVIEW_' + 'VERIFIER',
    'DELIVERY_' + 'RV',
    'COORDINATION_' + 'DA',
    'Feature ' + 'Lead',
    'Stage ' + 'Lead',
    '\\b' + 'IT' + '\\b',
    '\\b' + 'FL' + '\\b',
    '\\b' + 'SL' + '\\b'
  ].join('|')
)
assert.doesNotMatch(activeFramework, legacyRolePattern)

// Routing and verification expose the V2 topology explicitly.
assert.match(routing, /route: 'DISCUSSION' \| 'DA_UD' \| 'DO' \| 'CO'/)
assert.match(routing, /ONE_AGGREGATE_CO_PR/)
assert.match(routing, /INDEPENDENT_DO_PRS/)
assert.match(routing, /independentPrExceptionConfirmed/)
const verification = readBase('src/verification-topology.ts')
assert.match(verification, /requiredStatus: 'Baseline Checks'/)
assert.match(verification, /parallelRvAndCi: input\.pullRequestCandidateExists/)
assert.match(verification, /HUMAN_CONFIRMATION_REQUIRED/)
assert.match(verification, /VERIFICATION_FULL_DISCLOSURE_REQUIRED/)

// CO integration requires independent DO ownership, scoped RV, ordered integration,
// one aggregate branch by default, and an explicit releasability exception otherwise.
const integration = readBase('src/coordination-integration.ts')
assert.match(integration, /value\.items\.length < 2/)
assert.match(integration, /owners\.has\(item\.ownerTaskId\)/)
assert.match(integration, /validateScopedRv\(/)
assert.match(integration, /COORDINATION_SCOPED_RV_BINDING_MISMATCH/)
assert.match(integration, /aggregateBranch !== `codex\/coordination\/\$\{value\.coordinationKey\}`/)
assert.match(integration, /independentPrExceptionConfirmed/)
assert.match(integration, /independentlyReleasable/)
assert.match(integration, /STOPPED_FAILURE/)
assert.match(integration, /integratedPrefix/)
assert.match(integration, /loadTrustedCoordinationIntegrationAuthorization/)
assert.match(integration, /loadTrustedCoordinationIntegrationResults/)
assert.match(integration, /COORDINATION_INTEGRATION_MERGE_CHAIN_MISMATCH/)
assert.doesNotMatch(integration, /setInterval|setTimeout|writeFile/)

// DP/ADP are the external stable control surfaces for repository and host-local work.
const packages = readBase('src/delivery-package.ts')
assert.match(packages, /OES_DELIVERY_PACKAGE/)
assert.match(packages, /OES_AGGREGATE_DELIVERY_PACKAGE/)
assert.match(packages, /loadAggregateDeliveryPackageReference/)
assert.match(packages, /AGGREGATE_RV_EXACT_INPUT_MISMATCH/)
assert.match(packages, /HOST_LOCAL_PACKAGE_REMOTE_CI_FORBIDDEN/)
assert.match(packages, /PACKAGE_CLEANUP_REPOSITORY_PATH_FORBIDDEN/)
assert.match(packages, /SCOPE_CHANGED/)
assert.match(packages, /DESIGN_CHANGED/)
assert.match(packages, /DEPENDENCY_CHANGED/)
assert.match(packages, /CANDIDATE_CHANGED/)
assert.match(readRepo('docs/plans/deliveries/README.md'), /not an active V2 state source/)

// Assignment and lifecycle distinguish task roles from the bounded-helper mechanism.
const assignmentTypes = readBase('src/assignment-runtime.types.ts')
assert.match(
  assignmentTypes,
  /ASSIGNMENT_CHILD_KINDS = \[\s*'DO',\s*'BOUNDED_HELPER',\s*'RV'\s*\] as const/
)
assert.match(assignmentTypes, /AssignmentOwnerRole = 'CO' \| 'DO'/)
assert.doesNotMatch(assignmentTypes, /childRole/)
const lifecycle = readBase('src/coordination-lifecycle.ts')
assert.match(
  lifecycle,
  /TASK_KINDS: CoordinationLifecycleTaskKind\[\] = \['BOUNDED_HELPER', 'RV', 'DO', 'CO'\]/
)
assert.match(lifecycle, /COORDINATION_LIFECYCLE_SCOPED_RV_MISSING/)
assert.match(lifecycle, /COORDINATION_LIFECYCLE_AGGREGATE_RV_MISSING/)
assert.match(lifecycle, /depth\(b\) - depth\(a\)/)
assert.doesNotMatch(lifecycle, /setInterval|setTimeout|writeFile/)

// Cleanup is an isolated entrypoint with only disposal planning/verification commands.
const generalCli = readBase('src/cli.ts')
const cleanupCli = readBase('src/cleanup-cli.ts')
const cleanup = readBase('src/cleanup.ts')
const cleanupEntry = readBase('bin/oes-lifecycle-cleanup')
assert.match(cleanupEntry, /^#!\/bin\/sh\nset -eu\n/)
assert.match(cleanupEntry, /src\/cleanup-cli\.ts/)
assert.doesNotMatch(generalCli, /from '\.\/cleanup(?:-binding|-cli)?\.ts'|command === 'cleanup/)
assert.doesNotMatch(
  cleanupCli,
  /from '\.\/(?:routing|remote-driver|github-adapter|coordination-integration|local-main|proposal-queue)\.ts'/
)
for (const command of ['cleanup-plan', 'cleanup-verify', 'coordination-lifecycle-plan'])
  assert.match(cleanupCli, new RegExp(`command\\s*===\\s*'${command}'`))
for (const forbidden of [
  'publish-pr',
  'verify-pr',
  'merge-pr',
  'verify-main',
  'verification-plan',
  'coordination-integration-plan'
])
  assert.doesNotMatch(cleanupCli, new RegExp(forbidden))
assert.match(cleanupCli, /--repository-diff/)
assert.match(cleanup, /verifyCleanupProducesNoRepositoryDiff/)
assert.match(cleanup, /if \(diffEntries\.length !== 0\)/)
assert.match(cleanup, /PRESERVE_FAILURE/)
assert.match(cleanup, /requireTrustedCoordinationCleanupAuthorization/)
assert.match(readBase('src/cleanup-binding.ts'), /coordinationOwner/)
assert.doesNotMatch(
  `${cleanupCli}\n${cleanup}`,
  /node:child_process|\bexecSync\b|\bspawnSync\b|GitHubRemoteAdapter|RemoteDriver/
)

// Exact-owner profile and guarded moving-main behavior remain enforced.
const profile = readBase('profile/oes-project-owner.config.toml')
assert.match(profile, /approval_policy = "\{\{APPROVAL_POLICY\}\}"/)
assert.match(profile, /trusted_authorization_root = "\{\{TRUSTED_AUTHORIZATION_ROOT\}\}"/)
assert.match(profile, /"\{\{OWNER_GIT_DIRECTORY\}\}" = "write"/)
assert.match(profile, /"\{\{TRUSTED_AUTHORIZATION_ROOT\}\}" = "read"/)
assert.match(profile, /"\{\{SERIAL_ADMISSION_ROOT\}\}" = "write"/)
assert.doesNotMatch(profile, /GIT_COMMON_DIRECTORY.*write/)
const localMain = readBase('src/local-main.ts')
assert.match(localMain, /\['merge', '--ff-only'/)
assert.match(localMain, /\['fetch', '--no-tags', binding\.remote, binding\.branch\]/)
assert.doesNotMatch(localMain, /\['(?:reset|stash|rebase|checkout)'|setInterval|setTimeout/)

// Every executable schema remains parseable, and the rewritten topology schemas are V2-only.
for (const file of readdirSync(new URL('schemas', base))) JSON.parse(readBase(`schemas/${file}`))
for (const file of [
  'coordination-integration-authorization.schema.json',
  'aggregate-delivery-child-roster.schema.json',
  'package-evidence.schema.json',
  'coordination-cleanup-result-set.schema.json',
  'coordination-lifecycle-roster-authority.schema.json',
  'coordination-lifecycle-inventory.schema.json',
  'coordination-archive-result-set.schema.json'
]) {
  const schema = readBase(`schemas/${file}`)
  assert.match(schema, /"schemaVersion": \{ "const": 2 \}/)
}

console.log('collaboration-runtime static checks: PASS')
