# OES AI Platform Architecture

```text
status: FROZEN
frozenDate: 2026-07-28
lastAmendedDate: 2026-08-05
firstValidationScenario: Task Assistant
taskAssistantCollaboration: docs/architecture/collaborations/task-assistant.md
taskAssistantToolContract: docs/contracts/ai-platform/task-assistant-tool-contract.md
delegatedExecutionTruth: docs/architecture/collaborations/delegated-execution-and-action-grant.md
predecessorDesignGate: FROZEN_AI_PLATFORM_TASK_ASSISTANT
registrationGate: FROZEN_TOOL_CONTRACT_REGISTRATION_READY
```

> 本文是 OES 项目级 AI 平台架构真相源，只冻结长期逻辑边界和跨能力责任，不决定服务数量、部署拓扑、proto、schema、模型供应商或 Agent 框架。涉及单个服务的职责与核心对象时，以对应 `docs/architecture/services/*.md` 为准。

## 1. Position

AI 是 OES 的平台级增强能力，不是孤立聊天模块，也不是业务真相或业务规则 owner。平台把模型、知识、受控工具、权限、人工确认和审计组合成可复用能力；具体业务场景通过受治理配置与工具接入，不在业务服务内部重复建设本地 AI runtime。

稳定原则：

- AI 不拥有业务主数据真相。
- AI 不直接访问或写入业务数据库。
- AI 不把核心业务规则、权限规则或 operation 风险分类藏在 prompt 中。
- 业务读取与状态变化只能通过 owner 服务的公开能力完成。
- 每次 AI 调用必须显式携带 tenant、适用的 org、可信 operator、trace 与审计上下文。
- 任何状态变化都必须可鉴权、可确认、可追踪并能关联到最终业务结果。
- 当前阶段只冻结最小可持续基础，不建设大而全 AI 中台。

## 2. Stable Logical Layers

AI 平台采用稳定逻辑分层，但本轮不把每一层等同为独立微服务：

1. **Model layer**：统一模型接入、路由、回退、限流、成本统计与提示治理，避免业务服务直接绑定模型供应商。
2. **Knowledge layer**：承接受治理的企业文档、SOP、制度、FAQ、来源版本、权限感知检索与引用；不承接业务交易真相副本。
3. **Tool governance layer**：管理 `ToolContract` identity/version、允许的公开操作绑定与调用记录；工具是 AI 行动的唯一业务入口。
4. **Orchestration layer**：执行场景 Profile、组装最小上下文、协调模型/知识/工具、插入人工确认并记录 AI Run。
5. **Scenario layer**：定义可验收的业务辅助场景；Task Assistant 是第一个验证场景。

新增 AI 场景默认扩展这些稳定层，不为每个场景建立独立身份、权限、知识、工具和审计体系。

## 3. Stable Platform Concepts

### 3.1 AgentPrincipal

`AgentPrincipal` 是 AI 平台对 Identity-owned Machine Principal 的语义引用，不是第二套身份真相。当前 Identity 机器主体基础以 [identity-service.md](../services/identity-service.md) 中的 `ServiceAccount` 为准。

稳定规则：

- principal 按独立安全信任边界、工具权限上限和审计责任划分。
- 不按用户、会话、Task 或单次执行创建机器主体。
- 两个 Profile 只有在信任边界、工具权限上限和运行责任一致时才可以复用 principal。
- principal lifecycle、scope、tenant reference 与 enabled state 仍由 Identity owner 管理。

### 3.2 AgentProfile

`AgentProfile` 是版本化的场景运行定义，描述角色、行为边界、模型策略、知识范围引用、允许的 ToolContract、执行模式和成本策略。它不授予权限，不保存业务主数据，也不能扩大 AgentPrincipal 或 HUMAN 的授权上限。

### 3.3 KnowledgeScope

`KnowledgeScope` 描述某个 Profile 可请求的知识来源、tenant/org、可见性、版本与 lifecycle 边界。知识 owner 必须在检索时执行实际过滤；Profile 中的 scope 只是收窄上限，不能替代知识 owner 的授权判定。

### 3.4 ToolContract

`ToolContract` 是 AI 工具治理层拥有的不可变 identity/version 与明确输入输出边界。它只绑定业务 owner 已公开且已分类的 operation，不能重新定义业务命令、状态机、resource policy 或 operation 风险等级。

Task Assistant 的第一个注册面固定消费 [task-assistant-tool-contract.md](../../contracts/ai-platform/task-assistant-tool-contract.md)：identity 为 `oes.ai.task-assistant.collaboration-task`，immutable version 为 `1.0.0`。它通过 repository-native manifest 注册 owner 已冻结的 read/draft/CreateTask subset，但注册阶段不创建 runtime adapter，且 `runtimeExecutionEnabled`、`mutationExecutionEnabled` 与 `publicExposureEnabled` 全部为 `false`。同一 identity/version 一旦进入 `main` 不得原地修改；任何语义变化必须使用新 version 和新文件。

