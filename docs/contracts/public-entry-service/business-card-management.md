# BusinessCard Management Contract

> 服务设计唯一真相源：[public-entry-service.md](../../architecture/services/public-entry-service.md)。本文只描述 Phase 1 BusinessCard 管理端黑盒契约，不重新定义 HR、Identity Contact Asset、ShortLink、Tenant Org、Permission 或 CRM owner 边界。

## 1. Purpose

Defines Phase 1 admin management contracts for employee digital business cards.

It answers:

```text
管理员如何查看、启用、禁用、配置一张员工数字名片，并检查它是否可以公开展示？
```

## 2. Control Model

Trusted gRPC cutover 后，tenant/operator/trace/audit identity 只来自 verified execution context。本文 request JSON 中出现的 `tenantId` 与 `operatorContext` 仅是 `LEGACY_PRE_CUTOVER` 标注字段，不属于当前 supported request payload；阅读示例时必须删除这些属性。准确字段删除/保留号码及 10 个 admin RPC 的 Code 以 [README §3](README.md#3-trusted-grpc-23-rpc-contract) 为准。

Legacy pre-cutover examples below show the old authority envelope for historical comparison only. Current supported requests carry only business payload; tenant/operator/trace/audit facts come from the verified execution context.

Legacy pre-cutover management envelope:

```json
{
  "tenantId": "tenant_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_001"
  }
}
```

Rules:

- Caller boundary must enforce permission-service authorization.
- Commands must carry audit metadata.
- BusinessCard does not own permission truth.
- BusinessCard management uses permission-service authorization as:
  - `checkPermission`
  - tenant isolation
  - BusinessCard domain rules
- Phase 1 permission codes:
  - `public-entry.business-card.read`
  - `public-entry.business-card.manage`
  - `public-entry.business-card.enable`
  - `public-entry.business-card.disable`
  - `public-entry.business-card.public-entry.manage`
  - `public-entry.business-card.stats.read`
- `public-entry.business-card.preview` is not a Phase 1 permission code; admin preview/read-only diagnostics are covered by `public-entry.business-card.read`, and public preview does not use permission-service.
- `public-entry.business-card.self.read` is not a Phase 1 permission code; employee self-view uses authenticated self-bound access.

Admin scope rules:

- Tenant isolation is mandatory; `card.tenantId` must equal `operatorContext` tenant.
- Phase 1 admin scope is tenant-wide: if the operator has the required BusinessCard permission code in the tenant, the operator may access and manage all BusinessCards in that tenant.
- Phase 1 does not apply org subtree, department, employee-owner, or HR employee scope filters for BusinessCard admin management.
- List queries are restricted to the requested tenant after `public-entry.business-card.read` passes.
- Detail, update, enable, disable, public-entry binding and stats queries must load the card by `tenantId + businessCardId`; cross-tenant ids are `NOT_FOUND` / denied before mutation.
- Permission-service owns permission-code truth; HR / Tenant Org own employee/org facts, but those facts are not used for Phase 1 admin scope.

## 3. Shared Shapes

### 3.1 BusinessCardStatus

```text
DRAFT
ACTIVE
DISABLED
ARCHIVED
```

Rules:

- `DRAFT` / `DISABLED` cards are not publicly available.
- `ACTIVE` cards still require resolver readiness and active employee checks.
- `ARCHIVED` cards are historical and not restored in Phase 1.

### 3.2 ContactActionType

```text
CALL_PHONE
SEND_EMAIL
ADD_WECHAT
OPEN_WHATSAPP
SAVE_VCARD
OPEN_COMPANY_WEBSITE
```

Rules:

- BusinessCard Phase 1 does not support custom link actions.
- Button labels are renderer-owned by `contactActionType` and locale.
- Product catalog, quote, request contact, booking, social media and map actions are not Phase 1 actions.

### 3.3 ContactActionTargetRef

```json
{
  "targetRefType": "CONTACT_ASSET",
  "targetRefId": "ca_001"
}
```

```json
{
  "targetRefType": "TENANT_PUBLIC_PROFILE",
  "targetRefId": "tenant_profile_001"
}
```

```json
{
  "targetRefType": "NONE",
  "targetRefId": null
}
```

Rules:

- `CALL_PHONE / SEND_EMAIL / ADD_WECHAT / OPEN_WHATSAPP` use `CONTACT_ASSET`.
- `SAVE_VCARD` uses `NONE`.
- `OPEN_COMPANY_WEBSITE` uses `TENANT_PUBLIC_PROFILE` or the tenant/company public profile reference accepted by the public render boundary.
- `CONTACT_ASSET` references identity-service Contact Asset truth; BusinessCard must not store phone, email, WeChat, WhatsApp, handle, externalRef or display value.
- Contact Asset owner, type, ownership and status are governed by [contact-asset-design.md](../../plans/designs/contact-asset-design.md) and [identity-service.md](../../architecture/services/identity-service.md).

### 3.4 ContactActionConfig

```json
{
  "contactActionType": "CALL_PHONE",
  "targetRefType": "CONTACT_ASSET",
  "targetRefId": "ca_phone_001",
  "visibility": "PUBLIC",
  "displayOrder": 10,
  "enabled": true,
  "includeInVCard": true
}
```

Rules:

- `displayOrder` is unique within one BusinessCard.
- `visibility` is BusinessCard display config; Phase 1 uses `PUBLIC` / `HIDDEN`.
- `includeInVCard` only has effect for fields visible in `PublicBusinessCardView`.
- `enabled = false` hides the action in public render and excludes it from vCard.
- Missing `targetRefId` hides `CONTACT_ASSET` actions and appears as admin readiness diagnostics; it does not store or infer contact正文。
- `SAVE_VCARD` and `OPEN_COMPANY_WEBSITE` do not point to a personal Contact Asset.
- A configured action can be hidden at public render time when its target is not currently displayable.
- BusinessCard may validate target type compatibility during readiness check, but Contact Asset truth remains in identity-service.

### 3.5 VisibilityConfig

```json
{
  "showTitle": true,
  "showDepartment": true,
  "showCompany": true,
  "showOfficialPhoto": true
}
```

Rules:

- Visibility config controls display, not upstream field truth.
- Hidden fields must not appear in vCard.

### 3.6 PublicEntryRef

```json
{
  "publicEntryId": "sl_001",
  "shortCode": "CF26ZS1",
  "publicUrl": "https://go.oes.com/c/CF26ZS1",
  "qrContent": "https://go.oes.com/c/CF26ZS1",
  "status": "ACTIVE",
  "expiresAt": null
}
```

Rules:

- This is a local reference to ShortLink output.
- ShortLink status and expiresAt semantics are owned by ShortLink.
- `qrContent` equals `publicUrl`.

### 3.7 ReadinessReason

```text
READY
CARD_DISABLED
EMPLOYEE_NOT_FOUND
EMPLOYEE_NOT_ACTIVE
DISPLAY_NAME_MISSING
COMPANY_DISPLAY_MISSING
PUBLIC_ENTRY_MISSING
TEMPLATE_UNAVAILABLE
CONTACT_TARGET_UNAVAILABLE
UPSTREAM_TEMPORARILY_UNAVAILABLE
```

Rules:

- Readiness reasons are admin diagnostics.
- Public anonymous responses must not expose these details.
- `CARD_DISABLED`、`EMPLOYEE_NOT_ACTIVE`、`EMPLOYEE_NOT_FOUND`、`DISPLAY_NAME_MISSING`、`COMPANY_DISPLAY_MISSING`、`PUBLIC_ENTRY_MISSING`、`TEMPLATE_UNAVAILABLE` and `UPSTREAM_TEMPORARILY_UNAVAILABLE` block enable / public readiness.
- `CONTACT_TARGET_UNAVAILABLE` usually hides optional Contact Actions; it blocks enable only when tenant policy or admin action requires that action to be present.
- Public render maps detailed reasons to generic public states: `PUBLIC_CARD_UNAVAILABLE` or `PUBLIC_CARD_NOT_FOUND`.

## 4. BusinessCardSummary

```json
{
  "businessCardId": "card_001",
  "tenantId": "tenant_001",
  "employeeId": "emp_001",
  "status": "ACTIVE",
  "templateKey": "TENANT_STANDARD",
  "publicEntryRef": {
    "publicEntryId": "sl_001",
    "shortCode": "CF26ZS1",
    "publicUrl": "https://go.oes.com/c/CF26ZS1",
    "qrContent": "https://go.oes.com/c/CF26ZS1",
    "status": "ACTIVE",
    "expiresAt": null
  },
  "updatedAt": "2026-06-08T10:00:00Z"
}
```

Rules:

- Summary must not include phone, email, WeChat, WhatsApp or other contact正文。
- Employee display fields may appear only as upstream summaries, not BusinessCard truth.

## 5. ListBusinessCards

Purpose:

- List employee business cards for admin management.

Permission:

- `public-entry.business-card.read`
- Return all cards in the tenant after the read permission passes.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "employeeStatus": "ACTIVE",
  "cardStatus": "ACTIVE",
  "pageSize": 20,
  "pageToken": null,
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_list_001"
  }
}
```

Response:

```json
{
  "cards": [
    {
      "businessCardId": "card_001",
      "tenantId": "tenant_001",
      "employeeId": "emp_001",
      "status": "ACTIVE",
      "templateKey": "TENANT_STANDARD",
      "publicEntryRef": {
        "publicEntryId": "sl_001",
        "shortCode": "CF26ZS1",
        "publicUrl": "https://go.oes.com/c/CF26ZS1",
        "qrContent": "https://go.oes.com/c/CF26ZS1",
        "status": "ACTIVE",
        "expiresAt": null
      },
      "updatedAt": "2026-06-08T10:00:00Z"
    }
  ],
  "nextPageToken": null
}
```

## 6. GetBusinessCard

Purpose:

- Return one card configuration and admin diagnostics.

Permission:

- `public-entry.business-card.read`
- Card must belong to the requested tenant after the read permission passes.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_get_001"
  }
}
```

