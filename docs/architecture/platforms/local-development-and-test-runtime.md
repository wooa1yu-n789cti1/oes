# Local Development And Test Runtime

```text
status: STABLE
decision: docs/adr/0018-local-development-and-test-runtime.md
currentExecutableRunbooks: docs/runbooks/index.md
```

本文是 OES 本地开发与测试运行时的唯一平台架构真相源。它定义运行形态、环境配方、
依赖选择、资源身份、machine/Stack/Run state layout、配置注入、权限、schema bootstrap、并发、
验证和原子切换；业务服务边界、测试分类、消息语义、gRPC 信任和可观测性语义仍分别由其
现有真相源拥有。

仓库的受支持入口、CI 内部路径与现行 runbook 统一执行本文运行时。旧 Compose、生成式
service `.env` 与独立测试基础设施入口已经从受支持路径退役，不构成第二个运行模式。

## 1. Runtime shape and invariants

- 本地开发和 focused local test 的业务服务是 host process；Docker 只承载基础设施。
- 每台机器最多存在一个完整、长生命周期的 OES `DEV` 业务服务栈。
- 每台 developer machine 恰有一个 machine-shared `LOCAL` logical Stack；它包含完整 DEV provider
  与 shared TEST PostgreSQL/MinIO，但 logical Stack 不是 Docker Compose Project。
- 并行任务通常只执行选中的测试以及测试所需的最小业务服务集合，不创建完整 OES 栈。
- 并发增加不构成把 host service 迁入 Docker 的理由。
- 外部 client 仍只进入 API Gateway / BFF；内部同步调用仍使用 gRPC；跨 context fact 仍经
  NATS。运行时编排不得改变业务调用边界。
- 每个服务仍独占自己的数据库、schema、migration、seed/fixture 语义与 business truth。
  服务不得读取或写入另一个服务的数据库。
- 每个环境只有一个 Permission database，由 Permission Service 独占；其他服务不建立自身的
  Permission database 或 Permission truth 副本。
- V2 Docker lifecycle 只由 unified launcher、exact Stack/Run manifest、lease 与 `oes.runtime.*`
  label 共同授权；Docker Desktop grouping 只用于展示，不构成 owner 或 cleanup authority。

## 2. Runtime profiles

Profile 是 launcher 内部的运行配方，不是由开发者按服务或测试任意扩展的环境矩阵。
`FULL` 只表达测试计划广度，不是第四个 profile，也不启动一个巨型并发栈。

| Profile | Physical provider scope | Business processes | Intended use |
| --- | --- | --- | --- |
| `DEV` | 机器级、长生命周期、由 `devStackId` 绑定 | host process；一台机器最多一个完整 stack | 日常本地开发 |
| `LOCAL_INTEGRATION` | 共享 TEST PostgreSQL/MinIO；其余按 run 临时创建 | 仅选中测试所需的 owner service 和 production chain | focused local Integration/Journey |
| `CI` | 每个 CI job 私有 | 仅计划选择的 service/process | PR、merge-group、main、scheduled/manual/release CI |

### 2.1 DEV recipe

`DEV` 包含共享 DEV PostgreSQL、Redis、NATS/JetStream、MinIO、Nacos+MySQL、完整
Observability stack，以及稳定的 local CA 和每服务证书。业务服务由 launcher 作为 host
process 启动。

### 2.2 LOCAL_INTEGRATION recipe

- 共享、长生命周期的 TEST PostgreSQL 和 TEST MinIO 是 local test 的物理 provider。
- 每个 run 获得唯一 database/user 与 bucket/credential；这些逻辑资源不跨 run 复用。
- NATS/JetStream、Redis 和 mTLS material 仅在选中测试需要时按 run 临时创建。
- OTel Collector 或 Nacos+MySQL 只为显式 trace-specific / Nacos-specific 测试临时创建。
- TEST provider 与 DEV provider 物理分离；TEST data 可丢弃并重建。

### 2.3 CI recipe

CI 使用与 local 相同的 dependency planning 和 orchestration core，但 PostgreSQL、MinIO、
NATS、Redis、certificate material 以及其他被选择 provider 的物理实例全部 job-private。
CI 不借用 developer machine 的共享 provider、lease 或 credential。

`DEV` 与 `LOCAL_INTEGRATION` 是同一个 machine-shared `LOCAL` logical Stack 中的不同 provider
pool，不是两个 long-lived Stack。CI 仅在 exact job-local state root 中使用 job-private key、
manifest 和 provider；它不进入 developer-machine Stack registry，也不成为 resident local Stack。

## 3. Test-class execution semantics

