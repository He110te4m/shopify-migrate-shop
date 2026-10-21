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

export interface ExportedMetafieldValue {
  namespace: string;
  key: string;
  type: string;
  value: string;
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
