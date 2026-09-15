# finance-service Contracts

> Finance contract 只描述财务黑盒接口；涉及权限、scope、policy、checkPermission、checkResource 或 buildQueryScope 的服务设计边界，以 [permission-service.md](../../architecture/services/permission-service.md) 和项目级授权架构为准。

## 1. 目的

本目录用于冻结 `finance-service` phase 1 / phase 1B 经营财务闭环的黑盒契约文档。

这些文档面向：

- `api-gateway` / future finance BFF
- `sales-service`
- `procurement-service`
- future fulfillment boundary
- 后续承担 `finance-service` proto / runtime 实现的线程

这些文档不是 proto 副本，不展开数据库结构，不承诺运行时实现细节。

本目录只回写已经冻结的 `FINANCE-CONTRACT` 结论。

## 2. Phase 1 / Phase 1B Contract Surface

phase 1 / phase 1B 只冻结以下内部 `gRPC` contract 面：

- [account-query.md](./account-query.md)
  - `FinancialAccountQueryService`
  - `GetFinancialAccount`
  - `SearchFinancialAccounts`
  - `SearchAccountTransactions`
  - `GetExchangeRate`
- [account-management.md](./account-management.md)
  - `FinancialAccountManagementService`
  - `CreateFinancialAccount`
  - `UpdateFinancialAccountBasics`
  - `ImportAccountTransactions`
  - `RecordAccountTransaction`
  - `RegisterCustomerFinancialAccount`
  - `RegisterSupplierFinancialAccount`
  - `SetExchangeRate`
- [receivable-query.md](./receivable-query.md)
  - `ReceivableQueryService`
  - `GetReceivableSchedule`
  - `SearchReceivableSchedules`
  - `GetFinanceReleaseSignal`
- [receivable-management.md](./receivable-management.md)
  - `ReceivableManagementService`
  - `CreateReceivableScheduleFromSalesOrder`
  - `SetFinanceReleaseSignal`
- [payable-query.md](./payable-query.md)
  - `PaymentQueryService`
  - `GetPayableSchedule`
  - `SearchPayableSchedules`
  - `SearchPaymentRequests`
  - `SearchPaymentExecutions`
  - `SearchPaymentAllocations`
- [payable-management.md](./payable-management.md)
  - `PaymentManagementService`
  - `CreatePayableScheduleFromPurchaseOrder`
  - `ApplyPayableScheduleAdjustmentFromPurchaseOrderChange`
- [payment-management.md](./payment-management.md)
  - `PaymentManagementService`
  - `CreatePaymentRequest`
  - `DecidePaymentRequest`
  - `ExecutePaymentRequest`
  - `AllocatePaymentToPayable`
  - `AllocatePaymentToReceivable`
- [finance-integration.md](./finance-integration.md)
  - Sales / Procurement 与 Finance 的 integration input/output 语义

phase 1 / phase 1B 不在本目录中冻结：

- proto message 全量定义
- 外部 HTTP / BFF surface
- UI / workspace / selector contract
- integration event catalog、broker、outbox 或 payload 全量字段
- 完整 double-entry accounting
- `ChartOfAccount / Journal / JournalEntry / JournalEntryLine`
- `GL / voucher / statutory reporting / closing`
- 完整 `SupplierInvoice` lifecycle
- `SupplierStatement` reconciliation lifecycle
- bank API
- 自动银行对账
- 完整 `ExpenseClaim` workflow
- credit / refund / offset formal lifecycle
- order profitability
- tax engine
- treasury / cash forecast
- `costing-service`

## 3. Phase 1B Payable / Payment Boundary

phase 1B 在 Finance 内部只冻结最小 AP-compatible 边界：

- `PayableSchedule` 是应付计划真相
- `PaymentRequest` 是申请付款 / 付款治理入口
- `PaymentExecution` 是财务实际付款动作
- `AccountTransaction` 是真实资金流水
- `PaymentAllocation` 是真实流水核销结果
- supplier bill / invoice / statement 在 phase 1B 只作为 `PaymentRequest` evidence snapshot
- `PurchaseOrderChange` 只能追加、取消或 supersede 未执行 schedule line，并保留稳定 `source_ref`
- Procurement 只消费 Finance payment summary / `attachmentRef`，不拥有付款真相
- Finance 不直接改 `PO` 状态，Procurement 不直接写付款状态

## 4. Owner Boundary

phase 1 contract 明确围绕以下 owner 边界展开：

