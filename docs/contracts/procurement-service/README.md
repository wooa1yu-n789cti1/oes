# procurement-service Contracts

> Procurement contract 只描述采购黑盒接口；涉及权限、scope、policy、checkPermission、checkResource 或 buildQueryScope 的服务设计边界，以 [permission-service.md](../../architecture/services/permission-service.md) 和项目级授权架构为准。

## 1. 目的

本目录用于冻结 `procurement-service` phase 1 的 `PR + PO` 最小闭环黑盒契约文档。

这些文档面向：

- `api-gateway` / future procurement BFF
- `sales-service`
- future production / maintenance 需求入口
- `wms-service`
- `finance-service`
- 后续承担 `procurement-service` proto / runtime 实现的线程

这些文档不是 proto 副本，不展开数据库结构，不承诺运行时实现细节。

本目录只回写已经冻结的 `PROCUREMENT-CONTRACT` 结论。

## 2. Phase 1 Contract Surface

phase 1 只冻结以下内部 gRPC contract 面：

- [purchase-request-query.md](./purchase-request-query.md)
  - `PurchaseRequestQueryService`
  - `GetPurchaseRequest`
  - `SearchPurchaseRequests`
- [purchase-request-management.md](./purchase-request-management.md)
  - `PurchaseRequestManagementService`
  - `CreatePurchaseRequest`
  - `UpdatePurchaseRequestDraft`
  - `SubmitPurchaseRequest`
  - `DecidePurchaseRequest`
  - `CancelPurchaseRequest`
  - `ConvertPurchaseRequestToPurchaseOrder`
- [purchase-order-query.md](./purchase-order-query.md)
  - `PurchaseOrderQueryService`
  - `GetPurchaseOrder`
  - `SearchPurchaseOrders`
  - `ListPurchaseOrderChanges`
- [purchase-order-management.md](./purchase-order-management.md)
  - `PurchaseOrderManagementService`
  - `CreatePurchaseOrderDraft`
  - `UpdatePurchaseOrderDraft`
  - `IssuePurchaseOrder`
  - `ConfirmSupplierAcknowledgement`
  - `ApplyPurchaseOrderChange`
  - `CancelPurchaseOrder`
- [receiving-expectation.md](./receiving-expectation.md)
  - `ReceivingExpectationQueryService`
  - `GetReceivingExpectation`
  - `SearchReceivingExpectations`
  - `ReceivingExpectationManagementService`
  - `CreateReceivingExpectation`
  - `RecordReceivingDiscrepancyResolution`
- [internal-query.md](./internal-query.md)
  - `ProcurementInternalQueryService`
  - `ResolveReceivingExpectationForReceipt`

phase 1 不在本目录中冻结：

- proto message 全量定义
- 外部 HTTP / BFF surface
- UI / selector 组件 contract
- integration event catalog
- `RFQ`
- `SupplierQuote`
- 安全库存
- 自动补货
- `AP / supplier invoice / payment`
- 完整 workflow
- `Non-PO purchase` 正常化路径

## 3. Owner Boundary

phase 1 contract 明确围绕以下 owner 边界展开：

- `PurchaseRequest`
- `PurchaseRequestLine`
- `PurchaseRequestApprovalSnapshot`
- `PurchaseOrder`
- `PurchaseOrderLine`
- `PurchaseOrderLineAllocation`
- `PurchaseOrderChange`
- `ReceivingExpectation`
- `ReceivingDiscrepancy`

补充冻结规则：

- `PurchaseRequest` 是采购需求，不是采购承诺。
- `PurchaseOrder` 是正式采购承诺。
- `PR` 合并生成 `PO` 时：
  - 不创建新的 `PR`
  - 不删除旧的 `PR / PR line`
  - 源 `PR` 保留并进入 `PARTIALLY_CONVERTED / CONVERTED`
- `PurchaseRequestLine` 必须支持：
  - 标准 `Item`
  - 非标准 / 文本型采购需求
- `PurchaseRequest` 统一覆盖：
  - 部门日常采购
  - 销售专采
  - 生产 / 包装需求
  - 维修需求
  - 样品采购
