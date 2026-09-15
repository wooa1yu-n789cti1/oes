# party-service Merge API

> Superseded: 本文属于 ADR 0003 的 system-wide Party 模型历史契约，已被 [ADR 0008 Tenant-scoped TenantParty As Primary Party Model](../../adr/0008-tenant-scoped-tenant-party-primary-party-model.md) 替代。当前 `party-service` runtime surface 不提供 `MergeParties`，不得把本文作为当前实现或调用依据。

## 1. 模块职责

`PartyMergeService` 负责主体受控合并接口。

第一阶段适用场景：

- 确认历史上重复创建了多个 canonical `Party`
- 需要把重复主体归并到一个保留主体
- 需要让后续租户绑定和查询都指向同一主体真相

调用约束：

- 接口类型：内部服务接口
- 服务：`PartyMergeService`
- 调用方：内部服务
- 当前 runtime truth：
  - phase-1 runtime 尚未在 `party-service` 内落实 internal-service / authenticated-operator / permission guard enforcement
  - 上游可继续传递 operator / trace metadata，但 merge handler 当前不依赖这些 metadata 才能执行

## 2. 通用上下文要求

当前 merge 请求面中真正落在 proto / runtime 上的是：

- `survivor_party_id`
- `merged_party_ids[]`
- optional `reason`

当前调用链可传但尚未在 `party-service` 内形成 enforcement 的是：

- operator context
- trace context
- 审计元数据

merge 是高风险管理动作；完整审计链路、审批链与治理链当前统一 deferred。

## 3. 合并主体

### `MergeParties`

- 作用：将一个或多个重复主体归并到保留主体
- 请求关键字段：
  - `survivor_party_id`
  - `merged_party_ids[]`
  - optional `reason`
- 关键语义：
  - `survivor_party_id` 是最终保留的 canonical 主体
  - 当前 runtime 只冻结以下校验：
    - `merged_party_ids[]` 不能为空
    - `survivor_party_id` 不能出现在 `merged_party_ids[]` 中
  - 当前 runtime 仅保证“已找到的 merged parties”会被标记为 `MERGED` 并回显到响应中
  - merge 不等于删除；但 redirect、history traceability、downstream repair 当前都未落地
- 响应关键字段：
  - `survivor_party`
  - `merged_parties[]`

## 4. 主要副作用

- 当前 runtime 已兑现的副作用：
  - 已找到的被并入主体状态切换为 `MERGED`
- deferred，不属于当前 runtime 承诺：
  - 主体解析链路重定向到保留主体
  - `TenantParty`、identifier、relationship 或历史引用重写
  - merge record 持久化
  - 显式 audit event 落库

## 5. 主要错误语义

调用方应重点关注这几类失败：

- validation failure
  - `merged_party_ids[]` 为空
  - `survivor_party_id` 出现在 `merged_party_ids[]`

以下语义当前未冻结，不应继续写成已承诺：

- permission denied
- 每个 `merged_party_id` 都必须存在的 not-found 语义
- 类型兼容性、状态兼容性或 merge governance 校验
- conflict / lock / approval workflow

## 6. 第一阶段治理边界

- 第一阶段只冻结 `MergeParties` 的黑盒语义，不冻结完整 merge 审批流或 unmerge 流程。
- 普通业务服务不得把 merge 当作日常写接口调用。
- merge 结果会影响后续主体解析和绑定，但不能替代业务单据自己的历史快照。
- 若未来需要 `UnmergeParties`、merge preview、merge approval 或批量治理，应先进入 active design 并新增 contract，再由独立 Delivery 实现。
- redirect、history traceability、downstream effects 与引用修复链统一 deferred。
- HR minimum 第一阶段不得消费 `party.merged` 或 `tenant_party.deactivated` 事件来修复 `Employee` / binding；HR 对象语义以 [hr-service.md](../../architecture/services/hr-service.md) 为准，相关修复链应在独立 party-HR governance feature 中冻结后再实现。
