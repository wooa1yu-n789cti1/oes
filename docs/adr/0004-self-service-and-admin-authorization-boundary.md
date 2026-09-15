# ADR 0004: Self-service And Admin Authorization Boundary

> 当前 `permission-service` 服务职责、核心对象与 owner 边界以 [permission-service.md](../architecture/services/permission-service.md) 为准；本 ADR 只保留 self-service 与 admin-management 授权边界的架构决策记录。

日期：2026-04-21

## 状态

Accepted

## 背景

OES 当前在个人中心与账户安全场景中，已经同时存在两类语义完全不同的操作：

- 当前登录主体管理自己的资料与安全设置
- 管理员在范围内治理其他账号或其他用户的资料与安全状态

这些能力在产品上都看起来像“修改资料”或“管理登录方式”，但它们的授权语义并不相同。

近期联调已暴露出一个典型问题：

- `PATCH /auth/personal-center/account-profile` 这类 self-service 接口，实际复用了管理员修改账号资料的下游权限门，导致普通登录用户修改自己的头像、显示名、简介时被 `identity.account.profile.update` 拦截
- 账户安全中的登录方式启停也复用了管理员登录方式管理入口，导致普通登录用户管理自己的登录方式时被 `auth.login_method.manage` 一类管理员权限语义拦截

这说明系统里出现了一个不稳定边界：

- self-service 与 admin-management 在产品流程上已分开
- 但在接口授权语义上仍被混用

如果继续把“我能改我自己”主要建模为岗位 `RBAC` 权限，会产生以下问题：

- 普通用户需要依赖额外角色绑定才能完成本应天然具备的自助能力
- `RBAC` 同时承担岗位授权与基础自助能力，语义污染
- 漏绑基础角色时，系统会出现“明明是自己的数据却无权修改”的错误
- 后续个人中心、登录方式、MFA、会话等自助能力会继续被错误复用管理员接口

## 决策

OES 采用以下长期规则：

1. self-service 与 admin-management 是两类不同的授权能力，不得继续混用。
2. self-service 默认基于“authenticated operator + self-bound target + 白名单字段 / 动作 + 安全策略 + 审计”放行。
3. admin-management 默认基于“`RBAC` 权限码 + scope / resource 检查 + 审计”放行。
4. self-service 与 admin-management 必须在接口 / 契约层显式分开，不得让 self-service 直接复用管理员接口的权限门。
5. application / domain 层可以复用底层业务逻辑，但接口层授权语义必须分开。
6. tenant / system 若要关闭某项自助能力，应通过 self-service policy / capability 开关表达，而不是通过不给普通用户授予管理员权限码来实现。

## 具体边界

### 默认属于 self-service capability 的能力

- 修改自己的头像
- 修改自己的显示名
- 修改自己的个人简介
- 修改自己的密码
- 管理自己的登录方式
- 管理自己的 MFA 因子
- 管理自己的会话与安全设备

这些能力的共同约束是：

- 目标对象必须由服务端绑定到当前会话主体
- 只允许白名单字段与白名单动作
- 仍需满足业务底线规则
- 必须保留审计

### 默认属于 admin-management 的能力

- 修改别人账号资料
- 启用 / 停用别人登录方式
- 要求别人重设密码
- 停用账号
- 调整角色、组织、租户归属
- 修改组织下发的工作联系方式或其他治理字段

这些能力的共同约束是：

- 需要显式管理员权限码
- 需要 operator scope / resource scope 校验
- 必须保留审计

## 不采用的方案

### 方案 A：所有自助能力都放进“普通用户角色”

不作为主方案。

原因：

- “我能改我自己”首先是认证主体的基础自助能力，不是岗位授权
- 会让 `RBAC` 同时承担岗位权限与基础自助能力，模型变脏
- 每个账号都必须补绑基础角色，容易出现漏绑即不可用的问题
- 多账号、多 scope 用户下，基础角色到底绑在 `user` 还是 `account` 上会继续制造歧义

说明：

- 如果个别前端投影或运营策略确实需要一个“基础能力视图”，可以作为 capability projection 存在
- 但它不应成为 self-service 的主授权真相

### 方案 B：完全只保留一套管理员接口，然后在调用方特判“如果 target 是自己就放行”

不采用。

原因：

- 会把 self-service 与 admin-management 的契约语义继续混在一起
- 容易在别的调用链复用时再次误伤普通用户
- 不利于审计、测试和 Delivery acceptance 对齐

## 影响

### 对 api-gateway / BFF

- 必须对 personal-center、账户安全、自助密码、自助登录方式、自助 MFA 等能力暴露独立的 self-service contract
- self-service target 必须由当前会话解析，不接受前端任意传入他人 target
- 管理员 contract 继续显式携带 target，并做 account / user / scope 收敛

### 对 auth-service

- 自助密码、自助登录方式、自助 MFA、自助 session 管理必须拥有独立的 self-service 授权路径
- 管理员治理他人登录方式、密码 setup requirement、强制安全动作继续走管理员路径
- 可以复用命令处理器，但不得复用同一个接口层权限门

### 对 identity-service

- 当前账号自己的低风险 `account profile` 编辑必须拥有 self-service 授权路径
- 修改他人资料或治理字段继续走管理员路径
- `avatar / displayName / bio` 一类低风险字段不得默认要求管理员资料修改权限码

### 对 permission-service

- 继续为 admin-management 提供 `RBAC`、scope、policy 支撑
- 不将基础 self-service 能力主语义收编为岗位权限模型

### 对前端

- 个人中心与账户安全页的按钮显隐，不应直接依赖管理员 action code
- 管理员页与个人自助页可共用视觉组件，但不能共用授权语义假设

## 后续要求

实现前必须先对齐以下真相源：

- [authorization-layering-and-resource-policy.md](../architecture/platforms/authorization-layering-and-resource-policy.md)
- [authentication-and-identity.md](../architecture/collaborations/authentication-and-identity.md)
- [auth BFF self-service contract](../contracts/api-gateway/auth-bff-self-service.md)
- [auth BFF login contract](../contracts/api-gateway/auth-bff-login.md)
- [document-governance.md](../governance/document-governance.md)
- [codex-execution-model.md](../governance/codex-execution-model.md)

若后续线程要修改以下路径中的授权语义，必须先确认与本 ADR 一致；若不一致，先更新 architecture / ADR，再进入实现：

- `src/services/api-gateway/src/modules/auth-bff/**`
- `src/services/system/auth-service/src/interfaces/grpc/**`
- `src/services/system/identity-service/src/interfaces/grpc/**`

## 当前落地状态

更新时间：2026-04-21

本 ADR 已冻结设计结论，但代码仍存在需要继续收口的缺口：

- `auth-service` 中首次登录补密码相关 self-service user 解析问题已修复，避免把 accountId 当作 userId
- 个人中心 `account profile` 自助编辑与账户安全中的登录方式自助启停，仍需继续按本 ADR 拆开 self-service 与 admin-management 的授权路径

因此，自 2026-04-21 起，任何继续复用管理员权限门来承接这两类自助能力的实现，都应视为与本 ADR 冲突，而不是可接受的兼容写法
