# Warehouse, Site, Work Context, and Permission Isolation Design

## 0. 文档控制

```text
designKey: warehouse-site-work-context-permission
designStatus: ACTIVE_DESIGN_WORKSPACE
implementationStatus: DEFERRED
lastUpdatedAt: 2026-06-18 15:04:19 CST
lastUpdatedBy: Codex warehouse/site work-context thread
supersedes: 本线程中关于 OES 仓库、车间、工厂、作业上下文与权限隔离管理的讨论记录
truthSource: 等待 permission policy / resource authorization 专题线程冻结后回写
doNotUseAsStableSource: false
conflictResolution: 本文只记录讨论态进度与恢复入口；若稳定 architecture / ADR / contracts 或 policy 专题线程冻结结论覆盖本文，以稳定真相源为准。
```

## 1. 目标

本 workspace 用于记录 OES 中“仓库、车间、工厂、作业上下文与权限隔离管理”的当前讨论进度，作为后续恢复入口。

当前线程已暂停深入设计，原因是多仓库、多工厂、多车间与 WorkCenter 权限隔离依赖 `permission-service` 的 policy / resource authorization 最终设计。该底座已交由独立 policy 专题线程继续整理、冻结与迁移清理。

## 2. 当前范围

本 workspace 负责：

- 记录本线程已经形成的资源 owner 边界判断。
- 记录本线程对 PDA / Web / BFF 作业上下文的初步方向。
- 记录当前被 policy 专题线程阻塞的授权模型问题。
- 为后续继续讨论 WMS / MES 多资源权限隔离提供恢复入口。

本 workspace 不负责：

- 冻结 `permission-service` policy / `PolicyInstance` 的最终设计。
- 替代 `docs/architecture/services/*.md` 服务职责真相。
- 替代 `docs/architecture/collaborations/*.md` 跨服务协同真相。
- 替代 `docs/contracts/**` 契约正文。
- 直接进入 WMS / MES / PDA 实现。

## 3. 涉及对象

- services:
  - `permission-service`
  - `tenant-org-service`
  - `hr-service`
  - `identity-service`
  - `wms-service`
  - `mes-service`
  - `api-gateway`
- resources:
  - WMS: `Warehouse / Location`
  - MES: `Site / Area / WorkCenter / WorkUnit`
  - TenantOrg: `OrgUnit`
  - HR: `Employee / Employment`
  - Identity: `User / UserAccount / UserAccount <-> Employee binding`
- features / topics:
  - 多仓库权限隔离
  - 多工厂 / 多车间 / WorkCenter 权限隔离
  - PDA 作业上下文
  - 主管、质检、巡检、跨仓库 / 跨车间角色
  - policy / resource authorization 底座升级

## 4. 已确认判断

| 日期 | 判断 | 影响范围 | 回写目标 |
| --- | --- | --- | --- |
| 2026-06-18 | `Warehouse / Location` 由 `wms-service` 拥有。 | WMS 资源边界 | `docs/architecture/services/wms-service.md` 或 WMS collaboration |
| 2026-06-18 | `Site / Area / WorkCenter / WorkUnit` 由 `mes-service` 拥有。 | MES 资源边界 | `docs/architecture/services/mes-service.md` 或 MES collaboration |
| 2026-06-18 | `tenant-org-service.OrgUnit` 表达组织结构与管理责任，不拥有仓库、工厂、车间、产线或工位本体。 | TenantOrg / WMS / MES 边界 | collaboration 文档 |
| 2026-06-18 | `hr-service.Employee / Employment` 表达员工与任职归属真相，不应成为仓库 / 车间权限表。 | HR / Permission 边界 | collaboration 文档 |
| 2026-06-18 | `identity-service.UserAccount` 不应用于表达同一 tenant 下仓库或车间切换；同租户多仓 / 多车间权限不应建成多个 account。 | Identity / PDA 登录上下文 | account context / work context collaboration |
| 2026-06-18 | `Warehouse` 与 `MES Site` 可以关联 `ownerOrgId / responsibleOrgId / operatingOrgId` 等组织引用，但这些引用只表达管理归属或责任归属，不等同最终授权。 | Org / resource relation | service truth + collaboration |
| 2026-06-18 | 多仓库、多工厂、多 WorkCenter 权限最终依赖 `permission-service` 的 policy / resource authorization 模型。 | Permission 底座 | policy 专题线程 |
| 2026-06-18 | PDA 的仓库 / 车间 / 产线选择不应成为 identity account context；更适合作为作业上下文或任务过滤。 | PDA / BFF | PDA work-context contract |

## 5. 当前 policy 线程输入

本线程已将以下需求交给独立 policy 专题线程：

