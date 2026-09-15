# Sales 与 Finance Order-to-Cash 协同蓝图

## 1. 目标

定义 OES 中“销售交易何时进入财务闭环、财务如何拥有 AR / invoice / collection / credit / standard FX 真相、Sales 如何只消费 finance release signal 与财务摘要”的稳定协同方式。

## 2. 参与服务

- `sales-service`
- `finance-service`
- `crm-service`
- `party-service`
- `api-gateway`
- future `workflow-service`，当 finance release 需要人工审批时
- future external bank / PSP / statutory accounting systems，作为受控集成方而非 phase 1 owner

## 3. 协同分工

- `sales-service`
  - 负责 `Quote`、`SalesOrder`、commercial snapshot、customer commitment 与销售侧商业前提
- `finance-service`
  - 负责 `Receivable`、`Invoice`、`Collection`、`CollectionAllocation`、`CustomerCreditProfile`、`FinanceRelease` 与 `StandardExchangeRate`
- `crm-service`
  - 负责客户关系外壳与 customer eligibility 入口
- `party-service`
  - 负责客户主体 `tenantPartyId` 与主体引用真相
- `api-gateway`
  - 承担对外页面与工作台聚合入口
- future `workflow-service`
  - 承接超信用额度、逾期、特批放行等需要人工决策的审批流

## 4. 协同顺序

### 4.1 销售交易进入财务闭环

1. `sales-service` 通过显式成立动作创建 `SalesOrder`
2. `sales-service` owns 订单成立、commercial snapshot 与 customer commitment 真相
3. `finance-service` 基于受控交易事实接手 order-to-cash 财务闭环，不反向接管 `SalesOrder` owner
4. 财务侧如需判断是否允许继续推进，应发布独立 `FinanceRelease` 结果，而不是直接覆盖 Sales 对象

### 4.2 标准汇率与销售快照

1. Finance owns standard exchange rate truth
2. `sales-service` 在报价预览、正式发布与转订单时，只保存 exchange rate snapshot
3. `sales-service` 不自行维护标准汇率真相
4. 当汇率变动后，历史销售快照不应被回写；新交易按 Finance 当前标准汇率重新取数

### 4.3 客户信用与财务放行

1. `finance-service` 维护 `CustomerCreditProfile`、credit exposure、overdue exposure 与 available credit 摘要
2. `sales-service` 若需要“财务是否允许继续推进”的判断，应消费 `FinanceRelease` 结果或 finance summary
3. `finance-service` 可以基于信用额度、逾期、已开票未回款、预收抵扣等财务条件形成放行结论
4. `sales-service` 仍然 owns 自己的 commercial gate；Finance 只提供 finance release signal

### 4.4 发票与应收

1. `finance-service` owns `Invoice` 与 `Receivable` 真相
2. 发票开立、作废、状态流转与对应应收余额由 Finance 维护
3. `sales-service` 可以查看财务摘要，但不 owns invoice / receivable lifecycle
4. phase 1 不要求完整 statutory invoice、总账凭证或法定结账闭环

### 4.5 回款与分配

1. `finance-service` owns `Collection` 真相
2. 回款登记后，由 `finance-service` owns `CollectionAllocation` 分配到 invoice / receivable 的结果
3. Sales 不应维护“某笔回款抵了哪张发票”的真相
4. phase 1 不要求 bank reconciliation；回款与银行对账是两层不同能力

### 4.6 财务摘要回流销售

1. `finance-service` 可以向 `sales-service`、Gateway 或工作台回流财务摘要：
   - receivable balance
   - overdue summary
   - credit available
   - finance release status
2. Sales 只消费摘要，不复制 Finance 内部对象真相
3. 是否允许继续生产 / 备货 / 发货，最终仍以 Sales 自身 gate 语义表达；Finance 只是其中一个输入来源

### 4.7 Future Accounting Core 兼容

1. phase 1 经营财务对象不等于会计分录
2. future accounting core 可以把 `Receivable / Invoice / Collection / CollectionAllocation` 视为 posting source candidate
3. `ChartOfAccount / Journal / JournalEntry / JournalEntryLine / FiscalPeriod / PostingRule` 只预留边界，不在本蓝图中写成 phase 1 义务

## 5. 同步 / 异步边界

- 同步：
  - `sales-service -> finance-service` 的标准汇率读取、客户信用摘要读取、finance release 查询
  - `api-gateway -> finance-service` 的 invoice / receivable / collection / credit 查询
- 异步：
  - `sales-service -> finance-service` 的订单成立与关键商业事实通知
  - `finance-service -> sales-service` 的 finance release 结果变化通知
  - `finance-service -> downstream consumers` 的 invoice、collection、allocation、credit 状态变化通知

## 6. 真相归属

- `Quote`、`SalesOrder`、commercial snapshot、customer commitment：`sales-service`
- customer relationship shell：`crm-service`
- `tenantPartyId` 与主体主数据：`party-service`
- `Receivable`、`Invoice`、`Collection`、`CollectionAllocation`、`CustomerCreditProfile`、`FinanceRelease`、`StandardExchangeRate`：`finance-service`
- 页面消费聚合视图：`api-gateway`
- 人工审批过程：future `workflow-service`
- 法定会计 / 外部财务系统接口：future accounting core 或外部集成层

## 7. 明确禁止

- 不让 `sales-service` 拥有 `AR / invoice / collection / allocation / credit / standard FX` 真相
- 不让 `finance-service` 直接改写 `SalesOrder` 的 gate
- 不让 Sales 通过手工字段长期缓存 Finance 真相并替代受控读取
- 不让 `finance-service` 复制 CRM customer relationship 或 Party 主数据真相
- 不把 order profitability 塞进 phase 1 order-to-cash
- 不把 future accounting core 边界占位写成 phase 1 已冻结交付

## 8. 关联文档

- [sales-service.md](../services/sales-service.md)
- [finance-service.md](../services/finance-service.md)
- [sales-fulfillment-mes-wms-finance.md](./sales-fulfillment-mes-wms-finance.md)
- [sales-service contracts](../../contracts/sales-service/README.md)
- [finance-service contracts](../../contracts/finance-service/README.md)
