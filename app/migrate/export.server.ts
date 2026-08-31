import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { fetchAllDefinitions } from "./graphql.server";
import { exportValidations, referencedMetaobjectTypes } from "./refs";
import type { MetafieldDef, MigrationFile, SkippedItem } from "./types";

type Admin = AdminApiContext["graphql"];

function isAppOwned(identifier: string): boolean {
  return identifier.startsWith("$app:");
}

export async function buildMigrationFile(
  graphql: Admin,
  shop: string,
): Promise<MigrationFile> {
  const { metaobjects, metafields, gidToMetaobjectType } =
    await fetchAllDefinitions(graphql);

  const skipped: SkippedItem[] = [];

  const metaobjectDefinitions: MigrationFile["metaobjectDefinitions"] = [];
  for (const def of metaobjects) {
    if (isAppOwned(def.type)) {
      skipped.push({
        kind: "metaobject",
        identifier: def.type,
        reason: "app-owned 定义（$app: 前缀）无法跨应用迁移",
      });
      continue;
    }
    const fields: MigrationFile["metaobjectDefinitions"][number]["fieldDefinitions"] =
      [];
    let skipReason: string | null = null;
    for (const field of def.fieldDefinitions) {
      const { validations, unknownRef } = exportValidations(
        field.validations,
        gidToMetaobjectType,
      );
      if (unknownRef) {
        skipReason = `字段 ${field.key} 引用了未知的 metaobject 定义`;
        break;
      }
      const appOwnedRef = referencedMetaobjectTypes(validations).find((t) =>
        isAppOwned(t),
      );
      if (appOwnedRef) {
        skipReason = `字段 ${field.key} 引用了 app-owned metaobject ${appOwnedRef}，无法迁移`;
        break;
      }
      fields.push({ ...field, validations });
    }
    if (skipReason) {
      skipped.push({ kind: "metaobject", identifier: def.type, reason: skipReason });
      continue;
    }
    metaobjectDefinitions.push({ ...def, fieldDefinitions: fields });
  }

  const exportedTypes = new Set(metaobjectDefinitions.map((d) => d.type));

  const metafieldDefinitions: MetafieldDef[] = [];
  for (const def of metafields) {
    const identifier = `${def.ownerType}.${def.namespace}.${def.key}`;
    if (def.namespace === "$app" || def.namespace.startsWith("$app:")) {
      skipped.push({
        kind: "metafield",
        identifier,
        reason: "app-owned 定义（$app 命名空间）无法跨应用迁移",
      });
      continue;
    }
    const { validations, unknownRef } = exportValidations(
      def.validations,
      gidToMetaobjectType,
    );
    if (unknownRef) {
      skipped.push({
        kind: "metafield",
        identifier,
        reason: "引用了未知的 metaobject 定义",
      });
      continue;
    }
    const appOwnedRef = referencedMetaobjectTypes(validations).find((t) =>
      isAppOwned(t),
    );
    if (appOwnedRef) {
      skipped.push({
        kind: "metafield",
        identifier,
        reason: `引用了 app-owned metaobject ${appOwnedRef}，无法迁移`,
      });
      continue;
    }
    const missingRef = referencedMetaobjectTypes(validations).find(
      (t) => !exportedTypes.has(t),
    );
    if (missingRef) {
      skipped.push({
        kind: "metafield",
        identifier,
        reason: `依赖的 metaobject ${missingRef} 未能导出`,
      });
      continue;
    }
    metafieldDefinitions.push({ ...def, validations });
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    shop,
    metaobjectDefinitions,
    metafieldDefinitions,
    skipped,
  };
}
