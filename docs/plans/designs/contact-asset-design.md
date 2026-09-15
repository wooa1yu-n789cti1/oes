# Contact Asset Design Workspace

> 本文是 OES 工作联系方式 / 联系资产设计工作台。当前记录已冻结或明确后置的设计结论，不替代 `identity-service`、`auth-service`、`hr-service`、BusinessCard 或外部通信集成的唯一真相源；稳定服务职责仍以 `docs/architecture/services/*.md` 为准。

## 0. 文档控制

```text
designKey: contact-asset-design
designStatus: ACTIVE_DESIGN_WORKSPACE
lastUpdatedAt: 2026-06-08 02:20:00 Asia/Shanghai
lastUpdatedBy: Codex thread
supersedes: Employee Digital Business Card 讨论中关于 phone / email / WeChat / WhatsApp 字段归属的未冻结讨论
conflictResolution: 当本文与更早联系方式、员工名片或账号登录讨论冲突时，以本文 lastUpdatedAt 之后的冻结结论为准；稳定 architecture / ADR / contracts 明确覆盖本文时，以稳定真相源为准。
```

## 1. 目标

- 冻结 Contact Asset 的第一阶段 owner、产品范围与架构边界。
- 区分个人登录标识、工作联系方式资产、员工个人联系方式、公司受控社交账号、外部通信账号展示引用与 BusinessCard 展示配置。
- 支撑 Employee Digital Business Card 第一阶段展示联系方式，但不把联系方式真相放进 BusinessCard。
- 明确哪些能力第一阶段冻结，哪些能力后置且需要另行设计。

## 2. 当前范围

本 workspace 负责：

- Contact Asset 第一阶段 owner 与 bounded context 边界。
- 员工名片和员工资料页可见联系方式的资产分类。
- Contact Asset 与 `UserAccount`、`User`、`Employee` 的关联口径。
- Contact Asset 与 BusinessCard、Auth、HR 的协作边界。
- 公司受控微信 / WhatsApp / 其他社交账号的展示、隐藏、交接状态口径。
- 外部通信账号在第一阶段作为名片展示摘要的边界。

本 workspace 不负责：

- 账号安全页的个人手机号 / 邮箱登录管理。
- OAuth、外部账号登录绑定、授权 token、refresh token、webhook。
- 通过 OES 读取、发送或同步企业微信、飞书、钉钉、WhatsApp 等消息。
- org / team / role 级公共联系资产。
- BusinessCard 聚合、模板、二维码、Public Entry 或 vCard 完整设计。
- proto / contract / database schema / implementation plan。

## 3. 涉及对象

- services / modules:
  - `identity-service`
  - `auth-service`
  - `hr-service`
  - `party-service`
  - `tenant-org-service`
  - BusinessCard module / future `public-entry-service`
- related designs:
  - [public-entry-service.md](../../architecture/services/public-entry-service.md)
  - [identity-service.md](../../architecture/services/identity-service.md)
  - [auth-service.md](../../architecture/services/auth-service.md)
  - [hr-service.md](../../architecture/services/hr-service.md)

## 4. 核心边界

Contact Asset 第一阶段是账号工作上下文中的联系方式资产。

建议主关联：

```text
tenantId + accountId
```

辅助引用：

```text
userId: 身份主体引用与查询辅助。
employeeId: 当前员工分配对象或 HR lifecycle 协同引用，不是 Contact Asset owner。
```

稳定 owner 口径：

- `identity-service` owns Contact Asset 主数据、分配、启停、回收、交接状态与审计语义。
- `auth-service` owns login method、credential、OTP、MFA、session 与认证审计。
- `hr-service` owns Employee / Employment lifecycle，只提供或触发员工状态变化，不拥有通信资产。
- BusinessCard owns 展示配置、排序、是否公开、是否进入 vCard，不拥有联系方式正文。
- `party-service` owns 现实主体与租户主体联系人簿，不承接员工账号工作联系资产。

## 5. 概念拆分

