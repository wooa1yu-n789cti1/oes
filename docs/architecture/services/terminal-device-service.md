# terminal-device-service 职责卡

> `terminal-device-service` 只拥有企业受管现场交互终端设备治理真相；账号安全里的 trusted login device、MFA、登录历史与 session 真相以 [auth-service.md](./auth-service.md) 为准。

## 1. Purpose

`terminal-device-service` 是 OES 的企业受管现场交互终端设备治理服务，负责回答“某台受管终端设备属于哪个租户、是否已入网、当前是否允许用于 PDA / KIOSK 等现场终端场景、最近运行状态如何、适用什么版本策略”。

本文是 `terminal-device-service` 的唯一稳定设计真相源。其他 architecture、collaboration、contract、active design、Delivery artifact 或实现文档只能引用本文，不得重新定义本服务的长期职责、核心对象、边界或 owner 语义。

Phase 2 只正式支持 `PDA`，但服务命名和领域模型预留未来 `KIOSK`、`INDUSTRIAL_TABLET` 与共享移动终端。

## 2. Owns

- 企业受管终端设备 registry 真相。
- 管理员发放的设备入网 enrollment 真相。
- 设备租户绑定真相；Phase 2 只绑定 `tenantId`。
- 设备生命周期状态与状态流转规则。
- 设备 identity signals 的登记、匹配与冲突识别。
- 设备运行快照：
  - 最近 heartbeat
  - App 版本
  - Android 版本
  - 网络状态
  - 电量
  - App 前后台状态
  - 最近上报账号
- presence 推断：
  - `ONLINE`
  - `STALE`
  - `OFFLINE`
  - `UNKNOWN`
- terminal device 版本策略：
  - `minSupportedAppVersion`
  - `latestAppVersion`
  - `upgradeRequired`
  - `upgradeRecommended`
  - 可选 `apkDownloadUrl`
  - 可选 `releaseNotesUrl`
- 统一 `DeviceAccessDecision`。
- 设备治理审计事实：
  - enrollment 生成 / 使用 / 撤销
  - 状态变更
  - 版本策略修改
  - 敏感详情访问
  - session revoke 请求或结果摘要

## 3. Does Not Own

- 用户认证、密码、OTP、MFA、认证 challenge、trusted login device、登录历史、active session、refresh token、access token 或 token 签发语义；这些以 [auth-service.md](./auth-service.md) 为准。
- Role、Permission、Policy、Terminal Access Policy、access summary、授权判定或权限码真相；这些以 [permission-service.md](./permission-service.md) 为准。
- `User / UserAccount`、账号展示资料、身份映射、employee binding 或 contact asset 真相；这些以 [identity-service.md](./identity-service.md) 为准。
- 租户生命周期、组织树、组织单元、工厂、车间或仓库主数据；租户与组织边界以 [tenant-org-service.md](./tenant-org-service.md) 为准。
- WMS / MES 作业、库存、库位、工位、产线、工序、生产对象或现场任务真相。
- IoT、机台、PLC、传感器、普通固定资产、资产折旧或资产盘点。
- MDM、远程擦除、远程锁屏、后台静默安装、实时远程控制或企业应用市场集成。
- API Gateway / BFF 的外部 HTTP 响应形状和页面 DTO。

## 4. Core Objects

### 4.1 TerminalDevice

`TerminalDevice` 是真实受管终端设备完成 enrollment 激活后的设备档案。

稳定规则：

- `terminalDeviceId` 由服务端生成，是 OES 内部设备真相 ID。
- `terminalDeviceType` Phase 2 固定支持 `PDA`，预留 `KIOSK / INDUSTRIAL_TABLET`。
- Phase 2 只绑定 `tenantId`，不绑定 `orgId / siteId / warehouseId / workshopId / productionLineId / workstationId / zoneId / locationId`。
- `displayName` 与 `notes` 是管理展示信息，不作为身份真相。
- identity signals 可以包括：
  - `manufacturerSerial`
  - `androidId`
  - `appInstallationId`
  - `manufacturer`
  - `model`
  - `androidVersion`
