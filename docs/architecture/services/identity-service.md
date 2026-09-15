# identity-service 职责卡

## 1. Purpose

`identity-service` 是 OES 的账号、身份映射、登录身份查询、联系资产、机器主体与账号绑定关系真相服务，负责回答“这个自然人有哪些账号、账号属于哪个 scope / tenant 引用、账号如何映射到自然人主体或员工、哪些身份摘要可被认证、授权、BFF 与业务服务安全消费”。

涉及 HR `Employee / Employment`、员工生命周期或正式 `人 -> org` 归属时，以 [hr-service.md](./hr-service.md) 为准；本文只定义 identity 自身的账号、身份与 binding 边界。

本文是 `identity-service` 的唯一稳定设计真相源。其他 architecture、collaboration、contract、plan、feature packet 或服务内实现文档只能引用本文，不得重新定义 `identity-service` 的长期职责、核心对象、边界或 owner 语义。

## 2. Owns

- `User` 技术身份真相：
  - `userId`
  - 启用状态
  - legacy login handle 展示 / 迁移语义
- `UserAccount` 账号真相：
  - account id
  - `userId`
  - `scopeLevel`
  - tenant 引用
  - tenant account 上的 `tenantPartyId` 关联
  - account display name
  - account enabled / disabled lifecycle
- 当前 user 可用 account context 列表与 account 展示摘要。
- `UserAccount <-> Employee` 绑定结果真相；`Employee / Employment` 本体仍归 `hr-service`，以 [hr-service.md](./hr-service.md) 为准。
- 联系资产与账号归属关系：
  - 工作邮箱资产
  - 工作手机号资产
  - 公司受控微信 / WhatsApp / 其他社交账号资产
  - 员工个人社交联系方式在 OES 内的受控展示引用
  - 企业微信、飞书、钉钉等外部通信账号的名片展示摘要引用
  - 主工作联系方式标记
  - 联系资产启停、分配、回收、交接与审计语义
- 机器主体基础身份：
  - `ServiceAccount`
  - machine principal scope / type / lifecycle
  - `MachineWorkloadBinding`：Machine Principal 与受控 workload SPIFFE ID 的稳定绑定及其 lifecycle/version
  - `MachineWorkloadProvisioningReceipt`：固定 SYSTEM inventory entry 到 principal/binding 的幂等 provisioning 事实
- 面向认证、授权、BFF 与业务服务的受控身份查询结果。

## 3. Does Not Own

- 密码、OTP、MFA、login method、session、token、refresh token、认证 challenge 或认证审计真相；这些归属 `auth-service`。
- API Key secret / hash、credential 认证/签发/轮换/撤销、STS 与 ExecutionToken 签发；这些归属 `auth-service`。MACHINE selector 是 Identity owner reference，不是 credential。
- 权限码、角色、scope、policy、terminal access policy、授权判定、权限摘要或导航授权真相；这些以 [permission-service.md](./permission-service.md) 为准。
- `Tenant`、tenant lifecycle、`OrgUnit`、org tree、org hierarchy、org reference validation 或 `organizationTenantPartyId` 真相；这些以 [tenant-org-service.md](./tenant-org-service.md) 为准。
- `Employee`、`Employment`、正式 `人 -> org` 任职关系或 onboarding 业务结果；这些归属 `hr-service`。
- 现实世界自然人的真实姓名、法定姓名、昵称、多语言姓名或组织主体 canonical truth；这些归属 `party-service`。
- 客户、供应商、员工、联系人等业务角色语义真相；这些归属对应业务服务。
- 通知模板、渠道、provider、投递任务或通知投递状态真相；这些归属 `notification-service`。
- BusinessCard 的展示配置、Contact Action 排序、公开范围、vCard 输出规则或 public entry 真相；这些归属 BusinessCard / Public Entry owner。
- 外部通信平台的账号生命周期、OAuth token、refresh token、webhook、消息读取、消息发送或会话同步真相；这些需由后续 external communication integration / channel binding 设计冻结。
- API Gateway / BFF 的 HTTP contract、前端聚合形状或 UI 状态。

## 4. Core Responsibilities