测试分类和 CI 选择仍以 [Testing And CI](./testing-and-ci.md) 为准。本运行时只冻结每一类的
资源语义：

| Class | Runtime boundary |
| --- | --- |
| Unit | 无真实基础设施、无真实网络。 |
| Component | 无真实基础设施；外部系统和其他服务使用 fake/stub/in-memory sink。 |
| Contract | 默认无真实基础设施；若协议本身需要进程，只启动最小 protocol process。 |
| Integration | 启动一个 owner service 及其真实必要依赖。 |
| Journey | 仅启动已经存在且可执行的 production chain；fake 不能使 Journey complete。 |

普通 Unit、Component、Contract 保持并行。需要真实基础设施的 local run 使用机器级可配置
并发上限，默认 `2`；超出上限的 run 通过现有 lease primitive 实现的跨进程 FIFO semaphore
等待，不引入 resident scheduler service。

## 4. Dependency planning

统一 launcher/test planner 从以下输入确定 capability 和 process/provider 集合：

1. test class；
2. test owner；
3. pnpm workspace dependency graph；
4. [Testing And CI](./testing-and-ci.md) 所述的 versioned cross-service relationship table。

Relationship table 只记录静态 graph 无法表达的关系，包括 Proto/event consumer、共享资源、
runtime capability、serial group、risk tag 和 executable critical journey。每个真实资源需求都
必须能追溯到 owner 或版本化声明。

Unknown owner、冲突声明或 ambiguous resource need 以 declaration gap fail closed；planner
不得以“启动全部服务/基础设施”作为 fallback。Nacos-specific 和 trace-specific 测试必须显式
请求对应临时 provider。只有 production chain 已存在并可执行时，relationship table 才能把
它登记为 Journey。

这里的 runtime fail-closed 不改变 CI change planning 的 `FULL_REQUIRED` 规则：未知 change
mapping 可以要求扩大验证计划，但扩大计划仍不能用 undeclared runtime dependency 启动任意
资源。

## 5. Identity, state authority, and Docker lifecycle

### 5.1 Stable identities

| Identity | Meaning | Resource binding |
| --- | --- | --- |
| machine identity | launcher 一次生成并持久化的 32-byte CSPRNG seed | machine registry、copy detection、`machineFingerprint` |
| `stackKey` | `oes-local-<machineFingerprint>`；只用于 machine registry/state path | 一个 machine-shared `LOCAL` logical Stack |
| `devStackId` | 一台机器的长生命周期 DEV/TEST provider set | shared provider、稳定端口、machine-local runtime material |
| `taskKey` | 当前 DA/UD/DO/CO/RV task 的 accountable metadata | run ownership/audit context；不是 worktree identity |
| `runId` | 一次执行 | ephemeral resource、logical TEST allocation、evidence |

Worktree、branch、filesystem path 或 Compose project name 不推导 resource ownership。共享
provider 绑定 `stackKey + devStackId + pool + provider`；ephemeral resource 绑定
`taskKey + runId`。Machine registry 对 `stackKey` 与 immutable internal `devStackId` 实行一对一
映射；`stackKey` 不是 Compose project name，也不授予 Docker prefix cleanup。

`machine-identity.json` 固定包含 `schemaVersion`、`kind`、`seedEncoding=lowercase-hex`、64 个小写
hex 字符的 seed、`fullDigest`、`machineFingerprint`、`hostBindingKind` 与 `hostBindingHash`，文件模式
为 `0600`。`fullDigest` 是以下 exact bytes 的 SHA-256：

```text
UTF8("oes-runtime-v2-machine") || NUL || UTF8("v1") || NUL || decodeHex(seed)
```

Registry 保存完整 64-character lowercase digest，`machineFingerprint` 取其前 16 个字符。
`hostBindingHash` 对 versioned stable platform machine identifier 做 domain-separated SHA-256；hostname、
username、worktree、task/title、`taskKey` 与 `runId` 都不进入 machine identity。Host binding 不匹配时，
launcher 在 registry、Stack 或 Docker mutation 前 fail closed；rebind/rekey 是后续显式操作，并要求
active Run 与 Stack lease 均为零。Short fingerprint 相同而 full digest 不同同样 fail closed，不自动
增长 suffix 或重命名。

CI 在 job-local state root 内生成独立 32-byte CSPRNG seed，并以相同 byte contract、domain
`oes-runtime-v2-ci-job` 计算 16-character `jobFingerprint`。`oes-ci-<jobFingerprint>` 只在 exact job
内稳定和可重开；它从不进入 developer-machine registry，并由 job manifest 的 exact reconciliation
删除。

