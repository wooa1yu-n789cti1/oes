# browser-activity-service 职责卡

## 1. Purpose

`browser-activity-service` 是 OES 的浏览器访问审计事实服务，负责回答“在租户内哪些已被管理员授权的账号，通过已登录 browser-extension terminal 访问了哪些 URL、持续多久、前台可见多久、活跃浏览多久、空闲多久”。

本文是 `browser-activity-service` 的唯一稳定设计真相源。其他 architecture、contract、active design、Delivery artifact 或实现文档只能引用本文，不得重新定义本服务的核心对象、边界、命名或长期职责。

## 2. Owns

- 租户级浏览器访问审计治理策略：访问明细保留天数、聚合统计保留天数，以及后台治理默认值。
- 员工级浏览器访问审计授权：租户内哪个 account 可以被 browser-extension 采集。
- 浏览器访问会话汇总事实：tenant / org / employee account context、source extension session context、URL、domain、page title、起止与 flush 时间、dwell / foreground / active / idle 时长。
- 插件在线 heartbeat 与最近采集状态摘要。
- 员工 browser-extension 在线状态 read model：基于已认证插件 heartbeat 推导当前采集通道是否在线、心跳是否延迟、最后在线时间与 session 起始时间。
- 浏览器访问审计查询 read model：tenant overview、employee ranking、employee timeline、domain aggregation、URL search。
- 本能力范围内的管理审计事实：管理员修改租户策略、查看员工明细、查看完整 URL / title、查看时间线等敏感事实。
- 本能力自己的数据保留执行状态与清理水位。

## 3. Does Not Own

- 用户认证、session、access token、refresh token、account selection 或 terminal access truth；这些归属 [auth-service.md](./auth-service.md) 与 [permission-service.md](./permission-service.md)。
- 员工、任职、组织、人力主数据；这些归属 [hr-service.md](./hr-service.md) 与 [tenant-org-service.md](./tenant-org-service.md)。
- CRM、客户、商机、线索或销售绩效事实；这些归属 [crm-service.md](./crm-service.md) 或其他业务服务。
- 通用审计平台的跨域索引、归档、检索与全局审计视图；本服务只拥有浏览器访问审计能力内的本地管理审计事实。
- 浏览器插件登录 UI、launcher、side panel、workspace preference 或前端 route。
- 页面正文、DOM 快照、网络请求明细、截图、录屏、键盘内容、表单输入内容、鼠标轨迹或滚动轨迹。
- 网站分类、风险评分、AI 判断、自动绩效评价、违规结论或“摸鱼”判定。

## 4. Core Objects

### 4.1 BrowserActivityPolicy

`BrowserActivityPolicy` 是租户级浏览器访问审计治理策略事实，不是前台管理台展示的采集开关。

稳定规则：

- 每个 tenant 至多有一个当前策略。
- 未创建策略时默认视为 `enabled = false`；该字段不再作为员工采集的唯一门禁，正式采集门禁以 `BrowserActivityEmployeeAuditGrant` 为准。
- 默认保留周期为 raw detail 90 天、aggregate 365 天。
- 只有具备 `browser_activity.policy.manage` 的租户管理员可以修改策略。
- 策略变更必须记录管理审计。
- 前台管理台不得展示 raw / aggregate 保留时长作为日常操作信息。

### 4.2 BrowserActivityEmployeeAuditGrant

`BrowserActivityEmployeeAuditGrant` 是租户内 account 级浏览器访问审计采集授权事实。

稳定规则：

- 主键语义为 `tenantId + accountId`。
- 默认视为 `enabled = false`。
- 只有具备 `browser_activity.policy.manage` 的租户管理员可以修改授权。
- 启用授权前，BFF 必须通过 permission-service 确认目标 account 的 effective terminal access 包含 `BROWSER_EXTENSION`。
- 本服务只拥有“是否允许浏览器访问审计采集”的授权事实，不拥有插件登录能力真相。
- 未开启授权的 account 即便持有有效 `BROWSER_EXTENSION` session，也不得写入 heartbeat、online presence 或 visit session。

### 4.3 BrowserVisitSession

`BrowserVisitSession` 是插件上报的一次 URL 访问会话汇总事实。

稳定规则：

