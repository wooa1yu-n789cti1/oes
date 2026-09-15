# collaboration-service 职责卡

Last Updated: 2026-08-05

## 1. Truth Source Rule

本文是 `collaboration-service` 的唯一稳定设计真相源。

其他 collaboration 相关文档只能承担以下职责：

- `docs/contracts/collaboration-service/**`：描述黑盒接口契约，不重新定义服务职责、核心对象或长期命名。
- `docs/architecture/collaborations/**`：描述跨服务协同，不重新定义 `collaboration-service` 自身职责。
- 后续 Task 高级能力从 [backlog](../../plans/backlog.md) 分别进入独立 Design Task，不在服务真相源中保存过程记录。

若其他文档与本文冲突，以本文为准。若 `collaboration-service` 服务职责、模块边界或核心对象需要变更，必须先更新本文；涉及跨服务协同或关键架构取舍时，再同步更新 collaboration、contract 或 ADR。

## 2. Purpose

`collaboration-service` 是 OES 的全局协作服务，负责承接跨业务域通用的人类协作工作入口。

当前已冻结的模块包括：

- `task` module P1：租户内手动工作待办。
- `annotation` module P1：围绕 `CrmAccount` 的纯文本内部对象备注。

Task P1 只提供租户内手动工作待办能力，用于：

- 自己给自己创建 private work todo。
- 有授权的操作者给同租户 active account 指派任务。
- 跟踪任务的手动开始、完成、取消、重开与归档。

`collaboration-service` 不拥有 CRM、SRM、HR、Finance、Sales、Procurement、MES、WMS 等业务对象真相。

## 3. Stable Bounded Context

`collaboration-service` 属于 OES 支撑域的协作能力边界。

当前冻结：

- `task` module P1：手动任务。
- `annotation` module P1：`CrmAccount` 对象备注。

当前未冻结，仅作为后续设计方向保留：

- `comment`
- `mention`
- attachment
- team queue
- project collaboration
- task 与业务对象、workflow、notification 的深度协同

`collaboration-service` 不能演变为跨域业务逻辑堆放区。每个模块必须独立说明 owns / does-not-own，并遵守业务对象 owner 服务的边界。

## 4. Owns

`collaboration-service` owns：

- `Task`：租户内手动工作待办。
- Task 创建者与处理人引用。
- Task 状态、优先级、到期时间、完成、取消、重开与归档事实。
- Task P1 的参与者可见性规则。
- Task P1 的命令审计与任务事实事件。
- Task Assistant P1 operation 的 code risk baseline、tenant-only tightening、canonical action facts 与 policy version。
- Task Assistant P1 的 owner-action resolution、business command receipt、每个 ActionGrant JTI consumption 与最终 result reconciliation。
- Task P1 的列表查询范围：我的 todo、别人指派给我的任务、我分派的任务。
- `Annotation`：P1 中围绕 `CrmAccount` 的纯文本内部对象备注。
- Annotation 作者、可见性、编辑、软删除、对象级置顶与本地审计事实。
- Annotation 与业务对象的受控 `objectRef` 关联；P1 只白名单接入 `crm-service / CrmAccount`。

## 5. Does Not Own

`collaboration-service` does not own：

- CRM、SRM、HR、Finance、Sales、Procurement、MES、WMS 等业务对象主数据或状态机真相。
- 审批流、审批节点、审批意见、流程实例与流程结果真相；这些属于 future workflow / approval 能力。
- 签名、投票、阅读确认、文件提交、文件合规判断、合同版本或法律证据真相。
- 超出 Annotation P1 的过程备注、评论线程、回复树、mention、附件关系、附件正文或附件元数据真相；这些属于 future comment / attachment 能力、`asset-service` 或对应 owner 服务。
- Notification 模板、渠道、投递、回执、重试、提醒记录或通知偏好真相。
- SLA、升级、催办、工作日历与调度规则真相。
- recurrence 规则与周期性任务实例生成真相。
- team queue、项目、里程碑或项目计划真相。
- 员工任职、组织树、汇报线、账号、角色、权限或授权判定真相。
- AI Run / Conversation、AgentPrincipal、ToolContract、DelegationGrant、HUMAN confirmation evidence、ActionGrant credential 或 Permission intersection 真相。
- CRM、SRM、Sales、Procurement、MES、WMS 等服务的本地 Activity 真相或全局 ObjectActivity / ObjectTimeline 投影能力。

## 6. Annotation P1 Boundary

