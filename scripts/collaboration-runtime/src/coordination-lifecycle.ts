import { objectFingerprint } from './canonical.ts'
import { verifyTrustedReference } from './binding.ts'
import { validateCoordinationCleanupResultSet } from './cleanup.ts'
import { fail } from './errors.ts'
import type {
  RemoteTrustRoots,
  CoordinationArchiveDecision,
  CoordinationArchiveResult,
  CoordinationArchiveResultSet,
  CoordinationCleanupAuthorization,
  CoordinationCleanupResultSet,
  CoordinationLifecycleCreatedTask,
  CoordinationLifecycleInventory,
  CoordinationLifecyclePlan,
  CoordinationLifecycleTaskKind,
  CoordinationLifecycleRosterAuthority,
  CoordinationLifecycleTask,
  TrustedAuthorizationReference
} from './types.ts'

const DIGEST = /^[0-9a-f]{64}$/
const TASK_KINDS: CoordinationLifecycleTaskKind[] = ['BOUNDED_HELPER', 'RV', 'DO', 'CO']
const trustedAuthorities = new WeakSet<object>()
const trustedInventories = new WeakSet<object>()
const trustedResultSets = new WeakSet<object>()

/** Reopens the immutable CO-created roster from the profile-protected authorization root. */
export function loadTrustedCoordinationLifecycleRosterAuthority(
  reference: TrustedAuthorizationReference,
  cleanup: CoordinationCleanupAuthorization,
  trust: RemoteTrustRoots
): CoordinationLifecycleRosterAuthority {
  const value = validateCoordinationLifecycleRosterAuthority(
    verifyTrustedReference(
      reference,
      trust.authorizationRoot,
      'authorityFingerprint'
    ) as unknown as CoordinationLifecycleRosterAuthority
  )
  validateCleanupBinding(value, cleanup, trust)
  const frozen = deepFreeze(value)
  trustedAuthorities.add(frozen)
  return frozen
}

/** Reopens the current task-native roster and terminal-state readback. */
export function loadTrustedCoordinationLifecycleInventory(
  reference: TrustedAuthorizationReference,
  authority: CoordinationLifecycleRosterAuthority,
  cleanup: CoordinationCleanupAuthorization,
  trust: RemoteTrustRoots
): CoordinationLifecycleInventory {
  if (!trustedAuthorities.has(authority))
    fail('COORDINATION_LIFECYCLE_TRUSTED_AUTHORITY_REQUIRED', authority.coordinationKey)
  const value = validateCoordinationLifecycleInventory(
    authority,
    verifyTrustedReference(
      reference,
      trust.authorizationRoot,
      'inventoryFingerprint'
    ) as unknown as CoordinationLifecycleInventory
  )
  validateCleanupBinding(value, cleanup, trust)
  if (value.resourceCleanup === 'VERIFIED' && value.cleanupResult) {
    validateCoordinationCleanupResultSet(
      cleanup,
      verifyTrustedReference(
        value.cleanupResult,
        trust.authorizationRoot,
        'resultSetFingerprint'
      ) as unknown as CoordinationCleanupResultSet
    )
  }
  const frozen = deepFreeze(value)
  trustedInventories.add(frozen)
  return frozen
}

/** Reopens exact task-native archive results bound to the current cleanup inventory. */
export function loadTrustedCoordinationArchiveResults(
  reference: TrustedAuthorizationReference,
  inventory: CoordinationLifecycleInventory,
  cleanup: CoordinationCleanupAuthorization,
  trust: RemoteTrustRoots
): CoordinationArchiveResult[] {
  if (!trustedInventories.has(inventory))
    fail('COORDINATION_LIFECYCLE_TRUSTED_INVENTORY_REQUIRED', inventory.coordinationKey)
  const set = verifyTrustedReference(
    reference,
    trust.authorizationRoot,
    'resultSetFingerprint'
  ) as unknown as CoordinationArchiveResultSet
  if (
    set.schemaVersion !== 2 ||
    set.kind !== 'OES_COORDINATION_ARCHIVE_RESULT_SET' ||
    set.coordinationKey !== inventory.coordinationKey ||
    set.coordinationOwnerTaskId !== inventory.coordinationOwnerTaskId ||
    set.transitionId !== inventory.transitionId ||
    set.coordinationCleanupAuthorizationFingerprint !==
      inventory.coordinationCleanupAuthorizationFingerprint ||
    set.inventoryFingerprint !== inventory.inventoryFingerprint ||
    !Array.isArray(set.results)
  )
    fail('COORDINATION_ARCHIVE_RESULT_SET_BINDING_MISMATCH', inventory.coordinationKey)
  validateCleanupBinding(set, cleanup, trust)
  const results = deepFreeze(set.results)
  trustedResultSets.add(results)
  return results
}

