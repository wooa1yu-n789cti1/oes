# auth-service Contracts

## 1. 目的

本目录用于提供 `auth-service` 的黑盒接口文档。

`auth-service` 的唯一稳定服务设计真相源是 [auth-service.md](../../architecture/services/auth-service.md)。本目录只描述黑盒接口、字段、错误与调用语义，不重新定义服务职责、核心对象或长期边界。

涉及角色、权限、policy、access summary、navigation governance 或 terminal access policy 的服务设计边界，以 [permission-service.md](../../architecture/services/permission-service.md) 为准。

这些文档面向：

- `api-gateway`
- `auth-bff`
- `identity-service`
- 未来其他依赖认证与会话能力的内部服务

阅读目标：

- 理解 `auth-service` 暴露了哪些能力
- 明确每个接口的请求 / 响应语义
- 明确场景、权限、副作用与上下文要求

这些文档不是 proto 副本。

Proto 契约来源仍然是：

- [auth.proto](../../../src/common/src/contracts/auth_service/auth.proto)

## 2. 模块划分

- [session.md](./session.md)
  - 会话查询、管理员会话管理与自助登出能力
- [audit.md](./audit.md)
  - 认证与会话审计查询能力
- [mfa.md](./mfa.md)
  - MFA 自助安全管理与挑战提交流程
- [login.md](./login.md)
  - 登录、认证挑战、账户选择与会话续期流程
- [terminal-login-policy.md](./terminal-login-policy.md)
  - 平台级 terminal entry login flow 策略
- [terminal-mfa-policy.md](./terminal-mfa-policy.md)
  - 平台默认与租户 terminal MFA 策略
- [session-management.md](./session-management.md)
  - terminal-aware session 列表、筛选与清退语义
- [login-history.md](./login-history.md)
  - login history 作为 auth audit 脱敏视图的查询语义
- [trusted-login-device.md](./trusted-login-device.md)
  - Web trusted browser 与 future Mobile remembered device 语义
- [execution-token.md](./execution-token.md)
  - Workload / API Key 认证、STS exchange、current mTLS + typed selector direct MACHINE root、单 audience ExecutionToken、JWKS、cache 与紧急撤销语义；external callers receive only the separate Gateway-only access token
- [external-api-key-security.md](./external-api-key-security.md)
  - tenant Integration Machine 的 API Key 创建、轮换、撤销、审计、泄漏处置与 `external_api_key.proto` Gateway/Auth gRPC 语义
- [delegated-execution-and-action-grant.md](./delegated-execution-and-action-grant.md)
  - HUMAN delegation、step-up、精确 ActionGrant、撤销与高风险操作一次性消费语义

## 3. 全局调用约束

- 所有接口均为内部 gRPC 接口，不直接对外开放
- 调用方应将 `auth-service` 视为 black box，而不是依赖其内部实现
- 登录与认证流程接口不以 Swagger 作为主文档
- 管理员接口要求：
  - verified workload identity
  - target-audience ExecutionToken
  - 对应 permission code
- `tenantId / orgId / execution principal / trace context` 是否必需，以具体接口文档为准
- request body 中重复的 tenant、operator、scope 或 service name 不能建立身份或授权
## Trusted gRPC foundation-group admission

The exact 70-RPC public/self/business classification, foundation RPC target state, audience, callers and 15 request tombstones are owned by [auth-service.md](../../architecture/services/auth-service.md#19-trusted-grpc-foundation-group-admissionfrozen). Anonymous credential, recovery, MFA continuation, refresh and account-selection calls use their existing Auth-owned credential/challenge proofs over exact Gateway mTLS admission; they do not fabricate an ExecutionToken. Runtime cutover is atomic with Identity, Permission, HR and TenantOrg as frozen in the trusted-gRPC design baseline and contracts.
