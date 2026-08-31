import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { buildMigrationFile } from "../migrate/export.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const file = await buildMigrationFile(admin.graphql, session.shop);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `shopify-definitions-${session.shop}-${date}.json`;
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};

export default function ExportPage() {
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
        <Form method="post">
          <s-button type="submit" variant="primary">
            导出为 JSON
          </s-button>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
