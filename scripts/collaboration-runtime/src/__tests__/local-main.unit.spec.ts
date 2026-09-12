import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import { SpawnCommandRunner } from '../github-adapter.ts'
import {
  LocalMainController,
  evaluateLocalMainObservation,
  type LocalCommandRunner,
  type LocalMainObservation,
  type LocalMainSyncBinding,
  type LocalMainSyncConfirmation
} from '../local-main.ts'
import type { RemoteTrustRoots, TrustedAuthorizationReference } from '../types.ts'

/** Runs one fixture Git command and returns its trimmed output. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(result.stderr).trim()}`)
  return String(result.stdout).trim()
}

/** Seals one exact local-main binding after all Human-bound fields are present. */
function seal(binding: Omit<LocalMainSyncBinding, 'bindingFingerprint'>): LocalMainSyncBinding {
  const value = { ...binding, bindingFingerprint: '' } as LocalMainSyncBinding
  value.bindingFingerprint = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  return value
}

/** Writes one trusted exact Human confirmation fixture and returns its immutable reference. */
function confirmationFixture(
  trust: RemoteTrustRoots,
  repositoryRoot: string,
  expectedRemoteUrl: string,
  expectedRemoteMainSha: string,
  overrides: { transitionId?: string; singleUseNonce?: string; label?: string } = {}
): { confirmation: LocalMainSyncConfirmation; reference: TrustedAuthorizationReference } {
  const confirmation: LocalMainSyncConfirmation = {
    schemaVersion: 1,
    kind: 'OES_LOCAL_MAIN_SYNC_CONFIRMATION',
    confirmationFingerprint: '',
    status: 'ISSUED',
    ownerTaskId: trust.ownerTaskId,
    transitionId: overrides.transitionId ?? trust.profileTransitionId,
    action: 'sync',
    repositoryRoot: realpathSync(repositoryRoot),
    remote: 'origin',
    branch: 'main',
    expectedRemoteUrl,
    expectedRemoteMainSha,
    singleUseNonce: overrides.singleUseNonce ?? 'd'.repeat(64)
  }
  confirmation.confirmationFingerprint = objectFingerprint(
    confirmation as unknown as Record<string, unknown>,
    'confirmationFingerprint'
  )
  const path = join(trust.authorizationRoot, `${overrides.label ?? 'local-main-confirmation'}.json`)
  writeFileSync(path, `${canonicalJson(confirmation)}\n`)
  return {
    confirmation,
    reference: {
      path,
      sha256: sha256(readFileSync(path)),
      fingerprint: confirmation.confirmationFingerprint
    }
  }
}

/** Creates one profile-derived trust context for local-main unit fixtures. */
function trustFixture(root: string): RemoteTrustRoots {
  const authorizationRoot = join(root, 'trusted')
  const admissionRoot = join(root, 'admission')
  mkdirSync(authorizationRoot, { recursive: true })
  mkdirSync(admissionRoot, { recursive: true })
  return {
    projectKey: 'oes',
    authorizationRoot,
    admissionRoot,
    profilePath: join(root, 'profile.toml'),
    profileSha256: 'a'.repeat(64),
    ownerTaskId: '/root/do/local-main',
    profileTransitionId: 'local-main-sync:1',
    profileExpectedState: 'DELIVERY_ACTIVE'
  }
}

test('dirty, diverged, non-main, or active-operation checkout never exposes a sync card', () => {
  const base: LocalMainObservation = {
    repositoryRoot: '/fixture',
    branch: 'main',
    clean: true,
    operationMarkers: [],
    remoteUrl: '/fixture/remote.git',
    localMainSha: 'a'.repeat(40),
    remoteMainSha: 'b'.repeat(40),
    ahead: 0,
    behind: 1
  }
  assert.equal(
    evaluateLocalMainObservation(base, base.remoteMainSha, base.remoteUrl).status,
    'SYNC_ELIGIBLE'
  )
  for (const changed of [
    { ...base, branch: 'codex/delivery/other' },
    { ...base, clean: false },
    { ...base, operationMarkers: ['MERGE_HEAD'] },
    { ...base, remoteUrl: '/fixture/changed.git' },
    { ...base, ahead: 1, behind: 1 }
  ])
    assert.equal(
      evaluateLocalMainObservation(changed, base.remoteMainSha, base.remoteUrl).status,
      'PRESERVE_NO_CARD'
    )
})

