# Quality Service Design Workspace

> 来源：质量服务设计线程的阶段性沉淀。本文不是稳定真相源，用于承载 `quality-service` 的持续设计、开放问题与后续回写计划。

## 0. 文档控制

```text
designKey: quality-service-design
designStatus: ACTIVE_DESIGN_WORKSPACE
lastUpdatedAt: 2026-05-09 23:58:07 CST
lastUpdatedBy: Codex design thread
supersedes: older quality rule / inspection boundary discussion where applicable
conflictResolution: 当本文与更早的 quality、inspection、defect、grade、penalty 讨论冲突时，以本文 lastUpdatedAt 之后的冻结结论为准；稳定 architecture / ADR 明确覆盖本文时，以 architecture / ADR 为准。
```

## 1. 目标

- 冻结 `quality-service` 在 OES 中的长期定位与第一阶段最小能力范围。
- 明确 `quality-service` 与 `WMS / procurement / MES / CRM / ERP / product + manufacturing master data` 的边界方向。
- 记录当前已确认的质量场景、术语与开放问题，为后续继续设计提供恢复入口。

## 2. 当前范围

- 本 workspace 负责：
  - `quality-service` 的服务定位与边界方向
  - 第一阶段质量能力范围
  - `IQC / IPQC / 外部验货 / 出货质量放行 / 客诉转质量事件` 的场景判断
  - 内部质检强流程与外部验货灵活流程的设计方向
  - 严重异常围堵、漏检识别、责任归因、趋势分析等基础能力
- 本 workspace 不负责：
  - 最终 `architecture/services/quality-service.md` 职责卡正文
  - 最终 `contracts/quality-service/**` 正文
  - `WMS`、`procurement`、`ERP`、`MES` 各自完整设计
  - 完整 implementation plan
  - 第一阶段代码实现

## 3. 涉及对象

- services:
  - `quality-service`
  - `mes-service`
  - `wms`（future / bounded context）
  - `erp`（future / bounded context）
- features:
  - 来料质检 `IQC`
  - 制程质检 `IPQC`
  - 客户/第三方验货
  - 出货质量放行
  - 客诉转质量事件
  - 严重异常围堵
  - 质量趋势分析
- collaborations:
  - `WMS -> quality-service` 收货触发来料检验
  - `MES -> quality-service` 质检事实、漏检识别、责任归因
  - `CRM/售后 -> quality-service` 客诉转质量事件
  - `quality-service -> WMS / ERP / MES` 放行、围堵、责任输入

## 4. 已冻结决定