### 5.2 Machine, Stack, and Run layout

Configured `stateRoot` 是 machine root，规范布局为：

```text
<stateRoot>/
├── machine-identity.json
├── stack-registry.json
├── schema-version.json
├── semaphores/
├── locks/
└── stacks/
    └── <stackKey>/
        ├── stack.json
        ├── current-manifest.json
        ├── providers/
        │   ├── dev/
        │   └── test/
        ├── credentials/
        ├── leases/
        ├── manifests/
        │   └── <generation>.json
        ├── restore/
        ├── evidence/
        └── runs/
            └── <taskKey>/
                └── <runId>/
                    ├── transaction.json
                    ├── manifest.json
                    ├── credentials/
                    ├── provider/
                    ├── processes/
                    ├── events.ndjson
                    ├── evidence/
                    └── cleanup.json
```

Machine root 只保存 machine identity、Stack registry、global schema version、global FIFO semaphore、
global exclusive lock 与 `stacks/`。Provider data/credential、lease、manifest、restore state 和 execution
evidence 不直接放在 machine root。所有 key 在形成 path 前必须通过 versioned path-safe validation；
path escape、symlink substitution、duplicate `stackKey`/`devStackId` 或 registry/root mismatch 都在 mutation
前 fail closed。

每一层只拥有自身 scope 的 truth：

- `<stackRoot>/manifests/<generation>.json` 是该 generation 的 shared provider object ID、volume、published
  endpoint、credential reference、lease、readiness 与 `devStackId` 的唯一 Stack manifest authority；
- `<stackRoot>/current-manifest.json` 只保存 generation、absolute canonical path、SHA-256 与 manifest
  fingerprint，并原子指向一个 sealed Stack manifest；
- `<runRoot>/manifest.json` 是 `taskKey`、`runId`、logical/ephemeral resource、process、transaction 与
  cleanup 的唯一 Run manifest authority；它只通过 generation、absolute path、SHA-256 与 fingerprint
  引用 exact Stack manifest，不复制 shared-resource payload；
- `<stackRoot>/evidence/` 只保存 Stack provisioning、migration、restore 与 Stack-lifecycle evidence；
  `<runRoot>/evidence/` 只保存该 Run evidence；
- Cross-scope index 只可保存 canonical path、SHA-256、semantic fingerprint、type 与 lifecycle status，
  不复制 mutable manifest/evidence payload。

Delivery Package、backup、Proposal、RV evidence 与 collaboration lifecycle evidence 继续位于 runtime
state root 之外的 stable artifact root。Runtime 只按 absolute canonical path、file SHA-256、存在时的
semantic fingerprint 和 exact role/type 引用它们；外部 artifact 不成为 runtime ownership authority。

### 5.3 Docker identity and naming

V2 不创建、保留或重建 local Docker Compose Project，也不合成 `com.docker.compose.*` label。
Unified launcher、active Stack/Run manifest、exact lease 与下列 `oes.runtime.*` identity label 是唯一
lifecycle authority：runtime version、Stack key/ID、task/run ID、scope、pool、provider 与适用的 CI job
identity。缺少 exact manifest/lease join 时，name、prefix、Compose label、stopped state 或 Docker Desktop
分组只构成 discovery evidence。

- 当前 V2 shared object 的 exact name 与 object ID 在 state-layout delivery 前保持不变；
- 新建或必须替换的 shared object 使用
  `oes-v2-<devStackIdToken>-<pool>-<provider>`；
- Local Run object 使用
  `oes-v2-<exactResourceToken(taskKey + ":" + runId)>-<provider>`；
- CI object 使用
  `oes-v2-ci-<jobFingerprint>-<exactRunToken>-<provider>`。

Docker name 只允许 lowercase ASCII letter、digit 和 hyphen。`devStackIdToken` 在截断可能丢失 exact
identity 时携带 digest；Run token 以可读 bounded prefix 加完整 `taskKey:runId` UTF-8 preimage 的
SHA-256。完整 `devStackId`、`taskKey`、`runId`、job identity、scope、pool 与 provider 始终保留在
manifest 和 label。Launcher 在 Docker mutation 前验证最大长度与唯一性，任何 ambiguity 都停止
admission。Operator status 从 manifest/label join 投影为 `SHARED`、`RUN`、`CI`、`LEGACY` 或 `UNKNOWN`，
不以 Docker UI grouping 代替状态真相。

### 5.4 Allocation transaction

