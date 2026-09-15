# API Gateway Contracts

## 1. 目的

本目录用于提供 `api-gateway` / BFF 面向前端与外部客户端的黑盒契约入口。

这里主要回答三类问题：

- 哪些 HTTP 能力已经形成可依赖契约
- 每组能力的职责边界是什么
- 具体应该去看哪份正式文档

本 README 只承担导航与边界说明职责，不重复正文契约细节。

## 2. 阅读规则

- 稳定接口语义以对应黑盒契约文档为准。
- 具体字段与错误细节，以 controller、DTO、ViewModel 与 Swagger 为准。
- 如果文档与代码实现冲突，应以代码为准，并回写修正文档。
- 阶段性执行状态、前端改造进度、临时跟进事项，不应堆叠到本 README。

## 3. 当前契约入口

- [auth-bff-login.md](./auth-bff-login.md)
  - 登录主流程与登录后初始化上下文
- [pda-auth-bff-login.md](./pda-auth-bff-login.md)
  - PDA 专用登录闭环与 session context 契约
- [pda-device-management-bff.md](./pda-device-management-bff.md)
  - PDA 设备入网、heartbeat、bootstrap 设备治理与诊断日志契约
- [admin-terminal-device-bff.md](./admin-terminal-device-bff.md)
  - tenant-web 后台 terminal device enrollment、设备列表/详情、状态操作、版本策略与审计查询契约
- [kiosk-auth-bff-login.md](./kiosk-auth-bff-login.md)
  - KIOSK 专用登录闭环与 session context 契约
- [extension-auth-bff-login.md](./extension-auth-bff-login.md)
  - 浏览器插件专用登录闭环、extension terminal session 与 launcher 初始化契约草案
- [browser-activity-bff.md](./browser-activity-bff.md)
  - Browser Activity 插件采集与 tenant-web 管理台 BFF 契约
- [navigation-summary.md](./navigation-summary.md)
  - 登录后导航可见性摘要契约
- [access-summary.md](./access-summary.md)
  - 登录后权限摘要与 `actionCodes` 契约
- [auth-bff-self-service.md](./auth-bff-self-service.md)
  - 已登录用户自助安全管理接口
- [account-security-bff.md](./account-security-bff.md)
  - 当前用户账号安全中心接口，覆盖 session、login history 与 trusted devices
- [auth-bff-admin-security.md](./auth-bff-admin-security.md)
  - 管理员安全管理接口
- [platform-auth-security-bff.md](./platform-auth-security-bff.md)
  - 平台管理员 terminal login policy 与平台默认 terminal MFA policy 接口
- [tenant-target-binding.md](./tenant-target-binding.md)
  - canonical `:tenantId` path 的全局绑定、SYSTEM/TENANT eligibility、下游 handoff、错误与 acceptance contract
- [permission-management.md](./permission-management.md)
  - 权限管理后台接口
- [tenant-onboarding.md](./tenant-onboarding.md)
  - Tenant onboarding BFF 目标契约草案；当前为设计对齐用，尚未实现
- [mes-mold-management.md](./mes-mold-management.md)
  - MES 模具管理第一阶段 web 手工闭环 BFF 契约
- [external-api-key-exchange.md](./external-api-key-exchange.md)
  - 外部 Integration Machine 的 API Key HTTP exchange 与 Gateway-only access token 契约；external opening 仍关闭

## 4. 契约实现参考

前端或调用方在阅读黑盒文档之外，还应同时参考当前代码中的契约实现：

- controller
- DTO
- ViewModel / presenter
- Swagger

其中 `auth-bff` 当前主要实现参考位于：

- [auth.controller.ts](../../../src/services/api-gateway/src/modules/auth-bff/interfaces/http/controllers/auth.controller.ts)
- [login.dto.ts](../../../src/services/api-gateway/src/modules/auth-bff/interfaces/http/dtos/login.dto.ts)
- [auth-response.view-model.ts](../../../src/services/api-gateway/src/modules/auth-bff/interfaces/http/view-models/auth-response.view-model.ts)
- [session-context.view-model.ts](../../../src/services/api-gateway/src/modules/auth-bff/interfaces/http/view-models/session-context.view-model.ts)

这些代码文件只作为 HTTP contract 实现参考，不定义 `auth-service` 服务设计。`auth-service` 的长期职责、边界、session、token、MFA、OTP 与 self-service / admin-management 语义只以 [auth-service.md](../../architecture/services/auth-service.md) 为准。

## 5. 目录边界

- 本目录保留“调用方可依赖的 HTTP 契约”。
- 稳定设计原则与跨域边界，应回到 `docs/architecture/`。
- 未冻结事项应进入 `docs/plans/intake.md`、对应 active design 或 backlog；执行状态由 task-owned DP 承载。
- 尚未冻结的认证后续项，应记录到 `docs/plans/intake.md`、对应 active design 或 backlog，而不是保留在 `contracts/`。