| 日期 | 决定 | 影响范围 | 回写目标 |
| --- | --- | --- | --- |
| 2026-04-19 | `quality-service` 的长期定位不是“单一质检模块”，而是统一承接质量标准、检验判定、质量事件、质量围堵、质量分析的质量治理服务。 | 服务边界、协同设计 | `docs/architecture/services/quality-service.md`（未来） |
| 2026-04-19 | `quality-service` 不长期拥有采购执行、仓储执行、制造执行、售后沟通、财务结算或完整主数据真相。 | 服务边界 | `docs/architecture/services/quality-service.md`（未来） |
| 2026-04-19 | `ERP / Finance` 当前可视为已成立的 bounded context，但未形成正式服务职责卡；当前设计应依赖其上下文边界，而不是过早写死服务实现。 | 协作命名、依赖表达 | 本 workspace；未来 `docs/architecture/services/quality-service.md` |
| 2026-04-19 | `product + manufacturing master data` 当前已形成边界方向，但服务化形态后定；`quality-service` 只消费其引用，不拥有其真相。 | 主数据协同 | 本 workspace；未来相关 architecture / design |
| 2026-04-19 | 来料检验 `IQC` 的长期触发源更合理地来自 `WMS / receiving` 的实际收货事实，而不是 `procurement` 的采购单上下文。 | `WMS <-> quality-service` 边界 | `docs/architecture/collaborations/quality-wms-procurement.md`（未来） |
| 2026-04-19 | 传统“重型 OQC”不应作为默认设计；更合理的能力是“出货质量放行”，基于前序检验、包装状态、风险规则与外部验货结果决定是否放行。 | 出货协同、质量放行 | 本 workspace；未来 `contracts/quality-service/**` |
| 2026-04-19 | 客户/第三方验货的主锚点应是订单、出货批次、柜次等 shipment scope，而不是成品库中的普通 inventory batch。 | 外部验货模型 | 本 workspace；未来 quality-service 协同文档 |
| 2026-04-19 | 若在外部验货或内部质检中发现严重问题，后续排查范围应表达为更泛化的 `ContainmentScope`，`inventory batch` 只是其中一种常见范围。 | 围堵与复检设计 | 本 workspace；未来 contracts / architecture |
| 2026-04-19 | 内部质检应采用强流程模式，流程由产品、制造规格、工序与检验重点驱动；外部验货应采用灵活流程模式，允许按客户/第三方要求动态调整检查项与测量项。 | 检验流程模型 | 本 workspace；未来 `contracts/quality-service/**` |
| 2026-04-19 | 第一阶段优先落地基础能力，不追求一次性覆盖完整质量平台；`CAPA`、`8D`、客户偏好沉淀、风险驱动检验、跨域追溯总览等作为后续增强能力。 | 范围管理 | future Quality foundation Delivery |
| 2026-05-09 | 客观瑕疵事实、内部质量等级、客户接受性必须分开；内部等级不是 Item Attribute。 | 质量规则、MES/WMS/Sales 协同 | 本 workspace；未来 quality contracts |
| 2026-05-09 | `QualityGradeDefinition / QualityGradeRule` 归 `quality-service / rule`；MES 记录检查执行结果和等级判定事实。 | 质量规则边界 | 本 workspace；未来 quality contracts |
| 2026-05-09 | 内部质量等级与返修状态拆开：等级表达质量档位，返修状态表达是否需要/适合修补。 | 质量判定、WMS 库存分区 | 本 workspace；MES/WMS 设计 |
| 2026-05-09 | `DefectResponsibilityRule` 方向确认：定义可检测起点、源头工序、负责检查点及不同责任权重；具体模型后续单独冻结。 | 责任归因、奖罚输入 | 本 workspace；未来 quality contracts |

## 5. 开放问题

| 日期 | 问题 | 为什么未冻结 | 下一步 |
| --- | --- | --- | --- |
| 2026-04-19 | `quality-service` 是否第一阶段即独立成服务，还是先以较粗粒度模块/子域承载 | 当前已明确边界方向，但未冻结服务化时机 | 与整体业务域拆分节奏一起评估，必要时升级 architecture / ADR |
| 2026-04-19 | 第一阶段核心聚合应如何拆分 | 当前已形成对象候选，但未完成正式聚合边界讨论 | 下一轮补齐核心对象与聚合草图 |
| 2026-04-19 | `WMS -> quality-service`、`MES -> quality-service`、`CRM -> quality-service` 的最小命令/事件/查询契约 | 当前只冻结协作方向，未冻结接口正文 | 下一轮补齐协作契约草图 |
| 2026-04-19 | 外部验货报告、内部质检报告、客户/第三方报告附件是否共用统一报告模型 | 已明确类型不同，但模型细节未冻结 | 下一轮补齐报告模型 |
| 2026-04-19 | 责任归因是否仅保留“线索归因”，还是第一阶段即形成可供奖罚/绩效直接消费的稳定输入 | 涉及 ERP / 绩效协同深度，尚未冻结 | 后续与 ERP 协同设计一起收敛 |
| 2026-04-19 | `ContainmentScope` 的默认维度有哪些 | 当前只明确库存批次不是唯一范围，仍需冻结最小范围集合 | 下一轮补齐围堵模型 |
| 2026-04-19 | 客户质量偏好与外部验货流程的配置，第一阶段做到多灵活 | 已明确重要但可后置，需要避免第一阶段过重 | 在进入 Delivery 前再压 scope |

