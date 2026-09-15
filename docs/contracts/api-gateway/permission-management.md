# Permission Management API

> `permission-service` 的服务设计唯一真相源：[permission-service.md](../../architecture/services/permission-service.md)。本文只描述 API Gateway permission-management HTTP contract 与页面接入边界，不重新定义 Permission、Role、AccountRole、Policy、navigation governance 或 terminal access 的长期 owner 边界。

## 1. 组定位

本组接口用于权限管理后台读取和维护全局 `Permission` / `Role` 主数据。

`Policy Governance Readonly` 是本组后续只读扩展，只用于查看既有 policy 事实，不开放 policy mutation。

当前状态：

- `permission` 组首批接口已完成 Gateway HTTP → permission-service gRPC 真实联调验证
- `role` 组首批接口已完成 Gateway HTTP → permission-service gRPC 真实联调验证
- `role-template` 组首批接口已完成 Gateway HTTP → permission-service gRPC 真实联调验证
- `account-role` 组首批接口已完成 Gateway HTTP → permission-service gRPC 真实联调验证
- `policy-governance-readonly` 组已实现 Gateway / tenant-web 只读入口
- `policy-instance-management` 组已实现 Gateway / tenant-web list / detail / create / enable-disable 第一阶段入口
- 已验证系统管理员账号可完成 permission / role / role-template / account-role 的首批管理闭环
- 本组接口依赖 Gateway 全局 `checkPermission` guard，guard 会携带 `api-gateway` 内部服务 metadata 调用 permission-service

当前这组接口不是 BFF 编排，而是：

- 平台管理薄代理
- 面向系统管理员 / 权限管理员
- 少量只读字典查询对租户管理员开放

## 2. 当前已冻结的 `permission` 组边界

### `GET /permission`

- 用途：读取全局权限字典列表，并支持基础过滤
- 使用人：
  - 系统管理员
  - 租户管理员（仅全局只读字典可见）
- 权限控制：
  - `checkPermission(permission.list)`
- 不采用：
  - `buildQueryScope`
  - `checkResource`

支持的过滤参数：

- `module`
- `keyword`
- `page`
- `pageSize`

响应语义：

- 返回分页结构：`permissions / total / page / pageSize`
- `permissions[]` 为全局 permission 摘要
- 前端管理表格应使用 `total / page / pageSize` 驱动分页

### `POST /permission`

- 用途：创建全局权限字典项
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.create)`

### `GET /permission/:code`

- 用途：读取单个全局权限字典详情
- 使用人：
  - 系统管理员
  - 租户管理员（只读）
- 权限控制：
  - `checkPermission(permission.get_by_code)`

### `GET /permission/id/:id`

- 用途：按 ID 读取单个全局权限字典详情
- 使用人：
  - 系统管理员
  - 租户管理员（只读）
- 权限控制：
  - `checkPermission(permission.get_by_id)`
- 不采用：
  - `buildQueryScope`
  - `checkResource`

### `PATCH /permission/:id`

- 用途：修改全局权限字典项的可变元数据
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.update)`
- 可修改字段：
  - `module`
  - `description`
- 不允许修改：
  - `code`
- 不采用：
  - `buildQueryScope`
  - `checkResource`

### `GET /permission/:id/roles`

- 用途：查看当前引用该 permission 的角色
- 使用人：
  - 系统管理员
  - 租户管理员（只读）
- 权限控制：
  - `checkPermission(permission.role_template.list)`
  - `checkPermission(permission.role_instance.list)`
- 说明：
  - 这是权限详情页的辅助信息，真相来自 `permission-service.ListPermissionRoles`
  - 当前不在 Gateway 层做额外 `buildQueryScope`，角色可见性由下游 permission-service 管理语义约束

### `DELETE /permission/:id`

- 用途：删除全局权限字典项
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.delete)`

## 3. 当前已冻结的 `role` 组边界

### `GET /role`

- 用途：读取 role instance 分页列表，并支持基础过滤
- 使用人：
  - 系统管理员
  - 租户管理员（仅租户范围 role instance）
- 权限控制：
  - `checkPermission(permission.role_instance.list)`
- 支持的过滤参数：
  - `page`
  - `pageSize`
  - `tenantId`
  - `scopeLevel`: `SYSTEM` 或 `TENANT`
  - `keyword`
- 响应语义：
  - 返回分页结构：`roles / total / page / pageSize`
  - 系统管理员可通过 `scopeLevel=SYSTEM` 查看系统级 role instance
  - 租户管理员的可见范围由下游 permission-service 的 operator scope 约束
  - 返回项为标准 `RoleResponse`
  - 列表页可直接使用 `id / name / code / isEnabled / tenantId / roleKind / templateRoleId`

### `POST /role`

- 用途：创建 system 或 tenant role instance
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.create)`
- 请求字段：
  - `name`
  - `code`
  - `scopeLevel`: `SYSTEM` 或 `TENANT`
  - `tenantId`: tenant role 必填，system role 不传
  - `templateRoleId`: 可选
  - `description`: 可选
