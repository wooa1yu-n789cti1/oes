# OES Collaboration Framework V2

## 1. Purpose and authority

This is the canonical repository-wide role, routing, ownership, delivery, review, moving-main, and lifecycle contract. It deliberately minimizes owners and transitions while retaining independent design and candidate verification. Product architecture files remain authoritative for product behavior.

## 2. Roles

### 2.1 DA — Discussion & Architecture

DA owns continuing read-only product and architecture discussion for a coherent subject. It reads current truth, separates open questions from decisions, and after Human confirmation emits one bounded Proposal with problem, decisions, alternatives, protected scope, migration, affected truth sources, validation, rollback, and stop points. One DA can continue across related questions. DA does not write canonical design or product code.

### 2.2 UD — Unified Design

Exactly one project UD may be active. It independently audits an exact DA Proposal against current architecture, ADRs, contracts, and governance for repository-wide consistency, durable boundaries, migration impact, naming, and canonical placement. UD is the sole canonical design writer. Its queue remains derived from native Proposal/receipt history, FIFO, and single-flight; the current-UD binding is one replaceable identity, not a registry or history ledger. UD returns an exact accepted/revision-required/rejected result to the originating DA.

### 2.3 DO — Delivery Owner

DO owns one cohesive delivery from confirmed activation through implementation, in-scope repair, focused self-test, exact candidate, PR publication when applicable, candidate maintenance, and terminal disposal. Implementation defects, increased in-scope complexity, test/CI/RV findings, and tool/environment problems remain with the original DO. Only objective/acceptance change, canonical-design change, necessary delivery-topology change, or active-owner conflict returns once to DA; only the affected slice pauses and all exact resources are preserved. DA decides resume-original-DO, replacement DO, or CO. A canonical gap follows DO → DA → UD → DA. DO never dispatches DO or CO. One DO produces one candidate and one PR.

### 2.4 CO — Coordination Owner

CO is used only when at least two workstreams are independently ownable and real parallelism or cross-delivery integration exists. It freezes decomposition, write sets, dependency order, acceptance, and integration behavior; each workstream has one DO. After scoped RV, CO integrates exact candidates in dependency order and normally creates one aggregate candidate and one aggregate PR. An explicit Human-confirmed exception may choose independent DO PRs only when every delivery is independently releasable. Merge Queue is an admission mechanism, not a substitute for integration ownership.

### 2.5 RV — Review & Verification

RV is independent of the candidate owner and reviews an exact SHA or host-local operation. A single DO binds one Human-viewable RV subagent identity and reuses it serially across candidate generations; a failed lookup never authorizes a duplicate. It verifies DA/UD design conformance, correctness, maintainability, simplicity, efficiency, robustness, security, and risk-selected tests. RV reports bounded findings to the exact owner and does not redesign architecture after implementation. Each CO-owned DO candidate gets scoped RV; the integrated candidate gets aggregate RV, also as visible subagents.

Human chooses direction and confirms material decisions but is not a task role. Adding a role requires proof that the responsibility cannot be held by one of these roles and removal of equivalent complexity.

## 3. Routing

Read-only discussion creates no delivery resources. Before stateful work, classify stable-design impact, cohesive acceptance, write-set coupling, dependencies, risk, and genuine parallelism, then show one exact recommendation:

- Design-changing: DA → confirmed Proposal → UD → confirmed delivery activation.
- One cohesive/atomic/already-designed change: one DO, regardless of size or helper count.
- Several independently ownable deliveries needing coordination: one CO plus two or more DOs.

Human confirmation is required for a real decision, not a process checklist. A card is a preview, not proof of confirmation: the native controller records one exact `HumanConfirmationReceipt` beneath the profile-derived read-only authorization root. The card carries a material-decision fingerprint over project, objective, scope, protected scope, acceptance, integration contract, risk, design impact, independent-PR exception, CI ceiling, and stop point. Routing, continued execution, DP/ADP activation, FULL planning, and every remote action reopen that receipt plus its exact card; a caller-computed card hash or Boolean is never confirmation. One generated Proposal card covers UD audit, canonical write, Design PR publication, RV/CI of the exact design candidate, Merge Queue admission, merge verification, and exact task-owned cleanup. One generated Delivery card covers only actions applicable to its execution mode and PR topology: repository delivery includes implementation, in-scope repair, RV, selected CI, PR publication, Merge Queue, merge verification, post-check, and cleanup, while host-local delivery excludes PR, CI, and merge actions. Candidate repair, rerun, task creation required by an already confirmed topology, merge, and cleanup do not create new gates. Reconfirm only for a material fingerprint change, increased CI level, or destructive action against an unowned or ambiguous resource.

