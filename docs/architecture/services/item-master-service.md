# item-master-service 职责卡

## 1. Purpose

`item-master-service` 是 OES 的物料主数据真相服务，负责维护可被采购、销售、库存、生产、包装、BOM 与供应商映射稳定引用的 `ItemModel`、`Item`、attribute、BOM、包装规格、轻量分类与供应商物料标识映射。

本文件是 `item-master-service` 的唯一稳定设计真相源。其他服务文档可以引用本文定义的概念与边界，但不得自行创建或改写 `ItemModel`、`Item`、BOM、Packaging、capability 或 `SupplierItemMapping` 的主语义。

本文不展开 proto、数据库表结构、运行时代码或 UI 设计；contract 与代码改造应在本文冻结后进入 `CONTRACT-V2` 与后续迁移阶段。

## 2. Canonical Concepts

- `ItemModel`
- `Item`
- `AttributeDefinition`
- `AttributeOption`
- `ItemModelAttributeRule`
- `Item.capabilities`
- `BOM`
- `BOMLine`
- `PackagingMethod`
- `PackagingSpec`
- `ItemCategory`
- `SupplierItemMapping`

已废弃主语义：

- `ProductModel`
- `ItemComposition`
- `structureType = SINGLE | BUNDLE`
- `natureType = PHYSICAL | VIRTUAL | SERVICE`
- `StockItemType`

`ProductModel` 不再作为别名使用；模型层对象统一称为 `ItemModel`。

## 3. Owns

- `ItemModel` 的基础身份、类型、生命周期与模型级 capability 默认规则。
- `Item` 的基础身份、生命周期、locked attributes、包装规格引用与执行层 capability 真相。
- attribute 简版主数据：
  - `AttributeDefinition`
  - `AttributeOption`
  - `ItemModelAttributeRule`
- BOM 主数据：
  - `COMPOSITION_BOM`
  - `TRANSFORMATION_BOM`
  - `PACKAGING_BOM`
- 包装主数据：
  - `PackagingMethod`
  - `PackagingSpec`
- `ItemCategory` 轻量分类树。
- `SupplierItemMapping`，只表达供应商侧编码 / 名称如何映射到 OES 执行层 `Item`。

## 4. Does Not Own

- 销售报价、销售订单、销售配置、销售价格、客户承诺与客户侧 item snapshot 真相。
- 采购申请、采购订单、采购价格、MOQ、lead time、采购收货与采购履约真相；`PaymentTerm` 主数据归 `finance-service`，采购交易只保存 payment term snapshot。
- `srm-service` 的 `SupplierProfile`、`SupplierOffering`、联系人、关系治理与供应商状态真相。
- `mes-service` 的 `ProductionSpec`、`ProductionUnit`、Route、Operation、WorkCenter、工序执行、质量结果、资源使用与生产事实。
- `wms-service` 的 `InventoryUnit`、`InventoryLot`、`InventoryBalance`、`PackageUnit`、`InventoryGenealogy`、库位、库存状态、占用、收货、出库与仓储执行事实。
- `crm-service` 的商机、询盘、客户产品兴趣与客户关系真相。
- `PIM / PLM`、营销展示、网站发布、图纸工程、研发流程与完整产品生命周期管理真相。

说明：

- `PackagingSpec`、`PackagingMethod` 与 `PACKAGING_BOM` 属于 `item-master-service`，不再被归入 `PIM / PLM` deferred 范围。
- `SupplierItemMapping` 不是 `SupplierOffering`，也不是采购商业档案。
- 所有正式库存都是 `Item` 的库存；`StockItemType` 不再作为新 architecture truth。

## 5. ItemModel

`ItemModel` 是唯一模型层对象，可理解为可配置物料模型、款式模型、规格族、SPU 或 template。

冻结规则：

- 所有 `Item` 必须关联一个 `ItemModel`。
- 一次性物料、简单采购件、无规格族管理的物料，也应创建轻量 `ItemModel` 后再创建 `Item`。
- `ItemModel` 是全局主数据入口，不是单纯销售对象。
- 凡是需要长期维护规格族、款式族、可配置族或基础物料族的对象，都应使用 `ItemModel`。
- `ItemModel` 不参与采购、销售、库存、生产、BOM、包装执行的最终落地；执行最终落到 `Item`。
- `ItemModel.capabilities` 表达模型级允许范围和默认值，不是执行真相。

`ItemModel.modelKind` 表达本质类型：