- 访问事实只接受来自已认证 `BROWSER_EXTENSION` session 的 BFF 写入；目标服务以 `aud=urn:oes:service:browser-activity-service` ExecutionToken 中 Auth 签名的 `sub`、`tenant_id`、`session_id` 与 `session_terminal` 建立身份，客户端不得自报 tenant、operator、session、role、permission 或 terminal truth。
- 未登录插件、session 失效、员工审计授权未开启、terminal access denied 或账号不属于 tenant 时，不得创建访问事实。
- 同一 URL 在 30 秒内切出又切回，可由插件或服务按同一 visit merge key 合并为一条访问会话。
- P1 固定 active window 为 5 分钟；active / idle 时长必须可由会话摘要复算或验证。
- 访问事实可以记录“发生过用户活动”的时间窗口，不得保存具体键盘按键、鼠标坐标、滚动轨迹、点击目标或页面内容。
- URL 与 page title 属于敏感明细，查询必须区分 employee detail / URL detail 权限并记录敏感读取审计。

### 4.4 BrowserActivityHeartbeat

`BrowserActivityHeartbeat` 表达插件在已登录 session 下的在线事实。

稳定规则：

- heartbeat 只在插件已登录并持有有效 extension session 时上报。
- heartbeat 不等于有效工作时长；它只表达插件在线和采集通道健康。
- P1.1 在线状态定义为：员工 browser-extension 已登录、员工审计授权启用、最近 90 秒内有有效 heartbeat。
- 最近 90 秒内有有效 heartbeat 时状态为 `ONLINE`；超过 90 秒且不超过 180 秒未见 heartbeat 时状态为 `STALE`；超过 180 秒未见 heartbeat 时状态为 `OFFLINE`。
- `STALE` 表示网络、浏览器后台调度或插件进程可能延迟，不得被解释为离岗、违规或绩效结论。
- logout、session refresh failure、account switch 或 storage clear 后，插件必须停止 heartbeat。
- P1.1 不强依赖 auth-service logout / session revoked 事件；未收到即时离线事件时，服务端必须通过 heartbeat 超时自然转为 `OFFLINE`。

### 4.5 BrowserActivityOnlinePresence

`BrowserActivityOnlinePresence` 是 `BrowserActivityHeartbeat` 的当前状态 read model，用于回答“哪些员工的 browser-extension 采集通道当前在线”。

稳定规则：

- presence 只能由 authenticated `BROWSER_EXTENSION` heartbeat 派生，不能由 WEB session、CRM 操作、普通登录状态或访问会话记录推断。
- presence 必须限定在当前 tenant，主键语义为 tenant account，而不是全局 user。
- presence 可以保存 `lastHeartbeatAt`、`sessionStartedAt`、`extensionSessionId`、`displayNameSnapshot`、`lastObservedDomain` 与 `status`。
- `lastObservedDomain` 只能来自已接受的访问会话汇总或 heartbeat 附带的受限摘要，不得保存页面正文、DOM、截图、键盘输入或鼠标轨迹。
- 管理台展示在线人数、心跳异常人数、员工在线状态与最后在线时间时，只能表达采集通道状态，不得表达工作质量、违规判断或绩效结论。

### 4.6 BrowserActivityReadModel

`BrowserActivityReadModel` 是为管理台查询优化的浏览器访问审计读模型。

稳定规则：

- 默认 ranking 使用 `activeDurationSeconds`，不表达绩效或违规结论。
- overview、employee timeline、domain aggregation、URL search、online presence 都必须限定在当前 tenant。
- 员工展示名可以通过上游显式 adapter / snapshot 映射获得；本服务不拥有员工主数据真相。
- 查询模型可以异步聚合，但不得改变原始访问会话事实。

## 5. Collection Gate

浏览器访问采集必须同时满足以下条件：

1. 插件当前存在有效 `BROWSER_EXTENSION` authenticated session。
2. 当前 session 是 tenant-scope account，且携带 tenant context。
3. 当前账号仍允许从 `BROWSER_EXTENSION` terminal 建立或继续 session。
4. 当前账号的 `BrowserActivityEmployeeAuditGrant.enabled = true`。
5. 上报请求通过 API Gateway / BFF，目标服务已验证 mTLS、Browser Activity audience ExecutionToken、`principal_type=HUMAN` 与 `session_terminal=BROWSER_EXTENSION`；tenant、account、session 与 trace 来自可信执行上下文，审计 action 由目标 RPC 固定生成。

任一条件不满足时：

- 插件不得开始新的访问会话。
- 插件不得 heartbeat。
- 插件不得缓存未登录期间的 URL 访问事实等待登录后补报。
- 服务端不得接受访问事实写入。

### 5.1 Trusted gRPC Entry

