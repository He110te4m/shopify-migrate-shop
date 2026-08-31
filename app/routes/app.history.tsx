import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { migrationRuns } from "../storage.server";
import { authenticate } from "../shopify.server";
import type { PlanAction } from "../migrate/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const runs = await migrationRuns.list(session.shop);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      createdAt: run.createdAt,
      fileName: run.fileName,
      summary: JSON.parse(run.summary) as Record<PlanAction, number>,
    })),
  };
};

export default function HistoryPage() {
  const { runs } = useLoaderData<typeof loader>();

  return (
    <s-page heading="迁移历史">
      <s-section heading="导入记录">
        {runs.length === 0 ? (
          <s-paragraph>暂无导入记录。</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                <th style={{ padding: "8px" }}>时间</th>
                <th style={{ padding: "8px" }}>文件</th>
                <th style={{ padding: "8px" }}>创建</th>
                <th style={{ padding: "8px" }}>更新</th>
                <th style={{ padding: "8px" }}>跳过</th>
                <th style={{ padding: "8px" }}>失败</th>
                <th style={{ padding: "8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} style={{ borderBottom: "1px solid #f1f2f4" }}>
                  <td style={{ padding: "8px" }}>{new Date(run.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "8px", wordBreak: "break-all" }}>{run.fileName ?? "-"}</td>
                  <td style={{ padding: "8px" }}>{run.summary.create}</td>
                  <td style={{ padding: "8px" }}>{run.summary.update}</td>
                  <td style={{ padding: "8px" }}>{run.summary.skip}</td>
                  <td style={{ padding: "8px" }}>
                    {run.summary.fail > 0 ? (
                      <s-badge tone="critical">{run.summary.fail}</s-badge>
                    ) : (
                      0
                    )}
                  </td>
                  <td style={{ padding: "8px" }}>
                    <s-link href={`/app/history/${run.id}`}>详情</s-link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