Repository manifest 是注册与审查输入，不是运行时授权真相。任何 execution flag 打开前，AI 平台必须提供 owner-controlled runtime resolution contract，使 Auth 能取得当前 active ToolContract identity/version、operation upper bound 与安全版本引用；Auth、Permission 和业务服务不得在运行时读取 registration JSON、prompt 或调用方字段来重建该上限。

### 3.5 ExecutionContext

`ExecutionContext` 是一次调用的临时执行上下文，必须关联触发 HUMAN、AgentPrincipal、AgentProfile version、tenant、适用的 org、session/request/trace、delegation 与审计信息。它不是 credential、Role、Permission 或业务 ownership；具体跨服务字段结构在共享契约获得独立 ownership 后再冻结。

### 3.6 ModelRouting

`ModelRouting` 管理模型选择、回退、限额与成本策略。它属于 AI 基础设施策略，不参与身份或业务授权判定。

### 3.7 AgentRun

AI 编排边界拥有一次 AI 执行的 `AgentRun` 事实与安全摘要，包括 Profile/model/tool/knowledge version 引用、步骤结果、确认节点、成本、错误类别和关联标识。`AgentRun` 不复制业务 owner 的最终写入真相，也不能把“已请求工具”记录成“业务命令已成功”。具体 schema 后置。

一个用户指令创建一个 bounded `AgentRun`；Conversation 只是可长期保留的交互上下文，不是授权容器。继续同一 Conversation 的新指令仍创建新 Run，并由 Auth 基于当前 HUMAN session、AgentPrincipal、ToolContract 与 policy truth 形成新 delegation。Conversation 未关闭不会延长、续期或复活旧 Run 的 authority。

## 4. Identity, Authorization And Delegation

AI 调用必须保持 HUMAN 与 Agent 双重归因。有效操作上限是以下约束的严格交集：

```text
HUMAN grant
∩ active AgentPrincipal grant
∩ active DelegationGrant
∩ AgentProfile bound ToolContract
∩ ToolContract operation upper bound
∩ tenant / org
∩ target service method declaration
∩ target resource policy
∩ business domain rule
```

责任边界：

- Identity 拥有 Machine Principal identity 与 lifecycle。
- Auth 拥有机器认证、ExecutionToken、`DelegationGrant`、HUMAN confirmation evidence 与 `ActionGrant` credential lifecycle；它从 Identity 与 AI 平台 owner contract 解析当前 AgentPrincipal / ToolContract facts，并向 Permission 提交固定的可信 delegation upper bound。
- Permission 拥有 HUMAN/MACHINE grant、policy 和 DELEGATED authorization intersection；它独立解析 HUMAN grants，不查询 Auth storage、AI registration artifact 或业务 owner database。
- AI 平台拥有 Profile 执行、受控工具编排、用户侧确认展示与 AI Run；确认事实本身由 Auth 持有。
- 每个业务 owner 拥有 operation 风险基线、tenant-only tightening、canonical action facts、业务规则、状态变化和最终结果。

高风险执行严格消费 [delegated-execution-and-action-grant.md](../collaborations/delegated-execution-and-action-grant.md)：业务 owner 将 operation 分类为 `DELEGATION_ALLOWED`、`ACTION_GRANT_REQUIRED` 或 `AI_FORBIDDEN`；AI 平台不能自行降低或推断该分类。

## 5. Business Data And Knowledge Boundary

- 实时业务事实必须通过 owner 服务的 query/application capability 按需读取。
- AI 平台不得把业务表、业务聚合或业务 read model 复制成自己的主数据真相。
- 企业制度、SOP、手册、FAQ 与其他知识内容由统一知识能力承接，并保留来源、版本、tenant/org 与可见性过滤。
- 编排只组装当前执行所需的最小业务语义上下文，不向模型暴露不受控原始表或跨租户数据。
- 输出必须能区分 owner-service 实时事实、知识来源内容和模型推断。
- 若未来需要业务搜索索引或 AI projection，必须由 owner facts/event 构建可重建投影并单独冻结；向量库永远不是业务真相源。

## 6. Tool And Execution Modes

AI 场景按行为分为：

- **read/explain**：只通过受控 query 或知识检索读取已授权信息。
- **draft/propose**：生成建议或待确认的结构化动作，不改变业务状态。
- **submit/mutate**：只能通过版本化 ToolContract 调用业务 owner command，并满足 delegation、owner-declared risk class、resource policy、domain rule 与 idempotency；仅在风险分类要求时才追加 exact confirmation、step-up 与 ActionGrant。
- **unattended automation**：必须使用独立 MACHINE workflow，不得长期保留或静默续期 HUMAN delegation。

任何工具调用失败都必须 fail closed。模型不得把 tool failure、timeout、permission denial 或 pending confirmation解释为业务成功。

## 7. Audit And Replay Boundary

各 owner 只记录自己拥有的事实，并通过稳定关联引用组成完整链路：

- AI 平台：AgentRun、模型、知识引用、工具提议/调用、确认节点、成本与结果摘要。
- Auth：认证、delegation、step-up 与 ActionGrant credential lifecycle。
- Permission：授权决策、policy/version 与安全 reason。
- 业务服务：领域命令、状态变化、幂等与最终业务结果。

