# Task Assistant Collaboration

```text
status: FROZEN
frozenDate: 2026-07-28
lastAmendedDate: 2026-08-05
aiArchitectureTruthSource: docs/architecture/platforms/ai-platform.md
collaborationTruthSource: docs/architecture/services/collaboration-service.md
delegatedExecutionTruthSource: docs/architecture/collaborations/delegated-execution-and-action-grant.md
toolContractTruthSource: docs/contracts/ai-platform/task-assistant-tool-contract.md
predecessorDesignGate: FROZEN_AI_PLATFORM_TASK_ASSISTANT
registrationGate: FROZEN_TOOL_CONTRACT_REGISTRATION_READY
```

> 本文只冻结 Task Assistant 如何消费 AI 平台、Identity/Auth/Permission 与 Collaboration Task。它不重新定义任何服务职责、Task 对象、DG-4 credential、授权模型、API 字段或实现拓扑。

## 1. Scope

Task Assistant 是通用 AI 平台的第一个验证场景。第一阶段限定为 HUMAN 主动触发、人在回路的交互式 Copilot，用于：

- 查询当前 HUMAN 可见的 Task；
- 总结、排序、解释和提出处理建议；
- 生成待确认的 Task 动作；
- 在所有前置 gate 满足后，通过受控工具请求 owner-approved Task command。

第一阶段不支持无人值守执行、自动完成、Task event listener、recurrence、reminder、team queue、workflow human task 或 AI 自行判断业务完成。

## 2. Ownership

- AI platform owns：Task Assistant `AgentProfile`、模型/知识/工具编排、用户侧确认节点、ToolContract identity/version 与 AI Run。
- Identity owns：运行该 Profile 的 Machine Principal identity、scope 与 lifecycle。
- Auth owns：机器认证、ExecutionToken、DelegationGrant 与 ActionGrant credential lifecycle。
- Permission owns：HUMAN/MACHINE/DELEGATED authorization intersection 与 policy decision。
- Collaboration owns：Task、participant visibility、state transition、operation risk class、command idempotency、local audit、facts/events 与最终业务结果。

Task Assistant 不拥有或复制 Task、账号、角色、session、credential、policy 或业务审计真相。

Conversation 可以长期继续，但只承载上下文；每条新的用户指令创建新的 bounded AI Run。Run 完成、停止或过期后不能继续调用工具，未关闭 Conversation 也不会把 delegation 变成长期授权。

## 3. Business Ownership And Attribution

AI 代表 HUMAN 调用 Task capability 时：

- `createdByAccountId`、`assigneeAccountId` 与 Task participant semantics 继续引用 HUMAN account。
- AgentPrincipal 不成为 Task creator、assignee 或 participant。
- HUMAN 是业务责任主体；AgentPrincipal/Profile/ToolContract/delegation 是执行归因。
- Collaboration 继续按现有 participant rules 判断 read/update/start/complete/cancel/reopen/archive/unarchive。
- AI 平台不得通过 machine grant 或 prompt 绕过 HUMAN participant rule。

## 4. Read Flow

```text
HUMAN request
  -> trusted HUMAN + tenant context
  -> active AgentPrincipal and Task Assistant Profile
  -> delegated/read authorization upper bound
  -> registered Task read ToolContract
  -> collaboration-service ListTasks / GetTask
  -> current Task facts
  -> model explanation or proposal
```

稳定规则：

- Task Assistant 只消费 [task-query.md](../../contracts/collaboration-service/task-query.md) 的黑盒语义，不直接读取 Collaboration storage。
- ToolContract 必须比 HUMAN 权限更窄或相等，不能产生 admin/org/team bypass。
- 每次运行重新读取当前 Task facts；历史对话、模型上下文或知识索引不是 Task truth。
- read tool 未注册、principal/profile inactive、tenant mismatch 或授权拒绝时 fail closed。

## 5. Mutation Flow

```text
model proposes exact Task action
  -> HUMAN expresses exact execution intent
  -> resolve business-owner operation risk class
      -> DELEGATION_ALLOWED
           -> delegated authorization
           -> matching DELEGATED ExecutionToken
           -> controlled Task command
      -> ACTION_GRANT_REQUIRED
           -> exact confirmation / step-up when required
           -> matching ActionGrant + DELEGATED ExecutionToken
           -> controlled Task command
      -> AI_FORBIDDEN
           -> refuse; human-only flow
  -> collaboration-service validates participant rule and state transition
  -> collaboration-service commits idempotent business result
  -> AI reports the verified result
```

稳定规则：

- mutation 必须消费 [task-command.md](../../contracts/collaboration-service/task-command.md) 与 DG-4 冻结契约，不重新定义 command。
- AI 平台只展示和编排 owner-declared risk class，不得自行分类或降级。
- AI Platform 只展示 owner action facts；Auth 持有 HUMAN confirmation evidence。每个 high-risk business action 都单独确认，low-risk Run 不增加授权弹窗。
- ActionGrant 不能替代 Task participant rule、state transition、tenant isolation 或 idempotency。
- pending、timeout、tool error、authorization denial 和 confirmation denial 都不能被报告为业务成功；不确定结果显示为 pending，直到 Collaboration 返回明确 owner result。
- stop 取消当前 Run 的后续 work/pending confirmation，不回滚已提交 Task；Conversation 仍可继续并以新 Run 处理下一条指令。
- 长期无人值守自动化必须使用独立 MACHINE workflow，不能保留 HUMAN DelegationGrant。