- `manufacturerSerial` 是高优先级自然识别因子，但不是系统主键。
- `androidId` 只作为辅助识别，不单独自动恢复设备。
- `appInstallationId` 只表示当前安装实例，不能表示设备本体。
- 重装 App 后若本地 `terminalDeviceId` 丢失，即使 `manufacturerSerial` 匹配已有设备，也不得自动恢复为 `ACTIVE`，必须进入管理员确认 / 重新 enrollment 流程。

### 4.2 TerminalDeviceEnrollment

`TerminalDeviceEnrollment` 是管理员发放的一次性设备入网授权，不是设备本身。

稳定规则：

- 管理员必须先在后台创建 enrollment，PDA 才能激活入网。
- 二维码只承载短期 enrollment code / token，不承载完整设备配置。
- 原始 code / token 不应明文长期保存；服务端应保存 hash 或安全摘要。
- Phase 2 固定为短期、单次、可撤销。
- 状态：
  - `ISSUED`
  - `USED`
  - `EXPIRED`
  - `REVOKED`
- 使用成功后 enrollment 变为 `USED`，不可复用。
- 未使用 enrollment 可以撤销。
- 使用有效 enrollment 激活成功后才创建正式 `TerminalDevice`。
- 正常激活成功后 `TerminalDevice.status = ACTIVE`。
- `PENDING_APPROVAL` 只用于异常设备记录，例如 identity conflict、低可信激活或人工确认流程，不是正常 enrollment 必经状态。

### 4.3 TerminalDeviceRuntimeSnapshot

`TerminalDeviceRuntimeSnapshot` 是最近一次 heartbeat 形成的运行诊断快照。

`TerminalDeviceHeartbeatRecord` 是每次 heartbeat 形成的不可变诊断记录，用于后台排查设备在线、网络、电量、App 版本和上报 session 摘要变化。

稳定规则：

- runtime snapshot 不等于设备管理真相。
- heartbeat history 不等于生命周期状态、登录状态或审计事实。
- `lastHeartbeatAt` 使用服务端接收时间。
- `lastClientTime` 只用于诊断客户端时钟偏差。
- `lastReportedAccount` 只表示最近 heartbeat 附带的账号摘要，不是当前登录用户真相。
- 当前有效 PDA session 真相归属 `auth-service`；后台若要展示当前 session，必须聚合 `auth-service`。
- heartbeat 不改变生命周期状态。
- App 关闭、设备锁屏、设备关机或网络断开只能表现为未收到 heartbeat，Phase 2 不承诺精确区分原因。

### 4.4 TerminalDeviceVersionPolicy

`TerminalDeviceVersionPolicy` 是 terminal device 类型维度的 App 版本治理策略。

稳定规则：

- Phase 2 维度为 `tenantId + terminalDeviceType`。
- 低于 `minSupportedAppVersion` 时阻断登录和业务请求。
- 低于 `latestAppVersion` 但未低于 min 时可提示建议升级。
- `apkDownloadUrl` 与 `releaseNotesUrl` 为可选字段。
- Phase 2 不做自动升级、热更新、后台静默安装、MDM 或企业应用市场集成。

### 4.5 TerminalDeviceAuditEvent

`TerminalDeviceAuditEvent` 是设备治理域本地审计事实。

稳定规则：

- 状态变更、enrollment 生成 / 使用 / 撤销、版本策略修改、敏感详情访问都必须审计。
- 高风险动作必须填写原因：
  - `DISABLED`
  - `LOST`
  - `ACTIVE` restore
  - `DECOMMISSIONED`
  - 手动 session revoke 请求
  - identity conflict 恢复或重新登记
