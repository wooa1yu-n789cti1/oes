# 账号上下文切换协同蓝图

## 1. 目标

定义 OES 中“已登录用户如何在可用 account context 之间切换，并让会话、权限摘要与前端 shell 同步刷新”的长期协同方式。

`auth-service` 的 session context、token 与 context switch 服务边界只以 [auth-service.md](../services/auth-service.md) 为准；本文只记录跨服务协同链路。
`permission-service` 的权限摘要、角色、policy 与导航授权边界只以 [permission-service.md](../services/permission-service.md) 为准；本文只描述 context switch 后如何刷新这些消费视图。

## 2. 参与服务

- `api-gateway`
- `auth-service`
- `identity-service`
- `permission-service`
- `tenant-web`

## 3. 协同分工

- `tenant-web`
  - 提供切换入口、展示当前 context 与可切换列表，并在切换后刷新客户端状态
- `api-gateway`
  - 暴露对前端友好的 `contexts` / `switch-context` HTTP contract，并编排下游调用
- `auth-service`
  - 按 `auth-service` 唯一真相源执行切换后的 session context 替换与 token 重新签发
- `identity-service`
  - 提供当前用户可切换 account context 的事实列表与展示摘要
- `permission-service`
  - 在切换完成后提供新 context 对应的权限摘要与导航装配支撑

## 4. 协同顺序

1. `tenant-web` 通过 `api-gateway` 获取当前用户可切换 context 列表
2. `api-gateway` 调用 `identity-service` 获取候选 account context 事实
3. 用户选择目标 context 后，`tenant-web` 通过 `api-gateway` 提交切换请求
4. `api-gateway` 调用 `auth-service` 执行 session context 重建与 token 重签
5. 切换成功后，`tenant-web` 刷新 session context、access summary、首页导航与本地 shell 状态
6. 相关授权摘要与导航装配继续通过 `permission-service` 与 `api-gateway` 的既有链路获取

## 5. 同步 / 异步边界

- 同步：
  - `tenant-web -> api-gateway`
  - `api-gateway -> identity-service`
  - `api-gateway -> auth-service`
  - `api-gateway -> permission-service`
- 异步：
  - 第一阶段不引入上下文切换通知联动；若后续纳入安全治理，应作为独立协同议题处理

## 6. 真相归属

- 当前可切换 account context 列表：`identity-service`
- 切换后会话上下文与 token：以 [auth-service.md](../services/auth-service.md) 为准
- 权限摘要：`permission-service`
- HTTP contract 与前端消费形状：`api-gateway`
- 前端刷新链路：`tenant-web`

## 7. 明确禁止

- 不把上下文切换做成纯前端本地状态切换
- 不在前端复制下游服务内部类型作为长期契约
- 不让 task-owned Delivery Package 长期承载这一协同链路正文

## 8. 关联文档

- [unified-web-account-context.md](../platforms/unified-web-account-context.md)
- [auth-service.md](../services/auth-service.md)
- [identity-service.md](../services/identity-service.md)
- [permission-service.md](../services/permission-service.md)
- [auth BFF login contract](../../contracts/api-gateway/auth-bff-login.md)
