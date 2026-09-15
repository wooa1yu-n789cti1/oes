# site-service 职责卡

## 1. Purpose

`site-service` 是 OES 自有 / 自控外部站点治理与发布服务，负责回答：

- 哪些外部站点由 OES 管理。
- 每个站点支持哪些语言、域名、凭证和运行时通信配置。
- 哪些 Blog、News、FAQ、Inspiration 属于某个站点，以及哪些已发布 public views 对 Site Runtime 可见；Product Master–Site Product 关系继续后置。
- 每个站点的公开展示数据何时同步给 Site Runtime。
- Site Runtime 同步到什么版本、是否健康、是否需要处理。

`site-service` 不是集中式实时网站渲染后端。外部网站页面仍由各自 Site Runtime 使用本地 published data 渲染。

本服务只面向 OES 自有或自控站点体系，例如 brand site、B2B inquiry site、B2C site、dealer portal、regional site。

## 2. Frozen Ownership Boundary

Site ownership 以本文件为服务级稳定真相源。P1 冻结边界：

- OES 不做 page builder、任意组件 CMS、theme editor、主导航、Footer 或前台 Logo 视觉治理。
- `siteName` 只用于 Admin 识别、检索与审计，不得自动作为 Header、SEO fallback 或 JSON-LD 输出。
- OES 只管理 OES-owned resources 的 SEO 数据；Storefront 拥有站点 shell SEO、全局 fallback、最终 head / JSON-LD 输出。
- `robots.txt` 与 `sitemap.xml` 由站点输出；OES 只提供资源级 `indexable/noindex` 与 sitemap eligibility 信号。
- OES 只管理动态 OES-owned resources 的 historical slug redirect；静态页、营销页、域名与 locale redirect 归站点 / Nuxt / Edge。
- Preview 由 OES token、Runtime draft view 与 Storefront 真实页面渲染组成；preview 必须 `noindex`、`nofollow`、`no-store`，不得写正式 store、推进 publishVersion 或触发 webhook。
- Media asset 的默认 alt 只能作为编辑辅助；Blog / News 封面图、正文图片与 Inspiration 图片的最终 alt 都按业务使用场景和 locale 管理。

### 2.1 Frozen Site Content Category Taxonomy

站点文章的长期对象模型冻结为 `contentType + categoryIds[] + tags[]`。它取代 legacy `Topic`，并保留当前站点已经使用的多分类 archive 关系。

`contentType`：

- 每篇文章必须有且只有一个 `contentType`；初始受控值为 `blog / news`，后续新增类型必须先更新本服务真相源与 public view contract。
- `contentType` 是内容语义与运营筛选维度，不由 Storefront URL 推导。

`Content Category`：

- 每篇可发布文章必须至少引用一个有序 `categoryIds[]`；第一个值是通用列表卡片的 primary category，所有值都保留各自 archive membership。
- `SiteContentCategory` 是独立的 site-scoped 对象，拥有排序与 locale version；它不重复保存 Blog / News 适用类型或手工 archive visibility。
- Category locale version 拥有 `slug`、`displayName`、`archiveIntro`、`archiveLabel`、SEO、historical slug，以及 draft revision / last published revision。
- Article 自身的 `contentType = blog / news` 决定所属内容类型；Category 对两类 Article 中立，在哪一类公开可见只由该类已发布 Article 的实际引用驱动。
- Content Category 是公开内容 archive 的唯一分类依据；它不是产品分类树，也不引入多级内容目录。
- `article-category` 是 Content Category 的 public view resource type；它与产品 `category` resource type 不共享 id、树或 owner。

`tags`：

- 每篇文章可以有零到多个轻量 Tag。Tag 用于细粒度过滤、卡片辅助标签、站内关联与相关文章，例如 `bathtub`、`freestanding-bathtub`、`size-planning`。
- Tag 不作为默认 SEO archive、sitemap 或独立 public view；它不拥有文章级 canonical slug、描述或 SEO。
- Tag 在 locale version 中以 `{ key, label }` 保存：`key` 在 site 内稳定且用于筛选，`label` 是当前 locale 的展示文案。
- 某个 Tag 只有在具备足够内容量、搜索需求与编辑策展时，才可以通过新增 Content Category 的方式被提升为公开 archive；不得自动把全部 Tag 暴露为公开页面。

明确不保留：

- `primaryTopicId`
- `topicIds[]`
- `TopicPublicView`
- 把 Tag 伪装为可索引 Topic archive 的模型

Runtime 查询边界：

- Site Runtime 必须基于本地 published public views 提供组合筛选：`contentTypes[]`、`categorySlug`、`tagKeys[]`、`tagMatch = any | all`、排序与分页。
- Runtime 查询不理解 Storefront 的页面 URL、栏目名称或展示布局；Storefront 将自己的路由映射为上述 filter。
- Category archive 的最终 URL 属于 Storefront，不是 OES Site API 或 Runtime 的路由契约。Meilong 已冻结的 canonical 仅为 `/blogs/categories/:categorySlug` 与 `/news/categories/:categorySlug`；其 singular `category` 与 legacy `topic` namespace 是开发期遗留，必须 terminal 404，不得 redirect。
- 文章详情 canonical、Category slug 与 historical slug 由 published view 提供；最终页面 URL、locale 路由与 redirect 仍由 Storefront / Edge 拥有。

### 2.2 Tenant Ownership And Admin Access Boundary

Site 与所有 site-scoped 资源都必须归属于且只归属于一个 tenant。`site-service` 拥有该归属真相，并负责把它作为所有 Admin 读写、发布、同步、凭证与审计用例的不可绕过边界。

P1 稳定规则：

- Site Management P1 只支持已验证的 `TENANT` session context；当前不支持 `SYSTEM` session 跨租户管理 Site。SYSTEM 不能作为 bypass，未来若需支持，必须先冻结专用 system-targetable 入口、permission 与审计语义。
- 对任何携带 site 标识或 site-scoped resource 标识的操作，application 层必须先解析 owning Site，并验证其 tenant 与已验证 tenant context 一致，再读取详情、修改状态、生成预览、操作凭证、推进发布版本、重发 webhook 或记录成功审计。
- 对 site-scoped descendant resource，必须同时验证 resource 属于目标 Site、目标 Site 属于当前 tenant；不能只校验任意一个 id 存在，也不能只信任请求中重复携带的 tenant 信息。
- `CreateSite`、站点卡片列表等没有既有 site 标识的操作，只能使用 Gateway 已完成 target binding 的 tenant context；创建 Site 下属资源时仍必须先校验目标 Site ownership。
- ownership mismatch 必须 fail closed，并在任何业务副作用之前拒绝。Gateway 的 tenant-target binding 是入口第一道边界，不能替代 `site-service` 的资源归属校验。

该边界复用现有 tenant context 与 Site ownership，不新增 scope、page、schema 或 proto 字段。

#### 2.2.1 Trusted Admin RPC Context

- Site Admin gRPC RPC 必须使用 `BUSINESS` mode，从已验证 `TrustedExecutionContext` 获取 tenant、principal、Permission Code、request 与 trace；request body 的 tenant、operator 或 scope 副本不得作为授权依据。
- Self-service RPC（如未来存在）必须单独使用 `SELF_SERVICE` mode，并从执行主体派生 target；不能复用 Admin management body target。
- Site Runtime 的外部请求先继续验证既有 Site credential HMAC、nonce、method/path/body hash 与时效窗口，再由 Gateway / BFF 为内部调用取得 target-audience ExecutionToken。这两层分别证明 Runtime request 与内部 execution，不互相替代。
- Site Runtime 的七个 gRPC RPC 在内部边界统一使用 `INTERNAL` mode：capability registration 使用 `site.internal.runtime.capability.register`，publication reads 使用 `site.internal.runtime.publication.read`，sync result 使用 `site.internal.runtime.sync.report`，preview read 使用 `site.internal.runtime.preview.read`。这些 Code 只授予已验证 Gateway workload 的 STS issuance policy，不进入业务角色。
- `siteId`、resource id 与合法 `targetTenantId` 是业务目标，不是身份来源；application 层始终加载 Site ownership 并与可信 tenant 比较。
- SYSTEM principal 当前不能绕过 Site Management P1 的 TENANT 边界。未来平台跨租户操作必须通过专用 BUSINESS RPC、平台 Permission Code、目标 tenant 与高风险审计另行冻结。

