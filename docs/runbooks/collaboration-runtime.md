# Collaboration Framework V2 Runtime Runbook

The executable contract follows `docs/governance/codex-execution-model.md`. Active roles are exactly **DA / UD / DO / CO / RV**; RV runs as a viewable subagent rather than a separate sidebar task.

## 1. Route before mutation

Read-only discussion creates no delivery resources. For stateful work, create a routing input that records design impact, cohesive workstreams, write sets, dependencies, real parallelism, cross-delivery integration, and any Human-confirmed independent-PR exception.

```bash
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  route --input ROUTING_INPUT.json
```

Expected routes are `DISCUSSION`, `DA_UD`, `DO`, or `CO`. Size alone does not justify CO. The route emits at most one decision-confirmation gate and one of no PR, one DO PR, one aggregate CO PR, or an explicitly confirmed independently releasable DO-PR exception. Scope and acceptance are carried into the material-decision fingerprint; every workstream must be contained by those confirmed bounds. After the native controller writes the Human confirmation receipt, rerun with `--profile-report EFFECTIVE_PROFILE.json --confirmation CONFIRMATION_REFERENCE.json`; the runtime reopens the receipt instead of accepting a Boolean.

## 2. Owner profile and remote actions

Render and verify the exact owner profile, then execute remote actions only through the general remote driver:

```bash
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  profile-render --input PROFILE_RENDER.json
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  profile-preflight-probe --input PROFILE_PROBE.json
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  profile-preflight-finalize --input PROFILE_FINALIZE.json
scripts/collaboration-runtime/bin/oes-remote-driver \
  --profile-report EFFECTIVE_PROFILE.json --binding ACTION_BINDING.json
```

The remote driver supports only `preflight`, `publish-pr`, `verify-pr`, Merge Queue admission, and `verify-main`. Publication is Draft-only. Every action authorization reopens the existing controller-owned confirmation receipt plus exact current admission state. Mutating actions are serialized by one owner-local binding lock across remote read, mutation, and checkpoint; a live conflicting invocation fails closed and a dead holder is recoverable. The agent-facing merge capability is the `oes-remote-driver` command with a Merge Queue binding; cleanup is not a remote-driver action.

## 3. DO and CO candidates

One DO produces one candidate and one PR. A CO requires at least two independently owned DO candidates, each with scoped RV. Integrate candidates in dependency order:

```bash
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  coordination-integration-plan \
  --authorization CO_AUTHORIZATION.json \
  --results CURRENT_RESULTS.json
```

Default topology is one `codex/coordination/<key>` aggregate branch and one Draft PR. Independent PR topology is accepted only when the Human confirmed the exception and every DO is independently releasable. A failed integration preserves the verified prefix and blocks the suffix.

## 4. Verification

Build the exact-candidate topology:

```bash
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  verification-plan --input VERIFICATION_INPUT.json \
  --profile-report EFFECTIVE_PROFILE.json \
  --confirmation CONFIRMATION_REFERENCE.json
```

DO/CO self-test, independent visible RV subagent, and `Baseline Checks` CI are distinct. When a PR candidate exists, RV and CI run in parallel. Select static, unit, component, contract, integration, and journey coverage by changed risk. If the planner marks PR-triggered FULL above the approved level, disclose reason/scope/phases/estimated cost once; the resulting scope-bound confirmation survives candidate repairs.

Use the single public verification entry instead of assembling evidence shell scripts:

```bash
scripts/collaboration-runtime/bin/oes-verify run --input VERIFICATION_RUN.json
```

## 5. Moving main

`origin/main` is remote truth. Fetch does not mutate the shared local `main`; existing owner resources retain their base. Use the guarded `local-main` command only for an explicitly confirmed clean fast-forward. Update a candidate only for conflict, dependency change, or admission requirement and rerun affected verification. A Merge Queue request may observe `main` ahead of the original integration base; the queue synthesizes the current-main merge group and the driver validates that group rather than rejecting ordinary main drift.

## 6. Lifecycle disposal

Cleanup has a separate executable:

```bash
scripts/collaboration-runtime/bin/oes-lifecycle-cleanup \
  cleanup-plan --profile-report EFFECTIVE_PROFILE.json \
  --authorization CO_CLEANUP.json \
  --child-authorization CHILD_CLEANUP.json \
  --observed OBSERVATIONS.json --output PLAN.json

scripts/collaboration-runtime/bin/oes-lifecycle-cleanup \
  cleanup-verify --profile-report EFFECTIVE_PROFILE.json \
  --authorization CO_CLEANUP.json --child-results RESULTS.json \
  --repository-diff REPOSITORY_DIFF.json \
  --output CLEANUP_RESULT_SET.json

scripts/collaboration-runtime/bin/oes-lifecycle-cleanup \
  coordination-lifecycle-plan --profile-report EFFECTIVE_PROFILE.json \
  --authorization CO_CLEANUP.json \
  --roster-authority ROSTER_REFERENCE.json \
  --inventory INVENTORY_REFERENCE.json
```

This entrypoint exposes only exact resource disposal, zero-repository-diff verification, and child-first archive planning. `cleanup-verify` seals the complete DO-plus-CO absence proof; the protected lifecycle inventory must bind that exact result-set reference before archive planning can reach `ARCHIVE_READY`. It has no route to task/delivery creation, branch creation, product writes, PR publication, merge, or CI. Unknown, shared, active, dirty, missing-observation, physical-path alias, and SHA-mismatched resources are preserved. For one DO, terminate its RV subagent, clean exact resources, then archive DO; the controller-owned cleanup result is bound to the current profile owner and owner-resource package path. For CO work, terminate deepest bounded helpers/RV subagents, then DOs, aggregate RV, and CO; retries skip already verified identities. Exact task-owned cleanup uses the existing confirmation and does not stop for another card.

## 7. Evidence and restart

Persist candidate/base SHA, structured commands, literal output, exit status, dependency/environment identity, changed-risk coverage, RV result, CI state, remaining risk, and rollback. Completed DP/ADP evidence uses a typed record that binds evidence type, verdict, owner/reviewer, evidence generation, exact candidate or operation, current evidence basis, and hashed source artifacts. Reopen and byte-hash every activation design/DA/UD reference before accepting a DP; ADP reopening repeats that proof for every child DP. A CO ADP also reopens the Human-confirmed complete child roster and explicitly declared external dependencies before Aggregate RV input creation. Reopen and rehash bindings before resuming. Reuse evidence only when its exact candidate, inputs, dependencies, environment, command, and coverage still apply. At package disposal, inspect every path component without following links, treat dangling links as present aliases, observe repository-mode Git status through exact worktree/Git-directory arguments under a controlled environment that excludes inherited Git selectors and configuration, and use the same controlled environment to require host-local artifact roots to be repository-free.
