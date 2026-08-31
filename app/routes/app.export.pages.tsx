import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { buildPagesMigrationFile } from "../migrate/pages-export.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return await buildPagesMigrationFile(admin.graphql, session.shop);
};

export default function ExportPagesPage() {
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
    a.download = `shopify-pages-${file.shop}-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fetcher.data]);

  return (
    <s-page heading="导出页面">
      <s-section heading="导出全部页面">
        <s-paragraph>
          在源店铺使用本页面。点击按钮将拉取当前店铺的全部在线商店页面（包括
          SEO 标题/描述与页面 metafield 值），并下载为一个 JSON
          文件。随后到目标店铺的「导入页面」页面上传该文件。
        </s-paragraph>
        <s-paragraph>
          注意事项：reference 类型（产品、metaobject、文件等引用）的 metafield
          值指向源店铺数据，无法跨店铺解析，将在导出文件中列为跳过项；页面正文中的图片/文件链接保持原样，
          仍指向源店铺 CDN。
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
