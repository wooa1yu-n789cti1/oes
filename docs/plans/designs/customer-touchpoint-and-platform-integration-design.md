# Customer Touchpoint And Platform Integration Design

```text
designKey: CUSTOMER-TOUCHPOINT-PLATFORM-INTEGRATION
designStatus: ACTIVE_DESIGN_WORKSPACE
```

> 涉及 permission-service 的服务职责、核心对象或 owner 边界时，以 [permission-service.md](../../architecture/services/permission-service.md) 为准；本文只记录客户触点与平台集成设计过程。

## 1. 目标

- 为 OES 的“对外客户触点 / 第三方平台接入”建立长期设计工作台。
- 收敛公司官网、品牌官网、小程序、APP、经销商门户、售后入口、Amazon / 抖音 / 京东 / Shopify 等平台账号与 OES 的协同骨架。
- 冻结当前已经比较明确的对象边界、集成方向与第一阶段价值点。
- 为后续继续讨论 capability、connector、CRM / 订单 / 售后回流与实现顺序提供恢复入口。

## 2. 当前范围

本 workspace 负责：

- 品牌 / 公司档案与客户触点的对象边界。
- 自有客户触点与第三方平台账号的区分。
- OES 与不同触点 / 平台的通信方向与接入模式。
- 发布目录、动态、询盘、在线客服、报价请求、订单回流、售后入口等高价值场景的设计草稿。
- 第一阶段最小落地方向与未来扩展约束。

本 workspace 不负责：

- 直接建立新服务或实现代码。
- 冻结 CRM / OMS / 售后 / 内容管理的正式服务归属。
- 冻结完整品牌管理域模型。
- 冻结完整商城交易、支付、履约、会员模型。
- 冻结完整客服 IM 系统或社媒运营系统。
- 替代 `docs/architecture/**`、`docs/contracts/**` 中的稳定真相源。

## 3. 涉及对象

- services:
  - future external touchpoint / connector governance owner, not yet frozen
  - `product` / future product master owner
  - future CRM lead / inquiry owner
  - future content / CMS owner
  - future order / commerce owner
  - future service / after-sales owner
  - `identity-service`
  - `permission-service`
  - `auth-service`
- external channels / systems:
  - company websites
  - brand websites
  - WeChat mini program
  - mobile app
  - dealer portal
  - service / after-sales mini program
  - Amazon
  - Shopify
  - Taobao / JD / Pinduoduo / Douyin store
  - WeChat official account / video account
  - Xiaohongshu

## 4. Human-confirmed directions pending UD review

本节记录 Design Workspace 内已经获得 Human 认同、但尚未由 UD 回写规范真相的方向。它们不是稳定架构或可直接实施的契约。

| 日期 | 决定 | 影响范围 | 回写目标 |
| --- | --- | --- | --- |
| 2026-04-23 | 当前设计主题不是“建站器”，而是 OES 的对外客户触点与平台接入框架。 | 产品定位 | future architecture / Delivery |
| 2026-04-23 | 需要区分“品牌 / 公司档案”和“客户触点”；前者表达谁在对外经营，后者表达客户从哪里接触。 | 核心对象边界 | future architecture |
| 2026-04-23 | 需要区分“自有客户触点”和“第三方平台账号”；二者的底层集成方式不同。 | 集成边界 | future architecture / integration design |
| 2026-04-23 | 自有客户触点的默认主路是 `API first`，第三方平台账号的默认主路是 `connector first`。 | 接入模式 | future contracts / connector design |
| 2026-04-23 | 自有客户触点可采用混合模式：实时能力走 API，异步同步可走 webhook / push / callback。 | 自有触点集成方式 | future contracts |
| 2026-04-23 | 第三方平台账号通常需要专用 connector；webhook / polling / platform API 由 connector 统一适配，再映射成 OES 内部对象。 | 平台接入模式 | future integration design |
| 2026-04-23 | OES 应作为产品唯一真相源，但外部触点消费的应是“发布目录 / 对外版本”，不是内部产品主数据原样暴露。 | 产品与发布边界 | future product / content / channel contracts |
| 2026-04-23 | 触点与 OES 的协同程度应分级，而不是所有触点都一口气支持全功能。 | 功能规划方式 | future Delivery |
| 2026-04-23 | 在线客服、表单询盘、报价请求、售后申请等“互动入口”具有高价值，应作为第一阶段重点能力。 | 第一阶段价值判断 | future Delivery |

