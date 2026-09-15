# Sales、Fulfillment、MES、WMS 与 Finance 协同蓝图

## 1. 目标

定义 OES 中“销售订单如何在商业前提满足后交给 fulfillment boundary，制造与仓储如何继续执行，财务如何只接收交易事实而不被销售域吞并”的长期协同方式。

## 2. 参与服务

- `sales-service`
- fulfillment boundary
- `mes-service`
- `wms-service`
- `finance-service`
- `api-gateway`
- future `workflow-service`，当需要紧急订单人工审批时

## 3. 协同分工

- `sales-service`
  - 负责 `SalesOrder`、customer commitment、商业前提节点与 handoff 事实
- fulfillment boundary
  - 负责 physical release、执行推进编排与跨执行域协同
- `mes-service`
  - 负责制造对象、放行条件、后处理工序执行与结果真相
- `wms-service`
  - 负责正式仓储责任、库存位置 / 数量 / 状态、占用真相、包装与仓储侧送返控制
- `finance-service`
  - 负责 `AR / invoice / collection / payment / credit / finance release / standard FX` 真相
  - future accounting core 或外部法定财务系统在后续阶段承接完整会计核算
- `api-gateway`
  - 承担外部 HTTP / BFF 聚合入口
- future `workflow-service`
  - 承接紧急重分配等需要人工审批的工作流

## 4. 协同顺序

### 4.1 订单成立与 handoff

1. `sales-service` 只能通过显式成立动作创建 `SalesOrder`
2. 订单成立不等于允许生产、允许备货或允许发货
3. `sales-service` 分别维护：
   - 订单成立
   - 允许生产
   - 允许备货
   - 允许发货
4. fulfillment boundary 只在相关商业前提满足后接手推进执行

### 4.2 允许生产与制造协同

1. `sales-service` 在商业层形成 customer commitment
2. 当“允许生产”成立后，fulfillment boundary 才能把执行需求交给 planning / `mes-service`
3. `mes-service` 负责制造执行、WIP、后处理与制造放行真相
4. `sales-service` 不直接拥有生产执行进度，只消费必要的业务结果摘要

### 4.3 放行后交仓

1. `mes-service` 完成烧成后对象的质检 / 确认与放行判断
2. 只有满足交仓条件后，`mes-service` 才发布“可交仓 / 已交仓”事实
3. `wms-service` 基于该事实创建自己的仓储对象并接手正式库存责任
4. `mes-service` 保留制造追溯真相，但不继续拥有该对象的仓储位置、库存余额与配发状态真相

### 4.4 履约、备货与发货

1. fulfillment boundary 基于 `sales-service` 的 handoff 与放行结果生成履约需求
2. `wms-service` 先检查目标 SKU 现货库存
3. 若现货不足，`wms-service` 再检查可转化基础 SKU、已包装可拆回库存与其他可用仓储选项
4. `wms-service` 返回能否占用、占用哪些库存、是否需要转换 / 拆包 / 审批
5. fulfillment boundary 基于 WMS 返回结果继续推进履约或进入人工判断

### 4.5 后处理送返

1. `wms-service` 将待处理库存锁定、冻结或送入待处理区
2. 若后处理需要跨仓、外发或指定测试区，`wms-service` 负责仓储侧流转记录
3. `mes-service` 负责打孔、laser logo、修补、试水等工序执行与结果真相
4. 工序完成后，由 `wms-service` 负责回仓、恢复可用、转受限或转报废相关仓储状态

### 4.6 紧急订单重分配

1. `wms-service` 识别可被重分配的已占用库存，但不直接覆盖原占用
2. fulfillment boundary 或 `workflow-service` 发起人工审批
3. 审批通过后，`wms-service` 才执行占用释放 / 重建或重分配结果写入

### 4.7 财务协同

1. `sales-service` 发布已成立订单、对客承诺与必要商业摘要
2. `finance-service` 基于受控集成接手 `invoice / collection / payment / AR / credit`
3. 销售侧可以查看财务结果摘要，但不拥有发票、应收、回款、信用或 finance release 真相
4. 是否允许继续发货若涉及财务条件，应通过显式商业规则与审批结果回流，而不是把财务对象直接并入 `sales-service`

## 5. 同步 / 异步边界

- 同步：
  - `api-gateway -> wms-service`
  - fulfillment boundary -> `wms-service` 的履约可用性、占用、释放与重分配请求
  - `wms-service -> mes-service` 的必要追溯摘要或后处理结果查询
- 异步：
  - `sales-service -> fulfillment boundary` 的订单成立与商业放行结果
  - `mes-service -> wms-service` 的交仓事实、后处理完成事实
  - `sales-service -> finance-service` 的交易事实通知
  - `finance-service -> sales-service` 的 finance release / receivable summary 回流
  - future `workflow-service` 的审批结果通知

## 6. 真相归属

- `SalesOrder`、customer commitment、订单成立 / 允许生产 / 允许备货 / 允许发货：`sales-service`
- physical release、执行推进编排、履约交接：fulfillment boundary
- 制造对象、后处理工序、放行条件与结果：`mes-service`
- 仓储位置、库存余额、库存状态、占用真相、包装转换：`wms-service`
- `invoice / collection / payment / AR / credit / finance release / standard FX`：`finance-service`
- 审批过程状态：future `workflow-service`
- 前端消费聚合视图：`api-gateway`

## 7. 明确禁止

- 不让 `sales-service` 变成“大 erp-service”
- 不让订单成立自动等于允许生产、允许备货或允许发货
- 不让 `mes-service` 直接维护正式仓储库存真相
- 不让 `wms-service` 接管打孔、修补、试水等工序执行真相
- 不让 fulfillment boundary 维护独立的物理占用真相
- 不让 `sales-service` 拥有 `AR / invoice / collection / payment / credit / finance release / standard FX` 真相
- 不把“送后处理”混同为普通库位移动
- 不把“烧成完成”误判为“自动入库”

## 8. 关联文档

- [sales-service.md](../services/sales-service.md)
- [mes-service.md](../services/mes-service.md)
- [wms-service.md](../services/wms-service.md)
- [sales-service contracts](../../contracts/sales-service/README.md)
- [sales-finance-order-to-cash.md](./sales-finance-order-to-cash.md)