/** Binds lifecycle evidence to the exact current cleanup authorization and CO profile. */
function validateCleanupBinding(
  value: {
    coordinationKey: string
    coordinationOwnerTaskId: string
    transitionId: string
    coordinationCleanupAuthorizationFingerprint: string
  },
  cleanup: CoordinationCleanupAuthorization,
  trust: RemoteTrustRoots
): void {
  if (
    cleanup.coordinationOwnerTaskId !== trust.ownerTaskId ||
    value.coordinationKey !== cleanup.coordinationKey ||
    value.coordinationOwnerTaskId !== cleanup.coordinationOwnerTaskId ||
    value.transitionId !== cleanup.transitionId ||
    value.coordinationCleanupAuthorizationFingerprint !== cleanup.authorizationFingerprint
  )
    fail('COORDINATION_LIFECYCLE_CLEANUP_BINDING_MISMATCH', value.coordinationKey)
}

/** Deep-freezes trusted evidence so its trust mark cannot survive caller mutation. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Validates the closed CO graph captured from task-native creation receipts. */
export function validateCoordinationLifecycleRosterAuthority(
  value: CoordinationLifecycleRosterAuthority
): CoordinationLifecycleRosterAuthority {
  if (
    value.schemaVersion !== 2 ||
    value.kind !== 'OES_COORDINATION_LIFECYCLE_ROSTER_AUTHORITY' ||
    !['TASK_NATIVE_CREATION_RECEIPTS', 'EXECUTION_NATIVE_CREATION_RECEIPTS'].includes(value.source) ||
    !value.coordinationKey ||
    !value.coordinationOwnerTaskId ||
    !value.transitionId ||
    !DIGEST.test(value.coordinationCleanupAuthorizationFingerprint) ||
    !Array.isArray(value.createdRoster) ||
    value.createdRoster.length < 4
  )
    fail('COORDINATION_LIFECYCLE_ROSTER_AUTHORITY_INVALID', value.coordinationKey)
  const tasks = indexRoster(value.createdRoster)
  validateCoordinationTopology(value.coordinationOwnerTaskId, value.createdRoster, tasks)
  const expected = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'authorityFingerprint'
  )
  if (!DIGEST.test(value.authorityFingerprint) || value.authorityFingerprint !== expected)
    fail('COORDINATION_LIFECYCLE_ROSTER_AUTHORITY_FINGERPRINT_MISMATCH', value.coordinationKey)
  return value
}

