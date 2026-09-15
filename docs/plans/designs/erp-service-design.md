# ERP Service Design Workspace

```text
designKey: ERP-SERVICE
designStatus: ACTIVE_DESIGN_WORKSPACE
```

## 1. 目标

- 冻结 `erp-service` 第一阶段的职责边界与销售交易主链路设计方向。
- 记录报价、订单成立、订单推进、客户交易条件与审批的当前已确认需求。
- 为后续继续细化 `sales / procurement / settlement` 模块提供恢复入口。

## 2. 当前范围

本 workspace 负责：

- `erp-service` 与 `crm-service`、`party-service`、future `srm-service`、future `finance-service`、`mes-service`、future `wms-service`、planning / APS 的边界。
- `sales` 主链路中的 `Quote -> SalesOrder -> 生产/发货推进` 需求收敛。
- 报价草稿、发布、历史版本、旧版本找回、报价审批的产品需求方向。
- 客户交易条件、订单推进条件与“条件不满足即进入审批”的第一版治理原则。

本 workspace 不负责：

- 直接实现 `erp-service`。
- 直接冻结最终 `erp-service` 职责卡。
- 完整 `procurement` / `settlement` / `finance-service` 详细设计。
- 完整前端页面、工作台、状态机字段与数据库模型。
- `workflow`、`wms-service`、`finance-service` 的正式服务职责卡。

## 3. 涉及对象

- services:
  - future `erp-service`
  - `crm-service`
  - `party-service`
  - future `srm-service`
  - future `finance-service`
  - `mes-service`
  - future `wms-service`
  - planning / APS
- features:
  - quote drafting and publishing
  - quote approval
  - quote to order conversion
  - order progression control
  - customer trading profile
- collaborations:
  - `crm-service -> erp-service`
  - `erp-service -> mes-service`
  - `erp-service -> wms-service`
  - `erp-service -> finance-service`
  - `erp-service -> party-service`
  - `erp-service -> workflow`

## 4. 已冻结决定

| 日期 | 决定 | 影响范围 | 回写目标 |
| --- | --- | --- | --- |
| 2026-04-18 | `erp-service` 定位为“经营交易核心”，不是纯财务中台，也不是把库存、制造、计划、财务全部吞进一个大服务。 | ERP 总边界 | future `docs/architecture/services/erp-service.md` |
| 2026-04-18 | 用户界面不应显式暴露 ERP / MES / WMS 的系统边界；前端应尽量按角色与业务流程组织，由 BFF / 工作台聚合多服务数据。 | 前端体验边界、BFF 设计 | future collaboration / frontend docs |
| 2026-04-18 | `erp-service` 不拥有中性主体真相；交易与法律主体主数据归 `party-service`，ERP 单据优先引用 `tenantPartyId` 并保存交易快照。 | ERP 与主数据边界 | `erp-service` 职责卡 + contracts |
| 2026-04-18 | 客户角色语义归 `crm-service`；供应商角色语义归 future `srm-service`；ERP 只拥有正式交易关系中的引用、条件快照与单据真相。 | ERP / CRM / SRM 边界 | `erp-service` / `srm-service` 职责卡 |
| 2026-04-18 | `erp-service` 不拥有完整总账、会计科目、凭证、结账与法定财务核算；这些应归 future `finance-service` 或外部财务系统。 | ERP / Finance 边界 | future `finance-service` design / service card |
| 2026-04-21 | `sales` 中 `Quote` 应为独立业务对象，不与 `SalesOrder` 合并。 | sales 模块主模型 | future contracts / Delivery |
| 2026-04-21 | 用户操作心智上始终像是在处理“同一份报价”；销售不应被迫手工维护多份平行报价。 | 产品体验 | Delivery / UI design |
| 2026-04-21 | 报价必须支持历史版本；历史版本用于对外正式报价留痕、客户确认依据、转订单依据与旧版本找回。 | Quote 产品能力 | contracts / Delivery |
| 2026-04-21 | 下载本身不应等同于新报价版本；下载/导出记录与报价版本是两类不同事实。 | Quote 行为语义 | contracts / Delivery |
| 2026-04-21 | `Contract` 为可选对象，不是报价到订单的固定必经步骤；工程单通常需要，电商通常不需要，出口可按 `PO + PI` 或合同模式处理。 | sales 模块边界 | contracts / Delivery |
| 2026-04-22 | 订单成立、允许生产/备货、允许发货是三个不同节点，不应混成单一“确认后自动一路推进”的流程。 | order progression 模型 | future contracts / Delivery |
| 2026-04-22 | 不同客户存在不同交易条件，例如定金比例、尾款时点、账期、预存款/押金抵扣；这些条件应成为 ERP 核心需求对象。 | customer trading profile | future Delivery |
| 2026-04-22 | 第一版中，只要报价或订单推进不符合相关配置条件，就进入审批；是否放行交给有权限的上级判断。 | approval policy v1 | contracts / Delivery |
| 2026-04-22 | 第一版先收需求，不展开技术框架、实现方式或通用 policy engine 设计；先完整收齐产品需求再统一进入设计与落地。 | 当前线程协作方式 | 本 workspace |

## 5. 当前已收敛的需求要点

