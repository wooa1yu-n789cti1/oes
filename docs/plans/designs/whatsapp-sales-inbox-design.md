# WhatsApp Sales Inbox Design Workspace

> 本文记录 WhatsApp 销售协作收件箱的设计想法冻结稿。它不定义 Phase 1 实施范围，不替代 `crm-service`、`sales-service`、`identity-service`、`public-entry-service` 或未来外部通信集成服务的稳定真相源；后续若进入实现，必须先回写 architecture / collaboration / contract，再通过一次 Delivery 决策卡确认。

## 0. 文档控制

```text
designKey: whatsapp-sales-inbox-design
designStatus: ACTIVE_DESIGN_WORKSPACE
implementationStatus: IDEA_ONLY
lastUpdatedAt: 2026-06-09 Asia/Shanghai
lastUpdatedBy: Codex thread
scopeStatus: idea-frozen-not-phase-1-plan
relatedTopic: WhatsApp Business Platform / Sales Inbox / CRM collaboration / Quote sending
excludes: WeChat / WeCom design, WhatsApp Web linked-device automation, implementation plan
truthSource: 
```

## 1. 当前冻结想法

OES 应支持一个租户绑定一个或多个 WhatsApp Business Platform 官方通道，其中一种核心场景是：

```text
一个租户只有一个销售 WhatsApp business number
多个业务员在 OES 内共享该号码
OES 通过内部会话归属、客户归属和权限控制避免重复跟进
业务员可在 Inbox 内查看 CRM 客户资料并发送已生成报价
```

该能力不是“每个业务员登录自己的 WhatsApp Web”，而是“企业官方 WhatsApp 号码进入 OES 销售协作工作台”。

## 2. 核心产品目标

- 让多个业务员可以共同使用同一个企业销售 WhatsApp 号码。
- 客户进入 WhatsApp 后，在 OES 内形成可分配、可认领、可转交、可审计的销售会话。
- 当某个客户已被业务员跟进时，其他业务员在 Inbox 中能看到跟进人或归属提示，避免重复开发。
- Inbox 内直接展示或关联 CRM 客户 / 线索资料，避免销售在 WhatsApp 与 CRM 之间反复切换。
- 报价完成后，业务员可从 Inbox 选择报价并发送给客户，发送行为回写 CRM activity 与消息审计。

## 3. 当前明确不做

- 不使用 WhatsApp Web / WhatsApp Business App linked-device 扫码会话作为 OES 后端集成方式。
- 不通过非官方协议、浏览器自动化或模拟客户端实现消息收发。
- 不把 WhatsApp access token、webhook secret、provider credential 保存进 Contact Asset。
- 不让 Contact Asset 拥有消息、会话、客户归属或报价发送真相。
- 不在本文讨论 WeChat / WeCom；微信相关设计另开主题。
- 不在本文承诺 Phase 1 的具体功能切片。

## 4. 概念拆分

| 概念 | 含义 | 初步 owner 倾向 |
| --- | --- | --- |
| `WhatsApp Channel Binding` | 租户授权给 OES 的 WABA / phone number 官方通道，包含 `wabaId`、`phoneNumberId`、显示号码、provider 状态、webhook 配置和 token 引用。 | 外部通信集成能力，后续 architecture 决策 |
| `Sales Inbox Conversation` | 某个客户与某个 WhatsApp channel 的销售会话，包含状态、分配、认领、转交和最近消息。 | communication / sales collaboration 能力，后续 architecture 决策 |
| `Sales Inbox Message` | 通过 WhatsApp channel 收发的消息记录，包含方向、provider message id、发送人、状态、审计信息。 | 通信能力，后续 architecture 决策 |
| `CRM Customer / Lead` | 客户、线索、负责人、客户归属与销售阶段真相。 | `crm-service` |
| `Quote` | 报价单、报价状态、报价 PDF / 链接 / 摘要真相。 | `sales-service` 或报价所属服务 |
| `WhatsApp Contact Asset` | 员工名片或员工资料上展示的 WhatsApp 联系入口。 | `identity-service` Contact Asset |

## 5. 推荐协作边界

### 5.1 WhatsApp Channel Binding

该能力只表达 OES 是否被授权代表某个企业 WhatsApp business number 收发消息。

候选字段：

```text
tenantId
provider = META_WHATSAPP_BUSINESS_PLATFORM
wabaId
phoneNumberId
displayPhoneNumber
verifiedName
qualityRating
status
tokenRef
webhookConfigRef
createdBy / updatedBy / audit metadata
```

约束：

- token 本体不得进入 Contact Asset。
- provider webhook secret、access token、refresh token 或 system user credential 必须走专门 secret 管理或受控配置能力。
- 一个 channel 可以被多个 OES 用户使用，具体可见性与发送权限由 OES RBAC / team assignment 控制。

### 5.2 Sales Inbox Conversation

该能力负责多人协作跟进，而不是拥有客户主数据。

候选字段：