test('exact CLAIMED recovery and an interrupted temporary claim remain idempotent', () => {
  for (const mode of ['exact-claimed', 'orphan-temporary'] as const) {
    const root = mkdtempSync(join(tmpdir(), `oes-local-main-${mode}-`))
    const project = join(root, 'project')
    mkdirSync(project)
    const trust = trustFixture(join(root, 'runtime-trust'))
    const oldSha = 'a'.repeat(40)
    const newSha = 'b'.repeat(40)
    const remoteUrl = join(root, 'remote.git')
    const proof = confirmationFixture(trust, project, remoteUrl, newSha)
    const binding = seal({
      schemaVersion: 1,
      kind: 'OES_LOCAL_MAIN_SYNC_BINDING',
      action: 'sync',
      repositoryRoot: realpathSync(project),
      remote: 'origin',
      branch: 'main',
      expectedRemoteUrl: remoteUrl,
      expectedRemoteMainSha: newSha,
      ownerTaskId: proof.confirmation.ownerTaskId,
      transitionId: proof.confirmation.transitionId,
      singleUseNonce: proof.confirmation.singleUseNonce,
      humanConfirmationFingerprint: proof.confirmation.confirmationFingerprint,
      confirmation: proof.reference
    })
    const checkpointIdentity = sha256(
      canonicalJson({
        ownerTaskId: proof.confirmation.ownerTaskId,
        singleUseNonce: proof.confirmation.singleUseNonce
      })
    )
    const checkpointRoot = join(trust.admissionRoot, 'local-main-sync')
    const checkpointPath = join(checkpointRoot, `${checkpointIdentity}.json`)
    mkdirSync(checkpointRoot, { recursive: true })
    if (mode === 'exact-claimed') {
      const claim = {
        schemaVersion: 1,
        kind: 'OES_LOCAL_MAIN_SYNC_CHECKPOINT',
        checkpointFingerprint: '',
        confirmationFingerprint: proof.confirmation.confirmationFingerprint,
        ownerTaskId: proof.confirmation.ownerTaskId,
        transitionId: proof.confirmation.transitionId,
        singleUseNonce: proof.confirmation.singleUseNonce,
        phase: 'CLAIMED',
        before: null,
        after: null
      }
      claim.checkpointFingerprint = objectFingerprint(
        claim as unknown as Record<string, unknown>,
        'checkpointFingerprint'
      )
      writeFileSync(checkpointPath, `${canonicalJson(claim)}\n`)
    } else writeFileSync(`${checkpointPath}.interrupted.tmp`, '{partial')

    class ClaimRecoveryRunner implements LocalCommandRunner {
      calls: string[] = []
      merged = false
      run(command: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
        const call = `${command} ${args.join(' ')}`
        this.calls.push(call)
        if (call === 'git branch --show-current')
          return { stdout: 'main\n', stderr: '', exitCode: 0 }
        if (call === 'git status --porcelain') return { stdout: '', stderr: '', exitCode: 0 }
        if (call === 'git remote get-url origin')
          return { stdout: `${remoteUrl}\n`, stderr: '', exitCode: 0 }
        if (call === 'git rev-parse HEAD')
          return { stdout: `${this.merged ? newSha : oldSha}\n`, stderr: '', exitCode: 0 }
        if (call === 'git rev-parse refs/remotes/origin/main')
          return { stdout: `${newSha}\n`, stderr: '', exitCode: 0 }
        if (call === 'git rev-list --left-right --count HEAD...refs/remotes/origin/main')
          return { stdout: this.merged ? '0 0\n' : '0 1\n', stderr: '', exitCode: 0 }
        if (args[0] === 'rev-parse' && args[1] === '--git-path')
          return {
            stdout: `${join(project, '.git', args[2] as string)}\n`,
            stderr: '',
            exitCode: 0
          }
        if (call === 'git fetch --no-tags origin main')
          return { stdout: '', stderr: '', exitCode: 0 }
        if (call === 'git merge --ff-only refs/remotes/origin/main') {
          this.merged = true
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: `unexpected ${call}`, exitCode: 99 }
      }
    }
    const runner = new ClaimRecoveryRunner()
    assert.equal(new LocalMainController(runner).sync(binding, trust).status, 'SYNCED')
    assert.equal(runner.calls.filter((call) => call.startsWith('git fetch ')).length, 1)
    assert.equal(runner.calls.filter((call) => call.startsWith('git merge ')).length, 1)
    const stored = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { phase: string }
    assert.equal(stored.phase, 'COMPLETED')
  }
})

