# Site Collection 页面治理设计

## 0. 文档控制

```text
designKey: site-collection-governance-design
designStatus: ACTIVE_DESIGN_WORKSPACE
implementationStatus: PARTIALLY_IMPLEMENTED
lastUpdatedAt: 2026-07-19 10:58:28 Asia/Shanghai
lastUpdatedBy: Codex
supersedes: none
truthSource: pending write-back after collection governance closure
conflictResolution: 本文只记录当前 Collection 页面治理讨论；稳定 architecture / ADR / contracts 明确覆盖本文时，以稳定真相源为准。
```

## 1. 目标

冻结站点 Product Collection 的层级、发布、页面展示、产品聚合、图片职责与 SEO 行为，并明确 OES、Site Runtime SDK、Storefront 的职责边界。

## 2. 当前范围

本 workspace 负责：

- 站点级 Product Collection 治理。
- Collection 树形结构、同级排序与公开页面行为。
- 父 Collection 的子 Collection 展示与产品聚合。
- Collection 代表图、Banner、筛选、排序、分页与 SEO 页面行为。
- OES、SDK、Storefront 的职责边界。

本 workspace 不负责：

- Product 主数据真相。
- Product Master 与 Site Product 的最终关系。
- 产品名称、规格、事实图片等产品事实的最终归属。
- 具体字段、数据库 schema、proto 或代码实现。

## 3. 已确认决定

