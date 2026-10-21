import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { collectMetafieldValues } from "./metafields";
import { fetchAllProducts } from "./products-graphql.server";
import type {
  ExportedProduct,
  ExportedVariant,
  MetafieldFilter,
  SkippedItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

export interface ProductsChunk {
  products: ExportedProduct[];
  skipped: SkippedItem[];
}

// 供前端分批导出:每批只处理一批产品 ID,单次请求保持在函数超时以内。
// 结构保持完整:没有 metafield 的商品与变体也会写入,便于核对导出范围。
export async function exportProductsChunk(
  graphql: Admin,
  filter: MetafieldFilter,
  productIds: string[],
): Promise<ProductsChunk> {
  const fetched = await fetchAllProducts(graphql, productIds);

  const skipped: SkippedItem[] = [];
  const products: ExportedProduct[] = [];

  for (const product of fetched) {
    const metafields = collectMetafieldValues(product.metafields, {
      filter,
      kind: "product",
      identifierPrefix: product.handle,
      skipped,
    });

    const variants: ExportedVariant[] = product.variants.map((variant) => {
      const label = `${product.handle} / ${variant.sku || variant.title}`;
      if (variant.metafieldsTruncated) {
        skipped.push({
          kind: "product",
          identifier: label,
          reason: "该变体的 metafield 超过 250 条，仅导出前 250 条",
        });
      }
      return {
        sku: variant.sku,
        title: variant.title,
        metafields: collectMetafieldValues(variant.metafields, {
          filter,
          kind: "product",
          identifierPrefix: label,
          skipped,
        }),
      };
    });

    products.push({
      handle: product.handle,
      title: product.title,
      templateSuffix: product.templateSuffix,
      metafields,
      variants,
    });
  }

  return { products, skipped };
}