## 5. 当前对象草稿

### 5.1 品牌 / 公司档案

用于表达“谁在对外经营”。

当前草稿职责：

- 公司名称 / 品牌名称 / 对外展示名
- Logo、简介、联系方式、默认语言
- 对外动态 / 内容 / 品牌介绍归属
- 发布目录归属
- 客服 / 询盘 / 售后默认归属

当前判断：

- 这是高优先级对象，后续不应只从“域名”反推经营主体。
- 第一阶段可先用轻量对象承载，不急着展开成完整 Brand Service。

### 5.2 自有客户触点

指你们自己控制前后端的入口，例如：

- 公司官网
- 品牌官网
- WeChat mini program
- mobile app
- dealer portal
- service / after-sales mini program
- OEM / ODM customer portal

当前草稿属性：

- 触点类型
- 所属品牌 / 公司档案
- 面向客户类型
- 面向市场
- 功能能力包
- 访问标识
  - website: domain / subdomain
  - mini program: appId
  - mobile app: bundleId / packageName
- 接入凭证 / client

### 5.3 第三方平台账号

指你们在外部平台上的经营账号，例如：

- Amazon store
- Shopify store
- Taobao / JD / Pinduoduo / Douyin store
- WeChat official account
- Xiaohongshu account
- video account

当前草稿属性：

- 平台类型
- 账号 / 店铺 ID
- 所属品牌 / 公司档案
- 市场 / 区域
- 允许的同步能力
- 平台授权状态
- webhook / polling / token 配置

### 5.4 发布目录

用于承载外部可见的产品 / 内容版本，而不是内部真相本体。

当前草稿职责：

- 哪些产品允许对外展示 / 销售
- 哪套图片、文案、语言版本
- 是否显示价格
- 用哪套价格
- 是否显示库存摘要
- 面向哪些触点 / 平台 / 市场

### 5.5 能力包

当前不是独立服务设计，而是触点配置方式。

当前草稿能力分类：

- 展示
  - 公司介绍
  - 品牌介绍
  - 资质
  - Blog / 动态
  - 产品目录
- 互动
  - 在线客服
  - 表单询盘
  - 报价请求
  - 样品申请
- 客户账户
  - 注册 / 登录
  - 我的询盘
  - 我的订单
  - 我的售后
- 交易
  - 价格
  - 库存摘要
  - 下单
  - 履约状态
- 售后
  - 扫码识别产品
  - 知识库
  - AI 问答
  - 人工售后
  - 维修 / 换货申请
- 经销
  - 经销商价
  - 补货
  - 渠道政策
  - 物料下载
- 内容分发
  - 内容发布
  - 社媒分发
  - 评论 / 私信回流

## 6. 集成模式草稿

### 6.1 自有客户触点

当前 Workspace 已确认方向：

- 默认采用 `API first`
- 适合实时交互场景：
  - 读取发布目录
  - 提交询盘
  - 提交报价请求
  - 登录后查询订单 / 售后
- 可选采用 webhook / push / callback 做异步同步：
  - 内容 / 产品更新通知
  - 静态站重建
  - 本地缓存刷新
  - 状态更新通知

推荐理解：

```text
自有触点 = API first, webhook optional
```

### 6.2 第三方平台账号

当前 Workspace 已确认方向：

- 默认采用 `connector first`
- OES 需要为平台建立专用 connector
- connector 负责：
  - 调用平台 API
  - 接收平台 webhook
  - 轮询拉取平台数据
  - 验签 / 幂等 / 映射
  - 转换成 OES 内部对象或事件

推荐理解：

```text
第三方平台 = connector / webhook / polling first
```

### 6.3 webhook 与 connector 当前口径

当前 Workspace 已确认方向：

- webhook 是事件发生时，对方系统主动调用预先配置 URL 的通知方式。
- connector 是 OES 内部针对某个平台的专用适配层。
- 不同平台通常需要不同 connector。
- webhook 不是 connector 的替代品，而是 connector 可能采用的一种入站通知手段。

## 7. 当前高价值场景草稿

### 7.1 公司 / 品牌展示型触点

场景示例：

- 海外 OEM / ODM 官网
- 公司官网
- 品牌官网
- 展会落地页

高价值能力：

