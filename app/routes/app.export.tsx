import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { buildMigrationFile } from "../migrate/export.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return await buildMigrationFile(admin.graphql, session.shop);
};

export default function ExportPage() {
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

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
    a.download = `shopify-definitions-${file.shop}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fetcher.data]);

  return (
    <s-page heading="导出定义">
      <s-section heading="导出 metaobject 与 metafield 定义">
        <s-paragraph>
          在源店铺使用本页面。点击按钮将拉取当前店铺的全部 metaobject
          定义与所有资源类型的 metafield 定义，并下载为一个 JSON
          文件。随后到目标店铺的「导入定义」页面上传该文件。
        </s-paragraph>
        <s-paragraph>
          仅迁移定义结构，不包含任何 metaobject 条目或 metafield 的具体值。
          app-owned 定义（$app 前缀）无法跨应用迁移，将在导出文件中列为跳过项。
        </s-paragraph>
        <fetcher.Form method="post">
          <s-button
            type="submit"
            variant="primary"
            {...(isBusy ? { loading: true } : {})}
          >
            导出为 JSON
          </s-button>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