- 审计至少记录：
  - `tenantId`
  - `operatorAccountId`
  - `operatorOrgId`，如适用
  - `action`
  - `targetTerminalDeviceId`
  - `before / after` 摘要
  - `reason`
  - `traceId`
  - `occurredAt`

## 5. Lifecycle Status

稳定设备生命周期状态：

- `PENDING_APPROVAL`
  - 异常发现、identity conflict、低可信激活或需要人工确认。
  - 不允许登录或业务请求。
  - 允许 enrollment、heartbeat 与 diagnostic logs。
- `ACTIVE`
  - 已入网、可用于对应 terminal 场景。
  - 可登录、可发起授权范围内业务请求。
- `DISABLED`
  - 管理员临时 / 管理性停用。
  - 不允许登录或业务请求。
  - 可恢复为 `ACTIVE`，必须填写原因并审计。
- `LOST`
  - 设备丢失或疑似失控。
  - 不允许登录或业务请求。
  - 可高风险恢复为 `ACTIVE`，必须填写原因并审计。
- `MAINTENANCE`
  - 维修、调试或暂不投入生产。
  - 不允许正式登录或业务请求。
  - 可恢复为 `ACTIVE`，必须填写原因并审计。
- `DECOMMISSIONED`
  - 解除入网 / 退役。
  - 不允许登录或业务请求。
  - 是不可直接恢复的终止状态；再次使用必须重新 enrollment。

状态效果：

- 除 `ACTIVE` 外，所有状态都阻断 PDA 登录和业务请求。
- `DISABLED / LOST / MAINTENANCE / DECOMMISSIONED` 必须触发或请求 `auth-service` revoke 该 `terminalDeviceId` 关联的 PDA sessions。
- `DISABLED / LOST / MAINTENANCE` 下 PDA 应清理本地 session，但可保留 `terminalDeviceId`。
- `DECOMMISSIONED` 下 PDA 必须清理本地 session 与 `terminalDeviceId`。

## 6. DeviceAccessDecision

`DeviceAccessDecision` 是本服务对外提供的统一准入判定能力。

输入应包含：

- `tenantId`，当调用方已知时
- `terminalDeviceId`
- `terminalDeviceType`
- `appVersion`
- identity signals
- request purpose，例如：
  - `ENROLLMENT`
  - `LOGIN`
  - `BOOTSTRAP`
  - `BUSINESS_REQUEST`
  - `HEARTBEAT`
  - `DIAGNOSTIC_LOG`

输出应包含：

- `allowed`
- `decisionCode`
- `resolvedTenantId`
- `deviceStatus`
- `presenceStatus`
- `versionPolicy`
- `requiredAction`
- `messageKey`
- `shouldClearLocalSession`
- `shouldClearLocalTerminalDeviceId`
- `shouldRevokeServerSessions`

典型 decision code：

- `ALLOW`
- `ENROLLMENT_REQUIRED`
- `DEVICE_PENDING_APPROVAL`
- `DEVICE_DISABLED`
- `DEVICE_LOST`
- `DEVICE_MAINTENANCE`
- `DEVICE_DECOMMISSIONED`
- `APP_VERSION_UNSUPPORTED`
- `DEVICE_IDENTITY_CONFLICT`

BFF、controller 或 DTO 不得复制设备状态、版本策略或 identity conflict 判断规则。

## 7. PDA Login Tenant Resolution

PDA 登录租户由受管设备绑定决定。

稳定规则：

- PDA 完成 enrollment 后，`TerminalDevice` 绑定唯一 `tenantId`。
- PDA 登录页不提供租户选择。
- `/pda/auth/login` 必须携带 `terminalDeviceId` 和设备 identity metadata。
- PDA BFF 先调用 `terminal-device-service` 获取 `DeviceAccessDecision` 与 `resolvedTenantId`。
- PDA BFF 再调用 `auth-service`，只在 `resolvedTenantId` 下认证账号。
- `auth-service` session 必须记录 `terminal = PDA` 与 `terminalDeviceId`。
- 若账号不属于该 tenant，或没有 PDA terminal access，登录失败。
- 同一 PDA 如需给其他 tenant 使用，必须先 `DECOMMISSIONED`，清理本地 `terminalDeviceId`，再由新租户 enrollment。

