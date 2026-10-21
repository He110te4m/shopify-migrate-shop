import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { collectMetafieldValues } from "./metafields";
import { fetchAllPages } from "./pages-graphql.server";
import type {
  ExportedMetafieldValue,
  ExportedPage,
  PagesMigrationFile,
  SkippedItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

const EXPORT_ALL: { mode: "all"; patterns: string[] } = {
  mode: "all",
  patterns: [],
};

export function portablePageMetafields(
  handle: string,
  metafields: ExportedMetafieldValue[],
  skipped: SkippedItem[],
): ExportedMetafieldValue[] {
  return collectMetafieldValues(metafields, {
    filter: EXPORT_ALL,
    kind: "page",
    identifierPrefix: handle,
    skipped,
  });
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
