import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { parseMetafieldFilter } from "../migrate/metafields";
import { exportProductsChunk } from "../migrate/products-export.server";
import { fetchProductIds } from "../migrate/products-graphql.server";
import type {
  ExportedProduct,
  MetafieldFilter,
  ProductsMigrationFile,
  SkippedItem,
} from "../migrate/types";

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

// 每批 10 个产品(约 20 次 GraphQL 请求),避免单个请求超过函数超时
const CHUNK_SIZE = 10;

function parseProductIds(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is string =>
        typeof value === "string" && PRODUCT_GID.test(value),
    );
  } catch {
    return [];
  }
}

type ActionData =
  | { mode: "ids"; ids: string[]; shop: string; filter: MetafieldFilter }
  | {
      mode: "chunk";
      products: ExportedProduct[];
      skipped: SkippedItem[];
      shop: string;
    }
  | { mode: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const filter = parseMetafieldFilter(
    formData.get("mode"),
    formData.get("patterns"),
  );

  if (intent === "ids") {
    const selected = parseProductIds(formData.get("productIds"));
    const ids = selected.length
      ? selected
      : await fetchProductIds(admin.graphql);
    return { mode: "ids", ids, shop: session.shop, filter };
  }

  if (intent === "chunk") {
    const ids = parseProductIds(formData.get("productIds"));
    const { products, skipped } = await exportProductsChunk(
      admin.graphql,
      filter,
      ids,
    );
    return { mode: "chunk", products, skipped, shop: session.shop };
  }

  return { mode: "error", message: "未知操作" };
};

type SelectedProduct = { id: string; handle: string; title: string };

