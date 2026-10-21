import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { METAFIELDS_SET, runMutation } from "./graphql.server";
import {
  fetchTargetProducts,
  type TargetProduct,
  type TargetVariant,
} from "./products-graphql.server";
import type {
  ExportedMetafieldValue,
  ExportedProduct,
  ExportedVariant,
  Plan,
  PlanAction,
  PlanItem,
  ProductsMigrationFile,
  ResultItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

export function parseProductsFile(raw: string): ProductsMigrationFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("文件不是合法的 JSON");
  }
  const file = parsed as Partial<ProductsMigrationFile>;
  if (
    !file ||
    file.version !== 1 ||
    file.kind !== "products" ||
    !Array.isArray(file.products)
  ) {
    throw new Error("文件格式不正确，请使用本应用导出的产品迁移文件");
  }
  return {
    ...file,
    filter: file.filter ?? { mode: "all", patterns: [] },
    productHandles: Array.isArray(file.productHandles)
      ? file.productHandles
      : [],
    skipped: Array.isArray(file.skipped) ? file.skipped : [],
  } as ProductsMigrationFile;
}

export interface ProductIndex {
  byHandle: Map<string, TargetProduct>;
  bySku: Map<string, TargetProduct>;
}

export function buildProductIndex(products: TargetProduct[]): ProductIndex {
  const byHandle = new Map<string, TargetProduct>();
  const bySku = new Map<string, TargetProduct>();
  for (const product of products) {
    byHandle.set(product.handle, product);
    for (const variant of product.variants) {
      // 同 SKU 命中多个产品时保留第一个,避免匹配结果随查询顺序漂移
      if (variant.sku && !bySku.has(variant.sku)) bySku.set(variant.sku, product);
    }
  }
  return { byHandle, bySku };
}

export interface ProductMatch {
  product: TargetProduct;
  via: "handle" | "sku";
}

// handle 优先;handle 不匹配时用源变体 SKU 在目标店铺兜底查找
export function matchTargetProduct(
  source: ExportedProduct,
  index: ProductIndex,
): ProductMatch | null {
  const byHandle = index.byHandle.get(source.handle);
  if (byHandle) return { product: byHandle, via: "handle" };
  for (const variant of source.variants) {
    if (!variant.sku) continue;
    const hit = index.bySku.get(variant.sku);
    if (hit) return { product: hit, via: "sku" };
  }
  return null;
}

// SKU 优先,其次标题;源变体无 SKU 且目标只有单个变体时视为同一变体
export function matchTargetVariant(
  source: ExportedVariant,
  product: TargetProduct,
): TargetVariant | null {
  if (source.sku) {
    const bySku = product.variants.find((v) => v.sku === source.sku);
    if (bySku) return bySku;
  }
  const byTitle = product.variants.find((v) => v.title === source.title);
  if (byTitle) return byTitle;
  if (!source.sku && product.variants.length === 1) return product.variants[0];
  return null;
}

export interface ResolvedProductWrite {
  match: ProductMatch;
  variantWrites: { source: ExportedVariant; target: TargetVariant }[];
  unmatchedVariants: ExportedVariant[];
}

export function resolveProductWrite(
  source: ExportedProduct,
  index: ProductIndex,
): ResolvedProductWrite | null {
  const match = matchTargetProduct(source, index);
  if (!match) return null;
  const variantWrites: ResolvedProductWrite["variantWrites"] = [];
  const unmatchedVariants: ExportedVariant[] = [];
  for (const variant of source.variants) {
    // 文件保留全部变体结构,但没有 metafield 的变体无需写入
    if (!variant.metafields.length) continue;
    const target = matchTargetVariant(variant, match.product);
    if (target) variantWrites.push({ source: variant, target });
    else unmatchedVariants.push(variant);
  }
  return { match, variantWrites, unmatchedVariants };
}

const variantLabel = (variant: ExportedVariant) =>
  variant.sku || variant.title || "(无 SKU)";

