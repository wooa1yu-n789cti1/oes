# OES Collaboration Framework V2 runtime

This directory implements the repository-owned DA/UD/DO/CO/RV routing, delivery, verification, remote-action, and lifecycle contracts.

## Core modules

- `src/routing.ts` and `src/confirmation.ts`: choose the smallest owner topology and reopen one controller-owned Human confirmation receipt for a persistent Proposal or Delivery decision.
- `src/ud-binding.ts`: holds the single replaceable current-UD identity without a registry or history ledger.
- `src/replan.ts` and `src/assignment-runtime.ts`: keep normal issues with DO, return only boundary changes to DA, and enforce direct assignments and WIP ceilings.
- `src/review-session.ts`: binds one visible RV subagent across candidate generations.
- `src/coordination-integration.ts`: dependency-ordered CO integration, scoped-RV prerequisites, aggregate-PR default, explicit independent-PR exception, and healthy-prefix preservation.
- `src/verification-topology.ts` and `src/verification-runner.ts`: exact-candidate self-test/RV/CI coverage, persistent scope-bound FULL approval, and one structured verification entry that emits all four delivery artifact roles.
- `src/evidence.ts`, `src/validation-plan.ts`, and `src/design-risk-scan.ts`: evidence identity, risk-selected reuse/invalidation, and canonical design-gap checks.
- `src/profile-policy.ts`, `src/profile-preflight.ts`, `src/resource-topology.ts`: exact-owner profile and owner-exclusive resource binding.
- `src/remote-driver.ts` and `src/github-adapter.ts`: authenticated Draft PR, verification, Merge Queue admission, and main readback. The remote action set has no cleanup command.
- `src/cleanup-binding.ts`, `src/cleanup.ts`, `src/cleanup-cli.ts`: isolated exact disposal and zero-repository-diff validation.
- `src/coordination-lifecycle.ts`: task-native roster closure and deepest-child-first archive planning.
- `src/delivery-lifecycle.ts`: RV-first terminal disposal for one DO.
- `src/capabilities.ts` and `src/errors.ts`: stage-specific valid tools and stable `errorCode` plus one `nextAction`.
- `schemas/`: versioned executable contracts; decision cards carry a material-decision fingerprint, DP/ADP and remote authorization use v3/v2 wire versions for their new required trust fields, and old active records require an explicit cutover before reuse.

## Entrypoints

```bash
pnpm collaboration-runtime:check

node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  route --input ROUTING_INPUT.json
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  capabilities --stage MERGE
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  ud-binding-read --profile-report EFFECTIVE_PROFILE.json --project oes
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  rv-session-read --root /ABSOLUTE/OWNER-ARTIFACT-ROOT --delivery DELIVERY_KEY
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  verification-plan --input VERIFICATION_INPUT.json \
  --profile-report EFFECTIVE_PROFILE.json --confirmation CONFIRMATION_REFERENCE.json
node --experimental-strip-types scripts/collaboration-runtime/src/cli.ts \
  coordination-integration-plan \
  --authorization CO_AUTHORIZATION.json --results RESULTS.json

scripts/collaboration-runtime/bin/oes-remote-driver \
  --profile-report EFFECTIVE_PROFILE.json --binding ACTION_BINDING.json

scripts/collaboration-runtime/bin/oes-verify run --input VERIFICATION_RUN.json

scripts/collaboration-runtime/bin/oes-lifecycle-cleanup \
  cleanup-plan --profile-report EFFECTIVE_PROFILE.json \
  --authorization CLEANUP.json --child-authorization CHILD.json \
  --observed OBSERVED.json --output PLAN.json
```

`src/cli.ts` and `oes-remote-driver` contain delivery/remote behavior but no cleanup route. `oes-lifecycle-cleanup` contains disposal planning and verification but imports no routing, delivery creation, GitHub adapter, PR, merge, CI, or product-writing module.

All repository PRs target `main`, begin Draft, and use `Baseline Checks`. A DO has one candidate/PR. CO defaults to one aggregate candidate/PR after scoped RV; independent DO PRs require a confirmed exception and independent releasability. PR-triggered FULL is held until its disclosed cost is confirmed once for the bounded scope; candidate repairs do not revoke that confirmation.

Cleanup binds terminal state and exact owner resources, permits no branch creation or repository-content diff, disposes RV subagents before owners, preserves ambiguous resources, and replays only failed exact identities. Exact task-owned cleanup is covered by the existing card and introduces no extra Human gate.
