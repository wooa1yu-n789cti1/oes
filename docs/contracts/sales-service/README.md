# sales-service Contracts

## 1. 目的

本目录用于冻结 `sales-service` phase 1 的黑盒契约文档。

这些文档面向：

- `api-gateway` / future BFF
- `crm-service`
- `party-service`
- `item-master-service`
- future fulfillment boundary
- 后续承担 `sales-service` proto / runtime 实现的线程

这些文档不是 proto 副本，不展开数据库结构；但第 5 节拥有并冻结 trusted-gRPC cutover 所需的 RPC 分类、Permission Code、request authority 字段删除/reserve 与新增字段号，proto 实现必须逐项遵循。

本目录只回写已经冻结的 `SALES-CONTRACT-DOC` 结论。

## 2. Phase 1 Contract Surface

phase 1 只冻结四组内部 gRPC 服务面：

- [query.md](./query.md)
  - `SalesQueryService`
  - `GetQuote`
  - `SearchQuotes`
  - `GetQuoteVersion`
  - `ListQuoteVersions`
  - `GetSalesOrder`
  - `SearchSalesOrders`
- [management.md](./management.md)
  - `SalesManagementService`
  - `CreateQuote`
  - `UpdateQuoteDraft`
  - `PublishQuote`
  - `ConvertQuoteVersionToOrder`
  - `SetOrderCommercialGate`
  - `SubmitFulfillmentHandoff`
- [pricing-query.md](./pricing-query.md)
  - `PricingQueryService`
  - `SearchPriceLists`
  - `GetPriceList`
  - `GetPriceListLines`
  - `GetActiveCustomerPriceAgreement`
  - `GetCustomerPriceAgreement`
  - `ListCustomerPriceAgreementVersions`
  - `PreviewQuoteLinePricing`
- [pricing-management.md](./pricing-management.md)
  - `PricingManagementService`
  - `CreatePriceList`
  - `UpdatePriceList`
  - `ReplacePriceListLines`
  - `ChangePriceListStatus`
  - `CreateCustomerPriceAgreement`
  - `UpdateCustomerPriceAgreementDraft`
  - `PublishCustomerPriceAgreementVersion`
  - `CreateCustomerPriceAgreementFromSalesOrderLine`

phase 1 不在本目录中冻结：

- proto message 全量定义
- integration event catalog
- 外部 HTTP / BFF surface
- UI / print / export contract
- workflow、campaign engine、rebate 或 commission contract

## 3. Owner Boundary

phase 1 contract 明确围绕以下 owner 边界展开：

- `Quote`
- `QuoteVersion`
- `SalesOrder`
- `SalesOrderLine`
- `PriceList`
- `PriceListLine`
- `CustomerPriceAgreement`
- `CustomerPriceAgreementLine`
- transaction snapshot
- customer commitment
- order-level commercial gate summary
- sales-side fulfillment handoff summary

说明：

- `Quote` 草稿可反复修改；只有显式 `PublishQuote` 才生成 `QuoteVersion`
- 下载、预览、打印、导出不生成 `QuoteVersion`
- `SalesOrder` 只能通过显式 `ConvertQuoteVersionToOrder` 创建
- `SalesOrderLine` 必须保存稳定引用 + 冻结快照：
  - `itemId`
  - `itemSnapshot`
  - `salesConfigSnapshot`
  - `packagingRequirementSnapshot`
  - `priceQuantityDeliverySnapshot`
  - `customerItemSnapshot`
- `PriceList` 表达标准价、活动价、展会价，不展开 campaign engine
- `CustomerPriceAgreement` 表达客户长期价格；phase 1 不拆独立 `pricing-service`
- 同一 `customer_tenant_party_id + currency_code` 在同一租户下最多只有一个 active `CustomerPriceAgreement`
- `QuoteLine / QuoteVersionLine / SalesOrderLine` 必须冻结：
  - `priceSnapshot`
  - `moqSnapshot`
  - `exchangeRateSnapshot`
  - `exceptionPlaceholders[]`
- `customerItemSnapshot` 用于客户自有 `SKU / 型号 / 标签显示名`
- `CommercialGateSummary` 至少区分：
  - `order_established`
  - `production_gate`
  - `stocking_gate`
  - `shipping_gate`

