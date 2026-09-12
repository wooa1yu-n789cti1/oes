import { spawnSync } from 'node:child_process'
import { fail } from './errors.ts'
import type { RemoteAdapter } from './remote-driver.ts'
import type {
  RemoteDriverBinding,
  RemoteReceipt,
  RemoteTruth,
  RemoteVerification,
  RequiredCheckTruth,
  PullRequestTruth
} from './types.ts'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): CommandResult
}

export interface CommandInvocation {
  command: string
  args: string[]
}

/** Routes a command through the managed-session-compatible POSIX process boundary. */
export function managedCommandInvocation(command: string, args: string[]): CommandInvocation {
  return {
    command: '/bin/sh',
    args: ['-c', 'exec "$@"', 'oes-remote-command', command, ...args]
  }
}

/** Executes one child process through the managed broker boundary and preserves literal output. */
export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: string[], cwd: string): CommandResult {
    const invocation = managedCommandInvocation(command, args)
    const result = spawnSync(invocation.command, invocation.args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const spawnError = result.error?.message ?? ''
    return {
      stdout: result.stdout ?? '',
      stderr: [result.stderr ?? '', spawnError].filter(Boolean).join('\n'),
      exitCode: result.status ?? 1
    }
  }
}

/** Requires a command to succeed and returns its literal stdout. */
function checked(runner: CommandRunner, command: string, args: string[], cwd: string): string {
  const result = runner.run(command, args, cwd)
  if (result.exitCode !== 0)
    fail(
      'REMOTE_COMMAND_FAILED',
      `${command} ${args.join(' ')} [${result.exitCode}] ${result.stderr.trim()}`
    )
  return result.stdout
}

/** Parses one exact ls-remote branch result. */
function parseRemoteHead(output: string, ref: string): string | null {
  const lines = output.trim().split('\n').filter(Boolean)
  if (lines.length === 0) return null
  if (lines.length !== 1) fail('REMOTE_REF_AMBIGUOUS', ref)
  const [sha, actualRef] = lines[0].split(/\s+/)
  if (actualRef !== ref || !/^[0-9a-f]{40}$/.test(sha)) fail('REMOTE_REF_INVALID', lines[0])
  return sha
}

/** Converts a GitHub REST pull response into bounded remote truth. */
function parsePull(value: Record<string, unknown>): PullRequestTruth {
  const head = value.head as Record<string, unknown>
  const base = value.base as Record<string, unknown>
  const merged = value.merged_at !== null && value.merged_at !== undefined
  return {
    number: Number(value.number),
    state: merged ? 'MERGED' : String(value.state).toLowerCase() === 'open' ? 'OPEN' : 'CLOSED',
    draft: value.draft === true,
    baseRef: String(base.ref),
    headRef: String(head.ref),
    headSha: String(head.sha),
    mergeCommitSha: value.merge_commit_sha ? String(value.merge_commit_sha) : null,
    title: String(value.title ?? ''),
    body: String(value.body ?? '')
  }
}

/** Returns whether the remote URL names the exact bound repository. */
function remoteMatchesSlug(remote: string, slug: string): boolean {
  const normalized = remote.trim().replace(/\.git$/, '')
  return (
    normalized === `https://github.com/${slug}` ||
    normalized === `ssh://git@github.com/${slug}` ||
    normalized === `git@github.com:${slug}`
  )
}

/** Implements exact Git/GitHub operations for the repository remote driver. */
export class GitHubRemoteAdapter implements RemoteAdapter {
  readonly runner: CommandRunner
  readonly git: string
  readonly gh: string

  constructor(runner: CommandRunner = new SpawnCommandRunner(), git = 'git', gh = 'gh') {
    this.runner = runner
    this.git = git
    this.gh = gh
  }

