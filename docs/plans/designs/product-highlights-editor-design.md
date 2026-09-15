# Product Highlights Editor Design

## 0. 文档控制

```text
designKey: product-highlights-editor
designStatus: ACTIVE_DESIGN_WORKSPACE
implementationStatus: IDEA_ONLY
lastUpdatedAt: 2026-07-06 18:00:06 CST
lastUpdatedBy: Codex storefront PDP thread
supersedes: 当前 PDP 讨论中关于 Product Highlights / rich text / drag editor 的口头结论
truthSource:
conflictResolution: 当本文与更早讨论冲突时，以本文 lastUpdatedAt 之后的冻结结论为准；稳定 architecture / ADR / contracts 明确覆盖本文时，以稳定真相源为准。
```

## 1. 目标

- 为产品详情页 `Product Highlights` 折叠项确定 OES 配置端的最佳编辑方案。
- 为后续新线程实现 OES 产品配置端编辑能力提供恢复入口。
- 当前线程只负责 storefront PDP mock，不实现 OES 管理端编辑器。

## 2. 已确认方向

- `Product Description` 保持纯文本，用于产品 overview、SEO 基础描述与适用场景说明。
- `Product Highlights` 作为独立折叠项，用于展示细节图片、图片卖点、包含配件与可视化说明。
- 不采用完全自由的富文本页面排版。
- 不在第一版引入完整拖拽页面搭建器。
- 采用 `结构化 block builder + 字段级富文本 + 简单排序拖拽`。

## 3. 推荐方案

OES 产品配置端应提供一个 `Highlight Block Builder`：

- 用户可以新增、删除、启用、停用、排序 highlight block。
- 用户先选择固定 block 类型，再填写受约束字段。
- block 内的长文案字段可以使用富文本能力，但富文本不控制整体版式。
- block 与 block 之间可以拖拽排序。
- block 内部 items 可以拖拽排序。
- PDP 前端只根据结构化 schema 渲染高级模板，不接受任意 HTML 布局。

## 4. 第一版 Block 类型

### 4.1 Feature Story

用于主卖点讲述。

```ts
type FeatureStoryHighlightBlock = {
  type: 'feature_story'
  title: string
  body: RichText
  media: MediaAsset
  features: Array<{
    title: string
    body: string
    icon?: string
  }>
}
```

约束：

- `media` 必填，且只能选择 1 个主媒体。
- `features` 建议 2-3 个，最多 4 个。
- `body` 可以使用字段级富文本，但不允许插入任意布局容器。

### 4.2 Detail Grid

用于展示细节图片与短卖点。

```ts
type DetailGridHighlightBlock = {
  type: 'detail_grid'
  title?: string
  items: Array<{
    title: string
    body: RichText
    media: MediaAsset
  }>
}
```

约束：

- `items` 最少 2 个，最多 4 个。
- 每个 item 必须有标题、正文和媒体。
- 不支持用户自定义列数，由前端响应式模板决定。

### 4.3 Included Items

用于说明产品包含物。

```ts
type IncludedItemsHighlightBlock = {
  type: 'included_items'
  title: string
  items: Array<{
    label: string
    note?: string
    icon?: string
    media?: MediaAsset
  }>
}
```

约束：

- `items` 最少 2 个，最多 8 个。
- `icon` 与 `media` 二选一或都不填，前端提供默认图标样式。
- 不用于替代 `Resources Download` 或 `Detail Spec`。

## 5. 不采用的方案

### 5.1 纯富文本编辑器

不推荐作为 `Product Highlights` 的整体编辑方式。

原因：

- 用户容易破坏排版和响应式效果。
- 图片、文案、配件清单会混成 HTML，后续难以维护。
- 打印页、移动端、SEO 结构化与多产品复用都会变复杂。
- 无法稳定复刻高端 PDP 的图文节奏。

### 5.2 完整拖拽页面搭建器

不推荐第一版引入 Craft.js / GrapesJS 一类完整 page builder。

原因：

- 能力重，接入成本高。
- 会引入组件注册、权限、schema 迁移、响应式约束、版本治理和发布校验等问题。
- `Product Highlights` 只是 PDP 内的一个折叠内容区，不应演变成页面搭建器。

## 6. 编辑器选型建议

如果 OES 后续需要新增富文本能力，推荐优先考虑 `Tiptap`：

- 适合结构化内容与字段级富文本。
- 支持自定义扩展与内容约束。
- 比完整 page builder 更容易控制输出 schema。

使用边界：

- Tiptap 只负责 `body`、`note` 等字段级富文本。
- 不允许用户通过 Tiptap 插入任意栅格、任意图片布局、任意颜色字体。
- 媒体、items、block 类型、排序、启用状态由 OES 表单 schema 管理。

## 7. Storefront Mock 决定

当前 storefront PDP 先 mock 一个 `Product Highlights` accordion：

- 放在 `Product Description` 与 `Detail Spec` 之间。
- 默认展开，便于设计验证。
- 展示 1 个主细节图、2 个辅助图、右侧短文案、3 个 feature notes 与 `What's included` 清单。
- mock 不代表最终 OES 数据结构已实现。

## 8. 后续新线程入口

后续推进 OES 配置端时，应先确认 Delivery 决策卡：

- 配置端 schema 与 validation。
- 媒体选择能力。
- 字段级富文本编辑能力。
- block 排序与 item 排序。
- storefront 数据契约。
- 预览能力与发布校验。

开放问题：

- OES 管理端前端技术栈与现有表单体系。
- MediaAsset 的统一来源与权限边界。
- 富文本存储格式使用 HTML、JSON AST 还是 portable text 风格结构。
- highlights 是否需要参与打印页。