Launcher 使用 exclusive lock 完成需要串行化的 identity、port 和 logical-resource allocation。
启动事务在 exact Stack/Run transaction 与 lease record 中保存尚未发布的 partial progress；只有
dependency readiness 成功后，资源才进入 registered 状态并发布可消费的 active Stack pointer 与
Run manifest。Allocation 与最终 publication 对 consumer 是原子的：consumer 不会看到包含未 ready
endpoint 或跨 generation payload 的有效 manifest。

同一 manifest/lease record 支持正常失败与 abnormal interruption 的 reconciliation path。
Manifest 至少记录 profile、`devStackId`、`taskKey`、`runId`、owner、endpoint、resource identity、
process identity、lease、credential reference 和 evidence reference；它不包含 credential value。

### 5.5 Lease and cleanup

- Shared provider 使用 lease/reference count；只有不存在 active lease 时才允许停止。
- 一个 run 只释放 manifest 证明属于自己的 logical/ephemeral resources。
- Cleanup exact-identity、child-first、fail-closed。
- Unknown、shared、active、dirty、missing-observation、physical-alias 或 identity mismatch resource
  均保留并报告。
- Cleanup 先停止 owner process，再撤销 run credential/consumer/lease，然后删除 ephemeral
  provider/logical resource，最后释放 shared-provider reference。
- 正常结束、启动失败、signal/host interruption 后的 reconciliation 使用同一 manifest/lease
  truth；不得通过 broad label、name prefix 或 worktree deletion 推断 ownership。

## 6. Ports, endpoints, and process publication

- DEV 和 shared TEST provider 在 `devStackId` 首次创建时动态分配 host port，之后为该
  `devStackId` 保持稳定。
- Local per-run 和 CI ephemeral provider 总是使用 dynamic port。
- Port allocation 使用 exclusive lock；Docker 实际 published mapping 是 endpoint authority。
- Readiness 成功后才把 endpoint 发布进 manifest 并注入 consumer process。
- 已停止的 long-lived provider 重启时，如 reserved port 被占用，launcher 在同一事务内重新
  分配并重新发布 endpoint。
- Repository runtime logic 不包含 hard-coded host port；container target port 或协议 default
  不是 host endpoint authority。
- Gateway/frontend/service endpoint 全部从 manifest 传播。mTLS workload authority 只使用
  SPIFFE URI SAN，不依赖 hostname 或 port；证书同时携带 launcher-owned
  `<service>.localhost` DNS SAN（Auth 另含 issuer DNS）以完成 TLS routing/hostname validation，
  DNS 不参与 workload authorization。

Startup、liveness、readiness 是三个不同状态。Dependency readiness gate 必须先于 service
publication 和 test execution。启动事务逐项记录 partial progress；失败时只回滚当前 run 已
拥有的资源。

## 7. Configuration and worktrees

Developer 维护一个 worktree 外的 machine-local config，建议路径为
`~/.config/oes/local.env`。Repository 的 `.env.example` 继续是 sanitized schema/default
template，并存在于每个 worktree；它不是运行时 binding 或 credential store。

Launcher 按以下优先级构造一个 in-memory run configuration，并生成一个 manifest：

1. versioned repository defaults/schema；
2. machine-local config；
3. selected profile；
4. explicit supported command argument；
5. launcher-owned dynamic allocation 和 credential reference。

其中 launcher-owned binding key 不允许被 inherited shell variable、current working directory
或 stale dotenv file 覆盖。它们包括 database/message/cache/object-store endpoint、published
port、certificate path、process/runtime identity、run-scoped credential reference。普通 developer
tunable 可以来自 machine config 或 explicit command argument，但必须经过 schema validation。

Launcher spawn 每个 process 时显式注入该服务的最小环境；不同服务不得收到另一个服务的
database、bucket、NATS subject 或 administrative credential。Credential material 位于 ignored、
mode `0600` 的 launcher runtime storage，按 service/run 限权，输出和 evidence 一律 redacted。

Generated root/service `.env`、dotenv/current-directory discovery、worktree-derived owner identity
和由 worktree 复制出的 Compose project 已退役。仓库不保留 legacy/v2 mode selector。

## 8. Unified launcher boundary

一个 CLI 和一个 orchestration core 接收 `DEV`、selected local test 或 CI plan intent，并完成：

1. validate intent、profile 和 declarations；
2. allocate `devStackId`/`taskKey`/`runId`、resource、port、credential 和 lease；
3. provision provider 与 logical resource；
4. apply migrations/seed/fixture；
5. publish manifest 和 minimal per-service environment；
6. spawn selected host process/provider；
7. gate liveness/readiness；
8. execute requested command；
9. record exact evidence；
10. reconcile and clean up exact owned resources。

