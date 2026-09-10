export const EXPECTED_SELF_AUDIT_ACTIONS = [
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_ARCHIVED',
  'TASK_UNARCHIVED',
  'TASK_REOPENED',
  'TASK_CANCELLED',
  'TASK_ARCHIVED',
]

export const EXPECTED_SELF_EVENT_TYPES = [
  'TaskCreated',
  'TaskUpdated',
  'TaskStarted',
  'TaskCompleted',
  'TaskArchived',
  'TaskUnarchived',
  'TaskReopened',
  'TaskCancelled',
  'TaskArchived',
]

export const EXPECTED_ASSIGNED_AUDIT_ACTIONS = ['TASK_CREATED']
export const EXPECTED_ASSIGNED_EVENT_TYPES = ['TaskCreated', 'TaskAssigned']

// createTaskP1SmokeSeed builds deterministic Task P1 smoke input for tests and local verification.
export function createTaskP1SmokeSeed(now = Date.now()) {
  return {
    assigneeAccountId:
      process.env.COLLABORATION_TASK_SMOKE_ASSIGNEE_ACCOUNT_ID ||
      '00000000-0000-4000-8000-000000000903',
    credential: process.env.COLLABORATION_TASK_SMOKE_CREDENTIAL || 'imkgsam6593',
    expectedAssignedTaskId: 'assigned-task-id',
    expectedTaskId: 'task-id',
    identifier: process.env.COLLABORATION_TASK_SMOKE_IDENTIFIER || 'csp@ml.lc',
    marker: `collaboration Task P1 smoke ${now}`,
    nowIso: new Date(now).toISOString(),
    operatorAccountId: '00000000-0000-4000-8000-000000000901',
    operatorUserId: '00000000-0000-4000-8000-000000000801',
    tenantId:
      process.env.COLLABORATION_TASK_SMOKE_TENANT_ID ||
      '00000000-0000-4000-8000-000000000001',
  }
}

// runCollaborationTaskP1SmokeFlow drives the frozen Task P1 Gateway flow and validates persisted side effects.
export async function runCollaborationTaskP1SmokeFlow({ auditStore, gateway }, seed) {
  const login = await gateway.login({
    credential: seed.credential,
    identifier: seed.identifier,
    method: 'EMAIL_PASSWORD',
  })
  const account = login.accountOptions?.find(
    (option) =>
      option.accountId === seed.operatorAccountId &&
      option.tenantId === seed.tenantId &&
      option.scopeLevel === 'TENANT',
  )
  if (!account) {
    throw new Error(
      `Task P1 smoke requires tenant account ${seed.operatorAccountId} in tenant ${seed.tenantId}.`,
    )
  }

  const selected = await gateway.selectAccount({
    accountId: account.accountId,
    loginMethod: 'EMAIL_PASSWORD',
    userId: login.operator?.userId,
  })
  const token = selected.session?.accessToken
  if (!token) {
    throw new Error('Task P1 smoke did not receive an access token after account selection.')
  }

  const created = await gateway.createTask({
    description: 'Self todo created by the repeatable Task P1 smoke.',
    dueAt: '2026-06-16T10:00:00.000Z',
    priority: 'NORMAL',
    title: `${seed.marker} self`,
    token,
  })
  const taskId = created.task?.taskId
  if (!taskId) {
    throw new Error('Task P1 smoke createTask response did not contain task.taskId.')
  }

  const updated = await gateway.updateTask(taskId, {
    description: 'Self todo updated by the repeatable Task P1 smoke.',
    dueAt: '2026-06-17T10:00:00.000Z',
    priority: 'HIGH',
    title: `${seed.marker} self updated`,
    token,
  })
  const listed = await gateway.listTasks({
    includeArchived: false,
    page: 1,
    pageSize: 20,
    scope: 'MY_TODO',
    token,
  })
  const started = await gateway.startTask(taskId, { token })
  const completed = await gateway.completeTask(taskId, {
    completionNote: 'Task P1 smoke complete',
    token,
  })
  const archived1 = await gateway.archiveTask(taskId, { token })
  const unarchived = await gateway.unarchiveTask(taskId, { token })
  const reopened = await gateway.reopenTask(taskId, {
    reopenReason: 'Task P1 smoke reopen',
    token,
  })
  const cancelled = await gateway.cancelTask(taskId, {
    cancelReason: 'Task P1 smoke cancel',
    token,
  })
  const archived2 = await gateway.archiveTask(taskId, { token })
  const selfSideEffects = await auditStore.readTaskSideEffects(taskId)
  assertSequence('self audit actions', selfSideEffects.auditActions, EXPECTED_SELF_AUDIT_ACTIONS)
  assertSequence('self event types', selfSideEffects.eventTypes, EXPECTED_SELF_EVENT_TYPES)

  const assignedCreated = await gateway.createTask({
    assigneeAccountId: seed.assigneeAccountId,
    description: 'Assigned task created by the repeatable Task P1 smoke.',
    priority: 'NORMAL',
    title: `${seed.marker} assigned`,
    token,
  })
  const assignedTaskId = assignedCreated.task?.taskId
  if (!assignedTaskId) {
    throw new Error('Task P1 smoke assigned create response did not contain task.taskId.')
  }
  const createdByMe = await gateway.listTasks({
    includeArchived: false,
    page: 1,
    pageSize: 20,
    scope: 'CREATED_BY_ME',
    token,
  })
  const assignedSideEffects = await auditStore.readTaskSideEffects(assignedTaskId)
  assertSequence(
    'assigned audit actions',
    assignedSideEffects.auditActions,
    EXPECTED_ASSIGNED_AUDIT_ACTIONS,
  )
  assertSequence(
    'assigned event types',
    assignedSideEffects.eventTypes,
    EXPECTED_ASSIGNED_EVENT_TYPES,
  )

  return {
    assignedTask: {
      assigneeAccountId: assignedCreated.task.assigneeAccountId,
      auditActions: assignedSideEffects.auditActions,
      createdByMeContainsAssigned: (createdByMe.items ?? []).some(
        (task) => task.taskId === assignedTaskId,
      ),
      eventTypes: assignedSideEffects.eventTypes,
      taskId: assignedTaskId,
      visibility: assignedCreated.task.visibility,
    },
    auditActions: selfSideEffects.auditActions,
    eventTypes: selfSideEffects.eventTypes,
    listContainsCreated: (listed.items ?? []).some((task) => task.taskId === taskId),
    marker: seed.marker,
    statuses: {
      archivedAfterComplete: archived1.task?.archivedAt ? 'ARCHIVED' : 'NOT_ARCHIVED',
      archivedAfterCancel: archived2.task?.archivedAt ? 'ARCHIVED' : 'NOT_ARCHIVED',
      cancelled: cancelled.task?.status,
      completed: completed.task?.status,
      created: created.task?.status,
      reopened: reopened.task?.status,
      started: started.task?.status,
      unarchived: unarchived.task?.archivedAt ? 'STILL_ARCHIVED' : 'UNARCHIVED',
      updated: updated.task?.status,
    },
    taskId,
  }
}

// assertSequence fails fast when smoke side effects no longer match the frozen Task P1 command/event contract.
function assertSequence(label, actual, expected) {
  const normalizedActual = actual ?? []
  if (
    normalizedActual.length !== expected.length ||
    normalizedActual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label} mismatch. expected=${JSON.stringify(expected)} actual=${JSON.stringify(
        normalizedActual,
      )}`,
    )
  }
}