- 采购类支出在 phase 1 的正常路径必须先 `PR / PO`；`Non-PO purchase` 不是正常主线。
- 标准 `Item` 转 `PO` 时必须校验目标供应商存在 `ACTIVE SupplierOffering`。
- 日常非标准采购可不强制依赖 `ACTIVE SupplierOffering`，但 `PO` 必须保留 supplier snapshot。
- `PurchaseOrderLineAllocation` 必须支持同一行同时表达：
  - source = `PURCHASE_REQUEST_LINE`
  - source = `SALES_ORDER_LINE`
  - source = `FULFILLMENT_DEMAND`
  - general stock
- `PurchaseOrderLineAllocation` 必须允许携带目标仓 / 收货地址，用于后续 `ReceivingExpectation` grouping。
- `PO line quantity` 可以大于源 `PR demand quantity`，但超出部分必须标记为 `general stock`，并记录 reason。
- `PurchaseOrder` header 可保存 `payment_terms_snapshot` 与 supplier commercial terms snapshot，但它们只是本次采购快照，不反向成为 `SRM` 长期商业主档。
- `PurchaseOrder` query 可展示来自 `finance-service` 的 payment summary 与 attachment refs；Procurement 只消费摘要和引用，不拥有付款真相或付款凭证文件。
- `ReceivingExpectation` 是采购侧预期收货，不是 `WMS receipt` truth。
- 当同一 `PO line` 的 allocation 指向不同目标仓 / 收货地址 / allocation grouping 时，必须拆分成多个 `ReceivingExpectation`。
- `WMS receipt` 才是实际收货真相。
- `ReceivingDiscrepancy` 是采购侧差异摘要与处理入口，不是库存调整真相。
- `ReceivingDiscrepancy resolution` 只记录采购侧处置选择与引用，不直接修改库存真相。
- 关闭剩余未收数量必须通过 `PurchaseOrderChange` 留痕，而不是在 discrepancy resolution 中隐式完成。
- phase 1 的 return / claim 只保留 resolution 类型与引用，不实现完整 `SupplierReturn / claim workflow`。
- `PurchaseOrderChange` 在 phase 1 只要求轻量 `APPLIED` 变更记录。
- 历史采购价格第一阶段归 Procurement 交易事实 owner。

## 4. Does Not Own

`procurement-service` phase 1 contract 明确不承载以下真相：

- `srm-service` 的 `SupplierProfile / SupplierOffering`
- `item-master-service` 的 `Item / ItemCapability / SupplierItemMapping`
- `wms-service` 的实际收货、库位、库存、破损 / 受限库存
- `finance-service` 的 `AP / supplier invoice / payment / payment allocation`
- `party-service` 的主体主数据
- `RFQ`
- `SupplierQuote`
- 安全库存
- 自动补货
- 完整 `workflow-service`
- `costing-service`

进一步约束：

- 不把采购商业条款塞进 `SRM`
- 不把库存真相塞进 Procurement
- 不把付款真相塞进 Procurement
- 不把 `SupplierOffering` 扩成价格 / `MOQ` / lead time 对象
- 不把 `Non-PO purchase` 设计成正常路径

## 5. Security / Context Baseline

21 个现有 phase 1 RPC 统一遵循以下基线：

- 全部为内部 gRPC 契约，不直接对外部客户端开放
- 分类固定为 `BUSINESS / HUMAN / WEB`
- audience 固定为 `urn:oes:service:procurement-service`
- Gateway 是唯一 production caller；每个 RPC 要求其现有 canonical Code 与 mTLS/`cnf` binding
- tenant、org、operator、trace、audit 只从 verified ET/transport context 派生；request 不携带 authority context
- request 原 `tenant_id / org_id / operator_context / trace_context / audit_context` 删除并 reserve 原编号和名称；response 中 Procurement-owned projections 保留
- MACHINE、DELEGATED、SELF_SERVICE、non-WEB 与 legacy body/ordinary-metadata fallback 全部拒绝

补充说明：