## 4. Does Not Own

`sales-service` phase 1 contract 明确不承载以下真相：

- `crm-service` 的 `opportunity`
- `party-service` 的主体主数据与租户主体引用；具体核心对象与 owner 边界以 [party-service.md](../../architecture/services/party-service.md) 为准
- `item-master-service` 的 `Item`
- `wms-service` 的库存、占用、包装转换与仓储执行
- `mes-service` 的制造执行、WIP、工序与放行执行
- future `finance-service` 或外部财务系统的 `AR / AP / invoice / payment`
- `Contract / CLM` 生命周期

进一步约束：

- 不把 WMS / MES / Finance 真相塞进 Sales contract
- `sales-service` 只拥有商业前提与 fulfillment handoff
- physical release 与执行推进真相归 future fulfillment boundary

## 5. Trusted Execution Contract

### 5.1 Admission baseline

- 27/27 现有 RPC 均为 `BUSINESS / HUMAN / WEB`，只接受 API Gateway 当前 HUMAN 会话换取的 certificate-bound ExecutionToken。
- audience 固定为 `urn:oes:service:sales-service`；每个 RPC 使用下表的 exact canonical Code，判定规则均为 `all [Code]`。
- 服务拒绝 MACHINE、DELEGATED、SELF_SERVICE、非 WEB terminal、错误 audience、错误 `cnf`、缺失或错误 Code。
- tenant、org、operator、session、request、trace 与可信审计身份/来源来自 verified ET / trusted context。body、普通 metadata、signed operator 或 Gateway fallback 字符串没有 authority。
- management command 继续按 command 语义执行；trusted admission 不改变既有业务规则、事务、幂等、读取模型或错误语义。

### 5.2 Exact 27-RPC matrix

| RPC | Class / principal / terminal | Exact existing Code |
| --- | --- | --- |
| `GetQuote` | `BUSINESS / HUMAN / WEB` | `sales.quote.get_by_id` |
| `SearchQuotes` | `BUSINESS / HUMAN / WEB` | `sales.quote.list` |
| `GetQuoteVersion` | `BUSINESS / HUMAN / WEB` | `sales.quote.get_by_id` |
| `ListQuoteVersions` | `BUSINESS / HUMAN / WEB` | `sales.quote.get_by_id` |
| `GetSalesOrder` | `BUSINESS / HUMAN / WEB` | `sales.order.get_by_id` |
| `SearchSalesOrders` | `BUSINESS / HUMAN / WEB` | `sales.order.list` |
| `CreateQuote` | `BUSINESS / HUMAN / WEB` | `sales.quote.create` |
| `UpdateQuoteDraft` | `BUSINESS / HUMAN / WEB` | `sales.quote.update_draft` |
| `PublishQuote` | `BUSINESS / HUMAN / WEB` | `sales.quote.publish` |
| `ConvertQuoteVersionToOrder` | `BUSINESS / HUMAN / WEB` | `sales.quote.convert_to_order` |
| `SetOrderCommercialGate` | `BUSINESS / HUMAN / WEB` | `sales.order.set_commercial_gate` |
| `SubmitFulfillmentHandoff` | `BUSINESS / HUMAN / WEB` | `sales.order.submit_fulfillment_handoff` |
| `SearchPriceLists` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.read` |
| `GetPriceList` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.read` |
| `GetPriceListLines` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.read` |
| `GetActiveCustomerPriceAgreement` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.read` |
| `GetCustomerPriceAgreement` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.read` |
| `ListCustomerPriceAgreementVersions` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.read` |
| `PreviewQuoteLinePricing` | `BUSINESS / HUMAN / WEB` | `sales.pricing.preview_quote_line` |
| `CreatePriceList` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.manage` |
| `UpdatePriceList` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.manage` |
| `ReplacePriceListLines` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.manage` |
| `ChangePriceListStatus` | `BUSINESS / HUMAN / WEB` | `sales.pricing.price_list.manage` |
| `CreateCustomerPriceAgreement` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.manage` |
| `UpdateCustomerPriceAgreementDraft` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.manage` |
| `PublishCustomerPriceAgreementVersion` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.manage` |
| `CreateCustomerPriceAgreementFromSalesOrderLine` | `BUSINESS / HUMAN / WEB` | `sales.pricing.customer_agreement.manage` |

