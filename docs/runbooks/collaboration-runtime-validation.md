# Collaboration Runtime Validation and Evidence Runbook

This runbook applies the risk-based verification contract in `docs/governance/codex-execution-model.md` without redefining ownership or remote authority.

## 1. Evidence identity

Create an evidence key only after the command completes and its literal output and exit status are persisted. Bind:

- candidate commit/tree and exact dependency commits/trees;
- dependency, lockfile, toolchain, test-config, environment, and profile fingerprints;
- literal inputs, command/version, output fingerprint, and exit status;
- sorted bounded coverage identifiers.

Use Git object IDs directly and SHA-256 for persisted inputs. `createEvidenceKey` rejects duplicates and malformed identities; `validateEvidenceKey` reconstructs the canonical record and rejects missing or changed fields.

## 2. Reuse and invalidation

| Change                                                                                                                             | Decision           | Action                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| Complete evidence identity unchanged                                                                                               | `REUSE_EXACT`      | Reuse the exact record.                                                    |
| Candidate advanced only outside command coverage                                                                                   | `REFRESH_BASELINE` | Rebind unchanged literal result to the new candidate.                      |
| Changed paths intersect command coverage                                                                                           | `FOCUSED`          | Rerun the affected command only.                                           |
| Contract/dependency, lockfile, toolchain, config, environment, input/output, profile, command/version, status, or coverage changed | `FULL`             | Invalidate the affected evidence class and run the complete selected gate. |
| Frozen semantics conflict                                                                                                          | `DESIGN_GAP`       | Pause the affected delivery and return the exact gap through DA/UD.        |

A moving candidate or `main` is not automatically FULL. Changed-path proof must use normalized repository-relative paths without aliases or traversal.

## 3. Lifecycle tiers

Each `createValidationPlan` request has one tier:

1. `FOCUSED_DEVELOPMENT`: fastest changed-scope type/unit/static feedback; gate context `NONE`.
2. `CANDIDATE_AFFECTED`: risk-selected component, contract, integration, or journey coverage; gate context `NONE`.
3. `FULL_GATE`: one DO or CO candidate gate; gate context `DELIVERY` or `COORDINATION`.

Every command appears in exactly one of `runActions` or `reuseActions`. A semantic conflict returns `DESIGN_GAP` with no runnable/reusable action.

FULL is exceptional. If the PR change planner marks FULL required above the confirmed CI level, persist and present the exact reason, affected scope, estimated phases, time, and cost once. A confirmed FULL level remains runnable for later candidate repairs and reruns while the confirmed scope and risk remain unchanged. Scheduled, manual, and release FULL retain their separately invoked contract.

## 4. Design risk scan

`createDesignRiskScan` checks the exact canonical surfaces for cross-service fact ownership, pre-login identity/actor kind, permission role/grant provisioning, tenant/org/operator trace/audit, event durability/DLQ, migration ownership, and dependency cycles. Each sufficient result cites repository-relative canonical truth and one conclusion. A gap returns `DESIGN_GAP` with the exact surface and detail; the scan never writes design truth.

## 5. V2 verification topology

Each exact candidate has three non-substitutable layers:

1. DO/CO self-test for fast changed-scope feedback.
2. One stable visible RV subagent, independent of the owner, for design conformance, correctness, maintainability, simplicity, efficiency, robustness, security, and risk-selected tests. The same RV identity serially re-reviews later candidate generations.
3. CI with stable required status `Baseline Checks`.

When a PR candidate exists, RV and CI run in parallel. A CO candidate additionally requires scoped RV for each DO before integration and aggregate RV on the integrated candidate.

Applicable classes are static, unit, component, contract, integration, and critical business journey. Selection follows risk; every class is not run mechanically.

## 6. One public verification entry

Agents use one structured, shell-free entry. It records declared temporary inputs, exact argv, literal output and exit status, and emits the modified-artifact reference, binary patch, verification record, and Node rollback program:

```bash
scripts/collaboration-runtime/bin/oes-verify run --input VERIFICATION_RUN.json
```

Formal candidates require a clean exact-candidate worktree. Temporary verification assembly may contain only explicitly declared inputs such as dependency or Prisma links; NUL-delimited Git status rejects every undeclared dirty path, and declared directories are fingerprinted from their recursive names, entry kinds, link targets, and file bytes. These inputs do not redefine candidate cleanliness. The entry delegates to the existing test planner and package scripts rather than duplicating test logic.

## 7. Underlying commands

Focused runtime development:

```bash
pnpm collaboration-runtime:typecheck
pnpm collaboration-runtime:test
pnpm collaboration-runtime:static
```

Complete selected runtime gate:

```bash
pnpm collaboration-runtime:check
```

Repository change planning against an exact base:

```bash
pnpm test:plan -- --base BASE_SHA --head HEAD
```

Persist command text, literal output, exit status, candidate/base, environment identity, selected coverage, and resulting evidence fingerprint.

## 8. Failure routing

- Invalid/tampered evidence: regenerate from literal inputs.
- Missing evidence: schedule the required command at the current tier through `oes-verify`.
- Implementation or test failure: return to the exact DO or CO candidate owner.
- Frozen semantic conflict: return the pinpointed gap once through DA/UD while preserving delivery resources.
- Candidate/dependency movement: create a new affected matrix and reuse only exact still-applicable evidence.