#### 2.2.2 Frozen Admin RPC Authorization Map

`SiteAdminManagementService` 的 59 个 RPC 全部使用 `BUSINESS` mode，且每个 RPC 只声明一个 Code。稳定映射如下；分组中的 RPC 数量总和必须保持为 59，新增或改名必须先更新本真相源与对应 contract。

| Permission Code | RPCs |
| --- | --- |
| `site.management.read` | `ListSiteCards`, `ListSitePages`, `GetPendingSyncSummary`, `ListPendingSyncResources`, `ListSyncHistory`, `GetSyncDetail` |
| `site.management.manage` | `CreateSite`, `UpdateSiteSettings`, `DisableSite`, `UpdateSitePageGovernance` |
| `site.management.locale.manage` | `AddPreparingLocale`, `CheckLocaleCompleteness`, `ActivateLocale`, `DisableLocale` |
| `site.management.product.manage` | `ListSiteCategories`, `CreateSiteCategory`, `UpdateSiteCategory`, `UnpublishSiteCategory`, `ListSiteProducts`, `SearchProductMasterForAdd`, `GetSiteProductPublication`, `AddProductsToSite`, `UpdateSiteProductPublication`, `UnpublishSiteProduct` |
| `site.management.content.manage` | `ListSiteContents`, `GetSiteContent`, `CreateSiteContent`, `UpdateSiteContentLocaleVersion`, `UnpublishSiteContent`, `ListContentCategories`, `GetContentCategory`, `CreateContentCategory`, `UpdateContentCategoryLocaleVersion`, `PublishContentCategoryLocale`, `ReorderContentCategories`, `DeleteContentCategory`, `ListVisibleContentCategories`, `CheckContentCategoryCompleteness`, `ListContentCategoryUsage`, `ListFaqCategories`, `GetFaqCategory`, `CreateFaqCategory`, `UpdateFaqCategoryLocaleVersion`, `DisableFaqCategory`, `ListFaqEntries`, `GetFaqEntry`, `CreateFaqEntry`, `UpdateFaqEntryLocaleVersion`, `UnpublishFaqEntry`, `CheckFaqCompleteness` |
| `site.management.sync` | `SyncAllPendingChanges`, `RetryLastSync`, `ResendWebhook` |
| `site.management.credential.manage` | `ListSiteCredentials`, `GenerateSiteCredential`, `RotateSiteCredential`, `RevokeSiteCredential` |
| `site.management.audit.read` | `ListSiteAuditLogs` |
| `site.management.preview` | `IssuePreviewToken` |

Admin request identity migration is destructive and fail-closed rather than dual-read:

- The 57 request messages whose field `1` is `AdminRequestContext context` remove that field and declare both `reserved 1;` and `reserved "context";`.
- `ListSiteCardsRequest` removes and reserves numbers `1, 2, 3` and names `tenant_id`, `operator_id`, `trace_id`.
- `CreateSiteRequest` removes and reserves numbers `1, 2, 3, 4` and names `tenant_id`, `org_id`, `operator_id`, `trace_id`; its business fields retain their existing numbers beginning at `5`.
- `AdminRequestContext` is removed after references reach zero. Response and audit `operator_id` facts remain, but the service derives them from the verified execution principal rather than request body.
- Controllers translate immutable `TrustedExecutionContext` facts into application input. They never pass Token text, metadata, certificate data or body identity into domain code.

#### 2.2.3 Frozen Runtime RPC Authorization And Root Composition

`SiteRuntimeSyncService` uses exactly these `INTERNAL` declarations:

| Permission Code | RPCs |
| --- | --- |
| `site.internal.runtime.capability.register` | `RegisterPageCapabilities` |
| `site.internal.runtime.publication.read` | `GetLatestPublishState`, `ListChangedResources`, `BatchGetPublicViews`, `GetSnapshot` |
| `site.internal.runtime.sync.report` | `ReportSyncResult` |
| `site.internal.runtime.preview.read` | `GetPreviewView` |

The complete Runtime ingress proof is intentionally two-layered:

```text
Site Runtime SignedSiteContext
  -> Gateway verifies the external request admission
  -> Gateway uses current mTLS + its Identity-provisioned exact SYSTEM selector
  -> Auth / STS issues aud=site-service INTERNAL ExecutionToken
  -> Site verifies mTLS + ExecutionToken
  -> Site independently verifies SignedSiteContext HMAC, nonce, time, method, path and body hash
```

- The Gateway MACHINE root input is current transport-verified mTLS plus the non-secret exact selector emitted by Identity provisioning. The selector is stable configuration, not a bearer, tenant fact, certificate fact or grant. This Site slice adds no credential profile or bearer propagation seam.
- The certificate-bound target ET may be reused within its validity. A cache hit remains admissible only while selector, resolved principal/binding version, Permission/security version and current leaf binding remain identical.
- `SignedSiteContext` proves which external Site Runtime request was admitted. It remains request data for independent HMAC verification and never becomes tenant, principal, workload or Permission authority.
- The MACHINE ExecutionToken proves the internal Gateway workload and exact Runtime RPC authorization. It does not replace the HMAC proof, and the HMAC proof does not authorize the internal gRPC call.

### 2.3 Frozen Dynamic Slug Ownership

`site-service` 在自身边界内维护轻量的 dynamic slug reservation / history ledger，作为 OES-owned 动态资源 URL 所有权的唯一真相。它是内部领域与持久化机制，不是独立 `slug-service`，也不是供运营人员维护任意跳转规则的 Redirect Manager。

P1 namespace 只包含：

- `blog`：`contentType = blog` 的文章详情 slug。
- `news`：`contentType = news` 的文章详情 slug。
- `article-category`：Blog 与 News 共用的 Content Category slug。
- `inspiration-category`：Inspiration Category 页面 slug。

唯一性按 `site + namespace + locale + normalized slug` 判定。Blog、News 与 Content Category 使用不同公开 URL namespace，因此相同 slug 文本可以跨 namespace、跨 site 或跨 locale 使用；同一 namespace 内语义等价的 slug 必须先经过统一规范化再参与占用与查找，不能依赖管理端的“先查询再保存”作为最终防线。

Slug 生命周期冻结如下：

- 新建或修改草稿时，当前 draft slug 立即预占；与其他资源的 draft、canonical 或 historical slug 冲突时，保存必须失败。
- 从未正式发布的资源修改 slug 时，旧 draft-only 占用随同一次事务释放，新 slug 随同该事务取得占用；从未公开的旧值不进入 historical history，也不产生 301。
- 已发布资源编辑新 slug 时，线上 canonical 继续有效，新 draft slug 同时预占；正式 Sync 成功后，新值成为 canonical，旧 canonical 永久转为该稳定资源的 historical slug。
- 已发布过的 canonical / historical slug 在 P1 永不转让给其他资源。资源可以换回自己拥有的 historical slug；正式 Sync 时该值重新成为 canonical，原 canonical 转为 historical，其他 aliases 保持归属不变。不同资源之间不得交换已发布 slug。
- 草稿删除只释放从未发布的 draft-only 占用。已发布资源 unpublish 或 delete 后，其全部已发布 slug 仍永久保留，但 Runtime 不得把它们 301 到不可公开资源；P1 公开请求收敛为 404。将同一稳定资源重新发布后，其既有 aliases 才重新指向新的当前 canonical。

并发与发布不变量：

- Slug 占用、locale version 写入与对应审计必须在同一事务中提交，并由数据库唯一约束裁决并发申请；可选的预检查只用于更早提示，不能替代该约束。
- canonical 与 historical slug 占用同一个唯一空间，任何已发布旧 URL 都不能被另一个资源重新声明为新 canonical。
- 正式 Sync 只物化已提交的 canonical 与 historical history，不向 Runtime 暴露 draft reservation；历史变更必须与目标 public view 和 publishVersion 同事务发布。
- Runtime 从 public views 原子建立本地 historical alias index。请求命中当前 canonical 返回 200；命中同一已发布资源的 historical alias 时，由 Storefront 按自身 route namespace 组合当前 canonical URL 并返回 server-side 301；未命中或目标已 unpublish / delete / disabled 时返回 404。
- alias 始终解析到稳定资源身份，再读取其当前 canonical，不保存 alias-to-alias 跳转链，因此 slug 多次修改或换回后仍只有单跳 301。Historical URL 不进入 canonical、sitemap 或 hreflang。
- Meilong 的 retired singular Category / Topic namespace 是开发期废弃路由，不是 historical slug；必须继续 terminal 404，不能进入 alias lookup。

