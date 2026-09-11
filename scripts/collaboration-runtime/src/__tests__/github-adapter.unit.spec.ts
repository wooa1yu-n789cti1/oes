import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubRemoteAdapter,
  managedCommandInvocation,
  type CommandResult,
  type CommandRunner
} from '../github-adapter.ts'
import { remoteMutationSatisfied } from '../remote-driver.ts'
import type { PullRequestTruth, RemoteTruth } from '../types.ts'
import { remoteBinding } from './helpers.ts'

const emptyGate = {
  annotations: 0,
  issueComments: 0,
  reviewComments: 0,
  blockingReviews: 0,
  unresolvedThreads: 0
}

test('managed command invocation preserves exact executable and argument boundaries', () => {
  const invocation = managedCommandInvocation('git', [
    'ls-remote',
    '--heads',
    'origin',
    'refs/heads/codex/delivery with spaces;still-one-argument'
  ])
  assert.deepEqual(invocation, {
    command: '/bin/sh',
    args: [
      '-c',
      'exec "$@"',
      'oes-remote-command',
      'git',
      'ls-remote',
      '--heads',
      'origin',
      'refs/heads/codex/delivery with spaces;still-one-argument'
    ]
  })
})

class ScenarioRunner implements CommandRunner {
  readonly commands: string[] = []
  readonly candidate: string
  readonly main: string
  readonly ruleset: Record<string, unknown>
  pullExists = false
  branchHead: string | null
  pullNumber = 12
  pullState = 'open'
  pullDraft = true
  pullBaseRef = 'main'
  pullHeadRef = 'codex/delivery/runtime'
  pullHeadSha: string
  pullTitle = 'Runtime'
  pullBody = 'Exact candidate'
  failPush = false
  failPatch = false
  checkRuns: Array<Record<string, unknown>> = []
  readonly annotationsByCheckId = new Map<number, Array<Record<string, unknown>>>()
  readonly nonAncestorHeads = new Set<string>()

  constructor(candidate: string, main: string, ruleset: Record<string, unknown> = rulesetDetail()) {
    this.candidate = candidate
    this.main = main
    this.ruleset = ruleset
    this.branchHead = candidate
    this.pullHeadSha = candidate
  }