```text
PHYSICAL
SERVICE
DIGITAL
VIRTUAL
```

`ItemModel.modelType` 表达业务分类：

```text
FINISHED_PRODUCT
SEMI_FINISHED_PRODUCT
ACCESSORY
PART
SUB_ASSEMBLY
RAW_MATERIAL
PACKAGING_MATERIAL
SERVICE
VIRTUAL_KIT
```

类型使用规则：

- 连体马桶、智能马桶、浴缸、洗手盆等实体产品：`modelKind = PHYSICAL`。
- 纸箱、泡沫、蜂窝板、标签、说明书等长期库存化管理的包材或随箱物料：`modelKind = PHYSICAL`，`modelType = PACKAGING_MATERIAL` 或更合适的业务类型。
- 安装到产品功能结构上的零件或组件：`modelType = PART`、`SUB_ASSEMBLY` 或 `ACCESSORY`，具体关系由 `COMPOSITION_BOM` 表达。
- 服务：`modelKind = SERVICE`，通常不具备 `stockable`、`manufacturable`、`packable` 或 `packaged` 执行能力。
- 虚拟套装 / kit：第一阶段只记录为后置能力，不进入核心执行模型。

## 6. Item

`Item` 是固定属性后的具体 SKU / 可执行物料身份 / variant。

冻结规则：

- `Item = ItemModel + locked AttributeOption combination + optional PackagingSpec`。
- `Item.modelId` 必填。
- `Item` 是采购、销售、库存、生产投产、生产交仓、BOM 消耗与产出、包装成品、成本核算的执行层对象。
- 所有采购、销售、库存、生产、BOM 与包装执行最终以 `Item.active` 和 `Item.capabilities` 为准。
- `Item` 本身不 nested；组成、装配、转换、包装消耗关系通过 BOM 表达。
- `Item` 不自动穷举生成，可按需手动创建、批量创建或由配置流程创建。
- 同一个 `ItemModel + lockedAttributes + optional packagingSpecId` 必须唯一。

`Item` 不使用旧的 `structureType / natureType` 作为核心字段或执行判定依据。服务、实物、虚拟、数字等类型由 `ItemModel.modelKind / modelType` 表达；执行准入由 `Item.capabilities` 表达。

## 7. Item Capabilities

`capabilities` 同时存在于 `ItemModel` 和 `Item`，但语义不同：

- `ItemModel.capabilities`：模型级允许范围和默认值。
- `Item.capabilities`：执行真相。

第一阶段冻结 `Item.capabilities`：

| Capability | 执行规则 |
| --- | --- |
| `sellable` | 可在报价、销售订单、销售配置结果中作为销售执行 Item。 |
| `purchasable` | 可在采购申请、采购订单中作为采购执行 Item。 |
| `stockable` | 可被 WMS 创建 `InventoryUnit`，可进入 `InventoryBalance`。 |
| `manufacturable` | 可作为 MES `ProductionSpec / WorkOrder` 的目标 Item。 |
| `assemblable` | 可作为 `COMPOSITION_BOM` 的输出 Item。 |
| `transformable` | 可作为 `TRANSFORMATION_BOM` 的输出 Item。 |
| `packable` | 可作为 `PACKAGING_BOM` 的基础输入 Item。 |
| `packaged` | 表示该 Item 是包装成品，即 `Item(type = PACKAGED_FINISHED_GOOD)`。 |

Deferred capabilities：

- `traceable`
- `kittable`
- `consumable`

说明：

- Deferred capability 是已识别候选能力，但第一阶段不进入执行真相。
- BOM line 第一阶段默认允许引用 active Item，不使用 `consumable` 限制。
- `manufacturable` 的设置必须受治理约束，避免服务、数字物、明显不可生产对象被误设为可制造；MES 准入仍只消费 `active + manufacturable Item`。

## 8. Active / Archive

第一阶段使用简单 active/archive 规则：

- `ItemModel.active = false` 表示该模型归档，不再用于新建业务。
- `Item.active = false` 表示该 SKU / 执行物料身份归档，不再用于新建业务。
- 归档不删除历史，不影响已有订单、库存历史、生产历史、采购历史或审计记录。
- 停用 `ItemModel` 不自动停用其下所有 `Item`；是否停用由业务操作显式决定。

所有执行入口至少校验：

```text
Item.active = true
+ required capability = true
```

## 9. Attribute

