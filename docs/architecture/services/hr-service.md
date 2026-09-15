# hr-service 职责卡

## 1. Purpose

`hr-service` 是 OES 的员工与任职关系真相服务，负责回答“这个自然人在当前租户内是否构成员工或工作人员、处于什么任职状态、被分配到哪些岗位或组织”。

本文是 `hr-service` 的唯一稳定设计真相源。其他 architecture、collaboration、contract、active design、Delivery artifact 或实现计划只能引用本文，不得重新定义 `Employee`、`Employment`、员工生命周期、正式 `人 -> org` 归属或 HR onboarding owner 边界。

## 2. Owns

- 员工 / 工作人员主档真相，使用独立 `employeeId`
- 任职关系、雇佣状态与生命周期真相
- 员工编号、入转调离等人力状态语义
- 员工公开展示头像引用与展示 URL，用于员工数字名片和公开展示页面
- 岗位分配、汇报关系与主要任职记录
- 与组织挂靠相关的正式人力任职事实；正式 `人 -> org` 真相是 `Employment -> OrgUnit`
- minimum 第一阶段的员工 onboarding 业务结果与可重试接入补偿状态

## 3. Does Not Own

- 自然人主体主数据真相；这些以 [party-service.md](./party-service.md) 为准
- 账号、认证、会话、登录链路、`UserAccount <-> Employee` 绑定结果真相；这些以 [identity-service.md](./identity-service.md) 为准
- 账号头像、个人中心头像或用户自维护个人资料头像；这些不等同员工公开展示头像
- 头像文件二进制、对象存储生命周期、文件扫描与资产元数据；这些以 Asset 服务边界为准
- 租户内部组织树真相；`Tenant / OrgUnit / org tree` 边界以 [tenant-org-service.md](./tenant-org-service.md) 为准
- `account -> org` 或 account-org membership 的正式归属真相
- 角色、权限、policy、account-role grant 与授权判定真相；这些以 [permission-service.md](./permission-service.md) 为准
- 客户、供应商等外部联系人语义
- 薪酬、考勤、绩效、招聘、复杂岗位体系、完整汇报线治理等更重 HR 子域的完整实现范围

## 4. Core Responsibilities

- 把现实世界的自然人主体受控映射为租户内的人力主体，以上游 `tenantPartyId` 作为正式主引用
- 维护员工 / 工作人员的任职状态、任职区间与雇佣关系
- 提供岗位、主要任职与汇报线等人力基础能力
- 为 `tenant-org-service`、`identity-service` 与业务服务提供正式员工事实，而不是让这些服务长期各自维护员工语义
- 区分“组织成员”与“员工”：并非所有组织成员都属于员工，但员工任职应能被正式表达
- 在第一阶段 minimum 范围内，优先冻结 `Employee + 当前唯一 active Employment`，而不是把兼任、借调、复杂任职区间一次性做重

## 5. Core Objects

### 5.1 Employee

`Employee` 表达某个自然人在某个 tenant 内是否构成员工 / 工作人员。

稳定规则：

- `Employee` 使用独立 `employeeId`，不得复用 `tenantPartyId`、`accountId` 或 `userId` 作为主键。
- `tenantPartyId` 是 HR 上游主引用，用于连接 party-service 的租户主体引用。
- `Employee` 不保留 `partyId` 影子字段。
- 同一 `tenantId + tenantPartyId` 在 minimum 第一阶段只能对应一个正式 `Employee` 聚合。
- `employeeCode` 是租户内员工编号语义，不替代自然人姓名或 party 主体标识。
- `officialPhotoAssetId` 是员工公开展示头像的资产引用；HR 不保存文件二进制。
- `officialPhotoUrl` 是供内部消费方与公开展示组装使用的当前头像展示 URL；为空时消费方必须渲染正式占位，不得回退到账号头像。
- 员工公开展示头像由 HR / 租户管理员维护，用于员工数字名片、公开资料页等正式员工身份展示场景。
- 员工公开展示头像不等同账号头像，也不得从 `identity-service` 的 account avatar 派生为 fallback。

