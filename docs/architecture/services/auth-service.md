# auth-service 职责卡

## 1. Purpose

`auth-service` 是 OES 的认证、认证凭据、认证挑战、会话、token、MFA 与认证域审计真相服务，负责回答“操作者如何被认证、当前 session 是否有效、认证流程如何续流、当前 session context 如何建立或切换”。

本文是 `auth-service` 的唯一稳定设计真相源。其他 architecture、collaboration、contract、plan、feature packet 或服务内实现文档只能引用本文，不得重新定义 `auth-service` 的长期职责、核心对象、边界或 owner 语义。

## 2. Owns

- 主认证流程真相：
  - 邮箱密码登录
  - 手机密码登录
  - 邮箱 OTP 登录
  - 手机 OTP 登录
  - 员工码 + 现场终端 PIN 登录
- 认证 challenge 真相：
  - login challenge
  - OTP challenge
  - MFA flow challenge
  - password recovery challenge
  - step-up MFA challenge
- 认证凭据与登录方式真相：
  - `LoginMethod`
  - password credential
  - user-scoped `TERMINAL_PIN` credential
  - OTP usage 与验证码校验状态
  - password setup requirement
  - password recovery reset grant
  - platform terminal entry login policy
- session 与 token 真相：
  - active session
  - session context
  - access token 签发语义
  - refresh token rotation
  - session validation
  - logout / revoke / tenant session revoke
- service-to-service 执行凭据真相：
  - STS token exchange
  - 短期 ExecutionToken 签发、issuer、audience、TTL 与 key rotation
  - current mTLS/SPIFFE + typed selector 的 direct MACHINE root exchange 编排与认证审计
  - workload issuance policy 的认证执行
  - ExecutionToken 紧急撤销版本 / deny fact
- DELEGATED execution credential 真相：
  - `DelegationGrant` 的创建、状态、时效、撤销与认证域审计
  - 由明确用户确认和适用 step-up 证据签发的 `ActionGrant`
  - `ActionGrant` 的精确绑定、失效与签发审计；目标业务服务自己的原子消费记录不归 Auth 所有
- API Key credential 真相：
  - opaque credential identifier、secret verifier、verifier key version、过期、轮换、禁用与撤销
  - `ExternalApiKeyVerifierCompromiseIncident` 的幂等完成事实与受影响凭据撤销结果
  - API Key 认证与 Gateway-only external access token exchange；Gateway 内部再取得 ExecutionToken
- account selection 与 context switch 的 session 侧真相：
  - account selection 后建立当前 session context
  - context switch 后替换当前 session context
  - context switch 后重新签发 token
- MFA 真相：
  - user MFA binding
  - TOTP binding
  - recovery codes
  - platform default terminal MFA policy
  - tenant terminal MFA policy
  - login MFA orchestration
  - sensitive action step-up MFA orchestration
- personal trusted-device 与 new-device MFA 判定所需的认证域设备识别真相。
- 登录失败限流、OTP 发码频控、OTP 尝试次数与认证安全策略执行真相。
- 认证域本地审计事实：
  - login
  - challenge
  - MFA
  - password recovery
  - refresh
  - refresh replay
  - logout
  - session revoke
  - admin security action

## 3. Does Not Own

- 自然人、账号、租户、组织、联系资产主数据真相；这些归属 `identity-service`、[tenant-org-service.md](./tenant-org-service.md) 或 `party-service`。
- email / phone / social contact asset 的主数据、验证状态、展示资料、公司受控联系方式交接与外部通信账号展示引用真相；这些归属 `identity-service`。
- 当前用户可用 account context 列表与 account 展示摘要真相；这些归属 `identity-service`。
- tenant lifecycle 与 org tree 真相；这些以 [tenant-org-service.md](./tenant-org-service.md) 为准。
- 角色、权限、policy、授权判定、权限摘要与导航授权真相；这些以 [permission-service.md](./permission-service.md) 为准。
- Machine Principal identity、类型、scope、tenant、lifecycle、`MachineWorkloadBinding` 与固定 SYSTEM inventory provisioning；这些归属 `identity-service`。API Key 是 `auth-service` 拥有的 credential，但不是机器主体；MACHINE selector 是非秘密 owner reference，也不是 credential。
- 通知模板、渠道、provider、投递任务、投递状态、回执与成本治理真相；这些归属 `notification-service`。
- API Gateway / BFF 的 HTTP contract、前端响应聚合形状、captcha 校验与前端 shell 状态。
- 企业受管共享终端设备 registry、绑定租户、设备禁用、丢失、版本策略或设备运行快照真相；这些归属 `terminal-device-service`。
- Terminal Access Policy、account 是否允许从某 terminal 建立 session 的授权事实；这些归属 `permission-service`。
- 集中审计平台的索引、归档、检索与跨域审计视图；`auth-service` 只拥有认证域本地审计事实。
- Redis、Prisma、具体存储引擎或 runtime repository 形态的长期架构真相。

## 4. Core Responsibilities

- 执行统一主认证流程，并根据认证结果返回成功、拒绝、MFA 续流或 account selection 续流。
- 在当前阶段保留 account selection 主流程；即使用户只有一个 account，也不把自动进入作为当前稳定行为。
- 通过 `SelectAccount` 确定当前 session context，并建立 active session、签发 access token 与 refresh token。
- 在登录后的 account context switch 中，负责验证目标 account 与当前 session 主体关系，并替换当前 session context、重新签发 token。
- 维护 active session 生命周期，包括 validate、refresh、logout、logout all、logout other devices、admin revoke 与 tenant session revoke。
- 维护 refresh token rotation 与 replay 检测语义。
- 维护 user MFA binding、platform default / tenant terminal MFA policy、login MFA 与 step-up MFA challenge 编排。
- 维护 login method、password credential、password setup requirement 与 password recovery 流程。
- 维护平台级 Terminal Entry Login Policy，并在 primary credential 校验前判定当前 terminal 是否允许请求的 login flow。
- 执行登录失败限流、OTP 发码频控、OTP 尝试次数控制与 trusted-device / new-device MFA 判定。
- 记录认证、安全与 session 操作的本地审计事实。
- 认证 workload、HUMAN / MACHINE / DELEGATED execution principal 与外部 API Key，并通过 STS 签发目标 audience 的最小权限 ExecutionToken。
- 为 AI / Robot 的 HUMAN delegation 建立、撤销和失效受控的 `DelegationGrant`，并为明确的高风险业务动作签发短时、单用途的 `ActionGrant`。
- 发布 JWKS 与紧急撤销事实，使资源服务在普通 RPC 上本地验签而不在线 introspection。
- 显式区分 self-service 与 admin-management 接口授权语义，不允许长期复用同一接口层权限门承载两种语义。

## 5. Authentication Flow

`auth-service` 的认证流程分为四个稳定阶段：

1. 主认证：校验密码、OTP 或后续扩展认证方式，回答“用户是否完成基础身份验证”。
2. 登录 MFA：当所选 account 对应策略要求 MFA 时，创建并校验 login MFA flow。
3. Account selection：选择当前 `UserAccount`，并由该 account 决定当前 session scope。
4. Session issuance：建立 active session，并签发 access token / refresh token。

当前阶段稳定状态名仍保留：

- `SUCCESS`
- `MFA_REQUIRED`
- `ACCOUNT_SELECTION_REQUIRED`
- `DENIED`

`context selection` 是产品与协同层表达；在 `auth-service` 内部，当前稳定主语义仍是选择 `UserAccount` 作为当前 session context，不引入独立 `workspace` 或独立 context 主数据模型。

单 account 自动建 session 是 future optimization。当前阶段主认证成功后仍进入 account selection 流程，后续是否优化为单 account 自动进入，需要单独评估设备上下文、MFA、审计与兼容影响。

Terminal-aware Account Security Phase 2 增加以下稳定规则：

- Web 保留现有固定登录入口与 account selection。
- PDA 登录租户由受管设备绑定决定，用户登录时不选择租户。
- PDA Phase 2 不提供 account selection；用户认证成功后，必须在设备绑定 tenant 内解析出唯一可 PDA 登录 account。
- `EMPLOYEE_CODE_PIN` 是现场终端登录流程：`employeeCode` 只用于在设备绑定租户内解析 HR 员工与目标 account，真正的认证凭据是 user-scoped `TERMINAL_PIN`。
- Terminal Entry Login Policy 不改变各前端固定登录流程，只作为平台级入口启停与后端准入。

## 6. Account Selection And Session Context

`auth-service` 在 account selection 后建立当前 session context。

稳定规则：

- 当前 session context 必须包含 `userId`、`accountId`、`scopeLevel`、`tenantId`（TENANT scope 必填，SYSTEM scope 为空）以及适用时的 `orgId`。
- terminal-aware session 必须包含 `terminal` 与 `loginFlow`。
- PDA / KIOSK 等受管终端 session 可包含 `terminalDeviceId` 与 `deviceBoundTenantId`。
- `SYSTEM` account 不绑定 tenant，也不读取 tenant lifecycle。
- `TENANT` account 必须绑定 tenant，并在 session 建立、refresh、validate 等关键路径校验 tenant 仍为可用状态。
- account 候选列表和 account 展示摘要由 `identity-service` 提供。
- tenant lifecycle 与 tenant 展示信息由 `tenant-org-service` 提供，服务边界以 [tenant-org-service.md](./tenant-org-service.md) 为准。
- 权限摘要与导航授权由 `permission-service` / `api-gateway` 聚合提供，`auth-service` 不拥有该真相。

登录后的 account context switch 采用“替换当前 session context”语义：

- 不支持同一客户端并行持有多个 active context。
- 切换目标必须属于当前 session 对应 user。
- 切换成功后必须重新签发 access token，当前阶段也应轮换 refresh token。
- 切换后前端必须重新读取 session context、access summary 与导航摘要。
- 当前可切换 account context 列表不归 `auth-service` 所有。