### 5.1 报价

- `Quote` 至少应区分：
  - 草稿
  - 已发布 / 正式报价
- 草稿阶段可以持续修改和保存，不应生成新正式版本。
- 已发布报价必须形成可追溯历史版本。
- 历史版本需要支持：
  - 查看
  - 下载
  - 作为后续修改的基础
- 用户操作层面应保持“同一份报价持续推进”的心智，不应强迫用户手工创建多份平行报价。

### 5.2 报价版本与下载

- 以下动作不应生成新正式版本：
  - 保存草稿
  - 普通下载
  - 重复下载
  - 预览 / 打印
  - 未发布草稿阶段的日常修改
- 以下动作应形成新的正式报价基线：
  - 明确发布新的正式报价
  - 已发布报价修改后再次发布
  - 被客户确认的正式报价内容
  - 被用于转正式订单的报价内容

### 5.3 订单成立与推进

- “报价何时转正式订单”与“订单何时允许推进”是两层不同需求。
- 当前已确认要区分：
  - 订单成立
  - 允许生产 / 备货
  - 允许发货
- 不同客户、不同渠道、不同业务模式下，这三个节点可能受不同条件控制。

### 5.4 客户交易条件

- 当前已明确客户交易条件不能只看“客户”，也不能只看“渠道”。
- 需要同时考虑：
  - 客户分类
  - 渠道分类
  - 业务模式
  - 付款模式
  - 风险等级
- 当前已明确的典型客户 / 渠道类型包括：
  - 经销商
  - 代理商
  - OEM 客户
  - 一件代发客户
  - 自有门店
  - 外贸 / 出口客户
- 当前已确认客户交易条件至少涉及：
  - 是否需要定金
  - 定金比例
  - 尾款比例与时点
  - 是否有账期
  - 账期天数 / 月结
  - 是否有押金 / 预存款
  - 是否可用押金 / 预存款抵扣
  - 是否报价必审
  - 是否首单必审
  - 不符合条件时是否必须走审批

### 5.5 审批

- 报价审批已确认为必要能力。
- 审批触发来源当前已明确包括：
  - 业务员身份 / 资历
  - 客户类型 / 指定客户
  - 是否低于价格表
  - 价格阈值
  - 数量阈值
  - 其他后续可扩展条件
- 第一版治理原则：
  - 只要不符合相关配置条件，就进入审批
  - 不先细分复杂的例外策略
  - 是否放行交给上级判断

## 6. 开放问题

| 日期 | 问题 | 为什么未冻结 | 下一步 |
| --- | --- | --- | --- |
| 2026-04-22 | `erp-service` 的正式最小模块边界是否冻结为 `sales / procurement / settlement` | 当前只把 `sales` 主链路聊到一半，采购与结算尚未展开 | 继续补齐采购与结算需求，再回写服务职责卡 |
| 2026-04-22 | 客户交易条件的正式对象边界是什么 | 当前只确认了需求方向与典型字段，尚未冻结对象拆分 | 继续收集客户分类、渠道分类、交易条件来源与优先级 |
| 2026-04-22 | 报价到订单的正式触发路径有哪些 | 当前确认了“报价确认 -> 订单成立”的主题，但未冻结不同渠道的正式路径 | 继续按经销、OEM、出口、电商等场景细化 |
| 2026-04-22 | 订单推进节点的状态与审批结果如何表达 | 当前只确认了“条件不满足即审批”的原则，未冻结状态机 | 在需求完整后统一设计状态模型 |
| 2026-04-22 | 合同、`PO`、`PI` 在各业务模式中的必要性与关系 | 当前只冻结了“合同可选、非固定必经步骤” | 继续按出口、工程、电商场景补齐 |
| 2026-04-22 | 第一版审批规则主要挂在客户、渠道、业务员还是价格表 | 当前只确认了触发来源，不足以冻结配置归属 | 继续讨论“配置条件主要挂在哪一层” |

## 7. 真相源回写计划

- 服务职责：
  - future `docs/architecture/services/erp-service.md`
  - future `docs/architecture/services/finance-service.md`
- 协同蓝图：
  - future `docs/architecture/collaborations/crm-erp-order-lifecycle.md`
  - future `docs/architecture/collaborations/erp-mes-wms-finance.md`
- contracts：
  - future `docs/contracts/erp-service/**`
- 后续交付：
  - Quote / Order Core cohesive Delivery
  - Customer Trading Profile cohesive Delivery
- architecture / ADR：
  - 如 `erp-service` 与 `finance-service` 的正式拆分方式出现分歧，再升级到 architecture / ADR

## 8. 恢复入口

- 下次继续前先读：
  - [party-service.md](../../architecture/services/party-service.md)
  - [crm-service.md](../../architecture/services/crm-service.md)
  - [mes-service.md](../../architecture/services/mes-service.md)
  - [srm-service.md](../../architecture/services/srm-service.md)
- 当前推荐下一步：
  - 继续收齐客户交易条件的完整维度
  - 继续收齐报价确认到正式订单成立的不同业务路径
  - 继续收齐订单推进到生产 / 发货的条件与审批需求
  - 在 `sales` 需求足够完整后，再统一进入设计与落地讨论