| 概念 | 第一阶段含义 | Owner |
| --- | --- | --- |
| `Personal Login Identifier` | 个人用于 OES 登录的手机号 / 邮箱 / login handle。第一阶段默认每个 `User` 只启用一个 primary personal login method。 | `auth-service` |
| `Work Contact Asset` | 公司或租户分配给账号的工作邮箱、工作手机号等工作联系方式。 | `identity-service` |
| `Employee-owned contact` | 员工个人拥有、可作为名片兜底展示的微信 / WhatsApp 等联系方式。 | `identity-service` 管 OES 内引用；员工拥有外部账号本身 |
| `Company-controlled social contact asset` | 公司手机号、公司设备、公司流程或公司使用权控制的微信 / WhatsApp / 其他社交账号。 | `identity-service` |
| `External Communication Account` | 企业微信、飞书、钉钉等外部通信账号在 OES 内的展示摘要或引用。第一阶段不承接消息读写能力。 | `identity-service` 管 OES 内引用；外部平台拥有外部账号生命周期 |
| `BusinessCard Contact Action` | 名片上展示哪个联系方式、动作顺序、是否进入 vCard。 | BusinessCard module |

## 6. 第一阶段 Contact Asset 类型

第一阶段冻结类型：

```text
WORK_EMAIL
WORK_PHONE
WECHAT
WHATSAPP
EXTERNAL_COMMUNICATION_ACCOUNT
OTHER_SOCIAL
```

说明：

- `WORK_EMAIL` / `WORK_PHONE` 默认是工作联系资产，不天然可登录。
- `WECHAT` / `WHATSAPP` 可表达公司受控账号或员工个人账号，必须通过 ownership 区分。
- `EXTERNAL_COMMUNICATION_ACCOUNT` 表示企业微信、飞书、钉钉等外部通信账号的展示引用，可通过 `provider` 区分 `WE_COM / FEISHU / DINGTALK` 等。
- `OTHER_SOCIAL` 用于后续扩展其他社交平台，避免第一阶段枚举爆炸。

## 7. 最小字段方向

候选最小字段：

```text
ContactAsset {
  contactAssetId
  tenantId
  accountId
  userId
  employeeId
  type
  provider
  value / handle / externalRef
  displayName
  ownership
  usage
  status
  isPrimary
  assignedAt
  releasedAt
  audit metadata
}
```

字段口径：

- `accountId` 是第一阶段 primary 关联。
- `employeeId` 是当前分配对象或 HR 协同引用，可为空。
- `provider` 主要用于 `EXTERNAL_COMMUNICATION_ACCOUNT` 与 `OTHER_SOCIAL`。
- `value / handle / externalRef` 只表达联系方式正文或展示引用，不保存 OAuth token 或外部平台 credential。
- `usage` 可表达名片展示、工作联系、vCard 候选等用途，但不表达登录可用性。

## 8. 状态机方向

第一阶段最小状态：

```text
ACTIVE
PENDING_HANDOVER
DISABLED
RELEASED
```

状态口径：

- `ACTIVE`：可作为当前账号的有效联系资产，并可被 BusinessCard 按配置引用。
- `PENDING_HANDOVER`：公司受控社交账号或其他需人工交接的资产正在交接中。
- `DISABLED`：暂停使用，不应在名片公开展示。
- `RELEASED`：已从当前账号释放，可后续重新分配或归档。

公开展示规则：

- 只有 `ACTIVE` 可用于公开名片展示。
- `PENDING_HANDOVER`、`DISABLED`、`RELEASED` 均应隐藏对应 Contact Action。
- Contact Asset 状态变化应自动影响 BusinessCard public render；BusinessCard 不需要复制状态，也不执行资产回收。

第一阶段状态取舍：

- 不引入 `EXPIRED`：联系方式资产本身第一阶段不承接有效期语义；如外部平台 token 过期，属于后续 channel binding，不属于 Contact Asset。
- 不引入 `UNVERIFIED`：工作联系方式展示验证尚未冻结，且容易与 Auth OTP / login method 混淆；如后续需要验证状态，应另行定义 verification owner。
- 不对 public render 暴露 `DELETED`：删除应表现为 missing / hidden，不成为公开可见状态。
- 不单独冻结 `REVOKED`：员工个人联系方式撤回展示或管理员移除，第一阶段可表达为 `DISABLED` 或解除 BusinessCard 引用；如未来需要合规级 revoke history，再扩展状态或审计事件。
- 更细 verification、sync、claim、lost 或 revoked 状态需另行冻结。

