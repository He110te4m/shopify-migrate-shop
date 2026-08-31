import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  fetchAllDefinitions,
  type FetchedMetaobjectDef,
  type FetchedMetafieldDef,
} from "./graphql.server";
import {
  normalizeValidations,
  referencedMetaobjectTypes,
} from "./refs";
import type {
  MetaobjectDef,
  MetaobjectFieldDef,
  MigrationFile,
  Plan,
  PlanAction,
  PlanItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

function isAppOwned(identifier: string): boolean {
  return identifier.startsWith("$app:");
}

function metafieldIdentifier(def: {
  ownerType: string;
  namespace: string;
  key: string;
}): string {
  return `${def.ownerType}.${def.namespace}.${def.key}`;
}

function missingDependencyReason(refs: string[], available: Set<string>): string | null {
  const missing = refs.filter((t) => !available.has(t));
  return missing.length
    ? `依赖的 metaobject 未在目标店铺定义且不在导入文件中: ${missing.join(", ")}`
    : null;
}

export interface MetaobjectFieldDiff {
  conflicts: string[];
  fieldsToAdd: MetaobjectFieldDef[];
  fieldsToUpdate: MetaobjectFieldDef[];
}

export function diffMetaobjectFields(
  source: MetaobjectDef,
  target: FetchedMetaobjectDef,
  gidToType: Map<string, string>,
): MetaobjectFieldDiff {
  const targetFields = new Map(target.fieldDefinitions.map((f) => [f.key, f]));

  const conflicts: string[] = [];
  const fieldsToAdd: MetaobjectFieldDef[] = [];
  const fieldsToUpdate: MetaobjectFieldDef[] = [];

  for (const field of source.fieldDefinitions) {
    const targetField = targetFields.get(field.key);
    if (!targetField) {
      fieldsToAdd.push(field);
      continue;
    }
    if (targetField.type !== field.type) {
      conflicts.push(
        `字段 ${field.key} 类型不一致（源: ${field.type}，目标: ${targetField.type}）`,
      );
      continue;
    }
    if (targetField.required !== field.required) {
      conflicts.push(
        `字段 ${field.key} 必填属性不一致（源: ${field.required}，目标: ${targetField.required}）`,
      );
      continue;
    }
    const sourceNorm = normalizeValidations(field.validations, gidToType);
    const targetNorm = normalizeValidations(targetField.validations, gidToType);
    const metaChanged =
      targetField.name !== field.name ||
      (targetField.description ?? null) !== (field.description ?? null);
    if (
      metaChanged ||
      sourceNorm.length !== targetNorm.length ||
      sourceNorm.some((v, i) => v !== targetNorm[i])
    ) {
      fieldsToUpdate.push(field);
    }
  }

  return { conflicts, fieldsToAdd, fieldsToUpdate };
}

function compareMetaobject(
  source: MetaobjectDef,
  target: FetchedMetaobjectDef,
  gidToType: Map<string, string>,
  availableTypes: Set<string>,
): PlanItem {
  const identifier = source.type;
  const { conflicts, fieldsToAdd, fieldsToUpdate } = diffMetaobjectFields(
    source,
    target,
    gidToType,
  );

  if (conflicts.length) {
    return {
      kind: "metaobject",
      identifier,
      action: "fail",
      reason: `目标已存在同名定义但结构冲突: ${conflicts.join("; ")}`,
    };
  }

  if (!fieldsToAdd.length && !fieldsToUpdate.length) {
    return { kind: "metaobject", identifier, action: "skip", reason: "已存在且一致" };
  }

  const refs = [...fieldsToAdd, ...fieldsToUpdate].flatMap((f) =>
    referencedMetaobjectTypes(f.validations),
  );
  const depReason = missingDependencyReason(refs, availableTypes);
  if (depReason) {
    return { kind: "metaobject", identifier, action: "fail", reason: depReason };
  }

  const parts: string[] = [];
  if (fieldsToAdd.length)
    parts.push(`补充字段: ${fieldsToAdd.map((f) => f.key).join(", ")}`);
  if (fieldsToUpdate.length)
    parts.push(`更新字段元数据: ${fieldsToUpdate.map((f) => f.key).join(", ")}`);
  return {
    kind: "metaobject",
    identifier,
    action: "update",
    reason: parts.join("; "),
  };
}

function compareMetafield(
  source: MigrationFile["metafieldDefinitions"][number],
  target: FetchedMetafieldDef,
  gidToType: Map<string, string>,
  availableTypes: Set<string>,
): PlanItem {
  const identifier = metafieldIdentifier(source);

  if (target.type !== source.type) {
    return {
      kind: "metafield",
      identifier,
      action: "fail",
      reason: `目标已存在同名定义但类型不一致（源: ${source.type}，目标: ${target.type}）`,
    };
  }

  const sourceNorm = normalizeValidations(source.validations, gidToType);
  const targetNorm = normalizeValidations(target.validations, gidToType);
  const validationsDiffer =
    sourceNorm.length !== targetNorm.length ||
    sourceNorm.some((v, i) => v !== targetNorm[i]);
  const metaDiffer =
    target.name !== source.name ||
    (target.description ?? null) !== (source.description ?? null) ||
    (target.pinnedPosition ?? null) !== (source.pinnedPosition ?? null);

  if (!validationsDiffer && !metaDiffer) {
    return { kind: "metafield", identifier, action: "skip", reason: "已存在且一致" };
  }

  const refs = referencedMetaobjectTypes(source.validations);
  const depReason = missingDependencyReason(refs, availableTypes);
  if (depReason) {
    return { kind: "metafield", identifier, action: "fail", reason: depReason };
  }

  const parts: string[] = [];
  if (validationsDiffer) parts.push("同步校验规则");
  if (metaDiffer) parts.push("同步名称/描述/置顶状态");
  return {
    kind: "metafield",
    identifier,
    action: "update",
    reason: parts.join("; "),
  };
}

export function parseMigrationFile(raw: string): MigrationFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("文件不是合法的 JSON");
  }
  const file = parsed as Partial<MigrationFile>;
  if (
    !file ||
    file.version !== 1 ||
    !Array.isArray(file.metaobjectDefinitions) ||
    !Array.isArray(file.metafieldDefinitions)
  ) {
    throw new Error("文件格式不正确，请使用本应用导出的定义文件");
  }
  return {
    ...file,
    skipped: Array.isArray(file.skipped) ? file.skipped : [],
  } as MigrationFile;
}