- 使用建议：
  - 新建 role instance 页直接使用该接口
  - 若创建 tenant role，前端应显式传入 `tenantId`
  - 若创建 system role，前端不应传 `tenantId`
  - 若页面是“从模板派生 tenant role”，前端优先改用 `POST /role-template/:id/instantiate`

### `GET /role/:id`

- 用途：读取单个 role instance 详情
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.role_instance.get_by_id)`
- 响应语义：
  - 返回单个标准 `RoleResponse`
  - 适合作为详情页、编辑页、权限页的基础初始化接口

### `PATCH /role/:id`

- 用途：修改 role instance 的可变元数据
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.update)`
- 可修改字段：
  - `name`
  - `description`
- 不允许修改：
  - `code`
  - `scopeLevel`
  - `tenantId`
- 使用建议：
  - 只用于编辑 role 的可变元数据
  - 如果页面在做启停切换，不应复用该接口，而应调用 `PATCH /role/:id/enabled`

### `PATCH /role/:id/enabled`

- 用途：启用或禁用 role instance
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.update)`
- 请求字段：
  - `isEnabled`
- 使用建议：
  - 这是列表页和详情页的启用 / 禁用专用入口
  - 前端不应通过 `PATCH /role/:id` 间接表达启停

### `GET /role/:id/permissions`

- 用途：读取 role instance 当前拥有的 permission 列表
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.role_instance.get_by_id)`
- 响应语义：
  - 返回结构：`permissions[]`
  - 当前返回的是全局 permission 摘要，不带分页
  - 适合作为 role 权限详情页或分配弹窗的已选状态来源

### `POST /role/:id/permissions`

- 用途：向 role instance 分配一个 permission
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.assign_permissions)`
- 请求字段：
  - `permissionId`
- 使用建议：
  - 适合单条分配
  - 若后续页面需要“全量替换角色权限集合”，当前 contract 还没有对应批量接口

### `DELETE /role/:id/permissions/:permissionId`

- 用途：从 role instance 撤销一个 permission
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.assign_permissions)`
- 使用建议：
  - 适合单条撤销
  - 当前不承接批量撤销或整页全量替换

### `DELETE /role/:id`

- 用途：删除 role instance
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.delete)`
- 使用建议：
  - 删除前前端可先用 `GET /role/:id/permissions` 和 `GET /role/:id/accounts` 做影响面提示

## 4. 当前已冻结的 `role-template` 组边界

### `GET /role-template`

- 用途：读取 role template 分页列表，并支持基础过滤
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.list)`
- 支持的过滤参数：
  - `page`
  - `pageSize`
  - `keyword`
- 响应语义：
  - 返回分页结构：`roles / total / page / pageSize`
  - 返回项为全局 role template，而不是 tenant / system role instance
  - 返回项同样是标准 `RoleResponse`
  - 前端列表页可直接使用 `id / name / code / isEnabled / roleKind`

### `POST /role-template`

- 用途：创建全局 role template
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.create)`
- 使用建议：
  - 模板创建页直接使用该接口
  - 这是“全局模板”入口，不应传 `tenantId`

### `GET /role-template/:id`

- 用途：读取单个 role template 详情
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.get_by_id)`
- 响应语义：
  - 返回单个标准 `RoleResponse`
  - 适合作为模板详情页、编辑页、模板权限页的初始化接口

### `PATCH /role-template/:id`

- 用途：修改 role template 的可变元数据
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.update)`
- 可修改字段：
  - `name`
  - `description`
- 使用建议：
  - 只用于模板元数据编辑
  - 启停切换应走 `PATCH /role-template/:id/enabled`

### `PATCH /role-template/:id/enabled`

- 用途：启用或禁用 role template
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.update)`
- 使用建议：
  - 这是模板列表页和模板详情页的启停专用入口

### `GET /role-template/:id/permissions`

