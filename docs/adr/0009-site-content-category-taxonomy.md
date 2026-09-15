# ADR 0009: Site Content Category Taxonomy

## Status

Accepted — 2026-07-17; content-type scope simplified 2026-07-25; legacy redirect subsection superseded by [ADR 0011](./0011-site-dynamic-slug-reservation-and-history.md)

## Context

The first Site Runtime implementation named the editorial taxonomy `Topic`. The same records actually own the public category archive, localized archive introduction, category SEO, ordering and historical slug behavior. The name conflicts with the Storefront’s established `/blogs/category/:slug` routes and makes the distinction from lightweight article Tags unclear.

Existing published content can reference more than one of these records. That relationship is already used by the Storefront: a card shows its primary category in a general archive, while a category archive shows the category selected by the route.

## Decision

- Replace all Site Runtime `Topic` objects, fields, public view resource types, Runtime readers, APIs and Admin labels with `Content Category`.
- Use `article-category` as the public-view resource type. This prevents a collision with the existing product `category` resource type while keeping the public Storefront term simply “Category”.
- A Site Content Category is site-scoped and has stable `categoryId` and `sortOrder`. It does not duplicate Blog / News applicability or manual archive visibility.
- `sortOrder` is the single site-level Category order. Blog and News each filter the Categories eligible for that content type and locale, then preserve this shared relative order; there are no separate Blog and News order fields.
- Each Article owns exactly one `contentType = blog / news`; its ordered `categoryIds[]` relationship determines Category membership inside that content type. The same Category can be referenced by either or both types without a separate `appliesTo` gate.
- Each locale version owns its own `slug`, `displayName`, `archiveIntro`, `archiveLabel`, SEO title, SEO description, SEO image and historical slugs. `archiveIntro` is the visible archive introduction; SEO description is independently editable and falls back to the intro only when absent.
- Locale publication requires only a non-empty `displayName` and a canonical `slug` accepted by the slug ledger. Archive intro/label and SEO title/description/image are optional, with deterministic fallbacks to display name, archive intro and the Storefront global OG policy; omissions may warn but do not block publication.
- Each Category locale keeps a draft revision and, after first publication, a last published revision. Publishing approves new or changed metadata; P1 deliberately has no Category unpublish, disable or manual archive-visibility state. Draft changes never replace the last published revision and locale fallback is forbidden.
- Public archive eligibility is derived: a last published Category revision appears for a content type and locale only while at least one matching published Article references it. Removing the final published relationship naturally removes the archive; removing a relationship only in an Article draft has no public effect until that replacement revision is published.
- A Category locale may publish its metadata before any Article uses it. This makes it selectable for same-locale Article authoring but does not expose an empty archive; Article publication in turn requires every referenced Category to have a same-locale last published revision, avoiding a circular first-publication dependency.
- Articles reference stable Category identities. Publishing Category metadata, order or slug changes does not republish unchanged Articles; only an Article membership change creates an Article replacement revision. Site publication remains atomic, so Runtime never combines a new Category/alias with old Article membership or vice versa.
- Admin deletion is allowed only after every draft and published Article reference is removed. Never-published Categories are hard-deleted with their draft-only slug reservation; previously published Categories are removed from normal authoring and public output while retaining the minimal identity, permanent slug-ownership tombstone and audit required by ADR 0011.
- P1 does not compose a draft Article Category archive preview. Blog / News detail preview remains available; template, URL and SEO verification for Category archives uses an independently configured test Site publication rather than production data or a Category-specific preview protocol.
- Blog and News locale versions retain an ordered `categoryIds[]` relation. The first item is the primary category for generic card presentation; all referenced categories retain their own SEO archive membership. A category archive card always shows the archive category instead of the primary category.
- Tags remain separate, lightweight article metadata. They never become a `article-category` public view or default sitemap archive.
- Legacy `/blogs/topic/:slug` and `/news/topic/:slug` paths were an early migration proposal. The current routing truth is defined by ADR 0011 and `site-service.md`: retired Topic / singular Category namespaces are terminal 404 and are not historical slug aliases. New Runtime and Storefront APIs must not expose `topic` names.
- A locale-specific Content Category archive is indexable only when the category and at least one matching published content item exist in that locale. Missing locale versions must not silently publish English copy under a localized canonical URL.
- The Category does not carry per-Blog / per-News visibility switches. Its locale last published revision plus matching published Article references determines archive eligibility; Storefront still owns final navigation placement and presentation.

## Consequences

- The migration changes Site Service gRPC names, Admin BFF paths, public-view payload keys, SQLite resource types, Runtime readers, seed data, Storefront server routes and automated checks.
- The target model removes legacy `appliesTo / applies_to` and Blog / News archive visibility flags from Category storage and contracts; Admin shows actual published Blog / News usage counts instead of manually maintained applicability or visibility values.
- The database migration renames the Content Topic tables and `topicIds` column while preserving every relationship and deterministic primary-category order.
- Product categories remain unchanged. No product `CategoryPublicView` field, product category tree or product URL is repurposed for editorial content.
- `CollectionPage`, meta, OG, Twitter and JSON-LD descriptions must consume the localized Content Category SEO data consistently.

## Alternatives Considered

### Keep `Topic` and only change the UI copy

Rejected because it leaves contradictory public API, database, Runtime and SEO terminology, and it does not give the localized archive introduction an explicit semantic home.

### Reuse product `CategoryPublicView`

Rejected because product catalog taxonomy and editorial archive taxonomy have different ownership, visibility, locale and SEO rules.

### Collapse every existing multi-category relation to one category

Rejected because it would silently remove existing archive membership. Ordered `categoryIds[]` preserves current publishing behavior while keeping Tags separate.

## Related Documents

- [site-service.md](../architecture/services/site-service.md)
- [site-runtime-kit.md](../architecture/platforms/site-runtime-kit.md)
- [public-views.md](../contracts/site-service/public-views.md)
- [OES Backlog](../plans/backlog.md)