```text
tenantId
channelBindingId
customerExternalId / customerWaId
crmLeadId
crmCustomerId
assignedOperatorId
ownerOperatorId
status
lastMessageAt
lastInboundAt
lastOutboundAt
claimState
audit metadata
```

典型状态：

```text
NEW
ASSIGNED
IN_PROGRESS
WAITING_CUSTOMER
WAITING_INTERNAL
QUOTE_SENT
CLOSED
```

设计口径：

- `assignedOperatorId` 表示当前会话处理人。
- `ownerOperatorId` 可映射 CRM 客户负责人或销售归属。
- 如果 CRM 已有 owner，Inbox 必须显示该 owner，避免重复开发。
- 其他业务员是否能查看完整内容、只看摘要、申请转交或不可见，应由权限与团队规则决定。

### 5.3 CRM Collaboration

Inbox 可以消费和更新 CRM 协作事实，但不拥有客户真相。

需要支持的协作：

- inbound WhatsApp message 到达时，尝试按 phone / wa id / tenant 规则匹配 CRM lead 或 customer。
- 未匹配时，可从 Inbox 创建或关联 CRM lead。
- 已匹配时，显示客户名称、负责人、阶段、最近活动、未结任务。
- 会话认领、转交或关闭可回写 CRM activity。
- WhatsApp 消息收发记录可作为 CRM activity 的来源之一。

### 5.4 Quote Collaboration

Inbox 可以发送报价，但不拥有报价真相。

建议流程：

```text
业务员在 Inbox 打开客户会话
选择该客户相关 Quote
OES 读取报价摘要、状态和可发送链接 / PDF
业务员确认发送
WhatsApp channel 发送消息或模板消息
发送结果回写 message status 与 CRM activity
```

约束：

- 只能发送允许对外发送的报价状态，例如 approved / issued。
- 报价正文、价格、有效期、币种等真相仍归报价服务。
- Inbox 不复制报价主数据，只保存发送引用和消息审计。

## 6. 用户体验想法

Inbox 列表中，每个客户会话应显示：

- 客户名称或 WhatsApp 显示名
- 当前跟进人
- CRM owner 或未分配提示
- 会话状态
- 最近消息摘要
- 是否已有报价
- 是否存在未读消息或超时未回复

会话详情页应包含：

- 左侧客户会话列表
- 中间消息流
- 右侧 CRM 客户资料 / 线索摘要 / 报价列表
- 操作区：认领、分配、转交、创建/关联客户、选择报价发送、内部备注

关键交互：

- 如果客户已有跟进人，其他业务员点击会话时应看到明显提示。
- 如果用户没有接管权限，只能查看摘要或请求转交。
- 发送报价前必须二次确认，避免误发价格信息。

## 7. 与 Contact Asset / BusinessCard 的关系

WhatsApp Contact Asset 仍只表示“这个员工或名片可展示哪个 WhatsApp 联系入口”。

```text
ContactAsset(type=WHATSAPP)
  -> 可选关联 channelBindingId
  -> 用于 BusinessCard OPEN_WHATSAPP
  -> 不保存 provider token
  -> 不拥有消息或客户归属
```

当 Contact Asset 关联了官方 channel binding 时，未来可以支持从名片 action 进入受控销售会话；但 BusinessCard 仍只保存 Contact Asset ref，不保存 WhatsApp 正文或消息状态。

## 8. 需要后续冻结的问题

- OES 是否需要一个独立 `communication-service`，还是 WhatsApp Sales Inbox 初期放入 `crm-service` / `sales-service` 的协作模块？
- 一个 WhatsApp channel 的可见性是按 tenant-wide、department、sales team，还是 role policy 控制？
- CRM owner 与 conversation assigned operator 冲突时，以谁为准？
- 未匹配客户是否自动创建 Lead，还是必须人工确认？
- 报价发送使用文本链接、PDF、模板消息，还是组合方式？
- WhatsApp 模板消息、24 小时 customer service window、opt-in、退订和合规模型如何治理？
- 消息附件、图片、语音、文件是否进入第一阶段，还是只支持文本和报价链接？
- 归档后的 WhatsApp conversation 与 CRM activity 的保留周期和审计要求是什么？

## 9. 冻结结论记录

| 日期 | 结论 | 状态 |
| --- | --- | --- |
| 2026-06-09 | 用户希望优先讨论 WhatsApp，不讨论 WeChat / WeCom。 | frozen |
| 2026-06-09 | 目标想法是一个租户可使用一个销售 WhatsApp business number，由多个 OES 业务员共享。 | frozen |
| 2026-06-09 | Inbox 应显示客户跟进人 / 归属，避免其他业务员重复开发同一客户。 | frozen |
| 2026-06-09 | Inbox 需要双向接入 CRM，并支持从会话中选择报价发送给客户。 | frozen |
| 2026-06-09 | WhatsApp Web linked-device 扫码登录不作为 OES 正式后端集成方向；优先官方 WhatsApp Business Platform / Cloud API。 | frozen |
| 2026-06-09 | 本文只冻结设计想法，不定义 Phase 1 实施范围。 | frozen |