- 用途：读取 role template 当前拥有的 permission 列表
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.get_by_id)`
- 响应语义：
  - 返回结构：`permissions[]`
  - 当前返回的是模板当前继承给实例化角色的 permission 集合

### `POST /role-template/:id/permissions`

- 用途：向 role template 分配一个 permission
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.assign_permissions)`
- 使用建议：
  - 适合模板权限详情页中的单条分配动作

### `DELETE /role-template/:id/permissions/:permissionId`

- 用途：从 role template 撤销一个 permission
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.assign_permissions)`
- 使用建议：
  - 适合模板权限详情页中的单条撤销动作

### `POST /role-template/:id/instantiate`

- 用途：从 role template 创建一个 tenant role instance
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.create_from_template)`
- 说明：
  - 当前实例化目标是 tenant role instance，因此 `tenantId` 必填
  - 模板上的 permissions 会复制到新建的 role instance
  - 前端若提供“从模板创建租户角色”入口，应优先用该接口，而不是先读模板再手工调 `POST /role`

### `DELETE /role-template/:id`

- 用途：删除 role template
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_template.delete)`
- 使用建议：
  - 删除前前端可先用 `GET /role-template/:id/permissions` 做影响面提示

## 5. `role` / `role-template` 页面接入建议

### 5.1 Role Instance 列表页

- 页面目标：查看和筛选 system / tenant role instance
- 推荐列表初始化：
  - system role 列表：`GET /role?scopeLevel=SYSTEM`
  - tenant role 列表：`GET /role?scopeLevel=TENANT&tenantId=:tenantId`
- 推荐筛选参数：
  - `keyword`
  - `page`
  - `pageSize`
- 前端不应假设：
  - 一个列表同时天然混合 system / tenant 数据且无需显式区分

### 5.2 Role Instance 新建 / 编辑页

- 新建页：
  - system role：`POST /role`，传 `scopeLevel=SYSTEM`
  - tenant role：`POST /role`，传 `scopeLevel=TENANT + tenantId`
- 编辑页初始化：
  - `GET /role/:id`
- 编辑页保存：
  - `PATCH /role/:id`
- 启停：
  - `PATCH /role/:id/enabled`
- 不推荐：
  - 用编辑接口同时承载启停
  - 用模板实例化接口去创建 system role

### 5.3 Role Permission 页

- 页面目标：查看和维护某个 role instance 拥有的 permission
- 推荐初始化：
  - `GET /role/:id`
  - `GET /role/:id/permissions`
- 单条分配：
  - `POST /role/:id/permissions`
- 单条撤销：
  - `DELETE /role/:id/permissions/:permissionId`
- 当前边界：
  - 还没有批量替换整组 permissions 的接口
  - 前端若做多选分配，需要自己编排多次单条提交

### 5.4 Role Template 列表 / 详情页

- 页面目标：管理全局 role template
- 列表初始化：
  - `GET /role-template`
- 详情 / 编辑初始化：
  - `GET /role-template/:id`
- 保存元数据：
  - `PATCH /role-template/:id`
- 启停：
  - `PATCH /role-template/:id/enabled`

### 5.5 Role Template Permission 页

- 页面目标：查看和维护模板自带的 permissions
- 推荐初始化：
  - `GET /role-template/:id`
  - `GET /role-template/:id/permissions`
- 单条分配：
  - `POST /role-template/:id/permissions`
- 单条撤销：
  - `DELETE /role-template/:id/permissions/:permissionId`
- 当前边界：
  - 还没有模板权限的批量替换接口

### 5.6 从模板实例化 Tenant Role

- 页面目标：基于模板快速创建某个 tenant 的 role instance
- 推荐流程：
  - 先在模板列表或详情页选择模板
  - 明确目标 `tenantId`
  - 调 `POST /role-template/:id/instantiate`
- 当前适合输入：
  - `tenantId`
  - 可选覆盖的 `name / description`
- 当前不适合：
  - 覆盖模板 `code`；实例 `code` 必须继承模板 `code`
  - 用它创建 system role
  - 用它替代模板本身的编辑

## 6. 当前已冻结的 `account-role` 组边界

### `GET /account/:accountId/roles`

- 用途：读取某个账号当前生效的 role 绑定列表
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.account.get_roles)`
- 支持的过滤参数：
  - `tenantId`
  - `scopeLevel`: `SYSTEM` 或 `TENANT`
- 响应语义：
  - 返回结构：`roles[]`
  - 仅返回当前有效 role，不返回历史过期绑定
  - 返回项为标准 `RoleResponse`
  - 前端可直接用 `id / name / code / isEnabled / tenantId / roleKind / templateRoleId` 做展示与编辑态回显

### `GET /account/:accountId/roles/selection`