- 公司介绍、品牌介绍、资质、工厂实力
- 产品能力展示
- Blog / 新闻 / 动态
- 多语言、SEO
- 询盘、报价请求、在线客服

### 7.2 零售成交型触点

场景示例：

- 品牌独立站
- WeChat mini program mall
- mobile app mall

高价值能力：

- 产品目录
- 价格
- 库存摘要
- 下单 / 履约状态
- 客服

### 7.3 第三方交易平台账号

场景示例：

- Amazon
- Shopify
- Taobao / JD / Pinduoduo / Douyin store

高价值能力：

- 商品发布 / 更新
- 价格 / 库存同步
- 订单回流
- 评价 / 消息回流

### 7.4 经销 / 批发门户

场景示例：

- dealer portal
- B2B ordering portal

高价值能力：

- 经销商登录
- 分层价格
- 订货 / 补货
- 对账 / 政策 / 物料

当前判断：

- 价值明确，但实现复杂度较高
- 第一阶段可以后置，但模型必须预留

### 7.5 售后服务触点

场景示例：

- 扫码售后 WeChat mini program
- service portal

高价值能力：

- 产品扫码识别
- 使用说明 / 视频知识库
- AI 问答
- 人工售后
- 维修 / 换货 / 质量反馈

当前判断：

- 对陶瓷行业场景有较高价值
- 第一阶段可先预留为服务型触点

## 8. 当前未冻结问题

| 日期 | 问题 | 为什么未冻结 | 下一步 |
| --- | --- | --- | --- |
| 2026-04-23 | 这套能力最终是否沉淀为独立服务，还是先以 feature / module 方式落在现有边界中？ | 服务归属还不清晰，直接定服务容易过早。 | 先继续 active design，再决定是否形成 canonical service proposal 或 Delivery。 |
| 2026-04-23 | “品牌 / 公司档案”是否需要上升为正式 brand/company domain object？ | 品牌未来可能很复杂，目前不宜仓促冻结完整 Brand Service。 | 先保持轻量对象草稿。 |
| 2026-04-23 | 互动入口应先落到 CRM、通知、还是 future conversation / service hub？ | 涉及多个 future domain，当前不宜仓促定 owner。 | 后续按 inquiry / chat / after-sales 分开讨论。 |
| 2026-04-23 | 发布目录是否由产品域 owner 直接承接，还是需要单独的 channel / catalog publishing capability？ | 涉及内容、价格、库存摘要与多触点发布协同。 | 后续讨论发布层设计。 |
| 2026-04-23 | 自有触点与第三方平台账号在产品界面上如何命名才最接地气？ | 当前讨论偏架构口径，面向业务用户的产品命名还未冻结。 | 后续做信息架构梳理。 |
| 2026-04-23 | 第一阶段最先落地的是展示型 + 互动型，还是要直接覆盖部分交易能力？ | 依赖产品、订单、库存、CRM 等多个域的 readiness。 | 由总控结合基础模块成熟度再排序。 |

## 9. Marketplace connector and external commerce integration

本节集中保存第三方 Marketplace 集成仍然有效、且尚未进入规范真相的候选方向，不冻结服务名称、部署单元或内部 RPC。

### 9.1 Coverage against current truth

| 候选主题 | 当前覆盖 | 处理 |
| --- | --- | --- |
| 外部流量经 Gateway / BFF 进入 | 已有全局稳定约束 | 只作为基线 |
| 内部同步调用使用 gRPC | 已有全局稳定约束 | 只作为基线 |
| 外部平台语义与核心业务语义之间使用防腐层 | 已有全局稳定约束 | 只作为基线 |
| 自有 Site Runtime webhook 与 pull fallback | Site 稳定设计已覆盖 | 不推广为 Marketplace 契约 |
| 第三方平台采用 connector / webhook / polling | 仅在本 Workspace 有方向 | 继续设计 |
| Marketplace account / installation | 未冻结 | 继续设计 |
| callback 验签后解析 tenant 与执行主体 | 未冻结且与当前安全模型有张力 | 继续设计 |
| 外部对象与 OES 对象映射 | 未冻结 | 继续设计 |
| 订单导入、库存与价格同步 | 未冻结 | 继续设计 |
| retry、cursor、reconciliation 与人工修复 | 未冻结 | 继续设计 |
| Product / ProductVariant / Listing / Offer | 未冻结 | handoff 到后续 Item–Product / Channel 设计 |

