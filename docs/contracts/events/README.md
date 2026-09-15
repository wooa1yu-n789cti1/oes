# OES Event Catalog Contract

更新时间：2026-07-28

本文冻结 OES 第一版文档化 Event Catalog / Event Contract 协作机制。它不是 broker 选型、schema registry、outbox 实现或消息中间件运行手册。

公共事件的可靠投递平台以 [Event Bus 与 Outbox / Inbox 架构](../../architecture/platforms/event-bus-and-outbox.md) 为稳定设计真相，CloudEvents 与 common code contract 决策以 [ADR 0014](../../adr/0014-cloudevents-and-service-owned-event-code-contracts.md) 为准，broker-independent envelope 与 NATS transport mapping 以 [platform-transport.md](./platform-transport.md) 为黑盒契约。上述平台文档只负责运输，不得重新定义本目录中的业务 event type、payload、owner 或版本语义。

## 1. 目的

Event Catalog 用于回答：

- 哪个 owner service 对外发布了哪些稳定事实事件。
- 哪些事件允许跨 bounded context 订阅。
- 事件 envelope、payload、版本与兼容性如何治理。
- NotificationRule、timeline、BI、search、AI 后处理等消费者可以依赖哪些事件。

Event Catalog 不用于：

- 重新定义服务核心对象或 owner 边界。
- 替代 `docs/architecture/services/*.md` 服务稳定真相源。
- 替代 `docs/architecture/collaborations/*.md` 跨服务协同设计。
- 记录服务内部 local event、进程内 `EventEmitter`、audit pipeline 或临时 outbox 实现细节。
- 决定 broker、topic、partition、重试队列、DLQ 或 schema registry 技术实现。

## 2. 事件分类

| 类型                                          | 说明                                                                | 是否进入 Event Catalog                       |
| --------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| local event                                   | 服务进程内事件、框架事件、模块内钩子。                              | 否                                           |
| audit event                                   | 为合规、审计、追责、操作历史而记录的本地审计事实。                  | 默认否；除非另行冻结为公共审计事件           |
| domain event                                  | 服务内部领域事实，可用于本地事务、领域模型或 outbox。               | 不自动进入                                   |
| integration event / public subscribable event | owner service 在本地事务成功后对外发布的稳定跨上下文事实。          | 是                                           |
| notification rule consumed event              | `notification-service` 的 NotificationRule 可引用的公共可订阅事件。 | 是，且必须标记 `notificationConsumable=true` |

代码里出现 `EventEmitter`、`emit`、`publish`、`outbox` 或 `eventType`，不代表该事件已经成为公共可订阅契约。

跨服务异步 command 是定向请求，不是已经成立的事实，不进入本 Event Catalog。未来若 OES 引入异步 command lane，必须使用独立 contract、stream、subject 与 target owner 语义。

## 3. 文档结构

事件契约入口固定为：

- [catalog.md](./catalog.md)：全局事件索引。
- [platform-transport.md](./platform-transport.md)：公共事件的 outbox / broker / inbox 黑盒传输契约，不定义业务 payload。
- `<service-name>.md`：默认承载单个 owner service 的事件契约，例如 [collaboration-service.md](./collaboration-service.md)。

每个 owner service 只能维护自己拥有的事件契约。其他服务、Delivery artifact、active design 或 collaboration 文档可以引用这些契约，但不得重新定义同一事件的语义、payload 或版本规则。

当 owner 已在自己的唯一服务 contract 中冻结事件语义，且跨 capability path ownership 不允许 Event Catalog 复制 payload 时，本目录可以建立只含 catalog identity、transport mapping 与 owner truth link 的 registration 文档。例如 [auth-service.md](./auth-service.md) 只登记安全事件接入，并直接引用 Auth-owned ExecutionToken contract；该 registration 不是第二份业务语义真相。

### 3.1 Common 代码契约

进入实现后，每个 owner service 必须把已冻结公共事件映射到仓库现有 service contract 目录：

```text
src/common/src/contracts/<service_snake_case>/events.ts
```

例如：

```text
src/common/src/contracts/collaboration_service/events.ts
src/common/src/contracts/asset_service/events.ts
src/common/src/contracts/auth_service/events.ts
```

该文件只定义本服务公共 event type/version/owner 常量、`data` payload TypeScript 类型、通用 `OesCloudEvent<TData>` 组合类型和运行时验证 descriptor，并由同目录 `index.ts` 导出。producer 与 consumer 必须从同一份 common contract 引用；不得各自复制字符串或 payload interface，也不得把 owner 的内部 domain type 暴露为公共 contract。