## 7. Session And Token

`auth-service` owns active session truth，而不是仅验证 JWT 签名。

稳定规则：

- access token 必须是短期身份与 session context 摘要，不承载完整权限事实。
- access token validation 必须同时校验 JWT 与服务端 active session truth。
- refresh token 必须走 rotation 语义。
- refresh token replay 必须触发安全处理，并记录认证域审计事实。
- logout、logout other devices、logout all 与 admin revoke 都必须改变 active session truth，而不是只依赖客户端删除 token。
- terminal-aware session lifetime 由 `auth-service` 按 terminal 决定；`WEB` 保持通用长 refresh 策略，`PDA` 使用短作业终端策略（access token 默认 15 分钟，refresh token 默认 20 分钟）。
- PDA 用户 session 不跨 App 关闭自动恢复；PDA 端只持久化设备 enrollment / `terminalDeviceId`，重新打开 App 后必须重新登录。
- tenant 被 suspend / archive 后，`TENANT` scope session 不得继续 validate 或 refresh；可通过惰性失效与主动 revoke 双路径治理。
- `SYSTEM` scope session 不受 tenant lifecycle 影响。
- PDA / KIOSK 等受管终端设备进入 disabled / lost / unbound / retired 等不可登录状态后，`auth-service` 应消费设备状态事件并按 `terminalDeviceId` 幂等清退相关 active sessions。
- PDA login / refresh / bootstrap 仍应重查受管设备状态，作为事件延迟或失败时的兜底。

存储方向只在本文冻结到“active session truth 必须由 `auth-service` 拥有”。Redis、Prisma 或后续持久化 session 历史属于实现或专项架构问题，不在本文冻结为长期存储方案。

### 7.1 ExecutionToken And STS

ExecutionToken 是 service-to-service 的短期执行凭据，不是用户登录 access token 的别名。

稳定规则：

- 只有 `auth-service` / STS 可以签发 ExecutionToken；业务服务不得共享签名私钥或自行重签。
- Token 只面向一个 target service audience，以 `cnf` 绑定申请工作负载的已验证 mTLS identity，并直接在 `scope` 携带获准 Permission Code 子集。
- HUMAN subject 的 scope / tenant 使用一个规范化 pair：`TENANT` 必须携带精确、非空且非 wildcard 的 `tenant_id`，`SYSTEM` 必须完全省略 `tenant_id`。ExecutionToken 不增加 `scope_level` claim，`scope` 继续只表示 Permission Code；Auth verifier 与 signer 必须对同一 pair 使用相同规则。
- 对由 active HUMAN session 建立的 ExecutionToken，Auth 必须从自身 session truth 派生并签入 `session_terminal`；调用方、Gateway request、ordinary metadata 或业务 DTO 不能提交或覆盖该值。`session_terminal` 与 `session_id` 同时存在并绑定同一 active session，MACHINE Token 不携带该 claim。
- STS 对 HUMAN、MACHINE、DELEGATED 分别验证可信 session / principal、Permission grant、delegation upper bound 与 workload issuance policy；调用方不能提交可提升授权的 subject facts。
- 默认 TTL 约 5 分钟，不签发 refresh token。精确上下限、claim 与错误语义以 [execution-token.md](../../contracts/auth-service/execution-token.md) 为准。
- 普通资源服务只通过 cached JWKS 本地验签；Auth 实例保持无状态横向扩展，STS 容量按 cache miss、context change 与 audience exchange 规划，而不是按每个业务 RPC 规划。
- 普通撤销接受短 TTL 收敛；紧急撤销发布 principal / credential / session / security-version deny fact。Auth 不要求所有服务共享 Bearer Token cache。
- API Key 只在 Gateway / Auth 入口使用；认证成功后得到 Gateway-only external access token，Gateway 内部才换取 target-audience ExecutionToken。API Key 与 external token 都不能作为内部 gRPC credential 原样传播。

#### 7.1.1 Emergency ExecutionToken revocation

`auth-service` owns the `ExecutionTokenRevocation` security fact: its authorization, creation, immutable audit record, monotonic revocation version and publication intent. The owner-published fact is `auth.execution-token.revoked` at business version `1`; the Event platform owns its security-critical transport, catalog registration and consumer topology, while this service remains the sole source of revocation semantics.

One revocation fact has exactly one selector. The permitted stable selector kinds are:

- `TOKEN_JTI`: one exact ExecutionToken `jti`.
- `PRINCIPAL`: all applicable Tokens for one execution principal.
- `SESSION`: all applicable Tokens carrying one Auth session reference.
- `CREDENTIAL`: all applicable Tokens issued from one Auth-owned credential reference.
- `MINIMUM_AUTHZ_VERSION`: Tokens for one opaque security subject whose `authz_version` is below the newly required minimum.

Selector references are opaque Auth-owned identifiers. Auth never publishes a bearer Token, API Key secret, credential verifier, raw incident evidence, free-text reason or unnecessary personal data. Each fact carries an Auth-owned strictly increasing version for that selector, an effective time, the last possible validity time of affected Tokens including clock-skew allowance, a sanitised reason category, and audit / trace correlation. A consumer keeps only the highest applicable version; duplicate, delayed or older facts can never restore access.

Emergency revocation is limited to confirmed or suspected security incidents requiring action before normal Token TTL convergence, including compromised Tokens, sessions, principals or credentials, and urgent authorization-security changes. It may be triggered only by an Auth-controlled security workflow, an authorized security administrator, or a verified security detector. Other services may request an Auth security action through an authorized interface but cannot publish, forge or independently decide a revocation fact. Ordinary role, grant, session or credential changes continue to converge through short Token TTL and must not consume this emergency channel.

Auth records the security decision, trigger source, selector kind/reference, monotonic version, reason category, effective / cleanup times, operator context and trace correlation in its local authentication audit before publishing the fact through the Event-owned security transport. Revocation is irreversible for already issued Tokens: correcting an incident never re-enables an old Token, and resumed access requires a newly exchanged Token with current security state. Auth permits denial-state cleanup only after every affected Token can no longer be valid; it does not emit an "unrevoke" fact.

`auth-service` does not own resource-service deny caches, their readiness checks, event consumer databases, broker credentials, replay operations or transport freshness policy. Resource services apply the Event-owned security delivery contract locally, reject an affected Token as `EXECUTION_TOKEN_REVOKED`, and never call Auth on the normal RPC validation path. If a resource service cannot prove its revocation state is current, it must fail closed for the affected execution scope until it has caught up and established readiness.

#### 7.1.2 External API Key Security

`auth-service` owns the credential lifecycle for a tenant Integration Machine; it does not own the machine principal, external HTTP routing, or the external capability catalogue. The frozen cross-service flow is [external-api-key-security.md](../collaborations/external-api-key-security.md); credential-management behaviour is [external-api-key-security.md](../../contracts/auth-service/external-api-key-security.md).

- A credential has a non-secret opaque identifier and a high-entropy secret. The secret is displayed only in the successful create or rotate response and is never recoverable, logged, audited in plaintext, or returned by query APIs.
- Auth persists only a constant-time-verifiable, irreversible secret verifier plus the opaque `verifierKeyVersion` that produced it. The production Pepper is a non-exportable HMAC key in the deployment-owned KMS/HSM provider: Auth never stores the presented secret or receives raw Pepper/key material, and Gateway, Identity, Permission or a business service never reads the verifier or its key reference.
- One credential belongs to exactly one active `TENANT` Integration Machine. It cannot choose another tenant, represent a human, become an internal workload credential, or be shared by a Marketplace/App-installation model.
- Create, reveal-once, rotate, revoke, disable, and permission-affecting administration require the authorised human management path and the exact current API Key management Permission Code. Shared organisation/session policy may require stronger administrator assurance, but Auth does not introduce an API-Key-specific step-up MFA grant. Auth records an authentication-domain audit fact for every credential lifecycle and exchange outcome.
- The generated `ExternalApiKeyCredentialService` contract is mounted on Auth's existing trusted gRPC host. Its management methods consume verified HUMAN execution context; its `ExchangeExternalApiKey` method accepts a raw key only from the verified Gateway INTERNAL workload and must never accept the value through metadata or an external Auth route.
- After Auth has verified its credential record, it resolves owner facts in one fixed order: `IdentityQueryService.ResolveIntegrationMachineForAuth`, credential-tenant versus Identity-tenant equality and tenant lifecycle, then `PermissionCheckService.ResolveExternalMachineAuthorizationSnapshot`. The two downstream calls use Auth's verified mTLS workload and separate target-audience INTERNAL ExecutionTokens with exact Codes `identity.internal.integration_machine.resolve` and `permission.internal.external_machine.snapshot.resolve`. The snapshot contains the effective, externally eligible `BUSINESS` Permission Code subset and an Auth-auditable authorization version; Auth never reads Identity/Permission storage or accepts a caller-supplied machine, tenant, capability, role or Permission Code to construct it.
- Auth's runtime owns dedicated Identity-lifecycle and Permission-snapshot gRPC adapters under its existing infrastructure adapter boundary, injected into the external API-key application service. Missing client configuration, trust policy, ineligible/mismatched owner facts, empty/invalid snapshot, timeout or downstream unavailability makes the external-exchange readiness/request fail closed before signing; it never falls back to legacy Identity API-key authentication, generic account `CheckPermission`, cached caller facts or a partially populated JWT.
- Auth signs that snapshot into the Gateway-only external access token as its `scope` claim. The claim contains only externally eligible existing `BUSINESS` Permission Codes, never roles, policy graphs, INTERNAL Code, resource facts, API Key material or business data. The token is a signed JWT rather than encrypted data, so every included code must be intentionally safe to reveal to the credential holder. Auth enforces a 4 KiB serialized-token limit; an oversized snapshot fails exchange safely and must be reduced by narrowing the external integration rather than silently dropping grants.
- The external snapshot is an entry-Gateway authorization result, not a replacement for target-service authorization. When Gateway later requests a target-audience `ExecutionToken`, STS continues to evaluate the current MACHINE grant, tenant and target requirements. A grant removal therefore prevents a new exchange immediately and may stop a new internal exchange earlier; no already-issued external access token can remain usable beyond its five-minute expiry.
- A replacement credential may overlap the superseded credential for at most seven days; no Integration Machine has more than two valid credentials. Revocation, machine disablement, tenant disablement, or a confirmed leak removes the credential from future exchange immediately and never restores the same secret.
- Credential expiry defaults to one year. A 90-day age is a rotation-health signal, not an automatic outage; tenant security policy may impose a shorter lifetime. Expiry never extends by use.
- External callers never receive an internal `ExecutionToken`. They receive the Gateway-only short-lived external access token defined by the HTTP contract; Gateway exchanges trusted external context for target-audience ExecutionTokens only on its internal mTLS hop.

