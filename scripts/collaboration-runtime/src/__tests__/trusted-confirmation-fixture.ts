import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import {
  createDecisionCard,
  createHumanConfirmationReceipt,
  loadTrustedDecisionConfirmation,
  type DecisionCardInput,
  type TrustedDecisionConfirmation
} from '../confirmation.ts'
import type { RemoteTrustRoots, TrustedAuthorizationReference } from '../types.ts'
import { stableOwnerTaskTempLeaf } from '../resource-topology.ts'
import type { OwnerResourceBinding } from '../resource-topology.types.ts'

export const deliveryDecisionInput = (
  overrides: Partial<DecisionCardInput> = {}
): DecisionCardInput => ({
  projectKey: 'oes',
  decisionKind: 'DELIVERY',
  objective: 'Deliver the confirmed collaboration change',
  ownerTopology: 'ONE_DO',
  executionMode: 'REPOSITORY',
  scope: ['collaboration runtime'],
  protectedScope: ['product behavior'],
  acceptance: ['confirmed behavior is preserved'],
  integrationContract: [],
  risk: 'MEDIUM',
  designImpact: 'NONE',
  coupling: 'COHESIVE',
  prTopology: 'ONE_DO_PR',
  approvedCiLevel: 'FULL',
  stopPoint: 'terminal delivery disposal',
  ...overrides
})

export function persistTrustedConfirmation(
  input: DecisionCardInput = deliveryDecisionInput(),
  authorizationRoot = mkdtempSync(join(tmpdir(), 'oes-decision-confirmation-test-'))
): { confirmation: TrustedDecisionConfirmation; authorizationRoot: string } {
  mkdirSync(authorizationRoot, { recursive: true })
  const card = createDecisionCard(input)
  const cardPath = join(authorizationRoot, 'decision-card.json')
  const cardBytes = `${canonicalJson(card)}\n`
  writeFileSync(cardPath, cardBytes)
  const cardReference: TrustedAuthorizationReference = {
    path: cardPath,
    sha256: sha256(cardBytes),
    fingerprint: card.cardFingerprint
  }
  const receipt = createHumanConfirmationReceipt({
    projectKey: card.projectKey,
    confirmedAt: '2026-09-11T00:00:00.000Z',
    card: cardReference
  })
  const receiptPath = join(authorizationRoot, 'human-confirmation.json')
  const receiptBytes = `${canonicalJson(receipt)}\n`
  writeFileSync(receiptPath, receiptBytes)
  const reference: TrustedAuthorizationReference = {
    path: receiptPath,
    sha256: sha256(receiptBytes),
    fingerprint: receipt.confirmationFingerprint
  }
  return {
    confirmation: loadTrustedDecisionConfirmation(reference, authorizationRoot),
    authorizationRoot
  }
}

export function fixtureTrust(authorizationRoot: string): RemoteTrustRoots {
  mkdirSync(authorizationRoot, { recursive: true })
  authorizationRoot = realpathSync(authorizationRoot)
  const ownerTaskId = '/root/do-runtime'
  const ownerClone = join(authorizationRoot, 'owner')
  const artifactRoot = join(authorizationRoot, 'artifacts')
  mkdirSync(ownerClone, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })
  const binding: OwnerResourceBinding = {
    schemaVersion: 1,
    kind: 'OES_OWNER_RESOURCE_BINDING',
    bindingFingerprint: '',
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerTaskId,
    directParentTaskId: '/root',
    transitionId: 'delivery:test:1',
    repositoryRoot: ownerClone,
    repositoryRemoteUrl: 'https://github.com/example/oes.git',
    ownerClone,
    ownerGitDirectory: join(ownerClone, '.git'),
    ownerRef: 'refs/heads/codex/delivery/runtime',
    artifactRoot,
    taskTempRoot: `/private/tmp/${stableOwnerTaskTempLeaf(ownerTaskId)}`,
    deliveryPackagePath: join(artifactRoot, 'delivery-package.json'),
    currentEvidenceManifestPath: join(artifactRoot, 'current.json'),
    checkpointBundlePath: join(artifactRoot, 'checkpoint.json'),
    gitBundlePath: join(artifactRoot, 'owner.bundle')
  }
  binding.bindingFingerprint = objectFingerprint(
    binding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  const bindingPath = join(authorizationRoot, 'owner-resource-binding.json')
  const bindingBytes = `${canonicalJson(binding)}\n`
  writeFileSync(bindingPath, bindingBytes)
  return {
    projectKey: 'oes',
    authorizationRoot,
    admissionRoot: join(authorizationRoot, 'admission'),
    profilePath: join(authorizationRoot, 'profile.toml'),
    profileSha256: 'a'.repeat(64),
    ownerTaskId,
    profileTransitionId: 'delivery:test:1',
    profileExpectedState: 'DELIVERY_ACTIVE',
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerResourceBinding: {
      path: bindingPath,
      sha256: sha256(bindingBytes),
      fingerprint: binding.bindingFingerprint
    }
  }
}