现有 pnpm entry name 可以作为 compatibility-friendly user command 保留，但在切换后只能委托
给这一个 launcher。Local 与 CI 复用 planning/orchestration core，差异只来自 profile 规定的
provider scope 和 CI job-private boundary。

Launcher 只拥有 orchestration、runtime declaration validation 和 resource lifecycle；它不包含
业务规则、permission decision、event payload mapping、service schema truth 或 journey completion
判断。Service/database/event/trust/observability owner 的既有真相源继续拥有这些语义。

## 9. Access-control model

Shared physical provider 不表示 shared authorization。Bootstrap administration、migration 和
service runtime 是不同 authority；launcher 只把最小 credential 交给准确 consumer。

| Provider | Bootstrap/provisioning authority | Runtime authority | Required denials |
| --- | --- | --- | --- |
| PostgreSQL | provisioner 创建 database/role；migrator 对一个 owner database 执行 committed migration | service-scoped user 只访问本服务 database/schema | schema/role admin、其他服务 database、其他 run database |
| Redis | launcher 建立 ACL 与 namespace | per-service ACL + key namespace | dangerous global command、其他 service/run namespace；numeric DB index 不构成隔离 |
| MinIO | launcher bootstrap 创建 bucket/user/policy | 只有 Asset Service 获得 bucket-scoped direct access | 其他 service、其他 run bucket、admin API |
| NATS | bootstrap admin 建立 account/stream/consumer/ACL | service credential 只 publish/subscribe frozen subject | wildcard data/control subject、其他 service subject、topology admin |

DEV 和 CI 从同一 declarative permission model 派生 credential；CI credential 为 ephemeral。
完整 denial matrix 在 A0、相关 permission model 变更和 `FULL` 中运行，普通 focused test 只运行
其选择的相关 denial。Local runtime 不新增 Vault、KMS 或 production secret-management platform。

## 10. Schema, migrations, seed, and fixture

Committed migration file 是全部 managed `DEV`、`LOCAL_INTEGRATION` 和 `CI` 的唯一 schema
change truth。一个 owner database 的 bootstrap 顺序固定为：

```text
provision database/roles
  -> prisma migrate deploy (migrator authority)
  -> schema/native-invariant verification
  -> Foundation Seed
  -> run/test Fixture
  -> service/test execution (service runtime credential)
```

- Managed launcher、test 和 CI path 删除 `prisma db push` 与 `--accept-data-loss`。
- Personal disposable prototype database 可由 developer 显式使用 `db push`，但它不产生 accepted
  verification evidence，也不得被 managed environment 复用。
- 新 migration 在 owner 的 development/scratch database 生成，经 review/commit 后只通过
  `migrate deploy` 应用到 managed path。
- Foundation Seed 与 run/test Fixture 是不同阶段、不同输入；seed source/script 及其预期变更
  通过 Git 合并，runtime database content 不合并。
- Seed 必须 idempotent，并使用该 owner database 的 service-scoped write authority；它不获得
  provisioner 或其他服务 database authority。

## 11. Provider-specific recipes

| Provider/capability | DEV | LOCAL_INTEGRATION | CI |
| --- | --- | --- | --- |
| PostgreSQL | shared DEV provider，service-owned databases | shared TEST provider，per-run database/user | job-private provider，service-owned databases/users |
| Redis | shared；per-service ACL/namespace | one ephemeral instance per run when selected | job-private when selected |
| NATS/JetStream | shared | one ephemeral instance per run when selected | job-private when selected |
| MinIO | shared DEV provider；stable Asset bucket | shared TEST provider；per-run bucket/credential | job-private；per-run bucket/credential |
| Nacos+MySQL | shared | temporary only for Nacos-specific tests; ordinary tests inject direct endpoints | job-private when selected |
| mTLS | stable local CA and per-service certificate | per-run CA/cert for cross-service Integration/Journey | per-job CA/cert for networked test |
| Observability | shared full OTel/Tempo/Loki/Grafana | in-memory for Unit/Component; temporary Collector only for trace-specific test | selected provider; FULL validates complete stack |

MinIO configuration/permission/failure tests 可显式请求 temporary instance。Ordinary Integration 不
启动完整 Observability stack。Unit/Component 无真实 network。NATS、MinIO、mTLS、trace 等
provider 的 domain-specific semantics 仍由其平台真相源和 contract 冻结；本表只拥有运行配方。

## 12. Evidence and logging

每个执行记录 exact planner input/hash、profile、manifest identity/hash、selected dependencies、
baseline/candidate、command、sanitized environment schema、literal output、exit status、resource
allocation/cleanup result 和 residue observation。Evidence 必须绑定相同 `taskKey + runId`，不得把
另一个 run 的 provider、manifest 或 output 冒充当前结果。