#### 7.1.3 Direct Internal MACHINE Root Exchange

实现状态：`DESIGN_FROZEN_PENDING_IMPLEMENTATION`。本节取代已集成但缺少可部署首凭据输入、因而在真实调用中递归的 MACHINE source-credential path；现有 fail-closed 结果保持失败证据。

没有入站 HUMAN/session 或上游 ExecutionToken 的第一方 SYSTEM service、Cron、Robot、worker，直接以 current verified mTLS/SPIFFE 与 `ExchangeExecutionTokenRequest.machine_execution_selector` 建立 root MACHINE execution。selector 精确包含 principal id、binding id 与 binding version；它不含 secret、tenant/org、SPIFFE、certificate、Permission Code 或 lifetime，也不建立任何 authority。

稳定规则：

- `authorization` 对 direct MACHINE route 必须为空；bearer 与 selector 同时存在、selector 缺失/重复/格式错误或 caller 尝试提交 SPIFFE/certificate/tenant 均在 owner lookup 前拒绝。HUMAN/OBO/API Key/DELEGATED 的既有 private bearer route 保持不变。
- Auth 只从 Common transport 取得 current `VerifiedWorkloadIdentity.spiffeId` 与 leaf thumbprint/notAfter，把 transport-derived SPIFFE 与 selector 三元组提交给 Identity。请求或配置不能覆盖 transport facts。
- Identity `ResolveMachinePrincipalForAuth` 是 exact Auth mTLS-only、拒绝 Authorization metadata 的 pre-context owner resolver；它不要求 Identity-audience ExecutionToken，也不消费 Permission Code。policy 只绑定准确 method/caller，不能扩散。
- Identity decision 必须确认 Machine Principal active、type/scope/tenant 与适用 org reference 有效，selector 唯一对应同一 active binding，且 binding SPIFFE/version 精确匹配。Auth 只从该 owner decision 派生 MACHINE `sub`、scope 与 tenant/org。
- 完成认证后，BUSINESS Code 仍调用 `ResolvePrincipalAuthorization`；INTERNAL Code 仍调用 `ResolveWorkloadIssuance`。Auth 不从 selector 构造 Permission grant，也不读取 Identity/Permission storage。
- Auth 最后签发最长五分钟且 `cnf` 绑定当前 leaf 的 target-audience ExecutionToken。证书轮换只需用新 leaf 重新 exchange；Machine Principal/binding disable 或 stale selector 阻止新 exchange，既有 Token 由 TTL 与既有 `PRINCIPAL` / `MINIMUM_AUTHZ_VERSION` emergency selector 收敛。
- 任何 principal、scope、tenant、SPIFFE、binding/version、leaf、owner/Permission dependency 或 audit mismatch 都在 signing 前 fail closed。审计记录 route、selector reference、Identity/Permission decision、workload/leaf、result/reason 与 trace，不记录 bearer。

同步 HUMAN 多跳使用通用 OBO，不改变 Machine Principal owner 语义。唯一 subject credential 是当前已验证、由 Auth 签发且 `aud` 精确等于 exchanger 自身 audience 的 HUMAN ExecutionToken。Auth 必须重新验证 issuer/signature/time/security state、HUMAN subject、scope / tenant pair、session、当前 exchanger mTLS/SPIFFE/leaf 与 immutable workload registry；request/body、ordinary metadata、caller-local `scopeLevel` / `tenantId` 或 Machine selector 都不能提供或覆盖 subject scope / tenant authority。

Auth 签发的目标 Token 保持原 HUMAN `sub`、`principal_type=HUMAN`、subject scope / tenant、org/session attribution：TENANT 保持同一精确 `tenant_id`，SYSTEM 保持 `tenant_id` 缺席；`act` 写入当前 exchanger 的 tenantless SYSTEM MACHINE actor，`client_id`、target `aud` 与 `cnf` 绑定当前直接 workload 和 leaf certificate。目标 Token `exp` 不得晚于 subject Token `exp`。INTERNAL issuance 同时要求 Permission 对 exact exchanger workload→target audience→INTERNAL Code 的独立 allowed decision；Permission 不接收、提供或重解释 HUMAN subject scope / tenant。Auth 在返回 Token 前持久化 subject `jti` -> target `jti`、subject、actor、subject scope / tenant、audience、Permission decision reference 与 trace correlation；审计或任一依赖失败时不返回 Token，且不记录 bearer。无可信入站 HUMAN Token 的后台任务不获得 body/local fallback，留待独立设计。

OBO actor selector 不由 caller 或 Token request 提交，而是在既有 deployment-owned `AUTH_EXECUTION_WORKLOAD_POLICIES` 每个 workload record 中使用可选 `humanObo` block 冻结：

```ts
interface HumanOboPolicy {
  readonly selfAudience: string
  readonly actorMachinePrincipalId: string
  readonly actorBindingId: string
  readonly actorBindingVersion: string
  readonly targetAudiences: readonly string[]
}

interface WorkloadIssuancePolicy {
  readonly spiffeId: string
  readonly audiences: readonly string[]
  readonly humanObo?: HumanOboPolicy
}
```

一个 exact SPIFFE ID 只能有一个 workload record；所有 OBO-enabled record 的 `selfAudience` 也必须唯一且为 canonical service audience。`targetAudiences` 必须非空、去重、无 wildcard，并且是同一 record `audiences` 的子集；principal/binding selector 必须为 trim 后非空 stable reference，`actorBindingVersion` 必须是 canonical positive decimal。重复、歧义、未知字段、错误格式或交叉 record 冲突使 Auth 启动 fail closed。

HUMAN OBO exchange 必须同时满足：subject ET `aud` 精确等于 record 的 `selfAudience`；requested target 同时存在于 `audiences` 与 `humanObo.targetAudiences`；verified exchanger SPIFFE 精确命中该唯一 record；Auth 使用 registry 中的 actor principal/binding/version 与当前 SPIFFE 调用既有 `ResolveMachinePrincipalForAuth`。Identity decision 必须回显同一 active principal、binding、version、SPIFFE、`principal_type=MACHINE`、`scope=SYSTEM` 且 tenant 为空。stale version、selector mismatch、Identity unavailable 或 caller/body/metadata 尝试提供 actor 均在 Permission lookup/signing 前失败。该 block 是部署 selector，不取代 Identity owner truth，也不新增 Identity RPC 或 Permission input。

Auth 对 HUMAN OBO 的 subject verifier 与 signing gate 使用同一 truth table：

| Verified HUMAN subject | Signed `tenant_id` | Derived subject scope | Target Token |
| --- | --- | --- | --- |
| platform account/session | absent | `SYSTEM` | preserve absence |
| tenant account/session | one exact non-wildcard value | `TENANT` | preserve the same value |

空值、空白值、wildcard、与 active session 不一致的 tenant，或 caller 尝试补交 `scopeLevel` / `tenantId`，均在 Permission lookup 与 signer invocation 前拒绝。verifier 不把 tenantless HUMAN 固定为 `TENANT`，signing gate 也不把 tenant presence 作为所有 HUMAN OBO 的前置条件；两者都先验证上述 pair，再把明确的 typed scope / optional tenant 交给后续 exchange。SYSTEM OBO 仍不获得 tenant selector authority或 tenant BUSINESS grant。

精确 provision 与 migration 边界冻结为：

- Identity-owned deployment provisioner 只为版本化固定 SYSTEM / `INTERNAL_SERVICE` inventory 幂等建立 principal/binding，并向对应 workload config 输出非秘密 selector。manifest/database mismatch、duplicate/missing entry 或审计失败阻止 readiness；它不创建 tenant `AUTOMATION_BOT`。
- tenant bot principal/binding 继续由正常 ExecutionToken-protected management flow 建立。同一 shared runner SPIFFE 可关联多个不同 tenant binding；每个 job 使用自己的 exact selector，停用一个 bot 不停用 runner 或其他 bot。
- rollout 先 additive 增加 selector wire、Identity exact guard 与 provisioner，保留旧 source path 作短暂兼容；callers shadow/parity 通过后停止新 source issue，等待最长 15 分钟 drain。
- drain 与 rollback window 完成后删除旧 Issue/Revoke RPC、JWS profile、Auth persistence/provider/config 和 credential-specific Code。删除前 rollback 可恢复旧 caller；删除后只允许整体恢复前一 schema/runtime 版本，不保留两个 MACHINE root authority。
- `auth-service` 自身是固定 SYSTEM inventory 的首批 entry。其 selector/readiness 就绪后，登录/会话安全只为 target-owned Auth-only INTERNAL Code 换取 Identity、HR 或 TenantOrg audience ET，不为固定 principal 请求 `identity.account.list`、`hr.employee.get_by_id` 或 `tenant_org.tenant.get_by_id` BUSINESS grant。这同时移除首凭据递归与登录前 BUSINESS role 耦合。selector、owner resolver、target INTERNAL policy/declaration 或 Permission 未就绪时，对应登录/session capability readiness 失败，现有 Stage fail-closed 结果仍保持失败证据。

