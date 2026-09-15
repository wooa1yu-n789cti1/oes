# Sales、CRM、Party 与 Item Master 协同蓝图

Last Updated: 2026-06-10

> `crm-service` 的服务职责、核心对象、owner 边界与长期命名以 [crm-service.md](../services/crm-service.md) 为唯一稳定真相源。本文只描述 `sales-service`、`crm-service`、`party-service` 与 `item-master-service` 的跨服务协同，不重新定义 CRM 服务内部设计。

## Status Note 2026-06-10

CRM v2 已原地替代旧 customer master phase 1 设计。CRM v2 Phase 1 只冻结核心对象模型，不冻结报价、订单、发票或 Sales selector 边界。

因此，本文中围绕旧 `CustomerAccount / CustomerAddressUsage / CustomerContactUsage / CustomerTaxProfile / Customer Selector` 的销售协同规则只作为旧实现和后续重写参考；新的 Sales / CRM 协同必须在独立设计中基于 [crm-service.md](../services/crm-service.md) 重新冻结。

## 1. 目标

定义 `sales-service` 如何与 `crm-service`、`party-service`、`item-master-service` 协作，支撑报价与订单主链，同时避免把客户主数据、商机真相或 Item 主数据真相错误并入销售交易边界。

Item Master 概念以以下文件为唯一真相源：

- [item-master-service.md](../services/item-master-service.md)

## 2. 参与服务

- `sales-service`
- `crm-service`
- `party-service`
- `item-master-service`

## 3. 协同分工

- `sales-service`
  - 负责 `Quote`、`QuoteVersion`、`SalesOrder`、`SalesOrderLine`、transaction snapshot 与 customer commitment。
- `crm-service`
  - 负责 `CustomerAccount`、`CustomerAddressUsage`、`CustomerContactUsage`、`CustomerTaxProfile` 与销售前置交互过程。
- `party-service`
  - 负责当前租户内 `TenantParty` 主体事实；核心对象、地址 / 联系人正文与 owner 边界以 [party-service.md](../services/party-service.md) 为准。
- `item-master-service`
  - 负责 `ItemModel`、`Item`、attribute、BOM、Packaging、`ItemCategory` 与 `SupplierItemMapping` 真相。

## 4. 稳定协同规则

### 4.1 CRM CustomerAccount 与 Party 的边界

- `CustomerAccount` 是客户关系外壳，不等于 `party-service` 的主体主数据。
- `party-service` 回答“当前租户内这个交易 / 法律主体是谁”；`crm-service` 回答“这个主体在销售关系里处于什么客户状态”。
- `CustomerAccount` 直接引用 `tenantPartyId`；该绑定目标真相仍归 `party-service`。
- phase 1 一条 `CustomerAccount` 只有一个 `tenantPartyId`。
- 同一 `tenantId + tenantPartyId` 最多对应一个 active `CustomerAccount`。
- 创建客户时必须先通过 `party-service` 在当前租户内 register / select `TenantParty`；identifier 复用规则以 [party-service.md](../services/party-service.md) 为准。
- `TenantParty Selector` 只用于当前租户内主体选择；`Customer Selector` 只返回可被销售采用的 `CustomerAccount`。
- 明确禁止把 Party 主体字段复制成 CRM 真相；CRM 只保存关系语义、绑定关系和必要摘要。

### 4.2 Sales 与 CRM 的 customer selector 边界

- Sales phase 1 必须通过 CRM selector 选择客户，而不是长期直接以 `party-service` 作为 customer entry。
- 只有可交易状态且存在 `tenantPartyId` 的 `CustomerAccount` 才能进入 Sales selector。
- selector 返回的是“可被交易链采用的客户关系对象”，不把 `CustomerAccount` owner 转移给 `sales-service`。
- 报价和订单可以引用 CRM account / contact 上下文，但 `sales-service` 不拥有这些对象的长期真相。
- `crm-service` 的 future opportunity 不是 `SalesOrder`；机会关闭或变更不会隐式改写已发布报价或已成立订单。

### 4.3 Sales 与 Party 的主体边界

- 正式报价与订单应优先引用 `customer_tenant_party_id` 这类稳定主体引用，而不是在销售域维护另一套客户主档。
- `customer_tenant_party_id` 必须来自 CRM 已确认的 `CustomerAccount.tenantPartyId`，而不是销售侧临时自建主体入口。
- `party-service` 继续拥有交易 / 法律主体真相；`sales-service` 只保存单据所需的交易快照与显示摘要。
- 客户、开票、收货、签约等主体语义若需要进一步分化，应在 `sales-service` 内以“单据引用 + 快照”表达，而不是回写 `party-service` 业务角色。

### 4.4 Sales customer snapshot 口径

- Sales truth 仍保存：
  - `customer_tenant_party_id`
  - customer snapshot
- `PublishQuote` 必须把当时 customer snapshot 复制到 `QuoteVersion`，形成正式基线。
- `ConvertQuoteVersionToOrder` 必须把 `QuoteVersion` 中已冻结的 customer snapshot 复制到 `SalesOrder`，不重新回源 CRM 或 Party。
- customer snapshot 用于审计、历史复现与交易留痕，不把 customer truth owner 从 CRM / Party 转移到 `sales-service`。