  run(command: string, args: string[]): CommandResult {
    this.commands.push(`${command} ${args.join(' ')}`)
    if (command === 'git' && args[0] === 'status') return ok('')
    if (command === 'git' && args[0] === 'remote') return ok('https://github.com/example/oes.git\n')
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD')
      return ok(`${this.candidate}\n`)
    if (command === 'git' && args[0] === 'branch') return ok('codex/delivery/runtime\n')
    if (command === 'git' && args[0] === 'ls-remote') {
      const ref = args.at(-1)
      const sha = ref === 'refs/heads/main' ? this.main : this.branchHead
      return sha ? ok(`${sha}\t${ref}\n`) : ok('')
    }
    if (command === 'git' && args[0] === 'merge-base')
      return this.nonAncestorHeads.has(String(args[2])) ? failed('not an ancestor') : ok('')
    if (command === 'git' && args[0] === 'fetch') return ok('')
    if (command === 'git' && args[0] === 'push') {
      if (this.failPush) return failed('push rejected')
      this.branchHead = this.candidate
      if (this.pullExists) this.pullHeadSha = this.candidate
      return ok('')
    }
    if (command === 'git' && args[0] === 'cat-file')
      return ok(`tree ${'a'.repeat(40)}\nparent ${'b'.repeat(40)}\n`)
    if (command === 'gh' && args[0] === 'api') {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint.includes('/pulls?')) {
        const pulls = this.pullExists
          ? [
              {
                number: this.pullNumber,
                state: this.pullState,
                draft: this.pullDraft,
                merged_at: null,
                merge_commit_sha: null,
                title: this.pullTitle,
                body: this.pullBody,
                head: { ref: this.pullHeadRef, sha: this.pullHeadSha },
                base: { ref: this.pullBaseRef }
              }
            ]
          : []
        return ok(JSON.stringify(pulls))
      }
      if (args.includes('--method') && args.includes('POST')) {
        this.pullExists = true
        return ok(JSON.stringify({ number: 12 }))
      }
      if (args.includes('--method') && args.includes('PATCH')) {
        if (this.failPatch) return failed('patch rejected')
        for (const value of args.filter((arg) => arg.startsWith('title=')))
          this.pullTitle = value.slice('title='.length)
        for (const value of args.filter((arg) => arg.startsWith('body=')))
          this.pullBody = value.slice('body='.length)
        return ok(JSON.stringify({ number: this.pullNumber }))
      }
      if (endpoint.endsWith('/actions/permissions/workflow'))
        return ok(
          JSON.stringify({
            default_workflow_permissions: 'read',
            can_approve_pull_request_reviews: false
          })
        )
      if (endpoint.includes('/rulesets/7')) return ok(JSON.stringify(this.ruleset))
      if (endpoint.includes('/compare/'))
        return ok(
          JSON.stringify({
            status: this.nonAncestorHeads.has(endpoint.split('...').at(-1) ?? '')
              ? 'diverged'
              : 'ahead'
          })
        )
      if (endpoint.includes('/rulesets?'))
        return ok(
          JSON.stringify([{ id: 7, name: 'protect-main', target: 'branch', enforcement: 'active' }])
        )
      if (endpoint === 'repos/example/oes')
        return ok(
          JSON.stringify({
            default_branch: 'main',
            delete_branch_on_merge: false,
            allow_merge_commit: true,
            allow_squash_merge: false,
            allow_rebase_merge: false,
            allow_auto_merge: false
          })
        )
      const annotationMatch = endpoint.match(/\/check-runs\/(\d+)\/annotations/)
      if (annotationMatch) {
        const values = this.annotationsByCheckId.get(Number(annotationMatch[1])) ?? []
        const page = Number(new URL(`https://fixture.invalid/${endpoint}`).searchParams.get('page'))
        const start = (page - 1) * 100
        return ok(JSON.stringify(values.slice(start, start + 100)))
      }
      if (endpoint.includes('/check-runs'))
        return ok(JSON.stringify({ check_runs: this.checkRuns }))
      if (endpoint.includes('/comments?') || endpoint.includes('/reviews?')) return ok('[]')
      if (args.includes('graphql'))
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } }
              }
            }
          })
        )
    }
    return ok('')
  }
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitCode: 0 }
}
function failed(stderr: string): CommandResult {
  return { stdout: '', stderr, exitCode: 1 }
}
function rulesetDetail(): Record<string, unknown> {
  return {
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['merge']
        }
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'Baseline Checks' }]
        }
      }
    ]
  }
}

/** Builds one exact publish truth with bounded pull overrides. */
function publishTruth(
  binding: ReturnType<typeof remoteBinding>,
  branchHead: string | null,
  pullOverrides: Partial<PullRequestTruth> | null
): RemoteTruth {
  return {
    branchHead,
    mergeQueueEntry: null,
    mainHead: binding.integrationBase,
    pullRequest:
      pullOverrides === null
        ? null
        : {
            number: binding.pullRequest.number ?? 12,
            state: 'OPEN',
            draft: true,
            baseRef: 'main',
            headRef: binding.headRef,
            headSha: branchHead ?? binding.candidateSha,
            mergeCommitSha: null,
            title: binding.pullRequest.title,
            body: binding.pullRequest.body,
            ...pullOverrides
          },
    requiredChecks: [],
    mainParents: [],
    pullMergeParents: [],
    reviewGate: emptyGate
  }
}

test('partial publish recovery creates the missing Draft PR without repeating a matched branch push', async () => {
  const binding = remoteBinding()
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  const adapter = new GitHubRemoteAdapter(runner)
  const truth: RemoteTruth = {
    branchHead: binding.candidateSha,
    mergeQueueEntry: null,
    mainHead: binding.integrationBase,
    pullRequest: null,
    requiredChecks: [],
    mainParents: [],
    pullMergeParents: [],
    reviewGate: emptyGate
  }
  const receipt = await adapter.mutate(binding, truth)
  assert.equal(receipt.pullRequestNumber, 12)
  assert.equal(
    runner.commands.some((command) => command.startsWith('git push ')),
    false
  )
  assert.equal(runner.commands.filter((command) => command.includes(' --method POST ')).length, 1)
})

