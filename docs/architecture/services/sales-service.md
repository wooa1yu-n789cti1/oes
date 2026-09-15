# sales-service 职责卡

## 1. Purpose

`sales-service` 是 OES 的销售交易与客户承诺服务，负责回答“这份对客报价是什么、哪些内容已经被正式发布、订单在什么商业前提下正式成立，以及哪些客户承诺已经可以交接给履约边界继续推进”。

phase 1 只冻结报价与订单核心交易边界，不展开 proto、运行时代码、UI 或完整结算体系。

## 2. Owns

- `Quote`
- `QuoteVersion`
- `SalesOrder`
- `SalesOrderLine`
- 销售交易中的 transaction snapshot
- customer commitment 真相
- 报价草稿、正式发布、历史版本找回与基于正式版本成立订单的业务语义
- 订单成立、允许生产、允许备货、允许发货这四类商业前提节点

## 3. Does Not Own

- `crm-service` 的 lead、account、contact、opportunity 与销售前置跟进真相
- `party-service` 的主体主数据与租户主体引用；具体核心对象与 owner 边界以 [party-service.md](./party-service.md) 为准
- `item-master-service` 的 `ItemModel`、`Item`、attribute、BOM、Packaging、`ItemCategory`、`SupplierItemMapping` 与 Item 主数据真相
- `wms-service` 的库存、占用、包装转换与发运执行真相
- `mes-service` 的制造执行、`ProductionUnit` / WIP、工序与放行执行真相
- future `finance-service` 或外部财务系统的 `AR / AP / invoice / payment` 真相
- `Contract / CLM` 生命周期真相
- 完整 pricing engine、包装主数据或客户产品目录真相

## 4. Core Responsibilities

- 管理同一份报价在草稿态中的持续修改，而不把每次保存都升级为正式版本。
- 在显式发布动作发生时生成 `QuoteVersion`，并保留对外正式报价、客户确认与订单成立所需的历史基线。
- 明确区分下载 / 预览与正式发布；下载、导出、打印、预览都不生成新的 `QuoteVersion`。
- 只通过显式成立动作创建 `SalesOrder`，不把“存在报价”或“下载报价”误判成正式订单。
- 在 `SalesOrderLine` 上保存稳定引用与冻结快照，phase 1 最小集合必须包括：
  - `itemId`
  - `itemSnapshot`
  - `salesConfigSnapshot`
  - `packagingRequirementSnapshot`
  - `priceQuantityDeliverySnapshot`
  - `customerItemSnapshot`
- 用 `customerItemSnapshot` 承接出口等场景下客户自有 `SKU / 型号 / 标签显示名`，避免把客户侧显示语义硬塞回 `item-master-service`。
- 维护订单成立、允许生产、允许备货、允许发货这几个拆开的商业前提节点，而不是将其折叠成单一确认动作。
- 向 fulfillment boundary 发布商业前提与 handoff 事实；physical release 与执行推进真相不归 `sales-service`。

## 5. External Interfaces

- 典型上游入口：
  - `api-gateway`
  - future sales workspace / quote-order pages
  - CRM-assisted sales flows through BFF only
- 当前设计输入：
  - [erp-service-design.md](../../plans/designs/erp-service-design.md)
  - [sales-service contracts](../../contracts/sales-service/README.md)

## 6. Upstream Dependencies

- `crm-service`
  - 提供客户开发、联系人、商机与销售前置协同语义。
  - `sales-service` 不复制 opportunity 真相，只消费已确认的销售上下文或显式引用。
- `party-service`
  - 提供交易主体与 `tenantPartyId` 引用真相。
  - `sales-service` 不自建客户主体主档。
- `item-master-service`
  - 提供 `ItemModel`、attribute、`PackagingSpec` 到 active + sellable `Item` 的解析与稳定引用口径。
  - `sales-service` 在自身域内冻结销售配置、包装要求与客户承诺快照。
- `permission-service`
  - 提供报价发布、订单成立与放行动作所需的授权判定能力；permission 侧核心对象与 owner 边界以 [permission-service.md](./permission-service.md) 为准。

## 7. Downstream / Published Facts

- `Quote` 草稿与正式发布事实
- `QuoteVersion` 历史基线
- `SalesOrder` / `SalesOrderLine` 客户承诺事实
- 订单成立、允许生产、允许备货、允许发货的商业放行结果
- 供 fulfillment boundary 消费的 handoff 输入与商业前提摘要

## 8. Non-goals

- 不把 `sales-service` 扩成“大而全 erp-service”。
- 不把 CRM opportunity、Party truth、Item truth、WMS 库存、MES 执行或 Finance 真相复制进销售域。
- 不把 `CustomerItemMapping` 放进 `item-master-service`。
- 不把 `Contract / CLM` 作为 phase 1 的固定必经步骤。
- 不在 phase 1 展开完整 pricing engine 或客户产品目录；长期包装主数据归 `item-master-service`，销售只保存交易快照与客户承诺。

## 9. Current Stage

当前阶段只冻结 `sales-service` phase 1 最小稳定边界：

- 已确认 `sales-service` 取代“大 erp-service”承担销售交易主链。
- phase 1 聚焦 `Quote -> QuoteVersion -> SalesOrder -> SalesOrderLine -> fulfillment handoff`。
- 长期 `CustomerItemMapping` 只作为 `Sales / CRM` 协同候选能力存在；phase 1 只承诺 line-level `customerItemSnapshot`。
- `Contract / CLM`、完整 finance integration、完整 fulfillment service 形态、pricing engine 与客户产品目录均 deferred。

## 10. Trusted gRPC Boundary

现有四个 gRPC service 的 27 个 RPC 是面向租户后台销售人员的既有业务操作，统一冻结为 `BUSINESS / HUMAN / WEB`，目标 audience 为 `urn:oes:service:sales-service`。当前唯一生产入口是 API Gateway Sales BFF；未发现纯 MACHINE 生产调用方。Sales 只接受由 Gateway 当前 HUMAN WEB 会话换取、且与 mTLS 叶证书绑定的目标 ExecutionToken，并按每个 RPC 的 canonical Sales Permission Code 执行 `all` 判定。现有 RPC 不接受 MACHINE、DELEGATED、SELF_SERVICE 或非 WEB terminal，也不得同时声明第二种 INTERNAL 模式。

Request body 中的 `tenant_id`、`operator_context`、`trace_context`、`audit_context` 是迁移前兼容输入，不再构成 authority。迁移后 tenant、org、operator、request、trace 与审计身份/来源全部来自 verified ExecutionToken 和 trusted transport context；普通 metadata、body identity 或 Gateway fallback 字符串不能补足或覆盖。管理命令可以保留一个有长度限制、由用户填写的 `reason` 业务字段，但它不能提供 audit id、source 或 principal authority。

现有 27 个 RPC 的精确分类、Code、field tombstone 与新 `reason` 字段号以 [Sales contracts](../../contracts/sales-service/README.md) 为准。

未来确有自动化协同时，必须根据真实流程另行冻结窄范围 INTERNAL RPC 或事件：例如 Finance 读取订单结算摘要、MES 查询生产准备事实，或 WMS/fulfillment 消费 handoff 事实。该后续登记不是当前可调用契约，不新增业务能力；不得直接把当前 HUMAN RPC 改成双模式或让服务凭 body 冒充系统调用方。Sales 到 CRM、Party、Item、WMS、MES、Finance 的既有 outbound 与候选事件边界在本次迁移中保持不变。