- 用途：读取账号角色设置页所需的“可分配角色 + 已选角色”
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.account.get_roles)`
- 支持的过滤参数：
  - `tenantId`
  - `scopeLevel`: `SYSTEM` 或 `TENANT`
- 响应语义：
  - 返回结构：`availableRoles[] + selectedRoleIds[]`
  - 面向 checkbox / dual-list 这类账号角色设置页面
  - `availableRoles[]` 是当前操作者在该 scope 下“允许分配”的候选 role
  - `selectedRoleIds[]` 是该账号当前已经生效的 role id 集合
  - 前端应优先使用该接口初始化“角色设置页”，而不是自己拼装 `GET /role` + `GET /account/:accountId/roles`

### `POST /account/:accountId/roles`

- 用途：给某个账号增量授予一个 role instance
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.account.assign_roles)`
- 请求字段：
  - `accountType`: `USER` 或 `SERVICE`
  - `roleId`
  - `scopeLevel`: `SYSTEM` 或 `TENANT`
  - `tenantId`: tenant 绑定时填写，system 绑定时不传
  - `effectiveAt`: 可选
  - `expiresAt`: 可选
- 使用建议：
  - 只适合“单个授予”动作，例如详情页里的“补授一个角色”
  - 如果页面本身是 checkbox 全量编辑，前端应优先改用 `PUT /account/:accountId/roles`

### `DELETE /account/:accountId/roles/:roleId`

- 用途：撤销某个账号上的一个 role instance 绑定
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.account.assign_roles)`
- 使用建议：
  - 只适合“单个撤销”动作
  - checkbox 全量编辑页保存时，前端不应逐个调 delete，而应统一调 `PUT /account/:accountId/roles`

### `PUT /account/:accountId/roles`

- 用途：按 scope 一次性替换某个账号的角色集合
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.account.assign_roles)`
- 请求字段：
  - `accountType`: `USER` 或 `SERVICE`
  - `scopeLevel`: `SYSTEM` 或 `TENANT`
  - `tenantId`: tenant 绑定时填写，system 绑定时不传
  - `roleIds[]`
- 说明：
  - 这是账号角色设置页的主保存入口
  - 当前为“全量替换”语义，不是增量 patch
  - 建议前端把当前勾选结果完整映射到 `roleIds[]` 后一次提交
  - 若当前编辑的是 tenant 账号角色页，应固定传入 `scopeLevel = TENANT` 与对应 `tenantId`
  - 若当前编辑的是系统账号角色页，应固定传入 `scopeLevel = SYSTEM` 且不传 `tenantId`

### `GET /role/:roleId/accounts`