test('publish amendment fast-forwards one exact Draft PR and patches only its changed presentation', async () => {
  const binding = remoteBinding({
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 42,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Replacement candidate'
    }
  })
  const prior = '4'.repeat(40)
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.branchHead = prior
  runner.pullExists = true
  runner.pullNumber = 42
  runner.pullHeadSha = prior
  runner.pullBody = 'Prior candidate'
  const adapter = new GitHubRemoteAdapter(runner)
  const truth = publishTruth(binding, prior, { body: runner.pullBody })

  await adapter.preflight(binding, truth)
  const receipt = await adapter.mutate(binding, truth)

  assert.equal(receipt.branchHead, binding.candidateSha)
  assert.equal(receipt.pullRequestNumber, 42)
  assert.equal(runner.branchHead, binding.candidateSha)
  assert.equal(runner.pullBody, binding.pullRequest.body)
  assert.deepEqual(
    runner.commands.filter((command) => command.startsWith('git push ')),
    [`git push origin ${binding.candidateSha}:refs/heads/${binding.headRef}`]
  )
  assert.equal(
    runner.commands.some((command) => command.includes(' --force')),
    false
  )
  assert.equal(runner.commands.filter((command) => command.includes(' --method PATCH ')).length, 1)
  assert.equal(runner.commands.filter((command) => command.includes(' --method POST ')).length, 0)
})

test('an already complete publish amendment is satisfied without another push or PR patch', async () => {
  const binding = remoteBinding({
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 42,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    }
  })
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.pullExists = true
  runner.pullNumber = 42
  const adapter = new GitHubRemoteAdapter(runner)
  const truth = publishTruth(binding, binding.candidateSha, {})

  await adapter.preflight(binding, truth)
  assert.equal(remoteMutationSatisfied(binding, truth), true)
  assert.equal(
    remoteMutationSatisfied(binding, {
      ...truth,
      pullRequest: { ...truth.pullRequest!, number: 41 }
    }),
    false
  )
  assert.equal(
    remoteMutationSatisfied(binding, {
      ...truth,
      pullRequest: { ...truth.pullRequest!, headRef: 'codex/delivery/other' }
    }),
    false
  )
  assert.equal(
    runner.commands.some((command) => command.startsWith('git push ')),
    false
  )
  assert.equal(
    runner.commands.some((command) => command.includes(' --method PATCH ')),
    false
  )
})

test('publish amendment rejects an existing owner head that is not a local candidate ancestor', async () => {
  const binding = remoteBinding({
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 42,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Replacement candidate'
    }
  })
  const unrelated = '4'.repeat(40)
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.nonAncestorHeads.add(unrelated)
  const adapter = new GitHubRemoteAdapter(runner)
  await assert.rejects(
    adapter.preflight(binding, publishTruth(binding, unrelated, { body: 'Prior candidate' })),
    /REMOTE_OWNER_BRANCH_DIVERGED/
  )
  assert.equal(
    runner.commands.some((command) => command.startsWith('git push ')),
    false
  )
})

test('publish amendment rejects wrong PR number, ref, base, state, draft, or title', async () => {
  const binding = remoteBinding({
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 42,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Replacement candidate'
    }
  })
  const cases: Array<[string, Partial<PullRequestTruth>, RegExp]> = [
    ['number', { number: 41 }, /PULL_REQUEST_NUMBER_MISMATCH/],
    ['head ref', { headRef: 'codex/delivery/other' }, /PULL_REQUEST_BINDING_MISMATCH/],
    ['base ref', { baseRef: 'develop' }, /PULL_REQUEST_BINDING_MISMATCH/],
    ['state', { state: 'CLOSED' }, /PULL_REQUEST_REF_REUSED/],
    ['draft', { draft: false }, /PULL_REQUEST_BINDING_MISMATCH/],
    ['title', { title: 'Unbound title' }, /PULL_REQUEST_BINDING_MISMATCH/]
  ]
  for (const [label, overrides, expected] of cases) {
    const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
    const adapter = new GitHubRemoteAdapter(runner)
    await assert.rejects(
      adapter.preflight(binding, publishTruth(binding, binding.candidateSha, overrides)),
      expected,
      label
    )
    assert.equal(
      runner.commands.some((command) => command.startsWith('git push ')),
      false,
      label
    )
  }
})