P1 只冻结一个 Annotation 接入对象：

- `crm-service / CrmAccount`

Annotation P1 是内部对象备注能力，不是 Task、Activity、Audit、Comment Thread、Attachment、Notification 或业务对象状态。

P1 支持：

- 在支持对象详情页的全局 `Collaboration Panel` 中通过 `Notes` tab 使用。
- 围绕当前 `CrmAccount` 创建纯文本多行内部备注。
- 查看当前对象的备注列表。
- `PRIVATE` 与 `OBJECT_VISIBLE` 两种可见性；默认 `OBJECT_VISIBLE`。
- 作者编辑自己的备注。
- 作者软删除自己的备注。
- 具备 Annotation 管理权限的操作者软删除他人备注。
- 多条对象级置顶；置顶只影响对可见用户的排序，不改变可见性。
- 排序规则为置顶优先，组内按创建时间倒序。
- 本地命令审计，并对齐 OES 全局 audit envelope 语义。

P1 不支持：

- 图片、附件、富文本、Markdown、mention、emoji reaction、模板、AI 总结或改写。
- 回复树、Comment Thread、外部邮件 / IM 消息。
- role-visible、team-visible、org-visible、external-visible 或指定人员共享。
- 个人置顶、Archive、恢复删除、版本 diff 展示。
- 公共 subscribable annotation events。
- ObjectActivity / ObjectTimeline 投影。
- 全局 Notes 中心、跨对象 Notes 搜索或最近备注列表。
- `SupplierProfile`、`SalesOrder`、`PurchaseOrder`、MES、WMS 等其他对象类型。
- 全局 Object Registry。

`Collaboration Panel` 是全局框架 surface，但只在已接入协作能力的业务对象详情页可见 / 可用。P1 只在 `CrmAccount` 页面启用，且 P1 只有 `Notes` tab。

## 7. Annotation P1 Object Reference

Annotation 不直接外键关联 CRM 表，不跨服务共享数据库，也不复制 `CrmAccount` 主数据真相。

P1 使用白名单 object reference adapter：

- `collaboration-service.annotation` 根据 `objectOwnerService + objectType` 路由。
- P1 只允许 `crm-service + CrmAccount`。
- adapter 通过 gRPC 调用 `crm-service` 的对象引用校验能力。
- `crm-service` 负责判断 `CrmAccount` 是否存在、当前 operator 是否可读、是否允许创建备注，并返回轻量展示快照。
- 未接入白名单的对象类型必须拒绝创建备注。

展示快照只用于协作 UI 展示，不是业务对象真相。`CrmAccount` 名称、状态、归档、删除等长期事实仍以 [crm-service.md](./crm-service.md) 为准。

已归档但仍可读取的 `CrmAccount` 可以查看 Notes；归档对象不允许新增普通备注，也不允许编辑或置顶既有备注，治理删除除外。物理删除对象后的备注处理不在 P1 冻结范围。

## 8. Annotation P1 Authorization

Annotation P1 权限先判断业务对象访问，再判断 Annotation 操作规则：

- 读取 `OBJECT_VISIBLE` 备注：必须能读取对应 `CrmAccount`。
- 读取 `PRIVATE` 备注：仅作者本人可见，治理路径除外。
- 创建备注：必须能读取对应 `CrmAccount`，且具备 Annotation 创建权限。
- 编辑备注：P1 只允许作者编辑自己的备注。
- 软删除备注：作者可软删除自己的备注；具备 Annotation 管理权限者可软删除任意备注。
- 置顶 / 取消置顶：需要 Annotation 管理权限。

P1 只冻结两个 Annotation 权限语义：

- create：控制能否在支持对象上创建备注。
- manage：控制置顶 / 取消置顶、软删除他人备注等治理操作。

作者编辑 / 软删除自己的备注走作者规则，不单独冻结权限码。P1 不允许管理员编辑他人备注正文，避免改变“谁说了什么”的协作事实。

Annotation P1 是 `tenantId + objectRef` 范围，不冻结 org-level visibility。`orgId` 可作为请求上下文或审计元数据携带，但不参与 P1 备注可见性判断。

## 9. Annotation P1 Audit And Events

Annotation P1 的写操作必须记录 `collaboration-service.annotation` 本地审计，并对齐 OES 全局 audit envelope：

- 创建备注。
- 编辑备注。
- 软删除备注。
- 置顶 / 取消置顶。
- 可见性变更。

