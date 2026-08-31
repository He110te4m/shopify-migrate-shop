import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { migrationRuns } from "../storage.server";
import {
  fetchAllDefinitions,
  METAFIELD_DEFINITION_CREATE,
  METAFIELD_DEFINITION_UPDATE,
  METAOBJECT_DEFINITION_CREATE,
  METAOBJECT_DEFINITION_UPDATE,
  runMutation,
} from "./graphql.server";
import {
  referencedMetaobjectTypes,
  resolveValidations,
} from "./refs";
import {
  diffMetaobjectFields,
  planWithDefinitions,
} from "./validate.server";
import type {
  ImportReport,
  MetaobjectDef,
  MetaobjectFieldDef,
  MetafieldDef,
  MigrationFile,
  PlanAction,
  ResultItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

function metafieldIdentifier(def: {
  ownerType: string;
  namespace: string;
  key: string;
}): string {
  return `${def.ownerType}.${def.namespace}.${def.key}`;
}

function buildCapabilitiesInput(def: MetaobjectDef) {
  if (!def.capabilities) return undefined;
  const c = def.capabilities;
  return {
    publishable: { enabled: c.publishable },
    translatable: { enabled: c.translatable },
    renderable: { enabled: c.renderable },
  };
}

function buildFieldCreateInput(
  field: MetaobjectFieldDef,
  typeToGid: Map<string, string>,
) {
  const { validations } = resolveValidations(field.validations, typeToGid);
  return {
    key: field.key,
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.description ? { description: field.description } : {}),
    ...(validations.length ? { validations } : {}),
  };
}

// MetaobjectDefinitionCreateInput/MetafieldDefinitionInput 的 access.admin:
// 1. 仅接受 MERCHANT_READ/MERCHANT_READ_WRITE,导出侧的 PUBLIC_READ* 需降级映射
// 2. 仅允许 app-reserved($app 前缀)的定义指定,商户定义创建时不能传 admin
const ADMIN_ACCESS_INPUT_MAP: Record<string, string> = {
  MERCHANT_READ: "MERCHANT_READ",
  MERCHANT_READ_WRITE: "MERCHANT_READ_WRITE",
  PUBLIC_READ: "MERCHANT_READ",
  PUBLIC_READ_WRITE: "MERCHANT_READ_WRITE",
};

function mapAdminAccess(value: string, appReserved: boolean) {
  if (!appReserved) return undefined;
  return ADMIN_ACCESS_INPUT_MAP[value] ?? "MERCHANT_READ_WRITE";
}

function buildMetaobjectAccessInput(def: MetaobjectDef) {
  const access = def.access;
  if (!access) return undefined;
  const admin = access.admin
    ? mapAdminAccess(access.admin, def.type.startsWith("$app:"))
    : undefined;
  return {
    ...(admin ? { admin } : {}),
    ...(access.storefront ? { storefront: access.storefront } : {}),
  };
}

function buildMetaobjectCreateInput(
  def: MetaobjectDef,
  typeToGid: Map<string, string>,
) {
  return {
    name: def.name,
    type: def.type,
    ...(def.description ? { description: def.description } : {}),
    ...(def.access ? { access: buildMetaobjectAccessInput(def) } : {}),
    ...(buildCapabilitiesInput(def)
      ? { capabilities: buildCapabilitiesInput(def) }
      : {}),
    fieldDefinitions: def.fieldDefinitions.map((f) =>
      buildFieldCreateInput(f, typeToGid),
    ),
  };
}

function buildMetafieldCreateInput(
  def: MetafieldDef,
  typeToGid: Map<string, string>,
) {
  const { validations } = resolveValidations(def.validations, typeToGid);
  const admin = def.access?.admin
    ? mapAdminAccess(
        def.access.admin,
        def.namespace === "$app" || def.namespace.startsWith("$app:"),
      )
    : undefined;
  return {
    ownerType: def.ownerType,
    namespace: def.namespace,
    key: def.key,
    name: def.name,
    type: def.type,
    ...(def.description ? { description: def.description } : {}),
    ...(validations.length ? { validations } : {}),
    ...(admin || def.access?.storefront
      ? {
          access: {
            ...(admin ? { admin } : {}),
            ...(def.access?.storefront
              ? { storefront: def.access.storefront }
              : {}),
          },
        }
      : {}),
  };
}