## 6. 真相源回写计划

- 服务职责：
  - `docs/architecture/services/quality-service.md`（未来）
- 协同蓝图：
  - `docs/architecture/collaborations/quality-wms-procurement.md`（未来）
  - `docs/architecture/collaborations/quality-mes-crm-erp.md`（未来）
- contracts：
  - `docs/contracts/quality-service/**`（未来）
- 后续交付：
  - Quality Service Foundation cohesive Delivery
- architecture / ADR：
  - 如 `quality-service` 的服务化时机或上下文边界出现明显分歧，再升级到 architecture / ADR

## 7. 恢复入口

- 下次继续前先读：
  - [mes-service.md](../../architecture/services/mes-service.md)
- 当前推荐下一步：
  - 收敛 `quality-service` 核心对象与聚合草图
  - 收敛 `WMS / MES / CRM` 到 `quality-service` 的最小协作契约
  - 冻结第一阶段 scope，再决定是否进入 Delivery

## 8. 当前设计摘要

### 8.1 长期定位

- `quality-service` 负责质量标准、检验判定、质量事件、围堵与质量分析。
- 涉及 MES 生产规格、生产实物、现场资源或追溯主体时，本文只引用 [mes-service.md](../../architecture/services/mes-service.md)，不重新定义 MES 对象。
- 它不直接替代：
  - `WMS` 的收货、库存、发运
  - `procurement` 的采购单与供应商商务协同
  - `MES` 的生产执行与制造追溯真相
  - `CRM / 售后` 的客户沟通真相
  - `ERP / Finance` 的结算与财务真相
  - `product + manufacturing master data` 的主数据真相

### 8.2 第一阶段建议能力

- 基础字典与规则：
  - 缺陷字典与严重度体系
  - 内部质量等级定义
  - 内部质量等级判定规则
  - 返修处置规则
  - 责任归因与扣罚规则模板
  - 面向供应商/场景的基础质量策略配置
- 核心执行：
  - 来料质检 `IQC`
  - 制程质检 `IPQC`
  - 客户/第三方验货任务
  - 检验记录结构化录入
  - 内部质检报告
  - 客户/第三方验货报告
  - 出货质量放行
- 问题闭环：
  - 漏检/漏点识别
  - 责任归因
  - 严重异常围堵
  - 质量封锁规则
  - 客诉转质量事件
  - 重复瑕疵升级
- 分析：
  - 质量看板
  - Pareto 分析
  - 多维分析
  - 质量趋势分析
  - 责任考核输入

### 8.3 后续增强能力

- 让步接收 / 特采
- 供应商质量档案深化
- 返工后再检 / 复检任务体系
- 不良处置闭环深化
- `CAPA`
- `8D`
- 客户质量偏好沉淀
- 质量成本
- 图片证据中心
- 检验知识库
- 风险驱动检验
- 跨域追溯总览

### 8.4 内部质检与外部验货的流程模式

- 内部质检：
  - 强流程模式
  - 由产品、制造规格、工序、检验重点驱动
  - 关键检查项、关键测量项、关键证据项不应被随意跳过
- 外部验货：
  - 灵活流程模式
  - 由客户、第三方、订单要求、包装状态与现场方式驱动
  - 某些验货需要记录毛重、净重、尺寸，某些不需要
  - 某些要求包装后开箱抽检，某些允许包装过程中混合验货

### 8.5 关键术语草稿

- `QualityPolicy`
  - 质量策略 / 偏好设置，决定哪些供应商、客户、场景默认放行、必检、抽检或全检
- `InspectionWorkflow`
  - 检验流程，决定一次检验过程中应记录哪些项目、测量项与证据
- `InspectionRecord`
  - 实际发生的检验记录
