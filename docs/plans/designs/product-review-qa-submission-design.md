# Product Review and Q&A Submission Design

## 0. 文档控制

```text
designKey: product-review-qa-submission
designStatus: ACTIVE_DESIGN_WORKSPACE
implementationStatus: IDEA_ONLY
lastUpdatedAt: 2026-07-08 21:45:00 Asia/Shanghai
lastUpdatedBy: Codex PDP frontend thread
supersedes: PDP review/Q&A inline discussion in storefront implementation thread
truthSource:
conflictResolution: 当本文与更早口头讨论冲突时，以本文 lastUpdatedAt 之后的冻结结论为准；若后续 architecture / ADR / contracts 明确覆盖本文，以稳定真相源为准。
```

## 1. 目标

- 记录 PDP `Write a review` 与 `Ask a question` 的后置 OES 设计方向。
- 当前 PDP 前端先冻结入口、表单体验与 mock submission。
- OES 后台、服务归属、审核流、媒体上传、订单验证与第三方评价来源接入后置到新线程设计。

## 2. 当前范围

- 本 workspace 负责：
  - review / Q&A submission 的产品方向、状态流与 OES 协同边界。
  - 后续设计线程恢复上下文。
- 本 workspace 不负责：
  - 定义正式数据库 schema。
  - 定义 gRPC/proto/API 契约。
  - 决定最终服务归属。
  - 实现后台审核工作台。

## 3. 已确认方向

- PDP 前端入口：
  - `Write a review` 打开 review submission modal。
  - `Ask a question` 打开 Q&A submission modal。
  - 当前只做 mock success，不写入后端。
- Review submission 应包含：
  - rating、title、content、display name、email、country/region。
  - 支持图片/视频附件，但正式媒体上传后置。
  - 订单号或购买邮箱可用于后续 `Verified buyer` 判断。
- Q&A submission 应包含：
  - question、display name、email。
  - 可选择回答后邮件通知。
- 提交后的正式状态不应直接公开，应进入审核/回复队列。

## 4. 后置 OES 设计问题

- 服务归属：
  - 候选能力名：customer content / UGC / product experience content。
  - 需要确认是否独立服务，还是归入 site-service 的 public content 管理能力。
- 状态流：
  - review: `draft -> pending -> approved | rejected | hidden`
  - question: `pending -> answered -> published | rejected | hidden`
- 审核与治理：
  - 人工审核、敏感词、垃圾内容识别、媒体审核。
  - 评价真实性与 `Verified buyer` 证据链。
  - 第三方来源标记，例如 Bazaarvoice、Trustpilot、Google Reviews。
- 与 OES 协同：
  - 订单/客户数据只通过受控查询或防腐层验证，不允许 PDP runtime 直接查业务库。
  - 媒体资源应进入受控 asset pipeline。
  - 审核动作必须记录 operator context、tenantId、trace context 与审计元数据。

## 5. 后续推荐线程

- 新开 OES 设计线程：`product-review-qa-submission`
- 先冻结：
  - 服务/能力归属
  - review 与 Q&A 状态机
  - 后台审核工作台需求
  - PDP runtime API 边界
  - 媒体上传与审核链路
- 冻结必要设计与 contracts 后，通过一次 Delivery 决策卡进入实现，并由 task-owned DP 承载执行状态。
