import assert from 'node:assert/strict'
import test from 'node:test'

import { createTaskP1SmokeSeed, runCollaborationTaskP1SmokeFlow } from '../collaboration-task-p1-smoke-lib.mjs'

// Verifies the repeatable Task P1 smoke flow exercises every frozen command through the Gateway-facing client.
test('collaboration Task P1 smoke flow drives all frozen commands and verifies audit/event envelopes', async () => {
  const calls = []
  const seed = createTaskP1SmokeSeed(1700000000000)

  const gateway = {
    login: async (request) => {
      calls.push(['login', request])
      return {
        accountOptions: [
          {
            accountId: '00000000-0000-4000-8000-000000000902',
            scopeLevel: 'SYSTEM',
          },
          {
            accountId: seed.operatorAccountId,
            scopeLevel: 'TENANT',
            tenantId: seed.tenantId,
          },
        ],
        operator: { userId: seed.operatorUserId },
      }
    },
    selectAccount: async (request) => {
      calls.push(['selectAccount', request])
      return {
        session: { accessToken: 'access-token' },
        operator: {
          accountId: seed.operatorAccountId,
          tenantId: seed.tenantId,
          userId: seed.operatorUserId,
        },
      }
    },
    createTask: async (request) => {
      calls.push(['createTask', request])
      if (request.assigneeAccountId) {
        return {
          task: {
            assigneeAccountId: request.assigneeAccountId,
            status: 'OPEN',
            taskId: seed.expectedAssignedTaskId,
            title: request.title,
            visibility: 'ASSIGNMENT_PARTICIPANTS',
          },
        }
      }
      return {
        task: {
          taskId: seed.expectedTaskId,
          status: 'OPEN',
          title: request.title,
        },
      }
    },
    updateTask: async (taskId, request) => {
      calls.push(['updateTask', taskId, request])
      return { task: { taskId, status: 'OPEN', title: request.title } }
    },
    listTasks: async (request) => {
      calls.push(['listTasks', request])
      return {
        items:
          request.scope === 'CREATED_BY_ME'
            ? [{ taskId: seed.expectedAssignedTaskId }]
            : [{ taskId: seed.expectedTaskId }],
      }
    },
    startTask: async (taskId) => {
      calls.push(['startTask', taskId])
      return { task: { taskId, status: 'IN_PROGRESS' } }
    },
    completeTask: async (taskId, request) => {
      calls.push(['completeTask', taskId, request])
      return { task: { taskId, status: 'COMPLETED' } }
    },
    archiveTask: async (taskId) => {
      calls.push(['archiveTask', taskId])
      return { task: { taskId, status: 'COMPLETED', archivedAt: seed.nowIso } }
    },
    unarchiveTask: async (taskId) => {
      calls.push(['unarchiveTask', taskId])
      return { task: { taskId, status: 'COMPLETED', archivedAt: null } }
    },
    reopenTask: async (taskId, request) => {
      calls.push(['reopenTask', taskId, request])
      return { task: { taskId, status: 'OPEN' } }
    },
    cancelTask: async (taskId, request) => {
      calls.push(['cancelTask', taskId, request])
      return { task: { taskId, status: 'CANCELLED' } }
    },
  }

  const auditStore = {
    readTaskSideEffects: async (taskId) => {
      calls.push(['readTaskSideEffects', taskId])
      if (taskId === seed.expectedAssignedTaskId) {
        return {
          auditActions: ['TASK_CREATED'],
          eventTypes: ['TaskCreated', 'TaskAssigned'],
        }
      }
      return {
        auditActions: [
          'TASK_CREATED',
          'TASK_UPDATED',
          'TASK_STARTED',
          'TASK_COMPLETED',
          'TASK_ARCHIVED',
          'TASK_UNARCHIVED',
          'TASK_REOPENED',
          'TASK_CANCELLED',
          'TASK_ARCHIVED',
        ],
        eventTypes: [
          'TaskCreated',
          'TaskUpdated',
          'TaskStarted',
          'TaskCompleted',
          'TaskArchived',
          'TaskUnarchived',
          'TaskReopened',
          'TaskCancelled',
          'TaskArchived',
        ],
      }
    },
  }

  const result = await runCollaborationTaskP1SmokeFlow({ auditStore, gateway }, seed)

  assert.equal(result.taskId, seed.expectedTaskId)
  assert.equal(result.statuses.started, 'IN_PROGRESS')
  assert.equal(result.statuses.completed, 'COMPLETED')
  assert.equal(result.statuses.reopened, 'OPEN')
  assert.equal(result.statuses.cancelled, 'CANCELLED')
  assert.equal(result.listContainsCreated, true)
  assert.equal(result.assignedTask.taskId, seed.expectedAssignedTaskId)
  assert.equal(result.assignedTask.assigneeAccountId, seed.assigneeAccountId)
  assert.equal(result.assignedTask.createdByMeContainsAssigned, true)
  assert.equal(calls[1][1].accountId, seed.operatorAccountId)
  assert.deepEqual(result.assignedTask.auditActions, ['TASK_CREATED'])
  assert.deepEqual(result.assignedTask.eventTypes, ['TaskCreated', 'TaskAssigned'])
  assert.deepEqual(result.auditActions, [
    'TASK_CREATED',
    'TASK_UPDATED',
    'TASK_STARTED',
    'TASK_COMPLETED',
    'TASK_ARCHIVED',
    'TASK_UNARCHIVED',
    'TASK_REOPENED',
    'TASK_CANCELLED',
    'TASK_ARCHIVED',
  ])
  assert.deepEqual(result.eventTypes, [
    'TaskCreated',
    'TaskUpdated',
    'TaskStarted',
    'TaskCompleted',
    'TaskArchived',
    'TaskUnarchived',
    'TaskReopened',
    'TaskCancelled',
    'TaskArchived',
  ])
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'login',
      'selectAccount',
      'createTask',
      'updateTask',
      'listTasks',
      'startTask',
      'completeTask',
      'archiveTask',
      'unarchiveTask',
      'reopenTask',
      'cancelTask',
      'archiveTask',
      'readTaskSideEffects',
      'createTask',
      'listTasks',
      'readTaskSideEffects',
    ],
  )
})