function planProducts(file: ProductsMigrationFile, index: ProductIndex): Plan {
  // 导出文件保留了没有 metafield 的商品结构,这类商品没有可写入内容,不进入预检列表
  const candidates = file.products.filter(
    (product) =>
      product.metafields.length ||
      product.variants.some((variant) => variant.metafields.length),
  );

  const items: PlanItem[] = candidates.map((source) => {
    const resolved = resolveProductWrite(source, index);
    if (!resolved) {
      return {
        kind: "product",
        identifier: source.handle,
        action: "skip",
        reason: "目标店铺未找到匹配的产品（handle 与变体 SKU 均未匹配）",
      };
    }

    const variantMetafieldCount = resolved.variantWrites.reduce(
      (total, write) => total + write.source.metafields.length,
      0,
    );
    const unmatchedNote = resolved.unmatchedVariants.length
      ? `未匹配变体: ${resolved.unmatchedVariants.map(variantLabel).join(", ")}`
      : null;

    if (!source.metafields.length && !variantMetafieldCount) {
      return {
        kind: "product",
        identifier: source.handle,
        action: "skip",
        reason: unmatchedNote
          ? `没有可写入的 metafield；${unmatchedNote}`
          : "没有可写入的 metafield",
      };
    }

    const parts: string[] = [];
    if (resolved.match.via === "sku") {
      parts.push(`handle 未匹配，按变体 SKU 匹配到目标产品 ${resolved.match.product.handle}`);
    }
    if (source.metafields.length) {
      parts.push(`产品 metafield ${source.metafields.length} 个`);
    }
    if (variantMetafieldCount) {
      parts.push(
        `变体 metafield ${variantMetafieldCount} 个（${resolved.variantWrites.length} 个变体）`,
      );
    }
    if (unmatchedNote) parts.push(unmatchedNote);
    return {
      kind: "product",
      identifier: source.handle,
      action: "update",
      reason: parts.join("; "),
    };
  });

  const summary: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    skip: 0,
    fail: 0,
  };
  for (const item of items) summary[item.action] += 1;
  return { items, summary };
}

export async function buildProductsPlan(
  graphql: Admin,
  file: ProductsMigrationFile,
): Promise<Plan> {
  const products = await fetchTargetProducts(graphql);
  return planProducts(file, buildProductIndex(products));
}

const METAFIELDS_PER_CALL = 25;

async function writeMetafields(
  graphql: Admin,
  ownerId: string,
  metafields: ExportedMetafieldValue[],
): Promise<string[]> {
  const errors: string[] = [];
  for (let i = 0; i < metafields.length; i += METAFIELDS_PER_CALL) {
    const chunk = metafields.slice(i, i + METAFIELDS_PER_CALL);
    const { error } = await runMutation<{ id: string }[]>(
      graphql,
      METAFIELDS_SET,
      {
        metafields: chunk.map((mf) => ({
          ownerId,
          namespace: mf.namespace,
          key: mf.key,
          type: mf.type,
          value: mf.value,
        })),
      },
      "metafieldsSet",
    );
    if (error) errors.push(error);
  }
  return errors;
}

const BATCH_SIZE = 5;

const itemKey = (kind: string, identifier: string) => `${kind}:${identifier}`;

// 产品不会被创建,写入不改变 plan,因此需要客户端回传已处理的项(done)才能收敛
export async function executeProductsBatch(
  graphql: Admin,
  file: ProductsMigrationFile,
  options: { done?: string[]; batchSize?: number } = {},
): Promise<{ results: ResultItem[]; pending: number }> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const done = new Set(options.done ?? []);

  const products = await fetchTargetProducts(graphql);
  const index = buildProductIndex(products);
  const plan = planProducts(file, index);
  const sourceByHandle = new Map(file.products.map((p) => [p.handle, p]));

  const results: ResultItem[] = [];
  let slots = batchSize;

  for (const item of plan.items) {
    if (slots <= 0) break;
    if (item.action !== "update") continue;
    if (done.has(itemKey(item.kind, item.identifier))) continue;
    const source = sourceByHandle.get(item.identifier);
    if (!source) continue;
    const resolved = resolveProductWrite(source, index);
    if (!resolved) continue;
    slots--;

    const errors = (
      await writeMetafields(graphql, resolved.match.product.id, source.metafields)
    ).map((e) => `产品: ${e}`);

    let variantMetafieldCount = 0;
    for (const write of resolved.variantWrites) {
      variantMetafieldCount += write.source.metafields.length;
      const variantErrors = await writeMetafields(
        graphql,
        write.target.id,
        write.source.metafields,
      );
      errors.push(
        ...variantErrors.map((e) => `变体 ${variantLabel(write.source)}: ${e}`),
      );
    }

    if (errors.length) {
      results.push({
        ...item,
        action: "fail",
        reason: `写入失败: ${errors.join("; ")}`,
      });
      continue;
    }
    results.push({
      ...item,
      detail: `已写入产品 metafield ${source.metafields.length} 个，变体 metafield ${variantMetafieldCount} 个（${resolved.variantWrites.length} 个变体）`,
    });
  }

  const executed = new Set(results.map((r) => itemKey(r.kind, r.identifier)));
  const pending = plan.items.filter(
    (i) =>
      i.action === "update" &&
      !done.has(itemKey(i.kind, i.identifier)) &&
      !executed.has(itemKey(i.kind, i.identifier)),
  ).length;

  return { results, pending };
}
