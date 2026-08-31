import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { fetchAllPages } from "./pages-graphql.server";
import type {
  ExportedPage,
  ExportedPageMetafield,
  PagesMigrationFile,
  SkippedItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

// reference 类 metafield 的值是店铺内 GID,跨店铺不可解析
function isNonPortableType(type: string): boolean {
  const base = type.replace(/^list\./, "");
  return base.endsWith("_reference");
}

function isAppOwnedNamespace(namespace: string): boolean {
  return namespace === "$app" || namespace.startsWith("$app:");
}

export function portablePageMetafields(
  handle: string,
  metafields: ExportedPageMetafield[],
  skipped: SkippedItem[],
): ExportedPageMetafield[] {
  const out: ExportedPageMetafield[] = [];
  for (const mf of metafields) {
    const identifier = `${handle} ${mf.namespace}.${mf.key}`;
    if (isAppOwnedNamespace(mf.namespace)) {
      skipped.push({
        kind: "page",
        identifier,
        reason: "app-owned metafield（$app 命名空间）无法跨应用迁移",
      });
      continue;
    }
    if (isNonPortableType(mf.type)) {
      skipped.push({
        kind: "page",
        identifier,
        reason: `metafield 类型 ${mf.type} 的值为店铺内 GID，跨店铺不可解析`,
      });
      continue;
    }
    out.push(mf);
  }
  return out;
}

export async function buildPagesMigrationFile(
  graphql: Admin,
  shop: string,
): Promise<PagesMigrationFile> {
  const fetchedPages = await fetchAllPages(graphql);

  const skipped: SkippedItem[] = [];
  const pages: ExportedPage[] = fetchedPages.map((page) => ({
    title: page.title,
    handle: page.handle,
    body: page.body,
    isPublished: page.isPublished,
    templateSuffix: page.templateSuffix,
    metafields: portablePageMetafields(page.handle, page.metafields, skipped),
  }));

  return {
    version: 1,
    kind: "pages",
    exportedAt: new Date().toISOString(),
    shop,
    pages,
    skipped,
  };
}