Response:

```json
{
  "card": {
    "businessCardId": "card_001",
    "tenantId": "tenant_001",
    "employeeId": "emp_001",
    "status": "ACTIVE",
    "templateKey": "TENANT_STANDARD",
    "visibilityConfig": {
      "showTitle": true,
      "showDepartment": true,
      "showCompany": true,
      "showOfficialPhoto": true
    },
    "contactActions": [
      {
        "contactActionType": "CALL_PHONE",
        "targetRefType": "CONTACT_ASSET",
        "targetRefId": "ca_phone_001",
        "visibility": "PUBLIC",
        "displayOrder": 10,
        "enabled": true,
        "includeInVCard": true
      }
    ],
    "publicEntryRef": {
      "publicEntryId": "sl_001",
      "shortCode": "CF26ZS1",
      "publicUrl": "https://go.oes.com/c/CF26ZS1",
      "qrContent": "https://go.oes.com/c/CF26ZS1",
      "status": "ACTIVE",
      "expiresAt": null
    },
    "readiness": {
      "ready": true,
      "reasons": ["READY"]
    }
  }
}
```

## 7. UpdateBusinessCardConfig

Purpose:

- Update visibility and Contact Action configuration for one card.

Permission:

- `public-entry.business-card.manage`
- Card must belong to the requested tenant after the manage permission passes.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "visibilityConfig": {
    "showTitle": true,
    "showDepartment": true,
    "showCompany": true,
    "showOfficialPhoto": true
  },
  "contactActions": [
    {
      "contactActionType": "CALL_PHONE",
      "targetRefType": "CONTACT_ASSET",
      "targetRefId": "ca_phone_001",
      "visibility": "PUBLIC",
      "displayOrder": 10,
      "enabled": true,
      "includeInVCard": true
    },
    {
      "contactActionType": "SAVE_VCARD",
      "targetRefType": "NONE",
      "targetRefId": null,
      "visibility": "PUBLIC",
      "displayOrder": 50,
      "enabled": true,
      "includeInVCard": false
    }
  ],
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_update_001"
  }
}
```

Response:

```json
{
  "card": {
    "businessCardId": "card_001",
    "status": "DISABLED",
    "readiness": {
      "ready": true,
      "reasons": ["READY"]
    },
    "updatedAt": "2026-06-08T10:10:00Z"
  }
}
```

Rules:

- Command must audit before / after.
- Command must not write Contact Asset values.
- `CONTACT_ASSET` targets must be validated through identity-service Contact Asset query boundary when available.
- Invalid target type for action returns validation error.

## 8. GetBusinessCardMainPublicEntry

Purpose:

- Return the card's main ShortLink / Public Entry summary.

Permission:

- `public-entry.business-card.read`
- Card must belong to the requested tenant after the read permission passes.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_public_entry_001"
  }
}
```