- `FinancialAccount`
- `AccountTransaction`
- `CustomerFinancialAccount`
- `SupplierFinancialAccount`
- `ReceivableSchedule`
- `ReceivableScheduleLine`
- `PayableSchedule`
- `PayableScheduleLine`
- `PaymentRequest`
- `PaymentRequestLine`
- `PaymentExecution`
- `PaymentAllocation`
- `SupplierBillEvidenceSnapshot`
- `FinanceReleaseSignal`
- `ExchangeRate`

补充冻结规则：

- `FinancialAccount` 表达公司资金账户，包括银行、现金、微信、支付宝、`PayPal / Stripe` 等受控资金账户。
- `AccountTransaction` 表达账户实际流水，可来自手工录入、`CSV` 导入或 future API；它是资金真实出入账，不是总账分录。
- `CustomerFinancialAccount` 表达客户付款账号，不是 `CustomerAccount`、不是 CRM 客户关系外壳。
- `SupplierFinancialAccount` 表达供应商收款账号，不是 `SupplierProfile`。
- `ReceivableSchedule` 表达客户应付款计划，不表达实际回款。
- `PayableSchedule` 表达公司应付款计划，不表达实际付款。
- `PaymentRequest` 表达付款申请，不等于银行已经扣款，也不等于 payable truth。
- `PaymentExecution` 表达财务执行付款动作的记录，不自动等价于银行回单已完成对账。
- `AccountTransaction` 才是最终账户真实出入账。
- `PaymentAllocation` 表达真实流水核销到应收 / 应付计划的结果。
- `SupplierBillEvidenceSnapshot` 只表达付款申请证据快照，不升级为正式 AP lifecycle 对象。
- `FinanceReleaseSignal` 是 Finance 对外发布的财务放行结果，不转移 `SalesOrder` gate owner。
- `ExchangeRate` 是 Finance 拥有的标准汇率真相；Sales 只保存自己的 exchange rate snapshot。
- 采购类支出在 phase 1 正常路径必须关联 `PR / PO`；`Non-PO purchase` 不是正常主线。
- 员工垫付属于 future `ExpenseClaim`；phase 1 只保留边界，不冻结完整 workflow。
- phase 2 预留 double-entry accounting core，但 phase 1 不冻结 `JournalEntry` contract。

## 5. Does Not Own

`finance-service` phase 1 contract 明确不承载以下真相：

- `sales-service` 的 `Quote / SalesOrder / commercial snapshot`
- `sales-service` 的 customer commitment 与 commercial gate owner truth
- `procurement-service` 的 `PurchaseOrder / procurement transaction facts`
- `crm-service` 的客户关系外壳
- `srm-service` 的供应商主档
- `party-service` 的主体主数据
- 完整 double-entry accounting core
- `ChartOfAccount / Journal / JournalEntry / JournalEntryLine`
- `GL / voucher / statutory reporting / closing`
- full `SupplierInvoice` lifecycle
- `SupplierStatement` reconciliation
- full `AP matching`
- bank API
- automatic bank reconciliation
- full `ExpenseClaim` workflow
- credit / refund / offset formal lifecycle
- order profitability
- tax engine
- treasury / cash forecast
- `costing-service`

进一步约束：

- Finance 不直接改写 `SalesOrder` gate，只提供 `FinanceReleaseSignal`。
- Sales 仍然 owns `SalesOrderEstablished` 与 sales commercial snapshot。
- Procurement 仍然 owns `PurchaseOrderIssued` 与采购交易事实。
- `PayableSchedule / PaymentRequest / PaymentExecution / PaymentAllocation` 在 phase 1B 只冻结最小付款闭环，不等于完整 AP 生命周期。

## 6. Security / Context Baseline

本次 trusted gRPC cutover 只迁移当前 proto 的 27 个 RPC，不新增 Finance RPC、Permission Code、业务对象或跨服务能力。27 个 RPC 全部固定为 `BUSINESS / HUMAN / WEB`，audience 固定为 `urn:oes:service:finance-service`，Code 规则统一为 `all [exactCode]`：