Service log 在适用时携带 `taskKey`、`runId`、request/trace correlation；credential value、bearer、
database URL password、private key 与 secret material 不进入 log/evidence。Trace/audit 业务语义
继续以 [Observability And Audit](./observability-and-audit.md) 为准。

Migration-only PostgreSQL authority 只能存在于 Stack-private orchestration material，不进入任何 host
business process environment。任何 target path、Docker object、credential reference 或 manifest
generation 变化都会使旧 restore binding 失效；restore 在新 exact plan/binding 获得独立 Human
confirmation 前保持 blocked。

## 13. A0 business-neutral pilot

A0 只验证 runtime infrastructure，不依赖尚未完成的业务 Journey：

1. 同时启动两个 local run。
2. 两个 run 复用 shared TEST PostgreSQL/MinIO，但获得不同 database/user 和
   bucket/credential。
3. 按声明分配 ephemeral NATS、Redis、per-run mTLS material 和 dynamic port。
4. 验证 atomic manifest publication、explicit environment injection、readiness 与 per-service
   provider permission。
5. 结束 run A 并证明 run B 的 process、lease、database、bucket、NATS、Redis 与 certificate
   binding 不受影响。
6. 分别验证 normal/abnormal cleanup，且 shared provider 保持可用。
7. 分别 smoke temporary Nacos+MySQL 和 temporary OTel Collector。
8. 在 CI job 使用 job-private provider 重现同一 orchestration core。

A0 acceptance 同时要求：零 port/resource collision；cross-run/cross-service access denied；重复
执行稳定；unknown/shared resource 被保留；owned ephemeral resource 无 residue；literal
command/output/exit status 完整；manifest/evidence binding 可重开；rollback drill 成功。

现有 Auth→Permission、Collaboration→Notification 和 Asset business path 在各自 production chain
独立完成并可执行前不进入 A0。A0 通过不表示这些 Journey complete。

## 14. CI alignment

- DO/CO self-test、exact-candidate independent RV 与 CI 是三个独立 verification layer。
- PR candidate 存在后，RV 与 CI 并行。
- CI 只有稳定 required context `CI / Baseline Checks`；risk plan 选择 static、Unit、Component、
  Contract、Integration 和 Journey。
- CI 使用 runner/job `max-parallel` 控制 job-private provider concurrency。
- PR-triggered `FULL` 仍是例外，遵守既有 Human confirmation gate；scheduled/manual/release
  `FULL` 继续遵守 [Testing And CI](./testing-and-ci.md)。

## 15. Atomic migration and rollback

Runtime 实现与验证可以在 isolated candidate 进行，而 `main` 继续使用当前 executable runtime。
`main` 只进行一次原子切换，不保留 active legacy/v2 runtime mode。

本 Design 只冻结 required operation 与 acceptance semantics；在 implementation candidate 交付并验证
实际命令前，当前 executable runbook 不加入未来命令。Implementation 必须在同一个 candidate 中提供
state-layout command、tests、rollback，并原子更新 runbook。

Cutover candidate 必须同时：

- 把所有 supported pnpm entry 和 CI internal path 切到统一 launcher；
- 删除 legacy lifecycle code、generated root/service env flow、fixed-host-port assumption、旧配置 key、
  stale test 与 obsolete executable documentation；
- 对 runtime entry/config reference 做 repository-wide zero-reference check；
- 在切换前备份 DEV data，并重建 disposable TEST data；
- 交付一次性、可审计的 legacy host-resource reconciliation/cleanup 工具、read-only inventory、
  dry-run plan、confirmed cleanup apply 与 post-cleanup residue check；
- 原子改写受影响 runbook，使 operator 可以从 exact inventory 生成计划，并在独立 Cleanup
  confirmation 后执行同一 sealed plan；
- 不混入 business schema change、seed semantics change、business fix、service containerization 或
  unrelated refactor。

### 15.1 Legacy host-resource reconciliation

现有主机资源不是因为新 launcher 已交付就自动脱离 OES ownership。切换前，implementation
candidate 必须以只读方式盘点当前可观察到的 OES Compose project、container、network、volume，
并记录 Docker object ID、type/name、Compose/project labels、OES owner labels、active/stopped state、
attachment/mount、对应 task/lease/manifest evidence 与 observation time。名称或 prefix 只能作为
发现线索，不能单独证明 owner 或删除资格；inventory 不读取或输出 credential/private data。

每个 observed resource 必须恰好进入以下一类：