- 用途：读取当前引用某个 role instance 的账号绑定列表
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.account.get_roles)`
- 响应语义：
  - 返回结构：`accounts[]`
  - 返回项包含 `accountId / accountType / roleId / tenantId / scopeLevel`
  - 当前返回的是绑定摘要，不是账号详情；如果前端后续需要展示昵称/邮箱，应由账号管理场景补充对应查询接口

## 7. `account-role` 页面接入建议

### 7.1 账号角色设置页

- 页面目标：编辑“某个账号在某个 scope 下拥有哪些角色”
- 推荐初始化顺序：
  - 先拿到目标 `accountId`
  - 明确当前编辑上下文是 `SYSTEM` 还是 `TENANT`
  - 若是 tenant 页面，同时明确 `tenantId`
  - 调 `GET /account/:accountId/roles/selection`
- 推荐保存顺序：
  - 用户修改勾选结果
  - 前端将最终勾选项汇总为 `roleIds[]`
  - 调 `PUT /account/:accountId/roles`
- 不推荐：
  - 初始化时前端自己拼 `GET /role` 和 `GET /account/:accountId/roles`
  - 保存时前端逐个 `POST` / `DELETE` 进行差量同步

### 7.2 角色详情成员页

- 页面目标：查看“某个 role 当前被哪些账号绑定”
- 推荐接口：
  - `GET /role/:roleId/accounts`
- 当前适合的展示：
  - 绑定数量
  - `accountId`
  - `accountType`
  - `tenantId`
  - `scopeLevel`
- 当前不应假设：
  - 返回账号 display name
  - 返回邮箱 / 手机 / 头像
  - 返回用户实体完整资料

### 7.3 前端参数约束

- `scopeLevel = TENANT` 时：
  - 前端应传 `tenantId`
  - 页面语义是“编辑该 tenant 下的账号角色”
- `scopeLevel = SYSTEM` 时：
  - 前端不传 `tenantId`
  - 页面语义是“编辑系统账号的系统角色”
- `accountType` 当前只允许：
  - `USER`
  - `SERVICE`
- `effectiveAt / expiresAt` 当前只在单次授予接口 `POST /account/:accountId/roles` 生效
- `PUT /account/:accountId/roles` 当前不承接时间窗口编辑

## 8. 已删除或不推荐的兼容接口

以下旧接口已被统一列表入口吸收，不再作为长期契约保留：

- `GET /permission/all`
- `GET /permission/by-module`

## 9. 当前已冻结的 `policy-governance-readonly` 组边界

本组接口用于权限治理后台只读查看 policy 主数据与 permission-policy 绑定关系。

本组展示的是 legacy `Policy + conditionAstJson` readonly governance，不是 `PolicyInstance` 资源授权管理入口。新的资源授权配置主线以 `permission-service` 的 `PolicyTemplate / PolicyInstance + ResourceAuthorizationService` 为准，黑盒语义见 [permission-service/resource-authorization.md](../permission-service/resource-authorization.md)。`PolicyInstance` 管理与 preview 必须使用下方独立 contract 分组，不得复用本组旧 AST 语义。

当前边界：

- 只读治理，不开放 policy 创建、修改、删除、启停。
- 不开放 `conditionAstJson` 编辑。
- 不做 Policy Explain / Impact Preview。
- 不做 Rule Builder。
- 不做 Resource Policy Business Rollout。
- 不接入 feature / plugin enablement。

Gateway 内部仍保留 `deleteLegacyPolicy` 兼容清理路径，仅用于账号删除时清理历史 account-scoped AST policy。该方法不是 HTTP contract，不得作为新 policy mutation surface 使用。

`permission-service` 底层 legacy Policy AST mutation RPC 已默认封存；只有显式历史兼容恢复开关打开时才会执行。API Gateway 不提供打开该能力的 HTTP 入口。

### `GET /policy`

- 用途：读取 policy 分页列表，并支持基础过滤。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.list)`
- 支持的过滤参数：
  - `page`
  - `pageSize`
  - `tenantId`
  - `permissionCode`
  - `isEnabled`
  - `keyword`
- 响应语义：
  - 返回分页结构：`policies / total / page / pageSize`
  - `policies[]` 为只读 policy 摘要。
  - `conditionAstJson` 可返回给只读详情和只读 JSON 展示，不得被前端编辑后提交。

### `GET /policy/:id`

- 用途：读取单个 policy 详情。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.list)`
- 响应语义：
  - 返回单个 policy 详情。
  - 包含 `effect / subjectType / subjectId / permissionCode / resourceType / tenantId / priority / isEnabled / conditionAstJson`。
  - 适合作为 policy 详情抽屉或只读详情页初始化接口。

### `GET /permission/:permissionCode/policies`

- 用途：查看某个 permission 当前关联的 policy 列表。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.list)`
- 支持的过滤参数：
  - `tenantId`
- 响应语义：
  - 返回结构：`policies[]`
  - 面向 permission 详情页的“关联策略”只读区域。
  - 不提供添加、移除、启停 policy 的动作。

### `policy-governance-readonly` 页面接入建议

- Policy 列表页：
  - `GET /policy`
- Policy 详情：
  - `GET /policy/:id`
- Permission 详情关联策略：
  - `GET /permission/:permissionCode/policies`
- 页面必须保持只读：
  - 不渲染 create / edit / delete / enable-disable 操作。
  - 不允许提交 `conditionAstJson`。
  - 不把 explain / impact preview 混入当前页面主线。

## 9.1 当前已冻结的 `policy-instance-management` 组边界

本组接口用于查看并执行第一阶段受控 template-based `PolicyInstance` 资源授权事实管理。

当前边界：

- 支持 list / detail。
- 支持 create。
- 支持 enable / disable。
- 尚不开放 full update / delete。
- 不返回 legacy `conditionAstJson`。
- 不允许前端把 `params` 当自由 AST 编辑器使用。
- `list / detail` 使用 `permission.policy.list`。
- `create` 使用 `permission.policy.create`。
- `enable / disable` 使用 `permission.policy.update`。
- 下游黑盒契约见 [permission-service/policy-instance-management.md](../permission-service/policy-instance-management.md)。

### `GET /policy-instance`