- `InspectionReport`
  - 内部质检报告或客户/第三方验货报告
- `ContainmentScope`
  - 重大质量问题触发后的围堵与排查范围，可覆盖库存批次、生产批次、窑次、材料批次、包装批次等

### 8.6 三条优先主线

- 来料主线：
  - `WMS / receiving` 收货事实
  - `quality-service` 创建或触发 `IQC`
  - 输出放行、隔离、拒收、待处理结论
- 制程主线：
  - `MES` 提交质检事实或瑕疵事实
  - `quality-service` 承接漏检识别、责任归因、严重异常围堵
- 外部验货主线：
  - 按订单、出货批次、柜次组织客户/第三方验货
  - 形成验货记录与正式报告
  - 输出出货质量放行结论

### 8.7 核心对象草稿

> 本节用于冻结“第一阶段应讨论哪些核心对象”，不是最终数据库或代码结构。

- `DefectCatalog`
  - 缺陷字典。
  - 负责统一缺陷名称、严重度、分类、图片示例、责任分类提示。
  - 第一阶段是所有检验记录、报告、事件分析的基础字典。
- `QualityPolicy`
  - 质量策略 / 偏好设置。
  - 负责表达哪些供应商、客户、产品、场景默认放行、必检、抽检或全检。
  - 第一阶段优先覆盖供应商来料策略与部分外部验货策略。
- `InspectionWorkflow`
  - 检验流程定义。
  - 负责表达不同产品、制造规格、工序或外部验货场景需要记录哪些检查项、测量项与证据项。
  - 内部质检偏强约束，外部验货偏灵活。
- `InspectionTask`
  - 一次待执行的检验 / 验货任务。
  - 可来源于：
    - `WMS` 收货触发的 `IQC`
    - `MES` 工序或异常触发的 `IPQC`
    - 订单 / 柜次 / 出货批次触发的客户或第三方验货
    - 严重异常后的补检 / 围堵复查
  - 负责负责人、协同人、范围、状态、计划时间窗口。
- `InspectionScope`
  - 本次检验到底覆盖哪些对象。
  - 可表达：
    - 收货单 / 收货明细
    - 订单 / 出货批次 / 柜次
    - 工单 / 工序 / 在制品集合
    - 指定 MES `TraceSubject` 或由 MES 真相源确认的生产追溯引用
- `InspectionRecord`
  - 一次检验实际录入的结构化结果。
  - 负责记录：
    - 检验方式
    - 抽检 / 全检数量
    - 检查项结果
    - 测量值
    - 证据附件摘要
    - 现场备注
- `InspectionFinding`
  - 单个问题项。
  - 必须能落到具体对象或明确范围。
  - 可关联：
    - MES `TraceSubject` 或由 MES 真相源确认的生产追溯引用
    - 缺陷字典项
    - 严重度
    - 是否为漏检 / 漏点
    - 初步责任线索
- `InspectionReport`
  - 一次正式报告。
  - 至少区分：
    - 内部质检报告
    - 客户/第三方验货报告
  - 第一阶段优先保证内部沉淀与审计，不强求复杂外发模板。
- `ShipmentReleaseDecision`
  - 面向订单 / 出货批次 / 柜次的质量放行结果。
  - 负责表达通过、部分放行、待整改后复验、不通过、暂停放行。
- `ContainmentCase`
  - 严重异常触发后的围堵案例。
  - 负责把“发现问题”升级成“系统性排查与控制”。
- `ContainmentScope`
  - 围堵范围。
  - 当前建议至少支持：
    - `inventory batch`
    - 生产批次 / 工单批次
    - 窑次
    - 材料批次
    - 包装批次
    - 当前订单 / 出货批次 / 柜次关联范围
- `QualityCase`
  - 质量事件。
  - 负责承接：
    - 客诉转质量事件
    - 重大外部验货异常
    - 重复瑕疵升级
    - 批量异常
  - 第一阶段可先做到事件建案、分级、责任线索与状态流转。