const BATCH_SIZE = 10;

const itemKey = (kind: string, identifier: string) => `${kind}:${identifier}`;

// 分批执行导入:每批重新拉取目标定义并重算计划(天然幂等),只执行前 batchSize 个
// 待处理(create/update)项;exclude 中的项(上一批已失败)直接跳过,避免无限重试
export async function executeBatch(
  graphql: Admin,
  file: MigrationFile,
  options: { exclude?: string[]; batchSize?: number } = {},
): Promise<{ results: ResultItem[]; pending: number }> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const exclude = new Set(options.exclude ?? []);

  const fetched = await fetchAllDefinitions(graphql);
  const plan = planWithDefinitions(file, fetched);

  const typeToGid = new Map(fetched.metaobjects.map((d) => [d.type, d.id]));
  const results: ResultItem[] = [];
  let slots = batchSize;

  const sourceMetaobjectByType = new Map(
    file.metaobjectDefinitions.map((d) => [d.type, d]),
  );
  const sourceMetafieldById = new Map(
    file.metafieldDefinitions.map((d) => [metafieldIdentifier(d), d]),
  );
  const targetMetaobjectByType = new Map(
    fetched.metaobjects.map((d) => [d.type, d]),
  );
  const targetMetafieldById = new Map(
    fetched.metafields.map((d) => [metafieldIdentifier(d), d]),
  );

  // ---- Phase 1a: create metaobjects, dependency-ordered with multi-round retry ----
  const pendingCreates = new Map<string, MetaobjectDef>();
  for (const item of plan.items) {
    if (
      item.kind === "metaobject" &&
      item.action === "create" &&
      !exclude.has(itemKey(item.kind, item.identifier))
    ) {
      const def = sourceMetaobjectByType.get(item.identifier);
      if (def) pendingCreates.set(def.type, def);
    }
  }

  let progress = true;
  while (pendingCreates.size && progress && slots > 0) {
    progress = false;
    for (const [type, def] of [...pendingCreates]) {
      if (slots <= 0) break;
      const refs = def.fieldDefinitions.flatMap((f) =>
        referencedMetaobjectTypes(f.validations),
      );
      if (refs.some((t) => !typeToGid.has(t))) continue;
      const { data, error } = await runMutation<{ id: string }>(
        graphql,
        METAOBJECT_DEFINITION_CREATE,
        { definition: buildMetaobjectCreateInput(def, typeToGid) },
        "metaobjectDefinitionCreate",
      );
      slots--;
      if (error || !data) {
        results.push({
          kind: "metaobject",
          identifier: type,
          action: "fail",
          reason: `创建失败: ${error ?? "无数据返回"}`,
        });
      } else {
        typeToGid.set(type, data.id);
        results.push({ kind: "metaobject", identifier: type, action: "create" });
      }
      pendingCreates.delete(type);
      progress = true;
    }
  }
  // 槽位仍有剩余但无法推进 = 依赖已失败/被排除,永远无法满足,直接判失败
  if (slots > 0) {
    for (const [type] of pendingCreates) {
      results.push({
        kind: "metaobject",
        identifier: type,
        action: "fail",
        reason: "依赖未满足（可能存在循环依赖或依赖创建失败）",
      });
    }
    pendingCreates.clear();
  }

  // ---- Phase 1b: update existing metaobjects (add missing / sync changed fields) ----
  for (const item of plan.items) {
    if (slots <= 0) break;
    if (item.kind !== "metaobject" || item.action !== "update") continue;
    if (exclude.has(itemKey(item.kind, item.identifier))) continue;
    const source = sourceMetaobjectByType.get(item.identifier);
    const target = targetMetaobjectByType.get(item.identifier);
    if (!source || !target) continue;
    const { fieldsToAdd, fieldsToUpdate } = diffMetaobjectFields(
      source,
      target,
      fetched.gidToMetaobjectType,
    );
    const operations = [
      ...fieldsToAdd.map((f) => ({
        create: buildFieldCreateInput(f, typeToGid),
      })),
      ...fieldsToUpdate.map((f) => {
        const { validations } = resolveValidations(f.validations, typeToGid);
        return {
          update: {
            key: f.key,
            name: f.name,
            ...(f.description !== null ? { description: f.description } : {}),
            ...(validations.length ? { validations } : {}),
          },
        };
      }),
    ];
    slots--;
    if (!operations.length) {
      results.push({ ...item, action: "skip" });
      continue;
    }
    const { error } = await runMutation<{ id: string }>(
      graphql,
      METAOBJECT_DEFINITION_UPDATE,
      { id: target.id, definition: { fieldDefinitions: operations } },
      "metaobjectDefinitionUpdate",
    );
    results.push(
      error ? { ...item, action: "fail", reason: `更新失败: ${error}` } : { ...item },
    );
  }

  // ---- Phase 2: metafields ----
  for (const item of plan.items) {
    if (slots <= 0) break;
    if (item.kind !== "metafield") continue;
    if (item.action !== "create" && item.action !== "update") continue;
    if (exclude.has(itemKey(item.kind, item.identifier))) continue;
    const source = sourceMetafieldById.get(item.identifier);
    if (!source) continue;

    const { validations, missingTypes } = resolveValidations(
      source.validations,
      typeToGid,
    );
    slots--;
    if (missingTypes.length) {
      results.push({
        ...item,
        action: "fail",
        reason: `依赖的 metaobject 创建失败: ${missingTypes.join(", ")}`,
      });
      continue;
    }

    if (item.action === "create") {
      const createInput = buildMetafieldCreateInput(source, typeToGid);
      const { data, error } = await runMutation<{ id: string }>(
        graphql,
        METAFIELD_DEFINITION_CREATE,
        { definition: { ...createInput, validations } },
        "metafieldDefinitionCreate",
      );
      if (error || !data) {
        results.push({
          ...item,
          action: "fail",
          reason: `创建失败: ${error ?? "无数据返回"}`,
        });
        continue;
      }
      let detail: string | undefined;
      if (source.pinnedPosition !== null) {
        const pinResult = await runMutation<{ id: string }>(
          graphql,
          METAFIELD_DEFINITION_UPDATE,
          {
            definition: {
              namespace: source.namespace,
              key: source.key,
              ownerType: source.ownerType,
              pin: true,
            },
          },
          "metafieldDefinitionUpdate",
        );
        if (pinResult.error) detail = `已创建，但置顶失败: ${pinResult.error}`;
      }
      results.push({ ...item, detail });
      continue;
    }

    const target = targetMetafieldById.get(item.identifier);
    if (!target) {
      results.push({ ...item });
      continue;
    }
    const { error } = await runMutation<{ id: string }>(
      graphql,
      METAFIELD_DEFINITION_UPDATE,
      {
        definition: {
          namespace: source.namespace,
          key: source.key,
          ownerType: source.ownerType,
          name: source.name,
          description: source.description ?? "",
          validations,
          pin: source.pinnedPosition !== null,
        },
      },
      "metafieldDefinitionUpdate",
    );
    results.push(
      error ? { ...item, action: "fail", reason: `更新失败: ${error}` } : { ...item },
    );
  }

  const executed = new Set(results.map((r) => itemKey(r.kind, r.identifier)));
  const pending = plan.items.filter(
    (i) =>
      (i.action === "create" || i.action === "update") &&
      !exclude.has(itemKey(i.kind, i.identifier)) &&
      !executed.has(itemKey(i.kind, i.identifier)),
  ).length;

  return { results, pending };
}

export async function saveImportReport(
  shop: string,
  fileName: string | undefined,
  results: ResultItem[],
): Promise<ImportReport> {
  const summary: Record<PlanAction, number> = { create: 0, update: 0, skip: 0, fail: 0 };
  for (const r of results) summary[r.action] += 1;

  const report: ImportReport = {
    shop,
    executedAt: new Date().toISOString(),
    fileName,
    results,
    summary,
  };

  await migrationRuns.save({
    shop,
    fileName: fileName ?? null,
    summary: JSON.stringify(summary),
    report: JSON.stringify(report),
  });

  return report;
}