test('confirmed ff-only sync updates only designated main and preserves another DO worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-local-main-test-'))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const project = join(root, 'project')
  const publisher = join(root, 'publisher')
  const delivery = join(root, 'delivery-worktree')
  git(root, 'init', '--bare', remote)
  git(root, 'init', '--initial-branch=main', seed)
  git(seed, 'config', 'user.email', 'fixture@example.test')
  git(seed, 'config', 'user.name', 'Fixture')
  writeFileSync(join(seed, 'value.txt'), 'one\n')
  git(seed, 'add', 'value.txt')
  git(seed, 'commit', '-m', 'initial')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-u', 'origin', 'main')
  git(root, 'clone', '--branch', 'main', remote, project)
  git(project, 'worktree', 'add', '-b', 'codex/delivery/other', delivery, 'HEAD')
  const deliveryHead = git(delivery, 'rev-parse', 'HEAD')

  git(root, 'clone', '--branch', 'main', remote, publisher)
  git(publisher, 'config', 'user.email', 'fixture@example.test')
  git(publisher, 'config', 'user.name', 'Fixture')
  writeFileSync(join(publisher, 'value.txt'), 'two\n')
  git(publisher, 'add', 'value.txt')
  git(publisher, 'commit', '-m', 'remote advance')
  git(publisher, 'push', 'origin', 'main')
  git(project, 'fetch', '--no-tags', 'origin', 'main')
  const remoteMainSha = git(project, 'rev-parse', 'refs/remotes/origin/main')

  const controller = new LocalMainController(new SpawnCommandRunner())
  const inspect = seal({
    schemaVersion: 1,
    kind: 'OES_LOCAL_MAIN_SYNC_BINDING',
    action: 'inspect',
    repositoryRoot: realpathSync(project),
    remote: 'origin',
    branch: 'main',
    expectedRemoteUrl: git(project, 'remote', 'get-url', 'origin'),
    expectedRemoteMainSha: remoteMainSha,
    ownerTaskId: null,
    transitionId: null,
    singleUseNonce: null,
    humanConfirmationFingerprint: null,
    confirmation: null
  })
  assert.equal(controller.inspect(inspect).status, 'SYNC_ELIGIBLE')

  const trust = trustFixture(join(root, 'runtime-trust'))
  const proof = confirmationFixture(
    trust,
    project,
    inspect.expectedRemoteUrl,
    inspect.expectedRemoteMainSha
  )
  const sync = seal({
    ...inspect,
    action: 'sync',
    ownerTaskId: proof.confirmation.ownerTaskId,
    transitionId: proof.confirmation.transitionId,
    singleUseNonce: proof.confirmation.singleUseNonce,
    humanConfirmationFingerprint: proof.confirmation.confirmationFingerprint,
    confirmation: proof.reference
  })
  const result = controller.sync(sync, trust)
  assert.equal(result.status, 'SYNCED')
  assert.equal(git(project, 'rev-parse', 'HEAD'), remoteMainSha)
  assert.equal(git(project, 'status', '--porcelain'), '')
  assert.equal(git(delivery, 'rev-parse', 'HEAD'), deliveryHead)
  assert.equal(git(delivery, 'branch', '--show-current'), 'codex/delivery/other')

  const replay = controller.sync(sync, trust)
  assert.equal(replay.status, 'SYNCED')
  assert.equal(replay.after.localMainSha, remoteMainSha)

  const reboundTrust = { ...trust, profileTransitionId: 'local-main-sync:2' }
  const rebound = confirmationFixture(
    reboundTrust,
    project,
    inspect.expectedRemoteUrl,
    inspect.expectedRemoteMainSha,
    { label: 'local-main-confirmation-rebound' }
  )
  const reboundCalls: string[] = []
  const reboundController = new LocalMainController({
    run(command, args) {
      reboundCalls.push(`${command} ${args.join(' ')}`)
      return { stdout: '', stderr: '', exitCode: 0 }
    }
  })
  assert.throws(
    () =>
      reboundController.sync(
        seal({
          ...inspect,
          action: 'sync',
          ownerTaskId: rebound.confirmation.ownerTaskId,
          transitionId: rebound.confirmation.transitionId,
          singleUseNonce: rebound.confirmation.singleUseNonce,
          humanConfirmationFingerprint: rebound.confirmation.confirmationFingerprint,
          confirmation: rebound.reference
        }),
        reboundTrust
      ),
    /LOCAL_MAIN_CHECKPOINT_INVALID/
  )
  assert.deepEqual(reboundCalls, [])
})