minimum 第一阶段生命周期：

- `PREBOARDING`
  - `CreateEmployee` 成功后的初始状态。
  - 表示员工主档已成立，但尚未形成 active employment。
- `ACTIVE`
  - 第一条 active employment 成功创建后进入。
  - 调岗通过 `ChangePrimaryEmployment` 成功完成时，Employee 保持 `ACTIVE`。
- `OFFBOARDED`
  - active employment 被结束且没有继任 active employment 时进入。

第一阶段不引入 suspended、leave、probation 等更细状态；如需扩展，必须先更新本文。

### 5.2 Employment

`Employment` 表达员工在组织中的正式任职事实。

稳定规则：

- `Employment` 必须属于一个 `Employee`。
- `Employment` 引用 `tenantId / orgUnitId`，但不拥有 `OrgUnit` 或组织树。
- `Employment -> OrgUnit` 是正式 `人 -> org` 真相。
- 第一阶段同一员工最多只有一条当前 `ACTIVE` employment。
- `primary employment org` 只来自当前 active employment 的 `orgUnitId`。
- 读取 account 视角 org 数据时，调用方应优先消费 HR 摘要或其派生投影，而不是 legacy account-org membership owner。

minimum 第一阶段状态：

- `ACTIVE`
  - `CreateEmployment` 成功后的初始状态。
  - 第一阶段仅允许立即生效任职；`effectiveFrom` 不得晚于命令 accepted time。
- `ENDED`
  - `EndEmployment` 或 `ChangePrimaryEmployment` 结束旧任职后进入。
  - `effectiveTo` 必须存在且不得早于 `effectiveFrom`。

第一阶段不实现 `PENDING_EFFECTIVE`。若后续需要 future-dated employment，应另行冻结调度与生效规则。

### 5.3 Onboarding Access Compensation

HR minimum 第一阶段允许在员工 onboarding 中可选触发账号接入与初始授权。

稳定规则：

- `hr-service` 是 employee onboarding 的业务 owner，minimum 第一阶段由 HR application orchestration 串联跨服务步骤。
- `Party / Employee / Employment` 成立后，不得因后续账号绑定或权限 grant 失败而回滚。
- account 创建、account binding 或 permission grant 失败时，HR 可持有可重试的 onboarding access compensation 状态。
- 该补偿状态只表示 HR onboarding 接入段待继续，不得成为 `UserAccount <-> Employee` binding 真相或 account-role grant 真相。
- account binding 真相以 [identity-service.md](./identity-service.md) 为准。
- role / grant 真相以 [permission-service.md](./permission-service.md) 为准。

## 6. Commands And Queries

当前 minimum 第一阶段稳定能力：

- `CreateEmployeeOnboarding`
  - 通过 HR-owned orchestration 建立或复用员工相关主体、员工主档、首条任职，并在需要时完成账号绑定与默认访问接入。
- `CreateEmployee`
  - 基于已存在的 `tenantPartyId` 建立员工主档。
- `CreateEmployment`
  - 为员工建立立即生效的 active employment。
- `EndEmployment`
  - 结束一条 active employment，并在无继任 active employment 时让 Employee 进入 `OFFBOARDED`。
- `ChangePrimaryEmployment`
  - 通过“结束旧 employment + 建立新 employment”的本地事务完成调岗，不允许原地篡改既有 employment 的正式 `orgUnitId`。
- `UpdateEmployeeOfficialPhoto`
  - 为员工设置或替换公开展示头像资产引用，并刷新可供查询摘要消费的展示 URL。
- `RemoveEmployeeOfficialPhoto`
  - 移除员工公开展示头像引用；后续名片与公开页只能显示正式占位。
- `ListEmployees`
  - 查询租户员工目录。
- `ResolveActiveEmployeeByCode`
  - 按 `tenantId + employeeCode` 精确解析当前可工作的员工事实，返回 `Employee` 摘要与当前唯一 active employment。
  - 该查询只表达 HR 真相：员工编号、员工 active lifecycle 与 active employment；不返回账号绑定、权限或认证凭据事实。
