import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { migrationRuns } from "../storage.server";
import { authenticate } from "../shopify.server";
import type { ImportReport, PlanAction } from "../migrate/types";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const run = await migrationRuns.get(session.shop, params.id!);
  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }
  return {
    createdAt: run.createdAt,
    fileName: run.fileName,
    report: JSON.parse(run.report) as ImportReport,
  };
};

const ACTION_LABEL: Record<PlanAction, string> = {
  create: "创建",
  update: "更新",
  skip: "跳过",
  fail: "失败",
};

const ACTION_TONE: Record<PlanAction, "success" | "info" | "warning" | "critical"> = {
  create: "success",
  update: "info",
  skip: "warning",
  fail: "critical",
};

const KIND_LABEL: Record<string, string> = {
  metaobject: "Metaobject",
  metafield: "Metafield",
  page: "Page",
};

export default function HistoryDetailPage() {
  const { createdAt, fileName, report } = useLoaderData<typeof loader>();

  return (
    <s-page heading="导入详情">
      <s-button slot="secondary-actions" href="/app/history" variant="tertiary">
        返回历史
      </s-button>
      <s-section
        heading={`${new Date(createdAt).toLocaleString()} · ${fileName ?? "未知文件"}：创建 ${report.summary.create} / 更新 ${report.summary.update} / 跳过 ${report.summary.skip} / 失败 ${report.summary.fail}`}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
              <th style={{ padding: "8px" }}>类型</th>
              <th style={{ padding: "8px" }}>标识</th>
              <th style={{ padding: "8px" }}>结果</th>
              <th style={{ padding: "8px" }}>说明</th>
              <th style={{ padding: "8px" }}>详情</th>
            </tr>
          </thead>
          <tbody>
            {report.results.map((item, index) => (
              <tr key={index} style={{ borderBottom: "1px solid #f1f2f4" }}>
                <td style={{ padding: "8px" }}>
                  {KIND_LABEL[item.kind] ?? item.kind}
                </td>
                <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.identifier}</td>
                <td style={{ padding: "8px" }}>
                  <s-badge tone={ACTION_TONE[item.action]}>{ACTION_LABEL[item.action]}</s-badge>
                </td>
                <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.reason ?? "-"}</td>
                <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.detail ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>
      <s-section heading="原始报告 JSON">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <code>{JSON.stringify(report, null, 2)}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