export default function ExportProductsPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const modeRef = useRef<HTMLSelectElement>(null);
  const patternsRef = useRef<HTMLTextAreaElement>(null);

  const [selected, setSelected] = useState<SelectedProduct[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<{
    products: number;
    metafields: number;
    skipped: number;
  } | null>(null);

  const queueRef = useRef<string[]>([]);
  const productsRef = useRef<ExportedProduct[]>([]);
  const skippedRef = useRef<SkippedItem[]>([]);
  const metaRef = useRef<{ shop: string; filter: MetafieldFilter } | null>(null);
  const selectedHandlesRef = useRef<string[]>([]);
  const handledRef = useRef<ActionData | null>(null);

  const busy = progress !== null;

  const submitChunk = () => {
    const ids = queueRef.current.splice(0, CHUNK_SIZE);
    const formData = new FormData();
    formData.set("intent", "chunk");
    formData.set("productIds", JSON.stringify(ids));
    formData.set("mode", metaRef.current?.filter.mode ?? "all");
    formData.set(
      "patterns",
      (metaRef.current?.filter.patterns ?? []).join("\n"),
    );
    fetcher.submit(formData, { method: "post" });
  };

  const finish = () => {
    const meta = metaRef.current;
    if (!meta) return;
    const file: ProductsMigrationFile = {
      version: 1,
      kind: "products",
      exportedAt: new Date().toISOString(),
      shop: meta.shop,
      filter: meta.filter,
      // 空数组表示导出全部产品
      productHandles: selectedHandlesRef.current,
      products: productsRef.current,
      skipped: skippedRef.current,
    };

    const metafields = productsRef.current.reduce(
      (total, product) =>
        total +
        product.metafields.length +
        product.variants.reduce((n, variant) => n + variant.metafields.length, 0),
      0,
    );
    setLastFile({
      products: file.products.length,
      metafields,
      skipped: file.skipped.length,
    });

    const date = file.exportedAt.slice(0, 10);
    const blob = new Blob([JSON.stringify(file, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shopify-products-${file.shop}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setProgress(null);
  };

  const startExport = () => {
    setError(null);
    setLastFile(null);
    productsRef.current = [];
    skippedRef.current = [];
    queueRef.current = [];
    metaRef.current = null;
    selectedHandlesRef.current = selected.map((product) => product.handle);
    setProgress({ done: 0, total: 0 });

    const formData = new FormData();
    formData.set("intent", "ids");
    formData.set("productIds", JSON.stringify(selected.map((p) => p.id)));
    formData.set("mode", modeRef.current?.value ?? "all");
    formData.set("patterns", patternsRef.current?.value ?? "");
    fetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    const data = fetcher.data;
    if (!data || handledRef.current === data) return;
    handledRef.current = data;

    if (data.mode === "error") {
      setError(data.message);
      setProgress(null);
      return;
    }

    if (data.mode === "ids") {
      metaRef.current = { shop: data.shop, filter: data.filter };
      queueRef.current = data.ids;
      setProgress({ done: 0, total: data.ids.length });
      if (!data.ids.length) {
        finish();
        return;
      }
      submitChunk();
      return;
    }

    productsRef.current.push(...data.products);
    skippedRef.current.push(...data.skipped);
    setProgress((current) => ({
      done: productsRef.current.length,
      total: current?.total ?? productsRef.current.length,
    }));
    if (queueRef.current.length) {
      submitChunk();
      return;
    }
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const pickProducts = async () => {
    const result = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      filter: { variants: false, draft: true, archived: true, hidden: true },
    });
    if (!result) return;
    setSelected(
      result.map((product) => ({
        id: product.id,
        handle: product.handle,
        title: product.title,
      })),
    );
  };

  const removeProduct = (id: string) => {
    setSelected((current) => current.filter((product) => product.id !== id));
  };

  return (
    <s-page heading="导出产品">
      <s-section heading="导出产品与变体 metafield 值">
        <s-paragraph>
          在源店铺使用本页面。点击按钮将逐个读取当前店铺的产品与变体
          metafield 值，并下载为一个 JSON 文件。随后到目标店铺的「导入产品」页面上传该文件。
        </s-paragraph>
        <s-paragraph>
          仅导出 metafield 值，不迁移产品标题、价格、图片等基础字段，也不会在目标店铺创建商品。
          app-owned metafield（$app 命名空间）与 reference 类型（产品、变体、文件等引用，值为源店铺
          GID）无法跨店铺迁移，会在导出文件中列为跳过项。
        </s-paragraph>
        <s-paragraph>
          文件包含全部商品与变体条目（没有 metafield 的条目也会保留，metafields 为空数组），
          便于核对导出范围。导出按每批 10 个商品分批执行，商品较多时请保持页面打开。
        </s-paragraph>
      </s-section>

      <s-section heading="导出范围">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-button onClick={pickProducts} {...(busy ? { disabled: true } : {})}>
              选择产品
            </s-button>
            {selected.length > 0 && (
              <s-button
                variant="tertiary"
                onClick={() => setSelected([])}
                {...(busy ? { disabled: true } : {})}
              >
                清空选择
              </s-button>
            )}
          </s-stack>
          <s-paragraph>
            {selected.length > 0
              ? `已选择 ${selected.length} 个产品（含其全部变体）`
              : "未选择产品：将导出全部产品"}
          </s-paragraph>
          {selected.length > 0 && (
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}
            >
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "8px" }}>产品</th>
                  <th style={{ padding: "8px" }}>handle</th>
                  <th style={{ padding: "8px" }} />
                </tr>
              </thead>
              <tbody>
                {selected.map((product) => (
                  <tr key={product.id} style={{ borderBottom: "1px solid #f1f2f4" }}>
                    <td style={{ padding: "8px", wordBreak: "break-all" }}>{product.title}</td>
                    <td style={{ padding: "8px", wordBreak: "break-all" }}>{product.handle}</td>
                    <td style={{ padding: "8px" }}>
                      <s-button
                        variant="tertiary"
                        onClick={() => removeProduct(product.id)}
                        {...(busy ? { disabled: true } : {})}
                      >
                        移除
                      </s-button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </s-stack>
      </s-section>

      <s-section heading="metafield 过滤">
        <s-paragraph>
          过滤规则：只写 namespace 时匹配该命名空间下的全部 key（全名匹配）；写成{" "}
          <code>namespace.key</code> 时按 key 前缀匹配。每行一条，也可用逗号分隔，
          留空表示不过滤。过滤配置会写入导出文件，导入预检时原样展示。
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <label htmlFor="mode">过滤模式</label>
          <select id="mode" name="mode" defaultValue="all" ref={modeRef}>
            <option value="all">全部导出（不过滤）</option>
            <option value="include">仅导出匹配项</option>
            <option value="exclude">排除匹配项</option>
          </select>
          <label htmlFor="patterns">匹配规则</label>
          <textarea
            id="patterns"
            name="patterns"
            rows={4}
            placeholder={"custom\ncustom.my_key"}
            ref={patternsRef}
          />
          <s-button
            variant="primary"
            onClick={startExport}
            {...(busy ? { loading: true } : {})}
          >
            导出为 JSON
          </s-button>
        </s-stack>
      </s-section>

      {error && <s-banner tone="critical">{error}</s-banner>}

      {progress && (
        <s-banner tone="info">
          正在导出：已处理 {progress.done} / {progress.total} 个商品，请勿关闭页面。
        </s-banner>
      )}

      {lastFile && !progress && !error && (
        <s-banner tone="success">
          导出完成：{lastFile.products} 个商品，{lastFile.metafields} 条 metafield
          值，{lastFile.skipped} 条跳过项。文件已开始下载。
        </s-banner>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