- 提供 `User`、`UserAccount`、联系资产、机器主体与账号绑定关系的查询能力。
- `User` 不绑定 Party；租户账号通过 `UserAccount.tenantPartyId` 关联当前租户内 `PERSON` TenantParty。
- 维护 scope-aware `UserAccount`，支持 `SYSTEM` 与 `TENANT` 两类 account context。
- 为 `auth-service` 提供登录后 account candidate、account existence、account ownership、account enabled state 与 scope / tenant 引用事实。
- 为 `auth-service` 的员工码现场终端登录提供 `employeeId -> unique UserAccount + enabled state` 的受控解析事实；员工 lifecycle 与 active employment 仍由 `hr-service` 判断，PIN 仍由 `auth-service` 校验。
- 为 `api-gateway` / BFF 提供 account context、账号目录、身份展示摘要与必要的用户发现能力。
- 维护 `UserAccount <-> Employee` 绑定结果，并在绑定时校验同 tenant 与同自然人主体约束。
- 维护工作邮箱、工作手机号、公司受控社交账号、员工个人社交联系方式展示引用与外部通信账号展示摘要这类账号联系资产的分配、回收、启停、交接和主联系方式语义。
- 维护机器主体基础身份、`MachineWorkloadBinding` 与固定 SYSTEM inventory provisioning receipt，并向 Auth / Permission 提供稳定 principal id、type、scope、tenant/org reference、lifecycle 与 workload-binding decision；不保存认证 secret、叶证书或签发 token。
- 区分登录标识、联系资产、真实姓名与展示名，不把一个字段扩张成多种真相。
- 对当前账号自助资料修改与管理员资料管理使用显式分离的接口边界，不允许长期复用同一个 management 写接口承载 self-service 语义。

## 5. User And Login Identity Boundary

`identity-service` owns `User` 技术身份和可查询身份摘要，但不拥有认证凭据。

稳定规则：

- `User` 是技术身份，不持有 `partyId`。
- `User.username` 是历史字段；如被读取，只能作为可选 legacy login handle 展示或迁移依据。
- `User.username` 不是真实姓名、法定姓名、昵称、展示名或多语言姓名真相源。
- 若后续需要唯一用户名登录，应先冻结 login handle 语义，再同步更新 `auth-service` login method / credential 设计。
- 个人邮箱 / 个人手机号如作为登录标识参与认证，其认证可用性、密码、OTP 与 login method 归 `auth-service`；`identity-service` 只提供身份侧查询与联系资产 / profile 事实。
- 真实姓名搜索、自然人合并、法定主体识别等能力应通过 `party-service` 协同设计，不在 `identity-service` query 中直接扩展为姓名模糊搜索。

## 6. UserAccount And Account Context

`UserAccount` 表示一个自然人在某个工作上下文中的账号。

稳定规则：

- `UserAccount.scopeLevel = SYSTEM` 表示系统 / 平台账号。
- `UserAccount.scopeLevel = TENANT` 表示租户账号。
- `SYSTEM` account 不绑定 tenant，`tenantId` 必须为空。
- `TENANT` account 必须绑定真实 tenant 引用，`tenantId` 必填。
- `TENANT` account 可关联当前租户内 `tenantPartyId`；该字段用于表达账号在该租户上下文内对应的现实自然人主体。
- `CreateUserAccount` 收到上游显式传入的 `tenantPartyId` 时，应直接复用该租户主体引用；未传时可按既有账号创建流程向 `party-service` 注册当前租户 `PERSON TenantParty`。
- `SYSTEM` account 不关联 `tenantPartyId`。
- `tenantId` 在 `identity-service` 内只表示 account context 对 tenant 的引用，不是 tenant 主数据或 lifecycle 真相。
- `identity-service` 只按账号自身启用状态与 tenant 引用返回 account candidates；tenant lifecycle 由 `tenant-org-service` 提供并以 [tenant-org-service.md](./tenant-org-service.md) 为准，认证准入由 `auth-service` 消费后决策。
- account display name 是 account context 展示摘要，不等同于自然人真实姓名。
- 当前可切换 account context 列表归 `identity-service` 提供；切换后的 session context、token 与 refresh 语义归 `auth-service`。

## 7. Tenant / Org / HR Boundary

历史服务内旧文档曾把 `Tenant`、`Org`、org tree 与 account-org membership 作为 identity 设计正文。该方向已被当前项目级边界取代。

稳定规则：

