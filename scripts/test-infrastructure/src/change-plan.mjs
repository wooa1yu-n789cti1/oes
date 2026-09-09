#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import {
  buildWorkspaceGraph,
  discoverPackages,
  discoverTests,
  expandReverseDependencies,
  findOwner,
  findWorkspaceRoot,
  matchesAny,
  normalizePath,
  readGitChanges,
  readJson,
  stableHash,
  TEST_TYPES
} from './test-infrastructure.mjs'

const ruleSet = Object.freeze({
  schemaVersion: 1,
  docsPatterns: ['**/*.md', 'docs/**', '.github/CODEOWNERS'],
  fullRequiredPatterns: [
    '.github/workflows/ci.yml',
    'scripts/test-infrastructure/**',
    'pnpm-workspace.yaml',
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'scripts/local-runtime/**',
    'scripts/local/runtime-config/**/*execution-token*',
    'src/common/src/**/*execution-token*',
    'src/common/src/contracts/**/*envelope*',
    'src/common/src/contracts/**/*serialization*',
    'src/common/src/contracts/**/*trust*',
    'src/services/system/auth-service/src/**',
    'src/services/system/permission-service/src/**',
    'src/services/system/tenant-org-service/src/**'
  ],
  integrationRiskPatterns: [
    '**/prisma/**',
    '**/migrations/**',
    '**/*repository*',
    '**/*adapter*',
    '**/*nats*',
    '**/*outbox*',
    '**/*integration*'
  ],
  knownRootPatterns: [
    '.github/**',
    'checks/**',
    'docs/**',
    'scripts/**',
    'tests/**',
    '*.md',
    '*.json',
    '*.yaml',
    '*.yml',
    '*.mjs',
    '*.cjs',
    '*.js',
    '*.ts'
  ]
})

/** Parses conventional --name value and --name=value CLI arguments. */
function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const equals = argument.indexOf('=')
    if (equals !== -1) values[argument.slice(2, equals)] = argument.slice(equals + 1)
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values[argument.slice(2)] = argv[++index]
    else values[argument.slice(2)] = 'true'
  }
  return values
}

/** Returns an immutable package block map from a pnpm lockfile importer section. */
export function parseLockfileImporters(text) {
  const result = new Map()
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line === 'importers:')
  if (start === -1) return result
  let current = null
  let content = []
  const flush = () => {
    if (current !== null) result.set(current, content.join('\n').trimEnd())
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^[^\s]/.test(line)) break
    const importer = line.match(/^  ([^ ].*):$/)
    if (importer) {
      flush()
      current = importer[1].replace(/^['"]|['"]$/g, '')
      content = []
    } else if (current !== null) content.push(line)
  }
  flush()
  return result
}

/** Identifies lockfile importers whose declared dependency resolution changed. */
export function changedLockfileImporters(baseText, headText) {
  const base = parseLockfileImporters(baseText)
  const head = parseLockfileImporters(headText)
  const keys = [...new Set([...base.keys(), ...head.keys()])].sort()
  return keys.filter((key) => base.get(key) !== head.get(key))
}

/** Binds one immutable Change Plan artifact identity to the producer run attempt. */
export function createChangePlanArtifactName(runId, runAttempt) {
  const parts = [runId, runAttempt].map((value) => String(value ?? ''))
  if (parts.some((value) => !/^[1-9]\d*$/.test(value)))
    throw new Error('CHANGE_PLAN_ARTIFACT_ID_INVALID')
  return `change-plan-${parts.join('-')}`
}

/** Resolves one lockfile importer to the nearest package at its workspace-relative path. */
function ownerForImporter(lockfilePath, importer, packages) {
  const workspaceDirectory = normalizePath(dirname(lockfilePath)) === '.' ? '' : normalizePath(dirname(lockfilePath))
  const directory = normalizePath([workspaceDirectory, importer === '.' ? '' : importer].filter(Boolean).join('/'))
  return packages.find((candidate) => candidate.directory === directory) || null
}