## 8. External Interfaces

典型上游入口：

- PDA BFF
  - `/pda/device/enroll`
  - `/pda/device/heartbeat`
  - `/pda/session/bootstrap`
  - `/pda/device/logs`
- Admin BFF
  - enrollment 管理
  - 设备列表 / 详情
  - 状态操作
  - 版本策略管理

PDA BFF 与 Admin BFF 只拥有外部 HTTP 契约、DTO 映射、权限聚合和服务编排，不拥有设备治理规则。

`/pda/device/logs` 的上传入口仍由 PDA BFF 暴露，但 Phase 2 的后台可查询诊断日志历史由 `terminal-device-service` 持久化；Admin BFF 不以 gateway 进程内存作为日志历史真相。

### 8.1 Trusted gRPC execution boundary

Terminal Device 的 17 个 RPC 统一使用 audience `urn:oes:service:terminal-device-service`，且每个 RPC 恰有一种方法级模式。Admin 管理面是 `HUMAN`、`session_terminal=WEB` 的 `BUSINESS` 调用；PDA 入网、登录前设备判定、heartbeat 与诊断写入是准确 Gateway SYSTEM Machine Principal 发起的 `INTERNAL` 调用。两组都拒绝 `DELEGATED`，不得因已登录 PDA 用户存在而让同一个设备治理 RPC 在 HUMAN/MACHINE 模式间切换。

| RPC | Mode / principal | Exact Code rule |
| --- | --- | --- |
| `CreateEnrollment` | BUSINESS / HUMAN WEB | all `terminal-device.enrollment.create` |
| `ListEnrollments` | BUSINESS / HUMAN WEB | all `terminal-device.read` |
| `RevokeEnrollment` | BUSINESS / HUMAN WEB | all `terminal-device.enrollment.revoke` |
| `ActivateEnrollment` | INTERNAL / Gateway SYSTEM MACHINE | all `terminal-device.internal.gateway.enrollment.activate` |
| `ResolveDeviceAccessDecision` | INTERNAL / Gateway SYSTEM MACHINE | all `terminal-device.internal.gateway.access.resolve` |
| `ListTerminalDevices` | BUSINESS / HUMAN WEB | all `terminal-device.read` |
| `GetTerminalDevice` | BUSINESS / HUMAN WEB | all `terminal-device.read`; unmasked identity additionally requires `terminal-device.sensitive.read` in the same ET |
| `UpdateTerminalDevice` | BUSINESS / HUMAN WEB | all `terminal-device.update` |
| `ChangeTerminalDeviceStatus` | BUSINESS / HUMAN WEB | any lifecycle Code, followed by exact target-status-to-Code matching |
| `ListTerminalDeviceAuditEvents` | BUSINESS / HUMAN WEB | all `terminal-device.audit.read` |
| `RecordHeartbeat` | INTERNAL / Gateway SYSTEM MACHINE | all `terminal-device.internal.gateway.heartbeat.record` |
| `GetRuntimeSnapshot` | BUSINESS / HUMAN WEB | all `terminal-device.sensitive.read` |
| `ListHeartbeatRecords` | BUSINESS / HUMAN WEB | all `terminal-device.sensitive.read` |
| `RecordDiagnosticLogs` | INTERNAL / Gateway SYSTEM MACHINE | all `terminal-device.internal.gateway.diagnostic_log.record` |
| `ListDiagnosticLogs` | BUSINESS / HUMAN WEB | all `terminal-device.sensitive.read` |
| `GetVersionPolicy` | BUSINESS / HUMAN WEB | all `terminal-device.read` |
| `UpsertVersionPolicy` | BUSINESS / HUMAN WEB | all `terminal-device.version-policy.manage` |

