import { useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { executeImport } from "../migrate/import.server";
import { buildPlan, parseMigrationFile } from "../migrate/validate.server";
import type { ImportReport, Plan, PlanAction, SkippedItem } from "../migrate/types";

type ActionData =
  | { mode: "plan"; fileName: string; plan: Plan; skipped: SkippedItem[] }
  | { mode: "report"; report: ImportReport }
  | { mode: "error"; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const uploaded = formData.get("file");

  if (!(uploaded instanceof File)) {
    return { mode: "error", message: "请选择要上传的 JSON 文件" };
  }

  let file;
  try {
    file = parseMigrationFile(await uploaded.text());
  } catch (error) {
    return {
      mode: "error",
      message: error instanceof Error ? error.message : "文件解析失败",
    };
  }

  if (intent === "validate") {
    const plan = await buildPlan(admin.graphql, file);
    return { mode: "plan", fileName: uploaded.name, plan, skipped: file.skipped };
  }

  if (intent === "execute") {
    const report = await executeImport(admin.graphql, file, session.shop, uploaded.name);
    return { mode: "report", report };
  }

  return { mode: "error", message: "未知操作" };
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

function ItemsTable({
  items,
  showDetail,
}: {
  items: { kind: string; identifier: string; action: PlanAction; reason?: string; detail?: string }[];
  showDetail?: boolean;
}) {
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "13px",
      }}
    >
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
          <th style={{ padding: "8px" }}>类型</th>
          <th style={{ padding: "8px" }}>标识</th>
          <th style={{ padding: "8px" }}>动作</th>
          <th style={{ padding: "8px" }}>说明</th>
          {showDetail ? <th style={{ padding: "8px" }}>详情</th> : null}
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index} style={{ borderBottom: "1px solid #f1f2f4" }}>
            <td style={{ padding: "8px" }}>
              {item.kind === "metaobject" ? "Metaobject" : "Metafield"}
            </td>
            <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.identifier}</td>
            <td style={{ padding: "8px" }}>
              <s-badge tone={ACTION_TONE[item.action]}>{ACTION_LABEL[item.action]}</s-badge>
            </td>
            <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.reason ?? "-"}</td>
            {showDetail ? (
              <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.detail ?? "-"}</td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ImportPage() {
  const fetcher = useFetcher<typeof action>();
  const [fileKey, setFileKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isBusy = fetcher.state !== "idle";
  const data = fetcher.data;

  const submit = (intent: "validate" | "execute") => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.set("intent", intent);
    formData.set("file", file);
    fetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  return (
    <s-page heading="导入定义">
      <s-section heading="上传定义文件">
        <s-paragraph>
          在目标店铺使用本页面。上传由源店铺导出的 JSON 文件，先执行预检（不会写入任何数据），确认无误后再正式导入。
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <input
            key={fileKey}
            ref={fileInputRef}
            type="file"
            name="file"
            accept="application/json,.json"
          />
          <s-stack direction="inline" gap="base">
            <s-button
              onClick={() => submit("validate")}
              {...(isBusy ? { loading: true } : {})}
            >
              预检
            </s-button>
            {data?.mode === "plan" && (
              <s-button
                onClick={() => submit("execute")}
                variant="primary"
                {...(isBusy ? { loading: true } : {})}
              >
                确认执行导入
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {data?.mode === "error" && (
        <s-banner tone="critical">{data.message}</s-banner>
      )}

      {data?.mode === "plan" && (
        <>
          <s-section
            heading={`预检结果：创建 ${data.plan.summary.create} / 更新 ${data.plan.summary.update} / 跳过 ${data.plan.summary.skip} / 失败 ${data.plan.summary.fail}`}
          >
            {data.plan.summary.fail > 0 && (
              <s-banner tone="warning">
                存在 {data.plan.summary.fail} 项失败（定义冲突或依赖缺失）。这些项不会被写入；其余项可正常导入。
              </s-banner>
            )}
            <ItemsTable items={data.plan.items} />
          </s-section>
          {data.skipped.length > 0 && (
            <s-section heading={`导出时已跳过的定义（${data.skipped.length}）`}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                    <th style={{ padding: "8px" }}>标识</th>
                    <th style={{ padding: "8px" }}>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {data.skipped.map((item, index) => (
                    <tr key={index} style={{ borderBottom: "1px solid #f1f2f4" }}>
                      <td style={{ padding: "8px", wordBreak: "break-all" }}>{item.identifier}</td>
                      <td style={{ padding: "8px" }}>{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </s-section>
          )}
        </>
      )}

      {data?.mode === "report" && (
        <s-section
          heading={`导入完成：创建 ${data.report.summary.create} / 更新 ${data.report.summary.update} / 跳过 ${data.report.summary.skip} / 失败 ${data.report.summary.fail}`}
        >
          {data.report.summary.fail > 0 ? (
            <s-banner tone="critical">
              有 {data.report.summary.fail} 项导入失败，请查看下表原因。本次记录已保存到「迁移历史」。
            </s-banner>
          ) : (
            <s-banner tone="success">全部定义导入成功，记录已保存到「迁移历史」。</s-banner>
          )}
          <ItemsTable items={data.report.results} showDetail />
          <s-stack direction="inline" gap="base">
            <s-link href="/app/history">查看迁移历史</s-link>
            <s-button
              onClick={() => {
                setFileKey((k) => k + 1);
              }}
              variant="tertiary"
            >
              继续导入其他文件
            </s-button>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