`BrowserActivityService` 的 13 个 RPC 只接受 Gateway 作为当前 production direct caller，并使用唯一 audience `urn:oes:service:browser-activity-service`。每个 RPC 必须声明且只声明以下一种模式；当前全部拒绝 `MACHINE` 与 `DELEGATED`：

| RPC | Required principal/session terminal | Mode | Permission Code |
| --- | --- | --- | --- |
| `GetPolicy` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.policy.read` |
| `UpdatePolicy` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.policy.manage` |
| `GetEmployeeAuditGrants` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.overview.read` |
| `UpdateEmployeeAuditGrant` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.policy.manage` |
| `GetOverview` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.overview.read` |
| `GetEmployeeTimeline` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.employee_detail.read` |
| `GetDomainAggregation` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.url_detail.read` |
| `SearchUrls` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.url_detail.read` |
| `GetOnlinePresence` | `HUMAN` / `WEB` | `BUSINESS` | `browser_activity.overview.read` |
| `GetAuditControl` | `HUMAN` / `BROWSER_EXTENSION` | `SELF_SERVICE` | empty set |
| `AppendVisitSessions` | `HUMAN` / `BROWSER_EXTENSION` | `SELF_SERVICE` | empty set |
| `Heartbeat` | `HUMAN` / `BROWSER_EXTENSION` | `SELF_SERVICE` | empty set |
| `Disconnect` | `HUMAN` / `BROWSER_EXTENSION` | `SELF_SERVICE` | empty set |

稳定信任规则：

- `session_terminal` 由 Auth 从与 `session_id` 相同的 active session truth 签入；Gateway route guard 是入口第一层，不能替代目标服务的 exact terminal check。
- `SELF_SERVICE` 的 tenant、account 与 extension session 分别从 `tenant_id`、`sub` 与 `session_id` 派生；request 中的 `extension_session_id` 不能成为 authority。
- `account_ids`、`account_id`、`employee_account_id`、period、status、keyword、URL/domain summary 与 timestamps 是 tenant-scoped business target/payload，不能覆盖执行身份；目标资源必须再次执行 tenant/resource ownership check。
- request body 的 tenant/operator/trace/audit 副本与 legacy signed-operator/header path 在 token-only cutover 时删除并 reserve，不存在 Token 失败后的 fallback。
- `UpdatePolicy`、`UpdateEmployeeAuditGrant` 分别记录 append-only management audit；`GetEmployeeTimeline`、`GetDomainAggregation`、`SearchUrls` 分别记录 method-owned sensitive-read audit。操作者、tenant、target、trace 与 session evidence 来自可信上下文，reason/action 使用服务端稳定枚举，审计失败时不返回成功结果。

## 6. Metrics

P1 固定时间口径：

| Metric | Definition |
| --- | --- |
| `onlineDurationSeconds` | 插件已登录、session 有效且持续 heartbeat 的时间。 |
| `dwellDurationSeconds` | URL 会话从开始到结束或 flush 的总时长。 |
| `foregroundDurationSeconds` | tab 前台可见且浏览器窗口聚焦的时长。 |
| `activeDurationSeconds` | 前台可见期间，最近 5 分钟内有用户活动的时长。 |
| `idleDurationSeconds` | 页面打开或前台可见但连续超过 5 分钟无用户活动后的时长。 |

稳定规则：

- active window 固定 5 分钟。
- idle 从连续 5 分钟无用户活动后开始累计。
- 默认排名不使用 online duration。
- 所有时长必须非负，且服务端必须拒绝明显不一致的汇总。
- 在线人数使用 online presence 状态计算，不直接等同 `onlineDurationSeconds`。

## 7. Collaboration

- `api-gateway` owns HTTP/BFF surface, validates the external access token/session and exchanges an exact-audience ExecutionToken; it does not construct a second body identity or become terminal authority.
- `permission-service` owns action codes, navigation visibility, terminal access decision and access summary.
- `auth-service` owns extension session validation, session refresh, logout truth and the signed `session_terminal` claim bound to `session_id`.
- `browser-extension` owns local browser event observation and visit summary calculation, but not audit truth.
- `tenant-web` owns administrator UI rendering and action affordances, not browser activity facts.

## 8. Non-Goals

P1 明确不做：

- 截图、录屏、屏幕实时查看。
- 键盘记录、表单输入记录、页面正文抓取。
- 网站分类、风险评分、违规判断、AI 分析。
- 员工侧自查面板。
- 导出流程。
- 部门、岗位、工作时间段或条件化复杂采集策略；P1 只支持 account 级启停授权。
- 工作时间段策略。