| Classification | Required disposition |
| --- | --- |
| `VALID_DEV_DATA` | 在切换前完成可验证 backup；按新 DEV owner/database/bucket contract migration 或 restore，并保留 source/backup/target binding。 |
| `ACTIVE_OWNER_HELD` | 保留；绑定 exact active task/lease/owner 和阻止清理的 evidence。 |
| `CONFIRMED_IDLE_LEGACY_RESIDUE` | 进入 sealed cleanup plan；只有 exact identity 重新打开且独立 Cleanup confirmation 有效时删除。 |
| `UNKNOWN_OR_INSUFFICIENT_EVIDENCE` | fail closed 保留；记录 exact identity、缺失证据和后续 owner resolution action。 |

Known shared provider 有 active lease/owner 时归入 `ACTIVE_OWNER_HELD`，承载有效持久 DEV data 时
归入 `VALID_DEV_DATA`；缺少上述证据时归入 `UNKNOWN_OR_INSUFFICIENT_EVIDENCE`。只有同时证明属于
旧 lifecycle、没有 active lease/attachment 且不是待迁移 DEV data，才能归入
`CONFIRMED_IDLE_LEGACY_RESIDUE`。

Implementation candidate 交付的 reconciliation tool 必须：

- 默认和 `dry-run` 都是 read-only，产生 deterministic inventory、classification、planned action、
  reason 与 evidence digest；
- 把 backup/migration、preserve、delete 和 residue expectation 明确区分，不能把 stopped、unused、
  name match 或 label match 单独当成 delete proof；
- 生成 sealed exact-identity cleanup plan，并在 apply 前重新读取 object ID、labels、state、mount/
  attachment、owner/lease evidence；任一 drift/mismatch 转为 preserve-and-report；
- child-first 删除已确认属于旧 OES lifecycle 且 idle 的 container、Compose project membership、
  network 和 temporary volume，不删除仍被 attachment/mount 使用的 parent/shared resource；
- 验证 DEV backup/migration 后才允许旧 persistent DEV source 进入 delete plan；
- cleanup 后重新盘点全部发现面，证明 planned object 的 disposition 与 literal output/exit status，
  并报告所有保留项；
- 不在 launcher startup、Design PR、implementation merge 或普通 test command 中自动清理历史资源。

Tool、inventory schema、dry-run plan、runbook 和验证 evidence 属于 implementation delivery；对真实
主机执行 delete 仍是 [Collaboration Framework V2](../../governance/codex-execution-model.md) 的独立
`Cleanup` confirmation boundary。该边界只执行已经交付并验证的工具与 sealed plan，不创建新 task、
delivery、PR、merge、CI、product fix 或 repository diff。未获得 Cleanup confirmation 时，只允许
read-only inventory/dry-run、delivery activation 已授权并验证的 DEV backup/migration，以及
preserve report；不执行 legacy resource delete。

现有 Compose project `oes` 明确属于 legacy inventory。V2 logical Stack 不对应 Compose project，
也不为 Docker Desktop grouping 保留或重建本地 Compose project。Legacy `oes` project、container、
network、已证明属于它的 volume 与 anonymous init mount 在 Design 和 implementation verification
阶段保持不变；只有在 V2 migration/restore acceptance 完成、exact deletion set 重开且获得独立
Cleanup confirmation 后，才按 child-first 顺序删除。Unknown、active、shared 或证据不足对象继续保留。

### 15.2 State-layout activation and recovery

State-layout migration 是 later Human-confirmed delivery 中的一次性操作；Design merge 不移动目录、
不修改 registry/manifest/credential、不启动 restore/cleanup，也不触碰当前 Docker object。该 delivery
必须先修复并独立验证 business process environment 暴露 PostgreSQL migrator authority 的 blocker，
再进入 activation。

Activation precondition 固定为：持有 machine migration lock 并拒绝新 allocation；active Run 为零；
active Stack lease 为零；DEV host process 已停止；当前 path、mode、hash、Stack/Run manifest、credential
reference、Docker object ID、volume、endpoint 与每个 Docker bind source 已 sealed；runtime-state 与
DEV-data snapshot 已验证。任何 bind source 位于旧 `stateRoot` 下的 provider 都必须在 root movement
前安全停止，且不得有 running container 继续持有指向 renamed path 的 bind。

Staged next root 必须是同一 filesystem 上的 sibling tree。Migration 完成 closed-world mapping、permission、
path containment、hash、registry uniqueness、manifest fingerprint、external reference 与 zero-unresolved-
reference 验证后，fsync 全部 file/directory。Parent directory 中、old/next root 之外的 sealed activation
journal 是 crash recovery authority，状态顺序固定为：