/** Validates a current task-native readback against the immutable creation roster. */
export function validateCoordinationLifecycleInventory(
  authorityInput: CoordinationLifecycleRosterAuthority,
  value: CoordinationLifecycleInventory
): CoordinationLifecycleInventory {
  const authority = validateCoordinationLifecycleRosterAuthority(authorityInput)
  if (
    Object.keys(value).sort().join(',') !==
      [
        'schemaVersion',
        'kind',
        'inventoryFingerprint',
        'coordinationKey',
        'coordinationOwnerTaskId',
        'transitionId',
        'coordinationCleanupAuthorizationFingerprint',
        'cleanupIntentDetected',
        'coordinationExit',
        'resourceCleanup',
        'cleanupResult',
        'rosterAuthorityFingerprint',
        'taskReadbackSource',
        'readbackRosterFingerprint',
        'readbackRoster',
        'terminalTaskIds'
      ]
        .sort()
        .join(',') ||
    value.schemaVersion !== 2 ||
    value.kind !== 'OES_COORDINATION_LIFECYCLE_INVENTORY' ||
    value.cleanupIntentDetected !== true ||
    !['PASSED', 'PENDING', 'FAILED'].includes(value.coordinationExit) ||
    !['PENDING', 'VERIFIED', 'PARTIAL_FAILURE'].includes(value.resourceCleanup) ||
    (value.resourceCleanup === 'VERIFIED') !== (value.cleanupResult !== null) ||
    (value.cleanupResult !== null &&
      (!value.cleanupResult.path ||
        !DIGEST.test(value.cleanupResult.sha256) ||
        !DIGEST.test(value.cleanupResult.fingerprint))) ||
    !['CODEX_TASK_NATIVE', 'CODEX_EXECUTION_NATIVE'].includes(value.taskReadbackSource) ||
    value.coordinationKey !== authority.coordinationKey ||
    value.coordinationOwnerTaskId !== authority.coordinationOwnerTaskId ||
    value.transitionId !== authority.transitionId ||
    value.coordinationCleanupAuthorizationFingerprint !==
      authority.coordinationCleanupAuthorizationFingerprint ||
    value.rosterAuthorityFingerprint !== authority.authorityFingerprint ||
    !Array.isArray(value.readbackRoster) ||
    !Array.isArray(value.terminalTaskIds)
  )
    fail('COORDINATION_LIFECYCLE_INVENTORY_INVALID', value.coordinationKey)
  const created = new Map(authority.createdRoster.map((task) => [task.taskId, task]))
  const readback = indexRoster(value.readbackRoster)
  if (created.size !== readback.size)
    fail('COORDINATION_LIFECYCLE_ROSTER_SIZE_MISMATCH', value.coordinationKey)
  for (const [taskId, original] of created) {
    const current = readback.get(taskId)
    if (
      !current ||
      current.taskKind !== original.taskKind ||
      current.ownerTaskId !== original.ownerTaskId
    )
      fail('COORDINATION_LIFECYCLE_READBACK_CLOSURE_MISMATCH', taskId)
  }
  if (
    objectFingerprint(value.readbackRoster as unknown as Record<string, unknown>, '__none__') !==
    value.readbackRosterFingerprint
  )
    fail('COORDINATION_LIFECYCLE_READBACK_ROSTER_FINGERPRINT_MISMATCH', value.coordinationKey)
  const terminal = new Set(value.terminalTaskIds)
  if (terminal.size !== value.terminalTaskIds.length)
    fail('COORDINATION_LIFECYCLE_TERMINAL_DUPLICATE', value.coordinationKey)
  for (const task of value.readbackRoster)
    if ((task.state === 'TERMINAL') !== terminal.has(task.taskId))
      fail('COORDINATION_LIFECYCLE_TERMINAL_COVERAGE_MISMATCH', task.taskId)
  const expected = objectFingerprint(
    value as unknown as Record<string, unknown>,
    'inventoryFingerprint'
  )
  if (value.inventoryFingerprint !== expected)
    fail('COORDINATION_LIFECYCLE_INVENTORY_FINGERPRINT_MISMATCH', value.coordinationKey)
  return value
}

/** Indexes and validates one closed task roster. */
function indexRoster<
  T extends Pick<CoordinationLifecycleCreatedTask, 'taskId' | 'taskKind' | 'ownerTaskId'>
>(roster: T[]): Map<string, T> {
  const tasks = new Map<string, T>()
  for (const task of roster) {
    if (
      !task.taskId ||
      task.taskId === task.ownerTaskId ||
      !TASK_KINDS.includes(task.taskKind) ||
      tasks.has(task.taskId)
    )
      fail('COORDINATION_LIFECYCLE_TASK_INVALID', task.taskId)
    if (
      'creationReceiptFingerprint' in task &&
      !DIGEST.test(String(task.creationReceiptFingerprint))
    )
      fail('COORDINATION_LIFECYCLE_CREATION_RECEIPT_INVALID', task.taskId)
    if ('state' in task && !['TERMINAL', 'ACTIVE', 'UNKNOWN'].includes(String(task.state)))
      fail('COORDINATION_LIFECYCLE_TASK_STATE_INVALID', task.taskId)
    tasks.set(task.taskId, task)
  }
  return tasks
}