- `GetEmployeeById`
  - 按 `employeeId` 查询员工摘要。
- `GetEmployeeByTenantPartyId`
  - 按 `tenantId + tenantPartyId` 查询员工摘要。
- `GetActiveEmployment`
  - 查询某员工当前唯一 active employment。
- `ListEmployments`
  - 查询某员工任职历史摘要。

## 7. Collaboration Boundaries

### 7.1 Party

- `party-service` 提供自然人主体与租户主体引用事实。
- HR 只引用 `tenantPartyId`，不复制自然人姓名、法定姓名、证照或主体主档 truth。
- party merge、tenant party deactivate 后对 Employee 的修复链尚未冻结，未来必须通过独立协同设计处理。

### 7.2 Tenant-Org

- `tenant-org-service` 提供 `Tenant / OrgUnit / org tree / org hierarchy / org reference validation`。
- HR 只引用和校验 `OrgUnit`，不拥有组织树。
- 组织树本体变更不等于员工任职自动变更；员工任职变更必须通过 HR command 表达。

### 7.3 Identity

- `identity-service` 拥有 `User / UserAccount / UserAccount <-> Employee` binding 真相。
- HR 可以发起绑定请求或读取绑定结果，但不得持久化账号绑定真相。
- HR 不把 `account -> org` compatibility projection 视为正式员工归属。

### 7.4 Permission

- `permission-service` 拥有 role、permission、policy、account-role grant 与 onboarding grant 真相。
- HR 可以请求 employee onboarding initial grant，但不得直接写 account-role 或 role-permission 绑定。
- access package shape、岗位 / 组织推导角色等高级授权语义尚未冻结，未来必须回到 permission-service 真相源或 ADR。

## 8. External Interfaces

- 典型上游入口：`api-gateway`、`tenant-org-service`、`identity-service`、业务服务
- 典型下游消费方：
  - 需要员工身份或任职状态的业务服务
  - 需要正式任职事实的组织与审批链路
  - 未来更重的人力子域，如薪酬、考勤、绩效等

黑盒契约：

- [hr-service/README.md](../../contracts/hr-service/README.md)
- [hr-service/query.md](../../contracts/hr-service/query.md)
- [hr-service/management.md](../../contracts/hr-service/management.md)

协同蓝图：

- [tenant-org-and-hr.md](../collaborations/tenant-org-and-hr.md)
- [employee-onboarding.md](../collaborations/employee-onboarding.md)

## 9. Published Facts

- 某自然人在某租户内是否构成员工 / 工作人员
- 员工当前任职状态、主岗位、主组织与任职区间
- 员工编号、汇报关系与主要任职摘要
- 面向组织、审批与业务服务可消费的正式人力事实
- 面向员工数字名片与公开资料页可消费的员工公开展示头像 URL；为空表示应使用正式占位
- 面向 `identity-service` 的 `UserAccount <-> Employee` 绑定目标摘要，但不拥有账号真相
- 面向认证编排可消费的 `tenantId + employeeCode -> active employee + active employment` 查询事实；认证结果、PIN 与 session 仍归 `auth-service`

## 10. Non-goals

- 不直接拥有自然人主体主数据
- 不把客户联系人、供应商联系人等外部关系纳入员工真相
- 不替代 `tenant-org-service` 管理组织树本体
- 不替代 `identity-service` 管理账号、认证与 operator context
- 不把账号头像作为员工公开展示头像的 fallback 或同步来源
- 不拥有头像文件存储、图片处理、病毒扫描或 CDN 生命周期
- 不替代 `permission-service` 管理 role、permission、policy 或 account-role grant
- 不让 `account -> org` compatibility 接口回升为正式员工归属真相
- 不让 BFF 持有 employee onboarding 跨服务事务逻辑
- 不在 minimum 第一阶段支持多条当前 active employment、兼任组织、借调、future-dated 自动生效、复杂任职区间治理
- 在当前阶段不默认承接完整 payroll、attendance、performance、recruiting、position management 或 reporting line governance