| 日期 | 决定 | 影响范围 |
| --- | --- | --- |
| 2026-07-18 | 公开产品分组统一使用 Product Collection，不另设公开 Product Category 页面能力。 | Site / Storefront |
| 2026-07-18 | Collection 可形成树形结构；同一父级下按 rank 排序；树不允许循环。 | OES / SDK |
| 2026-07-18 | Collection 页面是动态模板能力，不为每个 Collection 创建 SitePage 实例；SitePage 管理模板能力，Collection 管理自身发布与内容。 | SitePage / Storefront |
| 2026-07-18 | Collection 页面使用 `/product/collection/{collection-slug}`；URL 不包含完整父级路径，Breadcrumb 根据当前父级树生成。 | Storefront / SEO |
| 2026-07-18 | Collection 页面分支依据当前站点、locale 下有效的已发布子 Collection 数量判断；未发布或无效子 Collection 不参与判断。 | SDK / Storefront |
| 2026-07-18 | 有有效子 Collection 时，默认展示标题、描述、所有子 Collection 的图片卡片与链接，再展示聚合产品。具体卡片视觉由各站点 Storefront 决定。 | Storefront |
| 2026-07-18 | 无有效子 Collection 时，默认展示独立 Banner、标题、描述、筛选、排序、分页与产品列表。 | Storefront |
| 2026-07-18 | Collection 代表图与 Collection Banner 是两套独立素材，不互相替代。 | OES / Storefront |
| 2026-07-18 | 代表图使用带透明通道的 PNG，用于子 Collection 卡片、导航入口与推荐集合展示。 | OES / Storefront |
| 2026-07-18 | Banner 是独立的宽幅图片，用于无有效子 Collection 的页面首屏，不要求使用透明 PNG。 | OES / Storefront |
| 2026-07-18 | 所有正式发布的 Collection 必须有代表图；叶子 Collection 正式展示时必须有 Banner；父 Collection 的 Banner 可以提前维护，但不是当前子 Collection 布局的发布阻塞条件。 | OES |
| 2026-07-18 | 有子 Collection 但无直接产品的父 Collection 可以正式发布；没有产品且没有有效子 Collection 的叶子 Collection 不应正式发布或索引。 | OES / SEO |
| 2026-07-18 | 父 Collection 的聚合产品来自其有效子 Collection；产品去重。 | SDK / Storefront |
| 2026-07-18 | 父 Collection 尚未人工排序时，子 Collection 按 rank 排序，各子 Collection 内部产品按自身顺序，通过轮询方式合并；重复产品保留首次出现位置。 | SDK |
| 2026-07-18 | Storefront 使用显式分页，不使用加载更多或无限滚动作为正式方案；分页页面使用独立 URL，筛选和替代排序页面不参与索引。 | Storefront / SEO |
| 2026-07-18 | 筛选与排序是当前 Collection 页面的交互状态，不是新的 SitePage 或 Collection；长期 SEO 需求应建立正式 Collection。 | Storefront / SEO |
| 2026-07-18 | SDK 返回当前站点、locale 下有效的子 Collection、产品聚合结果、筛选结果和稳定分页结果；Storefront 负责最终视觉呈现。 | Runtime SDK / Storefront |
| 2026-07-19 | Collection 页面必须输出准确的 `BreadcrumbList`；`CollectionPage` 与 `ItemList` 只作为 Storefront 可选语义增强；Collection 列表页不输出 `Product` 标记，`Product` 结构化数据只属于产品详情页。 | Storefront / SEO |
| 2026-07-19 | Collection 资源级 SEO 内容与索引意图由 OES 管理并通过 Runtime SDK 发布；Storefront 根据真实域名、locale、公开路由和 OES 治理信号输出 title、description、robots、canonical、hreflang、Breadcrumb、结构化数据与 sitemap。canonical 不作为运营人员任意填写的内容。 | OES / Runtime SDK / Storefront |
| 2026-07-19 | Collection 名称、介绍、详细内容和 SEO 文案按站点 locale 独立管理与发布；正式公开页面不回退到其他语言文案，未完成的 locale 版本不公开、不进入 sitemap 或 hreflang。默认语言回退只允许用于 OES 管理端和预览。结构与图片可以复用，图片替代文本和相关说明按 locale 管理。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | Collection 保持统一内部身份，公开 slug 按站点 locale 独立管理；允许不同 locale 主动使用相同值，但不从默认语言自动回退。slug 正式发布后保持稳定，名称变化不自动改 slug；生产上线后的 slug 变更必须同步旧地址跳转、canonical、hreflang 与 sitemap。开发期已确认删除的错误历史路径不做兼容跳转。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | Collection 的 Banner 与代表图共用同一份 locale 级固定图片 alt；该语义随 Collection locale version 由 site-service 管理，不属于 asset-service 的通用资产默认 alt。Storefront 根据最终语境使用该 alt 或输出 `alt=""`，不提供页面级人工 alt 配置。 | OES / Runtime SDK / Storefront / Accessibility |
| 2026-07-19 | Collection 的社交分享图来源按 `OG Image`（若配置）→ `Banner` → `代表图` 回退；当前阶段直接使用所选原图，不做裁剪、合成或比例转换。后续可独立增加社交分享图优化处理。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | Draft Collection 可以不完整；正式发布需满足当前 locale 内容、唯一 slug、代表图、树无循环以及叶子 Banner/有效产品等质量条件。已发布叶子暂时无产品时停止索引，正式废弃时停止公开并返回 404；父级失去所有有效子 Collection 且自身无产品时按空叶子处理。SitePage 模板关闭只影响公开能力，不删除 Collection。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | `/product/collections` 作为可选的 Collection 根入口页，只展示受治理的 Collection 集合入口，不承担全部产品列表能力。OES 只提供一个扁平、有序的内容项列表，并校验正式发布所需的最低数量与内容完整性；Storefront 按内容项顺序套用既有固定布局规律，继续渲染后续内容，末尾不足完整布局组时使用普通卡片收尾。OES 不注册或配置具体前端布局，也不引入分区对象。 | OES / Runtime SDK / Storefront |
| 2026-07-19 | `/product/collections` 根入口页的媒体项采用统一的基础可用比例与质量约束；不同 Block 的最终展示比例、尺寸、裁切和响应式适配由 Storefront 既有设计决定。OES/后端只负责校验图片、视频及视频封面满足基本可用条件，不负责具体裁切或强制所有展示槽位使用同一比例。 | OES / Runtime SDK / Storefront |
| 2026-07-19 | 当前 `/product/collections` 只将 Collection 入口模块接入 OES；现有 Hero、服务卡片及其他非 Collection 营销模块继续由 Storefront 静态维护。它们未来是否进入 OES，待其业务能力与对象归属明确后另行设计，不混入 Collection 契约。 | OES / Storefront |
| 2026-07-19 | `/product/collections` 中的 Collection 入口项可以维护根入口页专用的独立图片或视频；该媒体只服务根入口页，不直接复用 Collection 代表图或 Banner，也不改变二者原有职责。媒体文件事实仍由资产能力管理，入口项的选择、顺序与发布归属由站点能力管理。 | OES / Asset Service / Runtime SDK / Storefront |
| 2026-07-19 | Collection 入口项必须关联一个 Collection；入口项点击链接由该 Collection 当前站点 locale 的正式 slug 自动生成，不允许入口项单独填写任意 URL。活动页、外部页面或其他非 Collection 目标不纳入当前 Collection 入口列表。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | Collection 入口项可以按站点 locale 独立维护根入口页使用的 Title、Description 与链接文案；链接文案可以修改，但链接目标仍固定为关联 Collection 的正式页面。入口项文案不替代或覆盖 Collection 自身名称、描述与资源级 SEO 内容。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | 已发布的 `/product/collections` 入口列表仍引用某个 Collection 时，该 Collection 不允许直接停用或下架；运营必须先删除或替换入口并完成同步，再下架 Collection。Draft 入口可以不完整，但正式发布入口只能引用当前站点 locale 下有效且已发布的 Collection，避免 Runtime 出现失效链接。 | OES / Runtime SDK / Storefront / SEO |
| 2026-07-19 | 当前 Storefront 版本的 `/product/collections` 使用 15 个 Collection 入口位置，OES 当前实施基线要求正式发布至少有 15 个有效入口；该数量不是所有站点或未来布局的永久规则。后续 Storefront 布局调整时，必须同步更新位置映射与最低数量约束，并通过同一集成变更验证。 | OES / Runtime SDK / Storefront |

