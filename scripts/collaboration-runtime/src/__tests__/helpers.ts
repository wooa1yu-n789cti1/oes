import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after } from 'node:test'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import type {
  RemoteActionAuthorization,
  RemoteAuthorizationRoot,
  RemoteDriverBinding,
  RemoteTrustRoots,
  CoordinationChildCleanupAuthorization,
  CoordinationCleanupAuthorization,
  TerminalCoordinationCleanup
} from '../types.ts'
import type { OwnerResourceReference } from '../resource-topology.types.ts'
import {
  loadTrustedCoordinationChildCleanupAuthorization,
  loadTrustedCoordinationCleanupAuthorization
} from '../cleanup-binding.ts'

const trustByBinding = new WeakMap<RemoteDriverBinding, RemoteTrustRoots>()
const cleanupTrustByAuthorization = new WeakMap<
  CoordinationCleanupAuthorization,
  RemoteTrustRoots
>()
const fixtureRoots = new Set<string>()

/** Creates and registers one process-owned temporary fixture root for terminal cleanup. */
function fixtureTempDir(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  fixtureRoots.add(root)
  return root
}

after(() => {
  for (const root of [...fixtureRoots].sort((left, right) => right.length - left.length))
    rmSync(root, { recursive: true, force: true })
  fixtureRoots.clear()
})

/** Returns the fixture trust context separately from the untrusted binding. */
export function remoteTrust(binding: RemoteDriverBinding): RemoteTrustRoots {
  const trust = trustByBinding.get(binding)
  if (!trust) throw new Error('fixture trust context absent')
  return trust
}

/** Returns the protected-root fixture context used to reopen one cleanup authorization. */
export function cleanupTrust(value: CoordinationCleanupAuthorization): RemoteTrustRoots {
  const trust = cleanupTrustByAuthorization.get(value)
  if (!trust) throw new Error('cleanup fixture trust context absent')
  return trust
}

