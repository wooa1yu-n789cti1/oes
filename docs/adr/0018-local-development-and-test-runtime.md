# ADR 0018: Local Development And Test Runtime

```text
status: ACCEPTED
decisionDate: 2026-09-06
architectureTruthSource: docs/architecture/platforms/local-development-and-test-runtime.md
implementationState: IMPLEMENTED
stateLayoutExtension: DESIGN_ACCEPTED_PENDING_IMPLEMENTATION
```

## Context

OES 原本的本地运行时把 worktree identity、Compose project、generated root/service `.env`、固定
host port 和 current-directory dotenv discovery 绑定在一起。Focused test 与开发环境因而可能
复制完整 Compose project、竞争端口、遗漏 `DATABASE_URL`、复用过宽 credential，或在失败后留下
无法精确归属的资源。Managed test path 还混用了 committed migration 与 `prisma db push`，使本地
结果与 CI/schema truth 不一致。

OES 同时需要保持既有架构边界：local business service 继续作为 host process；Docker 只提供
基础设施；每个服务独占数据库与 business truth；内部同步、事实传播、workload trust、测试分类
与 CI governance 不因本地并发而改变。

首个 V2 implementation 已移除受支持路径中的 Compose lifecycle，却仍使用 flat machine/shared/leases/
runs state layout，并以一个 `devStackId` 同时关联 DEV 与 shared TEST provider。若把 logical Stack 误作
Docker Compose Project、复制 Stack/Run manifest payload，或在 bind-mounted state root 上执行无 journal
的目录切换，会重新引入 coarse ownership、双重 authority 与不可确定 rollback。

## Decision

采用统一 local development/test runtime：

1. 一个 launcher 和 orchestration core 同时服务 `DEV`、`LOCAL_INTEGRATION` 和 `CI`。
2. 每台机器最多一个完整 long-lived `DEV` stack；并行 task 只启动 selected test 需要的最小
   service/provider 集合。
3. `DEV` 使用 machine-shared provider；local Integration 共享物理 TEST PostgreSQL/MinIO 并获得
   per-run logical resource，其他 provider 按声明临时创建；CI provider 全部 job-private。
4. `devStackId` 绑定 shared provider，`taskKey + runId` 绑定 ephemeral/logical resource；worktree
   不构成 runtime ownership。
5. Host port 动态分配并由 Docker published mapping 授权；readiness 后才发布 endpoint。
6. Launcher 从 versioned defaults、machine-local config、profile、explicit argument 和 dynamic
   allocation 构造 in-memory configuration，并向每个 host process 显式注入 minimal environment。
7. Shared physical provider 使用 per-service/per-run ACL、credential 和 namespace；administrative、
   migration 与 runtime authority 分离。
8. Managed DEV/TEST/CI 只应用 committed migration，通过 `prisma migrate deploy` 建立 schema；
   `db push` 不产生 accepted evidence。
9. Real-infrastructure local run 默认最多并发两个，使用现有 lease primitive 实现 FIFO semaphore，
   不引入 resident scheduler service。
10. Runtime 通过 business-neutral A0 验证 isolation、readiness、manifest/evidence binding、normal/
    abnormal cleanup、CI reproduction 和 rollback。
11. Main 以一个候选原子切换所有 supported entry、CI internal path、configuration、test 和 runbook；
    不保留 active legacy/v2 mode。
12. Implementation candidate 在切换前只读盘点并分类现有 OES Compose project/container/network/
    volume，交付 deterministic dry-run、sealed exact-identity cleanup plan 和 residue check；真实主机
    删除只在独立 Human-confirmed Cleanup boundary 执行。
13. 每台 developer machine 恰有一个 machine-shared `LOCAL` logical Stack，包含 DEV provider 与 shared
    TEST PostgreSQL/MinIO；CI 只使用 job-private state/provider。Logical Stack 是 launcher state/ownership
    boundary，不是 Docker Compose Project。
