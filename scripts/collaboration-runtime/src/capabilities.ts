export const EXECUTION_STAGES = [
  'STARTUP',
  'DELIVERY',
  'RV',
  'CI',
  'MERGE',
  'CLEANUP',
  'REPLAN'
] as const
export type ExecutionStage = (typeof EXECUTION_STAGES)[number]

export interface ExecutionCapability {
  operation: string
  tool: string
  nextActionOnSuccess: string
}

const CAPABILITIES: Record<ExecutionStage, ExecutionCapability[]> = {
  STARTUP: [
    {
      operation: 'route',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration route --input ROUTING_INPUT --profile-report PROFILE_REPORT --confirmation CONFIRMATION_REFERENCE',
      nextActionOnSuccess: 'OPEN_CONFIRMED_OWNER'
    },
    {
      operation: 'read-current-ud',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration ud-binding-read --profile-report PROFILE_REPORT --project PROJECT_KEY',
      nextActionOnSuccess: 'SEND_TO_BOUND_UD_OR_BIND_SUCCESSOR'
    }
  ],
  DELIVERY: [
    {
      operation: 'verify',
      tool: 'scripts/collaboration-runtime/bin/oes-verify run --input VERIFICATION_RUN',
      nextActionOnSuccess: 'REQUEST_OR_RESUME_BOUND_RV'
    },
    {
      operation: 'publish',
      tool: 'scripts/collaboration-runtime/bin/oes-remote-driver --profile-report PROFILE_REPORT --binding PUBLISH_PR_BINDING',
      nextActionOnSuccess: 'RUN_RV_AND_CI'
    }
  ],
  RV: [
    {
      operation: 'read-session',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration rv-session-read --profile-report PROFILE_REPORT --delivery DELIVERY_KEY',
      nextActionOnSuccess: 'RESUME_OR_BIND_SESSION'
    },
    {
      operation: 'bind-session',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration rv-session-bind --profile-report PROFILE_REPORT --input REVIEW_SESSION_INPUT',
      nextActionOnSuccess: 'REVIEW_EXACT_CANDIDATE'
    },
    {
      operation: 'review',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration rv-session-bind --profile-report PROFILE_REPORT --input REVIEW_SESSION_INPUT',
      nextActionOnSuccess: 'RECORD_EXACT_CANDIDATE_VERDICT'
    }
  ],
  CI: [
    {
      operation: 'run-or-rerun',
      tool: 'scripts/collaboration-runtime/bin/oes-remote-driver --profile-report PROFILE_REPORT --binding VERIFY_PR_BINDING',
      nextActionOnSuccess: 'READ_AUTHORITATIVE_RESULT'
    }
  ],
  MERGE: [
    {
      operation: 'enqueue',
      tool: 'scripts/collaboration-runtime/bin/oes-remote-driver --profile-report PROFILE_REPORT --binding MERGE_QUEUE_BINDING',
      nextActionOnSuccess: 'WAIT_FOR_MERGE_GROUP_RESULT'
    }
  ],
  CLEANUP: [
    {
      operation: 'dispose',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration delivery-lifecycle-plan --profile-report PROFILE_REPORT --input DELIVERY_LIFECYCLE_INPUT',
      nextActionOnSuccess: 'ARCHIVE_OWNER_AFTER_CHILDREN'
    },
    {
      operation: 'dispose-coordination',
      tool: 'scripts/collaboration-runtime/bin/oes-lifecycle-cleanup coordination-lifecycle-plan --profile-report PROFILE_REPORT --authorization CLEANUP_AUTHORIZATION --roster-authority ROSTER_AUTHORITY_REFERENCE --inventory INVENTORY_REFERENCE --output LIFECYCLE_PLAN',
      nextActionOnSuccess: 'ARCHIVE_OWNER_AFTER_CHILDREN'
    }
  ],
  REPLAN: [
    {
      operation: 'classify',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration replan --input DO_ISSUE_INPUT',
      nextActionOnSuccess: 'CONTINUE_DO_OR_RETURN_ONCE_TO_DA'
    },
    {
      operation: 'decide-owner-topology',
      tool: 'scripts/collaboration-runtime/bin/oes-collaboration da-replan --input DA_REPLAN_INPUT --profile-report PROFILE_REPORT --confirmation CONFIRMATION_REFERENCE',
      nextActionOnSuccess: 'RESUME_REPLACE_OR_COORDINATE_WITHOUT_DUPLICATION'
    }
  ]
}

/** Returns only the valid agent-facing operations for the current execution stage. */
export function executionCapabilities(stage: ExecutionStage): ExecutionCapability[] {
  if (!EXECUTION_STAGES.includes(stage)) return []
  return structuredClone(CAPABILITIES[stage])
}