test('publish amendment preserves the old PR when the fast-forward push fails', async () => {
  const binding = remoteBinding({
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 42,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Replacement candidate'
    }
  })
  const prior = '4'.repeat(40)
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.branchHead = prior
  runner.pullExists = true
  runner.pullNumber = 42
  runner.pullHeadSha = prior
  runner.pullBody = 'Prior candidate'
  runner.failPush = true
  const adapter = new GitHubRemoteAdapter(runner)
  const truth = publishTruth(binding, prior, { body: runner.pullBody })
  await adapter.preflight(binding, truth)

  await assert.rejects(adapter.mutate(binding, truth), /REMOTE_COMMAND_FAILED/)
  assert.equal(runner.branchHead, prior)
  assert.equal(runner.pullHeadSha, prior)
  assert.equal(runner.pullBody, 'Prior candidate')
  assert.equal(
    runner.commands.some((command) => command.includes(' --method PATCH ')),
    false
  )
})

test('publish amendment retries only the PR patch after a successful fast-forward', async () => {
  const binding = remoteBinding({
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 42,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Replacement candidate'
    }
  })
  const prior = '4'.repeat(40)
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.branchHead = prior
  runner.pullExists = true
  runner.pullNumber = 42
  runner.pullHeadSha = prior
  runner.pullBody = 'Prior candidate'
  runner.failPatch = true
  const adapter = new GitHubRemoteAdapter(runner)
  const truth = publishTruth(binding, prior, { body: runner.pullBody })
  await adapter.preflight(binding, truth)

  await assert.rejects(adapter.mutate(binding, truth), /REMOTE_COMMAND_FAILED/)
  assert.equal(runner.branchHead, binding.candidateSha)
  assert.equal(runner.pullBody, 'Prior candidate')
  runner.failPatch = false
  const retryTruth = publishTruth(binding, binding.candidateSha, { body: runner.pullBody })
  await adapter.preflight(binding, retryTruth)
  const receipt = await adapter.mutate(binding, retryTruth)

  assert.equal(receipt.branchHead, binding.candidateSha)
  assert.equal(runner.pullBody, binding.pullRequest.body)
  assert.equal(runner.commands.filter((command) => command.startsWith('git push ')).length, 1)
  assert.equal(runner.commands.filter((command) => command.includes(' --method PATCH ')).length, 2)
})

test('preflight rejects latest-main drift before merge or publication', async () => {
  const binding = remoteBinding()
  const runner = new ScenarioRunner(binding.candidateSha, '9'.repeat(40))
  const adapter = new GitHubRemoteAdapter(runner)
  const truth: RemoteTruth = {
    branchHead: null,
    mergeQueueEntry: null,
    mainHead: '9'.repeat(40),
    pullRequest: null,
    requiredChecks: [],
    mainParents: [],
    pullMergeParents: [],
    reviewGate: emptyGate
  }
  await assert.rejects(adapter.preflight(binding, truth), /LATEST_MAIN_DRIFT/)
})

test('Merge Queue admission accepts a normally advanced main and delegates integration to the group', async () => {
  const advancedMain = '9'.repeat(40)
  const binding = remoteBinding({
    action: 'merge-pr',
    pullRequest: {
      baseRef: 'main',
      draft: false,
      number: 77,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    },
    mergeAuthorizationFingerprint: 'f'.repeat(64),
    admission: {
      mode: 'merge-queue',
      lockPath: null,
      mergeGroupSha: null,
      mergeGroupBaseSha: null
    }
  })
  const runner = new ScenarioRunner(binding.candidateSha, advancedMain)
  runner.pullExists = true
  runner.pullNumber = 77
  runner.pullDraft = false
  const adapter = new GitHubRemoteAdapter(runner)
  const truth: RemoteTruth = {
    ...publishTruth(binding, binding.candidateSha, { number: 77, draft: false }),
    mainHead: advancedMain,
    requiredChecks: [
      {
        id: 1,
        sha: binding.candidateSha,
        name: 'Baseline Checks',
        status: 'completed',
        conclusion: 'success'
      }
    ]
  }
  await adapter.mutate(binding, truth)
  assert.equal(
    runner.commands.some((command) => command.includes('/merge-async')),
    true
  )
  assert.equal(
    runner.commands.some((command) =>
      command.includes(`/compare/${binding.integrationBase}...${advancedMain}`)
    ),
    true
  )
})