| RPC | Exact existing Code |
| --- | --- |
| `GetFinancialAccount` | `finance.financial_account.get_by_id` |
| `SearchFinancialAccounts` | `finance.financial_account.list` |
| `SearchAccountTransactions` | `finance.account_transaction.list` |
| `GetExchangeRate` | `finance.exchange_rate.get` |
| `CreateFinancialAccount` | `finance.financial_account.create` |
| `UpdateFinancialAccountBasics` | `finance.financial_account.update_basics` |
| `ImportAccountTransactions` | `finance.account_transaction.import` |
| `RecordAccountTransaction` | `finance.account_transaction.record` |
| `RegisterCustomerFinancialAccount` | `finance.customer_financial_account.register` |
| `SetExchangeRate` | `finance.exchange_rate.set` |
| `GetReceivableSchedule` | `finance.receivable_schedule.get_by_id` |
| `SearchReceivableSchedules` | `finance.receivable_schedule.list` |
| `GetFinanceReleaseSignal` | `finance.finance_release_signal.get` |
| `CreateReceivableScheduleFromSalesOrder` | `finance.receivable_schedule.create_from_sales_order` |
| `SetFinanceReleaseSignal` | `finance.finance_release_signal.set` |
| `GetPayableSchedule` | `finance.payable.read` |
| `SearchPayableSchedules` | `finance.payable.read` |
| `SearchPaymentRequests` | `finance.payable.read` |
| `SearchPaymentExecutions` | `finance.payable.read` |
| `SearchPaymentAllocations` | `finance.payment_allocation.list` |
| `CreatePayableScheduleFromPurchaseOrder` | `finance.payable.create_from_purchase_order` |
| `ApplyPayableScheduleAdjustmentFromPurchaseOrderChange` | `finance.payable.adjust_from_purchase_order_change` |
| `CreatePaymentRequest` | `finance.payment_request.create` |
| `DecidePaymentRequest` | `finance.payment_request.decide` |
| `ExecutePaymentRequest` | `finance.payment_execution.create` |
| `AllocatePaymentToPayable` | `finance.payment_allocation.create` |
| `AllocatePaymentToReceivable` | `finance.payment_allocation.allocate_to_receivable` |

Finance 必须在 controller 业务数据前本地验证签名、时效、`aud`、mTLS workload/`cnf`、trusted tenant、HUMAN Principal、`session_terminal=WEB` 与 exact Code。所有 27 个 RPC 拒绝 MACHINE、DELEGATED、SELF_SERVICE、非 WEB、错误 audience/`cnf`/Code；Gateway edge permission 不能替代 Finance 服务端声明和验证，也不存在 body/header/signed-operator fallback。

### 6.1 Request authority field disposition

当前 102 个 legacy authority declaration 由 96 个 request authority 字段和 6 个 service-owned response/projection `tenant_id` 组成：

- 12 个 query request 删除并保留 `tenant_id=1`、`operator_context=2`、`trace_context=3`：`GetFinancialAccount`、`SearchFinancialAccounts`、`SearchAccountTransactions`、`GetExchangeRate`、`GetReceivableSchedule`、`SearchReceivableSchedules`、`GetFinanceReleaseSignal`、`GetPayableSchedule`、`SearchPayableSchedules`、`SearchPaymentRequests`、`SearchPaymentExecutions`、`SearchPaymentAllocations`。
- 15 个 management request 删除并保留 `tenant_id=1`、`operator_context=2`、`trace_context=3`、`audit_context=4`：`CreateFinancialAccount`、`UpdateFinancialAccountBasics`、`ImportAccountTransactions`、`RecordAccountTransaction`、`RegisterCustomerFinancialAccount`、`SetExchangeRate`、`CreateReceivableScheduleFromSalesOrder`、`SetFinanceReleaseSignal`、`CreatePayableScheduleFromPurchaseOrder`、`ApplyPayableScheduleAdjustmentFromPurchaseOrderChange`、`CreatePaymentRequest`、`DecidePaymentRequest`、`ExecutePaymentRequest`、`AllocatePaymentToPayable`、`AllocatePaymentToReceivable`。
- 六个 search request 另删除并保留 `org_id=4`：`SearchFinancialAccounts`、`SearchAccountTransactions`、`SearchReceivableSchedules`、`SearchPayableSchedules`、`SearchPaymentRequests`、`SearchPaymentExecutions`。
- 五个 create/integration request 另删除并保留 `org_id=5`：`CreateFinancialAccount`、`CreateReceivableScheduleFromSalesOrder`、`CreatePayableScheduleFromPurchaseOrder`、`ApplyPayableScheduleAdjustmentFromPurchaseOrderChange`、`CreatePaymentRequest`。
- `ImportAccountTransactionsRequest.imported_by=9` 与 `SetExchangeRateRequest.set_by=9` 也是 legacy caller identity duplicate，删除并保留；真实 operator 由 trusted context 派生。
- `OperatorContext` 作为 compatibility tombstone 保留号码 `operator_id=1`、`operator_type=2`、`org_id=3`；`TraceContext` 保留 `trace_id=1`、`request_id=2`；`AuditContext` 保留 `audit_id=1`、`reason=2`、`source=3`。这些号码不得复用为新 authority。
- `FinancialAccount.tenant_id=3`、`ExchangeRate.tenant_id=2`、`ReceivableSchedule.tenant_id=3`、`FinanceReleaseSignal.tenant_id=2`、`PayableSchedule.tenant_id=3`、`PaymentRequest.tenant_id=3` 是 Finance-owned projection，继续保留；它们不是 caller authority。