审计至少应体现 tenant、operator、trace、audit context、目标 Annotation、关联 `objectRef`、动作与结果。审计不作为普通 Notes 列表或对象 Activity 展示来源。

P1 不冻结公共 subscribable annotation events。未来如接入 Notification、ObjectTimeline、Search 或 AI summary，必须按 OES 事件治理规则单独冻结 annotation events。

## 10. Task P1 Core Object

P1 只冻结一个核心对象：

- `Task`

`Task` 核心字段：

- `taskId`
- `tenantId`
- `title`
- `description`
- `createdByAccountId`
- `assigneeAccountId`
- `visibility`
- `status`
- `priority`
- `dueAt`
- `startedAt`
- `completedAt`
- `completedByAccountId`
- `completionNote`
- `cancelledAt`
- `cancelledByAccountId`
- `cancelReason`
- `archivedAt`
- `archivedByAccountId`
- `createdAt`
- `updatedAt`

P1 `description` 是纯文本，不承接富文本、附件、评论或对象备注语义。

P1 不冻结：

- `primaryObjectRef`
- `relatedObjectRefs`
- `sourceBinding`
- `completionMode`
- `recurrenceRule`
- `teamQueueRef`
- `slaPolicyRef`
- `projectRef`
- `correlationKey`

这些字段或概念属于后续 slice，不得在 P1 contract 中提前承诺。

## 11. Task P1 Enums

`visibility`：

- `PRIVATE`
- `ASSIGNMENT_PARTICIPANTS`

`status`：

- `OPEN`
- `IN_PROGRESS`
- `COMPLETED`
- `CANCELLED`

`priority`：

- `LOW`
- `NORMAL`
- `HIGH`
- `URGENT`

`OVERDUE` 不作为状态。超期由查询时根据 `status in OPEN / IN_PROGRESS` 且 `dueAt < now` 派生。

## 12. Task P1 State Rules

允许的状态流转：

- `OPEN -> IN_PROGRESS`
- `OPEN -> COMPLETED`
- `OPEN -> CANCELLED`
- `IN_PROGRESS -> COMPLETED`
- `IN_PROGRESS -> CANCELLED`
- `COMPLETED -> OPEN`
- `CANCELLED -> OPEN`

不允许的状态流转：

- `IN_PROGRESS -> OPEN`
- `COMPLETED -> IN_PROGRESS`
- `CANCELLED -> IN_PROGRESS`
- `COMPLETED -> CANCELLED`
- `CANCELLED -> COMPLETED`

`archivedAt` 不是任务状态，只是终态任务的归档标记。

## 13. Task P1 Commands

P1 冻结以下 commands：

- `CreateTask`
- `UpdateTask`
- `StartTask`
- `CompleteTask`
- `CancelTask`
- `ReopenTask`
- `ArchiveTask`
- `UnarchiveTask`

### 13.1 CreateTask

- Self todo：已认证租户 operator 可以给自己创建。
- Assigned task：需要 `collaboration.task.assign` 权限。
- 指派目标必须是同 tenant 内 active account。
- Self todo 默认 `visibility = PRIVATE`。
- 指派给他人默认 `visibility = ASSIGNMENT_PARTICIPANTS`。
- 初始状态为 `OPEN`。

### 13.2 UpdateTask

- 只有 `createdByAccountId` 可以更新。
- 可更新字段：`title`、`description`、`dueAt`、`priority`。
- 只允许更新 `OPEN / IN_PROGRESS` 状态任务。
- 已归档任务不得更新。

### 13.3 StartTask

- 只有 `assigneeAccountId` 可以开始。
- `OPEN -> IN_PROGRESS`。
- `IN_PROGRESS` 幂等成功。
- `startedAt` 记录最近一次开始时间。

### 13.4 CompleteTask

- `createdByAccountId` 或 `assigneeAccountId` 可以完成。
- `OPEN / IN_PROGRESS -> COMPLETED`。
- `COMPLETED` 幂等成功，且不覆盖既有完成字段。
- 记录 `completedAt`、`completedByAccountId`、`completionNote`。

### 13.5 CancelTask

- 只有 `createdByAccountId` 可以取消。
- `OPEN / IN_PROGRESS -> CANCELLED`。
- `CANCELLED` 幂等成功，且不覆盖既有取消字段。
- 记录 `cancelledAt`、`cancelledByAccountId`、`cancelReason`。

### 13.6 ReopenTask