Attribute 是 `ItemModel` 允许的规格维度；`AttributeOption` 是该规格维度下的可选值；`Item` 通过锁定一组 `AttributeOption`，形成稳定的执行层物料身份。

第一阶段冻结 attribute 简版：

| 对象 | 定义 |
| --- | --- |
| `AttributeDefinition` | 属性定义，例如颜色、尺寸、孔位、坑距、溢水孔、材质、表面处理、密度、长度。 |
| `AttributeOption` | 枚举属性值，例如白色、600mm、无孔、单孔、有溢水孔、无溢水孔、centerset、widespread。 |
| `ItemModelAttributeRule` | 某个 `ItemModel` 允许哪些 Attribute / AttributeOption。 |

冻结规则：

- Attribute 只用于表达物料本体或规格识别属性，即“这个物料本身是什么规格”。
- Attribute 用于把同一 `ItemModel` 下的规格变化收敛为具体 `Item`，不用于表达过程结果、销售策略、库存状态或营销展示语义。
- 同一产品族内的尺寸、孔位、溢水孔、颜色、材质、表面处理等可作为 Attribute；即使不同尺寸对应不同模具，也不妨碍尺寸作为同一 `ItemModel` 下的规格维度，具体生产约束由 `ProductionSpec / MoldDesign / BOM / Route` 等执行设计承接。
- 如果某个差异已经代表不同产品族、不同长期设计模型、不同生命周期或不同主分类，应拆分为不同 `ItemModel`，而不是强行作为 Attribute。
- 生产后、质检后或入库后产生的质量等级、瑕疵、返修状态、库存冻结、占用、库位、批次等不属于 Attribute，应分别归 MES / WMS / Sales 履约策略对象。
- 官网、站点或营销侧可见的热销、新品、推荐、适用场景、卖点标签等不属于 Attribute；是否公开展示某个 Attribute 由 Sales / PIM / Site 展示策略决定。
- 包装方式、客户包装、随箱配件、客户说明书、客户标签等不塞进 attribute。
- 包装泡沫密度如果是包装规格的一部分，属于 `PackagingSpec / PACKAGING_BOM` 语义。
- 如果泡沫密度是泡沫材料自身规格，属于泡沫这个 `ItemModel / Item` 的 attribute。
- 第一阶段不引入复杂 `AttributeCombinationRule`。

## 10. BOM

`BOM` 统一表达 `Item` 与 `Item` 之间的输入、输出、组成、转换与消耗关系。

冻结规则：

- 当前阶段不采用模型层 composition 对象。
- `ItemComposition` 不再作为主模型；历史 `ItemComposition` 应迁移到 BOM。
- 所有实际组成、半成品、配件包、包装、后加工转换、拆解关系优先通过 BOM 或 BOM 相关规则表达。
- BOM 主数据归属 `item-master-service` / BOM 子域。
- BOM 类型必须表达执行语义，不只是 UI 标签。
- BOM 不等于工序。工序、人员、WorkCenter、质量结果由 MES 或 WMS 的任务执行对象记录。

第一阶段 BOM 类型：

| 类型 | 语义 | 例子 |
| --- | --- | --- |
| `COMPOSITION_BOM` | 功能组成 / 装配 / 实体 Item 构建。 | 空瓷 + 水件 -> 安装水件半成品；陶瓷体 + 智能盖板 + 电控模块 -> 智能马桶基础成品。 |
| `TRANSFORMATION_BOM` | 经过工序把输入转成输出。 | 无孔洗手盆 -> 单孔洗手盆；无 logo 产品 -> 有 logo 产品；返修；泥浆 / 釉料配制。 |
| `PACKAGING_BOM` | 包装执行消耗。 | 产品 + 纸箱 + 泡沫 + 说明书 + 随箱配件。 |

基础规则：

- `outputItemId` 必须指向 active Item。
- `componentItemId` 必须指向 active Item。
- 必须禁止 BOM 循环，包括直接循环和多层循环。
- 第一阶段不使用 `consumable` capability 限制 BOM line。

Deferred：

- 虚拟套装 / kit 销售展开。
- 复杂替代料。
- 可选 BOM 行。

## 11. Packaging

包装主数据归属 `item-master-service`。

冻结对象：

- `PackagingMethod`
- `PackagingSpec`
- `BOM(type = PACKAGING_BOM)`

`PackagingMethod` 表示包装方式分类，例如普通包装、加强包装、电商包装。它是轻量可维护字典，不建议写死成 enum。