Auth 登录/会话安全的最小 downstream surface 固定为：

- Identity `identity.internal.auth_login_account.resolve`：`ListAuthLoginAccountCandidates(user_id)`、`ResolveAuthLoginAccount(user_id, account_id)`、`ResolveAuthEmployeeLoginAccount(tenant_id, employee_id)`；
- HR `hr.internal.auth_login_employee.resolve`：`ResolveAuthLoginEmployee(tenant_id, employee_code)`；
- TenantOrg `tenant_org.internal.auth_session_tenant_lifecycle.resolve`：`ResolveAuthSessionTenantLifecycle(tenant_id)`。

Web password/OTP 在 Auth-owned credential 成功后使用 Identity candidate resolver，再以 TenantOrg lifecycle 筛选；account selection 与 MFA completion 通过 `user_id + account_id` 重新验证 owner/enabled 事实。Employee PIN 先以设备边界提供的 tenant selector 解析 active employee，再解析 Identity employee/account binding，最后验证 Auth-owned PIN。Session refresh/validation 使用同一 TenantOrg minimal lifecycle resolver，因为它是 Auth 的 session safety fact，而非用户查询 Tenant 资料。

密码失败审计只从 Auth-owned LoginMethod 记录获取规范化 identifier 与可用 user reference；不再为审计富化调用 Identity `GetUserByEmail` / `GetUserByPhone`。对外错误、anti-enumeration、risk throttle、MFA、terminal access、session 与 Auth-owned audit 结果保持不变。

精确 direct exchange 以 [execution-token.md](../../contracts/auth-service/execution-token.md) 为准；Identity owner/provisioning 以 [machine-principal-resolution.md](../../contracts/identity-service/machine-principal-resolution.md) 为准。

#### 7.1.4 Delegation And ActionGrant

`DelegationGrant` 与 `ActionGrant` 是认证域凭据，不是 role、业务审批或业务操作本身。

稳定规则：

- `DelegationGrant` 只能由已验证 HUMAN 明确创建，必须绑定 human principal、tenant / org、受控 AgentPrincipal、ToolContract 版本、允许的 operation / Permission Code 上限、最晚失效时间与审计关联；它不能创建独立的 DELEGATED role。
- 每个用户指令创建一个 bounded AI Run 与 fresh Run-bound `DelegationGrant`；Conversation 只保留上下文。授权默认短时、可撤销且不可静默续期；Run 完成/停止/过期、用户撤销、human session / principal 失效、tenant 不可用或有效授权不再满足时，后续 delegation 和 ActionGrant 签发必须失败。长期无人值守自动化使用单独的 MACHINE principal 与流程授权，不复用 HUMAN delegation。
- Auth 在创建 delegation 或请求 DELEGATED issuance 前，从 Identity owner contract 取得 active AgentPrincipal fact、从 AI Platform owner contract 取得 active ToolContract identity/version 与 operation upper bound，并与当前 HUMAN/session 和 Auth-owned DelegationGrant 形成固定可信 upper-bound snapshot/reference 交给 Permission。Auth 不读取 AI registration JSON；Permission 不反向查询 Auth storage，因此调用链不得形成 Permission -> Auth -> Permission 同步循环。
- `ActionGrant` 只能在有效 delegation、Permission 的交集判定、业务 owner 返回的 canonical action facts/effective risk class/policy version、明确的用户确认以及适用时的 step-up 完成后签发。AI Platform 展示确认，Auth 独占不可变 HUMAN confirmation evidence；caller 或 AI 字段不能自报确认、风险或 target facts。
- 一次确认和一个 `ActionGrant` 只覆盖一个 owner-defined business action，而不是一个技术 RPC 或任意 batch。它是短时、单一目标服务、单一 operation、单一 target、单一 canonical input digest 与 owner policy version 的一次性凭据。
- `ActionGrant` 不替代目标服务的状态机、审批分离、金额阈值、资源授权或 command idempotency。目标服务在自己的事务中分别记录 business idempotency receipt 与每个 JTI consumption，并写入业务结果；相同 descriptor 的 replacement JTI 可绑定既有结果，但不能产生第二次写入。Auth 不跨服务共享数据库或接管业务提交。
- 用于 `ActionGrant` 的签名、issuer、audience 与 workload binding 必须使用 DG-1 冻结的 JWS / mTLS 互操作规则；不得引入第二套签名体系、共享 Bearer pool 或 body identity fallback。
- 密码、MFA、recovery code、session、API Key、role / permission / policy、delegation 自身、审计记录和 AI 自己结果的批准属于 AI 永久禁止操作。精确规则以 [delegated-execution-and-action-grant.md](../../contracts/auth-service/delegated-execution-and-action-grant.md) 为准。

#### 7.1.5 Cryptography, Registry And Rotation

`auth-service` owns ExecutionToken issuer configuration, signing-key lifecycle, JWKS publication and the controlled registry of service audiences and permitted workload identities. Deployment owns the CA, trust bundle and workload certificate issuance; business services do not own any part of this registry or key material.

- The production signing profile is JWS `ES256` only. Private signing keys are KMS/HSM-backed or equivalently protected, every `kid` is unique and never reused, and no service receives a shared signing secret.
- Each environment exposes one exact HTTPS issuer. Auth registers immutable service audiences as `urn:oes:service:<service-name>` and validates the requesting workload's verified SPIFFE ID before issuing a Token. The registry does not support wildcard audiences or caller-defined issuer/audience values.
- Auth publishes standard authorization-server metadata and JWKS over HTTPS. A resource service may use cached trusted keys and a bounded unknown-`kid` refresh, but must fail closed if refresh cannot establish a valid trusted key.
- A new signing public key is published before it signs Tokens. Old public keys remain published through the final Token expiry plus permitted clock skew. Signing keys rotate at least every 90 days and immediately on suspected compromise.
- Tokens carry `client_id` equal to the verified SPIFFE ID and `cnf.x5t#S256` equal to the presenting workload's current mTLS leaf certificate. Auth exchanges a new Token after certificate rotation; the Token cache key includes that certificate binding.
- Production workload leaf certificates have a maximum 24-hour lifetime and renew automatically before two thirds of their lifetime. Local uses a separate trust domain, CA, issuer and signing key, but exercises the same mTLS, JWKS and rotation protocol.

#### 7.1.6 ExecutionToken runtime binding and publication

`auth-service` owns the runtime composition that exposes its frozen ExecutionToken contract. The generated `ExecutionTokenService` is mounted on the existing Auth gRPC host and serves both `ExchangeExecutionToken` and `GetExecutionTokenJwks`; an HTTP metadata controller without that generated gRPC mapping is incomplete. Exchange maps only its declared target / Code request and consumes workload identity plus execution facts injected by the trusted Common transport runtime, never caller-supplied identity DTO fields.

Auth also owns the in-process producer of issuer HTTPS authorization-server metadata and its advertised JWKS document. Deployment routes the exact issuer host to this producer; the metadata location follows RFC 8414 for that exact issuer and advertises an absolute configured `jwks_uri`. This is public-key publication only: it does not expose a private key, replace the internal gRPC service or open an external execution exchange endpoint.

The only production signing composition is `KmsHsmExecutionTokenClient` through `KmsHsmExecutionTokenSigningAdapter` into `ExecutionTokenSigningPort`. The protected client is a deployment binding, not a caller-selected SDK or a business-service dependency. Bootstrap requires a validated issuer, metadata/JWKS endpoint, opaque signing-key reference and immutable workload/audience registry; missing or invalid configuration, an absent protected client, or an invalid active/published key timeline prevents the STS runtime from accepting exchange or JWKS requests. Auth never falls back to an in-memory, file, PEM, private-JWK or environment-variable signing key.

Local security integration uses the same port against a KMS/HSM-compatible protected test boundary with a non-exportable test key identified only by an opaque reference. A fake signer is limited to an isolated unit-test module. When the protected signer is unavailable, new exchange fails closed; resource services may only continue validating with already trusted cached JWKS and unexpired Tokens.

#### 7.1.7 Protected signing provider ownership and bootstrap

Auth owns the composition and startup health of one protected signing provider, while deployment owns the provider implementation, KMS/HSM tenancy and credential-delivery mechanism. The provider receives an opaque signing-key reference and, only when workload identity cannot authenticate directly, an opaque credential reference resolved inside the infrastructure provider. Neither reference is a private key, and no resolved key material may cross into application/domain services, ordinary Nest config, logs or diagnostics.

The mandatory runtime configuration is: exact issuer, absolute JWKS URI, opaque signing-key reference and immutable workload/audience registry; an opaque credential reference is optional and deployment-only. Before readiness, Auth constructs `KmsHsmExecutionTokenClient`, loads active and overlap public keys, validates the unique `kid`, P-256/ES256 JWK and complete publication timeline, then signs a bootstrap challenge and verifies it with the active public JWK. Only after this preflight passes may Auth expose ExecutionToken gRPC or issuer HTTPS metadata/JWKS routes. A placeholder client, absent provider, invalid reference, unavailable preflight, software key, PEM/private-JWK/env-key, or in-memory fallback is a startup failure.

