# ObjectActivity 与 ObjectTimeline 协同蓝图

## 1. 目标

定义 OES 中平台级 `ObjectActivity / ObjectTimeline` 能力的长期边界、协同形态与 phase 1 接入顺序，确保后续 contract、实现与 UI 线程都在统一前提下推进，而不是把 audit、评论、审批或通知状态混成一个“万能时间线”。

## 2. 能力定位

- `ObjectActivity`
  - 是面向业务协作的可读活动事实。
  - 它回答“围绕某个业务对象，用户或系统刚刚发生了哪一条值得被人读到的活动”。
- `ObjectTimeline`
  - 是围绕某个对象组织展示活动、评论、审批里程碑与关联操作的读模型。
  - 它回答“当我打开这个对象时，协作者应该按时间看到哪些关键事实”。
- phase 1 不等于立刻新建中心 `activity-service`。
- 推荐形态是：
  - 各对象 owner 服务本地生成 `activity fact`
  - 各服务本地维护 `outbox`
  - 未来再按统一投影能力汇总为 `ObjectTimeline`

## 3. 参与方

- 对象 owner 服务
  - `item-master-service`
  - `sales-service`
  - future `mes-service`
  - future `wms-service`
- 平台协作能力
  - future comment capability
  - future workflow / approval capability
  - future attachment capability
  - future notification capability
- 平台基础能力
  - `identity-service`
  - `permission-service`
  - `api-gateway` / BFF
- AI consumer
  - future object summary / reason explanation / progress summary flows

## 4. Owns / Does-Not-Own

### 4.1 ObjectActivity Owns

- 围绕业务对象的“可读活动事实”表达口径。
- 面向 timeline 的最小统一活动模型。
- 活动标题、描述、发生时间、actor snapshot、来源服务与关联对象引用。
- 面向人读的 `changeSet` 摘要，而不是底层逐字段审计流水。
- 统一的降噪规则与 phase 1 activity type taxonomy。

### 4.2 ObjectActivity Does Not Own

- 业务对象主数据真相。
- 业务对象自己的状态机真相。
- 工作流实例、审批实例、通知投递、评论线程、附件元数据或二进制真相。
- 审计合规、追责、不可抵赖真相。
- 前端页面结构、卡片布局、筛选交互或视觉呈现真相。

### 4.3 ObjectTimeline Owns

- 围绕单个对象聚合展示的读模型。
- 不同活动来源在时间线中的排序、分组与读取口径。
- 对活动、评论、审批里程碑、关联操作的统一查询入口。

### 4.4 ObjectTimeline Does Not Own

- 任何源对象的写入真相。
- comment / approval / attachment / notification 的源记录。
- 审批当前状态或业务对象当前状态的最终解释权。

## 5. 与 AuditLog 的边界

- `AuditLog`
  - 面向合规、追责、安全、不可抵赖。
  - 重点回答“谁在什么时候对什么对象做了什么动作，结果如何”。
  - 真相应继续留在各服务受控审计链路与审计存储中。
- `ObjectActivity`
  - 面向业务协作与对象时间线。
  - 重点回答“围绕这个对象，有什么值得协作者看到的业务活动”。
  - 允许对人类可读性、聚合表达与降噪做优化。

明确规则：

- 不能用 audit 表直接充当 timeline。
- 不能把 audit envelope 直接暴露为 `ObjectTimeline` 项。
- 同一业务动作可以同时产生 audit fact 与 activity fact，但两者目的不同、结构不同、保留策略不同。
- 若某动作只满足合规记录价值、不满足协作阅读价值，可以只写 audit、不写 activity。

## 6. 与其他平台能力的关系

### 6.1 Comment / Mention

- comment capability 拥有评论正文、线程结构、编辑 / 删除语义与 mention 解析真相。
- `ObjectActivity` 只记录“发生了评论相关活动”，phase 1 可通过 `COMMENT_ADDED` 表达。
- mention 是否触发提醒、提醒给谁，不归 `ObjectActivity`。

### 6.2 Attachment

- attachment capability 拥有附件元数据、文件存储、版本与权限真相。
- `ObjectActivity` 可记录“对象新增了关键附件”或“某次操作关联了附件”，但不拥有附件本体。

### 6.3 Workflow / Approval

- workflow / approval capability 拥有审批实例、节点流转、待办、签核意见与最终审批状态真相。
- `ObjectActivity` 只镜像关键协作里程碑：
  - `APPROVAL_REQUESTED`
  - `APPROVAL_APPROVED`
  - `APPROVAL_REJECTED`
- `ObjectActivity` 不替代 workflow / approval 状态，也不承接待办分配。

### 6.4 Notification

- notification capability 拥有发送计划、渠道路由、投递结果、失败重试与已读状态真相。
- `ObjectActivity` 可以成为通知触发输入之一，但不承接通知投递状态。
- timeline 上看到一条活动，不代表通知已经成功投递给任何人。

## 7. 推荐协同形态

### 7.1 Phase 1 写入口径

- 每个对象 owner 服务在本地业务写路径中判断是否需要生成 `ObjectActivity`。
- 每条 activity fact 应与该次业务动作保持明确关联，并记录：
  - `sourceService`
  - `traceId`
  - actor snapshot
  - object reference
- 推荐将 activity fact 与本地 outbox 一起纳入服务本地一致性边界，而不是先依赖中心运行时。

### 7.2 Future 统一投影