`PackagingMethod` 支持受保护硬删除：只有未被任何 `PackagingSpec` 引用的包装方式可以物理删除；一旦被包装规格引用，历史语义必须保留，只能停用。

`PackagingSpec` 是具体包装规格：

```text
PackagingSpec =
  ItemModel
  + PackagingMethod
  + optional Customer
```

`PackagingSpec` 记录：

- 包装规格说明。
- 外箱尺寸。
- 毛重。
- 体积。
- 简单作业要求，例如标签位置、封箱方式、包装备注。
- 状态、版本、生效期。

具体纸箱、泡沫、蜂窝板、说明书、标签、随箱配件等消耗不直接塞进 `PackagingSpec`，而是通过 `PACKAGING_BOM` 表达。

客户长期专属包装应创建 customer-specific `PackagingSpec`。一次性临时客户包装要求可以留在 sales transaction snapshot 中，不强制沉淀为长期包装主数据。

## 12. PackagedItem

`PackagedItem` 不是独立对象。

冻结规则：

```text
PackagedItem = Item(type = PACKAGED_FINISHED_GOOD)
```

包装成品 Item 必须满足：

- `packagingSpecId != null`
- `Item.capabilities.packaged = true`

不冻结 `baseItemId` 字段。包装成品的输入来源、消耗和组成统一由 `PACKAGING_BOM` 表达。

单品包装示例：

```text
output: MA3124 300坑距 白色 普通包装成品
inputs:
  MA3124 300坑距 白色 基础成品 x1
  MA3124 普通纸箱 x1
  MA3124 普通泡沫 x1
  MA3124 说明书 x1
```

多品合并包装示例：

```text
output: P100 洗手盆 + 立柱 合并包装成品
inputs:
  P100 洗手盆 白色 单孔 x1
  P100 立柱 白色 x1
  P100 合并纸箱 x1
  P100 合并泡沫 x1
  说明书 x1
```

## 13. ItemCategory

`ItemCategory` 属于 `item-master-service`，是第一阶段应优先实现的基础信息。

冻结规则：

- `ItemCategory` 是 tenant-scoped 轻量分类树。
- `ItemCategory` 用于分类、浏览、搜索收窄、列表展示与基础统计分组。
- `ItemCategory` 不承载权限、定价、采购策略、库存策略、包装策略或制造策略。
- 第一阶段主挂 `ItemModel`，即 `ItemModel.primaryCategoryId`。
- `Item` 通过所属 `ItemModel` 获得分类上下文。
- 是否支持 `Item` 级 override / secondary category 后置。

## 14. SupplierItemMapping

`SupplierItemMapping` 归属 `item-master-service`。

冻结规则：

- `SupplierItemMapping` 只表达：

```text
supplierId + supplierItemCode / supplierItemName -> itemId
```

- `itemId` 必须指向执行层 `Item`，不映射到 `ItemModel`。
- `SupplierItemMapping` 不承载价格、MOQ、payment term snapshot、lead time、供应表现或供应商合作状态。
- `SupplierItemMapping` 不是 `SupplierOffering`。
- `SupplierOffering` 归 `srm-service`，表达“某供应商可供应某个 Item”的关系事实。

## 15. Cross-Service Adoption

### 15.1 Sales

- `sales-service` 可以从 `ItemModel + AttributeOption + optional PackagingSpec` 解析到 active + sellable `Item`。
- `SalesOrderLine` 最终必须引用稳定 `itemId`，并保存销售交易所需 snapshot。
- 客户自己的 SKU、型号、标签显示名、出口显示语义不进入 `item-master-service`，应留在 sales snapshot 或后续 Sales / CRM customer item 设计中。
- 一次性临时包装要求可以留在 sales snapshot；长期包装配置应沉淀为 `PackagingSpec` 与必要的 PackagedItem。

### 15.2 Procurement

- 标准采购最终引用 active + purchasable `Item`。
- Procurement 可以从 `ItemModel + AttributeOption` 解析到 purchasable `Item`，也可以直接选择 `Item`。
- 非标准 / 文本型采购需求可以留在 procurement 自身单据中，不强制进入 item-master。
- 采购价格、MOQ、lead time、RFQ、PO、收货与采购履约不归 `item-master-service`；`PaymentTerm` 主数据归 `finance-service`。

### 15.3 MES