owner semantic contract 是业务语义真相：通常位于本目录；采用 registration-by-reference 时则以 registration 明确链接的 owner service contract 为准。common `events.ts` 是冻结契约的编译期实现映射，不能先于文档定义新语义。第一版不要求独立 Schema Registry、平行 JSON Schema 目录或 AsyncAPI codegen；未来生成物不得成为第二份业务语义真相。

## 4. 事件状态

| 状态                       | 含义                                       | 消费者能否订阅                      |
| -------------------------- | ------------------------------------------ | ----------------------------------- |
| `PROPOSED`                 | 建议新增，尚未被 owner service 确认。      | 否                                  |
| `DESIGNED_NOT_IMPLEMENTED` | 已有稳定设计，但尚未实现或未进入发布路径。 | 否，除非 feature 明确接受 mock/stub |
| `IMPLEMENTED_UNCONTRACTED` | 代码已有发布或订阅，但尚未冻结契约。       | 否                                  |
| `FROZEN_SUBSCRIBABLE`      | 契约已冻结，可被跨服务消费者订阅。         | 是                                  |
| `DEPRECATED`               | 已有替代或计划下线，仍在兼容窗口。         | 仅存量消费者                        |
| `SUPERSEDED`               | 已被替代事件覆盖，不再新增订阅。           | 否                                  |

NotificationRule 只能引用 `FROZEN_SUBSCRIBABLE` 且 `notificationConsumable=true` 的事件。

### 4.1 Transport Profile

每个 `FROZEN_SUBSCRIBABLE` 事件还必须登记一个 transport profile：