- `LiabilityAttribution`
  - 责任归因结果或归因线索。
  - 可指向工序、班组、工人、包装人员、清洁人员、材料批次、模具、窑次等。
  - 第一阶段优先支持“可追责输入”，不强求自动化精确归责。

### 8.8 聚合边界草图

> 本节是第一版聚合草图，用于控制边界，不代表最终类图或表结构。

#### A. `Inspection Governance` 聚合组

- 包含候选：
  - `DefectCatalog`
  - `QualityPolicy`
  - `InspectionWorkflow`
- 职责：
  - 维护质量语义、严重度、默认检验策略与流程定义
- 原因：
  - 这些对象变化频率较低，更像治理配置，不应与单次检验执行耦合

#### B. `Inspection Execution` 聚合组

- 包含候选：
  - `InspectionTask`
  - `InspectionScope`
  - `InspectionRecord`
  - `InspectionFinding`
- 职责：
  - 承载一次真实检验/验货从创建、执行到记录完成的生命周期
- 原因：
  - 这是第一阶段最核心的运行态对象
  - `IQC`、`IPQC`、外部验货都可复用这组对象，但通过不同策略与流程驱动

#### C. `Inspection Reporting & Release` 聚合组

- 包含候选：
  - `InspectionReport`
  - `ShipmentReleaseDecision`
- 职责：
  - 把执行结果整理成正式报告，并输出对出货/放行的质量结论
- 原因：
  - 报告与放行判断对外部协作很关键，但不应反过来吞掉检验执行本体

#### D. `Containment & Case Management` 聚合组

- 包含候选：
  - `ContainmentCase`
  - `ContainmentScope`
  - `QualityCase`
  - `LiabilityAttribution`
- 职责：
  - 承接严重异常、批量问题、客诉升级、重复瑕疵升级后的围堵与追责
- 原因：
  - 这组对象关注“发现问题之后怎么办”，和日常单次检验不同

#### E. 第一阶段读模型候选

- `QualityDashboardSummary`
  - 看板摘要
- `DefectParetoSummary`
  - 缺陷 Pareto
- `QualityTrendSummary`
  - 趋势分析
- `LiabilitySummary`
  - 责任统计
- `ShipmentInspectionSummary`
  - 外部验货与出货质量放行摘要

### 8.9 最小协作契约草图

> 当前只冻结方向与最小黑盒语义，不冻结字段细节。

#### 8.9.1 `WMS -> quality-service`

- 典型输入事实：
  - `ReceiptRegistered`
  - `ReceiptItemArrived`
  - `ReceiptReadyForInspection`
- `quality-service` 典型输出：
  - 创建 `IQC InspectionTask`
  - 输出 `ReceiptQualityDecision`
    - 放行
    - 隔离
    - 拒收建议
    - 待处理
- 明确禁止：
  - `quality-service` 直接改写 `WMS` 库存真相

#### 8.9.2 `MES -> quality-service`

- 典型输入事实：
  - `InspectionCompleted`
  - `DefectRecorded`
  - `QualityClassificationRecalculated`
  - `ResponsibilityAttributed`
  - 模具、材料、窑次、位置级追溯摘要
- `quality-service` 典型输出：
  - 缺陷字典
  - 内部分类规则
  - 责任归因规则模板
  - 围堵 / 质量封锁建议
- 明确禁止：
  - `quality-service` 直接推进 `MES` 工序流转
  - `quality-service` 直接决定对象是否已移交 `WMS`

#### 8.9.3 `CRM / 售后 -> quality-service`

- 典型输入事实：
  - `CustomerComplaintRegistered`
  - `ComplaintMarkedAsQualityIssue`
- `quality-service` 典型输出：
  - 创建 `QualityCase`
  - 输出质量分级、责任线索、是否需要围堵
- 明确禁止：
  - `quality-service` 直接接管客户沟通真相