test('main verification rejects a merge whose second parent is not the confirmed PR head', async () => {
  const mergeSha = '8'.repeat(40)
  const binding = remoteBinding({
    action: 'verify-main',
    expectedMergeSha: mergeSha,
    pullRequest: {
      baseRef: 'main',
      draft: false,
      number: 12,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    }
  })
  const adapter = new GitHubRemoteAdapter(new ScenarioRunner(binding.candidateSha, mergeSha))
  const truth: RemoteTruth = {
    branchHead: binding.candidateSha,
    mergeQueueEntry: null,
    mainHead: mergeSha,
    pullRequest: {
      number: 12,
      state: 'MERGED',
      draft: false,
      baseRef: 'main',
      headRef: binding.headRef,
      headSha: binding.candidateSha,
      mergeCommitSha: mergeSha,
      title: binding.pullRequest.title,
      body: binding.pullRequest.body
    },
    requiredChecks: [
      { id: 1, sha: mergeSha, name: 'Baseline Checks', status: 'completed', conclusion: 'success' }
    ],
    mainParents: ['4'.repeat(40), '9'.repeat(40)],
    pullMergeParents: ['4'.repeat(40), binding.candidateSha],
    reviewGate: emptyGate
  }
  const result = await adapter.verify(binding, truth, {
    action: 'verify-main',
    mutationPerformed: false,
    recoveredFromRemoteTruth: false,
    branchHead: binding.candidateSha,
    pullRequestNumber: 12,
    mergeCommitSha: mergeSha
  })
  assert.equal(result.passed, false)
})

test('a newer failing duplicate required check blocks an older success', async () => {
  const binding = remoteBinding({
    action: 'verify-pr',
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 12,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    }
  })
  const adapter = new GitHubRemoteAdapter(new ScenarioRunner(binding.candidateSha, '8'.repeat(40)))
  const pull = {
    number: 12,
    state: 'OPEN' as const,
    draft: true,
    baseRef: 'main',
    headRef: binding.headRef,
    headSha: binding.candidateSha,
    mergeCommitSha: null,
    title: binding.pullRequest.title,
    body: binding.pullRequest.body
  }
  const result = await adapter.verify(
    binding,
    {
      branchHead: binding.candidateSha,
      mergeQueueEntry: null,
      mainHead: binding.integrationBase,
      pullRequest: pull,
      requiredChecks: [
        {
          id: 10,
          sha: binding.candidateSha,
          name: 'Baseline Checks',
          status: 'completed',
          conclusion: 'success'
        },
        {
          id: 11,
          sha: binding.candidateSha,
          name: 'Baseline Checks',
          status: 'completed',
          conclusion: 'failure'
        }
      ],
      mainParents: [],
      pullMergeParents: [],
      reviewGate: emptyGate
    },
    {
      action: 'verify-pr',
      mutationPerformed: false,
      recoveredFromRemoteTruth: false,
      branchHead: binding.candidateSha,
      pullRequestNumber: 12,
      mergeCommitSha: null
    }
  )
  assert.equal(result.passed, false)
  assert.equal(result.status, 'PR_CI_PENDING')
})