export async function buildPlan(
  graphql: Admin,
  file: MigrationFile,
): Promise<Plan> {
  const fetched = await fetchAllDefinitions(graphql);
  return planWithDefinitions(file, fetched);
}

export function planWithDefinitions(
  file: MigrationFile,
  fetched: {
    metaobjects: FetchedMetaobjectDef[];
    metafields: FetchedMetafieldDef[];
    gidToMetaobjectType: Map<string, string>;
  },
): Plan {
  const { metaobjects, metafields, gidToMetaobjectType } = fetched;

  const targetMetaobjectByType = new Map(metaobjects.map((d) => [d.type, d]));
  const targetMetafieldById = new Map(
    metafields.map((d) => [metafieldIdentifier(d), d]),
  );

  const items: PlanItem[] = [];
  const sourceTypes = new Set(file.metaobjectDefinitions.map((d) => d.type));
  const availableTypes = new Set<string>([
    ...sourceTypes,
    ...targetMetaobjectByType.keys(),
  ]);

  for (const source of file.metaobjectDefinitions) {
    if (isAppOwned(source.type)) {
      items.push({
        kind: "metaobject",
        identifier: source.type,
        action: "skip",
        reason: "app-owned 定义无法跨应用迁移",
      });
      continue;
    }
    const target = targetMetaobjectByType.get(source.type);
    if (!target) {
      const refs = source.fieldDefinitions.flatMap((f) =>
        referencedMetaobjectTypes(f.validations),
      );
      const depReason = missingDependencyReason(refs, availableTypes);
      items.push(
        depReason
          ? { kind: "metaobject", identifier: source.type, action: "fail", reason: depReason }
          : { kind: "metaobject", identifier: source.type, action: "create" },
      );
      continue;
    }
    items.push(compareMetaobject(source, target, gidToMetaobjectType, availableTypes));
  }

  for (const source of file.metafieldDefinitions) {
    const identifier = metafieldIdentifier(source);
    if (source.namespace === "$app" || source.namespace.startsWith("$app:")) {
      items.push({
        kind: "metafield",
        identifier,
        action: "skip",
        reason: "app-owned 定义无法跨应用迁移",
      });
      continue;
    }
    const target = targetMetafieldById.get(identifier);
    if (!target) {
      const refs = referencedMetaobjectTypes(source.validations);
      const depReason = missingDependencyReason(refs, availableTypes);
      items.push(
        depReason
          ? { kind: "metafield", identifier, action: "fail", reason: depReason }
          : { kind: "metafield", identifier, action: "create" },
      );
      continue;
    }
    items.push(compareMetafield(source, target, gidToMetaobjectType, availableTypes));
  }

  const summary: Record<PlanAction, number> = { create: 0, update: 0, skip: 0, fail: 0 };
  for (const item of items) summary[item.action] += 1;
  return { items, summary };
}