```text
PREPARED -> OLD_MOVED -> NEW_PLACED -> COMMITTED
```

在 durable `COMMITTED` 前 old root 保持 authority；在其后 new root 保持 authority。Exact sequence 是：
把 old root rename 到 journal-bound rollback path；把 staged root rename 到 configured `stateRoot`；fsync
parent；在 final new bind path 上启动或仅在必要时替换 affected provider；发布新的 exact Stack manifest；
验证 readiness 与 object mapping；最后 durable commit。Healthy V2 object 不因命名或展示目的被替换；
任何必要 replacement 都必须在 journal 和新 Stack manifest 中记录 exact old/new identity。

Crash recovery 在没有 `COMMITTED` 时隔离 uncommitted new root、按 journal 恢复 old root 并重启 retained
old provider；存在 `COMMITTED` 时继续 new-root reopen 与 verification。Failure cleanup 只停止 exact new
object；unknown 或 identity-drifted object 保留并报告。每一步都使用 no-follow exact path、journal binding
和 idempotent replay，禁止 dual-read、dual-write 或 persistent generation selector。

Activation 改变任何 restore target binding 后，旧 restore confirmation 继续失效。成功 reopen 后生成
新的 exact restore plan/binding，并停在独立 Restore confirmation；old root、old provider 和 legacy data
carrier 在各自 terminal verification 与独立 Cleanup confirmation 前继续保留。

### 15.3 Final migration acceptance

只有 exact-candidate self-test、A0、independent RV 和 `CI / Baseline Checks` 均通过，且获得之后
独立的 Human merge confirmation，candidate 才可合并。Implementation acceptance 必须包含 A0 的
完整 literal evidence、权限 denial、stable rerun、normal/abnormal cleanup、residue observation、
CI reproduction 和 rollback drill。原子切换后的最终 migration acceptance 还要求：

- legacy runtime executable/config/test/document reference zero check 通过；
- sealed cleanup plan 中所有 `CONFIRMED_IDLE_LEGACY_RESIDUE` 在独立 Cleanup confirmation 后归零；
- 已迁移 DEV data 的 source、backup、target 和 restore verification 可重开；
- 每个保留的 `ACTIVE_OWNER_HELD` 或 `UNKNOWN_OR_INSUFFICIENT_EVIDENCE` resource 都有 exact identity、
  classification、owner/evidence 或证据缺口、保留原因和后续动作；
- 不得把未识别、活动或证据不足 resource 重新标记为“非 OES”来制造 zero-residue 结论。

若仍存在 confirmed-idle legacy OES resource，最终 migration 尚未完成；若仅保留 active/unknown/
shared/insufficient-evidence resource，报告必须明确它们不属于已获授权的 deletion set，且不因
新 runtime 可用而被静默忽略。

Rollback 是 whole-candidate Git revert；若 DEV migration/seed 已影响持久数据，则同时恢复切换前
DEV snapshot。Rollback 不选择性恢复 legacy file、旧 `.env` 或固定端口路径。Historical ADR 保留
为历史并在其决定被替代时标记 `SUPERSEDED`、链接当前 truth；active documentation、configuration、
test 和 executable path 不积累旧模式。

## 16. Ownership and non-goals

本设计保护以下边界：

- 每个 service 的 data/business truth ownership；
- API Gateway/BFF 外部入口、gRPC 内部同步边界、NATS event semantics；
- tenant、permission、workload trust、test taxonomy 与 CI governance；
- local development 的 host-run business-service model。

本设计不定义 production deployment topology、production secret infrastructure、业务行为修复、
未完成 Journey 的实现，也不把 runtime orchestration 变成业务平台 service。Runtime implementation
需要 Design PR 合并后另行进行 Human-confirmed delivery activation。

## 17. Related truth sources

- [Testing And CI](./testing-and-ci.md)：test taxonomy、change selection、CI topology 与 FULL gate。
- [Event Bus And Outbox](./event-bus-and-outbox.md)：NATS/event transport、outbox/inbox、ACL 与 replay
  语义。
- [Trusted gRPC And Execution Context](./grpc-metadata-and-service-trust.md)：mTLS、SPIFFE、
  ExecutionToken 与 RPC admission。
- [Observability And Audit](./observability-and-audit.md)：signal、trace、log 与 audit 语义。
- [ADR 0018](../../adr/0018-local-development-and-test-runtime.md)：本运行时形态与原子切换的决定。
- [Runbooks](../../runbooks/index.md)：当前统一运行时的可执行操作。