## 11. Trusted gRPC 17-RPC contract（FROZEN）

The baseline 15 HR RPCs remain `BUSINESS`; additive `ResolveAuthLoginEmployee` and `ResolvePublicBusinessCardEmployee` are the sixteenth and seventeenth `INTERNAL` RPCs. Audience is `urn:oes:service:hr-service`. Direct Gateway calls use `HUMAN / WEB`. Identity/TenantOrg collaboration calls use the verified subject as `HUMAN_OBO`. Auth pre-HUMAN employee lookup uses only its Auth resolver. Anonymous Public Entry reads use only the dedicated public-card resolver. No Cron/worker, generic service-name caller or workload wildcard is admitted.

| Code | RPCs |
| --- | --- |
| `hr.internal.auth_login_employee.resolve` | `ResolveAuthLoginEmployee` |
| `hr.internal.public_business_card_employee.resolve` | `ResolvePublicBusinessCardEmployee` |
| `hr.employee.list` | `ListEmployees` |
| `hr.employee.get_by_id` | `GetEmployeeById`, `GetEmployeeByTenantPartyId`, `ResolveActiveEmployeeByCode`, `GetActiveEmployment`, `ListEmployments`, `GetLatestOnboardingAccess` |
| `hr.employee.create` | `CreateEmployee`, `CreateEmployeeOnboarding`, `UpdateEmployeeOfficialPhoto`, `RemoveEmployeeOfficialPhoto` |
| `hr.employment.create` | `CreateEmployment`, `CompleteEmployeeAccess` |
| `hr.employment.end` | `EndEmployment` |
| `hr.employment.change_primary` | `ChangePrimaryEmployment` |

Ten legacy request `tenant_id=1` fields are removed/reserved: `ChangePrimaryEmployment`, `CompleteEmployeeAccess`, `CreateEmployeeOnboarding`, `CreateEmployee`, `CreateEmployment`, `GetEmployeeByTenantPartyId`, `GetLatestOnboardingAccess`, `ListEmployees`, `RemoveEmployeeOfficialPhoto`, `UpdateEmployeeOfficialPhoto`. `ResolveActiveEmployeeByCode.tenant_id=1` remains a resource selector for its compatible BUSINESS contract. Auth login supplies the verified terminal/device tenant to `ResolveAuthLoginEmployee.tenant_id`; Public Entry supplies its card-owned tenant to `ResolvePublicBusinessCardEmployee.tenant_id`. All are lookup selectors and never admission authority. All existing response projections and HR business identifiers remain unchanged.

`ResolveAuthLoginEmployee(tenant_id, employee_code)` is Auth-only and returns only `employee_id` plus `active_employment_id` when the employee and current employment are active in the selected tenant. The request tenant and employee code are lookup selectors, never execution authority. Missing, inactive, tenant-mismatched or ambiguous facts return the stable unavailable/empty result consumed by Auth; the generic `ResolveActiveEmployeeByCode` BUSINESS method remains compatible for existing non-login consumers.

`ResolvePublicBusinessCardEmployee(tenant_id, employee_id)` is Public Entry-only and returns only the minimal employee/current-employment projection required for public-card readiness and display: employee/lifecycle, active employment, optional position, optional org reference and optional official photo URL. `tenant_id` is an owner lookup selector under the dedicated SYSTEM tenant-target declaration; HR must prove employee and employment belong to that tenant and are active. Missing, inactive, ambiguous or mismatched facts return a safe unavailable decision. Public Entry receives no `hr.employee.get_by_id` BUSINESS grant or fallback. The cross-service flow is frozen in [Public Business Card owner-fact resolution](../collaborations/public-business-card-owner-facts.md).

`ResolvePublicBusinessCardEmployee` implementation status is `DESIGN_FROZEN_PENDING_IMPLEMENTATION`.