`ChangeTerminalDeviceStatus` 必须在 guard 的 `any` 通过后继续执行目标绑定：`DISABLED -> terminal-device.status.disable`、`LOST -> terminal-device.status.mark-lost`、`MAINTENANCE -> terminal-device.status.mark-maintenance`、`ACTIVE -> terminal-device.status.restore-active`、`DECOMMISSIONED -> terminal-device.status.disable`。`DECOMMISSIONED` 仍由服务端作为不可恢复终态处理，并要求高风险原因与审计；本 RPC 不允许把目标设为 `PENDING_APPROVAL`。

BUSINESS 请求的 tenant、account、org、operator 与 trace 只来自 verified ExecutionToken / trusted transport；设备、enrollment 与分页字段只是当前 tenant 内的业务 target。四个 INTERNAL 请求只接受环境 registry 中准确 Gateway SPIFFE workload 的 certificate-bound ET；Gateway 使用 current mTLS + Identity-provisioned exact SYSTEM selector、STS、`ResolveWorkloadIssuance` 与最多五分钟的进程内 target-token cache。SYSTEM Machine Token 不携带或伪造 tenant；Terminal Device 从 enrollment 或现有设备 registry 解析 tenant。

### 8.2 Device credential boundary

Gateway MACHINE ET 只证明内部调用者是 Gateway，不能证明外部请求来自其自报的 PDA。Phase 2 因此冻结一个 Terminal Device Service 自有的随机 `deviceCredential`：

- enrollment 激活成功时生成高熵随机值，只向 PDA 返回一次；PDA 使用 Android Keystore 加密保存，服务端只保存 hash 与状态，不保存可恢复原文；
- credential 绑定 `terminalDeviceId + appInstallationId`，带服务端 `credentialVersion`，默认最长 30 天；是设备证明而不是 Execution Principal、Auth credential、Permission grant 或用户 session；
- heartbeat 在 credential 剩余 7 天或更短时原子签发新 credential/version；新旧 credential 最多重叠 5 分钟，仅用于设备收敛，过期旧版本随后拒绝；
- `ResolveDeviceAccessDecision`、`RecordHeartbeat` 与 `RecordDiagnosticLogs` 必须同时验证准确 credential；只提交 terminalDeviceId、serial、Android ID 或 installation ID 不能建立设备 authority；
- `DISABLED / LOST / MAINTENANCE` 暂停 credential 使用，受审计的 `ACTIVE` restore 才恢复；`DECOMMISSIONED` 与重新 enrollment 永久撤销旧 credential；
- credential、hash、enrollment code、source bearer 与完整设备敏感标识不得进入日志、错误、普通审计或普通 response；
- device credential 只允许设备准入、heartbeat 与诊断用途。库存、生产、管理或任何业务动作仍要求对应 HUMAN/session 与业务授权。

本阶段不引入每设备 Machine Principal、设备 mTLS PKI、硬件私钥签名、MDM 或自动 credential rotation。未来只有出现离线高风险业务或明确防克隆要求时，才另行冻结 hardware-backed proof-of-possession。

### 8.3 Domain repository consistency port

`TerminalDeviceRepository` 是设备生命周期与 credential 状态写入的稳定 domain port，必须显式声明下列两个原子操作；application handler 不得通过私有 structural cast、可选方法或 test-only substitute 定义生产能力：

- `compareAndSwapCredential(expected, replacement) -> updated | null`：仅当持久化记录的 `terminalDeviceId`、credential version/hash/state 与 lifecycle status 仍等于 `expected` 快照时提交 `replacement`。同一旧版本的并发轮换只能有一个成功者；冲突返回 `null`，调用方重新读取 owner 真相，不得覆盖赢家或返回未持久化的新 credential。
- `commitStatusChange(nextDevice, auditEvent) -> updated`：在一个 consistency boundary 内提交 lifecycle 状态、由该状态派生的 credential suspend/restore/revoke/material transition，以及对应 `TerminalDeviceAuditEvent`。任一写入失败时，device 与 audit 都不得部分可见；Redis `terminal-device.unavailable` 仍只在成功提交后作为独立异步事实发布。