- `ProductionSpec.targetItemId` 引用 active + manufacturable `Item`。
- `ProductionUnit.currentItemId` 表达生产实物当前事实状态对应的 `Item`。
- `item-master-service` 不拥有 `ProductionSpec`、`ProductionUnit`、Route、Operation、WorkCenter、工序执行、质量结果或生产历史。
- 新 truth 只使用 `ProductionSpec` 与 `ProductionUnit`，不在本文保留旧名兼容。

### 15.4 WMS

- WMS 为 active + stockable `Item` 创建 `InventoryUnit`。
- `InventoryBalance` 按 `Item + location + lot / quality / status` 等维度汇总库存。
- `PackageUnit` 是箱、托、包裹、搬运层级对象，不进入 `InventoryBalance`。
- PackagedItem 仍然是 `Item`，因此包装成品库存自然进入通用库存余额。
- WMS 库存转换、包装、装配、拆解、追溯关系由 `InventoryGenealogy` 等 WMS 对象承载。
- 新 truth 不再使用 `StockItemType`。

### 15.5 SRM

- SRM 拥有 `SupplierProfile` 与 `SupplierOffering`。
- `SupplierOffering` 表达某供应商可供应某个 Item。
- `SupplierItemMapping` 继续归 `item-master-service`，只表达供应商侧标识到标准 `Item` 的映射。

## 16. Examples

### 16.1 连体马桶

```text
ItemModel:
  MA3124 连体马桶
  modelKind = PHYSICAL
  modelType = FINISHED_PRODUCT

Item:
  MA3124 300坑距 白色 顶按 基础成品
  MA3124 300坑距 白色 顶按 普通包装成品

PackagingSpec:
  MA3124 普通包装规格

PACKAGING_BOM:
  output: MA3124 300坑距 白色 顶按 普通包装成品
  inputs:
    MA3124 300坑距 白色 顶按 基础成品 x1
    MA3124 普通纸箱 x1
    MA3124 普通泡沫 x1
    MA3124 说明书 x1
```

### 16.2 智能马桶

```text
ItemModel:
  S900 智能马桶整机 -> PHYSICAL / FINISHED_PRODUCT
  S900 陶瓷体 -> PHYSICAL / SEMI_FINISHED_PRODUCT
  S900 智能盖板 -> PHYSICAL / SUB_ASSEMBLY
  电控模块 -> PHYSICAL / PART

COMPOSITION_BOM:
  output: S900 智能马桶整机 基础成品
  inputs:
    S900 陶瓷体 x1
    S900 智能盖板 x1
    电控模块 x1

PACKAGING_BOM:
  output: S900 智能马桶整机 包装成品
  inputs:
    S900 智能马桶整机 基础成品 x1
    纸箱 x1
    泡沫 x1
    说明书 x1
```

### 16.3 分体立柱盆合并包装

```text
ItemModel:
  P100 洗手盆 -> PHYSICAL / FINISHED_PRODUCT
  P100 立柱 -> PHYSICAL / FINISHED_PRODUCT 或 ACCESSORY
  P100 洗手盆 + 立柱 合并包装族 -> PHYSICAL / FINISHED_PRODUCT

Item:
  P100 洗手盆 白色 单孔
  P100 立柱 白色
  P100 洗手盆 + 立柱 合并包装成品

PACKAGING_BOM:
  output: P100 洗手盆 + 立柱 合并包装成品
  inputs:
    P100 洗手盆 白色 单孔 x1
    P100 立柱 白色 x1
    P100 合并纸箱 x1
    P100 合并泡沫 x1
```

### 16.4 bathtub coaster

`bathtub coaster` 按实际业务含义分类：

- 如果是浴缸安装或使用所需功能配件：`modelType = ACCESSORY` 或 `PART`。
- 如果是包装保护垫：`modelType = PACKAGING_MATERIAL`，进入 `PACKAGING_BOM`。
- 如果可单独销售或采购：对应 `Item` 开启 `sellable` 或 `purchasable`。
- 如果进入库存或 BOM：仍必须有 `ItemModel + Item`。

## 17. Trusted gRPC Inbound Boundary

Item Master 当前 50 个查询/管理 RPC 全部冻结为 `BUSINESS / HUMAN / WEB`，唯一允许的生产 caller 类是 Gateway；当前 46 条 BFF route 不因本迁移增加业务入口。Gateway 先完成 HTTP session 与 Permission decision，再使用专用 Item Master mTLS client 和 `aud=urn:oes:service:item-master-service` 的 certificate-bound HUMAN ExecutionToken 调用；服务拒绝 MACHINE、DELEGATED、SELF_SERVICE、非 WEB terminal、错误 audience/`cnf`/Code 以及旧 body/metadata authority。