- `Tenant`、tenant status、tenant lifecycle 与 tenant 展示摘要以 [tenant-org-service.md](./tenant-org-service.md) 为准。
- `OrgUnit`、org tree、org hierarchy 与 org reference validation 以 [tenant-org-service.md](./tenant-org-service.md) 为准。
- `Employment -> OrgUnit` 是正式 `人 -> org` 任职真相，归 `hr-service`。
- `UserAccount <-> Employee` binding 必须校验同 tenant，且 `UserAccount.tenantPartyId == Employee.tenantPartyId`。
- `ResolveEmployeeLoginAccount` 保留为既有 BUSINESS compatibility query，不作为 Auth pre-HUMAN 登录入口；员工码现场登录只使用 Auth-only INTERNAL `ResolveAuthEmployeeLoginAccount`，由 Identity 基于既有 `UserAccount <-> Employee` binding 校验唯一 account、tenant owner 关系及 enabled state。两者都不得把 identity-service 扩展为 HR lifecycle、terminal access 或 PIN owner。
- legacy account-org membership 或 account 视角 org 数据只能作为 compatibility / projection 口径存在，不得成为 onboarding、HR、授权或组织治理主链 owner。
- `identity-service` 可在账号、联系资产、机器主体、审计记录中保留 `tenantId / orgId` 引用字段，但不得通过本地模型或共享数据库读取 tenant / org 真相。

## 8. Contact Assets

`identity-service` owns account-scoped contact asset truth。

稳定规则：

- Contact Asset 第一阶段服务员工资料与 Employee Digital Business Card 的联系方式展示，不承接外部账号登录绑定、OAuth token、webhook、消息读取或消息发送。
- Contact Asset 的 primary 关联是 tenant-scoped `UserAccount`：
  - `tenantId + accountId` 是第一阶段主归属口径。
  - `userId` 是身份主体引用与查询辅助。
  - `employeeId` 可作为当前分配对象或 HR lifecycle 协同引用，但不是 Contact Asset owner。
- 第一阶段 Contact Asset 类型包括：
  - `WORK_EMAIL`
  - `WORK_PHONE`
  - `WECHAT`
  - `WHATSAPP`
  - `EXTERNAL_COMMUNICATION_ACCOUNT`
  - `OTHER_SOCIAL`
- 工作邮箱和工作手机号是账号联系资产，可分配、回收、启停、标记主联系方式并记录审计。
- `WECHAT` / `WHATSAPP` 可表达公司受控账号或员工个人账号，必须通过 ownership 区分。
- 公司名下手机号注册的微信、WhatsApp 或其他社交账号在 OES 内视为公司受控 Contact Asset；员工只是当前使用 / 分配对象，不是资产 owner。
- 员工个人微信、WhatsApp 或其他个人社交联系方式可作为名片兜底展示引用，但不是公司资产；公司不得在离职后回收或转交该个人账号。
- 员工个人联系方式第一阶段不建立独立 consent 模型；添加、修改、移除和展示配置动作必须记录审计元数据。
- 企业微信、飞书、钉钉等第一阶段建模为 `EXTERNAL_COMMUNICATION_ACCOUNT`，只保存 provider、handle / external reference、display summary 等名片展示摘要；外部平台账号 lifecycle 仍归外部平台。
- 同一类社交联系入口在 BusinessCard 默认只展示一个：公司受控 Contact Asset 优先；没有公司受控账号时，才展示员工个人联系方式引用。
- 公司受控社交账号在员工离职、调岗失去使用权或 account disabled 时，默认立即从原员工名片隐藏，并进入交接或停用状态。
- 第一阶段 Contact Asset 最小状态语义为 `ACTIVE`、`PENDING_HANDOVER`、`DISABLED`、`RELEASED`；更细 verification、sync、claim、lost 或 revoked 状态需另行冻结。
- 工作联系方式不天然等于登录方式；是否可登录、是否已启用 login method、OTP / password credential 均归 `auth-service`。
- 第一阶段 OES 登录默认使用个人 primary login method；公司分配的工作邮箱、工作手机号、公司受控社交账号不作为默认登录方式。
- BusinessCard 只能引用 Contact Asset 并决定展示配置、排序、公开范围和是否进入 vCard，不拥有 phone、email、WeChat、WhatsApp 或外部通信账号正文。
- 第一阶段不做 org / team / role 级公共联系资产；公共号、部门号、客服号或销售公共号应通过后续设计单独冻结。
- 自助联系绑定与管理员联系资产治理必须分离：
  - self-service 只作用于当前登录主体，并从当前 session / operator context 派生 target。
  - admin-management 面向目标账号或目标用户，必须经过权限与 scope 判定。
- 联系资产可保存 `tenantId / orgId` 作为上下文引用，但不拥有 tenant / org 真相。

## 9. Machine Identity

`identity-service` owns machine principal identity foundation。

稳定范围：

- `ServiceAccount` 是当前机器主体基础模型。
- `scopeLevel` 表达 `SYSTEM / TENANT` 机器主体。
- `TENANT` scope machine principal 必须绑定真实 tenant 引用。
- `SYSTEM` scope machine principal 不绑定 tenant。
- `type` 表达机器主体类型，例如 internal service、external integration、AI agent 或 automation bot。
- lifecycle 至少需要 active / disabled 语义。