## 9. BusinessCard 协作边界

稳定口径：

- BusinessCard 不保存 phone、email、WeChat、WhatsApp 或外部通信账号正文。
- BusinessCard 只保存 Contact Asset 引用、展示配置、排序、公开范围与是否进入 vCard。
- 同一类社交联系入口默认只展示一个。
- 展示优先级默认是公司受控 Contact Asset 优先；没有公司受控账号时，才展示员工个人账号。
- Contact Asset inactive、disabled、released、pending handover 或 missing 时，BusinessCard 应隐藏对应 action。
- 员工离职、调岗失去使用权或 account disabled 时，原员工名片默认立即隐藏公司受控社交账号。

### 9.1 ContactAction targetRef

BusinessCard 的 `contactActionConfigs` 第一阶段推荐只保存引用和展示配置：

```text
BusinessCardContactActionConfig {
  contactActionType
  targetRefType
  targetRefId
  visibility
  displayOrder
  enabled
  includeInVCard
}
```

字段口径：

- `contactActionType` 使用 BusinessCard 预置动作，例如 `CALL_PHONE`、`SEND_EMAIL`、`ADD_WECHAT`、`OPEN_WHATSAPP`、`SAVE_VCARD`、`OPEN_COMPANY_WEBSITE`。
- `targetRefType = CONTACT_ASSET` 时，`targetRefId` 指向 `identity-service` Contact Asset。
- `targetRefType = TENANT_PUBLIC_PROFILE` 或类似 profile reference 时，用于 `OPEN_COMPANY_WEBSITE`；公司官网不属于个人 Contact Asset。
- `SAVE_VCARD` 不引用单一 Contact Asset；它由 BusinessCard public render 基于当前 public view 中可见字段组装。
- `visibility` 表达 BusinessCard 展示配置，不替代 Contact Asset 状态或 ownership。
- BusinessCard 不保存正文值；public render 时通过受控查询获取 public-safe value summary。

### 9.2 Public render 查询边界

BusinessCard public render 需要消费 `identity-service` 的 Contact Asset 解析能力。第一阶段建议契约语义为：

```text
ResolveContactActionTargets(
  tenantId,
  accountId,
  employeeId,
  targetRefs[]
)
```

输入口径：

- `tenantId` 来自 BusinessCard / session / public render 已解析上下文，不来自匿名用户任意输入。
- `accountId` 是 Contact Asset primary owner，用于限定查询范围。
- `employeeId` 可作为 HR lifecycle 协同引用或校验输入；不作为 Contact Asset owner。
- `targetRefs[]` 来自 BusinessCard `contactActionConfigs`，包含 `contactActionType`、`targetRefType`、`targetRefId`。

输出口径：

```text
ResolvedContactActionTarget {
  contactActionType
  targetRefType
  targetRefId
  renderable
  hiddenReason
  publicValueSummary
}
```

`publicValueSummary` 只包含公开渲染所需最小值：

```text
publicValueSummary {
  type
  provider
  label
  displayValue
  actionValue
  actionUri
  includeInVCardAllowed
}
```

规则：

- `renderable = true` 仅当 Contact Asset 存在、属于该 tenant / account 上下文、状态为 `ACTIVE`，且该 action type 可由该 asset type 支撑。
- 不可用、缺失、状态不可展示、tenant mismatch、account mismatch 均返回 `renderable = false`，BusinessCard 隐藏对应 action。
- public render 不应收到认证用登录标识、credential、OTP、MFA、外部 OAuth token、内部审计字段或不公开的联系方式字段。
- 查询结果只为 BusinessCard public render / vCard 组装提供 public-safe summary，不把 Contact Asset 全量资料泄露给 BusinessCard。
- 授权判定不塞进 BusinessCard；管理端配置动作仍需走既有 operator context、permission 与 audit。

### 9.3 Action type 到 Contact Asset 的最小映射