- `COMPLETED -> OPEN`：`createdByAccountId` 或 `assigneeAccountId` 可以重开。
- `CANCELLED -> OPEN`：只有 `createdByAccountId` 可以重开。
- 已归档任务必须先 `UnarchiveTask` 才能重开。
- 重开会清空当前完成 / 取消主字段；历史必须通过 audit 保留。

### 13.7 ArchiveTask

- 只有 `createdByAccountId` 可以归档。
- 只允许归档 `COMPLETED / CANCELLED` 任务。
- 记录 `archivedAt`、`archivedByAccountId`。

### 13.8 UnarchiveTask

- 只有 `createdByAccountId` 可以取消归档。
- 清空 `archivedAt`、`archivedByAccountId`。

P1 不支持 `DeleteTask`。错误任务通过 `CancelTask + ArchiveTask` 收口。

### 13.9 Task Assistant / ActionGrant Boundary

Task Assistant、ActionGrant 与 DELEGATED runtime 均保持后置，不属于当前 16 个 HUMAN WEB RPC 的可执行入口。当前设计不冻结 delegated read/create operation、owner-action resolver、ActionDescriptor、JTI consumption 或 AI-specific idempotency receipt；这些能力未来必须单独定义并通过独立设计与契约冻结。当前 HUMAN RPC 不接受 DELEGATED、MACHINE 或 AI caller。

## 14. Task P1 Query Scope

P1 提供统一任务列表查询，按 scope 区分视图：

- `MY_TODO`
  - `createdByAccountId = operatorAccountId`
  - `assigneeAccountId = operatorAccountId`
  - `visibility = PRIVATE`
- `ASSIGNED_TO_ME`
  - `assigneeAccountId = operatorAccountId`
  - `createdByAccountId != operatorAccountId`
- `CREATED_BY_ME`
  - `createdByAccountId = operatorAccountId`
  - `assigneeAccountId != operatorAccountId`

P1 支持的过滤维度：

- `status`
- `priority`
- `dueBefore`
- `dueAfter`
- `keyword`
- `overdueOnly`
- `includeArchived`
- `archivedOnly`
- `page`
- `pageSize`

默认列表只展示 `OPEN / IN_PROGRESS` 且未归档任务。

`GetTask` 的普通可见性：

- `createdByAccountId = operatorAccountId`
- 或 `assigneeAccountId = operatorAccountId`

管理视图、组织范围视图、团队队列视图、项目视图和业务对象关联视图均后置。

## 15. Task P1 Authorization Boundary

P1 只冻结一个显式权限码：

- `collaboration.task.assign`

该权限只控制是否可以创建 `assigneeAccountId != operatorAccountId` 的任务。

其他操作由 Task 参与者规则控制：

- read：`createdByAccountId` 或 `assigneeAccountId`
- update：`createdByAccountId`
- start：`assigneeAccountId`
- complete：`createdByAccountId` 或 `assigneeAccountId`
- cancel：`createdByAccountId`
- reopen completed：`createdByAccountId` 或 `assigneeAccountId`
- reopen cancelled：`createdByAccountId`
- archive / unarchive：`createdByAccountId`

P1 不按组织层级、汇报关系、项目成员或团队队列控制委派范围。后续若引入组织范围或汇报线委派，必须通过 `hr-service`、`tenant-org-service` 与 `permission-service` 的正式协同设计扩展。

## 16. Task P1 Audit

每个 P1 command 都必须写 audit：

- `TASK_CREATED`
- `TASK_UPDATED`
- `TASK_STARTED`
- `TASK_COMPLETED`
- `TASK_CANCELLED`
- `TASK_REOPENED`
- `TASK_ARCHIVED`
- `TASK_UNARCHIVED`

审计至少记录：

- `tenantId`
- `taskId`
- `operatorAccountId`
- `createdByAccountId`
- `assigneeAccountId`
- `action`
- `result`
- `reason / note snapshot`，当命令提供时记录摘要
- `traceId`
- `occurredAt`

Audit 不应退化为任务正文存储；长文本内容不应依赖 audit 作为读取来源。

## 17. Task P1 Published Facts

本地事务成功后发布以下任务事实事件：

- `TaskCreated`
- `TaskAssigned`
- `TaskUpdated`
- `TaskStarted`
- `TaskCompleted`
- `TaskCancelled`
- `TaskReopened`
- `TaskArchived`
- `TaskUnarchived`

触发规则：