/** Requires CO -> DO -> bounded-helper/RV ownership plus one aggregate RV owned by CO. */
function validateCoordinationTopology(
  ownerTaskId: string,
  roster: CoordinationLifecycleCreatedTask[],
  tasks: Map<string, CoordinationLifecycleCreatedTask>
): void {
  const roots = roster.filter((task) => task.ownerTaskId === null)
  const owners = roster.filter((task) => task.taskKind === 'CO')
  const deliveries = roster.filter((task) => task.taskKind === 'DO')
  if (
    roots.length !== 1 ||
    owners.length !== 1 ||
    owners[0].taskId !== ownerTaskId ||
    deliveries.length < 2
  )
    fail('COORDINATION_LIFECYCLE_TOPOLOGY_INCOMPLETE', ownerTaskId)
  for (const task of roster) {
    const parent = task.ownerTaskId ? tasks.get(task.ownerTaskId) : null
    if (task.taskKind === 'CO') {
      if (task.ownerTaskId !== null) fail('COORDINATION_LIFECYCLE_ROOT_OWNER_INVALID', task.taskId)
    } else if (!parent) fail('COORDINATION_LIFECYCLE_OWNER_ABSENT', task.taskId)
    else if (task.taskKind === 'DO' && parent.taskKind !== 'CO')
      fail('COORDINATION_LIFECYCLE_OWNER_ROLE_INVALID', task.taskId)
    else if (task.taskKind === 'BOUNDED_HELPER' && parent.taskKind !== 'DO')
      fail('COORDINATION_LIFECYCLE_OWNER_ROLE_INVALID', task.taskId)
    else if (task.taskKind === 'RV' && !['DO', 'CO'].includes(parent.taskKind))
      fail('COORDINATION_LIFECYCLE_OWNER_ROLE_INVALID', task.taskId)
  }
  for (const delivery of deliveries)
    if (
      roster.filter((task) => task.taskKind === 'RV' && task.ownerTaskId === delivery.taskId)
        .length !== 1
    )
      fail('COORDINATION_LIFECYCLE_SCOPED_RV_MISSING', delivery.taskId)
  if (
    roster.filter((task) => task.taskKind === 'RV' && task.ownerTaskId === ownerTaskId).length !== 1
  )
    fail('COORDINATION_LIFECYCLE_AGGREGATE_RV_MISSING', ownerTaskId)
}

