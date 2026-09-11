#!/usr/bin/env node
import { canonicalJson, readJson, writeJsonAtomic } from './canonical.ts'
import {
  loadTrustedCoordinationChildCleanupAuthorization,
  loadTrustedCoordinationCleanupAuthorization
} from './cleanup-binding.ts'
import { createCoordinationCleanupResultSet, planChildSelfCleanup } from './cleanup.ts'
import {
  loadTrustedCoordinationArchiveResults,
  loadTrustedCoordinationLifecycleInventory,
  loadTrustedCoordinationLifecycleRosterAuthority,
  planCoordinationLifecycle
} from './coordination-lifecycle.ts'
import { fail, RuntimeContractError, runtimeErrorResult } from './errors.ts'
import {
  loadRemoteTrustRootsFromProfileReport,
  verifyEffectiveProfileReport
} from './profile-preflight.ts'
import type {
  CleanupDiffEntry,
  CleanupResourceDecision,
  CompletedCleanupResource,
  CoordinationCleanupAuthorization,
  EffectiveProfileReport,
  ObservedCleanupResource,
  TrustedAuthorizationReference
} from './types.ts'

/** Returns the value following one required cleanup command flag. */
function flag(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index < 0 || index + 1 >= args.length) fail('CLI_ARGUMENT_REQUIRED', name)
  return args[index + 1]
}
/** Emits one canonical JSON cleanup result. */
function emit(value: unknown): void {
  process.stdout.write(`${canonicalJson(value)}\n`)
}

/** Executes only lifecycle disposal planning and verification; no delivery, PR, merge, CI, or product-write command is reachable. */
async function main(args: string[]): Promise<void> {
  const command = args[0]
  const report = verifyEffectiveProfileReport(
    readJson<EffectiveProfileReport>(flag(args, '--profile-report'))
  )
  const trust = loadRemoteTrustRootsFromProfileReport(report)
  if (command === 'cleanup-plan') {
    const { root, child } = loadTrustedCoordinationChildCleanupAuthorization(
      flag(args, '--authorization'),
      flag(args, '--child-authorization'),
      trust
    )
    const observations = readJson<ObservedCleanupResource[]>(flag(args, '--observed'))
    const completed = args.includes('--completed')
      ? readJson<CompletedCleanupResource[]>(flag(args, '--completed'))
      : []
    const plan = planChildSelfCleanup(root, child.ownerTaskId, observations, completed)
    writeJsonAtomic(flag(args, '--output'), plan)
    emit(plan)
    return
  }
  if (command === 'cleanup-verify') {
    const authorization = loadTrustedCoordinationCleanupAuthorization(
      flag(args, '--authorization'),
      trust
    )
    const childResults = readJson<Record<string, CleanupResourceDecision[]>>(
      flag(args, '--child-results')
    )
    const repositoryDiff = readJson<CleanupDiffEntry[]>(flag(args, '--repository-diff'))
    const result = createCoordinationCleanupResultSet(authorization, childResults, repositoryDiff)
    writeJsonAtomic(flag(args, '--output'), result)
    emit(result)
    return
  }
  if (command === 'coordination-lifecycle-plan') {
    const cleanup = loadTrustedCoordinationCleanupAuthorization(
      flag(args, '--authorization'),
      trust
    )
    const authority = loadTrustedCoordinationLifecycleRosterAuthority(
      readJson<TrustedAuthorizationReference>(flag(args, '--roster-authority')),
      cleanup,
      trust
    )
    const inventory = loadTrustedCoordinationLifecycleInventory(
      readJson<TrustedAuthorizationReference>(flag(args, '--inventory')),
      authority,
      cleanup,
      trust
    )
    const prior = args.includes('--prior-results')
      ? loadTrustedCoordinationArchiveResults(
          readJson<TrustedAuthorizationReference>(flag(args, '--prior-results')),
          inventory,
          cleanup,
          trust
        )
      : []
    const plan = planCoordinationLifecycle(authority, inventory, prior)
    if (args.includes('--output')) writeJsonAtomic(flag(args, '--output'), plan)
    emit(plan)
    return
  }
  fail('CLEANUP_CLI_COMMAND_UNKNOWN', command ?? 'NONE')
}
main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${canonicalJson(runtimeErrorResult(error))}\n`)
  process.exitCode = error instanceof RuntimeContractError ? 2 : 1
})