上述 15 个 Code 已由 canonical Permission catalog/generator 拥有；本次不新增或修改 Code。

### 5.3 Exact request compatibility disposition

每个 27 request 都删除并 reserve `tenant_id=1`、`operator_context=2`、`trace_context=3` 的字段号与字段名。14 个 management request 还删除并 reserve `audit_context=4`。共享兼容 tombstone 同时固定 `OperatorContext.operator_id=1/operator_type=2/org_id=3`、`TraceContext.trace_id=1/request_id=2`、`AuditContext.audit_id=1/reason=2/source=3`，不得复用这些名称或编号恢复 body authority。Response/projection 中 Sales 自己写出的 `tenant_id` 与所有普通业务字段保持不变。

`audit_context.reason` 中原本可由用户填写的说明不属于身份 authority。它从 tombstone 中拆出为 optional `string reason`，去除首尾空白后为 `1..256` 个 UTF-8 字符；空白等同未提供，不得放入 Token、credential、个人敏感信息或任意 JSON。它只补充业务审计说明，不能覆盖 trusted principal、tenant、org、trace、audit id 或 source。精确新字段号如下：

| Request | New `reason` field |
| --- | --- |
| `CreateQuoteRequest` | `reason=8` |
| `UpdateQuoteDraftRequest` | `reason=7` |
| `PublishQuoteRequest` | `reason=6` |
| `ConvertQuoteVersionToOrderRequest` | `reason=6` |
| `SetOrderCommercialGateRequest` | `reason=8` |
| `SubmitFulfillmentHandoffRequest` | `reason=6` |
| `CreatePriceListRequest` | `reason=11` |
| `UpdatePriceListRequest` | `reason=9` |
| `ReplacePriceListLinesRequest` | `reason=7` |
| `ChangePriceListStatusRequest` | `reason=7` |
| `CreateCustomerPriceAgreementRequest` | `reason=8` |
| `UpdateCustomerPriceAgreementDraftRequest` | `reason=7` |
| `PublishCustomerPriceAgreementVersionRequest` | `reason=6` |
| `CreateCustomerPriceAgreementFromSalesOrderLineRequest` | `reason=6` |

### 5.4 Caller and future-internal boundary

当前唯一生产 direct caller 是 Gateway Sales BFF，没有 pure MACHINE root。`scripts/sales-smoke.mjs` 是直接伪造 tenant/operator/trace 的历史测试脚本，迁移时删除，并同步移除 package `smoke` command；它不升级为生产 caller 或 MACHINE credential owner。

未来 Sales→Finance/WMS/MES/fulfillment 等自动协作需要保留为待设计登记：对同步且确有最小事实读取需求的场景新增窄范围 INTERNAL RPC；对订单成立、handoff 等跨域事实传播优先单独冻结事件。该登记不构成当前 contract，不新增业务能力、Code、RPC 或事件，也不得把上述 27 个 HUMAN RPC 改成双模式。现有 outbound caller、collaboration 和 event/outbox 路径均不在本次 cutover 范围。

## 6. Deferred

以下能力明确 deferred，不得写成 phase 1 已承诺 contract：

- 完整 pricing engine
- special price stacking / campaign engine
- low-price / low-MOQ workflow
- rebate / commission
- CustomerPriceAgreement 完整合同生命周期
- packaging master
- `CustomerItemMapping` 完整目录
- `Contract / CLM`
- fulfillment boundary contract
- finance integration
- one quote version -> split / partial order
- integration events

## 7. Deferred Candidate Events

phase 1 只允许把下列事件列为候选，不得视为已冻结 event catalog：

- `QuotePublished`
- `SalesOrderEstablished`
- `SalesOrderCommercialGateUpdated`
- `SalesOrderFulfillmentHandoffSubmitted`

## 8. 关联真相源

本目录以上游稳定文档为准：

- [sales-service.md](../../architecture/services/sales-service.md)
- [sales-crm-party-item-master.md](../../architecture/collaborations/sales-crm-party-item-master.md)
- [sales-fulfillment-mes-wms-finance.md](../../architecture/collaborations/sales-fulfillment-mes-wms-finance.md)