### 9.2 Three truth boundaries

第三方平台接入至少需要区分三类真相。

#### External platform truth

由 Amazon、淘宝、京东或其他平台拥有：

- seller / shop / marketplace 标识；
- external product、listing、SKU、order、shipment、refund、review 与 message；
- 平台审核与发布状态；
- 平台 API cursor、notification type 和 provider request id；
- 平台自身的价格、库存承诺和履约状态。

OES 可以保存必要快照与映射，但不得把平台状态改写成 OES 核心业务对象的唯一真相。

#### Integration truth

由未来 Marketplace integration owner 拥有，候选包括：

- tenant-scoped platform installation / account binding；
- credential reference 与 authorization lifecycle；
- external object mapping；
- inbound receipt 与 idempotency record；
- sync checkpoint / cursor；
- sync run、retry 和 rate-limit state；
- reconciliation finding；
- provider payload snapshot 或可审计引用；
- connector capability 与版本。

这些候选名称不是已冻结对象。后续应先确认每项是否拥有独立业务真相，再决定聚合与存储。

#### OES business truth

继续由对应业务服务拥有：

- Item Master：内部 ItemModel、Item 与执行物料身份；
- Sales / Order owner：客户订单、报价、取消与销售业务判断；
- WMS：库存、占用、发货与仓储事实；
- Pricing / Sales：内部价格规则与对渠道的商业条件；
- Finance：应收、结算与财务事实；
- After-sales：退货、退款、投诉与售后业务判断；
- CRM / UGC / Communication owner：询盘、客户关系、评价、问答、消息与会话。

Connector 负责协议适配、映射和同步，不接管这些核心业务真相。

### 9.3 Candidate ingress topology

候选入站链路：

    External Marketplace
      -> public Gateway route
      -> generic transport protection and trace
      -> marketplace connector boundary
      -> provider signature / state / replay verification
      -> tenant installation and machine authority resolution
      -> durable receipt / idempotency
      -> business-owner command, narrow INTERNAL call, or event

Gateway 候选职责：

- TLS、公网路由、通用限流和请求大小限制；
- trace、接收时间和可信网络元数据；
- 保留平台验签所需的 canonical request material；
- 只把允许的 callback route 转给明确的 connector boundary。

Connector 候选职责：

- 平台协议与签名的最终解释；
- OAuth state、token refresh 与 credential reference；
- replay protection 与 provider-specific idempotency；
- 识别 platform installation；
- 必要时调用平台 API 补拉完整数据；
- 映射、同步、重试、对账与异常治理。

尚未冻结 Gateway 与 connector 之间需要传递的精确 canonical request。raw body、path、query 与 header allowlist 必须以最小、可审计且不被中间转换破坏的形式设计；普通 header、body tenant 或调用方自报身份不构成 authority。

### 9.4 Tenant and machine authority gap

待核验的候选映射为：

    platform + sellerId / shopId / appId
      -> MarketplaceAccount
      -> tenantId / orgId
      -> SYSTEM_INTEGRATION operator context

该方向尚未满足当前 ExecutionToken 与 external integration 稳定设计。

当前约束：

- tenant、org 与 principal 必须来自可信 owner resolution 和签名执行凭证；
- callback body、query、普通 metadata 或本地配置中的 tenant 不是 authority；
- 无 HUMAN subject 的自动流程应使用明确的 tenant-owned Machine Principal；
- External API Key 模型只覆盖 tenant-owned Integration Machine，不覆盖 shared Marketplace App、多 tenant installation 或 Marketplace developer-platform principal；
- 当前稳定设计明确没有为 shared App principal 与跨 tenant installation 预留通用模型。

因此需要独立冻结：

1. 一个 tenant 的一个店铺安装如何绑定 tenant-owned Machine Principal；
2. 平台共享 App credential 与 tenant installation credential 如何分离；
3. provider callback 通过什么不可伪造的安装标识找到 binding；
4. connector workload 如何取得目标 audience 的 MACHINE ExecutionToken；
5. installation disable、token revoke、shop transfer 与 tenant disable 如何收敛；
6. 多 org 场景由 installation 固定 org，还是由业务 owner 再解析；
7. callback 验证失败、binding 缺失或 tenant 冲突时的 fail-closed 行为；
8. 平台 App 多租户安装是否需要显式重开当前已排除的安全模型。