/** Plans child-first task disposal only after terminal state and exact resource cleanup. */
export function planCoordinationLifecycle(
  rosterAuthorityInput: CoordinationLifecycleRosterAuthority,
  inventoryInput: CoordinationLifecycleInventory,
  priorResults: CoordinationArchiveResult[] = []
): CoordinationLifecyclePlan {
  if (!trustedAuthorities.has(rosterAuthorityInput))
    fail('COORDINATION_LIFECYCLE_TRUSTED_AUTHORITY_REQUIRED', rosterAuthorityInput.coordinationKey)
  if (!trustedInventories.has(inventoryInput))
    fail('COORDINATION_LIFECYCLE_TRUSTED_INVENTORY_REQUIRED', inventoryInput.coordinationKey)
  if (priorResults.length && !trustedResultSets.has(priorResults))
    fail('COORDINATION_LIFECYCLE_TRUSTED_ARCHIVE_RESULTS_REQUIRED', inventoryInput.coordinationKey)
  const inventory = validateCoordinationLifecycleInventory(rosterAuthorityInput, inventoryInput)
  if (inventory.coordinationExit !== 'PASSED')
    return wait(
      'WAIT_COORDINATION_EXIT',
      inventory.readbackRoster,
      'coordination exit has not passed'
    )
  if (inventory.readbackRoster.some((task) => task.state !== 'TERMINAL'))
    return wait(
      'WAIT_TERMINAL_ROSTER',
      inventory.readbackRoster,
      'every created child must be terminal'
    )
  if (inventory.resourceCleanup !== 'VERIFIED')
    return wait(
      'WAIT_RESOURCE_CLEANUP',
      inventory.readbackRoster,
      `resource cleanup is ${inventory.resourceCleanup}`
    )

  const tasks = new Map(inventory.readbackRoster.map((task) => [task.taskId, task]))
  const prior = new Map<string, CoordinationArchiveResult>()
  for (const result of priorResults) {
    const task = tasks.get(result.taskId)
    if (
      !task ||
      task.taskKind === 'RV' ||
      task.taskKind !== result.taskKind ||
      prior.has(result.taskId) ||
      result.inventoryFingerprint !== inventory.inventoryFingerprint
    )
      fail('COORDINATION_ARCHIVE_RESULT_UNBOUND', result.taskId)
    const expected = objectFingerprint(
      {
        taskId: result.taskId,
        taskKind: result.taskKind,
        state: result.state,
        inventoryFingerprint: result.inventoryFingerprint,
        taskNativeReadbackFingerprint: result.taskNativeReadbackFingerprint
      },
      '__none__'
    )
    if (!DIGEST.test(result.taskNativeReadbackFingerprint) || result.resultFingerprint !== expected)
      fail('COORDINATION_ARCHIVE_RESULT_FINGERPRINT_MISMATCH', result.taskId)
    prior.set(result.taskId, result)
  }
  const depth = (task: CoordinationLifecycleTask): number => {
    let result = 0
    let cursor = task
    const seen = new Set<string>()
    while (cursor.ownerTaskId) {
      if (seen.has(cursor.taskId)) fail('COORDINATION_LIFECYCLE_CYCLE', cursor.taskId)
      seen.add(cursor.taskId)
      const parent = tasks.get(cursor.ownerTaskId)
      if (!parent) fail('COORDINATION_LIFECYCLE_OWNER_ABSENT', cursor.taskId)
      cursor = parent
      result += 1
    }
    return result
  }
  const remaining = inventory.readbackRoster.filter(
    (task) => task.taskKind !== 'RV' && prior.get(task.taskId)?.state !== 'ARCHIVED'
  )
  if (!remaining.length)
    return {
      status: 'COMPLETE',
      decisions: inventory.readbackRoster.map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        decision: task.taskKind === 'RV' ? 'SKIP_TERMINATED_SUBAGENT' : 'SKIP_ARCHIVED',
        reason:
          task.taskKind === 'RV'
            ? 'visible RV subagent is already terminal and has no sidebar archive action'
            : 'prior exact archive result was verified'
      }))
    }
  const activeDepth = Math.max(...remaining.map(depth))
  const activeFailed = remaining.some(
    (task) => depth(task) === activeDepth && prior.get(task.taskId)?.state === 'FAILED'
  )
  const decisions = [...inventory.readbackRoster]
    .sort((a, b) => depth(b) - depth(a) || a.taskId.localeCompare(b.taskId))
    .map((task): CoordinationArchiveDecision => {
      if (task.taskKind === 'RV')
        return {
          taskId: task.taskId,
          taskKind: task.taskKind,
          decision: 'SKIP_TERMINATED_SUBAGENT',
          reason: 'visible RV subagent is terminal and is not a sidebar task'
        }
      const result = prior.get(task.taskId)
      if (result?.state === 'ARCHIVED')
        return {
          taskId: task.taskId,
          taskKind: task.taskKind,
          decision: 'SKIP_ARCHIVED',
          reason: 'prior exact archive result was verified'
        }
      if (depth(task) < activeDepth)
        return {
          taskId: task.taskId,
          taskKind: task.taskKind,
          decision: 'PRESERVE_BLOCKED',
          reason: 'a child task is not archived'
        }
      return {
        taskId: task.taskId,
        taskKind: task.taskKind,
        decision: 'ARCHIVE',
        reason:
          result?.state === 'FAILED'
            ? 'retry the exact failed archive item'
            : 'deepest remaining child-first archive action'
      }
    })
  return { status: activeFailed ? 'ARCHIVE_PARTIAL_FAILURE' : 'ARCHIVE_READY', decisions }
}

/** Creates a uniform preservation plan for a blocked lifecycle gate. */
function wait(
  status: CoordinationLifecyclePlan['status'],
  tasks: CoordinationLifecycleTask[],
  reason: string
): CoordinationLifecyclePlan {
  return {
    status,
    decisions: tasks.map((task) => ({
      taskId: task.taskId,
      taskKind: task.taskKind,
      decision: 'PRESERVE_BLOCKED',
      reason
    }))
  }
}