Response:

```json
{
  "businessCardId": "card_001",
  "publicEntryRef": {
    "publicEntryId": "sl_001",
    "shortCode": "CF26ZS1",
    "publicUrl": "https://go.oes.com/c/CF26ZS1",
    "qrContent": "https://go.oes.com/c/CF26ZS1",
    "status": "ACTIVE",
    "expiresAt": null
  }
}
```

Rules:

- Summary is read from the ShortLink-admin contract or BusinessCard's local reference after binding.
- BusinessCard does not reinterpret ShortLink `status` or `expiresAt` semantics.
- Missing main public entry returns `PUBLIC_ENTRY_MISSING` in readiness diagnostics.

## 9. BindOrRefreshBusinessCardMainPublicEntry

Purpose:

- Create, bind, or refresh the card's main ShortLink / Public Entry reference.

Permission:

- `public-entry.business-card.public-entry.manage`
- Card must belong to the requested tenant after the public-entry manage permission passes.
- This BusinessCard permission lets the BusinessCard application consume ShortLink internally; it does not grant generic `public-entry.short-link.create`.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_bind_entry_001"
  }
}
```

Response:

```json
{
  "businessCardId": "card_001",
  "publicEntryRef": {
    "publicEntryId": "sl_001",
    "shortCode": "CF26ZS1",
    "publicUrl": "https://go.oes.com/c/CF26ZS1",
    "qrContent": "https://go.oes.com/c/CF26ZS1",
    "status": "ACTIVE",
    "expiresAt": null
  },
  "readiness": {
    "ready": true,
    "reasons": ["READY"]
  }
}
```

Rules:

- Command consumes ShortLink create / bind capability with `targetKind = INTERNAL_REF`、`targetType = BUSINESS_CARD`、`targetResourceId = businessCardId`.
- Command must be application-level idempotent for one card's main public entry, even if ShortLink does not freeze `idempotencyKey` as a named contract field.
- Command must audit before / after.
- Command does not create BusinessCard display data or Contact Asset values.

## 10. EnableBusinessCard

Purpose:

- Make one card publicly eligible.

Permission:

- `public-entry.business-card.enable`
- Card must belong to the requested tenant after the enable permission passes.
- Enable is intentionally independent from `public-entry.business-card.manage`.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_enable_001"
  }
}
```