The issuer authority must terminate TLS itself or through an approved proxy that forwards only the metadata/JWKS routes over an authenticated local channel to Auth. A plain application HTTP listener or arbitrary Host-header routing is insufficient. After readiness, a protected-signing outage rejects new exchange; it does not cause resource services to bypass cached-JWKS local validation. Local integration uses the same preflight against a KMS/HSM-compatible non-exportable test key boundary; unit fakes never satisfy readiness outside their isolated test module.

#### 7.1.8 Executable signer-agent asset

The executable protected provider is `execution-token-signer-agent`, a per-Auth-workload deployment sidecar owned by the existing EXEC-CRYPTO capability. It is the existing Auth-local protected-crypto process and is not an Auth business service: it has no public ingress, tenant state, business database or public OES API. Auth owns the repository client/adapter under `src/services/system/auth-service/src/infrastructure/execution-token-signer/**`; Deployment/SRE owns the paired Go static binary at `docker/grpc-trust/execution-token-signer/cmd/agent/**`, its local `go.mod`, image, local HSM harness, socket mount and PKCS#11 module binding. DG-3 reuses this process rather than adding a second sidecar or public service; its historical executable/path name is retained in this capability to avoid an unrelated EXEC-CRYPTO migration.

Auth connects only through the required pod-local `AUTH_EXECUTION_SIGNER_SOCKET_PATH` Unix socket. The path is deployment configuration, never request input; its mount permissions and peer authentication must restrict use to the Auth workload and signer-agent. Its newline-delimited JSON-RPC 2.0 ExecutionToken namespace remains restricted to `GetActiveKey`, `ListPublishedKeys` and `SignEs256`; signing accepts one published `kid` plus base64url JWS signing input and returns fixed-width base64url JOSE `r || s`. ADR 0017 adds only the separately domain-bound `GetExternalApiKeyVerifierStatus` and `ComputeExternalApiKeyVerifier` methods; it does not widen `SignEs256`, expose a general MAC API or accept caller-selected algorithms/backend key references. The agent uses workload identity to access a PKCS#11-compatible production HSM/KMS gateway or a local PKCS#11-compatible test HSM. It resolves opaque key and optional credential references internally, retains all private/HMAC key material, and never exposes a DER private key, raw Pepper, backend credential or arbitrary key selector.

Signer-agent preflight is part of Auth readiness: socket identity/permission, active and overlap JWKs, rotation timeline, requested published `kid`, and a sign/verify challenge must all succeed. Missing sidecar, TCP/DNS endpoint substitution, unmounted PKCS#11 backend, reference mismatch, or failed preflight prevents exchange/JWKS serving. Local security integration runs the actual sidecar and non-exportable test key; isolated unit fakes remain unit-test-only.

#### 7.1.9 PKCS#11 key selection, rotation and credential lease

The configured signing-key reference is exactly one RFC 7512 PKCS#11 URI. It pins the token serial, private-key `CKA_ID` (`id`) and `type=private`; Auth never selects a slot, object or key from a request. The agent resolves the matching P-256 public key using that same token serial and `CKA_ID`, requires the private key to be non-extractable, derives its ES256 public JWK, and derives `kid` as the RFC 7638 SHA-256 JWK thumbprint. A retired `kid` can never return to the published set.

Deployment/SRE owns the read-only rotation manifest at `docker/grpc-trust/execution-token-signer/config/**`, mounted to the agent through `EXECUTION_SIGNER_ROTATION_MANIFEST_PATH`. Every canonical PKCS#11 URI / expected-`kid` record carries RFC 3339 UTC `publishNotBefore`, `signingNotBefore`, `signingNotAfter` and `retireAfter`. The agent validates every declared JWK and `kid` against the HSM and permits exactly one active signer; it publishes the active/overlap keys only during their manifest windows. `retireAfter` is at least `signingNotAfter + 300 seconds + 60 seconds`, so verifiers can retain a JWKS key for every valid maximum-TTL Token and clock skew. Auth treats any manifest, HSM or timeline mismatch as a readiness failure, not a request-time choice or fallback.

The normal provider credential is workload identity. If the backend requires a separate credential, deployment gives only the agent an opaque reference resolved through its secret broker; Auth never sees a PIN, resolved credential, private key or raw PKCS#11 handle. The agent logs in as `CKU_USER` only for the configured token/slot, maintains a leased session, refreshes it before expiry, and zeroizes, logs out, closes and fails closed on credential/session refresh failure. The approved local protected integration asset is SoftHSM2 at `docker/grpc-trust/execution-token-signer/local/softhsm2/**`: it generates a sensitive, non-extractable P-256 key inside its token and mounts token state/PIN only as a permission-restricted agent secret file. An actual agent-over-UDS integration test, not a fake signer, must prove export refusal, manifest mismatch, credential-lease failure, unavailable agent/HSM failure, signing verification and key rotation.

#### 7.1.10 Protected external API-key verifier provider

Auth owns API-key verifier semantics and the application port; Deployment/EXEC-CRYPTO owns the protected provider asset, HMAC key lifecycle, backend reference manifest, workload credential delivery and SoftHSM integration. The final Auth port is operation-oriented: it computes a verifier and returns an opaque logical version. It never resolves or returns Pepper material. The preliminary `resolve(): { version, material }` seam is prohibited from production composition and must be replaced rather than retained as a fallback.

The sole cryptographic operation is `ComputeExternalApiKeyVerifier(mode, identifier, secret, verifierKeyVersion?)`. `ISSUE` forbids a requested version and uses the provider's unique active version; `VERIFY` requires exactly the credential-stored version and accepts it only while provider state is `ACTIVE` or `VERIFY_ONLY`. The provider also exposes read-only `GetExternalApiKeyVerifierStatus` metadata containing opaque active/verification lifecycle data plus terminal compromise evidence defined below, never a backend key reference. Requests cannot select a KMS/HSM object, algorithm, domain, arbitrary message or credential. The HMAC algorithm is fixed to HMAC-SHA-256 over the canonical byte sequence `ASCII("oes.auth.external-api-key-verifier/v1") || 0x00 || ASCII(identifier) || 0x00 || BASE64URL_DECODE(secret)`. The identifier must be the canonical unpadded base64url encoding of 18 random bytes and the secret the canonical unpadded base64url encoding of 32 random bytes. The result is exactly 32 bytes encoded as unpadded base64url; Auth decodes the stored/candidate values to equal-length buffers and compares them with a constant-time primitive.

The provider maps opaque logical versions to deployment-owned backend key references internally. Exactly one version is `ACTIVE` for issue; older versions may be `VERIFY_ONLY` so ordinary Pepper rotation never forces an otherwise valid external credential offline. Before API-key capability readiness, Auth reads the distinct versions referenced by every active, unexpired or still-overlapping credential and requires the provider status to contain all of them plus exactly one active issue version. A version cannot retire until Auth proves that no such row references it and the declared backup/restore recovery window has elapsed. A confirmed HMAC-key compromise disables that version, permanently revokes every associated credential and requires replacement; it never reactivates an old secret.

Production/staging use the existing per-Auth UDS agent with workload identity and a distinct non-exportable 256-bit HMAC key, separate from the ES256 signing key. Missing provider, invalid/missing version, zero/multiple active versions, manifest/backend mismatch, timeout, credential failure or HSM/KMS outage closes API-key create, rotate and exchange without an environment/file/memory fallback. List and revoke remain available, unrelated Auth login/session capabilities remain independent, and an already issued Gateway-only external token retains only its existing five-minute maximum.

Day-to-day host development may explicitly bind `LocalDevelopmentExternalApiKeyVerifier` to a generated, repository-ignored, owner-readable local key only when the runtime proves `NODE_ENV=development` and a separate local-development security profile. It never satisfies staging/production or security-acceptance readiness; those environments must reject it. The required security integration still runs the actual UDS agent with SoftHSM2, using a distinct `CKK_GENERIC_SECRET` / `CKM_SHA256_HMAC` object marked sensitive and non-extractable. Acceptance covers raw-key export refusal, fixed domain/algorithm enforcement, arbitrary selector rejection, version overlap/retirement, constant-time comparison, local-provider production rejection and unavailable/mismatched provider fail-closed behavior.

#### 7.1.11 Verifier-version compromise workflow

Auth owns the internal CQRS command `CompromiseExternalApiKeyVerifierVersion` and durable `ExternalApiKeyVerifierCompromiseIncident` completion fact. Deployment/EXEC-CRYPTO owns the decision/evidence that one logical verifier version is compromised and the provider/backend action that makes it unusable. This is a fail-safe ordered workflow rather than a distributed transaction: Deployment first removes the version from every compute allowlist and confirms the backend version is disabled, then its dedicated security-operation runner invokes Auth. If Auth is unavailable or its transaction fails, the provider remains disabled and new exchanges using that version remain impossible while the command is retried.

The provider status contract has a terminal `COMPROMISED_DISABLED` state containing only the opaque logical version, safe `incidentReference`, `occurredAt` and immutable/monotonic `stateRevision`; it contains no backend selector or key material. The agent may report this state only after both its local operation allowlist denies the version and the configured backend confirms it cannot execute MAC operations. The state can never return to `ACTIVE` or `VERIFY_ONLY`; recovery uses a new logical version and replacement credentials.

The sole remote invocation is `ExternalApiKeyCredentialService.CompromiseExternalApiKeyVerifierVersion` on Auth's existing internal gRPC host. It has no external HTTP/Gateway route and is not a HUMAN or tenant-admin management method. The exact caller is an environment-registered deployment `security-operations-runner` workload using verified mTLS identity, `aud=auth-service`, certificate-bound INTERNAL ExecutionToken and Code `auth.internal.external_api_key.verifier_version.compromise` in SYSTEM scope. No HUMAN/MACHINE role receives that Code; no wildcard workload policy is valid. Any upstream human approval remains in the deployment incident system. Auth consumes only trusted workload/operator/trace facts and never accepts operator identity from the request body.