## 4. Identity, visibility, and ownership

DA, the unique UD, DO, and CO are Human-visible project tasks with role-first titles and exact parent/subject binding. The current UD is read from the single `current-ud.json` path under the verified project authorization root; agents have no bind-current-UD command, so choosing another caller directory cannot create another project UD. RV is a Human-viewable subagent with one canonical session path, exact stable reviewer identity, append-only candidate-generation history, and immutable verdict; PASSED and FAILED results both bind that session, and later DP/ADP generations preserve it. Bounded helpers may use hidden transport. A work item and artifact have exactly one current owner. Notification is not ownership transfer. Replacement follows verified termination of the old owner; it never duplicates owners.

Repository deliveries use an owner-exclusive clone/ref plus durable artifact root and task-local scratch. Each DO records one Delivery Package (DP) in that stable artifact root; each CO records one Aggregate Delivery Package (ADP) binding child DPs and the exact aggregate candidate. Host-local operations use the same package schema with no Git resources unless they modify the repository. Owner profile, task, repository, transition, credentials, permissions, and resource binding are read back before role-owned writes. Drift repairs the same owner.

## 5. Design flow

1. DA discusses against latest canonical truth without writes.
2. Human confirms one exact Proposal card.
3. DA emits the immutable Proposal to the bound unique UD.
4. UD audits and, when accepted, writes canonical truth and a Design PR.
5. If UD accepts without a material revision, the confirmed Proposal continues through Design PR, Merge Queue, merge verification, and exact Proposal cleanup.
6. After successful design merge/baseline, one Delivery card activates implementation; its confirmation persists through the bounded delivery lifecycle.
7. A delivery-discovered design gap pauses only the affected work, returns through DA/UD, preserves current delivery resources, and resumes the same owner after truth merge.

## 6. Delivery and PR topology

A DO records objective, base SHA, write/protected scope, dependencies, acceptance, candidate SHA, self-test evidence, RV result, PR/CI state, remaining risk, and rollback. Bounded helpers return typed results; they never become owners.

A CO records independently ownable workstreams, dependency order, frozen integration contracts, scoped RV results, and aggregate acceptance. It integrates exact candidate SHAs without rewriting accepted history. Default output is one `codex/coordination/<key>` aggregate branch, candidate, and Draft PR. Independent PR mode is a confirmed exception, not the default.

All repository PRs target `main`, begin Draft, prohibit direct pushes to `main`, and use merge commits through Merge Queue. Direct merge is not an agent-facing capability. Merge and exact task-owned cleanup remain distinct execution stages but are not separate Human decisions when the confirmed card still applies.

## 7. Verification and CI

Verification has three non-substitutable layers:

1. **DO/CO self-test:** fastest changed-scope feedback.
2. **RV:** independent review and risk-based local verification on the exact candidate SHA.
3. **CI:** authoritative reproducible remote verification on PR and merge-group candidates.

After a PR candidate exists, RV and CI run in parallel. Applicable classes are static, unit, component, contract, integration, and critical business journey; risk determines selection. Evidence reuse requires identical candidate, inputs, dependencies, toolchain, environment, command, and still-applicable coverage.

`CI / Baseline Checks` is the stable required status. Change planning selects `DOCS`, `SCOPED`, or `FULL`. A PR-triggered `FULL_REQUIRED` result blocks expensive execution until the Human sees exact reason/scope/estimated phases and cost and confirms FULL once. That confirmation binds the material-decision fingerprint and remains valid across candidate repair generations and reruns. A higher CI level or material fingerprint change requires a new decision. Scheduled FULL may run silently at its cadence; manual/release FULL is already explicitly invoked.

RV findings and failed CI are routed to the candidate owner. Infrastructure-only retry is bounded and tied to the same run/job/SHA. Product failures change the candidate and invalidate affected evidence.

## 8. Moving main

`origin/main` is canonical. Owner creation fetches/prunes but never automatically fast-forwards a shared local `main` checkout. Existing owner work retains its bound base. Peer merges do not rewrite it. Rebase/update happens only for an actual conflict, changed dependency contract, or admission requirement; only affected verification is repeated. Merge Queue validates the synthetic current-main merge group. Local-main fast-forward is an explicit safe convergence action requiring a clean checkout and no active dependency on its current position.