- 未来可建立统一 timeline projection，用于：
  - 聚合多服务 activity
  - 关联 comment / approval 里程碑
  - 提供统一对象时间线查询
- 该统一投影是读模型能力，不改变各源服务对业务真相的 ownership。
- 是否最终演进为中心运行时服务，需要以后基于查询规模、跨服务采用率与治理收益再决定。

## 8. 最小模型

phase 1 冻结以下最小字段：

- `activityId`
  - 单条活动事实的稳定标识。
- `tenantId`
  - 活动所属租户边界。
- `objectType`
  - 被围绕展示的对象类型，例如 `Item`、`Quote`、`SalesOrder`。
- `objectId`
  - 对象稳定标识。
- `activityType`
  - 活动类型；受统一 taxonomy 约束。
- `actorType`
  - 活动操作者类型，例如用户、系统、集成任务。
- `actorId`
  - 操作者稳定标识。
- `actorDisplayNameSnapshot`
  - 发生时的展示名快照；不要求查询时回表重算历史显示名。
- `occurredAt`
  - 活动发生时间。
- `title`
  - 面向人读的主标题。
- `description`
  - 面向人读的补充描述。
- `changeSet`
  - 本次活动的关键变化摘要；用于表达“改了什么”，不是逐字段审计明细。
- `relatedObjectRefs`
  - 关联对象引用，例如来源报价、相关审批单、相关附件。
- `sourceService`
  - 产生该活动的服务。
- `traceId`
  - 用于跨链路追踪与排障。
- `visibilityScope`
  - 读取该活动时适用的可见性范围。

补充约束：

- 所有 activity 写入与 timeline 查询都必须显式携带 `tenantId`、operator context、trace context 与必要审计元数据。
- phase 1 只冻结字段存在性与职责，不在本线程展开 proto、数据库列或枚举细节。

## 9. Phase 1 Activity Types

phase 1 统一冻结以下活动类型：

- `CREATED`
- `UPDATED`
- `FIELD_CHANGED`
- `STATUS_CHANGED`
- `COMMENT_ADDED`
- `APPROVAL_REQUESTED`
- `APPROVAL_APPROVED`
- `APPROVAL_REJECTED`
- `ASSIGNED`
- `RELEASED`
- `CANCELLED`
- `SYSTEM_EVENT`

使用原则：

- `UPDATED` 用于一般对象更新。
- `FIELD_CHANGED` 只用于“某个字段变化本身对协作者有强语义”的场景，不代表按字段爆炸写多条活动。
- `STATUS_CHANGED` 用于对象生命周期或业务阶段变化。
- `SYSTEM_EVENT` 只用于需要被协作者读到、但不属于明确人工动作的系统侧事实。

## 10. 降噪规则

- 一次用户可见写操作通常只生成一条 primary activity。
- 不按字段爆炸生成大量 timeline item。
- 若一次操作改动多个字段，应优先合并到同一条 `UPDATED` 或 `FIELD_CHANGED` 活动，并把细节写入 `changeSet`。
- 只有当某个变化对协作者本身具有独立阅读价值时，才应拆成独立活动。
- 技术性重试、内部补偿、索引刷新、缓存同步等后台细节默认不进对象时间线，除非它们对业务协作具有明确可读价值。

## 11. Phase 1 接入顺序

### 11.1 第一优先接入对象

- `Item`
- `Quote`
- `SalesOrder`

### 11.2 第二优先接入对象

- `MES WorkOrder`
- `WMS FulfillmentSet`

### 11.3 条件接入

- `FulfillmentDemand`
  - 前提是 fulfillment boundary 先冻结。

### 11.4 后置对象

- MES `ProductionUnit`
- `PackageUnit`

## 12. Timeline 读取口径

- `ObjectTimeline` 是对象视角读模型，不是单表直出。
- phase 1 可以先以 `ObjectActivity` 为主线，逐步补 comment / approval milestone 的投影引用。
- timeline 查询应通过 `api-gateway` / BFF 暴露给外部客户端，而不是让前端直接拼装多服务真相。
- 可见性控制应通过 `visibilityScope` 与 `permission-service` 的授权结果共同完成，而不是在前端做弱约束过滤。

## 13. AI 使用约束

- AI 可以消费 `ObjectActivity / ObjectTimeline` 做对象摘要、原因解释与进度总结。
- AI 不能把 timeline 当业务真相 owner。
- AI 不能绕过对象 owner 服务、审批能力或审计链路直接改写 timeline 所暗示的业务状态。
- 若 AI 生成结论会影响业务动作，仍必须回到受控应用服务、审批或人工确认链路。

## 14. 明确禁止

- 不把 `ObjectActivity` 当业务真相 owner。
- 不替代 `AuditLog`。
- 不替代 workflow / approval 状态。
- 不替代 notification 投递状态。
- 不替代业务对象自己的状态机。
- 不直接设计前端 UI。
- 不在 phase 1 直接创建中心 `activity-service` runtime。

## 15. 关联文档

- [observability-and-audit.md](../platforms/observability-and-audit.md)
- [auth-service.md](../services/auth-service.md)
- [identity-service.md](../services/identity-service.md)
- [permission-service.md](../services/permission-service.md)
- [party-service.md](../services/party-service.md)
- [item-master-service.md](../services/item-master-service.md)
- [sales-service.md](../services/sales-service.md)
- [sales-service contracts](../../contracts/sales-service/README.md)
- [document-governance.md](../../governance/document-governance.md)
