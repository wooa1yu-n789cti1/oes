# CRM Service Design Workspace

```text
designKey: CRM-SERVICE
designStatus: ACTIVE_DESIGN_WORKSPACE
truthSource: docs/architecture/services/crm-service.md
contractSource: docs/contracts/crm-service/README.md
writeBackTargets:
  - docs/architecture/services/crm-service.md
  - docs/architecture/collaborations/sales-crm-party-item-master.md
  - docs/contracts/crm-service/
  - docs/plans/backlog.md
```

## Current Goal

继续冻结 CRM v2 在 intake、prospecting、lead/customer conversion、Party usage、Opportunity、Activity 与 resource authorization 方面的未决边界。本文只记录当前开放问题，不复制已经回写的对象和 owner 真相。

## Open Questions

1. `Intake` 是否细分子类型，或先由 source + triage status 承接。
2. `LeadDraft -> Lead` 的正式交接契约。
3. `Lead -> CustomerAccount` 的转换命令、去重与审计语义。
4. `CustomerContactUsage` 与 person party 的绑定时机、治理流程和最小数据形态。
5. `CustomerAddressUsage` 对 Party 地址簿正文的引用方式。
6. primary contact/address 的唯一 active 约束及 inactive primary 处理。
7. `CustomerTaxProfile` 与 Finance payment term/tax truth 的边界。
8. `Opportunity` 阶段是否需要按行业配置。
9. CRM Activity 中的 Task 如何与 Collaboration Task 分工。
10. 批量导入默认进入 Intake，还是允许受控来源直接形成 Lead。
11. CRM resource owner/team facts 与 Permission query scope 的最小 contract。
12. `CrmAccount` 在 Draft Lead、Active Lead、Prospect Customer 与 Customer 阶段的字段编辑矩阵，以及绑定 `TenantParty` 后 official name、strong identifier、profile evidence 的 owner、修改、重新解析、纠错与审计边界；同时确认是否需要显式记录 party binding basis 与 evidence references。

## Candidate Feature Order

1. CRM customer master hardening and current v2 delta closure.
2. Party selector/binding and contact/address usage.
3. Intake/prospecting/lead conversion.
4. Customer tax/default terms and Sales selector integration.
5. Opportunity and Activity expansion.

## Exit Condition

每项决定冻结后先回写 [crm-service.md](../../architecture/services/crm-service.md)，再创建或更新对应 collaboration、contract 与 Feature Packet；本 Workspace 不保存实现状态或完成历史。