Product、Collection 未来可以复用该机制，但其 URL namespace、资源归属与生命周期必须等待 Product Master–Site Product / Collection 设计冻结后再纳入；P1 不提前实现或推导这些规则。

关键取舍与失败语义以 [ADR 0011](../../adr/0011-site-dynamic-slug-reservation-and-history.md) 为准。

## 3. Operator Model

OES Admin 中的主要入口是 `Site Management` 卡片式站点工作台。

站点详情页冻结为以下主导航：

- `Overview`
- `Setup & Connection`
- `Pages & Locales`
- `Publish & Sync`
- `Content Management`
- `Collections`
- `Audit`

`Content Management`（中文“内容管理”）只是 Site Management 的导航分组，内聚 Blog、News、Article Categories、FAQ 与 Inspirations 工作区；它不是领域对象或新的 Content 聚合，这些内容对象不因为共用入口而合并领域模型。

主要操作心智：

- 站点是运营核心对象。
- `Products` / `Add Products` 的实际列表语义、选品边界与 Product Master–Site Product 关系尚未冻结，不得以当前 UI 作为稳定设计依据。
- Blog / News 是站点私有内容，不做跨站点共享发布。
- FAQ 是站点私有结构化问答内容；客户提交的问题仍由 CRM Inquiry 处理。
- Inspirations 是站点私有视觉内容，使用 Items / Categories 工作区；图片文件仍由 Asset Service 拥有。
- 保存草稿或配置只标记待同步，不通知站点。
- `Sync` 才生成 public view、推进站点版本并 webhook 通知 Site Runtime。
- 预览通过站点真实 preview 页面完成，但不进入正式同步链路。

## 4. Owns

### 4.1 Site

站点根对象。

P1 建议字段：

- `siteId`
- `siteCode`
- `siteName`
- `siteType`
- `brandId`
- `regionCode`
- `channelCode`
- `status`: `draft` / `active` / `disabled`
- `defaultLocale`
- `primaryDomain`
- `siteMediaDeliveryIntent`: `local` / `remote`；这是运营配置意图，不是 provider credential 或实际交付完成状态
- `siteMediaHost`: 仅在远端意图下保存，例如 `media.meilong-ceramics.com`
- `previewBaseUrl`
- `allowedOrigins`
- `webhookUrl`
- `runtimeStatusUrl`

P1 不单独拆复杂 `SiteDomain`、`SiteRuntimeEndpoint`、`SiteBrandBinding`。后续出现多域名、多区域 runtime、多品牌复杂绑定时再拆。

