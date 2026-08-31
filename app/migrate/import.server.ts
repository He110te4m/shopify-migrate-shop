import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { migrationRuns } from "../storage.server";
import {
  fetchAllDefinitions,
  formatUserErrors,
  METAFIELD_DEFINITION_CREATE,
  METAFIELD_DEFINITION_UPDATE,
  METAOBJECT_DEFINITION_CREATE,
  METAOBJECT_DEFINITION_UPDATE,
  type UserError,
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

interface MutationPayload<T> {
  userErrors: UserError[];
  [key: string]: T | UserError[] | null;
}

async function runMutation<T>(
  graphql: Admin,
  query: string,
  variables: Record<string, unknown>,
  payloadKey: string,
): Promise<{ data: T | null; error: string | null }> {
  const response = await graphql(query, { variables });
  const body = (await response.json()) as {
    data?: Record<string, MutationPayload<T>>;
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    return {
      data: null,
      error: body.errors.map((e) => e.message).join("; "),
    };
  }
  const payload = body.data?.[payloadKey];
  if (!payload) return { data: null, error: "无数据返回" };
  if (payload.userErrors.length) {
    return { data: null, error: formatUserErrors(payload.userErrors) };
  }
  return { data: payload as unknown as T, error: null };
}

function buildCapabilitiesInput(def: MetaobjectDef) {
  if (!def.capabilities) return undefined;
  const c = def.capabilities;
  return {
    publishable: { enabled: c.publishable },
    translatable: { enabled: c.translatable },
    renderable: {
      enabled: c.renderable,
      ...(c.renderable && c.renderableTemplateSuffix
        ? {
            data: {
              onlineStore: { templateSuffix: c.renderableTemplateSuffix },
            },
          }
        : {}),
    },
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

function buildMetaobjectCreateInput(
  def: MetaobjectDef,
  typeToGid: Map<string, string>,
) {
  return {
    name: def.name,
    type: def.type,
    ...(def.description ? { description: def.description } : {}),
    ...(def.access ? { access: def.access } : {}),
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
  return {
    ownerType: def.ownerType,
    namespace: def.namespace,
    key: def.key,
    name: def.name,
    type: def.type,
    ...(def.description ? { description: def.description } : {}),
    ...(validations.length ? { validations } : {}),
    ...(def.access?.admin || def.access?.storefront
      ? {
          access: {
            ...(def.access.admin ? { admin: def.access.admin } : {}),
            ...(def.access.storefront
              ? { storefront: def.access.storefront }
              : {}),
          },
        }
      : {}),
  };
}

export async function executeImport(
  graphql: Admin,
  file: MigrationFile,
  shop: string,
  fileName?: string,
): Promise<ImportReport> {
  const fetched = await fetchAllDefinitions(graphql);
  const plan = planWithDefinitions(file, fetched);

  const typeToGid = new Map(fetched.metaobjects.map((d) => [d.type, d.id]));
  const results: ResultItem[] = [];

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
    if (item.kind === "metaobject" && item.action === "create") {
      const def = sourceMetaobjectByType.get(item.identifier);
      if (def) pendingCreates.set(def.type, def);
    }
  }

  const createdResults = new Map<string, ResultItem>();
  let progress = true;
  while (pendingCreates.size && progress) {
    progress = false;
    for (const [type, def] of [...pendingCreates]) {
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
      if (error || !data) {
        createdResults.set(type, {
          kind: "metaobject",
          identifier: type,
          action: "fail",
          reason: `创建失败: ${error ?? "无数据返回"}`,
        });
      } else {
        typeToGid.set(type, data.id);
        createdResults.set(type, {
          kind: "metaobject",
          identifier: type,
          action: "create",
        });
      }
      pendingCreates.delete(type);
      progress = true;
    }
  }
  for (const [type] of pendingCreates) {
    createdResults.set(type, {
      kind: "metaobject",
      identifier: type,
      action: "fail",
      reason: "依赖未满足（可能存在循环依赖或依赖创建失败）",
    });
  }

  // ---- Phase 1b: update existing metaobjects (add missing / sync changed fields) ----
  const updatedResults = new Map<string, ResultItem>();
  for (const item of plan.items) {
    if (item.kind !== "metaobject" || item.action !== "update") continue;
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
    if (!operations.length) {
      updatedResults.set(item.identifier, { ...item, action: "skip" });
      continue;
    }
    const { error } = await runMutation<{ id: string }>(
      graphql,
      METAOBJECT_DEFINITION_UPDATE,
      { id: target.id, definition: { fieldDefinitions: operations } },
      "metaobjectDefinitionUpdate",
    );
    updatedResults.set(
      item.identifier,
      error
        ? { ...item, action: "fail", reason: `更新失败: ${error}` }
        : { ...item },
    );
  }

  // ---- Phase 2: metafields ----
  const metafieldResults = new Map<string, ResultItem>();
  for (const item of plan.items) {
    if (item.kind !== "metafield") continue;
    const source = sourceMetafieldById.get(item.identifier);
    if (!source) {
      metafieldResults.set(item.identifier, { ...item });
      continue;
    }
    if (item.action === "create") {
      const { validations, missingTypes } = resolveValidations(
        source.validations,
        typeToGid,
      );
      if (missingTypes.length) {
        metafieldResults.set(item.identifier, {
          ...item,
          action: "fail",
          reason: `依赖的 metaobject 创建失败: ${missingTypes.join(", ")}`,
        });
        continue;
      }
      const createInput = buildMetafieldCreateInput(source, typeToGid);
      const { data, error } = await runMutation<{ id: string }>(
        graphql,
        METAFIELD_DEFINITION_CREATE,
        { definition: { ...createInput, validations } },
        "metafieldDefinitionCreate",
      );
      if (error || !data) {
        metafieldResults.set(item.identifier, {
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
      metafieldResults.set(item.identifier, { ...item, detail });
      continue;
    }
    if (item.action === "update") {
      const target = targetMetafieldById.get(item.identifier);
      if (!target) {
        metafieldResults.set(item.identifier, { ...item });
        continue;
      }
      const { validations, missingTypes } = resolveValidations(
        source.validations,
        typeToGid,
      );
      if (missingTypes.length) {
        metafieldResults.set(item.identifier, {
          ...item,
          action: "fail",
          reason: `依赖的 metaobject 创建失败: ${missingTypes.join(", ")}`,
        });
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
      metafieldResults.set(
        item.identifier,
        error
          ? { ...item, action: "fail", reason: `更新失败: ${error}` }
          : { ...item },
      );
      continue;
    }
    metafieldResults.set(item.identifier, { ...item });
  }

  // ---- Assemble report in plan order ----
  for (const item of plan.items) {
    if (item.kind === "metaobject") {
      if (item.action === "create" && createdResults.has(item.identifier)) {
        results.push(createdResults.get(item.identifier)!);
      } else if (item.action === "update" && updatedResults.has(item.identifier)) {
        results.push(updatedResults.get(item.identifier)!);
      } else {
        results.push({ ...item });
      }
    } else {
      results.push(metafieldResults.get(item.identifier) ?? { ...item });
    }
  }

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