`Integration Machine` 是 `type = external integration` 的 tenant machine principal 使用形态，而不是新的共享 App 或 credential owner。稳定规则：

- 必须是 `TENANT` scope，并且一台 machine 只绑定一个 tenant；它不能转换为 SYSTEM、跨 tenant 复用或代表人类 account。
- Identity owns its display name、tenant reference、type and active/disabled lifecycle. It returns only the stable machine reference and lifecycle facts needed by Auth and Permission.
- Auth may create and manage credentials only for an active Integration Machine. Identity never stores, verifies, lists, reveals, rotates, or revokes API Key secrets.
- A disabled machine is not eligible for new credential exchange or external access. Credential and session invalidation semantics remain Auth-owned; the cross-service path is [external-api-key-security.md](../collaborations/external-api-key-security.md).
- Identity exposes one Auth-only `ResolveIntegrationMachineForAuth` query on its existing `IdentityQueryService` gRPC surface. The request contains only the Auth-derived machine reference. Identity returns its owned machine id, tenant reference, scope, type, lifecycle status, opaque lifecycle version and safe decision reference; it never accepts a caller-supplied tenant as authority and never returns API Key material or permission facts.
- The query is an INTERNAL technical primitive requiring verified `auth-service` workload identity, target audience `identity-service`, certificate binding and exact issuance Code `identity.internal.integration_machine.resolve`. Gateway, external callers and ordinary HUMAN/MACHINE roles cannot obtain this Code. Only `scopeLevel=TENANT`, `type=EXTERNAL_INTEGRATION`, `status=ACTIVE` and a non-empty tenant reference is eligible. Missing, wrong-type, wrong-scope or inactive machines return an ineligible decision; transport/trust failure is fail-closed for API Key exchange.

内部 Cron、Robot 与 worker 使用另一条 generic Machine Principal resolution，不复用 external Integration resolver：

实现状态：`DESIGN_FROZEN_PENDING_IMPLEMENTATION`。既有 binding persistence/resolver runtime 保留为实现基础；resolver admission 与固定 SYSTEM provisioning 按本节变更，以移除不可部署的递归首凭据路径。

- `MachineWorkloadBinding` 是 Identity-owned identity fact。一个 binding 以稳定 opaque reference 关联一个 Machine Principal、一个精确 workload SPIFFE ID、active/disabled lifecycle 与单调 binding version；它不保存 leaf certificate、Auth credential、Permission Code 或 grant。一个 SPIFFE workload 可以承载多个受控 machine binding，但一次 Auth exchange 的 typed selector 必须引用唯一一个 binding，且该 binding 只能解析到唯一一个 principal；任何歧义均拒绝。
- Identity 在既有 `IdentityQueryService` surface 提供 Auth-only `ResolveMachinePrincipalForAuth`。它与 `ResolveIntegrationMachineForAuth` 是两个目的明确的 resolver：前者只服务第一方 MACHINE root execution，后者继续只服务 external API-key exchange，不修改、不泛化，也不作为 fallback。
- Auth 只提交 typed selector 的 Machine Principal reference、binding reference/exact version 与原始 exchange 当前 `VerifiedWorkloadIdentity.spiffeId`；不提交 raw source credential、leaf certificate、Permission grant 或 caller-computed tenant。Identity 要求 principal 与 binding 均 active、binding 唯一指向该 principal、SPIFFE ID 与 version 精确匹配，并返回 principal id（供 Auth 作为 `sub`）、`principal_type=MACHINE`、type、scope、tenant、适用 org reference、principal lifecycle version、binding reference/version 与 safe decision reference。
- `TENANT` principal 必须返回同一 tenant 的有效引用；`SYSTEM` principal 的 tenant 必须为空。org 只作为适用时的受控引用返回，Identity 不取得 tenant/org tree 或 lifecycle 真相所有权。缺失、inactive、wrong type/scope、tenant/org mismatch、binding mismatch/stale 或 dependency unavailable 均 fail closed。
- HUMAN OBO 不修改本 owner fact：MES、WMS、Procurement 与 SRM 的 `SYSTEM` Machine Principal 仍 tenantless，Identity 不把 HUMAN subject 的 tenant 写入 Machine Principal、`MachineWorkloadBinding` 或 resolver response。同步 OBO 的 actor 由 Auth 通过 deployment-owned immutable SPIFFE/self-audience policy 取得 exact principal id、binding stable ref 与 binding version，再用本 resolver 校验 active owner facts；allowed response 必须回显相同 principal/binding/version/SPIFFE、`scope=SYSTEM` 且 tenant 为空。Identity 不接收 subject bearer、target audience、caller actor input，不签发 Token，也不拥有 Auth registry 或 Permission decision。
- 该 resolver 是 Identity 唯一 exact pre-context identity method：只接受准确 `auth-service` workload 的 verified mTLS identity 并拒绝任何 Authorization metadata；不要求 Identity-audience ExecutionToken 或 Permission Code。该 method policy 不得扩散到其他 Identity RPC、caller、service-name header、network placement 或 wildcard。
- Identity 不校验 leaf thumbprint；Auth 先从原始 exchange transport 取得 current SPIFFE/leaf facts，再消费本 resolver 的 stable principal/SPIFFE/binding owner decision 并最终绑定 leaf。任一 mismatch 都不得进入 Permission lookup 或 signing。