- 用途：读取 `PolicyInstance` 分页列表，并支持基础过滤。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.list)`
- 支持的过滤参数：
  - `page`
  - `pageSize`
  - `tenantId`
  - `permissionCode`
  - `resourceType`
  - `templateCode`
  - `enabled`
- 响应语义：
  - 返回分页结构：`policyInstances / total / page / pageSize`
  - `policyInstances[]` 为 `PolicyInstance` 只读摘要。
  - `subjectSelector / templateCode / params / effect / enabled / priority` 来自 `permission-service` 的 `PolicyInstanceManagementService`。

### `GET /policy-instance/:id`

- 用途：读取单个 `PolicyInstance` 详情。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.list)`
- 响应语义：
  - 返回单个 `PolicyInstance` 详情。
  - 包含 `subjectSelector / permissionCode / resourceType / templateCode / effect / params / enabled / priority / createdBy / updatedBy / createdAt / updatedAt`。
  - 不包含业务资源主数据；业务资源 truth 仍由各业务服务拥有。

### `POST /policy-instance`

- 用途：创建一个 template-based `PolicyInstance`。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.create)`
- 请求语义：
  - `tenantId`
  - `subjectSelector`
  - `permissionCode`
  - `resourceType`
  - `templateCode`
  - `effect`
  - `params`
  - `enabled`
  - `priority`
- 响应语义：
  - 返回创建后的 `PolicyInstance`。
  - `createdBy / updatedBy` 来自 authenticated operator context。
  - `params` 由 permission-service 按 built-in template schema 校验。
  - Gateway 不校验业务资源主数据存在性。

### `POST /policy-instance/:id/enabled`

- 用途：启用或停用一个 `PolicyInstance`。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.update)`
- 请求字段：
  - `enabled`
- 响应语义：
  - 返回更新后的 `PolicyInstance`。
  - 仅表达启停，不表达 full update。

### `policy-instance-management` 页面接入建议

- PolicyInstance 列表页：
  - `GET /policy-instance`
- PolicyInstance 详情：
  - `GET /policy-instance/:id`
- PolicyInstance 创建：
  - `POST /policy-instance`
- PolicyInstance 启停：
  - `POST /policy-instance/:id/enabled`
- 页面必须保持模板受控：
  - 不允许提交模板 schema 外的 `params`。
  - 不把 `params` 渲染成自由 AST / rule builder。
- tenant-web 当前治理入口：
  - route: `/admin/policy-instance-management`
  - navigation entry: `admin.policy-instance-management`

## 9.2 当前已冻结的 `policy-instance-preview` 组边界

本组接口用于验证 template-based `PolicyInstance` 资源授权主线是否可从管理端触发真实判定。

当前边界：

- preview-only，不持久化 `PolicyInstance`。
- 不开放完整 PolicyInstance CRUD。
- 不开放旧 `Policy.conditionAstJson` 编辑。
- 不作为业务服务 runtime resource authorization RPC。
- 使用 `permission.policy.list` 作为第一阶段粗粒度管理入口权限。

### `POST /policy-instance/evaluate-preview`

- 用途：提交候选 `PolicyInstance` 与 subject/resource facts，返回 `checkResource` 或 `buildQueryScope` 预览结果。
- 使用人：
  - 系统管理员
  - 权限管理员
- 权限控制：
  - `checkPermission(permission.policy.list)`
- 请求语义：
  - `mode = CHECK_RESOURCE | QUERY_SCOPE`
  - `subject` 必须包含 `accountId / tenantId / roleIds`
  - `policyInstances[]` 是 preview-only candidate，不写入数据库
  - `QUERY_SCOPE` 返回结构化 `scope`
  - `CHECK_RESOURCE` 消费调用方提供的 `resource` facts
- 响应语义：
  - 返回 `allowed / reasonCode / matchedPolicyIds / deniedPolicyIds`
  - `scope` 为结构化 QueryScopeExpression，不包含 raw SQL
  - 返回结果只用于管理验证，不代表某个业务服务已经完成 rollout
- tenant-web 当前治理入口：
  - route: `/admin/policy-instance-preview`
  - navigation entry: `admin.policy-instance-preview`

## 10. 当前已冻结的 `navigation-management` 组边界

本组接口用于权限管理后台读取和维护第一阶段 navigation governance 主数据。

定位约束：

- 当前仍属于 `permission-management` 管理薄代理，不新增独立 navigation BFF。
- 当前只治理稳定 `entryKey`、role visibility 与 role landing policy。
- 当前不承载 Web route、菜单层级、icon、layout 等 terminal-specific UI 配置。
- 当前不承载用户个人 landing preference。

### `GET /navigation/entries`

