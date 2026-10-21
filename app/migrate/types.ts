export interface Validation {
  name: string;
  value: string;
}

export interface MetaobjectFieldDef {
  key: string;
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  validations: Validation[];
}

export interface MetaobjectAccess {
  admin: string;
  storefront: string;
}

export interface MetaobjectCapabilities {
  publishable: boolean;
  translatable: boolean;
  renderable: boolean;
}

export interface MetaobjectDef {
  type: string;
  name: string;
  description: string | null;
  access: MetaobjectAccess | null;
  capabilities: MetaobjectCapabilities | null;
  fieldDefinitions: MetaobjectFieldDef[];
}

export interface MetafieldAccess {
  admin?: string | null;
  storefront?: string | null;
}

export interface MetafieldDef {
  ownerType: string;
  namespace: string;
  key: string;
  name: string;
  type: string;
  description: string | null;
  validations: Validation[];
  pinnedPosition: number | null;
  access: MetafieldAccess | null;
}

export type MigrationItemKind = "metaobject" | "metafield" | "page" | "product";

export interface SkippedItem {
  kind: MigrationItemKind;
  identifier: string;
  reason: string;
}

export interface MigrationFile {
  version: 1;
  exportedAt: string;
  shop: string;
  metaobjectDefinitions: MetaobjectDef[];
  metafieldDefinitions: MetafieldDef[];
  skipped: SkippedItem[];
}

// 跨店铺可移植的变体引用:不写 GID,只用目标店铺可重新匹配的业务键
export interface PortableVariantReference {
  kind: "product_variant";
  productHandle: string;
  sku: string | null;
  variantTitle: string;
}

export interface ExportedMetafieldValue {
  namespace: string;
  key: string;
  type: string;
  value: string;
  // 仅 buy-box-template-config 导出填充:把 variant_reference 的 GID 换成可移植引用
  references?: PortableVariantReference[];
}

export interface ExportedPage {
  title: string;
  handle: string;
  body: string;
  isPublished: boolean;
  templateSuffix: string | null;
  metafields: ExportedMetafieldValue[];
}

export interface PagesMigrationFile {
  version: 1;
  kind: "pages";
  exportedAt: string;
  shop: string;
  pages: ExportedPage[];
  skipped: SkippedItem[];
}

export type MetafieldFilterMode = "all" | "include" | "exclude";

// 按 namespace 全名或 namespace.key 前缀过滤,例如 "custom" 命中 custom 命名空间下所有 key,
// "custom.foo" 命中 custom.foo 及 custom.foo* ; 结尾的 .* 会被忽略
export interface MetafieldFilter {
  mode: MetafieldFilterMode;
  patterns: string[];
}

export interface ExportedVariant {
  sku: string | null;
  title: string;
  metafields: ExportedMetafieldValue[];
}

export interface ExportedProduct {
  handle: string;
  title: string;
  // 产品使用的主题模板后缀,对应 product.<templateSuffix>.json;null 表示默认模板
  templateSuffix: string | null;
  metafields: ExportedMetafieldValue[];
  variants: ExportedVariant[];
}

export interface ProductsMigrationFile {
  version: 1;
  kind: "products";
  exportedAt: string;
  shop: string;
  filter: MetafieldFilter;
  // 导出时选择的产品 handle;空数组表示导出全部产品
  productHandles: string[];
  products: ExportedProduct[];
  skipped: SkippedItem[];
}

// 模板配置导出复用产品迁移文件结构,但 kind 不同且不能在产品导入页导入
export interface BuyBoxTemplateConfigFile
  extends Omit<ProductsMigrationFile, "kind"> {
  kind: "buy-box-template-config";
}

export type ProductsExportKind =
  | ProductsMigrationFile["kind"]
  | BuyBoxTemplateConfigFile["kind"];

export type PlanAction = "create" | "update" | "skip" | "fail";

export interface PlanItem {
  kind: MigrationItemKind;
  identifier: string;
  action: PlanAction;
  reason?: string;
}

export interface Plan {
  items: PlanItem[];
  summary: Record<PlanAction, number>;
}

export interface ResultItem extends PlanItem {
  detail?: string;
}

export interface ImportReport {
  shop: string;
  executedAt: string;
  fileName?: string;
  results: ResultItem[];
  summary: Record<PlanAction, number>;
}