/** Reissues a fixture action authorization and seals the exact binding against it. */
export function authorizeRemoteBinding(binding: RemoteDriverBinding): RemoteDriverBinding {
  const authorizationRoot = fixtureTempDir('oes-remote-authorization-test-')
  const admissionRoot = fixtureTempDir('oes-remote-admission-test-')
  if (binding.admission?.mode === 'serial-latest-main')
    binding.admission.lockPath = join(admissionRoot, 'latest-main.lock')
  const rootRecord: RemoteAuthorizationRoot = {
    schemaVersion: 1,
    kind: 'OES_REMOTE_AUTHORIZATION_ROOT',
    recordFingerprint: '',
    status: 'ACTIVE',
    issuerTaskId: '/root/fixture-authority',
    owner: binding.owner,
    expectedState: binding.expectedState,
    stateVersion: binding.stateVersion,
    transitionId: binding.transitionId,
    rootConfirmationFingerprint: 'e'.repeat(64),
    scopeFingerprint: binding.scopeFingerprint,
    truthBaseline: binding.truthBaseline,
    repositoryRoot: binding.repositoryRoot,
    repositorySlug: binding.repositorySlug,
    artifactRoot: binding.artifactRoot,
    allowedActions: [binding.action],
    mergeAuthorizationFingerprint: binding.mergeAuthorizationFingerprint,
    cleanupAuthorizationFingerprint: binding.cleanupAuthorizationFingerprint,
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerResourceBinding: binding.ownerResourceBinding
  }
  rootRecord.recordFingerprint = objectFingerprint(
    rootRecord as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  const rootPath = join(authorizationRoot, 'root-authorization.json')
  const rootBytes = `${canonicalJson(rootRecord)}\n`
  writeFileSync(rootPath, rootBytes)
  const resourceSetFingerprint = objectFingerprint(
    {
      checkpointPath: binding.checkpointPath,
      resultPath: binding.resultPath,
      invalidationPath: binding.invalidationPath,
      pullRequest: binding.pullRequest,
      admission: binding.admission ?? null,
      expectedMergeSha: binding.expectedMergeSha ?? null,
      resourceTopologyVersion: binding.resourceTopologyVersion,
      ownerResourceBinding: binding.ownerResourceBinding ?? null
    },
    '__none__'
  )
  const authority: RemoteActionAuthorization = {
    schemaVersion: 1,
    kind: 'OES_REMOTE_ACTION_AUTHORIZATION',
    authorizationFingerprint: '',
    status: 'ISSUED',
    issuedBeforeRemoteMutation: true,
    issuerTaskId: '/root/fixture-authority',
    rootAuthorization: {
      path: rootPath,
      sha256: sha256(rootBytes),
      fingerprint: String(rootRecord.recordFingerprint)
    },
    owner: binding.owner,
    expectedState: binding.expectedState,
    stateVersion: binding.stateVersion,
    transitionId: binding.transitionId,
    rootConfirmationFingerprint: 'e'.repeat(64),
    scopeFingerprint: binding.scopeFingerprint,
    truthBaseline: binding.truthBaseline,
    integrationBase: binding.integrationBase,
    candidateSha: binding.candidateSha,
    allowedAction: binding.action,
    repositoryRoot: binding.repositoryRoot,
    repositorySlug: binding.repositorySlug,
    artifactRoot: binding.artifactRoot,
    headRef: binding.headRef,
    baseRef: binding.baseRef,
    singleUseNonce: binding.singleUseNonce,
    resourceSetFingerprint,
    postcondition: 'FIXTURE_POSTCONDITION',
    mergeAuthorizationFingerprint: binding.mergeAuthorizationFingerprint,
    cleanupAuthorizationFingerprint: binding.cleanupAuthorizationFingerprint,
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerResourceBinding: binding.ownerResourceBinding
  }
  authority.authorizationFingerprint = objectFingerprint(
    authority as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  const authorityPath = join(authorizationRoot, 'action-authorization.json')
  const authorityBytes = `${canonicalJson(authority)}\n`
  writeFileSync(authorityPath, authorityBytes)
  binding.authorization = {
    path: authorityPath,
    sha256: sha256(authorityBytes),
    fingerprint: authority.authorizationFingerprint
  }
  binding.bindingFingerprint = objectFingerprint(
    binding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  trustByBinding.set(binding, {
    authorizationRoot,
    admissionRoot,
    profilePath: '/fixture/installed-profile.toml',
    profileSha256: 'a'.repeat(64),
    ownerTaskId: binding.owner.taskId,
    profileTransitionId: binding.transitionId,
    profileExpectedState: 'DELIVERY_ACTIVE',
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerResourceBinding: binding.ownerResourceBinding
  })
  return binding
}

/** Creates one valid V2 remote binding rooted in an owner-exclusive test clone. */
export function remoteBinding(overrides: Partial<RemoteDriverBinding> = {}): RemoteDriverBinding {
  const root = fixtureTempDir('oes-remote-owner-test-')
  const artifactRoot = fixtureTempDir('oes-remote-artifacts-test-')
  const base: RemoteDriverBinding = {
    schemaVersion: 1,
    kind: 'OES_REMOTE_DRIVER_BINDING',
    bindingFingerprint: '',
    authorization: { path: '/pending', sha256: '0'.repeat(64), fingerprint: '0'.repeat(64) },
    action: 'publish-pr',
    owner: { role: 'DO', taskId: '/root/do' },
    expectedState: 'LOCAL_REVIEW_PASSED',
    stateVersion: 3,
    transitionId: 'transition:3:publish',
    scopeFingerprint: 'd'.repeat(64),
    truthBaseline: '1'.repeat(40),
    integrationBase: '2'.repeat(40),
    candidateSha: '3'.repeat(40),
    repositoryRoot: root,
    repositorySlug: 'example/oes',
    artifactRoot,
    checkpointPath: '',
    resultPath: '',
    invalidationPath: '',
    singleUseNonce: 'nonce-1',
    headRef: 'codex/delivery/runtime',
    baseRef: 'main',
    pullRequest: {
      baseRef: 'main',
      draft: true,
      number: null,
      requiredChecks: ['Baseline Checks'],
      title: 'Runtime',
      body: 'Exact candidate'
    },
    mergeMethod: 'merge',
    ...overrides
  }
  const ownerBinding = {
    schemaVersion: 1 as const,
    kind: 'OES_OWNER_RESOURCE_BINDING' as const,
    bindingFingerprint: '',
    resourceTopologyVersion: 'owner-exclusive-v2' as const,
    ownerTaskId: base.owner.taskId,
    directParentTaskId: '/root/parent',
    transitionId: base.transitionId,
    repositoryRoot: base.repositoryRoot,
    repositoryRemoteUrl: `https://github.com/${base.repositorySlug}.git`,
    ownerClone: base.repositoryRoot,
    ownerGitDirectory: join(base.repositoryRoot, '.git'),
    ownerRef: `refs/heads/${base.headRef}`,
    artifactRoot: base.artifactRoot,
    taskTempRoot: `/private/tmp/oes-owner-${sha256(base.owner.taskId)}`,
    deliveryPackagePath: join(base.artifactRoot, 'delivery-package.json'),
    currentEvidenceManifestPath: join(base.artifactRoot, 'current.json'),
    checkpointBundlePath: join(base.artifactRoot, 'bundle.json'),
    gitBundlePath: join(base.artifactRoot, 'owner.bundle')
  }
  ownerBinding.bindingFingerprint = objectFingerprint(
    ownerBinding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  const ownerPath = join(base.artifactRoot, 'owner-resource-binding.json')
  const ownerBytes = `${canonicalJson(ownerBinding)}\n`
  writeFileSync(ownerPath, ownerBytes)
  base.resourceTopologyVersion = 'owner-exclusive-v2'
  base.ownerResourceBinding = {
    path: ownerPath,
    sha256: sha256(ownerBytes),
    fingerprint: ownerBinding.bindingFingerprint
  }
  const actionRoot = join(base.artifactRoot, 'remote-actions', base.action, base.singleUseNonce)
  base.checkpointPath = join(actionRoot, 'checkpoint.json')
  base.resultPath = join(actionRoot, 'result.json')
  base.invalidationPath = join(actionRoot, 'invalidated.json')
  return authorizeRemoteBinding(base)
}

/** Creates one valid V2 two-DO terminal cleanup authorization. */
export function cleanupAuthorization(): CoordinationCleanupAuthorization {
  const fixtureRoot = realpathSync(fixtureTempDir('oes-cleanup-owner-resources-'))
  const bindingReference = (
    key: string,
    ownerTaskId: string,
    ownerRef: string,
    ownerClone: string,
    artifactRoot: string,
    taskTempRoot: string
  ): OwnerResourceReference => {
    const binding = {
      schemaVersion: 1 as const,
      kind: 'OES_OWNER_RESOURCE_BINDING' as const,
      bindingFingerprint: '',
      resourceTopologyVersion: 'owner-exclusive-v2' as const,
      ownerTaskId,
      directParentTaskId: ownerTaskId === '/root/co' ? '/root' : '/root/co',
      transitionId: 'coordination:cleanup:1',
      repositoryRoot: ownerClone,
      repositoryRemoteUrl: 'https://github.com/example/oes.git',
      ownerClone,
      ownerGitDirectory: `${ownerClone}/.git`,
      ownerRef,
      artifactRoot,
      taskTempRoot,
      deliveryPackagePath: `${artifactRoot}/delivery-package.json`,
      currentEvidenceManifestPath: `${artifactRoot}/current.json`,
      checkpointBundlePath: `${artifactRoot}/checkpoint.json`,
      gitBundlePath: `${artifactRoot}/owner.bundle`
    }
    binding.bindingFingerprint = objectFingerprint(
      binding as unknown as Record<string, unknown>,
      'bindingFingerprint'
    )
    mkdirSync(artifactRoot, { recursive: true })
    const path = join(artifactRoot, 'owner-resource-binding.json')
    const bytes = `${canonicalJson(binding)}\n`
    writeFileSync(path, bytes)
    return { path, sha256: sha256(bytes), fingerprint: binding.bindingFingerprint }
  }
  const terminal = (key: string, suffix: string) => {
    const candidateSha = suffix.repeat(40)
    const ownerTaskId = `/root/co/do-${key}`
    const ownerClone = join(fixtureRoot, key, 'owner')
    const artifactRoot = join(fixtureRoot, key, 'artifacts')
    const taskTempRoot = `/private/tmp/oes-owner-${sha256(ownerTaskId)}`
    const ownerResourceBinding = bindingReference(
      key,
      ownerTaskId,
      `refs/heads/codex/delivery/${key}`,
      ownerClone,
      artifactRoot,
      taskTempRoot
    )
    return {
      deliveryKey: key,
      ownerTaskId,
      terminalState: 'MERGED' as const,
      candidateSha,
      mergeSha: String(Number(suffix) + 1).repeat(40),
      ownerResourceBinding,
      resources: [
        {
          kind: 'remote-branch' as const,
          path: `codex/delivery/${key}`,
          expectedSha: candidateSha
        },
        { kind: 'local-branch' as const, path: `codex/delivery/${key}`, expectedSha: candidateSha },
        {
          kind: 'worktree' as const,
          path: ownerClone,
          expectedSha: candidateSha
        },
        { kind: 'task-temp' as const, path: taskTempRoot, expectedSha: null },
        {
          kind: 'delivery-package' as const,
          path: `${artifactRoot}/delivery-package.json`,
          expectedSha: null
        }
      ]
    }
  }
  const value: CoordinationCleanupAuthorization = {
    schemaVersion: 2,
    kind: 'OES_COORDINATION_CLEANUP_AUTHORIZATION',
    authorizationFingerprint: '',
    status: 'ISSUED',
    expectedState: 'COORDINATION_CLEANUP_AUTHORIZED',
    stateVersion: 1,
    coordinationKey: 'release',
    coordinationOwnerTaskId: '/root/co',
    transitionId: 'coordination:cleanup:1',
    confirmationFingerprint: 'a'.repeat(64),
    terminalDeliveries: [terminal('alpha', '1'), terminal('beta', '3')],
    coordinationOwner: {
      ownerTaskId: '/root/co',
      terminalState: 'MERGED',
      candidateSha: '5'.repeat(40),
      mergeSha: '6'.repeat(40),
      ownerResourceBinding: bindingReference(
        'coordination',
        '/root/co',
        'refs/heads/codex/coordination/release',
        join(fixtureRoot, 'coordination', 'owner'),
        join(fixtureRoot, 'coordination', 'artifacts'),
        `/private/tmp/oes-owner-${sha256('/root/co')}`
      ),
      resources: [
        { kind: 'remote-branch', path: 'codex/coordination/release', expectedSha: '5'.repeat(40) },
        { kind: 'local-branch', path: 'codex/coordination/release', expectedSha: '5'.repeat(40) },
        {
          kind: 'worktree',
          path: join(fixtureRoot, 'coordination', 'owner'),
          expectedSha: '5'.repeat(40)
        },
        {
          kind: 'task-temp',
          path: `/private/tmp/oes-owner-${sha256('/root/co')}`,
          expectedSha: null
        },
        {
          kind: 'delivery-package',
          path: join(fixtureRoot, 'coordination', 'artifacts', 'delivery-package.json'),
          expectedSha: null
        }
      ]
    } satisfies TerminalCoordinationCleanup
  }
  value.authorizationFingerprint = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  return value
}

/** Reopens a cleanup fixture through the same current protected-record path used by the CLI. */
export function trustedCleanupAuthorization(
  value: CoordinationCleanupAuthorization = cleanupAuthorization()
): CoordinationCleanupAuthorization {
  const authorizationRoot = fixtureTempDir('oes-cleanup-authorization-root-')
  const rootPath = join(authorizationRoot, 'coordination-cleanup.json')
  const rootBytes = `${canonicalJson(value)}\n`
  writeFileSync(rootPath, rootBytes)
  const current = {
    schemaVersion: 2 as const,
    kind: 'OES_COORDINATION_CLEANUP_CURRENT_AUTHORIZATION' as const,
    recordFingerprint: '',
    status: 'ACTIVE' as const,
    purpose: 'COORDINATION_CLEANUP_VERIFY' as const,
    rootAuthorization: {
      path: rootPath,
      sha256: sha256(rootBytes),
      fingerprint: value.authorizationFingerprint
    },
    childAuthorization: null,
    coordinationKey: value.coordinationKey,
    coordinationOwnerTaskId: value.coordinationOwnerTaskId,
    ownerTaskId: value.coordinationOwnerTaskId,
    expectedState: value.expectedState,
    stateVersion: value.stateVersion,
    transitionId: value.transitionId,
    confirmationFingerprint: value.confirmationFingerprint,
    postcondition: 'CURRENT_COORDINATION_CLEANUP' as const
  }
  current.recordFingerprint = objectFingerprint(
    current as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  writeFileSync(
    join(authorizationRoot, 'current-coordination-cleanup.json'),
    `${canonicalJson(current)}\n`
  )
  const trust: RemoteTrustRoots = {
    authorizationRoot,
    admissionRoot: join(authorizationRoot, 'admission'),
    profilePath: join(authorizationRoot, 'profile.toml'),
    profileSha256: '9'.repeat(64),
    ownerTaskId: value.coordinationOwnerTaskId,
    profileTransitionId: value.transitionId,
    profileExpectedState: 'DELIVERY_ACTIVE'
  }
  const loaded = loadTrustedCoordinationCleanupAuthorization(rootPath, trust)
  cleanupTrustByAuthorization.set(loaded, trust)
  return loaded
}

/** Reopens one child cleanup fixture through exact current/root/child CAS references. */
export function trustedChildCleanupAuthorization(
  value: CoordinationCleanupAuthorization = cleanupAuthorization(),
  mutateChild?: (child: CoordinationChildCleanupAuthorization) => void
): { root: CoordinationCleanupAuthorization; child: CoordinationChildCleanupAuthorization } {
  const authorizationRoot = fixtureTempDir('oes-child-cleanup-authorization-root-')
  const rootPath = join(authorizationRoot, 'coordination-cleanup.json')
  const rootBytes = `${canonicalJson(value)}\n`
  writeFileSync(rootPath, rootBytes)
  const rootReference = {
    path: rootPath,
    sha256: sha256(rootBytes),
    fingerprint: value.authorizationFingerprint
  }
  const delivery = value.terminalDeliveries[0]
  const child: CoordinationChildCleanupAuthorization = {
    schemaVersion: 2,
    kind: 'OES_COORDINATION_CHILD_CLEANUP_AUTHORIZATION',
    authorizationFingerprint: '',
    status: 'ISSUED',
    rootAuthorization: structuredClone(rootReference),
    expectedState: value.expectedState,
    stateVersion: value.stateVersion,
    coordinationKey: value.coordinationKey,
    coordinationOwnerTaskId: value.coordinationOwnerTaskId,
    ownerTaskId: delivery.ownerTaskId,
    transitionId: value.transitionId,
    confirmationFingerprint: value.confirmationFingerprint,
    ownerResourceBinding: structuredClone(delivery.ownerResourceBinding),
    resources: structuredClone(delivery.resources),
    postcondition: 'CHILD_SELF_CLEANUP'
  }
  mutateChild?.(child)
  child.authorizationFingerprint = objectFingerprint(
    child as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  const childPath = join(authorizationRoot, 'child-cleanup.json')
  const childBytes = `${canonicalJson(child)}\n`
  writeFileSync(childPath, childBytes)
  const childReference = {
    path: childPath,
    sha256: sha256(childBytes),
    fingerprint: child.authorizationFingerprint
  }
  const current = {
    schemaVersion: 2 as const,
    kind: 'OES_COORDINATION_CLEANUP_CURRENT_AUTHORIZATION' as const,
    recordFingerprint: '',
    status: 'ACTIVE' as const,
    purpose: 'CHILD_SELF_CLEANUP' as const,
    rootAuthorization: rootReference,
    childAuthorization: childReference,
    coordinationKey: value.coordinationKey,
    coordinationOwnerTaskId: value.coordinationOwnerTaskId,
    ownerTaskId: delivery.ownerTaskId,
    expectedState: value.expectedState,
    stateVersion: value.stateVersion,
    transitionId: value.transitionId,
    confirmationFingerprint: value.confirmationFingerprint,
    postcondition: 'CURRENT_COORDINATION_CLEANUP' as const
  }
  current.recordFingerprint = objectFingerprint(
    current as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  writeFileSync(
    join(authorizationRoot, 'current-coordination-cleanup.json'),
    `${canonicalJson(current)}\n`
  )
  const trust: RemoteTrustRoots = {
    authorizationRoot,
    admissionRoot: join(authorizationRoot, 'admission'),
    profilePath: join(authorizationRoot, 'profile.toml'),
    profileSha256: '9'.repeat(64),
    ownerTaskId: delivery.ownerTaskId,
    profileTransitionId: value.transitionId,
    profileExpectedState: 'DELIVERY_ACTIVE'
  }
  return loadTrustedCoordinationChildCleanupAuthorization(rootPath, childPath, trust)
}