test('a required check without a positive authoritative run id fails closed', async () => {
  const binding = remoteBinding({
    action: 'verify-pr',
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 12,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    }
  })
  const adapter = new GitHubRemoteAdapter(new ScenarioRunner(binding.candidateSha, '8'.repeat(40)))
  const result = await adapter.verify(
    binding,
    {
      branchHead: binding.candidateSha,
      mergeQueueEntry: null,
      mainHead: binding.integrationBase,
      pullRequest: {
        number: 12,
        state: 'OPEN',
        draft: true,
        baseRef: 'main',
        headRef: binding.headRef,
        headSha: binding.candidateSha,
        mergeCommitSha: null,
        title: binding.pullRequest.title,
        body: binding.pullRequest.body
      },
      requiredChecks: [
        {
          id: Number.NaN,
          sha: binding.candidateSha,
          name: 'Baseline Checks',
          status: 'completed',
          conclusion: 'success'
        }
      ],
      mainParents: [],
      pullMergeParents: [],
      reviewGate: emptyGate
    },
    {
      action: 'verify-pr',
      mutationPerformed: false,
      recoveredFromRemoteTruth: false,
      branchHead: binding.candidateSha,
      pullRequestNumber: 12,
      mergeCommitSha: null
    }
  )
  assert.equal(result.passed, false)
  assert.equal(result.status, 'PR_CI_PENDING')
})

test('review gate counts annotations only from the newest authoritative required check', async () => {
  const binding = remoteBinding({
    action: 'verify-pr',
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 12,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    }
  })
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.pullExists = true
  runner.checkRuns = [
    {
      id: 10,
      name: 'Baseline Checks',
      status: 'completed',
      conclusion: 'failure'
    },
    {
      id: 11,
      name: 'Baseline Checks',
      status: 'completed',
      conclusion: 'success'
    },
    {
      id: 20,
      name: 'Secondary Check (non-required)',
      status: 'completed',
      conclusion: 'failure'
    }
  ]
  runner.annotationsByCheckId.set(10, [{ annotation_level: 'failure' }])
  runner.annotationsByCheckId.set(11, [{ annotation_level: 'warning' }])
  runner.annotationsByCheckId.set(20, [{ annotation_level: 'failure' }])

  const truth = await new GitHubRemoteAdapter(runner).readTruth(binding)

  assert.equal(truth.reviewGate.annotations, 1)
  assert.equal(
    runner.commands.some((command) => command.includes('/check-runs/10/annotations')),
    false
  )
  assert.equal(
    runner.commands.some((command) => command.includes('/check-runs/11/annotations')),
    true
  )
  assert.equal(
    runner.commands.some((command) => command.includes('/check-runs/20/annotations')),
    false
  )
})

test('review gate reads required-check annotations through the final page', async () => {
  const binding = remoteBinding({
    action: 'verify-pr',
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: 12,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    }
  })
  const runner = new ScenarioRunner(binding.candidateSha, binding.integrationBase)
  runner.pullExists = true
  runner.checkRuns = [
    { id: 11, name: 'Baseline Checks', status: 'completed', conclusion: 'success' }
  ]
  runner.annotationsByCheckId.set(11, [
    ...Array.from({ length: 100 }, () => ({ annotation_level: 'notice' })),
    { annotation_level: 'failure' }
  ])

  const truth = await new GitHubRemoteAdapter(runner).readTruth(binding)

  assert.equal(truth.reviewGate.annotations, 1)
  assert.equal(
    runner.commands.some((command) => command.includes('/annotations?per_page=100&page=2')),
    true
  )
})

test('protect-main ruleset must target exactly the default main ref', async () => {
  const binding = remoteBinding()
  const wrongRuleset = rulesetDetail()
  wrongRuleset.conditions = {
    ref_name: { include: ['refs/heads/develop'], exclude: ['refs/heads/main'] }
  }
  const adapter = new GitHubRemoteAdapter(
    new ScenarioRunner(binding.candidateSha, binding.integrationBase, wrongRuleset)
  )
  await assert.rejects(
    adapter.preflight(binding, {
      branchHead: null,
      mergeQueueEntry: null,
      mainHead: binding.integrationBase,
      pullRequest: null,
      requiredChecks: [],
      mainParents: [],
      pullMergeParents: [],
      reviewGate: emptyGate
    }),
    /REPOSITORY_RULESET_MISMATCH/
  )
})