Site 只拥有 Site Media 的域名意图与激活授权。`asset-service` 拥有对应 `SiteMediaDeliveryBinding` 的 provider、验证、迁移、公开 URL、purge 和实际状态；详见 [asset-service.md](./asset-service.md#101-site-media-delivery-binding) 与 [Site–Asset Media 协同蓝图](../collaborations/site-asset-media.md)。Site 不保存 R2、CDN 或 DNS provider credential。

### 4.2 SiteLocale

站点语言生命周期。

- `siteId`
- `locale`
- `status`: `preparing` / `active` / `disabled`
- `isDefault`

规则：

- 每个站点必须有且只有一个 default locale。
- default locale 必须是 `active`。
- P1 不支持更换 default locale。
- `preparing` 语言只在 OES 内部准备，不公开。
- `active` 语言参与站点页面能力覆盖检查，以及每个待发布资源 locale version 自身的完整性检查；不要求一次性补齐全部历史资源。
- `disabled` 语言不公开展示。

新增语言流程：

```text
Add Locale
  ↓
preparing
  ↓
补全已启用静态页面的 Storefront locale 能力，并完成待发布动态资源的 locale view
  ↓
完整性检查通过
  ↓
Activate Locale
  ↓
生成该语言全量 public views
  ↓
Site Runtime 同步成功
  ↓
active
```

### 4.3 SiteCredential

站点后端访问 OES Site API 的凭证。

- `siteId`
- `clientId`
- `credentialId`
- secret / key metadata
- scopes
- status
- created / rotated / revoked metadata
- last used metadata

P1 站点后端通过单个环境变量接入：

```text
OES_SITE_CREDENTIAL
```

该 bundle 对站点开发者表现为一个配置项，对 `@oes/site-runtime-kit` 内部保持结构化身份、签名密钥、endpoint 与环境信息。

P1 scopes：

- `site:read`
- `site:sync`
- `site:preview`
- `site:status`

凭证只允许站点后端持有，禁止放入 Storefront Frontend。

### 4.4 Product Public Publication Boundary

产品主数据真相不属于 `site-service`，属于 product / item master / PIM 相关服务。

Product Master 与 Site Product / `SiteProductPublication` 之间的 identity、mapping、lifecycle、选品与发布关系尚未冻结，继续后置到独立产品设计。本节只冻结以下边界，不得把当前实现或运营 UI 推导为两者关系的稳定设计：

- 任何产品 public view 都不得改变 Product Master 的主数据真相。
- Product Master public-safe fields、Site Product 身份与站点展示配置的合成规则，必须在 product / item master owner 参与的独立设计中先行冻结。
- 当前 locale version 必须自身完整才允许公开；没有该 locale version 的产品资源不在该语言公开，不阻塞其他资源或其他 locale。
- 产品 public view 若引用分类，只能引用当前站点已发布的 category id；这不表示其等同于 item-master 内部分类。

### 4.5 SiteCategoryDefinition

外部站点公开分类定义。

P1 分类是 site-defined taxonomy。不同站点可以有不同分类树、分类名、slug、排序和 SEO；`site-service` 在外部站点治理边界内拥有该站点公开分类定义与发布输出，不把 item-master 内部 category projection 暴露为外部站点 contract。

建议字段：

- `siteId`
- `categoryId`
- `locale`
- `parentCategoryId`
- `slug`
- `displayTitle`
- `description`
- `image`
- `sortOrder`
- `seoTitle`
- `seoDescription`
- `seoImage`
- publish status
- sync status

规则：

- `CategoryPublicView` P1 source 是当前站点定义的 category data。
- Storefront 与 Site Runtime 只消费当前站点已发布的 category public views，不关心分类内部来源或是否参考过 item-master。
- ProductPublicView 可以通过 `category_ids` 引用当前站点定义的 category id。
- P1 不引入完整 PIM、CMS、taxonomy platform 或跨站共享分类治理。
- 若后续需要从 item-master、PIM 或其他分类源辅助生成站点分类，必须通过 `site-service` 防腐与发布模型转成 site-defined public category，不改变 Site Runtime contract。

### 4.6 SiteContentEntry

站点私有 Blog / News 内容。

本小节的核心对象、字段与查询语义以 [2.1 Frozen Site Content Category Taxonomy](#21-frozen-site-content-category-taxonomy) 为准；不得引入 `primaryTopic`、`topicIds[]` 或 Topic public view。

P1 不做跨站点内容共享，不做完整 CMS，不做 template，不做 page builder，不做任意内容类型 archive。

P1 允许 Blog / News 专用的 Content Category SEO archive 页面，用于站点内容分类的公开列表页；该能力由 `SiteContentCategory` 约束，不扩展为通用 CMS taxonomy platform。

建议拆分：

- `SiteContentEntry`: 内容逻辑记录，包含 `siteId`、`contentType`、整体状态。
- `SiteContentLocaleVersion`: 某语言版本，包含标题、slug、摘要、封面、作者名、有序 Category 引用、轻量 Tag、正文富文本、SEO、状态与同步状态。

固定字段：

- `title`
- `slug`
- `summary`
- `coverImage`
- `coverImageAlt`
- `authorDisplayName`
- `categoryIds`
- `tags`
- `bodyRichText`
- `seoTitle`
- `seoDescription`
- `seoImage`
- `publishedAt`
- slug history / redirect metadata

规则：

- Blog / News 属于某个 site。
- Blog / News 使用同一字段模型，仅通过 `contentType = blog / news` 区分。
- 多语言站点中，同一篇内容有多个 locale 版本。
- 当前 Blog / News locale version 必须自身完整才允许同步；同一内容可以逐个 locale 独立发布。
- Blog / News 引用的 Content Category 必须在该内容 locale 正式发布所需的 locale 下完整，不能把缺少的其他 locale 当作当前内容的阻塞条件。
- `publishedAt` 是运营展示时间；首次正式同步时若为空，由 OES 自动填入首次发布成功时间，后续同步不自动覆盖。
- 正文 public view 必须输出 OES 侧清洗后的 sanitized HTML。
- 正文中的非装饰性图片必须在当前 locale 与使用场景下提供 `alt`；装饰性图片必须显式标记并输出 `alt=""`。
- Media asset 默认 alt 只能作为编辑辅助，不能自动成为 Blog / News 封面图或正文图片的最终 published alt。
- Blog / News slug 变更必须保留历史 slug，供 Site Runtime 对旧 URL 执行 301 redirect。
- 不想公开展示时走 `Unpublish`。

### 4.7 SiteContentCategory

站点私有 Blog / News Content Category。它是可索引 archive 的唯一大类，不是产品 Category，也不是低粒度 Tag。

建议拆分：

- `SiteContentCategory`: Category 逻辑记录，包含 `siteId` 与排序，不再维护独立启停状态。
- `SiteContentCategoryLocaleVersion`: 某语言版本，包含显示名、archive intro、archive label、slug、SEO 与历史 slug。

建议字段：

- `siteId`
- `categoryId`
- `sortOrder`
- `locale`
- `displayName`
- `archiveIntro`
- `archiveLabel`
- `slug`
- `seoTitle`
- `seoDescription`
- `seoImage`
- `historicalSlugs`
- locale revision status
- sync status

规则：

- Content Category 属于某个 site，不跨站共享。
- Blog 与 News 共用一套 Content Category。Category 不拥有适用类型；Article 的 `contentType` 与实际 Category 引用共同决定 Blog / News archive membership。
- Content Category 只拥有一套站点级人工 `sortOrder`。Blog 与 News 分别过滤出当前 locale 下实际可见的 Category 后，必须沿用这套相对顺序；不维护 Blog 专属顺序或 News 专属顺序。
- Category 支持多 locale，不同 locale 可以有不同 slug、显示名、archive intro 与 SEO。
- Category locale version 只需在被正式发布内容引用的对应 locale 下完整，缺少的其他 locale 不阻塞当前 locale 内容发布。
- Category locale 发布硬要求只有非空 `displayName` 与通过 slug ledger 校验的 canonical `slug`。`archiveIntro`、`archiveLabel`、`seoTitle`、`seoDescription` 与 `seoImage` 均可为空；缺少这些可选内容最多产生非阻塞 SEO / 内容质量 warning，不得阻止发布。
- Category archive 的固定回退为：`archiveLabel -> displayName`、SEO title `-> displayName`、SEO description `-> archiveIntro -> omit`、SEO image `-> Storefront 全局 OG fallback -> omit`。Site Service 不用 `siteName` 或其他语言内容伪造回退值，Storefront 仍拥有最终 title composition 与全局 SEO shell。
- Category locale 只维护 draft revision 与 last published revision：首次发布使该 locale metadata 可供已发布 Article 引用，后续编辑先形成草稿，只有再次发布修改后才替换 last published revision。P1 不提供 Category locale 下架或 Category 整体停用状态，也不允许保存草稿即覆盖线上内容或回退其他 locale。
- Category locale 的发布只表示该语言 metadata 已获准进入公开组合，不等同于 Category archive 一定可见。只有同 locale、对应 `contentType` 的 published Article 实际引用它时，Category 才进入该类型公开筛选、sitemap 与 archive route；最后一个 published 引用消失后自然移除并返回 404。
- 允许先发布没有任何 Article 引用的 Category locale，以便完成首次配置并供 Article editor 选择；此时它只是可引用的 published metadata，不产生公开入口、sitemap URL 或可访问 archive。Article locale 发布必须校验其每个 Category 在同 locale 已存在 last published revision，第一篇有效 Article 发布后两者才共同取得公开资格。
- Category 通过稳定 `categoryId` 被 Article 引用，可以独立发布名称、archive 文案、SEO、排序与 slug 修改；这些修改不要求重发所有关联 Blog / News。只有 Article 自身的 `categoryIds[]` 发生变化时，才发布该 Article 的 replacement revision。
- Category 修改同步失败时，Runtime 必须继续服务上一份完整 Site publication，包括上一 Category metadata、旧 canonical 与一致的 Article 关系；自动追赶成功前不得暴露新旧 Category / Article 混合结果。
- Blog / News 的 Category 关联变化必须标记对应内容 pending sync。关联是 ordered collection，第一个值为 primary category。
- 停止公开使用某 Category 时，运营只需把 published Article 改到其他 Category 或下架相关 Article；仅在 Article 草稿中移除关系不会改变当前公开 archive，replacement revision 正式发布后才解除旧 published 引用。
- Article Category 删除必须先确认没有任何 Article draft 或 published revision 引用；存在引用时拒绝，并返回可识别的阻塞 Article、`contentType`、locale 与 draft / published revision 类型。
- 从未发布且无引用的误建 Category 可以永久删除，并释放其 draft-only slug reservation。曾经发布且已无引用的 Category 允许从用户工作区删除，但 Site Service 只删除可编辑内容并保留最小 tombstone、稳定身份、全部已发布 slug ownership 与审计；它不再出现在普通列表、selector 或 public view，P1 不允许复用其 canonical / historical slug。
- Category slug 变更必须保留历史 slug；真实的同一 Category historical slug 可 301 到当前 canonical。Meilong 中该目标必须是复数 `/blogs/categories/:categorySlug` 或 `/news/categories/:categorySlug`；`/topic/` 与 singular `/category/` namespace 不是 historical slug，必须 terminal 404 且不返回 `Location`。
- Category archive 公开可见性由 published Blog / News 引用反向驱动；没有 published 内容引用的 Category 不出现在公开入口、sitemap 或可索引页面。
- Category 不维护 Blog / News archive visibility 开关。当前 locale Category 已发布且被对应 `contentType` 的 published Article 引用时，才成为该内容类型的公开 archive/filter 候选项；`archiveLabel` 只是候选项短文案，Storefront 仍决定是否、在哪里、以何种交互展示。
- P1 不做多级 Content Category 树、跨站共享 Category、AI 自动打标、复杂搜索或 Category landing page。

OES 管理工作流：

- 入口固定为 `Site Management -> Content Management -> Article Categories`。Blog 与 News 共用这一个 Category 工作区，不各自复制一套分类。
- 创建 Category 必须在同一次用户提交中保存 Category 基础信息与 default locale 的名称、slug、archive intro / label、SEO；任一步失败都不得留下只有 Category id、没有可继续识别内容的空壳记录。
- 创建成功只形成完整草稿，不自动公开、不生成 publishVersion，也不通知 Runtime；其他 locale 在草稿建立后逐个添加。
- 运营人员按 locale 独立保存草稿与发布内容修改。某 locale 首次发布或再次发布修改后，由 OES 形成 pending Site Sync 并沿用站点自动同步闭环；不要求在站点 Backend 再手动点击同步。
- 首次使用顺序固定为“创建 Category locale 草稿 -> 发布 Category locale metadata -> 在 Article 中选择 -> 发布 Article”。空 Category metadata 可以先发布但不公开，避免 Article 与 Category 之间形成相互等待。
- Category 列表只需优先展示 default locale 名称、各 locale 是否存在 last published revision / pending draft changes，以及 published Blog / News usage counts。Usage 已足以解释公开结果，不再增加独立“公开位置”或整体 `active / healthy` 状态；同步正常时不逐行显示，只有 pending / retrying / failed 才在受影响 Category 上提示。
- Article Categories 工作区统一维护站点级 Category 顺序；调整该顺序会同时影响 Blog 与 News 中符合公开资格的 Category 相对顺序，但不会使未被对应内容类型使用的 Category 出现在该类型页面。
- Blog / News 编辑器只引用已存在的 Content Category，使用可搜索、多选并保留顺序的 selector；不得要求运营人员手工输入 Category id，也不得在文章编辑器内创建另一套 Category 对象。
- 删除成功后，普通运营列表与 Article selector 不再返回该 Category；最小 tombstone 只用于 slug ledger、审计与历史一致性，不作为可继续编辑的 Category。
- P1 不提供 Article Category archive 草稿预览。Blog / News detail preview 保持独立；需要验证 Category 真实 Storefront 模板、URL 与 SEO 输出时，在独立测试 Site 对象发布验证，不复用生产 Site，也不新增 Category preview token、draft Article composition 或特殊 Runtime route。

### 4.8 SiteFaq

站点私有 FAQ 内容。FAQ 是 Site Management 拥有的独立内容对象，不复用 Blog / News 的 `contentType`，也不属于 `SitePage` 内容本身。

建议拆分：

- `SiteFaqCategory`: 站点级一级 FAQ 分类，维护显示名称、locale 版本、排序与发布状态。
- `SiteFaqEntry`: 归属于一个 FAQ Category 的问题与答案，维护 locale 版本、排序与发布状态。

规则：

- FAQ 属于某个 Site，不跨站共享。
- P1 只支持一级 Category；每条 FAQ Entry 只能属于一个 Category；Category 与 Entry 均支持人工排序。
- Category 与 Entry 按 locale 独立维护和发布；缺少当前 locale 的已发布内容时，Storefront 不回退其他语言。
- FAQ 只提供一个 Storefront 页面 `/faqs`；Category 不产生独立公开 URL、canonical、historical slug 或 sitemap entry。
- `SitePage` 的 `FAQ` 能力继续控制 FAQ 页面整体是否公开以及页面级 index 意图；FAQ Category/Entry 的内容与顺序不属于 `SitePage`。
- Storefront 保留 FAQ 页面的布局、分类导航、折叠交互、页面标题、简介与路由级 SEO 文案；FAQ 页面中的 Category 导航、锚点、问题与答案由 Runtime 已发布数据动态渲染。
- FAQ public view 不承载客户提交的问题。客户提问进入 CRM Inquiry；只有人工筛选、去除客户隐私并创建 FAQ 草稿后，才能进入公开 FAQ 发布链路。
- FAQ 保存只形成 pending sync；显式 Sync 才生成 FAQ public view 并通知 Site Runtime。
- FAQ P1 不包含页面内搜索、Category 详情页、评论、自动问答或客户问题自动公开。

### 4.9 SiteInspiration

站点私有视觉灵感内容。Inspiration 是 Site Management 拥有的一级内容对象，不复用 Blog / News Article，也不把图片文件真相收回 `site-service`。

当前已冻结的最小对象关系：

- `SiteInspirationItem`：瀑布流中的一个图片项目；Meilong 当前一张瀑布流图片对应一个 Item。
- `SiteInspirationCategory`：Item 的站点级分类；一个 Item 可以属于多个 Category，不因多分类复制图片或 Item。
- 一个 Item 必须且只需引用一个受控图片 `assetId`。P1 不把 Item 扩展为多图相册、案例文章或 page builder。
- Item 使用一个站点级人工 `rank`；同一 Item 属于多个 Category 时不为 Category-Item 关系建立独立顺序。
- `SiteInspirationHotspot`：归属于一个 Item 的稳定热点位置；第一阶段只拥有相对于原始图片的归一化 x/y、稳定身份、人工顺序与检查状态，不拥有尚未冻结的 Product target。

Asset ownership 边界：

- `asset-service` 拥有文件二进制、对象存储 key、稳定 `assetId`、公开访问地址、原始宽高、格式、大小、技术校验与资产生命周期真相。
- `site-service` 只保存 Asset 引用以及 Inspiration 使用语义，包括 Category 关系、人工顺序、locale 使用场景 alt、草稿 / 发布 / 同步状态；不得复制文件真相或接受任意外链 URL 作为正式图片来源。
- Asset 的通用默认 alt 只可作为编辑辅助。正式 Inspiration public view 的 alt 可以为空；如果填写，则必须是当前 Item 使用场景按 locale 维护的值，不能自动继承默认值或其他 locale。
- 原始宽高与比例来自 Asset facts；OES 不保存 Storefront 列数、裁切模板、目标卡片比例或响应式布局规则。

发布与读取规则：

- Site Service 在发布前必须确认 Asset 属于允许的 tenant / scope、状态可用且可以公开解析；验证失败时该 Item 不能进入正式发布。Item alt 缺失只产生非阻塞的可访问性警告，不阻止发布。
- 已被 published Inspiration 引用的 Asset 在解除引用或替换前不得被盲目物理删除；通用 Site media 的解析、publication protection、释放与生命周期以 [site-media.md](../../contracts/asset-service/site-media.md) 和 [site-asset-media.md](../collaborations/site-asset-media.md) 为准。Site 实现不得以普通 URL 字段绕过该依赖。
- Site Sync 输出 public-safe resolved asset data，至少保持稳定 Asset 身份、公开读取地址、原始宽高与当前 locale alt 的语义；Storefront 正常请求只读取 Runtime 本地已发布数据，不在 request-time 调用 Asset Service。
- Storefront 继续拥有现有 masonry、lightbox、加载、裁切与响应式表现；从静态数据切换为 Runtime 数据不得改变已冻结布局和交互。
- 根 `/inspirations` 页面的标题、简介、页面级 SEO 文案、OG / Twitter 文案与根页 JSON-LD 继续由 Storefront 自己维护，不由 Site Service 或 `InspirationItemPublicView` 覆盖；OES 只通过 SitePage / locale governance 控制该页是否公开、是否 indexable 以及支持哪些 locale。
- `/inspirations/category/{slug}` 是动态 Category 页面；其 Category 名称、简介、slug、SEO 与公开状态由 `SiteInspirationCategory` 的 locale 版本提供，Storefront 只负责使用现有页面模板呈现。
- 根页先按 Item 全局 rank 展示全部已发布 Item；Category 页只做 membership filter，再沿用同一 Item rank。Category 自身另有 Category rank，仅用于筛选项顺序。
- Item rank 相同时必须使用稳定 Item 身份作为确定性 tie-breaker；分页发生在最终排序之后。
- P1 明确不支持、也不预留 Category-Item 关系级 rank；不同 Category 中的同一 Item 不允许被配置成不同位置。
- Hotspot 坐标相对于 Item 原始 Asset 的完整图片，采用分辨率无关的归一化位置；Storefront 将其映射到现有 lightbox，不由 OES 保存像素坐标、裁切结果或响应式位置。
- Item 更换 Asset 时，现有 Hotspot 全部进入 `needs_review`，在运营人员重新确认前不得进入公开输出；Item 图片本身仍可按自身发布状态公开。
- Product target 在 Product Master–Site Product 身份冻结前不得进入正式关联契约。未绑定有效 target、处于 `needs_review`、或未来 target 已不可公开的 Hotspot 一律不向 Storefront 输出，但不影响 Inspiration Item 本身。
- Hotspot 不允许以任意 URL、手填商品名称、价格或测试商品快照代替正式 Product target；OES 不管理热点图标、drawer 样式或交互布局。

OES Hotspot authoring flow：

- 运营人员先在 Inspiration Item 编辑页通过受控 Asset Library 选择或上传图片；Asset Service 返回稳定 `assetId`，Site Management 不提供另一套文件上传或普通 URL 输入。
- 图片保存到 Item 后，运营人员进入轻量 Hotspot placement 模式，直接在实际图片边界内点击添加标记、拖动调整或删除。管理端可以显示位置，但正常用户不输入或编辑 x/y 数值。
- Admin 将图片内点击位置换算为归一化坐标，Site Service 必须验证坐标位于有效范围内；预览容器留白、缩放比例和屏幕尺寸不得进入持久化坐标。
- Product target 尚未冻结时，新建 Hotspot 保存为未绑定状态；Item 草稿和 Item 图片可以继续发布，但未绑定 Hotspot 不进入 public view。
- Item 更换 Asset 后，所有既有 Hotspot 自动进入 `needs_review`。运营人员逐个移动、删除或重新确认；未确认 Hotspot 不公开，但不阻塞 Item 图片发布。
- Hotspot editor 不是图片处理工具，不支持裁切、滤镜、绘图、文字图层或复杂图层系统。

OES Inspiration workspace flow：

- 入口固定为 `Site Management -> Content Management -> Inspirations`，工作区包含 `Items` 与 `Categories` 两个数据面，不新增 Site 顶层导航，也不把 Item 放入 Pages。
- Item 创建流程依次处理受控 Asset、零到多个 Category、Site 级 rank、各 locale alt / 发布状态以及可选 Hotspot；Item 可以不属于任何 Category，并仍出现在根 `/inspirations`。
- Items 列表至少能够表达缩略图、Category membership、草稿 / 已发布 / 已取消发布、locale 发布覆盖、pending sync、Hotspot 未绑定 / 需复核状态与 Asset 可用性。
- Categories 工作区维护一级 Category、locale display name / intro / slug / SEO、Category rank、发布状态与各 locale 已发布 Item 数量。
- 保存草稿或公开配置变化只形成 pending sync；正式 Site Sync 才生成 `InspirationItemPublicView` / `InspirationCategoryPublicView` 并通知 Runtime。Runtime 自动拉取，操作者不在站点 Backend 再执行第二次同步。
- Category 在某 locale 没有已发布 Item 时可以保留在 OES，但不进入该 locale 公开筛选、sitemap 或 Category 页面。
- Runtime 公开查询按 locale、可选 Category、Site 级 Item rank 与稳定身份过滤 / 排序，并在最终结果上分页；Storefront 决定加载批次与 masonry 交互。
- Runtime 分页游标必须绑定本地 publishVersion 与 filter；若分页期间本地版本切换，Storefront 重置并从第一页读取，不能把两个版本拼接成一个 gallery。
- 根 `/inspirations` 无 published Item 时保留 Storefront 自有页面 shell，显示固定通用空状态并 `noindex`；Category 空结果继续 not found。任何场景都不得回退静态 gallery fixture。
- Runtime Sync 失败时保留上一份完整 Inspiration publication；不暴露部分 Category、部分 Item 或新旧版本混合结果。

### 4.10 SitePublicView

站点 runtime 同步用的公开数据，不是编辑源数据。

P1 类型：

- `ProductPublicView`
- `CategoryPublicView`
- `BlogPublicView`
- `NewsPublicView`
- `ArticleCategoryPublicView`
- `FaqDirectoryPublicView`
- `InspirationItemPublicView`
- `InspirationCategoryPublicView`

带公开 URL 的业务 public view 统一使用以下外壳；页面级 FAQ directory view 使用 [FaqDirectoryPublicView](../../contracts/site-service/public-views.md#8-faqdirectorypublicview-payload) 例外 shape：

- `siteId`
- `resourceType`
- `resourceId`
- `locale`
- `slug`
- `status`
- `publishVersion`
- `payload`

站点 runtime 本地可以统一保存到 `published_resources`，但 OES 端编辑与发布模型不得只依赖一个大 `payloadJson`。

分类发布规则：

- `CategoryPublicView` 由 `SiteCategoryDefinition` 生成。
- `CategoryPublicView` 不暗示分类必然来自 item-master category projection。
- `ProductPublicView.category_ids` 引用的是当前站点公开分类 id。

Blog / News / Content Category 发布规则：

- `BlogPublicView` / `NewsPublicView` 由 `SiteContentEntry` 与对应 locale version 生成。
- `ArticleCategoryPublicView` 由 `SiteContentCategory` 与对应 locale version 生成。
- Blog / News public view 只携带有序 `category_ids[]`；Category 显示名、archive intro、slug、描述与 SEO 以 `ArticleCategoryPublicView` 为准。
- Site Runtime 可本地保存 `ArticleCategoryPublicView`，但公开 Category archive、导航和 sitemap 必须由 published Blog / News 引用反向驱动。
- `ArticleCategoryPublicView` 可同步到 Runtime，不代表该 Category 一定公开可见。

Blog / News 组合查询规则：

- `BlogPublicView` / `NewsPublicView` 包含有序 `category_ids[]` 与轻量 `tags[]`。
- Runtime 提供本地 published `BlogPublicView` / `NewsPublicView` 的组合过滤结果与空结果信号；Storefront 根据其页面 filter、canonical 路径与 SEO 策略决定 Category archive 是否公开或进入 sitemap。空结果页面不得索引。
- Tag 只随 `BlogPublicView` / `NewsPublicView` 输出，不单独同步 Tag public view，不产生默认 archive 或 sitemap route。

FAQ 发布规则：

- `FaqDirectoryPublicView` 按 `site + locale` 聚合当前已发布、已排序的 FAQ Category 与 Entry，供 Runtime 本地 `/faqs` 页面读取。
- FAQ directory view 是页面级公开数据，不参与 dynamic slug ledger、historical redirect 或独立 URL 生成；Storefront 仍拥有 `/faqs` 路由与页面 shell SEO 文案。
- 当前 locale 没有可公开的 FAQ directory view 时，FAQ 页面不得回退其他 locale；Storefront 按 SitePage/locale 公开治理返回不可用或 not found 结果。
- FAQ 不建立独立版本号、历史版本管理或运营回滚界面；`FaqDirectoryPublicView` 只随 Site 统一 `publishVersion` 进入正式同步。

Inspiration 发布规则：

- `InspirationItemPublicView` 是无 Item 详情 URL 的视觉项目公开数据，不参与 Item slug ledger、historical redirect 或独立 sitemap entry。
- Inspiration public view 只携带已解析的 public-safe Asset 数据与 Site-owned 使用语义；Runtime / Storefront 不接收对象存储内部 key，也不实时解析 Asset。
- Inspiration Category 的站点归属、一级层级、多 Item 关系、顺序、slug、locale 文案、SEO、公开状态与 `InspirationCategoryPublicView` 最小 payload 已冻结；实现不得从当前静态前端数组额外推导未确认字段。

版本化公开输出规则：

- 每个已提交 `publishVersion` 的 public views 与 Site Exposure Publication 构成该 Site 在该版本下的不可变公开输出；具体持久化可以采用版本行、copy-on-write 或等价机制，但不能只保留会被下一次发布覆盖且无法按 target 读取的单份 latest 行。
- 版本化公开输出是 Site Sync 的传输一致性机制，不为 FAQ、Blog、News 等资源分别建立用户可见的内容版本管理能力。
- 发布 N+1 不得改变或污染仍可读取的 N；Runtime 按 target 拉取 N 时，所有 delta、batch、snapshot page 与 exposure 都必须解析为 N 的状态。
- 公开输出保留策略可以独立演进，但仅发布更高版本不能立即使上一 target 不可读。若请求 target 已超出保留范围或因完整性问题不可读取，Site Service 必须显式拒绝，不能回退 latest 或返回混合版本。

### 4.11 SiteSyncBatch

一次显式同步动作。

- `siteId`
- `syncId`
- `publishVersion`
- status
- resource count
- triggered by
- started / completed metadata

每个 batch 包含多个 `SiteSyncResource`：

- `resourceType`
- `resourceId`
- `locale`
- `changeType`: `create` / `update` / `unpublish` / `locale_activate` / `locale_disable`

规则：

- 保存只产生 pending sync。
- 同步才生成 / 更新 public views。
- 无变更不生成版本、不发 webhook。
- 同一 Site 的正式 Sync 必须串行化；并发 Sync 不能基于同一个已提交版本各自生成重复的下一版本。竞争者只允许有限等待，并在取得发布权后基于最新已提交状态重跑完整事务，最终成为 no-op 或发布剩余 pending changes。
- 每个 pending resource 必须具备内部 revision。Sync 捕获自己物化的 expected revision，并且只能用 CAS 清除该 revision；同步期间产生的新 revision 不阻塞编辑，也不得被旧 Sync 清账，必须继续保持 pending。
- publishVersion、pending snapshot、public views、Site Exposure Publication、CAS 清账结果、sync batch 与 Site 最新版本必须在同一数据库事务中原子提交；同一 Site 的 publishVersion 唯一性由数据库约束作为最终防线。
- 每个站点每次同步最多发送一次 webhook。
- Site Runtime 收到 webhook 后 `syncToLatest()`。
- P1 sync resource type 覆盖 `product`、`category`、`content`、`blog`、`news`、`article-category`、`faq`、`inspiration`、`inspiration-category`。

### 4.12 SiteWebhookEndpoint

P1 可先以 `Site.webhookUrl` 表达，概念上负责 OES 通知站点 runtime 有新版本可拉取。

默认事件：

```text
site.publish.available
```

Webhook 只通知，不携带完整业务数据，也不携带 changed resource list。

每个已成功提交且确有变化的 publishVersion 都产生一次新的 webhook 通知。Webhook 中的 publishVersion 只是唤醒提示，不是 Runtime 的读取真相；通知必须在正式事务提交后发送，失败可以重发但不能回滚已提交版本。

### 4.13 SiteRuntimeStatus

OES 看到的站点运行与同步状态。

典型信息：

- local publish version
- latest known OES publish version
- last sync status
- last sync time
- runtime kit version
- store status
- recent error
- status: `healthy` / `degraded` / `blocked` / `failed` / `unknown`

来源可以是：

- Site Runtime 主动上报。
- OES 通过受保护 runtime status endpoint 查询。

### 4.14 SiteAuditLog

站点治理与同步审计事实。

P1 至少记录：

- `site.created`
- `site.updated`
- `site.disabled`
- `locale.added`
- `locale.activated`
- `locale.disabled`
- `credential.generated`
- `credential.rotated`
- `credential.revoked`
- Product Master–Site Product 关系相关 audit event 名称与语义继续后置，不在 P1 稳定事件清单中冻结。
- `category.created`
- `category.updated`
- `category.unpublished`
- `content.created`
- `content.updated`
- `content.unpublished`
- `content.slug_changed`
- `content_category.created`
- `content_category.updated`
- `content_category.locale_published`
- `content_category.deleted`
- `content_category.slug_changed`
- `faq_category.created`
- `faq_category.updated`
- `faq_category.disabled`
- `faq_entry.created`
- `faq_entry.updated`
- `faq_entry.unpublished`
- `sync.started`
- `sync.completed`
- `sync.failed`
- `webhook.sent`
- `webhook.failed`
- `runtime.status_reported`

P1 不做复杂审计回放。

### 4.15 SitePage

`SitePage` 是站点页面能力与公开状态的治理对象，统一覆盖静态页面和动态页面模板；它不是页面内容、组件树或资源实例。

页面能力与页面治理必须分离：Storefront 项目声明自己实际实现的稳定页面身份与支持的 locale，Site Runtime 在启动时向 OES 幂等注册该能力；OES 只保存能力发现状态，不因注册自动公开页面。OES 管理端基于已注册能力维护 SitePage 的公开与 SEO 治理状态。

建议字段：

- `siteId`
- `pageKey`
- `enabled`
- `indexPolicy`
- `publishVersion`
- audit metadata

规则：

- `pageKey` 是页面的稳定身份，例如 `ABOUT`、`CONTACT`、`PRODUCT_DETAIL`、`BLOG_CATEGORY`、`INSPIRATION`。
- 静态页面的 `SitePage` 控制一个逻辑页面是否公开；动态页面的 `SitePage` 控制对应模板页面能力是否公开。
- `SitePage` 不设置 `pageKind`，不建立 `static / collection / archive / detail` 等页面分类体系。
- 页面能力注册只包含稳定 `pageKey` 与 Storefront 支持的 locale，不包含布局、组件、页面内容、资源实例或前端内部路由。
- 页面能力注册以站点、`pageKey` 与 locale 幂等识别；重复注册只刷新发现状态，不生成重复能力，也不重置 OES 的公开或 SEO 配置。
- 新注册能力默认不公开；已知能力暂时未被 Runtime 注册时不自动删除。已启用能力从最新注册清单消失时，OES 必须标记能力漂移并阻止新的正式同步，不能静默造成线上 404。
- 站点 locale 由 SiteLocale 在站点级统一控制；不提供页面 × locale 的独立公开开关。SitePage 的公开与 index 意图是页面能力整体治理，适用于站点已启用的所有 locale。
- 静态页面和动态页面使用相同的启用、locale、SEO、发布与审计规则。
- Storefront 负责页面路由、页面内容、布局和最终 HTML；OES 负责页面公开治理。
- `indexPolicy` 是 OES 提供的页面级 SEO 治理信号；sitemap 不是独立运营开关，而是 Storefront / Runtime 根据页面可访问性、index 意图、canonical 和内容资格自动生成。
- `index = false` 时页面可以访问，但 Storefront 必须输出 `noindex`，且不得进入 sitemap 或 hreflang；`index = true` 只有在 canonical 有效且页面内容满足发布条件时才具备 sitemap 资格。动态资源自身的 `indexable/noindex` 可以进一步否决索引。
- 静态页面公开必须同时满足有效公开 locale、SitePage 整体已启用以及 Storefront 已实现该页面的对应 locale；站点 locale 激活前必须通过静态页面能力完整性校验。动态页面公开必须同时满足有效公开 locale、SitePage 模板整体已启用以及对应资源 locale 已正式发布；动态资源不要求一次性补齐所有历史 locale 版本。
- 动态页面对应的具体资源 slug、内容和发布状态不属于 `SitePage`。

## 5. Does Not Own

- 产品 / 物料主数据真相。
- 价格真相。
- 库存真相。
- 客户真相。
- 询盘真相。
- 订单真相。
- 支付、收款、发票真相。
- 仓库分配、发货、履约真相。
- 完整 CMS 与页面搭建器。
- Storefront Frontend 页面渲染。
- Site Runtime 本地 SQLite / Local Published Store。
- Amazon / 1688 / 淘宝 / 京东等第三方 marketplace 集成。
- IM、Email、社媒渠道与外部沟通线程。

第三方电商平台、IM / Email / 社媒渠道后续应按各自领域独立设计，不纳入 `site-service`。

## 6. P1 Scope

P1 包含：

- site registry
- site card workspace 所需状态数据
- locale lifecycle
- credential bundle
- basic scopes
- product public-view publication boundary（Product Master–Site Product 关系继续后置）
- site-defined category definition
- site-scoped Blog / News
- site-scoped Blog / News Content Category
- Blog / News Content Category SEO archive public views
- site-scoped FAQ Category / Entry
- FAQ directory public views
- Blog / News and Content Category slug history for P1 301 redirect
- preview token and draft preview view
- explicit sync batch
- public view generation
- publish version
- changed resource index / sync resource list
- webhook notification
- runtime status inspection
- site audit
- site page exposure governance

P1 不包含：

- template
- page builder
- full CMS archive
- Content Category landing page
- automatic translation
- automatic product master publish
- price / inventory final validation
- inquiry submission
- order intake
- customer account
- dealer account
- payment / checkout
- third-party marketplace connector
- IM / Email / social channel
- multi-runtime endpoint
- complex redirect management
- CDN purge

说明：

- P1 允许 Blog / News 专用 Content Category archive 页面；这不是完整 CMS archive，也不引入任意内容类型归档能力。
- P1 只做 Blog / News 与 Content Category 自身真实 historical slug 的 301 redirect，不做全站复杂 redirect management；Meilong 的 retired Topic / singular Category namespace 不属于 historical slug 兼容范围。
- FAQ 使用单页 `/faqs`，不引入 Category URL 或 FAQ slug redirect。

## 7. Collaboration Boundaries

`site-service` 读取 OES Core 的业务真相，但不拥有内部业务真相。

产品同步协作继续后置：Product Master–Site Product 的 owner 协作、identity mapping、选品与发布 lifecycle 必须在独立设计中冻结后才能回写本真相源。现有 `ProductPublicView` 读取能力不构成该关系已冻结的证据。

Category 协作：

```text
OES Admin defines site category tree
  ↓ save draft
site-service marks pending sync
  ↓ explicit Sync
site-service builds CategoryPublicView from site-defined category data
  ↓ webhook notify
Site Runtime pulls latest category views
  ↓
Storefront renders current site's public taxonomy
```

Blog / News 协作：

```text
OES Admin edits site-scoped Blog / News
  ↓ save draft
site-service marks pending sync
  ↓ explicit Sync
site-service builds BlogPublicView / NewsPublicView
  ↓ webhook notify
Site Runtime pulls latest views
```

Blog / News Content Category 协作：

```text
OES Admin manages site-scoped Content Category
  ↓ save draft
no public change; last published revision remains active
  ↓ publish locale changes
site-service marks Category pending sync and enters automatic Site Sync
  ↓
site-service builds ArticleCategoryPublicView
  ↓ webhook notify
Site Runtime pulls latest Category view
  ↓
Storefront shows Category archive only when published Blog / News references it
```

FAQ 协作：

```text
OES Admin manages site-scoped FAQ Category / Entry
  ↓ save draft
site-service marks FAQ directory pending sync
  ↓ explicit Sync
site-service builds FaqDirectoryPublicView for one locale
  ↓ webhook notify
Site Runtime pulls and atomically stores the FAQ directory
  ↓
Storefront preserves the existing /faqs layout and dynamically renders categories, anchors and entries
```

Preview 协作：

```text
OES Admin saves draft
  ↓ Preview
site-service issues previewToken
  ↓ opens site preview URL
Site Runtime calls OES Preview API through @oes/site-runtime-kit
  ↓
site-service returns draft preview view
  ↓
Site Runtime renders real preview page without writing formal store
```

Future commerce collaboration:

```text
Site Runtime
  ↓
Site Ingress
  ↓
Sales / Order / Pricing / WMS / CRM services
```

在 commerce 场景中，`site-service` 只提供 site / region / channel / policy / public view 上下文，不拥有订单、库存、价格、客户或询盘真相。

## 8. External Interfaces

典型上游入口：

- OES Admin / tenant-web
- `api-gateway` Admin BFF
- `api-gateway` Site-facing BFF / Site API
- Site Runtime runtime-status 巡检路径

典型站点侧消费者：

- `@oes/site-runtime-kit`
- Site Runtime backend

具体 HTTP / gRPC / event 黑盒契约以 `docs/contracts/**` 为准；已冻结的 Site Media 与 Asset event contract 不得由实现重新定义，尚未列入 contract 的新 surface 仍须先冻结。

`site-service` 不直接面向公网暴露 Site Runtime API。外部 Site Runtime 必须通过 `api-gateway` 的 Site-facing BFF / Site API 访问 OES。

`api-gateway` 负责 HTTP 入口、DTO 校验、HTTP 错误模型、operator / site caller context、trace、rate limit 与签名校验前置；`site-service` 负责 credential、site status、scope、sync state、public view 与 audit 的最终真相判定。

内部调用的可信边界以 [grpc-metadata-and-service-trust.md](../platforms/grpc-metadata-and-service-trust.md) 为准。Gateway 不把 HTTP access token、Runtime HMAC 或 body operator 原样当作 Site gRPC 凭据，而是取得 `aud=site-service` 的 ExecutionToken。

Site Sync 调 Asset 的稳定多跳形态：

```text
Gateway -> Site: aud=site-service, BUSINESS site.management.sync
Site verifies business authorization and Site ownership
Site -> STS: request aud=asset-service + exact asset.internal.* code
Site -> Asset: INTERNAL ExecutionToken bound to site-service workload
```

Site 不 hardcode Permission Code 转换表；调用 Asset adapter 的方法签名显式声明所需 INTERNAL Code，STS 再依据 Site workload issuance policy 决定是否签发。Site audience Token 不得原样传给 Asset。

## 9. Sync Semantics

同步是操作者显式动作，不是每次保存自动触发。

```text
Save draft / config
  ↓
Pending Sync
  ↓
Sync All Pending Changes / Retry
  ↓
Validate static page capability coverage and per-resource locale readiness
  ↓
Build public views
  ↓
Advance site publishVersion
  ↓
Send one webhook per site
  ↓
Site Runtime pull latest
```

全局同步时：

- 有 pending changes 的站点才处理。
- 无变更站点跳过。
- 每个站点生成自己的 sync batch。
- 每个站点最多发送一次 webhook。
- 同一 Site 的 Sync 先取得 site-scoped 数据库事务发布权，再从最新已提交版本与 pending revisions 构建本轮一致快照；锁竞争只允许有限等待，重试必须覆盖完整事务。
- Sync 只清除与本轮 expected revision 一致的 pending resource。同步期间保存的新 revision 保持 pending，并由下一批发布。
- 正式版本、版本化公开输出、batch 与清账结果必须同事务提交；提交失败不得留下部分 publishVersion 或部分 public views。

Site Runtime 同步时：

- Runtime 先查询 OES 当前 latest committed publishVersion，并将该值固定为本轮 target；`ListChangedResources.to_publish_version`、每次 `BatchGetPublicViews.target_publish_version`、每一页 `GetSnapshot.target_publish_version` 都必须显式携带该 target，且 delta、snapshot、public views 与 Site Exposure Publication 必须全部属于同一 target。
- Webhook publishVersion 不直接充当 target。Webhook 延迟、丢失、重复或乱序时，Runtime 仍以重新查询到的 latest committed publishVersion 为准。
- Site Service 不得在 target 缺失时默认为 latest；target 尚未提交、不可读取或已超出保留范围时必须返回明确的同步协议错误。Runtime 丢弃本轮临时结果、保留上一个完整本地版本并重新发现 latest。
- Runtime 正在同步时收到新的 webhook 或 pull trigger，不并行启动第二轮写入，而是合并为一次 pending trigger。当前 target 完成后必须重新查询 latest 并自动追赶；若当前读取检测到版本漂移，则整轮不得提交，并由 pending trigger 重新发现目标。
- 任一轮失败都必须保留 Runtime 上一个完整提交的本地版本；startup recovery 与定时 pull fallback 负责在 webhook 未到达或进程重启后继续追赶，不需要人工触发 Runtime Sync。

Webhook 失败可重发。Site Runtime 必须具备 pull fallback。

关键取舍与失败语义以 [ADR 0010](../../adr/0010-site-publish-sync-concurrency.md) 为准。

## 10. Preview Semantics

P1 预览规则：

- 只能从 OES Admin 发起。
- 必须先保存草稿。
- preview token 短时有效。
- preview token 绑定 site、resource、locale、operator。
- token 不携带完整内容。
- Site Runtime 用 `@oes/site-runtime-kit` 调 OES Preview API 拉 draft preview view。
- 预览不写 Site Runtime 正式 store。
- 预览不生成 publishVersion。
- 预览不触发 webhook。
- 预览页面必须 `noindex`、`nofollow`、`no-store`。
- P1 预览只覆盖 product / blog / news detail，不覆盖 Category archive、Blog / News list、sitemap 或 robots。
- 若 OES draft preview 不可用，Site Runtime 可以 fail closed 并返回 5xx，但响应仍必须带 `noindex` / `nofollow` 与 `no-store` 语义。
- Storefront 可以把不可用的 preview 渲染为安全 fallback 页面，但该 fallback 不代表正式 published data，不得写入正式 store、生成 publishVersion 或触发 webhook。

## 11. Non-goals

- 不作为所有外部数字触点的统一大平台。
- 不承载 Amazon / 1688 / 淘宝 / 京东等第三方电商渠道。
- 不承载 IM / Email / 社媒沟通渠道。
- 不作为所有网站页面渲染的实时后端。
- 不直接替代 `item-master-service`、未来 CMS、CRM、Sales、WMS、Finance 等业务服务。
- 不在 P1 实现 inquiry、order、payment、dealer portal account 等业务写入能力。

## 12. Truth Source Rule

本文是 `site-service` 的唯一稳定服务职责真相源。其他 architecture、collaboration、contract、active design 或 Delivery artifact 只能引用本文，不得重新定义 `site-service` 的服务职责、核心对象或 owner 边界。
