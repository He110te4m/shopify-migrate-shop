import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { collectMetafieldValues } from "./metafields";
import { fetchAllProducts } from "./products-graphql.server";
import type {
  ExportedProduct,
  ExportedVariant,
  MetafieldFilter,
  ProductsMigrationFile,
  SkippedItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

export async function buildProductsMigrationFile(
  graphql: Admin,
  shop: string,
  filter: MetafieldFilter,
  options: { productIds?: string[] } = {},
): Promise<ProductsMigrationFile> {
  const products = await fetchAllProducts(graphql, options.productIds);

  const skipped: SkippedItem[] = [];
  const exported: ExportedProduct[] = [];

  for (const product of products) {
    const metafields = collectMetafieldValues(product.metafields, {
      filter,
      kind: "product",
      identifierPrefix: product.handle,
      skipped,
    });

    const variants: ExportedVariant[] = [];
    for (const variant of product.variants) {
      const label = `${product.handle} / ${variant.sku || variant.title}`;
      if (variant.metafieldsTruncated) {
        skipped.push({
          kind: "product",
          identifier: label,
          reason: "该变体的 metafield 超过 250 条，仅导出前 250 条",
        });
      }
      const variantMetafields = collectMetafieldValues(variant.metafields, {
        filter,
        kind: "product",
        identifierPrefix: label,
        skipped,
      });
      if (variantMetafields.length) {
        variants.push({
          sku: variant.sku,
          title: variant.title,
          metafields: variantMetafields,
        });
      }
    }

    // 没有可迁移值的商品不写入文件,避免产生无效条目
    if (!metafields.length && !variants.length) continue;
    exported.push({
      handle: product.handle,
      title: product.title,
      metafields,
      variants,
    });
  }

  return {
    version: 1,
    kind: "products",
    exportedAt: new Date().toISOString(),
    shop,
    filter,
    productHandles: exported.map((product) => product.handle),
    products: exported,
    skipped,
  };
}
