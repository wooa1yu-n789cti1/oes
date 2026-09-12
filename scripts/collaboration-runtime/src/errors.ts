const RECOVERY_ACTIONS: Record<string, string> = {
  CLI_ARGUMENT_REQUIRED: 'READ_STAGE_CAPABILITIES',
  CLI_COMMAND_UNKNOWN: 'READ_STAGE_CAPABILITIES',
  CLEANUP_CLI_COMMAND_UNKNOWN: 'READ_CLEANUP_CAPABILITIES',
  OWNER_WORKTREE_DIRTY: 'USE_FORMAL_CANDIDATE_OR_DECLARED_VERIFICATION_INPUTS',
  ASSIGNMENT_RV_WIP_EXCEEDED: 'RESUME_BOUND_RV_SUBAGENT',
  ASSIGNMENT_RV_IDENTITY_CHANGED: 'RESUME_BOUND_RV_SUBAGENT',
  UD_ALREADY_ACTIVE: 'SEND_PROPOSAL_TO_BOUND_UD',
  UD_BINDING_BUSY: 'READ_CURRENT_UD_BINDING',
  UD_BINDING_CAS_MISMATCH: 'READ_CURRENT_UD_BINDING',
  RV_SESSION_BUSY: 'READ_BOUND_RV_SUBAGENT',
  RV_SESSION_CAS_MISMATCH: 'READ_BOUND_RV_SUBAGENT',
  RV_TERMINAL_MUTATION_FORBIDDEN: 'READ_BOUND_RV_SUBAGENT',
  REMOTE_ACTION_BUSY: 'RESUME_BOUND_REMOTE_ACTION',
  REMOTE_ACTION_LOCK_INVALID: 'PRESERVE_LOCK_AND_RETURN_TO_CURRENT_OWNER',
  REMOTE_ACTION_LOCK_OWNERSHIP_LOST: 'PRESERVE_LOCK_AND_RETURN_TO_CURRENT_OWNER',
  MERGE_QUEUE_REQUIRED: 'ENQUEUE_CONFIRMED_PULL_REQUEST',
  HUMAN_DECISION_REQUIRED: 'PRESENT_ONE_DECISION_CARD',
  VERIFICATION_FULL_DISCLOSURE_REQUIRED: 'PRESENT_FULL_SCOPE_AND_COST_ONCE',
  THIN_VERIFY_USAGE: 'READ_VERIFICATION_RUNNER_USAGE',
  THIN_VERIFY_INPUT_INVALID: 'FIX_VERIFICATION_INPUT',
  THIN_VERIFY_UNDECLARED_DIRTY_PATH: 'DECLARE_INPUT_OR_CLEAN_WORKTREE',
  V3_PACKAGE_CUTOVER_REQUIRED: 'MIGRATE_ACTIVE_PACKAGE_TO_V3_BEFORE_CONTINUING',
  V2_REMOTE_AUTHORIZATION_CUTOVER_REQUIRED: 'REISSUE_REMOTE_AUTHORIZATION_V2'
}

/** Returns the one machine-readable recovery action for a stable failure code. */
export function nextActionFor(code: string): string {
  return RECOVERY_ACTIONS[code] ?? 'RETURN_ERROR_TO_CURRENT_OWNER'
}

/** Carries a stable runtime failure code and one deterministic recovery action. */
export class RuntimeContractError extends Error {
  readonly code: string
  readonly nextAction: string

  constructor(code: string, message: string, nextAction: string = nextActionFor(code)) {
    super(`${code}: ${message}`)
    this.name = 'RuntimeContractError'
    this.code = code
    this.nextAction = nextAction
  }
}

/** Fails a runtime guard with a stable code. */
export function fail(code: string, message: string, nextAction?: string): never {
  throw new RuntimeContractError(code, message, nextAction)
}

/** Formats a runtime error without requiring an agent to infer the recovery route. */
export function runtimeErrorResult(error: unknown): {
  status: 'ERROR'
  errorCode: string
  message: string
  nextAction: string
} {
  if (error instanceof RuntimeContractError)
    return {
      status: 'ERROR',
      errorCode: error.code,
      message: error.message,
      nextAction: error.nextAction
    }
  return {
    status: 'ERROR',
    errorCode: 'UNEXPECTED_RUNTIME_ERROR',
    message: error instanceof Error ? error.message : String(error),
    nextAction: 'RETURN_ERROR_TO_CURRENT_OWNER'
  }
}