- Self todo：发布 `TaskCreated`。
- Assigned task：发布 `TaskCreated` 与 `TaskAssigned`。

事件 payload 至少包含：

- `eventId`
- `eventType`
- `occurredAt`
- `tenantId`
- `taskId`
- `actorAccountId`
- `createdByAccountId`
- `assigneeAccountId`
- `status`
- `previousStatus`，仅状态变化事件需要
- `priority`
- `dueAt`
- `titleSnapshot`
- `traceId`

事件不携带 `description`。

P1 不发布：

- `TaskDueSoon`
- `TaskOverdue`
- `TaskReminderRequested`
- `TaskLinkedToBusinessObject`
- `TaskSourceCompleted`

## 18. Integration Boundary

外部客户端统一通过 API Gateway / BFF 进入：

- external client -> `api-gateway` / BFF -> `collaboration-service` gRPC

`collaboration-service` 应对齐 OES 既有服务框架：

- 内部 gRPC command / query 契约。
- application 层执行参与者规则、指派权限与审计编排。
- 本地事务成功后发布事件。

所有 query 与 command 都通过 verified HUMAN WEB ExecutionToken 和 trusted transport context 建立 tenant、operator、trace authority；command 的 audit identity/source 也由该上下文提供。request body 不再承载这些 authority 字段，业务 target、reason 与 objectRef 仍是普通业务数据。

## 19. Task Assistant AI Exposure

Task Assistant 的任何工具消费保持后置；AI 不是当前 16 个 HUMAN RPC 的 creator、assignee 或 participant，业务责任主体始终是可信 HUMAN account。

未来 AI exposure 的 operation、风险等级、ActionGrant 与审计规则不在本轮冻结。

当前不定义 AI operation matrix、ActionDescriptor、ActionGrant receipt 或 AI-specific idempotency；这些均须未来单独冻结。

## 20. Deferred

以下能力明确后置：

- business object binding
- source binding
- auto completion
- workflow integration
- business event listener
- recurrence
- reminder / due soon / overdue event
- SLA / escalation
- team queue
- org / reporting assignment scope
- project integration
- task batch / campaign
- annotation-on-task
- annotation image / attachment / mention / rich text
- Annotation support for objects other than `CrmAccount`
- public annotation events
- ObjectActivity / ObjectTimeline projection
- global Notes center / cross-object Notes search
- notification closed loop
- admin / org management views
- delete task

## 21. Trusted gRPC Inbound Boundary

The existing 16 Task and Annotation RPCs remain one business API per operation. `CreateTask` is intentionally not split: a self todo and an assigned task are two outcomes of the same create operation. Trusted gRPC admission requires the base Code `collaboration.task.create`; after ET claims are established, Collaboration compares `assigneeAccountId` with the verified operator. Self assignment proceeds without another Permission lookup; assigning another account calls Permission Service for `collaboration.task.assign` and then verifies the target is an active account in the same tenant. `DeleteAnnotation` likewise remains one operation: the service compares the verified operator with `authorAccountId`, allowing the author rule, or calls Permission Service for `collaboration.annotation.manage` for governance deletion of another author's note.

All 16 inbound RPCs use `aud=urn:oes:service:collaboration-service`, certificate-bound HUMAN ExecutionToken, `session_terminal=WEB`, and reject MACHINE, DELEGATED, missing/wrong audience, certificate binding, terminal or Code. Tenant, operator, trace and audit facts come only from verified ET/transport context. The request body never establishes authority. `ActionGrant`, Task Assistant and DELEGATED execution remain deferred and cannot use these HUMAN RPCs.

This transport migration does not alter Task participant rules, Annotation author/visibility rules, CRM object-reference checks, local audit, Task events/outbox, Prisma/schema, or the existing Gateway Identity client used for participant display names.

The CRM target cutover activates the existing Annotation object-reference adapter as one exact HUMAN_OBO hop. Collaboration preserves the locally verified inbound HUMAN subject/tenant/session and `WEB` terminal, exchanges it through Auth STS for `aud=urn:oes:service:crm-service`, records exact `collaboration-service` SYSTEM MACHINE actor attribution, and calls only `ValidateCrmObjectReference` with Code `crm.internal.object_reference.validate` over a dedicated CRM mTLS client. Missing inbound proof, wrong actor/audience/terminal/Code/certificate, MACHINE root, DELEGATED, body authority and the former generic CRM registration all fail closed. Identity and Permission outbound target compositions remain unchanged.
