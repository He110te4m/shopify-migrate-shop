import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { parseMetafieldFilter } from "../migrate/metafields";
import { buildProductsMigrationFile } from "../migrate/products-export.server";

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const filter = parseMetafieldFilter(
    formData.get("mode"),
    formData.get("patterns"),
  );
  const productIds = parseProductIds(formData.get("productIds"));
  return await buildProductsMigrationFile(admin.graphql, session.shop, filter, {
    productIds,
  });
};

type SelectedProduct = { id: string; handle: string; title: string };

export default function ExportProductsPage() {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";
  const [selected, setSelected] = useState<SelectedProduct[]>([]);

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

  useEffect(() => {
    const file = fetcher.data;
    if (!file) return;
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
  }, [fetcher.data]);

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
          未选择产品时导出全部产品；使用「选择产品」只导出指定产品，导出范围会写入文件并在导入预检时展示。
        </s-paragraph>
      </s-section>

      <s-section heading="导出范围">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-button onClick={pickProducts}>选择产品</s-button>
            {selected.length > 0 && (
              <s-button
                variant="tertiary"
                onClick={() => setSelected([])}
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
        <fetcher.Form method="post">
          <input
            type="hidden"
            name="productIds"
            value={JSON.stringify(selected.map((product) => product.id))}
          />
          <s-stack direction="block" gap="base">
            <label htmlFor="mode">过滤模式</label>
            <select id="mode" name="mode" defaultValue="all">
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
            />
            <s-button
              type="submit"
              variant="primary"
              {...(isBusy ? { loading: true } : {})}
            >
              导出为 JSON
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