Prisma 与仓库内提供的 in-memory adapter 必须实现同一个 declared port 和相同可观察语义；测试替身也只能实现该 port，不能成为生产 contract 的唯一来源。

## 9. Upstream Dependencies

- `auth-service`
  - session / token 真相。
  - 按 `terminalDeviceId + terminal=PDA` revoke sessions。
  - 提供当前有效 PDA session 查询能力时，后台 BFF 可聚合展示。
- `permission-service`
  - 设备管理权限码、角色、policy 与授权判定真相。
  - Terminal Access Policy 判定。
- `identity-service`
  - 账号归属、账号状态与展示摘要。
- `tenant-org-service`
  - 租户存在性与生命周期。
- API Gateway / BFF
  - 外部 HTTP 入口、operator context、trace context、DTO 映射与下游编排。

## 10. Published Facts

本服务可对外发布或返回：

- 某个 `terminalDeviceId` 是否存在、属于哪个 tenant、是什么 terminal device type。
- 某个 terminal device 当前生命周期状态。
- 某个 PDA request purpose 是否允许继续。
- 当前版本策略与升级建议。
- 最近一次 heartbeat 运行快照。
- presence 推断结果。
- enrollment 使用结果。
- 设备治理审计摘要。

## 11. Permission Boundary

设备管理权限真相归属 `permission-service`。Phase 2 建议权限码包括：

- `terminal-device.enrollment.create`
- `terminal-device.enrollment.revoke`
- `terminal-device.read`
- `terminal-device.sensitive.read`
- `terminal-device.status.disable`
- `terminal-device.status.mark-lost`
- `terminal-device.status.mark-maintenance`
- `terminal-device.status.restore-active`
- `terminal-device.version-policy.manage`
- `terminal-device.audit.read`
- `terminal-device.update`
- `terminal-device.internal.gateway.enrollment.activate`
- `terminal-device.internal.gateway.access.resolve`
- `terminal-device.internal.gateway.heartbeat.record`
- `terminal-device.internal.gateway.diagnostic_log.record`

`terminal-device-service` 执行命令时必须从 trusted execution context 接收 operator、tenant/org、trace 与审计元数据；request body 不再携带这些 authority。Permission Code 授权真相仍归 Permission Service，Terminal Device 只执行方法声明、敏感 projection、目标状态与 Code 的精确匹配以及本域资源/生命周期规则。

## 12. Non-goals

Phase 2 不做：

- WMS / MES 业务闭环。
- 仓库、车间、产线、工位、库区、库位绑定。
- 设备分组策略。
- 离线业务提交。
- 自动升级、热更新、后台静默安装。
- MDM / 企业应用市场集成。
- 实时远程控制、远程锁屏、远程擦除。
- 前台服务、后台常驻 heartbeat、开机自启。
- 蓝牙打印、NFC。
- 照片上传或业务附件服务。
- 账号安全 trusted device、MFA、登录历史、管理员会话管理。
- 生产设备、IoT、机台、普通资产管理。
- 把 heartbeat 当作登录真相。
- 把 `lastReportedAccount` 当作当前登录用户真相。

## 13. Related Documents

- [0006-terminal-device-service.md](../../adr/0006-terminal-device-service.md)
- [pda.md](../terminals/pda.md)
- [terminal-access-policy.md](../collaborations/terminal-access-policy.md)
- [auth-service.md](./auth-service.md)
- [permission-service.md](./permission-service.md)
- [identity-service.md](./identity-service.md)
- [tenant-org-service.md](./tenant-org-service.md)
