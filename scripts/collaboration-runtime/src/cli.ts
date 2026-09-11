#!/usr/bin/env node
import { loadRemoteBinding } from './binding.ts'
import { canonicalJson, readJson, writeJsonAtomic } from './canonical.ts'
import { assessDrift, createEvidenceKey } from './evidence.ts'
import { RuntimeContractError, fail, runtimeErrorResult } from './errors.ts'
import { GitHubRemoteAdapter, SpawnCommandRunner } from './github-adapter.ts'
import { LocalMainController, type LocalMainSyncBinding } from './local-main.ts'
import { proposalQueueView, type ProposalHistoryEvent } from './proposal-queue.ts'
import { renderOwnerProfileLaunch, type OwnerProfileRenderRequest } from './profile-policy.ts'
import {
  SystemPreflightProbeAdapter,
  finalizeEffectiveProfilePreflight,
  loadRemoteTrustRootsFromProfileReport,
  runEffectiveProfileProbePhase,
  verifyEffectiveProfileReport,
  type PreflightRequest,
  type SystemProbeOptions
} from './profile-preflight.ts'
import { validateJsonSchema } from './schema-validation.ts'
import {
  createAggregateRvInput,
  loadAggregateDeliveryPackageReference,
  renderPackagePrSummary,
  validateAggregateDeliveryPackage,
  validateAggregateRvInput,
  validateDeliveryPackage
} from './delivery-package.ts'
import {
  loadTrustedCoordinationIntegrationAuthorization,
  loadTrustedCoordinationIntegrationResults,
  planCoordinationIntegration
} from './coordination-integration.ts'
import { RemoteDriver } from './remote-driver.ts'
import { decideRouting, type RoutingDecisionInput } from './routing.ts'
import {
  createVerificationTopology,
  type VerificationTopologyInput
} from './verification-topology.ts'
import {
  CiRecoveryController,
  FileCiRecoveryReceiptStore,
  type CiRecoveryInput
} from './retry-policy.ts'
import {
  assessContinuation,
  createDecisionCard,
  loadTrustedDecisionConfirmation,
  type ContinuationAssessmentInput,
  type DecisionCardInput
} from './confirmation.ts'
import { executionCapabilities, type ExecutionStage } from './capabilities.ts'
import { decideDaReplan, decideDoIssue, type DaReplanInput, type DoIssueInput } from './replan.ts'
import { FileUdBindingStore } from './ud-binding.ts'
import { FileReviewSessionStore, type ReviewSessionInput } from './review-session.ts'
import { planDeliveryLifecycle, type DeliveryLifecycleInput } from './delivery-lifecycle.ts'
import type {
  DriftAssessmentInput,
  EffectiveProfileReport,
  EvidenceKeyInput,
  TrustedAuthorizationReference
} from './types.ts'

/** Returns the value following one required command-line flag. */
function flag(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) fail('CLI_ARGUMENT_REQUIRED', name)
  return args[index + 1]
}

/** Emits one deterministic JSON value for machine consumption. */
function emit(value: unknown): void {
  process.stdout.write(`${canonicalJson(value)}\n`)
}

/** Reopens one controller-owned Human confirmation through the verified owner profile. */
function trustedConfirmation(args: string[]) {
  const profileReport = verifyEffectiveProfileReport(
    readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
  )
  const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
  return loadTrustedDecisionConfirmation(
    readJson<TrustedAuthorizationReference>(flag(args, '--confirmation')),
    trust.authorizationRoot
  )
}