- 用途：读取 navigation entry registry 列表，并支持基础过滤。
- 使用人：
  - 系统管理员 / 权限管理员
  - 具备角色导航配置能力的租户管理员（只读 registry，用于选择 role 可见 entries）
- 权限控制：
  - `checkPermission(permission.navigation.entry.list)`
- 支持的过滤参数：
  - `keyword`
  - `featureKey`
  - `terminal`
  - `enabled`
- 响应语义：
  - 返回稳定 entry registry 摘要列表。
  - 返回项应至少包含：
    - `entryKey`
    - `name`
    - `description`
    - `featureKey`
    - `supportedTerminals[]`
    - `registryPriority`
    - `enabled`
    - `entryType`

### `POST /navigation/entries`

- 用途：创建一个新的 navigation entry registry 项。
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.navigation.entry.create)`
- 请求语义：
  - 只允许创建稳定 entry 元数据。
  - 不允许提交 Web route、菜单层级、icon、layout。

### `GET /navigation/entries/:entryKey`

- 用途：读取单个 navigation entry registry 项详情。
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.navigation.entry.get_by_key)`

### `PATCH /navigation/entries/:entryKey`

- 用途：修改 navigation entry registry 的可变元数据。
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.navigation.entry.update)`
- 第一阶段可修改字段：
  - `name`
  - `description`
  - `featureKey`
  - `supportedTerminals`
  - `registryPriority`
  - `enabled`
  - `entryType`
- 第一阶段不允许：
  - 修改 `entryKey`
  - 真删除被引用 entry

### `GET /roles/:roleId/navigation`

- 用途：读取某个 role 当前的 navigation 配置。
- 使用人：
  - 系统管理员
  - 租户管理员（仅其租户范围）
- 权限控制：
  - `checkPermission(permission.role_instance.get_by_id)`
- 响应语义：
  - 返回该 role 当前可见 entries。
  - 返回该 role 当前 landing policies。
  - 适合作为 `Role Detail > Navigation` 页的初始化接口。

### `PUT /roles/:roleId/navigation/visibility`

- 用途：整组替换某个 role 的 navigation visible entries 集合。
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.update)`
- 请求语义：
  - 采用“整组覆盖”而不是单条 add / remove patch。
  - 每项 visibility 至少应带：
    - `entryKey`
    - `scopeLevel`
    - `terminal`
    - `enabled`
- 服务端校验：
  - `entryKey` 必须存在。
  - `entryKey` 必须处于 enabled 状态。
  - `entryKey` 必须支持目标 terminal。

### `PUT /roles/:roleId/navigation/landing-policies`