test('caller-minted or drifted local-main confirmation fails before any Git command', () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-local-main-trust-'))
  const project = join(root, 'project')
  git(root, 'init', '--initial-branch=main', project)
  git(project, 'config', 'user.email', 'fixture@example.test')
  git(project, 'config', 'user.name', 'Fixture')
  writeFileSync(join(project, 'value.txt'), 'one\n')
  git(project, 'add', 'value.txt')
  git(project, 'commit', '-m', 'initial')
  git(project, 'remote', 'add', 'origin', join(root, 'remote.git'))
  git(root, 'init', '--bare', join(root, 'remote.git'))
  git(project, 'push', '-u', 'origin', 'main')
  const sha = git(project, 'rev-parse', 'HEAD')
  const remoteUrl = git(project, 'remote', 'get-url', 'origin')
  const trust = trustFixture(join(root, 'runtime-trust'))
  const proof = confirmationFixture(trust, project, remoteUrl, sha)
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_LOCAL_MAIN_SYNC_BINDING' as const,
    action: 'sync' as const,
    repositoryRoot: realpathSync(project),
    remote: 'origin' as const,
    branch: 'main' as const,
    expectedRemoteUrl: remoteUrl,
    expectedRemoteMainSha: sha,
    ownerTaskId: proof.confirmation.ownerTaskId,
    transitionId: proof.confirmation.transitionId,
    singleUseNonce: proof.confirmation.singleUseNonce,
    humanConfirmationFingerprint: proof.confirmation.confirmationFingerprint,
    confirmation: proof.reference
  }

  class RecordingRunner implements LocalCommandRunner {
    calls: string[] = []
    run(
      command: string,
      args: string[],
      _cwd: string
    ): { stdout: string; stderr: string; exitCode: number } {
      this.calls.push(`${command} ${args.join(' ')}`)
      return { stdout: '', stderr: '', exitCode: 0 }
    }
  }

  for (const changed of [
    { ...base, expectedRemoteUrl: `${remoteUrl}.changed` },
    { ...base, expectedRemoteMainSha: 'b'.repeat(40) },
    { ...base, humanConfirmationFingerprint: 'f'.repeat(64) }
  ]) {
    const runner = new RecordingRunner()
    assert.throws(() => new LocalMainController(runner).sync(seal(changed), trust))
    assert.deepEqual(runner.calls, [])
  }

  const stale = confirmationFixture(trust, project, remoteUrl, sha, {
    transitionId: 'local-main-sync:stale',
    label: 'local-main-confirmation-stale'
  })
  const staleRunner = new RecordingRunner()
  assert.throws(
    () =>
      new LocalMainController(staleRunner).sync(
        seal({
          ...base,
          transitionId: stale.confirmation.transitionId,
          singleUseNonce: stale.confirmation.singleUseNonce,
          humanConfirmationFingerprint: stale.confirmation.confirmationFingerprint,
          confirmation: stale.reference
        }),
        trust
      ),
    /LOCAL_MAIN_CONFIRMATION_TRANSITION_INVALID/
  )
  assert.deepEqual(staleRunner.calls, [])

  const alias = join(root, 'project-alias')
  symlinkSync(project, alias)
  const runner = new RecordingRunner()
  assert.throws(
    () => new LocalMainController(runner).sync(seal({ ...base, repositoryRoot: alias }), trust),
    /LOCAL_MAIN_CONFIRMATION_BINDING_MISMATCH/
  )
  assert.deepEqual(runner.calls, [])

  const callerMinted = seal({
    ...base,
    repositoryRoot: '/tmp/caller-selected-repository',
    expectedRemoteUrl: '/tmp/caller-selected-remote.git',
    expectedRemoteMainSha: 'a'.repeat(40),
    humanConfirmationFingerprint: 'f'.repeat(64),
    confirmation: {
      path: '/tmp/caller-minted-confirmation.json',
      sha256: 'e'.repeat(64),
      fingerprint: 'f'.repeat(64)
    }
  })
  const forgedRunner = new RecordingRunner()
  assert.throws(() => new LocalMainController(forgedRunner).sync(callerMinted, trust))
  assert.deepEqual(forgedRunner.calls, [])
})