  /** Runs local, repository-policy, review and latest-main guards before a bound action. */
  async preflight(binding: RemoteDriverBinding, truth: RemoteTruth): Promise<void> {
    const cwd = binding.repositoryRoot
    const status = checked(this.runner, this.git, ['status', '--porcelain'], cwd).trim()
    if (status) fail('OWNER_WORKTREE_DIRTY', status)
    const remote = checked(this.runner, this.git, ['remote', 'get-url', 'origin'], cwd)
    if (!remoteMatchesSlug(remote, binding.repositorySlug))
      fail('BOUND_REPOSITORY_REMOTE_MISMATCH', remote.trim())
    const head = checked(this.runner, this.git, ['rev-parse', 'HEAD'], cwd).trim()
    if (head !== binding.candidateSha && binding.action !== 'verify-main')
      fail('LOCAL_HEAD_MISMATCH', head)
    const branch = checked(this.runner, this.git, ['branch', '--show-current'], cwd).trim()
    if (binding.action !== 'verify-main' && branch !== binding.headRef)
      fail('LOCAL_BRANCH_MISMATCH', branch)
    this.verifyRepositoryBaseline(binding)
    if (['preflight', 'publish-pr', 'verify-pr'].includes(binding.action)) {
      if (truth.mainHead !== binding.integrationBase)
        fail('LATEST_MAIN_DRIFT', `${truth.mainHead} != ${binding.integrationBase}`)
      checked(
        this.runner,
        this.git,
        ['merge-base', '--is-ancestor', binding.integrationBase, binding.candidateSha],
        cwd
      )
    }
    if (
      binding.action === 'merge-pr' &&
      binding.admission?.mode === 'merge-queue' &&
      truth.mergeQueueEntry
    ) {
      if (truth.mergeQueueEntry.headSha === binding.candidateSha)
        fail('MERGE_GROUP_NOT_SYNTHESIZED', truth.mergeQueueEntry.headSha)
      this.verifyRemoteAncestor(binding, binding.integrationBase, truth.mergeQueueEntry.baseSha)
    }
    if (
      binding.pullRequest.number !== null &&
      truth.pullRequest?.number !== binding.pullRequest.number
    )
      fail('PULL_REQUEST_NUMBER_MISMATCH', String(truth.pullRequest?.number))
    if (binding.action === 'publish-pr') this.requirePublishSource(binding, truth)
    else {
      if (truth.branchHead && truth.branchHead !== binding.candidateSha)
        fail('REMOTE_OWNER_BRANCH_DIVERGED', truth.branchHead)
      if (truth.pullRequest) this.requireExactPull(binding, truth.pullRequest)
    }
  }