| Profile             | Semantics                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BUSINESS`          | 普通 tenant-only 公共事实；进入 `OES_BUSINESS_EVENTS`。                                                                 |
| `SECURITY_CRITICAL` | 仅用于通过平台适用门禁的紧急安全事实；进入隔离的 security Stream/DLQ，并强制 execution scope、精确 ACL 与 fail-closed。 |

transport profile 不是业务 event type 或 `eventVersion` 的组成部分，publisher 不得在运行时切换。profile、Stream 或 scope compatibility 的变更必须先更新 Event-owned architecture / transport contract 与 Catalog；业务 payload 仍只由 owner contract 决定。

Catalog 只登记已由 transport contract 决定的 profile，不自行选择 broker、Stream、DLQ 或 retry 技术。

## 5. 命名规范

公共 event type 使用小写 dot-case：

```text
<bounded-context>.<aggregate-or-capability>.<past-tense-fact>
```

示例：

- `collaboration.task.assigned`
- `collaboration.task.completed`
- `collaboration.task.cancelled`

命名要求：

- 使用已经发生的事实，不使用命令式动词。
- 不在 event type 中包含版本号；业务语义使用 `eventVersion`，CloudEvents wire mapping 使用 `oeseventversion`。
- 不暴露技术实现名、class name、broker topic 或数据库表名。
- 可以记录 `implementationAlias`，用于映射既有代码或服务文档中的 `TaskAssigned` 这类名称。

## 6. CloudEvents Envelope

所有公共可订阅事件采用 CloudEvents `1.0` Structured JSON。Event Catalog 使用 OES 业务语义名称，wire contract 以固定映射表达：

| OES 业务语义         | CloudEvents / OES extension | 必填 | 说明                                                 |
| -------------------- | --------------------------- | ---- | ---------------------------------------------------- |
| CloudEvents 标准版本 | `specversion`               | 是   | 固定为 `1.0`，不是业务事件版本。                     |
| `eventId`            | `id`                        | 是   | 全局唯一事件 ID。                                    |
| `eventType`          | `type`                      | 是   | 公共 dot-case event type。                           |
| `eventVersion`       | `oeseventversion`           | 是   | OES 业务事件版本，初始为 `1`。                       |
| `ownerService`       | `source`                    | 是   | `urn:oes:service:<owner-service>`。                  |
| `occurredAt`         | `time`                      | 是   | owner service 确认事实成立的时间。                   |
| schema identity      | `dataschema`                | 是   | `urn:oes:event:<eventType>:v<eventVersion>`。        |
| `executionScope`     | `oesexecutionscope`         | 条件 | `SECURITY_CRITICAL` 必填；只允许 SYSTEM/TENANT。     |
| `tenantId`           | `oestenantid`               | 条件 | 普通/TENANT 必填；SYSTEM security fact 必须缺失。    |
| `orgId`              | `oesorgid`                  | 否   | 场景适用时携带组织边界。                             |
| `aggregateType`      | `oesaggregatetype`          | 条件 | owner contract 声明公共 aggregate 时必填。           |
| `aggregateId`        | `subject / oesaggregateid`  | 条件 | owner contract 声明公共 aggregate 时两者必填且一致。 |
| `actorAccountId`     | `oesactoraccountid`         | 否   | 只用于归因，不是下游授权凭证。                       |
| `traceId`            | `oestraceid`                | 是   | OES 链路关联 ID。                                    |
| `correlationId`      | `oescorrelationid`          | 否   | 跨消息/流程关联 ID。                                 |
| `causationId`        | `oescausationid`            | 否   | 触发该事件的 command、event 或 request ID。          |
| `auditRef`           | `oesauditref`               | 否   | owner service 本地审计引用。                         |
| `payload`            | `data`                      | 是   | 事件业务载荷。                                       |

CloudEvents extension attribute 使用小写字母和数字；common codec 可以为 TypeScript 应用提供 camelCase 语义别名。准确 Structured JSON 与 NATS mapping 以 [platform-transport.md](./platform-transport.md) 为准。

普通事件继续使用真实 tenant 与稳定 aggregate。security-critical contract 只有在 Catalog 显式登记后才能使用 `oesexecutionscope`；若 owner semantic contract 没有声明公共 aggregate，Event 平台不得从敏感 payload/selector 推导或补造 `subject / oesaggregatetype / oesaggregateid`。

## 7. Payload 记录方式

第一阶段使用 Markdown 表冻结 payload schema：

- 字段名。
- 类型。
- 必填性。
- 说明。
- 兼容性规则。

payload 只携带消费者理解事件所需的 ID、状态和必要快照。不得把 owner service 的完整内部实体、长文本正文、数据库结构或 UI 专用模型直接塞入 payload。

## 8. 版本与兼容性

CloudEvents `specversion` 固定为 `1.0`；OES `eventVersion` 映射到 `oeseventversion`，初始为 `1`。同一业务版本内允许：

- 新增 optional 字段。
- 新增 enum 值，但消费者必须容忍 unknown。
- 放宽字段约束。
- 增加不改变既有语义的快照字段。

同一版本内禁止：

- 删除已冻结字段。
- 修改字段含义。
- 将 optional 字段改为 required。
- 改变 ID 归属、状态语义、时间语义或租户边界语义。
- 把 consumer 依赖的 payload 字段改成另一服务的内部对象结构。

不兼容变更必须新增 `eventVersion`，并写明迁移窗口、双发策略或替代事件。

## 9. Owner Service 责任

owner service 必须：

- 只发布自己拥有真相的事实事件。
- 在本地事务成功后发布事件。
- 维护本服务事件契约、版本、deprecated / superseded 信息。
- 确保 payload 不泄露非必要敏感信息或他域内部真相。
- 明确事件是否可被 NotificationRule 消费。
- 明确事件与本地 audit fact 的关系，但不把 audit 表当公共契约。
- 在实现时维护自己 `src/common/src/contracts/<service_snake_case>/events.ts` 中的公共事件 code contract，并保证与本文和 `catalog.md` 一致。

owner service 不得：

- 为其他服务定义事件。
- 发布尚未成为本服务事实的命令意图。
- 依赖消费者回写来完成本服务本地事务。
- 用事件绕过 gRPC 写前强校验。

## 10. Consumer 订阅纪律

consumer service 必须：

- 只订阅 `FROZEN_SUBSCRIBABLE` 事件。
- 按至少一次投递处理，保证幂等。
- 容忍重复、乱序、延迟、缺失和重放。
- 只把事件作为事实输入，不反向接管 owner service 真相。
- 不从源码、测试、outbox 表或 broker topic 猜测未声明事件。
- 不依赖事件完成当前 command 的同步成功/失败闭环。
- 从 owner 的 common `events.ts` 引用同一 event type/version/data contract，不自行复制跨服务 payload interface。

NotificationRule 额外要求：

- 只能引用 `notificationConsumable=true` 的事件。
- 不得引用 audit event、local event、未冻结 domain event 或未声明 outbox event。
- 模板、渠道、收件人解析、投递状态仍归 `notification-service`，事件 owner 只负责事实发布。

## 11. Deprecated / Superseded

废弃事件必须记录：

- 当前状态：`DEPRECATED` 或 `SUPERSEDED`。
- 替代事件。
- 最后允许新增订阅日期。
- 存量消费者迁移要求。
- 兼容发送截止条件。

被替代事件不得继续扩展 payload 或新增消费者。

## 12. 当前冻结范围

当前冻结 `collaboration-service` Task P1 中 Notification P1 需要消费的三个事件、Site Media availability 供 `site-service` 消费的一个事件，以及 Auth-owned 紧急 ExecutionToken 撤销事实：

- `collaboration.task.assigned`
- `collaboration.task.completed`
- `collaboration.task.cancelled`
- `asset.site-media.availability.changed`
- `auth.execution-token.revoked`

除上述 Auth security fact 外，其他 auth / identity / permission 事件、terminal device 事件、MES outbox 事件、Sales / Procurement / Finance / WMS deferred candidate events 均不在当前冻结范围内。