/** Runs one collaboration-runtime subcommand. */
async function main(args: string[]): Promise<void> {
  const command = args[0]
  if (command === 'capabilities') {
    const stage = flag(args, '--stage') as ExecutionStage
    const capabilities = executionCapabilities(stage)
    if (!capabilities.length) fail('EXECUTION_STAGE_INVALID', stage)
    emit({ stage, capabilities })
    return
  }
  if (command === 'confirmation-card') {
    emit(createDecisionCard(readJson<DecisionCardInput>(flag(args, '--input'))))
    return
  }
  if (command === 'continuation') {
    const input = readJson<Omit<ContinuationAssessmentInput, 'confirmation'>>(flag(args, '--input'))
    emit(assessContinuation({ ...input, confirmation: trustedConfirmation(args) }))
    return
  }
  if (command === 'replan') {
    emit(decideDoIssue(readJson<DoIssueInput>(flag(args, '--input'))))
    return
  }
  if (command === 'da-replan') {
    const input = readJson<Omit<DaReplanInput, 'confirmation'>>(flag(args, '--input'))
    emit(decideDaReplan({ ...input, confirmation: trustedConfirmation(args) }))
    return
  }
  if (command === 'ud-binding-read') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    emit({ binding: new FileUdBindingStore(trust).read(flag(args, '--project')) })
    return
  }
  if (command === 'rv-session-read') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    emit({
      session: new FileReviewSessionStore(trust).read(flag(args, '--delivery'))
    })
    return
  }
  if (command === 'rv-session-bind') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    const input = readJson<{
      current: ReviewSessionInput
      expectedFingerprint: string | null
    }>(flag(args, '--input'))
    emit(new FileReviewSessionStore(trust).bind(input.current, input.expectedFingerprint))
    return
  }
  if (command === 'delivery-lifecycle-plan') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    emit(planDeliveryLifecycle(readJson<DeliveryLifecycleInput>(flag(args, '--input')), trust))
    return
  }
  if (command === 'route') {
    const input = readJson<Omit<RoutingDecisionInput, 'confirmation'>>(flag(args, '--input'))
    emit(
      decideRouting({
        ...input,
        confirmation: args.includes('--confirmation') ? trustedConfirmation(args) : null
      })
    )
    return
  }
  if (command === 'verification-plan') {
    const input = readJson<Omit<VerificationTopologyInput, 'confirmation'>>(flag(args, '--input'))
    emit(createVerificationTopology({ ...input, confirmation: trustedConfirmation(args) }))
    return
  }
  if (command === 'validate-binding') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    const binding = loadRemoteBinding(flag(args, '--binding'), trust)
    emit({
      status: 'BINDING_VALID',
      bindingFingerprint: binding.bindingFingerprint,
      action: binding.action
    })
    return
  }
  if (command === 'remote') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    const binding = loadRemoteBinding(flag(args, '--binding'), trust)
    emit(await new RemoteDriver(new GitHubRemoteAdapter(), trust).run(binding))
    return
  }
  if (command === 'profile-preflight-probe') {
    const input = readJson<{
      request: PreflightRequest
      systemProbe: SystemProbeOptions
      draftPath: string
    }>(flag(args, '--input'))
    emit(
      await runEffectiveProfileProbePhase(
        input.request,
        new SystemPreflightProbeAdapter(input.systemProbe),
        input.draftPath
      )
    )
    return
  }
  if (command === 'profile-preflight-finalize') {
    const input = readJson<{
      request: PreflightRequest
      systemProbe: SystemProbeOptions
      draftPath: string
    }>(flag(args, '--input'))
    emit(
      await finalizeEffectiveProfilePreflight(
        input.request,
        new SystemPreflightProbeAdapter(input.systemProbe),
        input.draftPath
      )
    )
    return
  }
  if (command === 'profile-render') {
    emit(renderOwnerProfileLaunch(readJson<OwnerProfileRenderRequest>(flag(args, '--input'))))
    return
  }
  if (command === 'schema-validate') {
    const schema = readJson<Record<string, unknown>>(flag(args, '--schema'))
    const value = readJson<unknown>(flag(args, '--input'))
    validateJsonSchema(schema, value)
    emit({ status: 'SCHEMA_VALID' })
    return
  }
  if (command === 'profile-verify') {
    const report = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--report'))
    )
    emit({
      status: 'PROFILE_VERIFIED',
      ownerTaskId: report.ownerTaskId,
      schemaVersion: report.schemaVersion,
      approvalMode: report.approvalMode,
      normalPermissionPromptCount: 0
    })
    return
  }
  if (command === 'evidence-key') {
    const key = createEvidenceKey(readJson<EvidenceKeyInput>(flag(args, '--input')))
    const output = flag(args, '--output')
    writeJsonAtomic(output, key)
    emit(key)
    return
  }
  if (command === 'affected-tests') {
    const assessment = assessDrift(readJson<DriftAssessmentInput>(flag(args, '--input')))
    const output = flag(args, '--output')
    writeJsonAtomic(output, assessment)
    emit(assessment)
    return
  }
  if (command === 'ud-queue-view') {
    const input = readJson<{
      history: ProposalHistoryEvent[]
      audience: 'EXACT_UD' | 'PROJECT_ROLE' | 'BOUNDED_HELPER'
    }>(flag(args, '--input'))
    emit(proposalQueueView(input.history, input.audience))
    return
  }
  if (command === 'ci-recovery-decision') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    emit(
      new CiRecoveryController(new FileCiRecoveryReceiptStore(trust.admissionRoot), trust).decide(
        readJson<CiRecoveryInput>(flag(args, '--input'))
      )
    )
    return
  }
  if (command === 'local-main') {
    const binding = readJson<LocalMainSyncBinding>(flag(args, '--binding'))
    const controller = new LocalMainController(new SpawnCommandRunner())
    if (binding.action === 'inspect') emit(controller.inspect(binding))
    else {
      const profileReport = verifyEffectiveProfileReport(
        readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
      )
      const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
      emit(controller.sync(binding, trust))
    }
    return
  }
  if (command === 'coordination-integration-plan') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    const { authorization, repositoryRoot } = loadTrustedCoordinationIntegrationAuthorization(
      readJson<TrustedAuthorizationReference>(flag(args, '--authorization')),
      trust
    )
    const results = loadTrustedCoordinationIntegrationResults(
      readJson<TrustedAuthorizationReference>(flag(args, '--results')),
      authorization,
      trust
    )
    emit(
      planCoordinationIntegration(authorization, results, repositoryRoot, new SpawnCommandRunner())
    )
    return
  }
  if (command === 'delivery-package-validate') {
    const value = readJson<Record<string, unknown>>(flag(args, '--package'))
    const packageValue =
      value.kind === 'OES_DELIVERY_PACKAGE'
        ? validateDeliveryPackage(value as never)
        : validateAggregateDeliveryPackage(value as never)
    emit({
      status: 'PACKAGE_VALID',
      kind: packageValue.kind,
      packageFingerprint: packageValue.packageFingerprint
    })
    return
  }
  if (command === 'delivery-package-summary') {
    const value = readJson<Record<string, unknown>>(flag(args, '--package'))
    emit({
      summary: renderPackagePrSummary(
        value.kind === 'OES_DELIVERY_PACKAGE'
          ? validateDeliveryPackage(value as never)
          : validateAggregateDeliveryPackage(value as never)
      )
    })
    return
  }
  if (command === 'aggregate-rv-input') {
    const profileReport = verifyEffectiveProfileReport(
      readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
    )
    const trust = loadRemoteTrustRootsFromProfileReport(profileReport)
    const reference = readJson<TrustedAuthorizationReference>(flag(args, '--package-reference'))
    const aggregate = loadAggregateDeliveryPackageReference(reference, trust.authorizationRoot)
    const input = createAggregateRvInput(reference, aggregate)
    if (args.includes('--existing'))
      validateAggregateRvInput(
        readJson<Record<string, unknown>>(flag(args, '--existing')) as never,
        reference,
        aggregate
      )
    emit(input)
    return
  }
  fail('CLI_COMMAND_UNKNOWN', command ?? 'NONE')
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${canonicalJson(runtimeErrorResult(error))}\n`)
  process.exitCode = error instanceof RuntimeContractError ? 2 : 1
})