  /** Reads exact branch, pull, queue, check, review and main state without remote mutation. */
  async readTruth(binding: RemoteDriverBinding): Promise<RemoteTruth> {
    const cwd = binding.repositoryRoot
    const branchRef = `refs/heads/${binding.headRef}`
    const branchHead = parseRemoteHead(
      checked(this.runner, this.git, ['ls-remote', '--heads', 'origin', branchRef], cwd),
      branchRef
    )
    const mainHead = parseRemoteHead(
      checked(this.runner, this.git, ['ls-remote', '--heads', 'origin', 'refs/heads/main'], cwd),
      'refs/heads/main'
    )
    if (!mainHead) fail('REMOTE_MAIN_ABSENT', binding.repositorySlug)
    const pullRequest = this.readPull(binding)
    const mergeQueueEntry = this.readMergeQueueEntry(binding)
    const checkSha =
      binding.action === 'verify-main'
        ? mainHead
        : (mergeQueueEntry?.headSha ??
          (binding.admission?.mode === 'merge-queue' && pullRequest?.state === 'MERGED'
            ? pullRequest.mergeCommitSha
            : (pullRequest?.headSha ?? branchHead)))
    const requiredChecks = checkSha ? this.readChecks(binding, checkSha) : []
    const pullMergeParents = pullRequest?.mergeCommitSha
      ? this.readCommitParents(binding, pullRequest.mergeCommitSha)
      : []
    const reviewGate = pullRequest
      ? this.readReviewGate(binding, pullRequest.number, requiredChecks)
      : {
          annotations: 0,
          issueComments: 0,
          reviewComments: 0,
          blockingReviews: 0,
          unresolvedThreads: 0
        }
    checked(this.runner, this.git, ['fetch', '--no-tags', 'origin', 'main'], cwd)
    const commit = checked(this.runner, this.git, ['cat-file', '-p', 'origin/main'], cwd)
    const mainParents = commit
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice('parent '.length))
    return {
      branchHead,
      mergeQueueEntry,
      mainHead,
      pullRequest,
      requiredChecks,
      mainParents,
      pullMergeParents,
      reviewGate
    }
  }

  /** Applies only the single mutation named by the binding. */
  async mutate(binding: RemoteDriverBinding, truth: RemoteTruth): Promise<RemoteReceipt> {
    const cwd = binding.repositoryRoot
    if (binding.action === 'publish-pr') {
      if (truth.branchHead === null)
        checked(
          this.runner,
          this.git,
          ['push', 'origin', `${binding.candidateSha}:refs/heads/${binding.headRef}`],
          cwd
        )
      else if (truth.branchHead !== binding.candidateSha) {
        this.requirePublishSource(binding, truth)
        checked(
          this.runner,
          this.git,
          ['push', 'origin', `${binding.candidateSha}:refs/heads/${binding.headRef}`],
          cwd
        )
      }
      const currentPull = this.readPull(binding)
      if (!currentPull)
        checked(
          this.runner,
          this.gh,
          [
            'api',
            '--method',
            'POST',
            `repos/${binding.repositorySlug}/pulls`,
            '-f',
            `title=${binding.pullRequest.title}`,
            '-f',
            `body=${binding.pullRequest.body}`,
            '-f',
            `head=${binding.headRef}`,
            '-f',
            'base=main',
            '-F',
            'draft=true'
          ],
          cwd
        )
      else {
        this.requireMutableDraftPull(binding, currentPull)
        if (
          currentPull.title !== binding.pullRequest.title ||
          currentPull.body !== binding.pullRequest.body
        )
          checked(
            this.runner,
            this.gh,
            [
              'api',
              '--method',
              'PATCH',
              `repos/${binding.repositorySlug}/pulls/${currentPull.number}`,
              '-f',
              `title=${binding.pullRequest.title}`,
              '-f',
              `body=${binding.pullRequest.body}`
            ],
            cwd
          )
      }
    } else if (binding.action === 'merge-pr') {
      this.requireMergeGate(binding, truth)
      checked(
        this.runner,
        this.gh,
        [
          'api',
          '--method',
          'PUT',
          `repos/${binding.repositorySlug}/pulls/${binding.pullRequest.number}/merge-async`,
          '-f',
          `sha=${binding.candidateSha}`,
          '-f',
          'merge_method=merge',
          '-f',
          'merge_action=merge_queue'
        ],
        cwd
      )
    } else fail('READ_ONLY_ACTION_MUTATION_REQUESTED', binding.action)
    const after = await this.readTruth(binding)
    return {
      action: binding.action,
      mutationPerformed: true,
      recoveredFromRemoteTruth: false,
      branchHead: after.branchHead,
      pullRequestNumber: after.pullRequest?.number ?? null,
      mergeCommitSha: after.pullRequest?.mergeCommitSha ?? null,
      mergeGroupBaseSha:
        after.mergeQueueEntry?.baseSha ??
        (binding.admission?.mode === 'merge-queue' ? (after.pullMergeParents[0] ?? null) : null),
      mergeGroupHeadSha:
        after.mergeQueueEntry?.headSha ??
        (binding.admission?.mode === 'merge-queue'
          ? (after.pullRequest?.mergeCommitSha ?? null)
          : null)
    }
  }

  /** Verifies the postcondition for the exact action and receipt. */
  async verify(
    binding: RemoteDriverBinding,
    truth: RemoteTruth,
    receipt: RemoteReceipt
  ): Promise<RemoteVerification> {
    if (binding.action === 'preflight')
      return {
        passed: truth.mainHead === binding.integrationBase,
        status: 'PREFLIGHT',
        literalResult: truth
      }
    if (binding.action === 'publish-pr') {
      const passed =
        truth.branchHead === binding.candidateSha &&
        truth.pullRequest?.state === 'OPEN' &&
        truth.pullRequest.draft &&
        (binding.pullRequest.number === null ||
          truth.pullRequest.number === binding.pullRequest.number) &&
        truth.pullRequest.headSha === binding.candidateSha &&
        truth.pullRequest.baseRef === 'main' &&
        truth.pullRequest.headRef === binding.headRef &&
        truth.pullRequest.title === binding.pullRequest.title &&
        truth.pullRequest.body === binding.pullRequest.body
      return {
        passed: Boolean(passed),
        status: passed ? 'PR_READY' : 'PR_NOT_READY',
        literalResult: truth.pullRequest
      }
    }
    if (binding.action === 'verify-pr') {
      const passed =
        truth.pullRequest?.headSha === binding.candidateSha &&
        truth.pullRequest.title === binding.pullRequest.title &&
        truth.pullRequest.body === binding.pullRequest.body &&
        this.requiredChecksPass(binding, truth.requiredChecks, binding.candidateSha) &&
        this.reviewGatePasses(truth)
      return {
        passed: Boolean(passed),
        status: passed ? 'PR_CI_PASSED' : 'PR_CI_PENDING',
        literalResult: { checks: truth.requiredChecks, reviewGate: truth.reviewGate }
      }
    }
    if (binding.action === 'merge-pr') {
      let groupChecksPassed = true
      if (binding.admission?.mode === 'merge-queue') {
        if (!receipt.mergeGroupBaseSha || !receipt.mergeGroupHeadSha)
          return { passed: false, status: 'MERGE_GROUP_INPUTS_PENDING', literalResult: receipt }
        this.verifyRemoteAncestor(binding, binding.integrationBase, receipt.mergeGroupBaseSha)
        const groupChecks = this.readChecks(binding, receipt.mergeGroupHeadSha)
        groupChecksPassed = this.requiredChecksPass(binding, groupChecks, receipt.mergeGroupHeadSha)
      }
      const passed =
        truth.pullRequest?.state === 'MERGED' &&
        truth.pullRequest.headSha === binding.candidateSha &&
        truth.pullRequest.mergeCommitSha !== null &&
        (binding.admission?.mode !== 'merge-queue' ||
          truth.pullRequest.mergeCommitSha === receipt.mergeGroupHeadSha) &&
        groupChecksPassed &&
        this.reviewGatePasses(truth)
      return {
        passed: Boolean(passed),
        status: passed ? 'MERGED' : 'MERGE_NOT_OBSERVED',
        literalResult: { pullRequest: truth.pullRequest, receipt }
      }
    }
    if (binding.action === 'verify-main') {
      const expectedMergeSha = binding.expectedMergeSha as string
      const exactParents =
        truth.mainParents.length === 2 && truth.mainParents[1] === binding.candidateSha
      let treeMatches = false
      if (truth.mainHead === expectedMergeSha && exactParents) {
        checked(
          this.runner,
          this.git,
          ['merge-base', '--is-ancestor', binding.candidateSha, expectedMergeSha],
          binding.repositoryRoot
        )
        const expectedTreeSource =
          binding.admission?.mode === 'merge-queue'
            ? binding.admission.mergeGroupSha
            : binding.candidateSha
        if (!expectedTreeSource) fail('VERIFY_MAIN_MERGE_GROUP_REQUIRED', binding.headRef)
        const mainTree = checked(
          this.runner,
          this.git,
          ['rev-parse', `${expectedMergeSha}^{tree}`],
          binding.repositoryRoot
        ).trim()
        const reviewedTree = checked(
          this.runner,
          this.git,
          ['rev-parse', `${expectedTreeSource}^{tree}`],
          binding.repositoryRoot
        ).trim()
        treeMatches = mainTree === reviewedTree
      }
      const passed =
        truth.mainHead === expectedMergeSha &&
        truth.pullRequest?.mergeCommitSha === expectedMergeSha &&
        truth.pullRequest.headSha === binding.candidateSha &&
        exactParents &&
        treeMatches &&
        this.requiredChecksPass(binding, truth.requiredChecks, expectedMergeSha) &&
        this.reviewGatePasses(truth)
      return {
        passed: Boolean(passed),
        status: passed ? 'MAIN_CI_PASSED' : 'MAIN_VERIFICATION_PENDING',
        literalResult: truth
      }
    }
    fail('REMOTE_VERIFICATION_ACTION_UNKNOWN', binding.action)
  }

  /** Requires the live pull identity and immutable presentation to match the binding. */
  private requireExactPull(binding: RemoteDriverBinding, pull: PullRequestTruth): void {
    if (
      pull.baseRef !== 'main' ||
      pull.headRef !== binding.headRef ||
      pull.headSha !== binding.candidateSha ||
      pull.title !== binding.pullRequest.title ||
      pull.body !== binding.pullRequest.body
    )
      fail('PULL_REQUEST_BINDING_MISMATCH', String(pull.number))
  }

  /** Admits only an exact Draft PR whose current head is the candidate or its strict local ancestor. */
  private requirePublishSource(binding: RemoteDriverBinding, truth: RemoteTruth): void {
    const pull = truth.pullRequest
    if (!pull) {
      if (truth.branchHead !== null && truth.branchHead !== binding.candidateSha)
        fail('REMOTE_OWNER_BRANCH_DIVERGED', truth.branchHead)
      return
    }
    if (pull.state !== 'OPEN') fail('PULL_REQUEST_REF_REUSED', String(pull.number))
    if (
      pull.draft !== true ||
      pull.baseRef !== 'main' ||
      pull.headRef !== binding.headRef ||
      pull.headSha !== truth.branchHead ||
      pull.title !== binding.pullRequest.title
    )
      fail('PULL_REQUEST_BINDING_MISMATCH', String(pull.number))
    if (truth.branchHead === null) fail('PULL_REQUEST_BINDING_MISMATCH', String(pull.number))
    if (truth.branchHead !== binding.candidateSha)
      this.requireLocalFastForward(binding, truth.branchHead)
  }

  /** Requires the post-push Draft PR identity before changing only its bound presentation. */
  private requireMutableDraftPull(binding: RemoteDriverBinding, pull: PullRequestTruth): void {
    if (
      (binding.pullRequest.number !== null && pull.number !== binding.pullRequest.number) ||
      pull.state !== 'OPEN' ||
      pull.draft !== true ||
      pull.baseRef !== 'main' ||
      pull.headRef !== binding.headRef ||
      pull.headSha !== binding.candidateSha
    )
      fail('PULL_REQUEST_BINDING_MISMATCH', String(pull.number))
  }

  /** Proves the remote owner head is a strict locally known ancestor of the new candidate. */
  private requireLocalFastForward(binding: RemoteDriverBinding, remoteHead: string): void {
    if (remoteHead === binding.candidateSha) return
    const result = this.runner.run(
      this.git,
      ['merge-base', '--is-ancestor', remoteHead, binding.candidateSha],
      binding.repositoryRoot
    )
    if (result.exitCode !== 0) fail('REMOTE_OWNER_BRANCH_DIVERGED', remoteHead)
  }

  /** Requires all non-Human merge gates visible before admission. */
  private requireMergeGate(binding: RemoteDriverBinding, truth: RemoteTruth): void {
    if (binding.admission?.mode !== 'merge-queue')
      fail('MERGE_QUEUE_REQUIRED', String(binding.admission?.mode))
    this.verifyRemoteAncestor(binding, binding.integrationBase, truth.mainHead)
    if (!truth.pullRequest || truth.pullRequest.draft)
      fail('PULL_REQUEST_NOT_MERGE_READY', binding.headRef)
    this.requireExactPull(binding, truth.pullRequest)
    if (!this.requiredChecksPass(binding, truth.requiredChecks, binding.candidateSha))
      fail('REQUIRED_CHECKS_NOT_PASSED', binding.candidateSha)
    if (!this.reviewGatePasses(truth)) fail('PULL_REQUEST_REVIEW_GATE_BLOCKED', binding.headRef)
  }

  /** Verifies repository settings required by canonical v6. */
  private verifyRepositoryBaseline(binding: RemoteDriverBinding): void {
    const cwd = binding.repositoryRoot
    const repo = JSON.parse(
      checked(this.runner, this.gh, ['api', `repos/${binding.repositorySlug}`], cwd)
    ) as Record<string, unknown>
    const rulesets = JSON.parse(
      checked(
        this.runner,
        this.gh,
        ['api', `repos/${binding.repositorySlug}/rulesets?per_page=100`],
        cwd
      )
    ) as Array<Record<string, unknown>>
    const workflow = JSON.parse(
      checked(
        this.runner,
        this.gh,
        ['api', `repos/${binding.repositorySlug}/actions/permissions/workflow`],
        cwd
      )
    ) as Record<string, unknown>
    const matches = rulesets.filter(
      (r) => r.name === 'protect-main' && r.target === 'branch' && r.enforcement === 'active'
    )
    if (
      repo.default_branch !== 'main' ||
      repo.delete_branch_on_merge !== false ||
      repo.allow_merge_commit !== true ||
      repo.allow_squash_merge !== false ||
      repo.allow_rebase_merge !== false ||
      repo.allow_auto_merge !== false ||
      workflow.default_workflow_permissions !== 'read' ||
      workflow.can_approve_pull_request_reviews !== false ||
      matches.length !== 1
    )
      fail('REPOSITORY_BASELINE_MISMATCH', binding.repositorySlug)
    const ruleset = JSON.parse(
      checked(
        this.runner,
        this.gh,
        ['api', `repos/${binding.repositorySlug}/rulesets/${String(matches[0].id)}`],
        cwd
      )
    ) as Record<string, unknown>
    const bypass = ruleset.bypass_actors as unknown[]
    const conditions = ruleset.conditions as Record<string, unknown> | undefined
    const refName = conditions?.ref_name as Record<string, unknown> | undefined
    const includedRefs = canonicalSet(refName?.include)
    const excludedRefs = canonicalSet(refName?.exclude)
    const rules = Object.fromEntries(
      ((ruleset.rules as Array<Record<string, unknown>>) ?? []).map((r) => [String(r.type), r])
    )
    const pull = rules.pull_request?.parameters as Record<string, unknown> | undefined
    const checks = rules.required_status_checks?.parameters as Record<string, unknown> | undefined
    const required =
      (checks?.required_status_checks as Array<Record<string, unknown>> | undefined) ?? []
    if (
      !Array.isArray(bypass) ||
      bypass.length !== 0 ||
      !['refs/heads/main', '~DEFAULT_BRANCH'].includes(includedRefs) ||
      excludedRefs !== '' ||
      !rules.deletion ||
      !rules.non_fast_forward ||
      pull?.required_approving_review_count !== 0 ||
      pull.required_review_thread_resolution !== true ||
      canonicalSet(pull.allowed_merge_methods) !== 'merge' ||
      checks?.strict_required_status_checks_policy !== true ||
      !required.some((r) => r.context === 'Baseline Checks')
    )
      fail('REPOSITORY_RULESET_MISMATCH', binding.repositorySlug)
  }

  /** Finds at most one pull request for the exact head/base pair. */
  private readPull(binding: RemoteDriverBinding): PullRequestTruth | null {
    const [owner] = binding.repositorySlug.split('/')
    const query = `repos/${binding.repositorySlug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${binding.headRef}`)}&base=main&per_page=20`
    const pulls = (
      JSON.parse(checked(this.runner, this.gh, ['api', query], binding.repositoryRoot)) as Record<
        string,
        unknown
      >[]
    ).map(parsePull)
    const matches = pulls.filter(
      (pull) => binding.pullRequest.number === null || pull.number === binding.pullRequest.number
    )
    if (matches.length > 1) fail('PULL_REQUEST_AMBIGUOUS', binding.headRef)
    return matches[0] ?? null
  }

  /** Reads native merge-queue membership with exact generated base/head commits. */
  private readMergeQueueEntry(binding: RemoteDriverBinding): RemoteTruth['mergeQueueEntry'] {
    if (binding.admission?.mode !== 'merge-queue' || binding.pullRequest.number === null)
      return null
    const [owner, name] = binding.repositorySlug.split('/')
    const query =
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id position state baseCommit{oid} headCommit{oid}}}}}'
    const raw = checked(
      this.runner,
      this.gh,
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${binding.pullRequest.number}`
      ],
      binding.repositoryRoot
    )
    const response = JSON.parse(raw) as {
      data?: {
        repository?: {
          pullRequest?: {
            mergeQueueEntry?: {
              id: string
              position?: number | null
              state: string
              baseCommit?: { oid?: string }
              headCommit?: { oid?: string }
            } | null
          }
        }
      }
    }
    const entry = response.data?.repository?.pullRequest?.mergeQueueEntry
    if (!entry) return null
    const baseSha = String(entry.baseCommit?.oid ?? '')
    const headSha = String(entry.headCommit?.oid ?? '')
    if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha))
      fail('MERGE_QUEUE_COMMIT_IDENTITY_MISSING', entry.id)
    return { id: entry.id, position: entry.position ?? null, state: entry.state, baseSha, headSha }
  }

  /** Reads the exact parent list for a possibly non-current merge commit. */
  private readCommitParents(binding: RemoteDriverBinding, sha: string): string[] {
    const raw = checked(
      this.runner,
      this.gh,
      ['api', `repos/${binding.repositorySlug}/git/commits/${sha}`],
      binding.repositoryRoot
    )
    const commit = JSON.parse(raw) as { parents?: Array<{ sha?: string }> }
    const parents = (commit.parents ?? []).map((parent) => String(parent.sha ?? ''))
    if (parents.some((parent) => !/^[0-9a-f]{40}$/.test(parent)))
      fail('REMOTE_MERGE_PARENT_INVALID', sha)
    return parents
  }

  /** Reads check runs for one exact commit without changing repository state. */
  private readChecks(binding: RemoteDriverBinding, sha: string): RequiredCheckTruth[] {
    const raw = checked(
      this.runner,
      this.gh,
      ['api', `repos/${binding.repositorySlug}/commits/${sha}/check-runs?per_page=100`],
      binding.repositoryRoot
    )
    const response = JSON.parse(raw) as { check_runs?: Array<Record<string, unknown>> }
    return (response.check_runs ?? []).map((check) => ({
      sha,
      name: String(check.name),
      status: String(check.status),
      conclusion: check.conclusion === null ? null : String(check.conclusion),
      id: Number(check.id),
      startedAt: check.started_at ? String(check.started_at) : undefined,
      completedAt: check.completed_at ? String(check.completed_at) : null
    }))
  }

  /** Reads annotations, comments, blocking reviews and unresolved conversations. */
  private readReviewGate(
    binding: RemoteDriverBinding,
    pr: number,
    checks: RequiredCheckTruth[]
  ): RemoteTruth['reviewGate'] {
    const cwd = binding.repositoryRoot
    let annotations = 0
    const checkSha = checks[0]?.sha ?? binding.candidateSha
    const authoritativeChecks = this.currentRequiredChecks(binding, checks, checkSha) ?? []
    for (const check of authoritativeChecks) {
      let exhausted = false
      for (let page = 1; page <= 1_000; page += 1) {
        const values = JSON.parse(
          checked(
            this.runner,
            this.gh,
            [
              'api',
              `repos/${binding.repositorySlug}/check-runs/${String(check.id)}/annotations?per_page=100&page=${page}`
            ],
            cwd
          )
        ) as unknown
        if (!Array.isArray(values)) fail('CHECK_ANNOTATIONS_RESPONSE_INVALID', String(check.id))
        annotations += values.filter((annotation) => {
          if (!annotation || typeof annotation !== 'object')
            fail('CHECK_ANNOTATION_INVALID', String(check.id))
          return ['warning', 'failure'].includes(
            String((annotation as Record<string, unknown>).annotation_level)
          )
        }).length
        if (values.length < 100) {
          exhausted = true
          break
        }
      }
      if (!exhausted) fail('CHECK_ANNOTATIONS_PAGINATION_INCOMPLETE', String(check.id))
    }
    const issueComments = (
      JSON.parse(
        checked(
          this.runner,
          this.gh,
          ['api', `repos/${binding.repositorySlug}/issues/${pr}/comments?per_page=100`],
          cwd
        )
      ) as unknown[]
    ).length
    const reviewComments = (
      JSON.parse(
        checked(
          this.runner,
          this.gh,
          ['api', `repos/${binding.repositorySlug}/pulls/${pr}/comments?per_page=100`],
          cwd
        )
      ) as unknown[]
    ).length
    const reviews = JSON.parse(
      checked(
        this.runner,
        this.gh,
        ['api', `repos/${binding.repositorySlug}/pulls/${pr}/reviews?per_page=100`],
        cwd
      )
    ) as Array<Record<string, unknown>>
    const blockingReviews = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length
    const [owner, name] = binding.repositorySlug.split('/')
    const query =
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}'
    const graph = JSON.parse(
      checked(
        this.runner,
        this.gh,
        [
          'api',
          'graphql',
          '-f',
          `query=${query}`,
          '-f',
          `owner=${owner}`,
          '-f',
          `name=${name}`,
          '-F',
          `number=${pr}`
        ],
        cwd
      )
    ) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage?: boolean }
              nodes?: Array<{ isResolved?: boolean }>
            }
          }
        }
      }
    }
    const threads = graph.data?.repository?.pullRequest?.reviewThreads
    if (threads?.pageInfo?.hasNextPage) fail('REVIEW_THREAD_PAGINATION_REQUIRED', String(pr))
    const unresolvedThreads = (threads?.nodes ?? []).filter(
      (thread) => thread.isResolved !== true
    ).length
    return { annotations, issueComments, reviewComments, blockingReviews, unresolvedThreads }
  }

  /** Selects one newest, uniquely identified check run for every required context. */
  private currentRequiredChecks(
    binding: RemoteDriverBinding,
    checks: RequiredCheckTruth[],
    sha: string
  ): RequiredCheckTruth[] | null {
    const current: RequiredCheckTruth[] = []
    for (const name of binding.pullRequest.requiredChecks) {
      const matches = checks.filter((check) => check.sha === sha && check.name === name)
      if (
        matches.length === 0 ||
        matches.some((check) => !Number.isSafeInteger(check.id) || Number(check.id) < 1) ||
        new Set(matches.map((check) => check.id)).size !== matches.length
      )
        return null
      current.push([...matches].sort((left, right) => Number(right.id) - Number(left.id))[0])
    }
    return current
  }

  /** Requires the authoritative newest run for every bound context to pass on the exact SHA. */
  private requiredChecksPass(
    binding: RemoteDriverBinding,
    checks: RequiredCheckTruth[],
    sha: string
  ): boolean {
    const current = this.currentRequiredChecks(binding, checks, sha)
    return (
      current !== null &&
      current.every((check) => check.status === 'completed' && check.conclusion === 'success')
    )
  }

  /** Requires all review and annotation counters to be clear. */
  private reviewGatePasses(truth: RemoteTruth): boolean {
    return Object.values(truth.reviewGate).every((count) => count === 0)
  }

  /** Uses the remote compare API so merge-queue bases can include prior admitted results. */
  private verifyRemoteAncestor(
    binding: RemoteDriverBinding,
    ancestor: string,
    descendant: string
  ): void {
    const raw = checked(
      this.runner,
      this.gh,
      ['api', `repos/${binding.repositorySlug}/compare/${ancestor}...${descendant}`],
      binding.repositoryRoot
    )
    const comparison = JSON.parse(raw) as { status?: string }
    if (!['identical', 'ahead'].includes(String(comparison.status)))
      fail('MERGE_GROUP_BASE_NOT_LATEST_MAIN_DESCENDANT', `${ancestor}..${descendant}`)
  }
}

/** Canonicalizes a string-array setting for exact comparison. */
function canonicalSet(value: unknown): string {
  return Array.isArray(value) ? [...value].map(String).sort().join(',') : ''
}