精确管理、wire 与 persistence 冻结为：

- `IdentityManagementService` 新增 `EnrollMachineWorkloadBinding` 与 `DisableMachineWorkloadBinding`，只接受正常 mTLS + target-audience ExecutionToken 保护的 HUMAN 或受控 SYSTEM MACHINE 管理调用，并要求 BUSINESS Code `identity.machine.workload_binding.manage`。
- Enroll 只接受 principal id、exact SPIFFE ID 与 idempotency key；Disable 只接受 binding id、expected exact version 与 allowlisted reason。tenant/org/operator 必须来自 trusted context 和 principal owner fact，不从 body 建立 authority。
- 第一阶段 internal resolver 只允许 `INTERNAL_SERVICE` 与 `AUTOMATION_BOT`；`EXTERNAL_INTEGRATION` 继续只走 external API-key resolver，`AI_AGENT` runtime 继续 deferred。
- Identity 持久化 `MachineWorkloadBinding` UUID、local `ServiceAccount` FK、exact SPIFFE ID、`ACTIVE | DISABLED` state、monotonic version、created/disabled operator/time/reason 与 local audit references。对 `ServiceAccount` 使用 `ON DELETE RESTRICT`；不建立跨 Auth/tenant/org database FK。
- 同一 `(Machine Principal, SPIFFE ID)` 同时最多一个 active binding；同一 SPIFFE ID 可承载多个经管理者显式登记的不同 principal binding。Disable 是终态；恢复时创建新 binding，不复活历史。
- enroll/disable state 与 Identity-local `AuditEvent` 在同一 database transaction 中持久化；resolver allowed/denied decision 在响应前记录 safe principal/binding/version/SPIFFE correlation，不记录 source bearer 或 leaf material。

固定 SYSTEM / `INTERNAL_SERVICE` 的初始 principal/binding 由 Identity-owned deployment provisioner 在相关 workload readiness 前按版本化 inventory 幂等建立和核对。inventory 只声明 immutable entry key、display name、固定 type/scope 与 exact SPIFFE；Identity-local provisioning receipt 以 unique entry key/digest 绑定 principal、binding、deployment revision 与 audit reference。成功输出非秘密 principal/binding/version selector。相同 manifest 重跑是 no-op；owner truth mismatch、duplicate/missing entry 或 audit failure 阻止 readiness。provisioner 不创建 TENANT / `AUTOMATION_BOT`，后者继续使用正常 management flow。

`ResolveMachinePrincipalForAuth` 的精确 request/response field number、management message、safe reason 与 database constraint 以 [machine-principal-resolution.md](../../contracts/identity-service/machine-principal-resolution.md) 为准。

黑盒语义以 [machine-principal-resolution.md](../../contracts/identity-service/machine-principal-resolution.md) 为准。

当前注意事项：

- 现有 machine auth contract 中由 Identity 执行 `AuthenticateApiKey` 的部分是 legacy 兼容形态，目标状态由 [ADR 0015](../../adr/0015-workload-identity-and-execution-token.md) 与 Auth [execution-token.md](../../contracts/auth-service/execution-token.md) 取代。
- `APIKey` 是 credential，不是主体。
- API Key credential、认证、轮换与撤销归 `auth-service`；Identity 只保存 Auth credential 所引用的 machine principal identity，不保存 secret 或 hash。
- 内部 MACHINE root 不再有独立 Auth source credential；Identity 保存 selector 所引用的 Machine Principal 与 `MachineWorkloadBinding`，不保存 bearer、verifier 或证书 thumbprint。
- `permission-service` 通过通用 `PrincipalRoleBinding` 与 policy 管理机器授权；机器不伪装为 `UserAccount`。
- 平台 Robot template 不是 machine principal；租户启用 template 时创建独立 TENANT principal。外部 Integration 同样固定为 tenant-owned principal；Marketplace、共享第三方 App principal 与跨 tenant installation model 已取消，不在 Identity 预留对应对象。