14. V2 不保留、创建或重建 local Compose project；launcher、exact Stack/Run manifest、lease 与
    `oes.runtime.*` label 是唯一 Docker lifecycle authority。现有 Compose project `oes` 是 legacy
    inventory，只在 migration/restore acceptance 后通过独立 Cleanup confirmation 删除。
15. Machine root、Stack root 与 Run root 使用固定层级；sealed Stack generation manifest 与 Run manifest
    各自只拥有一个 scope，cross-scope join 只保存 absolute path、SHA-256、semantic fingerprint 与 type，
    不复制 mutable payload。
16. Developer identity 使用 persisted 32-byte CSPRNG seed 与 byte-exact domain-separated SHA-256；
    `stackKey=oes-local-<machineFingerprint>` 只作为 registry/state key。CI 使用独立 job-private seed 与
    `oes-ci-<jobFingerprint>`，不进入 developer-machine registry。
17. State-layout activation 使用 same-filesystem sibling tree、parent-scope sealed journal、bind-aware
    provider quiescence 和 `PREPARED -> OLD_MOVED -> NEW_PLACED -> COMMITTED` recovery。Design merge 无
    live effect；actual command 与 executable runbook 由后续 implementation candidate 同时交付。

完整 profile、provider、lifecycle、permission、migration、A0 和 rollback contract 以
[Local Development And Test Runtime](../architecture/platforms/local-development-and-test-runtime.md)
为准。

## Consequences

### Positive

- 并行 task 的隔离单位从 worktree/Compose proliferation 收敛为显式 `taskKey + runId` resource。
- Shared PostgreSQL/MinIO 降低本地资源成本，同时 logical database/user 和 bucket/credential 保持
  cross-run isolation。
- Local 与 CI 复用 planner/orchestrator，减少 implicit environment 与手工 topology drift。
- Dynamic port、atomic manifest publication、readiness gate 和 exact cleanup 消除固定端口碰撞及
  stale resource 的 broad deletion 风险。
- Committed migration、service-scoped credential 和 denial matrix 使 schema 与 access evidence 可
  重现、可审计。
- Logical Stack 与 Docker Compose Project 解耦，避免 Docker UI grouping 成为 coarse lifecycle authority；
  Stack/Run manifest 分权与 reference-only join 消除重复状态真相。
- Byte-exact machine/job identity 与 journaled root activation 使 naming、copy detection、crash recovery 和
  rollback 可由独立实现重现。

### Cost and risk

- Cutover 必须同时迁移当前 pnpm/CI entry、dotenv、Compose lifecycle、fixed-port test、migration、
  seed/fixture 和 runbook；部分切换会制造两个 authority，因此不被接受。
- 现有主机可能同时包含有效 DEV data、active owner resource、idle legacy residue 和无法证明归属的
  object；新 launcher 可用不等于这些资源已安全 reconcile。
- Shared TEST provider 需要可靠的 logical provisioning、lease reconciliation 和 per-run denial；
  仅有名称前缀或 numeric Redis DB 不构成隔离。
- Dynamic endpoint 要求全部 host process 通过 manifest injection 启动；直接执行依赖 stale `.env`
  的 service command 将在切换后 fail closed。
- A0 不证明业务 Journey 完整，existing incomplete production chain 必须继续由其 owner 独立关闭。
- State-layout activation 必须在无 active Run/Stack lease、bind-mounted provider 已安全停止且 snapshot
  已验证时执行；必要 provider replacement 会增加 migration/rollback evidence 成本。

## Alternatives rejected

### One complete Dockerized OES stack per task

拒绝。资源成本过高，并违背 local host-process business-service model。

### One shared mutable test database, bucket, or subject namespace

拒绝。它没有 cross-run authorization boundary，会产生 nondeterministic concurrency。

### One complete temporary infrastructure stack per test

拒绝。启动成本与 provider 数量不随 selected dependency 收敛。

### Fixed host ports

拒绝。并发 worktree、stale container 和其他本机进程都可产生 collision。

### Worktree-derived ownership and copied service `.env`

