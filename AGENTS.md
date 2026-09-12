# OES execution baseline — Collaboration Framework V2

## 1. Authority

This file is the repository entry point. Product truth remains in `docs/architecture/`, `docs/adr/`, and `docs/contracts/`. The complete collaboration contract is `docs/governance/codex-execution-model.md`; document placement is governed by `docs/governance/document-governance.md`.

## 2. Architecture constraints

- Freeze boundaries before implementation for services, cross-service contracts/events, permission, tenant, shared abstraction, AI tool protocol, or operator context.
- Each service owns its data and business truth; do not share or directly read another service database.
- External clients enter through API Gateway/BFF; internal synchronous calls use gRPC; facts cross contexts through the event bus.
- Keep business rules out of controllers, gateways, DTOs, Prisma schemas, and protocol mapping.
- Domain code does not depend on NestJS, Prisma, or gRPC. `src/common` contains infrastructure and explicit shared contracts, not cross-domain business logic.
- AI changes state only through controlled tools, application services, authorization, confirmation, and audit. Carry applicable tenant, org, operator, trace, and audit context explicitly.

## 3. Active task roles

The complete active role set is **DA / UD / DO / CO / RV**. Human is the decision owner, not a task role.

- **DA — Discussion & Architecture:** continuing product/architecture discussion; reads canonical truth, evaluates options, and emits a bounded Proposal after confirmation.
- **UD — Unified Design:** the one active project UD independently audits DA Proposals against all current canonical truth and is the only canonical design writer.
- **DO — Delivery Owner:** owns one cohesive delivery from confirmed scope through implementation, in-scope repair, focused self-test, exact candidate, one PR when applicable, and terminal lifecycle disposal.
- **CO — Coordination Owner:** exists only for multiple independently ownable DO deliveries with real parallelism or cross-delivery integration; owns dependency order, integration, aggregate validation, and normally one aggregate PR.
- **RV — Review & Verification:** independently reviews an exact DO/CO candidate as one Human-viewable subagent retained across candidate generations; RV remains a role but is not a separate sidebar task.

Helpers are bounded execution mechanisms, not task roles or owners.

## 4. Routing and lifecycle

1. Read-only discussion creates no task, branch, worktree, Delivery Package (DP), candidate, or PR.
2. Before stateful work, classify scope, risk, design impact, and coupling; generate and validate one Proposal or Delivery decision card. One confirmation remains valid for the card's bounded scope and CI level.
3. Stable-design change follows DA → Human-confirmed Proposal → the unique UD audit/canonical write. Delivery begins from its own one-time confirmed card; mechanical Proposal and Delivery steps do not create additional confirmation gates.
4. Small, already-designed, or atomically coupled work uses one DO. Size alone never justifies CO.
5. Independent DO uses one candidate and one PR. CO integrates RV-approved DO candidates in dependency order and defaults to one aggregate candidate/PR. Independent DO PRs require an explicit Human-confirmed exception and independently releasable workstreams.
6. DO/CO self-test, independent RV, and CI are separate. Once a PR candidate exists, exact-candidate RV subagent review and CI run in parallel. CI's stable required context is `Baseline Checks`; change planning selects static, unit, component, contract, integration, and journey classes by risk.
7. PR-triggered FULL is exceptional. Disclose reason, scope, phases, and estimated cost once. A confirmed FULL level remains valid across repairs and reruns while the confirmed scope and risk do not materially change.
8. `origin/main` is remote truth. Fetch does not mutate shared local `main`; existing worktrees retain their base. Update/rebase only for an actual conflict, dependency change, or admission requirement, then rerun affected verification.
9. Exact task-owned cleanup is included in the confirmed Proposal or Delivery and runs automatically, child-first and fail-closed. Unknown, shared, active, dirty, ambiguous, or SHA-mismatched resources are preserved and reported for a Human decision. Cleanup cannot create a task, delivery, PR, merge, CI run, product fix, repository branch, or repository-content diff. Paused design resources are retained.

## 5. Implementation and evidence quality

- Reproduce or locate behavior, distinguish symptom/trigger/root cause/design gap/environment, then fix the correct boundary.
- Read exact merged truth and neighboring code first. Avoid hard-coded exceptions, duplicate logic, silent errors, hidden shared state, and unrelated refactors.
- Cover applicable correctness invariants, boundary/failure paths, concurrency/transaction/idempotency, security/tenant isolation, resource release, observability, migration, and rollback.
- New or rewritten functions/classes/services/handlers/repositories/guards/interceptors have a one-sentence responsibility comment.
- Use UTF-8; code identifiers and repository paths are English.
- A candidate records changed behavior, base/head SHA, structured commands and literal results with exit status, risks, rollback, PR/CI state, and the stable visible RV subagent identity. A controller-owned Human confirmation receipt—not a card self-hash or Boolean—is reopened for publication, Merge Queue admission, merge verification, and exact task-owned cleanup without repeated confirmation.
- Every DO owns one v3 Delivery Package (DP) in its stable artifact root; every CO owns one v3 Aggregate Delivery Package (ADP) binding the trusted confirmation receipt, confirmed complete child roster, child DPs, explicit external dependencies, dependency/order, integration contract, accepted candidates, aggregate candidate, canonical RV session/reviewer/history, aggregate RV/CI, merge, post-check, and cleanup state. The v3 bump makes the new required trust fields explicit rather than silently invalidating v2 wire state. A package change invalidates only affected evidence; completed evidence remains typed and exact-basis. Host-local DP/ADP records use the same schema with no Git, PR, Merge Queue, or remote CI fields. Agents use the repository thin verification entry rather than hand-maintaining evidence scripts.
- DO handles implementation defects, increased in-scope complexity, test/CI findings, and tool/environment problems itself. It returns one bounded issue to DA only for objective/acceptance change, canonical-design change, necessary delivery-topology change, or an active-owner conflict. DA decides whether to resume the original DO, replace it, or dispatch CO; a design gap routes DA → UD → DA. Only the affected slice pauses and existing artifacts are preserved.
- Mutating remote actions are serialized by an owner-local, binding-sealed lock covering read, mutation, and checkpoint; a live conflicting action fails closed, while a dead holder can be recovered without repeating a proven mutation. Merge Queue admission accepts a normally advanced `main` and validates the synthetic queue group instead of requiring the old integration base to remain the remote head. DO issue decisions carry the exact issue identity and fingerprint into DA replan decisions.