## 10. Self-service And Admin-management Boundary

`identity-service` 的接口层必须显式区分 self-service 与 admin-management。

Self-service 默认语义：

- 当前用户修改自己的低风险基础资料。
- 当前用户完成自己的联系绑定后触发必要的身份侧同步。
- target 必须由当前 session / operator context 推导，不接受前端任意指定他人 target。
- 不默认要求管理员资料修改权限码，但仍必须满足安全策略、白名单动作与审计要求。

Admin-management 默认语义：

- 管理员查看或治理目标账号、目标用户、工作联系方式资产或机器主体。
- 必须经过 `RBAC + scope / resource` 授权判定，并记录审计。

历史混合接口只作为迁移债，不得继续扩展；剩余迁移由 [backlog](../../plans/backlog.md) 的单一 closure item 跟踪，而不是在各服务中分别维护孤立清单。

## 11. External Interfaces

典型上游入口：

- `auth-service`
- `api-gateway` / BFF
- `hr-service`
- `permission-service`
  - 提供账号管理、contact asset 管理、machine principal 管理与 employee binding 管理接口的权限判定；permission 侧核心对象与 owner 边界以 [permission-service.md](./permission-service.md) 为准。
- 业务服务

典型契约位置：

- [identity-service/query.md](../../contracts/identity-service/query.md)
- [identity-service/management.md](../../contracts/identity-service/management.md)
- [identity-service/machine-auth.md](../../contracts/identity-service/machine-auth.md)
- [identity-service/employee-binding.md](../../contracts/identity-service/employee-binding.md)

Contract 文档只描述黑盒调用语义、字段、错误与当前接口形状；不得重新定义本文中的服务 owner、核心对象或长期边界。

## 12. Upstream Dependencies

- `party-service`
  - 提供当前租户内 `TenantParty` 主体事实。
  - 承接租户内真实姓名、法定名称、多语言名称与主体识别等现实世界主体语义。
- `tenant-org-service`
  - 提供 tenant lifecycle、tenant 摘要、org tree 与 org reference validation。
  - 为 TENANT scope account / machine principal 提供 tenant 引用校验依据。
- `hr-service`
  - 提供 `Employee / Employment` 真相。
  - 在 onboarding 或人员治理中发起或消费 `UserAccount <-> Employee` binding。
- `permission-service`
  - 为 identity 管理接口、账号目录、机器主体管理等受保护能力提供授权判定。
- `auth-service`
  - 消费 identity account facts 建立认证续流、account selection 与 session context。
  - 消费 Machine Principal facts，验证 API Key owner 与 lifecycle，并拥有认证凭据、API Key、login method、session、STS、token 与认证域审计。

## 13. Downstream / Published Facts

- user 技术身份摘要。
- account context 列表。
- `UserAccount.tenantPartyId` 租户主体关联摘要。
- account existence / ownership / enabled state。
- account scope / tenant reference。
- account display summary。
- contact asset summary。
- machine principal summary。
- `UserAccount <-> Employee` binding summary。

## 14. Non-goals

- 不拥有 session、refresh token、认证 challenge、password、OTP、MFA 或 login method 真相。
- 不拥有 API Key credential、STS、ExecutionToken 或 delegation credential 真相。
- 不定义权限、角色、policy、scope 或 terminal access 策略模型。
- 不拥有 tenant / org tree / org lifecycle / org hierarchy。
- 不拥有 `Employee / Employment -> OrgUnit` 的正式归属真相。
- 不承载业务域客户、供应商、员工等最终业务角色语义。
- 不提供真实姓名模糊搜索；如后续需要按姓名发现自然人，应先设计 `party-service` 协同能力。
- 不通过 service-local docs、feature packet 或 contract 文档长期承载第二份 identity-service 服务设计。

## 15. Current Stage And Cleanup Rules

当前 `identity-service` 处于唯一真相元整理与历史文档收敛阶段：