/** Reads a file at a Git revision, returning null when it does not exist there. */
function readRevisionFile(root, revision, path) {
  try {
    const { execFileSync } = awaitImportChildProcess()
    return execFileSync('git', ['show', `${revision}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
  } catch {
    return null
  }
}

/** Provides a synchronous dependency seam that unit tests can replace at the planning boundary. */
function awaitImportChildProcess() {
  return { execFileSync: globalThis.__OES_EXEC_FILE_SYNC__ || defaultExecFileSync }
}

import { execFileSync as defaultExecFileSync } from 'node:child_process'

/** Returns whether every changed path is documentation-only. */
function isDocumentationOnly(changes) {
  return (
    changes.length > 0 &&
    changes.every((change) =>
      [change.path, change.oldPath].filter(Boolean).every((path) => matchesAny(path, ruleSet.docsPatterns))
    )
  )
}

/** Creates one deterministic affected-test plan from explicit repository inputs. */
export function createChangePlan({
  root,
  base,
  head,
  event = 'pull_request',
  fullApproved = false,
  changes = null,
  files = null,
  packages = null,
  relationships = null,
  lastFullSha = null,
  lastFullAt = null,
  now = new Date()
}) {
  const repositoryRoot = resolve(root)
  const packageRecords = packages || discoverPackages(repositoryRoot)
  const graph = buildWorkspaceGraph(packageRecords)
  if (!graph.byName.size || graph.errors.length) {
    const fullApprovalToken = `ci-full-approved-${head.slice(0, 12)}`
    const approved = event !== 'pull_request' || fullApproved
    return {
      schemaVersion: 1,
      base,
      head,
      event,
      phase: 'candidate',
      mode: 'FULL',
      fullRequired: true,
      fullApproved: approved,
      requiresHumanConfirmation: event === 'pull_request' && !approved,
      planningBlocked: true,
      fullApprovalToken,
      rulesHash: stableHash({ ruleSet, relationshipTable: relationships || null }),
      changes: changes || [],
      risks: ['workspace-graph'],
      reasons: [
        graph.errors.length
          ? `Workspace graph is invalid (${graph.errors.join(', ')}); FULL_REQUIRED`
          : 'Workspace graph is empty or unavailable; FULL_REQUIRED'
      ],
      owners: [],
      workspaceRoots: [],
      selectedTests: Object.fromEntries(TEST_TYPES.map((type) => [type, []])),
      selectedTestCount: 0,
      discoveryCount: 0,
      journeyGaps: [],
      estimatedCost: 'workspace graph repair followed by all static/build/tests',
      planIdentity: stableHash({ base, head, event, reason: 'workspace-graph-unavailable' })
    }
  }
  const discovery = discoverTests({ root: repositoryRoot, files, packages: packageRecords })
  if (discovery.violations.length) {
    const sample = discovery.violations.slice(0, 5).map((item) => `${item.code}:${item.path}`).join(', ')
    throw new Error(`Test discovery is invalid (${discovery.violations.length}): ${sample}`)
  }
  const relationTable =
    relationships ||
    readJson(resolve(repositoryRoot, 'scripts/test-infrastructure/relationships.json'))
  const diff = changes || readGitChanges(repositoryRoot, base, head)
  const changedPaths = [...new Set(diff.flatMap((change) => [change.oldPath, change.path]).filter(Boolean))].sort()
  const directOwners = new Set()
  const reasons = []
  const riskTags = new Set()
  const selectedJourneyGlobs = new Set()
  let fullRequired = false
  let graphFailure = false

  for (const change of diff) {
    const pathCandidates = [change.path, change.oldPath].filter(Boolean)
    for (const path of pathCandidates) {
      if (path.endsWith('pnpm-lock.yaml')) continue
      const owner = findOwner(path, packageRecords)
      if (owner?.name === 'cross-service') continue
      if (owner && owner.directory) directOwners.add(owner.name)
      else if (!matchesAny(path, ruleSet.knownRootPatterns)) graphFailure = true
    }
  }

  for (const change of diff.filter((item) => item.path.endsWith('pnpm-lock.yaml'))) {
    const baseText = readRevisionFile(repositoryRoot, base, change.oldPath || change.path)
    const headText = readRevisionFile(repositoryRoot, head, change.path)
    if (baseText === null || headText === null) {
      fullRequired = true
      reasons.push(`Lockfile ${change.path} could not be compared by importer`)
      continue
    }
    const importers = changedLockfileImporters(baseText, headText)
    if (!importers.length) {
      fullRequired = true
      reasons.push(`Lockfile ${change.path} changed outside attributable importer blocks`)
      continue
    }
    for (const importer of importers) {
      const owner = ownerForImporter(change.path, importer, packageRecords)
      if (owner && owner.directory) directOwners.add(owner.name)
      else {
        fullRequired = true
        reasons.push(`Lockfile importer ${importer} has no package owner`)
      }
    }
  }

  for (const path of changedPaths) {
    if (matchesAny(path, ruleSet.fullRequiredPatterns)) {
      fullRequired = true
      reasons.push(`FULL_REQUIRED rule matched ${path}`)
    }
  }

  for (const relation of [
    ...(relationTable.implicitContracts || []),
    ...(relationTable.journeyFamilies || [])
  ]) {
    if (!changedPaths.some((path) => matchesAny(path, relation.triggers))) continue
    reasons.push(`Relationship ${relation.id} matched`)
    for (const owner of relation.consumerOwners || []) {
      if (graph.byName.has(owner)) directOwners.add(owner)
      else {
        fullRequired = true
        reasons.push(`Relationship ${relation.id} references absent owner ${owner}; FULL_REQUIRED`)
      }
    }
    for (const tag of relation.riskTags || []) riskTags.add(tag)
    for (const glob of relation.journeyGlobs || []) selectedJourneyGlobs.add(glob)
    if (relation.fullRequired) fullRequired = true
  }

  if (graphFailure) {
    fullRequired = true
    reasons.push('One or more changed paths could not be mapped to the workspace graph')
  }

  const documentationOnly = isDocumentationOnly(diff)
  const forcedFullEvent = event === 'workflow_dispatch' || event === 'release'
  if (forcedFullEvent) {
    fullRequired = true
    fullApproved = true
    reasons.push(`${event} requires FULL`)
  }

  let phase = 'candidate'
  if (event === 'push') {
    phase = 'quick-smoke'
    fullRequired = false
    reasons.push('Post-main execution is limited to quick contract and Journey smoke')
  }
  if (event === 'schedule') {
    const ageMilliseconds = lastFullAt ? now.getTime() - new Date(lastFullAt).getTime() : Infinity
    if (lastFullSha === head || ageMilliseconds < 7 * 24 * 60 * 60 * 1000) {
      phase = 'evidence-reuse'
      reasons.push(lastFullSha === head ? 'Scheduled FULL content is unchanged' : 'Last successful FULL is less than seven days old')
      fullRequired = false
    } else {
      fullRequired = true
      fullApproved = true
      reasons.push('Scheduled FULL is due after changed main content and seven days')
    }
  }

  let mode = documentationOnly ? 'DOCS' : 'SCOPED'
  if (fullRequired) mode = 'FULL'
  if (!diff.length && phase !== 'evidence-reuse' && forcedFullEvent === false) {
    mode = 'FULL'
    fullRequired = true
    reasons.push('Abnormal empty change set requires FULL')
  }

  const affectedOwners = expandReverseDependencies(directOwners, graph)
  let selectedTests = discovery.tests.filter((test) => affectedOwners.has(test.owner))
  selectedTests.push(
    ...discovery.tests.filter(
      (test) =>
        test.type === 'journey' && [...selectedJourneyGlobs].some((glob) => matchesAny(test.path, [glob]))
    )
  )
  for (const change of diff) {
    if (change.status.startsWith('D')) continue
    const direct = discovery.tests.find((test) => test.path === change.path)
    if (direct) selectedTests.push(direct)
  }
  selectedTests = [...new Map(selectedTests.map((test) => [test.path, test])).values()].sort((left, right) => left.path.localeCompare(right.path))

  if (mode === 'FULL') selectedTests = discovery.tests
  if (mode === 'DOCS' || phase === 'evidence-reuse') selectedTests = []
  if (phase === 'quick-smoke') {
    selectedTests = selectedTests.filter(
      (test) => test.type === 'contract' || test.type === 'journey'
    )
  }

  const hasExecutableCodeChange = !documentationOnly && diff.length > 0 && phase === 'candidate'
  if (hasExecutableCodeChange && mode === 'SCOPED' && selectedTests.length === 0) {
    mode = 'FULL'
    fullRequired = true
    selectedTests = discovery.tests
    reasons.push('Abnormal empty test selection requires FULL')
  }

  const selectedByType = Object.fromEntries(
    TEST_TYPES.map((type) => [
      type,
      selectedTests.filter((test) => test.type === type).map((test) => test.path)
    ])
  )
  const selectedOwnerRecords = packageRecords
    .filter((record) => mode === 'FULL' || affectedOwners.has(record.name))
    .filter((record) => record.directory)
    .sort((left, right) => left.directory.localeCompare(right.directory))
  const workspaceRoots = [...new Set(selectedOwnerRecords.map((record) => findWorkspaceRoot(repositoryRoot, record.directory)))].sort()
  const journeyGaps = [...selectedJourneyGlobs]
    .filter((glob) => !discovery.tests.some((test) => test.type === 'journey' && matchesAny(test.path, [glob])))
    .sort()
  const requiresHumanConfirmation = event === 'pull_request' && mode === 'FULL' && !fullApproved
  if (mode === 'FULL' && event !== 'pull_request') fullApproved = true
  const rulesHash = stableHash({ ruleSet, relationshipTable: relationTable })

  return {
    schemaVersion: 1,
    base,
    head,
    event,
    phase,
    mode,
    fullRequired: mode === 'FULL',
    fullApproved: mode !== 'FULL' || fullApproved,
    requiresHumanConfirmation,
    planningBlocked: false,
    fullApprovalToken: `ci-full-approved-${head.slice(0, 12)}`,
    rulesHash,
    changes: diff,
    risks: [...riskTags].sort(),
    reasons: [...new Set(reasons)].sort(),
    owners: selectedOwnerRecords.map((record) => ({ name: record.name, directory: record.directory })),
    workspaceRoots,
    selectedTests: selectedByType,
    selectedTestCount: selectedTests.length,
    discoveryCount: discovery.total,
    journeyGaps,
    estimatedCost:
      mode === 'FULL'
        ? `all static/build plus ${discovery.total} tests; FULL Journey P95 budget <=30m`
        : phase === 'quick-smoke'
          ? `${selectedTests.length} contract/journey smoke tests`
          : `${selectedTests.length} affected tests`,
    planIdentity: stableHash({
      base,
      head,
      event,
      phase,
      mode,
      rulesHash,
      changes: diff,
      owners: [...affectedOwners].sort(),
      selected: selectedTests.map((test) => test.path)
    })
  }
}

/** Emits GitHub job outputs without allowing embedded newlines. */
function writeGithubOutputs(path, plan, artifactName) {
  const values = {
    'artifact-name': artifactName,
    mode: plan.mode,
    phase: plan.phase,
    'full-approved': String(plan.fullApproved),
    'confirmation-required': String(plan.requiresHumanConfirmation),
    unit: String(plan.selectedTests.unit.length > 0),
    component: String(plan.selectedTests.component.length > 0),
    contract: String(plan.selectedTests.contract.length > 0),
    integration: String(plan.selectedTests.integration.length > 0),
    journey: String(plan.selectedTests.journey.length > 0),
    'needs-web-install': String(plan.workspaceRoots.includes('app/web')),
    'needs-pda-install': String(plan.workspaceRoots.includes('app/pda')),
    'plan-identity': plan.planIdentity
  }
  appendFileSync(path, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
}

/** Renders the human-facing deterministic Change Plan summary. */
export function renderChangePlan(plan) {
  const selected = TEST_TYPES.map((type) => `${type}=${plan.selectedTests[type].length}`).join(' ')
  return [
    `# Change Plan`,
    ``,
    `- Input: \`${plan.base}\` → \`${plan.head}\``,
    `- Profile: **${plan.mode}** (${plan.phase})`,
    `- Rules: \`${plan.rulesHash}\``,
    `- Owners: ${plan.owners.map((owner) => `\`${owner.name}\``).join(', ') || 'none'}`,
    `- Tests: ${selected}`,
    `- Cost: ${plan.estimatedCost}`,
    `- FULL confirmation required: ${plan.requiresHumanConfirmation ? `yes; apply exact-head label \`${plan.fullApprovalToken}\`` : 'no'}`,
    `- Reasons: ${plan.reasons.join('; ') || 'workspace graph selection'}`,
    `- Journey gaps: ${plan.journeyGaps.join(', ') || 'none'}`,
    `- Identity: \`${plan.planIdentity}\``
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parseArguments(process.argv.slice(2))
    const root = resolve(args.root || process.cwd())
    const base = args.base || process.env.OES_CI_BASE_SHA || 'origin/main'
    const head = args.head || process.env.OES_CI_HEAD_SHA || 'HEAD'
    const event = args.event || process.env.GITHUB_EVENT_NAME || 'pull_request'
    const plan = createChangePlan({
      root,
      base,
      head,
      event,
      fullApproved: args['full-approved'] === 'true' || process.env.OES_FULL_APPROVED === 'true',
      lastFullSha: args['last-full-sha'] || process.env.OES_LAST_FULL_SHA || null,
      lastFullAt: args['last-full-at'] || process.env.OES_LAST_FULL_AT || null
    })
    const output = resolve(args.output || '.tmp/change-plan.json')
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`)
    const markdown = renderChangePlan(plan)
    console.log(markdown)
    if (args['github-output']) {
      const artifactName = createChangePlanArtifactName(
        process.env.GITHUB_RUN_ID,
        process.env.GITHUB_RUN_ATTEMPT
      )
      writeGithubOutputs(resolve(args['github-output']), plan, artifactName)
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  } catch (error) {
    console.error(`CHANGE_PLAN=FAIL ${error.message}`)
    process.exitCode = 1
  }
}