各服务禁止共享审计数据库或复制对方 owner 真相。集中观测/审计平台可以索引这些事实，但不取代任何本地 owner。审计与回放必须避免保存 credential、secret、ActionGrant 正文和不必要的敏感 prompt/tool payload。

## 8. Task Assistant As First Validation Scenario

Task Assistant 验证通用 AI 平台边界，而不改变 Collaboration Task：

- 它是版本化 `AgentProfile`，运行于按安全边界治理的 AgentPrincipal。
- 第一阶段只支持用户主动触发、人在回路的交互式 Copilot。
- 它可以查询、总结、排序、解释 Task，并生成拟执行动作。
- 它不得因模型推断自动创建、开始、完成、取消、重开或归档 Task。
- 状态变化只有在用户明确执行意图、业务 owner 风险分类和受控工具校验全部满足后才可请求。
- Task 的 `createdByAccountId`、`assigneeAccountId` 与参与者 ownership 始终是 HUMAN account；Agent 只作为 DELEGATED execution actor 进入审计。
- Task 实时事实始终从 Collaboration Task Query 获取；AI 平台不复制 Task 主数据或把它写入场景私有知识库。
- 当前注册阶段只发布不可变 ToolContract manifest；read、draft 和 CreateTask operation 均不可由 runtime 调用，mutation 与公共入口保持关闭。

完整协同以 [task-assistant.md](../collaborations/task-assistant.md) 为准；Task 长期职责仍以 [collaboration-service.md](../services/collaboration-service.md) 为唯一服务真相源。

## 9. Stable Task Assistant Flow

```text
HUMAN request through Gateway / BFF
  -> resolve trusted HUMAN context + governed AgentPrincipal/Profile
  -> query current Task facts through registered read ToolContract
  -> optionally retrieve governed enterprise knowledge
  -> model produces explanation or proposed action
  -> HUMAN expresses exact execution intent
  -> business-owner risk class controls the path
      -> DELEGATION_ALLOWED: delegated authorization + controlled command
      -> ACTION_GRANT_REQUIRED: exact confirmation + ActionGrant + controlled command
      -> AI_FORBIDDEN: refuse and route to human-only management flow
  -> collaboration-service applies Task participant rules and domain transition
  -> AI platform reports only the verified business result
```

## 10. Delivery Priority And Non-goals

架构边界现在冻结，但 AI 实现优先级后置于核心业务能力和可信执行基础。推荐顺序：

```text
core business and platform security
  -> Collaboration owner contract and risk freeze
  -> immutable Task Assistant ToolContract registration
  -> Collaboration Task runtime + trusted execution / EXEC-CRYPTO and DG-4 runtime
  -> minimal Task Assistant vertical validation
  -> evidence-driven AI platform expansion
```

本轮不冻结：

- 新服务数量、名称或部署拓扑；
- proto、HTTP API、database schema 或公共 `src/common` 结构；
- 模型供应商、Agent 框架、向量数据库或具体观测产品；
- prompt 正文、长期记忆、多 Agent、无人值守自动化；
- Task event subscription、AI Task projection 或自动完成；
- 对业务 owner 已冻结风险分类的重新定义。

## 11. Implementation Gates

ToolContract registration phase 必须满足：

1. 本架构、[task-assistant.md](../collaborations/task-assistant.md) 与 [task-assistant-tool-contract.md](../../contracts/ai-platform/task-assistant-tool-contract.md) 已进入 `main`。
2. Collaboration owner 已在既有 Task contracts 冻结 eligible operation subset、risk class 与 assigned-task descriptor。
3. 实现只写 AI-owned registration manifest 与 contract test；不创建 service、runtime adapter、proto、schema、Gateway route 或 execution path。

该 registration phase 不等待 ActionGrant runtime。任何 Task Assistant runtime 或 mutation opening 仍必须等待：

1. `EXEC-CRYPTO MAIN_READY`，可信 ExecutionToken/JWS/mTLS runtime 可用。
2. DG-4 DelegationGrant/ActionGrant runtime 满足冻结协同。
3. Collaboration Task runtime 与既有 query/command contracts 可用，且 target-side idempotency/consumption gate 完成。
4. 若 slice 包含制度/SOP 检索，统一知识能力的 owner、权限感知检索和引用边界已冻结并可用。
5. 若实现需要新增服务、共享 proto、operator context、permission semantics、公共入口或 runtime AI tool protocol 字段，先取得对应 truth-source/ADR/path ownership，不能由实现线程推断。

## 12. Related Truth Sources

- [identity-service.md](../services/identity-service.md)
- [auth-service.md](../services/auth-service.md)
- [permission-service.md](../services/permission-service.md)
- [collaboration-service.md](../services/collaboration-service.md)
- [delegated-execution-and-action-grant.md](../collaborations/delegated-execution-and-action-grant.md)
- [task-assistant.md](../collaborations/task-assistant.md)
- [task-assistant-tool-contract.md](../../contracts/ai-platform/task-assistant-tool-contract.md)