## 4. OES、SDK、Storefront 边界

| 能力 | OES | Runtime SDK | Storefront |
| --- | --- | --- | --- |
| Collection 层级与 rank | 管理与发布 | 返回有效树关系 | 决定视觉布局与交互 |
| Collection 发布状态 | 真相与治理 | 提供有效公开结果 | 执行公开路由 |
| 代表图与 Banner | 管理素材职责与发布条件 | 返回对应素材 | 决定图片组件、比例、背景与响应式表现 |
| 子 Collection 卡片 | 不管理视觉组件 | 返回有效子 Collection | 决定卡片样式、布局、间距与断点 |
| 产品聚合 | 管理公开关系与发布结果 | 去重、轮询、分页并返回结果 | 展示产品列表 |
| 筛选与排序 | 提供受治理的数据范围 | 计算当前范围内有效结果 | 提供交互控件与 URL 状态 |
| SEO 输出 | 提供资源级治理信号 | 提供公开页面数据 | 输出 canonical、robots、sitemap、Breadcrumb 与最终 HTML |

## 5. 开放问题

| 日期 | 问题 | 状态 |
| --- | --- | --- |
| 2026-07-18 | Product 主数据与 Site Product 的最终关系。 | 后置，暂不讨论。 |
| 2026-07-18 | 父 Collection 是否允许直接拥有不属于任何子 Collection 的产品，以及这类产品如何进入自动轮询队列。 | 待 Product 关系设计后处理。 |
| 2026-07-18 | Collection 社交分享图片选择与缺失 Banner 时的回退规则。 | 进入下一轮 Collection SEO 讨论。 |
| 2026-07-19 | 社交分享原图的比例适配、裁剪、合成与派生图优化。 | 后置，当前直接使用原图。 |
| 2026-07-19 | 根 Collection 集合入口页及其与产品总列表页的区别。 | 已确认：使用 `/product/collections` 作为可选 Collection 根入口，不提供全部产品列表页；内容以扁平有序列表提供，分区与布局由 Storefront 现有实现决定。 |
| 2026-07-19 | 根入口页非 Collection 营销模块是否由 OES 管理。 | 后置：当前保持 Storefront 静态实现，待其能力归属明确后另行设计。 |
| 2026-07-18 | SDK 黑盒契约、发布视图和具体资源结构。 | 设计冻结后另行形成 contracts。 |

## 6. 真相源回写计划

- 服务职责：`docs/architecture/services/site-service.md`
- Runtime 协同：`docs/architecture/platforms/site-runtime-architecture.md`
- Runtime SDK：`docs/architecture/platforms/site-runtime-kit.md`
- 黑盒契约：`docs/contracts/site-service/**`
- 延期事项：`docs/plans/backlog.md`

## 7. 恢复入口

- 下次继续前先读本文“已确认决定”和“开放问题”。
- Product 主数据与 Site Product 关系不属于本文当前讨论范围。
- 当前推荐下一步：继续完成 Collection SEO 内容与结构化数据设计，然后回写稳定真相源。

## 8. 当前分支收口

- 2026-07-19：Collection 根入口页的当前 Storefront 基线已确认，使用扁平有序入口列表、15 个 Collection 位置、入口项独立媒体与文案、Collection 固定链接目标。
- 15 个位置与现有 Storefront 组件的具体映射属于实现对接事项，不再在本设计分支中继续扩展；后续前端布局变化通过集成变更同步调整位置映射与最低数量约束。
- 本分支暂时收口，总控线程应返回站点整体业务能力拆分，不应继续把 Collection 入口实现细节当作新的设计分支。
