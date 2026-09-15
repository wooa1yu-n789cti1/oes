# After-Sales Service Design Workspace

```text
designKey: AFTER-SALES-SERVICE
designStatus: ACTIVE_LONG_TERM_DESIGN
implementationStatus: DEFERRED
```

> 本文只记录当前设计讨论，不是稳定架构、contract 或 implementation plan。

## 1. Goal

This workspace captures the draft direction for a future `after-sales-service`.

The service is intentionally deferred from phase 1 implementation. The current goal is to preserve confirmed thinking so the project can continue higher-priority business foundations without losing the after-sales context.

## 2. Working Scope

`after-sales-service` is expected to own customer after-sales case lifecycle, not customer master data, not inventory truth, and not finance truth.

Likely owned capabilities:

- Customer return request.
- Complaint and issue intake.
- Replacement / resend request.
- Repair request.
- Warranty claim.
- Compensation / allowance request.
- After-sales SLA tracking.
- Case evidence, communication summary, and resolution history.
- Escalation to Quality, WMS, Fulfillment, Finance, CRM, or Procurement when needed.

Likely not owned:

- Customer master profile and contacts, owned by `crm-service`.
- Party truth, owned by `party-service`.
- Physical return receipt and inventory ledger, owned by `wms-service`.
- Refund, credit, payment, and receivable adjustment truth, owned by `finance-service`.
- Product quality case investigation truth, owned by future `quality-service`.
- Sales order truth, owned by `sales-service`.

## 3. Confirmed Decisions

| Date | Decision |
| --- | --- |
| 2026-04-30 | After-sales should be a long-term independent service, but not phase 1 implementation scope. |
| 2026-04-30 | Customer return starts as a request object; approval / rejection / partial approval can stay in the same request object for simplicity. |
| 2026-04-30 | WMS creates receipt only after returned goods physically arrive; after-sales request approval is not inventory truth. |
| 2026-04-30 | Shipped SalesOrder / DeliveryPlan / WMS outbound history should not be modified by after-sales. Returns and compensation are separate follow-up objects. |
| 2026-04-30 | A flow view can show SalesOrder -> DeliveryPlan -> WMS outbound -> after-sales request -> WMS return receipt -> finance refund / credit summary, but the view is not a truth owner. |
| 2026-04-30 | Customer service is a role / workspace across CRM, Sales, Fulfillment, and After-sales; it should not force CRM to own after-sales cases. |

## 4. Draft Object Model

### AfterSalesCase

Top-level case container for after-sales work. It should group the customer, source order / delivery / product references, issue category, owner, SLA, current status, evidence, communication summary, and linked resolution objects.

### CustomerReturnRequest

Customer request to return goods. Phase 1 draft design should keep request, review decision, and result in one object to avoid premature split into return authorization.

Candidate status:

- `REQUESTED`
- `NEEDS_MORE_EVIDENCE`
- `APPROVED`
- `PARTIALLY_APPROVED`
- `REJECTED`
- `RETURN_IN_PROGRESS`
- `RECEIVED`
- `CLOSED`

### CustomerComplaint

Customer-reported issue or dissatisfaction. A complaint may remain purely service-related, or it may be marked as quality-related and escalated to `quality-service`.

### WarrantyClaim

Warranty-related claim. It should reference product trace identity when available, such as serial number, barcode, QR code, product instance, delivery record, or SalesOrderLine.

### RepairRequest

Repair workflow request. Future scope may include service task assignment, field service, spare part usage, and repair result.

### ReplacementRequest

Replacement / resend request. It should not directly write shipment or inventory truth; it should coordinate with Fulfillment / WMS through explicit future integration.

### CompensationRequest

Allowance, discount, refund, credit, or commercial compensation request. Finance owns the financial transaction truth; after-sales owns the service resolution request and evidence.

## 5. Product Traceability And Warranty

Warranty and authenticity checks are important future requirements.

Future after-sales should be able to answer:

- Which product was sold to which customer.
- When it was shipped or delivered.
- Whether the product is still under warranty.
- Whether the barcode / QR code / serial belongs to our product.
- Which order, batch, production record, or supplier source is related.

Open owner question:

- Product instance / serial-level traceability may need a dedicated traceability capability or a collaboration among WMS, MES, Item Master, Sales, and After-sales.
- After-sales should consume traceability and warranty eligibility snapshots; it should not become the physical product trace truth owner by default.

## 6. Escalation And Collaboration

After-sales should classify the suspected responsibility and route the case without taking over other service truths.

Candidate routing:

- Product defect -> `quality-service` case.
- Repeated product issue -> quality trend / improvement analysis.
- Packaging error -> Quality / WMS / MES / packaging collaboration.
- Wrong item, missing item, shipping damage -> WMS / Fulfillment collaboration.
- Delivery delay or partial delivery dispute -> Fulfillment / Planning / Procurement collaboration.
- Usage or installation issue -> knowledge base / service support.
- Supplier material issue -> Quality + SRM / Procurement collaboration.
- Refund / credit / allowance -> Finance financial action.

`quality-service` should own formal quality investigation and corrective action. After-sales owns the customer-facing case and communication state.

## 7. SLA And Performance

After-sales should record response and resolution timing facts:

- First response time.
- Evidence requested time.
- Decision time.
- Resolution completion time.
- Overdue status and reason.

These facts may later feed customer service KPI, HR performance, or BI analysis. After-sales should not own salary or performance scoring truth.

## 8. Knowledge And AI Deferred Direction

Future deferred capabilities:

- High-frequency issue extraction.
- FAQ / knowledge base.
- AI-assisted customer reply draft.
- AI-assisted evidence checklist.
- AI risk warning for repeated complaints or abnormal claims.

AI must not directly approve after-sales resolutions or write core business truth. Any state-changing action should remain auditable and human-controlled.

## 9. Deferred Features

- Full after-sales-service implementation.
- Customer portal / mini program after-sales self-service.
- Dealer after-sales flow.
- No-order after-sales case.
- Product instance / serial traceability contract.
- Warranty policy engine.
- RMA-style separate authorization object.
- Refund / credit lifecycle integration.
- Service task / field service execution.
- Spare parts consumption.
- Full quality-service integration.
- Knowledge base and AI support.
- External platform after-sales connector.

## 10. Open Questions

- Should `CustomerReturnRequest` stay as the long-term object, or later split into request + authorization?
- Where should serial-level product instance truth live?
- How should warranty policy be configured, and which service owns the policy?
- How should after-sales cases connect to future customer portal messages?
- Which after-sales events should be emitted when event catalog design starts?
- How should no-order cases be allowed without weakening fraud control?
- How should compensation requests connect to Finance without turning after-sales into financial truth?

## 11. Future Writeback Targets

When this design becomes stable, likely writeback targets are:

- `docs/architecture/services/after-sales-service.md`
- `docs/architecture/collaborations/sales-after-sales-wms-finance-quality.md`
- `docs/plans/backlog.md`
- `docs/contracts/after-sales-service/README.md`
- `docs/contracts/after-sales-service/*.md`

## 12. Recovery Entry

When resuming this topic, start from these draft decisions:

- After-sales is deferred but likely independent.
- Do not modify shipped SalesOrder / DeliveryPlan / WMS outbound history.
- Customer return begins as a request; WMS receipt starts only after goods physically arrive.
- Finance owns refund / credit truth.
- Quality owns quality investigation truth.
- Customer service is a cross-service role / workspace, not necessarily a service owner.