- WMS 使用 [internal-query.md](./internal-query.md) 的窄 `INTERNAL / HUMAN_OBO` RPC，不复用 Gateway BUSINESS query
- Procurement→Item Master 与 Procurement→SRM 使用当前 verified HUMAN subject 换取下一跳 audience ET；Permission 只授权 actor workload，不拥有 subject tenant authority
- management success audit 与 mutation 保持同一事务；本轮不新增幂等键或自动重试
- phase 1 只冻结同步 `gRPC` 校验边界，不冻结完整 integration event catalog
- 未来事件只能作为 deferred candidate 列出，不能在本目录内伪装成已承诺 payload

## 6. 同步 / 异步边界

phase 1 固定采用以下协同规则：

- 写入前强校验走 `gRPC`
- 本地事务成功后才允许 future event 扩散
- 不允许依赖 `Event` 完成本地事务

当前明确需要同步 `gRPC` 的校验只有：

- `procurement-service -> srm-service`
  - 校验目标 `SupplierProfile` 当前是否为 `ACTIVE`
  - 校验标准 `Item` 对应供应商是否存在 `ACTIVE SupplierOffering`
- `procurement-service -> item-master-service`
  - 校验标准 `Item` 是否存在
  - 校验标准 `Item` 是否具备 `purchasable` 能力
- `procurement-service -> permission-service`
  - 校验当前操作是否被授权
- `wms-service -> procurement-service`
  - 只通过 `ResolveReceivingExpectationForReceipt` 校验显式引用的 expectation 当前 tenant 可见性
  - caller 随 WMS trusted inbound cutover 激活，只接受 guard-verified HUMAN proof 与 exact WMS SYSTEM actor

future event 只保留为 deferred candidate，例如：

- `PurchaseRequestSubmitted`
- `PurchaseRequestDecided`
- `PurchaseOrderIssued`
- `PurchaseOrderChanged`
- `ReceivingExpectationCreated`
- `ReceivingDiscrepancyResolved`

说明：

- 本目录不冻结事件目录、命名全集、payload 字段或 outbox 实现
- `wms-service -> procurement-service` 的实际收货回流属于 future async collaboration，不在本目录中展开为事件 contract

## 7. Transaction Facts Boundary

phase 1 只冻结以下事实 owner 归 Procurement：

- 已提交 / 已决策 `PurchaseRequest` 事实
- 已发出 `PurchaseOrder` 与 `PurchaseOrderChange` 事实
- `ReceivingExpectation / ReceivingDiscrepancy` 采购侧摘要事实
- 历史采购价格与采购交易事实

说明：

- phase 1 不单独建立 `purchase-price-history` RPC
- 历史价格事实来源于 `PO line` 交易快照与后续已应用变更
- `PO` 级 payment summary 只消费 `finance-service` 已发布的付款摘要与 `asset-service attachmentRef` 引用，不改变付款真相 owner
- future `Finance / BI / Costing` 只消费分析，不拥有原始采购交易事实

## 8. Deferred

以下能力明确 deferred，不得写成 phase 1 已承诺 contract：

- `RFQ`
- `SupplierQuote`
- 安全库存
- 自动补货
- `Non-PO purchase` 正常化路径
- 供应商价格主档、`MOQ`、账期、lead time
- 完整采购审批 workflow
- 完整采购变更申请 / 审批 / 供应商确认闭环
- `AP / supplier invoice / payment / payment allocation`
- 完整付款凭证管理；phase 1 只展示 Finance 提供的摘要与引用
- 完整 `SupplierReturn / claim workflow`
- 完整事件目录与 payload
- `costing-service`

## 9. 关联真相源

本目录以上游稳定文档为准：

- [procurement-service.md](../../architecture/services/procurement-service.md)
- [procurement-srm-item-wms-finance.md](../../architecture/collaborations/procurement-srm-item-wms-finance.md)
- [srm-service.md](../../architecture/services/srm-service.md)
- [item-master-service.md](../../architecture/services/item-master-service.md)
- [wms-service.md](../../architecture/services/wms-service.md)
- [finance-service.md](../../architecture/services/finance-service.md)
- [service-collaboration-rules.md](../../architecture/system/service-collaboration-rules.md)