- 本文承接长期服务设计真相。
- `docs/contracts/identity-service/**` 继续作为黑盒 contract 真相，但不得重新定义服务职责。
- `docs/architecture/collaborations/**` 继续作为跨服务协同蓝图，但不得重新定义 `identity-service` owner 语义。
- 服务内旧 design、task、history、overview、roadmap 只作为本次提炼来源与历史记录，不再作为稳定设计入口。
- 服务内旧 docs 在提炼完成后应删除；服务根目录可保留一个极短 README 指向本文与 contract 入口。
- self-service / admin-management 拆分的剩余工作由 [backlog](../../plans/backlog.md) 的单一 closure item 跟踪。

## 16. Trusted gRPC 45-RPC contract（FROZEN）

Identity audience 固定为 `urn:oes:service:identity-service`。本组由 2026-07-27 baseline 的 41 RPC、三个 Auth-only 登录 INTERNAL resolver 与一个 Public Entry-only public-card INTERNAL resolver 构成 45 RPC；`ResolveIntegrationMachineForAuth`, `EnrollMachineWorkloadBinding`, `DisableMachineWorkloadBinding` 保持各自现有 contract 且不计入 45。`ResolveMachinePrincipalForAuth` 仍不计入 45，其 admission 按 direct MACHINE root contract 为 exact Auth mTLS/no-Authorization pre-context policy。

| 类别 | RPC（数量） | execution / terminal | Code 与 caller rule |
| --- | --- | --- | --- |
| `SELF_SERVICE` | `UpdateOwnAccountProfile`, `UpdateOwnUserBasicInfo`（2） | `HUMAN`, `WEB`, exact `sub/account_id` self binding | `identity.account.self.update_profile`; Gateway only |
| `FOUNDATION_EXTERNAL_CREDENTIAL` | `AuthenticateApiKey`（1） | existing exact Auth/Gateway external-credential admission; no HUMAN/MACHINE ET fabrication | preserve integrated contract; external API-key expansion remains deferred |
| `INTERNAL` | `ListAuthLoginAccountCandidates`, `ResolveAuthLoginAccount`, `ResolveAuthEmployeeLoginAccount`, `ResolvePublicBusinessCardIdentity`（4） | exact Auth or Public Entry `SYSTEM MACHINE` selected per method; target audience and current leaf `cnf`; no HUMAN role inheritance | Auth methods use `identity.internal.auth_login_account.resolve`; Public Entry method uses `identity.internal.public_business_card_identity.resolve`; exact registered workload only |
| `BUSINESS` | `GetAccountById`, `GetEmployeeBindingByAccountId`, `ResolveEmployeeLoginAccount`, `ListAuditEvents`, `GetApiKeyById`, `GetServiceAccountById`, `ListApiKeysByServiceAccountId`, `ListServiceAccounts`, `ResolveContactActionTargets`, `ListAccountContactAssets`, `ListAccountWorkEmailAssets`, `ListAccountWorkPhoneAssets`, `ListAccounts`, `GetUserById`, `GetUserByEmail`, `GetUserByPhone`, `GetAccountsByUserId`, `CountTenantAccounts`（18） | direct `HUMAN`, `HUMAN_OBO`, or only another statically named reference `SYSTEM MACHINE` where separately frozen; `WEB` for HUMAN | existing exact read/list/self Codes; direct Gateway plus Permission, HR and Collaboration allowlists from the frozen manifest; Public Entry public-card reads use only its INTERNAL resolver; no wildcard workload and no pre-HUMAN Auth login use |
| `BUSINESS` | `RotateApiKey`, `CreateApiKey`, `CreateServiceAccount`, `CreateUserAccount`, `GetAccountDeletionImpact`, `DeleteAccount`, `RevokeApiKey`, `SetServiceAccountEnabled`, `UpdateAccountProfile`, `UpdateUserBasicInfo`, `AssignAccountWorkEmailAsset`, `AssignAccountWorkPhoneAsset`, `RevokeAccountWorkEmailAsset`, `RevokeAccountWorkPhoneAsset`, `SetAccountWorkEmailAssetStatus`, `SetAccountWorkPhoneAssetStatus`, `SetAccountPrimaryWorkEmailAsset`, `SetAccountPrimaryWorkPhoneAsset`, `BindAccountToEmployee`, `UnbindAccountFromEmployee`（20） | direct `HUMAN` or exact HR/TenantOrg `HUMAN_OBO`, `WEB` | exact existing `identity.account.*`, `identity.contact.*`, `identity.machine.*` Code selected per method; no Code inference from request |

Exact Code mapping for the 45 methods is:

