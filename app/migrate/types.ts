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

export interface SkippedItem {
  kind: "metaobject" | "metafield";
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

export type PlanAction = "create" | "update" | "skip" | "fail";

export interface PlanItem {
  kind: "metaobject" | "metafield";
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
