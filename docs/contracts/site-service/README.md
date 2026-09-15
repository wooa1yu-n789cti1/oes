# site-service Contracts

```text
contractStatus: FROZEN_FOR_P1_IMPLEMENTATION
serviceTruthSource: docs/architecture/services/site-service.md
runtimeKitTruthSource: docs/architecture/platforms/site-runtime-kit.md
lastUpdatedAt: 2026-07-25
```

## 1. 目的

本目录用于冻结 External Site Integration P1 的黑盒契约。

`site-service` 的唯一稳定服务设计真相源是 [site-service.md](../../architecture/services/site-service.md)。`@oes/site-runtime-kit` 的 P1 架构真相源是 [site-runtime-kit.md](../../architecture/platforms/site-runtime-kit.md)。本目录只描述调用方可依赖的请求、响应、错误语义与安全边界，不重新定义服务职责、核心对象或长期边界。

这些文档面向：

- `api-gateway` Admin BFF
- `api-gateway` Site-facing BFF / Site API
- `site-service`
- `@oes/site-runtime-kit`
- Site Runtime backend
- future contract tests

## 2. P1 契约模块

- [security-and-signing.md](./security-and-signing.md)
  - `OES_SITE_CREDENTIAL`、HMAC signed request、webhook signing、scope 与错误语义。
- [sync-api.md](./sync-api.md)
  - Site Runtime 拉取 latest state、changed resources、public views、snapshot 的 Site-facing API。
- [public-views.md](./public-views.md)
  - `ProductPublicView`、`CategoryPublicView`、`ArticlePublicView`、`ArticleCategoryPublicView`、`FaqDirectoryPublicView`、`InspirationItemPublicView`、`InspirationCategoryPublicView` 的稳定数据契约，以及对应 Runtime 本地读取语义。
- [preview-and-runtime-status.md](./preview-and-runtime-status.md)
  - preview token / draft preview view 与 Site Runtime status 契约。
- [page-capabilities-and-exposure.md](./page-capabilities-and-exposure.md)
  - Storefront 页面能力注册、SitePage 页面治理、站点 locale 公开状态、capability drift 与 Runtime 本地公开状态契约。
- [admin-bff.md](./admin-bff.md)
  - OES Admin 的 Site Management P1 最小 BFF 契约。

## 3. 全局调用约束

### 3.0 Site Ownership Boundary

本目录所有契约都继承 [site-service.md](../../architecture/services/site-service.md) 的稳定边界：

- OES 不提供 page builder、任意组件 CMS、主导航、Footer、前台 Logo 使用或 Storefront 视觉 contract。
- OES `site_name` 只用于 Admin 识别、检索、审计，不作为 Header、SEO fallback 或 JSON-LD fallback。
- OES 只管理 OES-owned resources 的 SEO、indexability、published public views 与 dynamic historical slug redirect eligibility。
- Storefront 输出 `robots.txt` / `sitemap.xml`，并拥有静态 canonical pages、静态 redirects、营销 redirects、domain redirects 与 locale redirects。
- Preview 是 draft-only read path，必须 `noindex`、`nofollow`、`no-store`，不得写正式 store、推进 publishVersion 或触发 webhook。

### 3.1 Admin 调用

OES Admin 只能通过 `api-gateway` Admin BFF 使用站点管理能力。

Admin BFF 调用要求：

- authenticated operator context
- tenant context
- permission context
- trace context
- audit context for commands

### 3.2 Site Runtime 调用

Site Runtime 只能通过 `@oes/site-runtime-kit` 调用 OES Site-facing BFF / Site API。

Site-facing API 调用要求：

- `OES_SITE_CREDENTIAL`
- HMAC signed request
- timestamp
- nonce
- credential id
- site id
- client id
- trace id
- request id

Site Runtime 不得直接调用 OES Core 内部 API，不得直接调用 `site-service` 内部接口。

### 3.3 Storefront Frontend 调用

Storefront Frontend 不得：

- 持有 `OES_SITE_CREDENTIAL`
- 持有 client secret 或 webhook signing secret
- 直接调用 OES Core API
- 直接调用 OES Site-facing API
- 直接读取 Site Runtime 本地数据库

Storefront Frontend 应通过 Site Runtime 的 SSR / API 路径读取本地 published data。

## 4. P1 状态

本目录当前是 `FROZEN_FOR_P1_IMPLEMENTATION`。

Article taxonomy 已演进为 `articleType + category + tags`；它的稳定字段与 Runtime local filter contract 以 [public-views.md](./public-views.md) 和 [site-service.md](../../architecture/services/site-service.md) 为准。现有 Blog / News / Content Category P1 contract 只作为兼容与迁移基线。

已冻结：

- 与 `site-runtime-kit.md` 对齐
- 与 `site-service.md` 对齐
- 与 `site-runtime-architecture.md` 和 `site-runtime-kit.md` 对齐
- Blog / News + Content Category SEO Archive P1 的稳定语义以本目录及 ADR 0009/0011 为准。

实现前仍需要在 implementation plan 中决定：

- `@oes/site-runtime-kit` 的包路径。
- `site-service` 的源码服务路径与持久化实现计划。
- contract tests 的具体落点。

contracts 已冻结后，允许分别编写 `@oes/site-runtime-kit` 与 `site-service` 的实现计划；生产代码实现仍需等待对应 implementation plan 批准。
