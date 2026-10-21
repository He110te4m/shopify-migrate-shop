import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  collectMetafieldValues,
  collectTemplateConfigMetafieldValues,
  isAppOwnedNamespace,
  isVariantReferenceMetafieldType,
  matchesMetafieldFilter,
  type VariantReferenceLookup,
} from "./metafields";
import {
  fetchAllProducts,
  fetchVariantReferenceLookup,
  type RawMetafieldValue,
} from "./products-graphql.server";
import type {
  ExportedProduct,
  ExportedVariant,
  MetafieldFilter,
  ProductsExportKind,
  SkippedItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

export interface ProductsChunk {
  products: ExportedProduct[];
  skipped: SkippedItem[];
}

// 模板配置导出只解析参与导出的 variant_reference,其余 metafield 不额外查询引用
async function collectTemplateMetafields(
  graphql: Admin,
  metafields: RawMetafieldValue[],
  options: {
    filter: MetafieldFilter;
    identifierPrefix: string;
    skipped: SkippedItem[];
  },
) {
  const referencesByMetafieldId = new Map<string, VariantReferenceLookup>();
  for (const mf of metafields) {
    if (!matchesMetafieldFilter(mf, options.filter)) continue;
    if (isAppOwnedNamespace(mf.namespace)) continue;
    if (!isVariantReferenceMetafieldType(mf.type)) continue;
    referencesByMetafieldId.set(
      mf.id,
      await fetchVariantReferenceLookup(graphql, mf.id),
    );
  }
  return collectTemplateConfigMetafieldValues(metafields, {
    ...options,
    kind: "product",
    referencesByMetafieldId,
  });
}

// 供前端分批导出:每批只处理一批产品 ID,单次请求保持在函数超时以内。
// 结构保持完整:没有 metafield 的商品与变体也会写入,便于核对导出范围。
// buy-box-template-config 只导出产品级值(含可移植变体引用),变体 metafield 不参与。
export async function exportProductsChunk(
  graphql: Admin,
  filter: MetafieldFilter,
  productIds: string[],
  kind: ProductsExportKind = "products",
): Promise<ProductsChunk> {
  const templateConfig = kind === "buy-box-template-config";
  const fetched = await fetchAllProducts(graphql, productIds, {
    includeVariants: !templateConfig,
  });

  const skipped: SkippedItem[] = [];
  const products: ExportedProduct[] = [];

  for (const product of fetched) {
    const metafields = templateConfig
      ? await collectTemplateMetafields(graphql, product.metafields, {
          filter,
          identifierPrefix: product.handle,
          skipped,
        })
      : collectMetafieldValues(product.metafields, {
          filter,
          kind: "product",
          identifierPrefix: product.handle,
          skipped,
        });

    const variants: ExportedVariant[] = templateConfig
      ? []
      : product.variants.map((variant) => {
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