在这些问题冻结前，不把 MarketplaceAccount 当作可信 operator，也不复用 External API Key 作为平台 callback 身份。

### 9.5 Synchronization and reliability matrix

需要继续冻结的可靠性维度：

| Concern | Design questions |
| --- | --- |
| Inbound idempotency | provider event id、request id、shop id 和事件类型如何形成稳定 key；重复 payload 是否返回相同结果。 |
| Replay protection | timestamp、nonce、signature window 与已消费记录如何协同。 |
| Webhook completion | callback 是完整事实还是提示；何时必须补拉平台 API。 |
| Polling checkpoint | cursor、watermark、page token 与时间窗口由谁拥有；何时推进。 |
| Outbound idempotency | publish/update request 如何关联本地 desired version 与 provider result。 |
| Retry | provider 429、5xx、timeout、部分成功和长期拒绝如何分类。 |
| Rate limit | platform、app、shop、operation 与 tenant 维度如何调度。 |
| Ordering | 乱序事件、迟到事件和状态回退如何判定。 |
| Dead letter | 哪些失败进入人工处理；如何重放且不跳过业务校验。 |
| Reconciliation | 如何定期比较 external snapshot、mapping 与 OES desired state。 |
| Partial success | 一个 listing 多 variants 或批量价格更新部分成功时如何记录。 |
| Audit | 谁触发、哪个 installation、provider request id、mapping、输入摘要与结果如何关联。 |
| Secret handling | access token、refresh token 与签名 secret 只保存 credential reference，不进入日志、事件或普通 DTO。 |

Webhook、polling 和 reconciliation 应相互补充，不应假设任一单一机制提供完整一致性。

### 9.6 Candidate collaboration paths

#### External order import

候选流程：

    verified provider notification or polling result
      -> durable integration receipt
      -> external order snapshot and mapping
      -> Sales / Order owner evaluates import
      -> accepted / rejected / pending-domain-resolution
      -> integration records owner result and external acknowledgement

Connector 不自行决定：

- OES 客户身份；
- Item 替代或临时 Item；
- 内部价格是否合法；
- 库存是否可分配；
- 订单是否进入业务生命周期；
- 财务和售后状态。

#### Product and listing publication

候选流程：

    business-approved commercial publication
      -> connector desired-state translation
      -> provider create/update
      -> external listing / SKU identifiers
      -> mapping and provider status
      -> reconciliation

Product、ProductVariant、Listing、ListingVariant 与 Offer 的 owner 仍未冻结，本节只保存 connector 所需的边界。

#### Inventory and price synchronization

库存与价格更新不等于修改商品内容。后续至少要区分：

- product/listing content；
- price / promotion；
- available-to-promise or channel allocation；
- fulfillment mode；
- provider warehouse or marketplace fulfillment。

Connector 只发布业务 owner 已计算的渠道结果，不拥有库存余额或价格规则。

#### Review, Q&A, message and after-sales return

外部平台回传的数据应按业务语义路由：

- review / Q&A -> future UGC owner；
- message / chat -> future Communication / Conversation owner；
- inquiry / lead -> CRM；
- refund / return / complaint -> After-sales 或订单 owner；
- connector 只保留 external mapping、delivery state 与必要 snapshot。

### 9.7 Current runtime incompatibilities

若 connector 同步调用 Sales、WMS、Finance 和 Item Master，当前已有服务契约并未普遍支持该路径：

- Sales 现有生产 RPC 主要冻结为 HUMAN / WEB；
- WMS 当前多数业务入口没有 Marketplace MACHINE caller；
- Finance 当前没有已证明的 Marketplace pure MACHINE caller；
- Item Master 的现有窄 INTERNAL resolver 绑定已冻结 caller 与 HUMAN OBO，不是通用 connector query API。

后续需要按每个业务事实选择：

- 受业务 owner 控制的 integration event；
- durable import command / inbox；
- 新增精确、窄用途 INTERNAL RPC；
- 或由 Human 处理异常后再进入现有 BUSINESS workflow。

不得通过复用 HUMAN RPC、伪造 operator context、body tenant 或开放通用内部接口绕过当前授权边界。

### 9.8 Product and channel handoff

当前获得 Human 认同的产品方向：

    ItemModel / Item remain internal execution master truth.
    An independent external commercial display layer references them.