| BusinessCard action | Contact Asset / 上游来源 | Phase 1 规则 |
| --- | --- | --- |
| `CALL_PHONE` | `WORK_PHONE` | 只引用 `ACTIVE` 工作电话资产。 |
| `SEND_EMAIL` | `WORK_EMAIL` | 只引用 `ACTIVE` 工作邮箱资产。 |
| `ADD_WECHAT` | `WECHAT` | 公司受控 WeChat 优先；没有公司受控账号时才展示员工个人账号；每张名片默认最多一个。 |
| `OPEN_WHATSAPP` | `WHATSAPP` | 公司受控 WhatsApp 优先；没有公司受控账号时才展示员工个人账号；每张名片默认最多一个。 |
| `SAVE_VCARD` | BusinessCard public view | 不引用单一 Contact Asset；只包含当前公开可见字段。 |
| `OPEN_COMPANY_WEBSITE` | tenant / company public profile | 不属于个人 Contact Asset；Phase 1 推荐来自 tenant profile / company display profile 引用。 |

## 10. Auth 协作边界

稳定口径：

- 第一阶段 OES 登录默认使用个人 primary login method。
- 公司分配的工作邮箱、工作手机号、公司受控社交账号不作为默认登录方式。
- Contact Asset 与 Login Identifier 必须分离。
- 是否允许某个 email / phone / handle 登录、是否启用 login method、OTP / password / MFA 等认证能力，归 `auth-service`。
- Contact Asset 设计不承接账号安全页的个人手机号 / 邮箱登录管理。

## 11. HR 协作边界

稳定口径：

- HR owns Employee / Employment lifecycle。
- HR 不拥有 Contact Asset lifecycle。
- 员工离职、调岗或任职状态变化可触发 Contact Asset 隐藏、释放、交接或停用流程。
- `employeeId` 只作为当前分配对象或协同引用，不是 Contact Asset primary owner。
- UI 可以放在员工管理 / 员工资料页，但后台 command owner 仍是 `identity-service`。

## 12. 已冻结决定

| 日期 | 决定 | 影响范围 | 回写目标 |
| --- | --- | --- | --- |
| 2026-06-08 | Contact Asset 第一阶段归 `identity-service`，不归 HR、BusinessCard 或 Auth。 | 服务 owner | `identity-service.md` |
| 2026-06-08 | 第一阶段只 focus 员工资料与员工电子名片展示联系方式，不涉及登录绑定、OAuth token、消息读写或 webhook。 | 范围 | 本 workspace / future feature packet |
| 2026-06-08 | Contact Asset primary 关联为 `tenantId + accountId`；`userId` 是身份引用，`employeeId` 是当前分配对象或 HR lifecycle 协同引用。 | 数据边界 | `identity-service.md` |
| 2026-06-08 | 登录默认使用个人 primary login method；公司 Contact Asset 不作为默认登录方式。 | Auth / Identity 边界 | `auth-service.md` / `identity-service.md` |
| 2026-06-08 | Contact Asset 与 Login Identifier 分离；登录可用性、凭据、OTP、MFA 均归 `auth-service`。 | Auth / Identity 边界 | `auth-service.md` / `identity-service.md` |
| 2026-06-08 | BusinessCard 只引用 Contact Asset，决定展示配置、排序、公开范围与 vCard，不拥有联系方式真相。 | BusinessCard / Identity 边界 | BusinessCard design / `identity-service.md` |
| 2026-06-08 | 同一类社交联系入口默认只展示一个；公司受控账号优先，没有公司受控账号时才展示员工个人账号。 | 名片展示 | BusinessCard design / feature packet |
| 2026-06-08 | 员工个人微信 / WhatsApp 可作为兜底展示，但第一阶段不建立单独 consent 模型；配置动作保留审计。 | 隐私 / 审计 | feature packet |
| 2026-06-08 | 公司名下手机号注册的微信 / WhatsApp / 其他社交账号在 OES 内视为公司受控 Contact Asset。 | 资产分类 | `identity-service.md` |
| 2026-06-08 | 公司受控社交账号在员工离职、调岗失去使用权或 account disabled 时，默认立即从原员工名片隐藏，并进入交接或停用状态。 | 生命周期 | `identity-service.md` / BusinessCard design |
| 2026-06-08 | 企业微信、飞书、钉钉等第一阶段建模为 `EXTERNAL_COMMUNICATION_ACCOUNT`，只保存名片展示摘要或引用，不承接外部平台生命周期。 | 外部账号展示 | `identity-service.md` |
| 2026-06-08 | 第一阶段不做 org / team / role 级公共联系资产，只做 `UserAccount` 级员工联系资产。 | 范围控制 | future design candidate |
| 2026-06-08 | 未来通过 OES 绑定外部通信账号并读取 / 发送消息，不属于 Contact Asset 本体能力，应另行设计 External Communication Integration / Channel Binding。 | 后置能力 | `docs/plans/intake.md` 或独立 Design Workspace |
| 2026-06-08 | 已将 Contact Asset 稳定 owner、类型、登录分离、BusinessCard 引用与公司受控社交账号边界回写到 `identity-service.md`，并将登录分离边界轻量回写到 `auth-service.md`。 | 真相源回写 | completed |
| 2026-06-08 | 冻结 BusinessCard Phase 1 可消费最小边界：ContactAction 只保存 targetRef 与展示配置，public render 通过 `ResolveContactActionTargets` 获取 public-safe value summary；`SAVE_VCARD` 与 `OPEN_COMPANY_WEBSITE` 不属于个人 Contact Asset。 | BusinessCard contract handoff | BusinessCard contracts / feature packet |