The request contains only `verifierKeyVersion`, safe opaque `incidentReference` and `occurredAt`. The incident reference is 1–128 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}` and is an identifier, never free-text incident narrative. Auth requires provider status for that exact version to be terminal-compromised with exactly matching incident/time evidence before changing its database. The request has no backend key selector, credential/tenant/machine ID, key/verifier material, reason text or reactivation flag. `occurredAt` is incident evidence and cannot backdate database mutation; Auth uses its own `processedAt` as revocation time.

Within one Auth database transaction the handler creates or resolves the unique incident completion record, locks every credential row carrying that version, preserves existing `REVOKED` state and original `revokedAt`, revokes every remaining row at the same server `processedAt`, and writes safe per-newly-revoked plus aggregate authentication-security audit facts. A failure in any row/audit/incident write rolls back the entire Auth transaction. `incidentReference` is globally unique and `verifierKeyVersion` can have only one compromise incident: an exact replay returns the stored counts without new mutation/audit; the same reference with different version/time, or the same version with another reference, is an idempotency conflict. Concurrent exact invocations serialize on these uniqueness constraints.

The stored incident fact includes incident/version, provider `stateRevision`, evidence/processed times, caller workload and trace correlation, matched/newly-revoked/already-revoked counts. Per-credential audit is emitted only for newly revoked rows; already-revoked credentials keep their original revocation facts and appear only in the aggregate count. Neither response nor audit includes secret, verifier, backend reference, Authorization value, external/internal Token or credential list. The response returns only `incidentReference`, the three counts and `completedAt`. Already-issued Gateway-only access tokens retain the existing five-minute maximum; this workflow does not reopen DG-2 or add a Gateway deny cache.

#### 7.1.12 ExecutionToken authority upper bound and root input

Auth owns ExecutionToken exchange orchestration, but it does not own role, Permission or target-service RPC semantics. `requestedPermissionCodes` is a minimum-scope request only. Auth resolves an independently verifiable source credential for HUMAN/DELEGATED, or current mTLS + typed selector + live Identity owner decision for MACHINE, then consumes Permission Service's `ResolvePrincipalAuthorization` decision for BUSINESS or `ResolveWorkloadIssuance` for INTERNAL. Auth signs only when every requested Code is granted and the decision matches the trusted principal, tenant/org, verified workload and target audience; unknown, denied, mixed-kind, partial, stale or unavailable decisions fail the whole exchange. Assigning the requested set to an `authorized`, `permissionCodes` or equivalent field before the Permission decision is prohibited self-authorization.

The Permission issuance-control trust path is deliberately non-circular. Auth calls `ResolveWorkloadIssuance` without a pre-existing ExecutionToken, over the existing mTLS / SPIFFE transport; Permission accepts only Auth's exact registered `VerifiedWorkloadIdentity` for that exact method and independently evaluates the original verified workload -> target audience -> INTERNAL Code policy. Auth cannot use this bootstrap path for any other Permission RPC or treat its own mTLS identity as an INTERNAL grant. After Permission allows the exact Code set, Auth signs a certificate-bound `aud=permission-service` Token containing `permission.internal.principal_authorization.resolve` before calling `ResolvePrincipalAuthorization`. That BUSINESS resolver and every other protected Permission capability continue to require normal mTLS plus target-audience ExecutionToken enforcement.

`ResolvePrincipalAuthorization` is an Auth-only coarse BUSINESS issuance upper bound, not a Gateway/application resource authorization API. Auth supplies typed HUMAN / MACHINE / DELEGATED reference, trusted scope / tenant / org, target audience, canonical non-empty BUSINESS Code set and applicable session/delegation/tool references; it never supplies roles, admin flags, resource facts, domain state or a caller-computed granted set. SELF_SERVICE does not consume this resolver. Permission returns an all-or-nothing decision with exact granted/denied Codes, binding echo, safe reason, decision reference and `authzVersion`; Auth never signs a partial subset from a denied request.

Opaque source credentials remain transport-private and separate from the exchange DTO for HUMAN, multi-hop OBO, Gateway-only API Key and DELEGATED routes. Direct MACHINE root instead uses an optional typed selector in the request and requires Authorization to be absent. Auth combines that non-secret selector only with transport-derived SPIFFE/leaf facts and Identity live owner truth. A HUMAN session source yields immutable account, tenant/scope, `session_id` and `session_terminal` facts from the same active session record; a multi-hop subject Token additionally requires an exact self audience. A subject/tenant/terminal/role/Code copied from body, ordinary metadata, legacy signed operator context or selector never enters the issuance decision.

ExecutionToken reuse is bounded by principal/type, tenant/org, exact audience, canonical granted Code set, delegation/session/security version, applicable `session_terminal` and current workload certificate thumbprint. One cached Token may serve multiple target RPCs whose local declarations accept that same audience, principal mode, terminal constraint and Code set; Auth does not issue one Token per RPC and does not own a target-RPC registry. Target services remain responsible for BUSINESS/SELF_SERVICE/INTERNAL declaration enforcement, `all/any` Code checks, optional exact session-terminal checks, self-target derivation, resource ownership and domain rules. SELF_SERVICE uses an empty Code set; BUSINESS and INTERNAL use non-empty sets, with Permission independently establishing the corresponding principal or workload upper bound.

The issuance audit records route kind, applicable credential or MACHINE selector/Identity decision reference, verified principal/workload, tenant/org, audience, requested/granted Codes, Permission decision reference and `authzVersion`, session/delegation reference, certificate thumbprint, signing `kid`/Token `jti`, result/reason and trace correlation. It excludes bearer values and recoverable credentials. External API Key credential verification and Gateway-only token behaviour remain governed by DG-3 and are not widened by this ExecutionToken exchange rule.

## 8. Login Methods And Credentials

`auth-service` owns 认证可用性；`identity-service` owns 联系资产主数据。

稳定规则：

- `identity-service` owns email / phone / social contact asset、联系资产验证状态、用户 / 账号展示资料、公司受控联系方式交接与外部通信账号展示引用。
- `auth-service` owns login method、password credential、OTP challenge、MFA credential、recovery code 与 password setup requirement。
- 第一阶段 OES 登录默认使用个人 primary login method；公司分配的工作邮箱、工作手机号、公司受控社交账号或外部通信账号展示引用不作为默认登录方式。
- `TERMINAL_PIN` 是 `auth-service` 拥有的 user-scoped login credential，可供 PDA、KIOSK、触摸屏等现场共享终端使用；不得命名或建模为 PDA 专属凭据。
- `TERMINAL_PIN` 绑定 `userId`，不绑定 `accountId`、`employeeId` 或 `terminalDeviceId`；能否登录某租户终端仍由设备绑定租户、active employee、employee-account binding、account enabled、Terminal Access Policy 与设备状态共同决定。
- `TERMINAL_PIN` 设置、修改、忘记后重设、启用和停用属于 Web 已登录后的 self-service 账号安全能力，必须通过 step-up 保护；PDA 不提供 PIN 设置或找回流程。
- 管理员可要求用户重设 `TERMINAL_PIN` 或禁用目标用户的 `TERMINAL_PIN` login method，但不得查看、生成或设置明文 PIN。
- `TERMINAL_PIN` 必须只保存 hash；认证、诊断或审计日志不得记录 PIN 明文。
- `auth-service` 可以保存认证所需的 normalized identifier 或目标地址快照，但不得把它扩展为 email / phone 联系资产主数据。
- 联系资产绑定、变更或验证完成后，是否同步创建或启用 login method，必须通过显式 self-service 或 admin-management 接口完成。
- Contact Asset 与 Login Identifier 必须分离；任何工作邮箱、工作手机号或社交 handle 是否可登录，都必须通过 `auth-service` login method 显式表达。
- password recovery 使用认证域 challenge 与一次性 reset grant，不暴露账号存在性。
- 管理员要求用户重设密码应通过 admin-management 语义表达；用户自助修改或找回密码应通过 self-service / unauthenticated recovery 语义表达。
- 租户不配置 primary login method。
- 平台级 Terminal Entry Login Policy 定义每类 terminal 固定登录入口允许哪些已实现 login flow。
- 用户自己管理 credential / authenticator 可用性；Terminal Entry Login Policy 不表达 user、account、tenant 或单台设备级 login method override。

## 9. OTP And Notification Boundary

OTP 与通知投递必须分离 owner。

`auth-service` owns：

- OTP challenge 创建
- OTP value / hash / 校验
- OTP usage
- OTP 过期
- OTP 发码频控
- OTP 尝试次数
- OTP 相关认证审计
- OTP 是否通过并推动认证流程

`notification-service` owns：

- 通知 dispatch
- 模板
- 渠道
- provider adapter
- 发送任务
- 投递状态
- 回执
- 失败原因
- 成本与通知侧可观测性

`auth-service` 可以同步调用 `notification-service` 获取“通知请求已被受理 / 拒绝”的结果，但不得同步等待外部供应商真正送达。`notification-service` 不拥有 OTP 真相，也不判断 OTP 是否正确。

该下游调用不是 HUMAN 直接操作 Notification。`SendEmail` / `SendSms` 固定由 Auth 使用既有 MACHINE root 建立 SYSTEM execution，以 `aud=urn:oes:service:notification-service`、INTERNAL Code `notification.internal.auth.dispatch` 的 certificate-bound ExecutionToken 调用；上游 session/challenge/user/admin 归因保留在 Auth 审计，不传播为 Notification 授权。精确语义以 [Notification Auth dispatch contract](../../contracts/notification-service/auth-dispatch.md) 为准。

Auth production 与普通 local development 都必须通过 trusted gRPC Notification boundary。历史 `LocalNotificationDispatchAdaptor`、Auth-local Email/SMS service 与 `effectiveCode` 不属于 runtime 或兼容 fallback；isolated unit test 可以注入不修改 OTP 的 fake port。缺少 provisioned MACHINE selector、target ET producer 或 Notification client 时 readiness fail closed。

## 10. MFA Policy And Challenge

`auth-service` owns authentication MFA policy and challenge orchestration。

稳定范围：

- user MFA binding
- `EMAIL_OTP`
- `SMS_OTP`
- `TOTP`
- `BACKUP_CODE`
- platform default terminal MFA policy
- tenant terminal MFA policy
- login MFA challenge
- new-device login MFA
- sensitive action step-up MFA
- short-lived MFA grant token

稳定规则：

- 不设计全局 MFA 开关；MFA 按 terminal 独立配置。
- platform default terminal MFA policy 用作新租户或未配置租户的默认值，不是强制最低安全基线。
- tenant terminal MFA policy 是 TENANT scope account 登录时的最终优先策略；租户可以按 terminal 覆盖得更严格或更宽松。
- PDA / KIOSK 默认关闭登录 MFA，但模型层允许显式开启。
- PDA / KIOSK 高风险业务动作优先通过业务 step-up、主管确认或审批流设计，不属于常规登录 MFA。
- `permission-service` 不拥有 MFA policy 真相；它只判断管理者是否有权读取或修改 MFA policy。
- user MFA binding 与 tenant / platform MFA policy 是两个不同层次：策略决定是否需要 MFA，binding 决定当前 user 有哪些可用因子。
- `EMAIL_OTP / SMS_OTP` 的 MFA factor challenge 必须由用户显式触发发码；返回 `MFA_REQUIRED` 不等于已发出 OTP。
- `TOTP / BACKUP_CODE` 不依赖 notification dispatch。
- recovery codes 是 TOTP 的恢复与兜底能力，服务端只保存 hash，明文只在生成 / 轮换响应中展示一次。
- step-up MFA 面向已登录敏感操作，不与 login MFA flow 混用。

## 11. Device Context And Trusted Device

设备上下文用于 session 展示、登录历史、审计、trusted-device 与 new-device MFA。

当前稳定边界：

- `auth-service` 通过显式请求字段接收设备上下文，例如 `deviceId`、`deviceName`、`userAgent`、`ipAddress`。
- 当前阶段以 `SelectAccount` / 登录流程相关请求中的显式字段作为设备上下文进入 session 主链的正式入口。
- BFF 可以从 HTTP request 中提取 `user-agent`、client IP 或前端传入的 device 信息，再显式传给 `auth-service`。
- 裸 `ipAddress` 或裸 `userAgent` 不得单独作为 trusted-device 判定依据。
- trusted-device truth 需要以稳定 `deviceId` 等明确设备标识为基础。
- Personal trusted login device 只用于个人化登录环境，例如 Web trusted browser 与 future Mobile remembered app/device。
- PDA / KIOSK 受管设备不作为某个 user 的 personal trusted login device，不提供“信任此 PDA / KIOSK”或 remember MFA 语义。
- 受管终端设备是否 active、disabled、lost、bound 或 retired 的真相归 `terminal-device-service`；`auth-service` 只消费其状态与 `terminalDeviceId` 引用。

未来若要把设备上下文改为统一 gRPC metadata、operator context 或 `src/common` 自动传播机制，必须先走项目级 architecture / common 设计；`auth-service` 单服务线程不得私自扩展共享上下文结构。

## 12. Self-service And Admin-management Boundary

`auth-service` 的接口层必须显式区分 self-service 与 admin-management。

Self-service 默认语义：

- 当前用户修改自己的密码。
- 当前用户管理自己的 login methods。
- 当前用户管理自己的 MFA binding。
- 当前用户查看和管理自己的 sessions。
- 当前用户查看自己的 login history。
- target 必须由当前 session / operator context 解析，不接受前端任意指定他人 target。
- 不默认要求管理员 permission code，但仍必须满足安全策略、白名单动作与审计要求。

Admin-management 默认语义：

- 管理员查看或治理目标用户 sessions。
- 管理员撤销目标 session。
- 管理员按 user / account / tenant / terminal / terminalDeviceId 筛选 sessions。
- 管理员撤销指定 user 的全部 sessions。
- 管理员要求目标用户重设密码。
- 管理员启用 / 停用目标用户 login method。
- 管理员读取或修改 tenant / platform MFA policy。
- 平台管理员读取或修改 platform terminal entry login policy 与 platform default terminal MFA policy。
- 必须经过 `RBAC + scope / resource` 授权判定，并记录审计。

Phase 2 管理员 session 写操作不提供按筛选结果、terminal、terminalDeviceId 或 tenant 的任意批量 revoke。

application / domain 层可以复用底层业务逻辑，但 BFF / gRPC / interface 层不得长期复用同一个权限门承载 self-service 与 admin-management。

历史混合接口只作为迁移债，不得继续扩展；剩余迁移由 [backlog](../../plans/backlog.md) 的单一 closure item 跟踪，而不是在各服务中分别维护孤立清单。

## 13. Audit Facts

`auth-service` owns local authentication and session audit facts。

稳定规则：

- 所有认证、安全与 session 状态变化都应记录认证域本地审计事实。
- 审计事实应尽量携带 `operatorId`、`userId`、`accountId`、`scopeLevel`、`tenantId`、`orgId`、`sessionId`、`terminal`、`loginFlow`、`terminalDeviceId`、`deviceBoundTenantId`、`traceId` 与设备上下文摘要。
- tenant-bound 审计查询必须按 operator scope 收敛。
- system scope 可按授权查询全局认证域审计。
- 未来集中审计平台可以聚合、索引、归档、检索或展示认证域审计事实，但不接管 `auth-service` 的本地审计事实 owner。
- login history 是认证域审计事实的产品化、脱敏查询视图，不另立第二套登录历史真相。
- 普通 login history 不展示每次 access token validate 或 refresh 成功；refresh replay、session revoke、设备状态触发清退等安全事件进入 security activity 或管理员审计视图。

## 14. External Interfaces

典型上游入口：

- `api-gateway`
- Auth BFF
- tenant-web / platform web through BFF
- 受控内部服务

典型契约位置：

- [auth-service/login.md](../../contracts/auth-service/login.md)
- [auth-service/session.md](../../contracts/auth-service/session.md)
- [auth-service/mfa.md](../../contracts/auth-service/mfa.md)
- [auth-service/audit.md](../../contracts/auth-service/audit.md)
- [auth-service/terminal-login-policy.md](../../contracts/auth-service/terminal-login-policy.md)
- [auth-service/terminal-mfa-policy.md](../../contracts/auth-service/terminal-mfa-policy.md)
- [auth-service/session-management.md](../../contracts/auth-service/session-management.md)
- [auth-service/login-history.md](../../contracts/auth-service/login-history.md)
- [auth-service/trusted-login-device.md](../../contracts/auth-service/trusted-login-device.md)
- [auth-service/execution-token.md](../../contracts/auth-service/execution-token.md)
- [auth-service/external-api-key-security.md](../../contracts/auth-service/external-api-key-security.md)

相关 BFF contract：

- [auth-bff-login.md](../../contracts/api-gateway/auth-bff-login.md)
- [auth-bff-self-service.md](../../contracts/api-gateway/auth-bff-self-service.md)
- [auth-bff-admin-security.md](../../contracts/api-gateway/auth-bff-admin-security.md)
- [account-security-bff.md](../../contracts/api-gateway/account-security-bff.md)
- [platform-auth-security-bff.md](../../contracts/api-gateway/platform-auth-security-bff.md)
- [access-summary.md](../../contracts/api-gateway/access-summary.md)

Contract 文档只描述黑盒调用语义、字段、错误与当前接口形状；不得重新定义本文中的服务 owner、核心对象或长期边界。

## 15. Upstream Dependencies

- `identity-service`
  - 提供 user、account、login target 相关身份映射与展示查询支撑。
  - 提供当前 user 可用 account context 列表与 account 摘要。
  - 拥有联系资产主数据与账号展示资料真相。
  - 提供 Machine Principal identity、scope、tenant reference 与 lifecycle；不保存 API Key secret 或签发 ExecutionToken。
- `tenant-org-service`
  - 提供 tenant lifecycle、tenant 摘要、org tree 与组织上下文支撑。
  - 为 TENANT scope session 建立、refresh、validate 与 context switch 提供 tenant status 校验依据。
- `permission-service`
  - 为 admin-management、terminal login policy、MFA policy 管理、audit 查询等受保护管理能力提供授权判定。
  - 提供 access summary 与导航授权支撑，但不拥有 session context；permission 侧核心对象与 owner 边界以 [permission-service.md](./permission-service.md) 为准。
  - 提供 HUMAN / MACHINE principal grant、Permission Code 与 policy 判定，供 STS 计算 ExecutionToken 的获准 Permission 子集。
- `terminal-device-service`
  - 提供受管终端设备状态、设备绑定 tenant 与设备不可登录事件。
  - 不拥有 auth session、token、MFA、trusted login device 或认证审计真相。
- `notification-service`
  - 提供 OTP、安全提醒等通知 dispatch 能力。
  - 不接管 OTP、challenge 或认证结果真相。
- `api-gateway` / BFF
  - 提供 HTTP contract、防腐层、captcha、前端响应聚合、session context view 与 access summary 聚合。

## 16. Downstream / Published Facts

- 主认证结果。
- 认证续流状态。
- challenge 是否存在、是否已完成、是否过期。
- 当前 session 是否有效。
- 当前 session context 摘要。
- terminal-aware session metadata。
- access token 与 refresh token 签发结果。
- target-audience ExecutionToken、JWKS 与紧急撤销 / minimum security version 事实。
- API Key credential lifecycle 与认证结果；不发布可恢复的 API Key secret。
- refresh token rotation 与 replay 处理结果。
- account selection / context switch 后的 session 更新结果。
- MFA policy 与 MFA binding 查询结果。
- Terminal Entry Login Policy 与 Terminal MFA Policy 查询结果。
- step-up MFA grant 结果。
- 登录历史与认证域本地审计查询结果。

## 17. Non-goals

- 不直接暴露外部 HTTP API；外部客户端统一通过 Gateway / BFF。
- 不拥有前端 shell、导航菜单、权限摘要或页面聚合模型。
- 不复制 `identity-service` 的 user / account / contact asset 主数据。
- 不复制 `tenant-org-service` 的 tenant / org 主数据。
- 不复制 `permission-service` 的 role / policy / authorization truth。
- 不拥有 Machine Principal identity 或 lifecycle，也不把 API Key credential 建模成 principal。
- 不复制 `terminal-device-service` 的 managed terminal device registry、设备绑定、设备状态或版本策略真相。
- 不直接对接 Email / SMS provider。
- 不保留 local notification runtime fallback，也不允许 Notification 回写或替换 Auth-owned OTP。
- 不在本文冻结 Redis、Prisma 或其他存储实现方案。
- 不把基础 self-service 能力建模为普通 RBAC 岗位权限。
- 不让租户配置 primary login method。
- 不把 PDA / KIOSK 受管设备作为 personal trusted login device。
- 不通过 service-local docs、feature packet 或 contract 文档长期承载第二份 auth-service 服务设计。

## 18. Current Stage And Cleanup Rules

当前 `auth-service` 仍处于唯一真相元整理与历史文档收敛阶段：

- 本文已承接长期服务设计真相。
- `docs/contracts/auth-service/**` 继续作为黑盒 contract 真相，但不得重新定义服务职责。
- `docs/architecture/collaborations/**` 继续作为跨服务协同蓝图，但不得重新定义 `auth-service` owner 语义。
- `src/services/system/auth-service/doc/**` 中的旧 design、task、history、overview、roadmap 只作为本次提炼来源与历史记录，不再作为稳定设计入口。
- 服务内旧 docs 在提炼完成后应删除，或最多保留一个极短 README 指向本文与 contract 入口。
- self-service / admin-management 拆分的剩余工作由 [backlog](../../plans/backlog.md) 的单一 closure item 跟踪。

## 19. Trusted gRPC foundation-group admission（FROZEN）

`auth-service` 的 70 个既有 `AuthService` RPC 与 foundation RPC 目标组参加同一个五服务原子迁移候选；audience 固定为 `urn:oes:service:auth-service`。direct MACHINE root 解除首凭据递归；上述 target-owned INTERNAL login/session fact resolvers 解除固定 Auth principal 的 BUSINESS grant 耦合。两者都不改变登录、MFA、session、审计、限流或业务结果语义。

### 19.1 70-RPC 完整分类

下表每个方法只出现一次。`PUBLIC_*` 是在 execution context 建立前的专用 admission，不是伪造的 HUMAN/MACHINE ExecutionToken；只接受 Gateway 的准确 mTLS workload，并继续执行现有 anti-enumeration、rate-limit、challenge/grant、credential、session 与安全审计规则。

| 类别 | RPC（数量） | execution / terminal | Code 与 direct caller |
| --- | --- | --- | --- |
| `PUBLIC_CREDENTIAL` | `LoginWithEmailPassword`, `RequestEmailOtpLoginChallenge`, `LoginWithEmailOtp`, `LoginWithEmployeeCodePin`, `PreflightEmployeeCodePinLogin`, `LoginWithPhonePassword`, `RequestPhoneOtpLoginChallenge`, `LoginWithPhoneOtp`, `InspectPasswordRecoveryChannels`, `RequestPasswordRecoveryChallenge`, `VerifyPasswordRecoveryChallenge`, `CompletePasswordRecovery`（12） | pre-context / no terminal claim | empty Code；exact `api-gateway` mTLS workload；credential/challenge/rate/audit truth remains Auth-owned |
| `PUBLIC_CONTINUATION` | `CompleteFirstLoginPasswordSetup`, `RequestLoginMfaFactorChallenge`, `SubmitMfaChallenge`, `RefreshSession`, `SelectAccount`（5） | Auth-owned one-purpose continuation/refresh credential / no invented ET | empty Code；exact `api-gateway`; opaque grant/session proof must validate |
| `PUBLIC_SESSION_SOURCE_VALIDATION` | `ValidateAccessToken`（1） | Auth-owned access/session source verification | empty Code；exact `api-gateway`; bearer remains transport-private and is never copied into DTO/log/audit |
| `SELF_SERVICE` | `ListLoginHistory`, `BootstrapOwnLoginMethods`, `RequestEmailBindingChallenge`, `RequestPhoneBindingChallenge`, `ListLoginMethods`, `ChangeOwnPassword`, `SetOwnTerminalPin`, `ResetOwnTerminalPin`, `SetOwnTerminalPinEnabled`, `SetOwnLoginMethodEnabled`, `VerifyEmailBinding`, `VerifyPhoneBinding`, `ListMfaBindings`, `EnableMfaBinding`, `DisableMfaBinding`, `InitializeTotpBinding`, `ActivateTotpBinding`, `InitializeRecoveryCodes`, `RegenerateRecoveryCodes`, `StartStepUpMfaChallenge`, `CompleteStepUpMfaChallenge`, `ListSessions`, `ListTrustedDevices`, `RevokeTrustedDevice`, `RevokeOtherTrustedDevices`, `Logout`, `LogoutSession`, `LogoutOtherDevices`, `LogoutAll`（29） | `HUMAN`, `WEB`/the authenticated session terminal; exact self/session/resource binding | existing `auth.login_method.self.*` / `auth.session.self.*` where already declared, otherwise empty Code plus exact self rule; Gateway only |
| `BUSINESS` | `ListAuditEvents`（1） | `HUMAN`, `WEB` | `auth.audit.list`; Gateway |
| `BUSINESS` | `BootstrapUserLoginMethods`, `RequirePasswordSetup`, `RequireTerminalPinReset`, `DisableUserTerminalPin`（4） | direct `HUMAN` or foundation `HUMAN_OBO`, `WEB` | `auth.account_credentials.bootstrap`; Gateway, exact `hr-service`/`tenant-org-service` OBO where statically present |
| `BUSINESS` | `SetLoginMethodEnabled`（1） | `HUMAN`, `WEB` | `auth.account_login_methods.manage`; Gateway |
| `BUSINESS` | `GetTenantMfaPolicy`, `UpdateTenantMfaPolicy`, `GetTenantTerminalMfaPolicy`, `UpdateTenantTerminalMfaPolicy`（4） | `HUMAN`, `WEB` | `auth.mfa_policy.manage`; Gateway |
| `BUSINESS` | `GetPlatformMfaPolicy`, `UpdatePlatformMfaPolicy`, `GetPlatformTerminalLoginPolicy`, `UpdatePlatformTerminalLoginPolicy`, `GetPlatformDefaultTerminalMfaPolicy`, `UpdatePlatformDefaultTerminalMfaPolicy`（6） | `HUMAN`, `WEB` | `auth.platform_mfa_policy.manage`; Gateway SYSTEM-scope human only |
| `BUSINESS` | `HandleTerminalDeviceUnavailable`, `AdminListOnlineUsers`, `AdminListUserSessions`, `AdminListTerminalDeviceSessions`（4） | `HUMAN`, `WEB` | `auth.session.admin.view`; Gateway |
| `BUSINESS` | `AdminRevokeSession`, `AdminDeleteAccountSessions`, `RevokeTenantSessions`（3） | direct `HUMAN` or exact `tenant-org-service` `HUMAN_OBO`, `WEB` | `auth.session.admin.revoke`; Gateway / TenantOrg |

### 19.2 Foundation RPC target state

Program inventory 的目标状态是 `70+3`：两个 Auth-owned RPC `ExchangeExecutionToken`, `GetExecutionTokenJwks`，加 Identity-owned `ResolveMachinePrincipalForAuth`。Exchange 增加 optional typed MACHINE selector；Identity resolver 使用 exact Auth mTLS-only/no-Authorization policy。旧 Issue/Revoke RPC 在 migration drain 后移除；本原子组不得重写既有 HUMAN/OBO/API Key/DELEGATED claims、signer、certificate binding、registry 或审计语义。

### 19.3 request authority disposition

删除并 reserve 15 个旧 authority 字段及原号：`ListAuditEvents.operator_id=5/tenant_id=6/org_id=7`, `ChangeOwnPassword.tenant_id=5`, `ListTrustedDevices.tenant_id=2`, `RevokeTrustedDevice.tenant_id=2`, `RevokeOtherTrustedDevices.tenant_id=2`, `SetLoginMethodEnabled.operator_id=4`, `SetOwnLoginMethodEnabled.operator_id=4`, `StartStepUpMfaChallenge.tenant_id=3`, `UpdatePlatformTerminalLoginPolicy.operator_id=2`, `UpdatePlatformDefaultTerminalMfaPolicy.operator_id=2`, `UpdateTenantTerminalMfaPolicy.operator_id=3`, `VerifyEmailBinding.tenant_id=5`, `VerifyPhoneBinding.tenant_id=5`。`AdminListOnlineUsers.tenant_id=1`, tenant policy requests 的 `tenant_id=1` 和 `RevokeTenantSessions.tenant_id=1` 保留为显式 target/filter，不是 caller authority；TENANT subject 必须与 claim 相等，SYSTEM-scope HUMAN 必须通过 Code/scope，其他情况 fail closed。普通 metadata/operator/requestId fallback 全部移除。