保留的业务理由：

- 一个内部 Item 可被多个品牌、OEM 客户或市场使用；
- 不同渠道只公开部分 Item；
- 内外生命周期不同；
- 内部技术属性与外部展示属性不同；
- 多语言、单位、认证、媒体和营销内容不同；
- 外部组合展示不等于内部 BOM；
- 外部内容编辑不应改变库存、成本、BOM 或生产真相。

尚未冻结：

- Product 是否是正式聚合；
- ProductVariant、ProductItemBinding 或 projection；
- Product 与 ItemModel / Item 的映射基数；
- Brand、Channel、Catalog、Publication 的对象边界；
- MarketplaceListing、ListingVariant 与 ChannelOffer；
- 对外 Variant 映射固定 Item、configurable result 或 fulfillment result。

这些问题交由 [Commercial Product and Channel Publication Design Workspace](commercial-product-and-channel-publication-design.md) 集中收敛。本 Workspace 不重复定义，只保留 connector 对它们的依赖。

### 9.9 Known conflicts

- 独立外部展示层是当前 Human-confirmed direction；不新增通用 Product 不再是当前方向。
- `marketplace-integration-service` 只是候选名称，服务边界尚未冻结。
- `MarketplaceAccount -> tenant/operator` 候选方案尚未满足当前可信执行模型。
- 当前 External API Key 设计明确排除 shared Marketplace App 与 cross-tenant installation；真实平台安装可能要求重开该边界。
- connector 直接调用核心服务的候选路径，与现有 RPC mode 和 caller allowlist 冲突。
- Site Runtime webhook 是 OES 到自有站点的发布通知，不能直接推导为外部 Marketplace callback 契约。
- SiteProductPublication 的存在不代表 Product Master–Site Product identity、mapping 和 lifecycle 已冻结。

### 9.10 Open questions

1. Connector 是一个服务、多个 adapter module，还是按能力拆分的集成上下文？
2. Platform App、tenant installation、shop account 与 tenant Machine Principal 的精确关系是什么？
3. Marketplace callback 的 canonical request 与 Gateway-to-connector contract 是什么？
4. provider signature verification 最终发生在哪一层，Gateway 做哪些通用校验？
5. 平台凭证由 Auth、connector credential store 还是独立 secret owner 管理？
6. 外部对象 mapping 是统一 registry 还是按对象类型由 connector 分区拥有？
7. 外部订单通过 event、durable command 还是窄 INTERNAL RPC 交给业务 owner？
8. 现有 HUMAN-only 业务能力需要新增哪些 MACHINE integration surface？
9. Listing content、price、inventory allocation 和 fulfillment promise 的 owner 分别是谁？
10. 如何表达 desired state、provider observed state 与 reconciliation finding？
11. 第一阶段支持一个平台的一条链路，还是先冻结跨平台共同 contract？
12. Product / Channel 设计完成前，connector 如何保持对上游商业对象的弱耦合？

### 9.11 Next discussion point

先使用一个具体场景冻结可信入站骨架：

    Amazon order notification
      -> Gateway
      -> signature and installation verification
      -> tenant-owned machine authority
      -> durable receipt
      -> Sales / Order owner import decision

本轮只回答 installation、tenant authority、idempotency 与 owner handoff，不先冻结完整 Listing 或 Product 模型。

## 10. 真相源回写计划

- services:
  - future service responsibilities once owner is clear
- collaborations:
  - future customer touchpoint / platform integration collaboration doc
- contracts:
  - future self-owned touchpoint capability APIs
  - future platform connector contracts
- Delivery:
  - future first-phase customer touchpoint Delivery
- architecture / ADR:
  - only after naming, owner, and minimum phase are frozen

## 11. Next discussion point

- 继续讨论的当前输入：
  - 本 workspace
  - `docs/plans/designs/README.md`
  - 与 CRM / product / order / service 相关的后续设计文档（待补）
- 当前推荐下一步：
  - 先冻结 Marketplace callback 的 installation、tenant machine authority、durable receipt 与业务 owner handoff。
  - 继续压实“自有触点 vs 第三方平台账号”的第一阶段对象和字段。
  - 讨论互动入口（询盘 / 在线客服 / 报价 / 售后）如何映射到 future CRM / service / notification。
  - 判断该主题是进入一次确认的 Delivery，还是继续作为长周期 active design 保留。