## 13. 开放问题

| 日期 | 问题 | 为什么未冻结 | 下一步 |
| --- | --- | --- | --- |
| 2026-06-08 | Contact Asset 是否需要 `isPrimary`，还是由 BusinessCard action config 决定展示优先级？ | `identity-service` 已有主工作联系方式语义，但 BusinessCard 也有展示排序；需要避免双 owner。 | 回写 identity-service 前确认字段职责。 |
| 2026-06-08 | `employeeId` 是否必填？ | 非员工账号、外部顾问账号或未来非 HR 工作主体可能也需要联系方式资产。 | 第一阶段倾向可选；实现前通过 feature packet 冻结。 |
| 2026-06-08 | Contact Asset 是否需要验证状态？ | 工作邮箱 / 手机可能需要验证，但验证容易与 Auth OTP / login method 混淆。 | 第一阶段暂不冻结；如要验证，应另行定义 verification owner。 |
| 2026-06-08 | 外部通信账号消息读写能力是否进入候选池？ | 用户已明确当前 Contact Asset 不涉及该能力，但长期可能需要通过 OES 读发消息。 | 若近期推进，新增 candidates 或独立 workspace。 |

## 14. 真相源回写计划

- 服务职责：
  - 已更新 [identity-service.md](../../architecture/services/identity-service.md)，补充 Contact Asset 类型扩展、登录分离、BusinessCard 引用边界、公司受控社交账号与外部通信账号展示引用。
  - 已轻量更新 [auth-service.md](../../architecture/services/auth-service.md)，强调公司 Contact Asset 不默认成为 login method。
  - 当前不需要更新 [hr-service.md](../../architecture/services/hr-service.md)，除非后续冻结 HR lifecycle 事件触发 Contact Asset 交接的协同流程。
- 协同蓝图：
  - 若后续设计离职 / 调岗触发 Contact Asset 回收与 BusinessCard 隐藏，可新增或更新 collaboration 文档。
- contracts：
  - 本文只冻结 `ResolveContactActionTargets` 的最小语义；进入 feature packet / contract 阶段前再补 `identity-service` Contact Asset management / query contract 正文。
- feature packet：
  - Employee Digital Business Card feature packet 应引用本文，不重新定义 Contact Asset。
- architecture / ADR：
  - 当前不需要 ADR；若未来拆出独立 communication integration / channel service，再评估 ADR。

## 15. 恢复入口

下次继续前先读：

- [contact-asset-design.md](./contact-asset-design.md)
- [public-entry-service.md](../../architecture/services/public-entry-service.md)
- [identity-service.md](../../architecture/services/identity-service.md)
- [auth-service.md](../../architecture/services/auth-service.md)
- [hr-service.md](../../architecture/services/hr-service.md)

当前推荐下一步：

- 继续 review `identity-service.md` / `auth-service.md` 回写是否准确。
- BusinessCard contract 线程可引用本文的 `ContactAction targetRef`、`ResolveContactActionTargets`、状态展示规则、vCard 与 Company Website 边界。
- 暂不进入实现计划。