删除 request `org_id` 不删除已有 Finance 对象的组织归属。当前 operator 的可信组织作用域由 ET 建立，Finance 继续按既有数据语义应用该作用域；本轮不得新增跨组织查询或代操作能力。所有其他字段保持原 field number 和现有业务语义。

### 6.2 Audit and migration scope

- management audit 的 tenant、operator、trace、request 与 source 来自 trusted context；调用者提供的业务理由只能作为非权威补充，不能覆盖可信身份。
- management command 继续按 command 语义处理，现有审计、幂等、事务和错误规则不变。
- `RegisterSupplierFinancialAccount` 未出现在当前 proto 27-RPC surface，本次不实现、不迁移也不据此扩展 proto。
- Sales synchronous FX/credit/release、`SalesOrderEstablished` receivable、`PurchaseOrderIssued/Changed` payable 等协同不属于本次 cutover；不新增 INTERNAL RPC、Code、event contract、consumer、outbox 或 inbox。

## 7. 同步 / 异步边界

phase 1 固定采用以下协同规则：

- 写入前强校验走 `gRPC`
- 本地事务成功后才允许 future event 扩散
- 不允许依赖 `Event` 完成本地事务

当前明确需要同步 `gRPC` 的校验包括：

- `finance-service -> permission-service`
  - 校验当前 operator 是否有账户维护、回款登记、付款审批、付款执行、汇率维护、放行设置权限
- `finance-service -> sales-service`
  - 读取已成立 `SalesOrder` 的受控商业摘要
  - 读取 Sales 保存的 exchange rate snapshot 仅作对账参考，不反转 `ExchangeRate` owner
- `finance-service -> procurement-service`
  - 读取已发出 `PurchaseOrder` 的受控采购摘要
- `finance-service -> party-service / crm-service / srm-service`
  - 读取主体存在性或显示名摘要时的受控 owner truth

future async collaboration 只保留为 contract 语义，不在本目录中冻结 event catalog，例如：

- `SalesOrderEstablished` 进入 Finance 应收上下文
- `PurchaseOrderIssued` 进入 Finance 应付上下文
- `PurchaseOrderChanged` 进入 Finance 应付计划调整上下文
- `PaymentAllocated / ReceivablePaid` 摘要回流 Sales / Fulfillment
- `PaymentRequestApproved / PaymentExecuted / PayablePaid` 摘要回流 Procurement

说明：

- 本目录只冻结 integration input/output 语义，不冻结 broker、topic、outbox 或 payload 全量字段
- `FinanceReleaseSignal` 在 phase 1 以同步读取与受控写入为主；是否追加异步广播属于 future integration catalog

## 8. Accounting Compatibility Boundary

phase 1 对象必须被视为 future accounting core 的 posting source candidate，而不是提前伪装成会计分录：

- `AccountTransaction`
- `ReceivableSchedule`
- `PayableSchedule`
- `PaymentRequest`
- `PaymentExecution`
- `PaymentAllocation`
- `ExchangeRate`

说明：

- 这些对象表达经营财务事实，不表达 `JournalEntry`
- realization 线程可以为 future posting source 预留引用位，但不得在 phase 1 contract 中偷带 `double-entry` 语义

## 9. Deferred

以下能力明确 deferred，不得写成 phase 1 已承诺 contract：

- full double-entry accounting
- `ChartOfAccount / Journal / JournalEntry / JournalEntryLine` implementation
- `GL / voucher / statutory reporting / closing`
- full `SupplierInvoice` lifecycle
- `SupplierStatement` reconciliation
- full `AP matching`
- bank API
- automatic bank reconciliation
- full `ExpenseClaim` workflow
- credit / refund / offset formal lifecycle
- order profitability
- tax engine
- treasury / cash forecast
- `costing-service`

## 10. 关联真相源

本目录以上游稳定文档为准：

- [finance-service.md](../../architecture/services/finance-service.md)
- [sales-finance-order-to-cash.md](../../architecture/collaborations/sales-finance-order-to-cash.md)
- [sales-service.md](../../architecture/services/sales-service.md)
- [procurement-service.md](../../architecture/services/procurement-service.md)
- [service-collaboration-rules.md](../../architecture/system/service-collaboration-rules.md)