| Code | RPCs |
| --- | --- |
| `identity.internal.auth_login_account.resolve` | `ListAuthLoginAccountCandidates`, `ResolveAuthLoginAccount`, `ResolveAuthEmployeeLoginAccount` |
| `identity.internal.public_business_card_identity.resolve` | `ResolvePublicBusinessCardIdentity` |
| `identity.account.self.update_profile` | `UpdateOwnAccountProfile`, `UpdateOwnUserBasicInfo` |
| `identity.account.list` | `GetAccountById`, `GetEmployeeBindingByAccountId`, `ResolveEmployeeLoginAccount`, `ListAuditEvents`, `ListAccounts`, `GetUserById`, `GetUserByEmail`, `GetUserByPhone`, `GetAccountsByUserId`, `CountTenantAccounts` |
| `identity.account.self.read` | `ListAccountContactAssets`, `ListAccountWorkEmailAssets`, `ListAccountWorkPhoneAssets`, `ResolveContactActionTargets` |
| `identity.machine.service_account.create` | `GetServiceAccountById`, `ListServiceAccounts`, `CreateServiceAccount` |
| `identity.machine.service_account.update_status` | `SetServiceAccountEnabled` |
| `identity.machine.api_key.create` | `GetApiKeyById`, `ListApiKeysByServiceAccountId`, `CreateApiKey` |
| `identity.machine.api_key.rotate` | `RotateApiKey` |
| `identity.machine.api_key.revoke` | `RevokeApiKey` |
| `identity.account.create` | `CreateUserAccount` |
| `identity.account.delete` | `GetAccountDeletionImpact`, `DeleteAccount` |
| `identity.account.profile.update` | `UpdateAccountProfile`, `UpdateUserBasicInfo`, `BindAccountToEmployee`, `UnbindAccountFromEmployee` |
| `identity.contact.asset.assign` | `AssignAccountWorkEmailAsset`, `AssignAccountWorkPhoneAsset` |
| `identity.contact.asset.release` | `RevokeAccountWorkEmailAsset`, `RevokeAccountWorkPhoneAsset` |
| `identity.contact.asset.set_status` | `SetAccountWorkEmailAssetStatus`, `SetAccountWorkPhoneAssetStatus` |
| `identity.contact.asset.set_primary` | `SetAccountPrimaryWorkEmailAsset`, `SetAccountPrimaryWorkPhoneAsset` |
| preserved external credential admission | `AuthenticateApiKey` |

The more specific generated work-email/work-phone Codes remain catalog aliases for future route-level grants; this migration neither deletes them nor invents another business permission. Architecture tests require 45/45 literal coverage and reject any request-selected Code.

The three Auth-only resolvers return only login/session-safety projections. `ListAuthLoginAccountCandidates` accepts an Auth-verified `user_id` and returns structurally valid available account candidates. `ResolveAuthLoginAccount` accepts `user_id + account_id`, requires Identity to verify the owner pair, and returns the minimal account identity, scope, tenant, display name and enabled state. `ResolveAuthEmployeeLoginAccount` accepts `tenant_id + employee_id`, verifies the active binding/account tenant relationship and returns the same minimal account projection. Empty, mismatched, disabled or malformed owner facts never become authority; Auth applies its existing stable login error and anti-enumeration semantics.

`ResolvePublicBusinessCardIdentity(tenant_id, employee_id, target_refs[])` is exact Public Entry-only. Identity resolves and verifies the active same-tenant EmployeeBinding and enabled account, returns the minimum public display label plus stable account reference, and resolves only the supplied BusinessCard Contact Action refs into existing public-safe target projections. The selector and refs are lookup inputs, not tenant/account authority. Target-level missing/inactive/type mismatch returns non-renderable without value; owner/binding/account/trust failure returns a safe unavailable decision. Public Entry receives no `identity.account.list` or `identity.account.self.read` BUSINESS grant or fallback. The cross-service flow is frozen in [Public Business Card owner-fact resolution](../collaborations/public-business-card-owner-facts.md).

`ResolvePublicBusinessCardIdentity` implementation status is `DESIGN_FROZEN_PENDING_IMPLEMENTATION`.

Four request authority tombstones are frozen: `ListAuditEvents.operator_id=5/tenant_id=6/org_id=7` and `BindAccountToEmployee.tenant_id=1`. The baseline request `tenant_id` fields plus Auth/Public Entry resolver selectors are owner resource selectors for account/service-account/contact/login/public-card lookup; they cannot establish execution tenant. A TENANT HUMAN/HUMAN_OBO selector must equal signed tenant; an exact allowlisted SYSTEM reference call or dedicated INTERNAL resolver is evaluated as a target lookup under its literal method Code and cannot obtain cross-tenant authority from the body. Response tenant/org projections remain owner data.