拒绝。Code checkout 不是 execution identity；copied dotenv 会产生 stale/ambiguous binding。

### Long-lived legacy and V2 runtime modes

拒绝。双路径会永久分裂 entry、CI、migration、test 和 runbook authority。

### Retain a local Compose project for logical Stack grouping

拒绝。Compose project 是 coarse UI/lifecycle grouping，无法表达 exact Stack/Run ownership；与 launcher、
manifest、lease 和 `oes.runtime.*` label 并存会形成第二 authority。

### Business journeys as A0

拒绝。当前 production chain 不完整；以它们验证 runtime 会把 infrastructure acceptance 变成
business debugging，也可能用 fake 错报 Journey complete。

## Migration and rollback

Implementation 可在 isolated candidate 中验证，`main` 在合并前继续执行当前 runbook。Cutover
candidate 必须对 runtime/configuration/entry 做 repository-wide zero-reference check，先备份 DEV
data，重建 disposable TEST data，交付一次性 legacy host-resource inventory/reconciliation tool、
dry-run、sealed cleanup plan、rewritten runbook 与 residue check，并在 exact candidate 上完成
self-test、A0、independent RV 和 `CI / Baseline Checks`。合并需要之后独立的 Human confirmation。

State-layout extension 的 Design PR 只更新 architecture 与本 ADR，不声明尚不存在的 executable command。
后续独立 delivery 先修复并验证 migrator authority 不进入 host business process environment，再交付
layout implementation、actual command、failure-injection test、rollback 与 runbook update。Activation 在
machine migration lock 下要求 active Run/Stack lease 为零，停止所有 state-root bind-mounted provider，
sealed old state/DEV-data snapshot，并以 parent-scope journal 驱动 same-filesystem root swap。Durable
`COMMITTED` 前 old root 是 authority；之后 new root 是 authority。中断恢复按 journal exact path 幂等
恢复，不保留 dual-read/dual-write 或 persistent generation selector。

现有 V2 shared name/object identity 在 Design 阶段不变；delivery 不为命名或 Docker Desktop 展示而替换
healthy object。任何必要 replacement 都记录 exact old/new mapping。Target path、object、credential 或
manifest generation 变化使旧 restore binding 失效；new-root verification 后必须形成新的 exact restore
plan/binding 并停在独立 Restore confirmation。

实际删除主机上的 confirmed-idle legacy OES resource 是后续独立 Cleanup confirmation boundary。
Apply 前必须重开 exact Docker identity/labels/state/attachment/owner evidence；active、unknown、shared、
dirty、mismatched 或证据不足资源保留并报告。最终 migration acceptance 要求 confirmed-idle legacy
resource 归零，且每个保留项都有 exact identity 与理由；Design/implementation delivery 不能借
cutover、startup 或 merge 自动删除历史资源。

Legacy Compose project `oes` 及其 positively proven container/network/volume/init-mount 仍遵守该边界；
V2 不保留或重建同名/替代 Compose project。Cleanup 前完成 V2 acceptance、适用的数据 restore 验证和
exact deletion-set reopen；unknown、active、shared 或证据不足对象继续保留。

Design rollback 是 whole-candidate Git revert，且没有 live effect。Implementation rollback 在 durable
`COMMITTED` 前隔离 uncommitted new root、恢复 sealed old root 和 retained provider；之后若验证失败，
停止 exact new object、保留 failure evidence，再按 journal 恢复 old root。若 DEV migration/seed 已影响
持久数据，则同时恢复 source-bound snapshot；不得选择性恢复 legacy entry、generated `.env` 或
fixed-port path。

## Related documents

- [Local Development And Test Runtime](../architecture/platforms/local-development-and-test-runtime.md)
- [Testing And CI](../architecture/platforms/testing-and-ci.md)
- [Event Bus And Outbox](../architecture/platforms/event-bus-and-outbox.md)
- [Trusted gRPC And Execution Context](../architecture/platforms/grpc-metadata-and-service-trust.md)
- [Observability And Audit](../architecture/platforms/observability-and-audit.md)