Response:

```json
{
  "businessCardId": "card_001",
  "status": "ACTIVE",
  "readiness": {
    "ready": true,
    "reasons": ["READY"]
  }
}
```

Rules:

- Enable must run readiness check.
- Enable must fail if required readiness fails.
- Enable does not enable the ShortLink if ShortLink is disabled; ShortLink lifecycle remains ShortLink-owned.
- Command must audit before / after.

## 11. DisableBusinessCard

Purpose:

- Stop one card from public display.

Permission:

- `public-entry.business-card.disable`
- Card must belong to the requested tenant after the disable permission passes.
- Disable is intentionally independent from `public-entry.business-card.manage`.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "reason": "Employee requested temporary pause",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_disable_001"
  }
}
```

Response:

```json
{
  "businessCardId": "card_001",
  "status": "DISABLED"
}
```

Rules:

- Disable does not delete the card.
- Disable does not archive ShortLink by default.
- Public resolver returns `UNAVAILABLE` for disabled cards.
- Command must audit before / after.

## 12. RunBusinessCardReadinessCheck

Purpose:

- Return admin-visible readiness diagnostics without changing card status.

Permission:

- `public-entry.business-card.read`
- Card must belong to the requested tenant after the read permission passes.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_ready_001"
  }
}
```

Response:

```json
{
  "businessCardId": "card_001",
  "ready": false,
  "reasons": [
    "CONTACT_TARGET_UNAVAILABLE"
  ],
  "actionDiagnostics": [
    {
      "contactActionType": "CALL_PHONE",
      "targetRefType": "CONTACT_ASSET",
      "targetRefId": "ca_phone_001",
      "displayable": false,
      "hiddenReason": "CONTACT_TARGET_UNAVAILABLE"
    }
  ]
}
```

Rules:

- Readiness diagnostics are admin-only.
- Public resolver must not expose readiness reason details.
- Optional action failures may return `ready = true` with action diagnostics when required display data is available and public page can render.

## 13. GetBusinessCardVisitSummary

Purpose:

- Return ShortLink lightweight visit summary for the card main public entry.

Permission:

- `public-entry.business-card.stats.read`
- Card must belong to the requested tenant after the stats permission passes.

Request (`LEGACY_PRE_CUTOVER`; current wire request carries business fields only):

```json
{
  "tenantId": "tenant_001",
  "businessCardId": "card_001",
  "operatorContext": {
    "operatorAccountId": "acc_admin",
    "operatorOrgId": "org_001",
    "traceId": "trace_stats_001"
  }
}
```

Response:

```json
{
  "businessCardId": "card_001",
  "publicEntryId": "sl_001",
  "summary": {
    "shortLinkId": "sl_001",
    "totalVisits": 128,
    "byResultStatus": {
      "REDIRECTED": 120,
      "EXPIRED": 0,
      "DISABLED": 8,
      "ARCHIVED": 0,
      "INVALID_TARGET": 0
    },
    "byDetectedChannel": {
      "WECHAT": 92,
      "BROWSER": 34,
      "UNKNOWN": 2
    },
    "byDeviceType": {
      "MOBILE": 120,
      "DESKTOP": 8
    },
    "lastVisitedAt": "2026-06-08T15:30:00Z"
  }
}
```

Rules:

- Summary shape follows ShortLink admin management contract.
- BusinessCard does not own VisitEvent or aggregate model.

## 14. Error Semantics

| Condition | Error |
| --- | --- |
| businessCardId not found in tenant | `NOT_FOUND` |
| card archived and command cannot apply | `INVALID_STATE` |
| invalid action type / targetRef combination | `INVALID_ARGUMENT` |
| Contact Asset reference unavailable, mismatched or not allowed for this card | `CONTACT_TARGET_UNAVAILABLE` |
| Enable readiness failed | `READINESS_FAILED` with admin reasons |
| Upstream HR / Identity / Tenant Org temporarily unavailable | `UPSTREAM_UNAVAILABLE` |

Rules:

- Errors are management-side diagnostics.
- Public anonymous resolver uses generic unavailable behavior.
