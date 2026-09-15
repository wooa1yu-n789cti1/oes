# Communication And Mailbox Design Workspace

```text
designKey: COMMUNICATION-MAILBOX
designStatus: ACTIVE_DESIGN_WORKSPACE
truthSource: docs/architecture/platforms/communication-and-mailbox.md
writeBackTargets:
  - docs/architecture/services/communication-service.md
  - docs/architecture/collaborations/communication-notification.md
  - docs/contracts/communication-service/
  - docs/plans/backlog.md
```

## Goal

把共享邮箱和外部通信工作台从项目级边界推进到可冻结的 service、contract 与 P1 feature；本 Workspace 不作为服务或 proto 真相源。

## Confirmed Boundary

- Communication 管理外部沟通过程、线程、责任、状态、SLA、业务关联与归档。
- Notification 负责外发投递、模板、provider、重试与回执。
- 原始邮件/RFC 内容必须保留；展示层使用消息化 thread view 并折叠历史引用。
- 共享邮箱的 assignee、handling state 与 SLA 是统一事实，不按成员各自复制。
- 业务对象仍由 CRM/SRM/Sales/Finance 等 owner 服务拥有，Communication 只保存受控引用。
- AI 首期只能阅读、总结、分类和拟回复；发送及状态改变需要 HUMAN 确认和正常授权。

## Open Questions

1. 是否正式建立粗粒度 `communication-service`，以及 P1 是否只覆盖 Email。
2. `Mailbox / CommunicationThread / CommunicationMessage / Assignment / BusinessLink` 的最小 owner 模型。
3. mailbox membership、claim/transfer、visibility 与管理员治理权限。
4. inbound provider/webhook、原始 RFC 保存、正文清洗、附件与去重边界。
5. thread correlation、subject/reference fallback 与人工 merge/split 的审计语义。
6. SLA clock、waiting-external pause、escalation 与 timezone/calendar 规则。
7. business link 的 target validation 与反向查询契约。
8. outbound draft、HUMAN confirmation、Notification dispatch 与 delivery result 的边界。
9. retention、legal hold、export、redaction 与敏感信息访问。

## Next Freeze

先冻结 service owner 与 Email-only P1 aggregate，再冻结最小 contract。不得直接复用旧 proto 草稿或把全部 channel、AI、搜索、归档治理一次性加入 P1。
