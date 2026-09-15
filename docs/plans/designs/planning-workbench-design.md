# Planning Workbench Design Workspace

```text
designKey: PLANNING-WORKBENCH
designStatus: ACTIVE_DESIGN_WORKSPACE
writeBackTargets:
  - docs/architecture/services/planning-service.md
  - docs/architecture/collaborations/planning-and-mes.md
  - docs/contracts/planning-service/
```

> 本文记录尚未冻结的计划工作台讨论，不是稳定真相源或实现授权。

## 1. 目标

- 定义一个贴近当前落地阶段的制造计划工作台边界。
- 让 `mes-service` 不承担完整 APS 职责，同时又能得到合理的派工与放行输入。

## 2. 当前定位

- `planning-workbench` 可视为 APS 的雏形或过渡层。
- 它先解决现实计划问题：
  - demand 汇总
  - 产能可视化
  - 工人技能与出勤
  - 模具可用性与恢复时间
  - 产线、烘干房、窑炉容量
  - 温度、湿度等环境因素
  - 在制品分布
  - 插单、改单、停单
  - 派工建议与下发
- 它不是第一阶段完整 APS：
  - 不默认承担高级约束求解
  - 不默认承担自动全局最优排产
  - 不默认承担多工厂复杂协同优化

## 3. 与 `mes-service` 的边界

### 3.1 `planning-workbench` 负责

- 汇总 demand
- 形成投产建议
- 形成放行建议
- 形成派工建议
- 允许人工调整后下发
- 支持插单、改单、停单

### 3.2 `mes-service` 负责

- 记录现场执行真相
- 记录工序流转、扫码、巡检、质检、报废、修补、烧成追溯
- 执行已下发的任务与放行决定

## 4. 运行模式建议

- 手动模式
  - 计划员完全手工编排后下发
- 建议模式
  - 系统生成建议，人工确认后一键下发
- 自动模式
  - 满足配置条件时自动下发

建议按工厂、车间、工序组进行配置，而不是全局单一开关。

## 5. Demand 对工序的影响建议

- `Demand` 主要驱动前段投产决策，尤其是成型工段。
- 后段更多受在制品流转、放行规则与优先级影响。
- 不能简单理解为“所有工序都直接吃总 demand”，也不能理解为“后段完全不受 demand 影响”。

更准确的表述是：

- 投产型工序：
  - 直接受 demand 驱动
- 节奏控制型工序：
  - 受工艺成熟度、容量、优先级、环境等影响
- 流转处理型工序：
  - 更多处理流转到达的在制品，但仍受交期与插单影响

## 6. 计划工作台依赖的数据

- Demand
- 在制品分布
- 工人技能与出勤
- 模具当前状态与预计恢复时间
- 产线状态
- 烘干房容量与停留时间约束
- 窑炉与窑车容量
- 温度、湿度等环境因素

## 7. 当前推荐结论

- 第一阶段先做“计划工作台 + 建议调度”，而不是完整 APS。
- `planning-workbench` 与 `mes-service` 需要并行设计边界，但本线程不展开其完整实现。