现有 `GetItem` 只用于 HUMAN 查看 Item 详情，不同时接受 MACHINE authority。MES、WMS、Procurement 与 SRM 已存在的内部 capability 校验改用三个按业务语义拆分的窄 INTERNAL RPC：

| INTERNAL RPC | Item Master-owned rule | Exact caller workload |
| --- | --- | --- |
| `ResolveManufacturableItem` | `active + manufacturable` | `mes-service` |
| `ResolveStockableItem` | `active + stockable` | `wms-service` |
| `ResolvePurchasableItem` | `active + purchasable` | `procurement-service`, `srm-service` |

三个 RPC 均为 `INTERNAL`，只返回 `item_id/item_code/item_name/active` 最小 projection。当前冻结调用形态是 `HUMAN subject + exact SYSTEM MACHINE actor`：MES/WMS/Procurement/SRM 使用自己已验证、audience 为自身的入站 HUMAN ET 逐跳兑换 Item Master audience ET；不得复用 Gateway identity、Machine root credential、旧 signed operator metadata、request body tenant 或 raw smoke identity。该拆分只迁移现有存在性/状态/capability 校验，不新增 capability、状态、业务规则或其他 caller 服务 RPC。

可信链使用单一 OBO subject credential：Common 在调用服务的 request-isolated private scope 保存当前入站 ET 的不可序列化 handle；调用服务以该 Token 向 Auth 换取下一跳 Token。Auth 验证 HUMAN subject/tenant/session、自身 audience、current exchanger mTLS/SPIFFE/leaf、Identity-owned actor binding 与 Permission workload decision，随后签发 `sub=原 HUMAN`、`principal_type=HUMAN`、`tenant_id=原 tenant`、`act=当前 SYSTEM MACHINE actor`、`aud=item-master-service` 且绑定当前 leaf 的目标 ET。目标 expiry 不晚于 subject ET，Auth 审计关联 subject/target `jti`。

Item Master server 只验证最终目标 ET、HUMAN subject、exact actor workload allowlist、INTERNAL Code、tenant、audience 与 `cnf`，不接收或解析前一跳 ET。缺失/错误 subject credential、跨 tenant、错误 self/target audience、过期 Token、actor spoofing、错误 workload/certificate、Permission denied、直接 HUMAN（无 actor）、MACHINE root 或 body/local tenant 注入全部 fail closed。没有入站 HUMAN ET 的 Cron/Robot/后台任务不进入这三个 RPC；其 tenant authority 需后续独立设计。

全部现有 50 个 request 删除并 reserve `tenant_id=1`；新 INTERNAL request 从 `item_id=1` 开始，不承载 authority。tenant、org、principal、operator、trace、audit 与 source workload 只能来自验证后的 ExecutionToken 和 transport context。Item Master 响应中的自身 tenant projection 如合同明确需要仍是业务数据，不构成调用 authority。

生产 caller manifest 固定为 Gateway（现有 50 RPC 的唯一允许 HUMAN caller，当前 46 条 BFF route）、MES（manufacturable）、WMS（stockable）、Procurement 与 SRM（purchasable）。当前没有 Gateway route 的 RPC 不因迁移自动获得 route。raw smoke、本地 fixture/stub 和测试替身不是生产 workload；直接调用 Item Master management 的 legacy smoke 删除或改走 Gateway HTTP 测试入口，WMS 本地 query stub 继续只作为隔离测试夹具。

## 18. Deferred

- `traceable` capability。
- `kittable` capability。
- `consumable` capability。
- `AttributeCombinationRule`。
- 虚拟套装 / kit 销售展开。
- 复杂替代料。
- 可选 BOM 行。
- `Item` 级 category override / secondary category。
- `PIM / PLM`、营销展示、图纸工程与完整产品生命周期管理。
- trusted gRPC runtime 实现与部署联调；其契约已由本文、Contract V2 与统一 trusted-gRPC feature packet 冻结。

## 19. Contract And Migration Notes

- `docs/contracts/item-master-service/**` 已回写 Contract V2，后续 proto 与 runtime migration 必须以本文和 Contract V2 为准。
- 其他服务文档应引用本文定义的概念，不得重新定义 item-master 主数据语义。