## 6. Frozen Contract Surfaces

Task Assistant 使用唯一 AI-owned registration contract：[task-assistant-tool-contract.md](../../contracts/ai-platform/task-assistant-tool-contract.md)。其 immutable identity/version 固定为：

```text
toolContractId: oes.ai.task-assistant.collaboration-task
version: 1.0.0
```

精确 registered operation set 只有：

| Tool operation key | Owner surface | Owner-declared risk | Registration phase |
| --- | --- | --- | --- |
| `collaboration.task.list.v1` | Task Query `ListTasks` | `DELEGATION_ALLOWED` | registered, runtime disabled |
| `collaboration.task.get.v1` | Task Query `GetTask` | `DELEGATION_ALLOWED` | registered, runtime disabled |
| `oes.ai.task-assistant.draft-task-create.v1` | no command; proposal only | not applicable | registered, runtime disabled |
| `collaboration.task.create-self.v1` | Task Command `CreateTask` self todo variant | `DELEGATION_ALLOWED` | registered, mutation disabled |
| `collaboration.task.create-assigned.v1` | Task Command `CreateTask` assigned variant | `ACTION_GRANT_REQUIRED` | registered, mutation disabled |

Risk class remains owned by Collaboration and is consumed through the immutable v1 owner risk source declared by [task-assistant-tool-contract.md](../../contracts/ai-platform/task-assistant-tool-contract.md); the AI registration cannot modify it. `UpdateTask`、`StartTask`、`CompleteTask`、`CancelTask`、`ReopenTask`、`ArchiveTask` 与 `UnarchiveTask` are absent and therefore unregistered; their Task Assistant P1 classification remains `AI_FORBIDDEN` in that owner risk source.

The repository registration manifest is not runtime authorization truth. Before runtime opening, AI Platform must expose an owner runtime resolution contract for the active ToolContract identity/version and operation upper bound; Auth consumes that contract together with Identity-owned AgentPrincipal facts. Auth and Permission never authorize by reading the disabled registration JSON.

Registration phase invariants：

- `registrationState = REGISTERED_DISABLED`；
- `runtimeExecutionEnabled = false`；
- `mutationExecutionEnabled = false`；
- `publicExposureEnabled = false`；
- no service binding、runtime adapter、proto、schema、Gateway route、provider、UX or orchestration topology。

This phase does not wait for ActionGrant runtime because it cannot execute. Any later runtime opening requires a separately accepted candidate and all predecessor gates in section 9.

## 7. Business Data And Knowledge

- Task title、status、participant、priority、due time 与其他实时事实只从 Collaboration Query 获取。
- AI 平台不复制 Task 主数据，不把 Task 向量索引当作事实源。
- 企业制度、SOP 与手册若被场景使用，必须由统一知识能力进行 tenant/org/visibility/source/version 过滤并返回引用。
- 输出必须区分 Task 实时事实、企业知识和模型推断。
- 未来 Task projection/event integration 需要单独设计，不属于本协同。

## 8. Audit Chain

一次执行通过关联引用串起下列 owner facts：

- AI：Profile/model/knowledge/tool proposal/invocation/confirmation/cost/result summary。
- Auth：DelegationGrant/ActionGrant create, deny, revoke, expire and issue facts。
- Permission：delegated authorization decision and policy/version references。
- Collaboration：Task command audit、state transition、idempotency 与最终 business outcome。

AI 只能在收到 Collaboration 的明确成功结果后报告业务成功。审计记录不得包含 credential、ActionGrant 正文、secret 或不必要的敏感 Task/prompt 全文。

## 9. Implementation Gates

- `FROZEN_AI_PLATFORM_TASK_ASSISTANT` remains the predecessor architecture-freeze gate；`FROZEN_TOOL_CONTRACT_REGISTRATION_READY` is its registration-surface successor and requires the AI-owned contract to have entered main。
- registration artifact may be implemented before ActionGrant runtime only while every execution/public flag remains disabled。
- runtime opening waits for `EXEC-CRYPTO MAIN_READY`、DG-4 runtime and Collaboration Task runtime/query/command readiness。
- runtime opening also waits for the AI-owned ToolContract runtime resolver and Common registration of all required INTERNAL Codes; a disabled manifest alone is insufficient。
- mutation opening additionally waits for target-side descriptor/idempotency/ActionGrant-consumption readiness。
- knowledge-backed slice 等待 governed knowledge owner readiness。
- 新 service/proto/operator context/permission/public gateway changes 必须另获 truth-source 与 path ownership。

## 10. Non-goals

- 不决定 AI 服务数量、部署拓扑、数据库或模型供应商。
- Task Assistant 不自行修改 Task object、status、participant visibility、owner risk class、Permission Code 或 DG-4 owner contracts；本文件只引用各 owner 已冻结的事实与 readiness gate。
- 不定义新的 DG-4 credential、claim、error 或 cryptography。
- 不建立长期记忆、多 Agent、后台自动化或 Task event consumer。
- 不把观测系统、prompt 或向量库当作审计或业务真相源。