- 用途：整组替换某个 role 的 landing policy 集合。
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.role_instance.update)`
- 请求语义：
  - 以 `scopeLevel + terminal` 为键提交整组 landing policy。
  - 每项 policy 至少应带：
    - `defaultEntryKey`
    - `scopeLevel`
    - `terminal`
    - `priority`
    - `enabled`
- 服务端校验：
  - `defaultEntryKey` 必须存在。
  - `defaultEntryKey` 必须属于当前 role 可见 entries。
  - `defaultEntryKey` 必须支持目标 terminal。
- 规则说明：
  - landing policy 只影响默认落点，不授予 entry 可见性或动作权限。

### `POST /navigation/resolve-preview`

- 用途：预览某组 role / scope / terminal 在当前导航治理规则下会解析出的 `visibleEntries` 与 `defaultEntry`。
- 使用人：
  - 系统管理员 / 权限管理员
- 权限控制：
  - `checkPermission(permission.navigation.resolve_preview)`
- 输入语义：
  - `roleIds[]`
  - `scopeLevel`
  - `terminal`
- 第一阶段边界：
  - 正式接口直接支持多 role 组合输入。
  - role 页面做单 role 预览时复用同一接口，并传单元素 `roleIds[]`。
- 输出语义：
  - `visibleEntries`
  - `defaultEntry`
  - 可选 `resolvedByRoleId`
  - 可选 `fallbackReason`

### `navigation-management` 页面接入建议

- `Navigation Entry` 页面：
  - `GET /navigation/entries`
  - `POST /navigation/entries`
  - `GET /navigation/entries/:entryKey`
  - `PATCH /navigation/entries/:entryKey`
- `Role Detail > Navigation` 页面：
  - `GET /roles/:roleId/navigation`
  - `PUT /roles/:roleId/navigation/visibility`
  - `PUT /roles/:roleId/navigation/landing-policies`
  - `POST /navigation/resolve-preview`

## 11. `terminal-access-management` 组边界

本组接口用于管理 Terminal Access Policy。该能力属于 `permission-service` 的 role / access governance 范围，通过 `api-gateway` 的 permission-management 薄代理对管理端开放。

### 边界

- 运行时判定 RPC `ResolveAccountTerminalAccess` 不直接暴露给前端。
- 管理接口只负责配置、读取和当前账号最终准入展示。
- 登录准入裁决仍由 `auth-service -> permission-service` 的内部 gRPC 链路完成。
- 管理 UI Phase 1 只显示 `WEB / PDA / KIOSK`。
- 后端 enum 预留 `MOBILE / MINIAPP`。

### 权限码建议

- `permission.terminal_access.role.view`
- `permission.terminal_access.role.update`
- `permission.terminal_access.account_override.view`
- `permission.terminal_access.account_override.update`

### `GET /roles/:roleId/terminal-access`

- 用途：读取某个 role 的 terminal access 配置。
- 权限控制：
  - `checkPermission(permission.terminal_access.role.view)`
  - 租户管理员只能读取本租户 role instance
  - system admin 可读取 system role instance 与 template
- 响应语义：

```json
{
  "roleId": "role_001",
  "allowedTerminals": ["WEB", "PDA"]
}
```

### `PUT /roles/:roleId/terminal-access`

- 用途：整组替换某个 role 的 allowed terminals。
- 权限控制：
  - `checkPermission(permission.terminal_access.role.update)`
  - 租户管理员只能更新本租户 role instance
  - system admin 可更新 system role instance 与 template
  - template 修改不自动同步已有 role instances
- 请求语义：

```json
{
  "allowedTerminals": ["WEB", "PDA"]
}
```

- 空数组允许，表示该 role 不提供任何 terminal login access。
- 成功后必须记录管理审计。

### `GET /accounts/:accountId/terminal-access`

- 用途：读取一个账号的最终 terminal access，用于管理员账号详情展示。
- 权限控制：
  - `checkPermission(permission.terminal_access.account_override.view)`
  - 租户管理员只能读取本租户账号
  - system admin 可读取 system account
- 响应语义：

```json
{
  "accountId": "acc_001",
  "scopeLevel": "TENANT",
  "tenantId": "tenant_001",
  "overrideEnabled": true,
  "effectiveAllowedTerminals": ["WEB"],
  "overrideAllowedTerminals": ["WEB"]
}
```

### `PUT /accounts/:accountId/terminal-access-override`

- 用途：启用或更新账号专属 terminal access。
- 权限控制：
  - `checkPermission(permission.terminal_access.account_override.update)`
  - 租户管理员只能更新本租户账号
  - system admin 可更新 system account
  - 后端必须通过 `identity-service` 校验目标账号 scope / tenant 事实
- 请求语义：

```json
{
  "allowedTerminals": ["WEB"]
}
```

- 空数组允许，表示账号级全终端封禁；UI 必须二次确认。
- 成功后必须记录管理审计。

### `DELETE /accounts/:accountId/terminal-access-override`

- 用途：关闭账号专属 terminal access，恢复 role 默认 union。
- 权限控制：
  - `checkPermission(permission.terminal_access.account_override.update)`
  - 租户管理员只能删除本租户账号 override
  - system admin 可删除 system account override
- 成功后必须记录管理审计。

## 12. 真相源

前端或调用方除本文件外，还应同时参考以下真相源：

- Gateway controller：
  - [permission.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/permission.controller.ts)
  - [role.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/role.controller.ts)
  - [role-template.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/role-template.controller.ts)
  - [account-role.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/account-role.controller.ts)
  - [policy.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/policy.controller.ts)
  - [policy-instance.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/policy-instance.controller.ts)
  - [policy-instance-preview.controller.ts](../../../src/services/api-gateway/src/modules/permission-service/interface/http/controllers/policy-instance-preview.controller.ts)
- Gateway DTO
- 下游 proto：
  - [permission_management.proto](../../../src/common/src/contracts/permission_service/permission_management.proto)
  - [policy_management.proto](../../../src/common/src/contracts/permission_service/policy_management.proto)
- 服务设计真相源：
  - [permission-service.md](../../architecture/services/permission-service.md)

## 13. 文档边界

- 本文保留“调用方可依赖的权限管理 HTTP 契约”和“页面接入边界”。
- 详细按钮权限、页面实现步骤、测试命令与联调记录，不再继续堆叠到本文件。
- 后续阶段执行过程应记录在 task-owned DP；未解决的设计事项进入对应 active design 或 backlog，而不是污染契约正文。