- 分析当前 `Policy + conditionAstJson` 的长期定位。
- 分析当前 `Policy Template / Policy Instance` 与 `ResourceAuthorizationService` 的实现进度。
- 冻结旧 `CheckPermissionWithContext` 是否仅作为历史兼容保留。
- 冻结 `PolicyInstance` 是否作为资源授权主线，是否还需要独立 `ResourceGrant / ResourceScope`。
- 明确如何同时支持 `checkResource` 与 `buildQueryScope`。
- 明确如何支持 `warehouseId / siteId / areaId / workCenterId / includeDescendants`。
- 明确 org / employment 在授权中的角色：直接 scope、默认派生来源，还是 resource facts。
- 输出迁移与历史遗留清理方案。

本线程在 policy 专题线程冻结前不继续推进 WMS / MES / PDA 权限细节。

## 6. 开放问题

| 日期 | 问题 | 为什么未冻结 | 下一步 |
| --- | --- | --- | --- |
| 2026-06-18 | WMS 多仓库权限是否统一通过 `PolicyInstance` 的 `resource-field-in-set` 表达，还是需要仓储专用 scope adapter？ | 等待 policy 最终设计与 contract。 | 读取 policy 专题线程输出。 |
| 2026-06-18 | MES `Site / Area / WorkCenter / WorkUnit` 层级授权是否需要 `includeDescendants` 模板或由 MES 自行展开 scope？ | 当前 `PolicyInstance` 第一阶段只支持字段集合，层级语义尚未冻结。 | policy 线程冻结后，再在 MES/WMS 协同中细化。 |
| 2026-06-18 | org-based default scope 是否进入第一阶段？ | `org-scope` 当前仍带 experimental 色彩，HR/Org 派生范围需要独立设计。 | 等待 policy 与 HR/Org 协同结论。 |
| 2026-06-18 | PDA 登录后是否默认进入“我的任务”，还是先选择仓库 / 工厂 / WorkCenter？ | 取决于资源授权模型与任务模型。 | 等 policy 底座与任务模型明确后继续。 |
| 2026-06-18 | 主管、质检、巡检、跨仓 / 跨车间角色如何避免污染普通工人体验？ | 需要 `PolicyInstance`、任务派工、作业上下文共同设计。 | 后续 PDA work-context design。 |

## 7. 真相源回写计划

- 服务职责：
  - 如需补充组织引用语义，回写 `docs/architecture/services/wms-service.md` 与 `docs/architecture/services/mes-service.md`。
  - 如需补充授权 owner 边界，回写 `docs/architecture/services/permission-service.md`。
- 协同蓝图：
  - 建议后续新增或更新 WMS/MES/HR/TenantOrg/Permission 的 resource authorization collaboration。
  - 若 PDA 作业上下文进入设计，建议新增 PDA work-context collaboration 或 API Gateway/BFF contract。
- contracts：
  - WMS/MES 资源查询与作业接口需要在 resource facts / query scope 明确后再冻结。
  - `permission-service` 是否开放 resource authorization gRPC / HTTP，等待 policy 专题线程。
- feature packet：
  - policy 专题线程应先收口 policy template instance / resource authorization 迁移清理。
  - 本线程后续可拆出 `mes-wms-site-scope-rollout` 或 PDA work-context feature packet。
- architecture / ADR：
  - 如果改变旧 `Policy` 或 `CheckPermissionWithContext` 的长期定位，需由 policy 专题线程判断是否新增 ADR。

## 8. 恢复入口

下次继续前先读：

- `docs/architecture/services/permission-service.md`
- `docs/architecture/platforms/authorization-layering-and-resource-policy.md`
- `docs/architecture/services/permission-service.md`
- `docs/contracts/permission-service/policy-instance-management.md`
- `docs/contracts/permission-service/resource-authorization.md`
- `docs/architecture/platforms/authorization-layering-and-resource-policy.md`
- `docs/architecture/services/wms-service.md`
- `docs/architecture/services/mes-service.md`
- `docs/architecture/services/tenant-org-service.md`
- `docs/architecture/services/hr-service.md`
- policy 专题线程最终输出的 architecture / ADR / contracts

当前推荐下一步：

1. 等 policy 专题线程冻结最终 policy / resource authorization 设计与迁移方案。
2. 基于冻结结果，回到本 workspace 继续讨论：
   - WMS 多仓库 / Location 权限范围。
   - MES Site / Area / WorkCenter / WorkUnit 权限范围。
   - PDA / Web / BFF 作业上下文消费方式。
   - 普通工人、主管、质检、巡检、跨仓跨车间角色差异。
3. 决定是否进入稳定 collaboration 文档或 feature packet。