### 4.5 Customer address / contact / tax / terms snapshot 口径

- `party-service` 的主体地址 / 联系人正文边界以 [party-service.md](../services/party-service.md) 为准。
- `crm-service` owns `CustomerAddressUsage / CustomerContactUsage`，表达该地址或联系人在销售上下文中的用途、默认值、状态与备注。
- `crm-service` owns `CustomerTaxProfile`，只表达客户交易税务默认配置；发票、税额、税率、税务期间、红冲、认证与抵扣归 `finance-service`。
- `CustomerAccount.defaultCurrency / defaultPaymentTermId` 只是销售默认值。
- Sales 创建报价 / 订单时必须保存 address / contact / tax / payment term / currency snapshot；历史交易不能依赖回查当前 CRM / Party / Finance 主数据解释。

### 4.6 Sales 与 Item Master 的 Item 采用口径

- `sales-service` 最终只消费 active + sellable `Item`，不拥有 `Item` 主数据真相。
- Sales 可以从 `ItemModel + AttributeOption + optional PackagingSpec` 解析到 sellable `Item`。
- `SalesOrderLine` 必须保存稳定引用与冻结快照，phase 1 最小集合为：
  - `itemId`
  - `itemSnapshot`
  - `salesConfigSnapshot`
  - `packagingRequirementSnapshot`
  - `priceQuantityDeliverySnapshot`
  - `customerItemSnapshot`
- `itemSnapshot` 解决“当时卖的是什么”，但不把销售价格、包装要求、客户显示名反写到 `item-master-service`。
- `customerItemSnapshot` 用于出口等场景下客户自有 `SKU / 型号 / 标签显示名`，不进入 item-master。
- 一次性临时包装要求可以保留在 `packagingRequirementSnapshot`；长期包装配置应沉淀为 `PackagingSpec` 与必要的 PackagedItem。

### 4.7 Customer Item 口径

- 长期 `CustomerItemMapping` 可以作为 `Sales / CRM` 协同候选能力存在。
- phase 1 不实现完整客户产品目录，只冻结 line-level `customerItemSnapshot`。
- 明确禁止把 `CustomerItemMapping` 放进 `item-master-service`，因为它表达的是客户侧交易语义，不是全局 Item 主数据真相。

### 4.8 Quote 与 Version 口径

- `Quote` 草稿可以反复修改。
- 只有显式发布新的正式报价时才生成 `QuoteVersion`。
- 下载、导出、预览、打印都不生成新的 `QuoteVersion`。
- 正式 `QuoteVersion` 是客户确认、订单成立与审计留痕的稳定基线。

## 5. 同步 / 异步边界

- 同步：
  - `sales-service -> crm-service` 的 customer selector、account / contact 上下文读取。
  - 基于 CRM 已确认 `customer_tenant_party_id` 的受控主体摘要读取。
  - `sales-service -> item-master-service` 的 Item 配置解析、sellable 引用查询与校验。
- 异步：
  - phase 1 不强制冻结 `Sales -> CRM` 事件集。
  - 如后续需要同步报价发布、订单成立或客户产品映射更新事件，应在 `sales-service` contract 阶段单独冻结。

## 6. 真相归属

- `Quote`、`QuoteVersion`、`SalesOrder`、`SalesOrderLine`、customer commitment：`sales-service`
- `CustomerAccount`、`CustomerAddressUsage`、`CustomerContactUsage`、`CustomerTaxProfile`、`CustomerStatus`、`CustomerCategory`、tags：`crm-service`
- 交易 / 法律主体、租户主体引用、主体标识、地址 / 联系人正文：以 [party-service.md](../services/party-service.md) 为准
- `ItemModel`、`Item`、attribute、BOM、Packaging、`ItemCategory`、`SupplierItemMapping`：`item-master-service`
- 长期 `CustomerItemMapping`：future `sales-service / crm-service` 协同候选
- `PaymentTerm`、customer credit、invoice、receivable、collection、tax financial facts：`finance-service`

## 7. 明确禁止

- 不让 `sales-service` 接管 opportunity 真相或 Party 主数据真相。
- 不让 Sales 长期绕过 CRM selector 直接把 TenantParty 当成 customer entry。
- 不把 Party 主体信息复制成 CRM customer truth。
- 不让 Sales 直接把 TenantParty selector 当成 Customer selector。
- 不把 CRM/SRM 第一阶段实现阻塞在 payment account / bank account 设计上。
- 不让 `item-master-service` 承载客户自己的 SKU / 型号目录。
- 不让报价下载、预览、打印隐式生成 `QuoteVersion`。
- 不让“有报价”自动等于“有正式订单”。
- 不让 `ConvertQuoteVersionToOrder` 重新回源改写已冻结的 customer snapshot。
- 不在 phase 1 把完整客户产品目录、CLM 或 pricing engine 展开成必经依赖。

## 8. 关联文档

- [sales-service.md](../services/sales-service.md)
- [crm-service.md](../services/crm-service.md)
- [party-service.md](../services/party-service.md)
- [item-master-service.md](../services/item-master-service.md)
- [item-master-sales-mes-wms-srm.md](./item-master-sales-mes-wms-srm.md)
- [sales-service contracts](../../contracts/sales-service/README.md)
- [crm-service.md](../services/crm-service.md)