## 9. Lifecycle disposal

Cleanup is disposal, not delivery or defect discovery. Its executable is isolated from routing, task creation, product writes, PR publication, merge, and CI. The authorization binds terminal state and each exact owner ref/clone/worktree/scratch/DP resource, including CO-owned aggregate resources. Each filesystem component is inspected without following links and reopened as the same canonical physical path, so existing-target, dangling-leaf, dangling-ancestor, or substituted identities are preserved rather than removed. Repository-mode package cleanup observes Git status directly from the reopened owner repository with explicit worktree/Git-directory arguments and a controlled environment that excludes inherited Git repository, index, discovery, and configuration overrides; caller-authored empty diffs are not proof. Host-local package cleanup performs repository membership discovery with the same controlled environment and proves that its stable artifact root is outside every Git repository. Cleanup permits no branch and no repository-content diff; DP/ADP files are external stable artifacts.

For one DO, the lifecycle planner reopens its exact DP and RV session, terminates the RV subagent first, verifies exact resource cleanup, and archives the DO only from a controller-owned cleanup-result reference after the DP itself is gone. For CO work, dispose deepest bounded helpers/RV subagents, then DOs, aggregate RV, and CO. Exact task-owned disposal is automatic under the existing confirmation. A task archives only after every child is terminal and all exact resources are verified absent. The protected lifecycle inventory binds and reopens one sealed cleanup result set containing every DO and CO resource result plus the observed repository diff; caller Booleans or a scalar `VERIFIED` label never enable archive actions. Unknown, shared, active, dirty, missing-observation, physical-alias, or SHA-mismatched resources are preserved and reported for a Human decision. A partially completed retry skips exact verified results and retries only failed identities. Paused design is checkpointed and retained.

## 10. Commands and confirmation contract

<!-- BEGIN OES_COLLAB_COMMANDS_V2 -->

Read-only examples:

- “Discuss the account-context boundary.”
- “Show the current delivery/RV/CI status.”
- “Pause this owner and preserve its resources.”

Only a new Human decision produces one generated and schema-validated concise card:

```text
Decision: <proposal | delivery>
Project / execution mode: <project key | repository or host-local>
Objective: <human-readable objective>
Owner topology: <DA→UD | one DO | CO + N DOs>
Scope / protected scope: <bounded summary>
Risk / design impact / coupling: <summary>
PR topology: <one Design PR | none | one DO PR | one aggregate CO PR | confirmed independent exception>
Verification: <self-test + exact-candidate RV + Baseline Checks; FULL disclosure if applicable>
Stop point: <exact next boundary>
Continuous authorization: <covered actions and approved CI level>
Reconfirm only if: <material objective/design/risk/scope change or unowned/ambiguous destructive resource>
Confirm this exact card? <yes/no>
```

Internal binding retains the controller-owned confirmation receipt, task IDs, refs, worktrees, full SHAs, Proposal/candidate/finding IDs, state version, and transition; the Human does not repeat them. Immediately before execution, reopen the receipt and binding and refresh the card only if material truth changed.

The card binding is reopened before each covered stage. Candidate generation changes invalidate affected evidence, not the confirmation. Merge Queue bindings still bind exact PR head(s), order/topology, required CI, RV result, and the synthetic current-main merge group; ordinary advancement of `main` is validated by queue ancestry rather than treated as a new Human decision. Cleanup bindings still bind terminal owners and exact resources and assert zero new task/PR/merge/CI/product-fix/repository-diff capability; these are execution proofs, not additional confirmation cards.

<!-- END OES_COLLAB_COMMANDS_V2 -->

## 11. Completion

A delivery candidate is stable when its DP activation fields and scope/design conformance are exact, every bound design/DA/UD reference is reopened and byte-hash verified, focused self-test passes, Draft PR exists when repository mode applies, remote CI state is known when applicable, modified artifact/patch/verification/rollback are reopened, remaining risks are explicit, and the stable visible RV subagent is bound. Completed self-test/RV/CI/post-check evidence is reopened through typed exact applicability, not inferred from a package status. A CO aggregate candidate additionally requires an ADP, a complete confirmed child roster with explicit external dependencies, and exact ADP-plus-candidate Aggregate RV input; reopening the ADP reopens every child DP and its design bytes and checks the aggregate material-decision fingerprint against the complete roster and acceptance. PR summaries are generated within every heading of the repository PR template without embedding the active DP/ADP. Covered stages continue automatically until terminal disposal unless a defined material decision boundary is reached.