#### 8.9.4 `quality-service -> ERP / Finance`

- 典型输出事实：
  - 责任考核输入
  - 质量损失输入
  - 返工 / 报废 / 放行等质量结果摘要
- 当前判断：
  - 第一阶段只输出可审计输入，不直接承担结算逻辑

### 8.10 内部质量等级与返修处置

内部质量等级、返修状态、客户接受性必须分开。

冻结结论：

- `InternalQualityGrade` 是工厂内部质量档位 / 可售档位。
- `RepairDisposition` 是是否需要修补、什么时候修补、是否可修补。
- `CustomerAcceptance` 是客户是否接受某种瑕疵、等级或修补状态。
- 内部质量等级不应作为 Item Attribute，也不进入 Item variant。

建议 `QualityGradeDefinition`：

```text
QualityGradeDefinition {
  gradeCode
  gradeName
  rank
  stockPolicy
  salesPolicy
  defaultLocationPolicy
}
```

建议等级示例：

```text
PREMIUM
STANDARD
ECONOMY
LOW_GRADE
SCRAP_GRADE
```

建议返修状态：

```text
NONE_REQUIRED
REPAIR_RECOMMENDED
REPAIR_REQUIRED_BEFORE_STOCK
REPAIR_REQUIRED_BEFORE_SHIPMENT
NOT_REPAIRABLE
```

用途：

- WMS 按内部等级分区、汇总和隔离。
- Sales 后续通过质量策略选择可用等级。
- MES 根据返修状态决定是否进入返修、等待出货前修补或待报废确认。
- Quality 用等级、瑕疵、工序、模具、窑次、班组等维度做分析。

“总货”不是质量等级，而是销售/分配策略：

```text
MIXED_GENERAL_GOODS:
  allowedInternalGrades = [PREMIUM, STANDARD]
```

### 8.11 InspectionCheckpoint 与记录深度

检查点在 MES Route 中执行，质量规则由 `quality-service / rule` 提供。

检查点包括：

- Route 必经检查点，例如一检、二检、烧后外观检、功能检查。
- Optional checkpoint，例如客户 QC、第三方 QC、巡检/抽检。

`recordingMode` 表示检查记录详细程度：

```text
RESULT_ONLY
REJECT_REASON
DEFECT_REQUIRED
MEASUREMENT_REQUIRED
FULL_INSPECTION
```

烧后外观检应作为重检查点：

- 必须支持瑕疵记录。
- 必须支持面别、位置、数量、严重度。
- 后续应支持拍照存底。
- 应输出内部质量等级和返修处置建议。

### 8.12 责任与扣罚规则边界

`quality-service / rule` 长期负责：

- `DefectDefinition`
- `QualityGradeRule`
- `RepairDispositionRule`
- `DefectResponsibilityRule`
- `PenaltyRuleTemplate`

MES 负责：

- `DefectRecord`
- `InspectionExecution`
- `ResponsibilityAttribution`
- `PenaltyInputRecord`

Payroll / Finance 负责：

- 最终工资结算。
- 最终扣款或奖励入账。

连责规则方向：

```text
DefectResponsibilityRule:
  defectCode
  originOperationCandidates
  detectableFromCheckpoint
  checkpointResponsibilities[]
```

每个 checkpoint 可以配置不同责任角色与权重。具体字段后续单独冻结。

### 8.13 第一阶段建议角色草稿

- `QualityOwner`
  - 质量负责人
  - 可创建或关闭质量事件、确认放行与围堵结论
- `Inspector`
  - 内部质检员
  - 负责执行内部质检与录入记录
- `ExternalInspectionCoordinator`
  - 外部验货协调人
  - 负责安排客户/第三方验货、汇总外部反馈与形成报告
- `Collaborator`
  - 协同人员
  - 现场配合，不拥有最终结论权限
- `Approver`
  - 审批角色
  - 为后续特采、重大放行、重大围堵预留
