import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { executeBatch, saveImportReport } from "../migrate/import.server";
import { buildPlan, parseMigrationFile } from "../migrate/validate.server";
import type { ImportReport, Plan, PlanAction, PlanItem, ResultItem, SkippedItem } from "../migrate/types";

type ActionData =
  | { mode: "plan"; fileName: string; plan: Plan; skipped: SkippedItem[] }
  | { mode: "batch"; results: ResultItem[]; pending: number }
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

  if (intent === "report") {
    try {
      const results = JSON.parse(String(formData.get("results"))) as ResultItem[];
      const fileName = formData.get("fileName");
      const report = await saveImportReport(
        session.shop,
        typeof fileName === "string" ? fileName : undefined,
        results,
      );
      return { mode: "report", report };
    } catch {
      return { mode: "error", message: "导入报告保存失败" };
    }
  }

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

  if (intent === "batch") {
    let exclude: string[] = [];
    try {
      const raw = formData.get("exclude");
      if (typeof raw === "string" && raw) exclude = JSON.parse(raw);
    } catch {
      exclude = [];
    }
    const { results, pending } = await executeBatch(admin.graphql, file, { exclude });
    return { mode: "batch", results, pending };
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

const itemKey = (item: { kind: string; identifier: string }) =>
  `${item.kind}:${item.identifier}`;

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

  const [planData, setPlanData] = useState<
    Extract<ActionData, { mode: "plan" }> | null
  >(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; pending: number } | null>(null);

  const planRef = useRef<Extract<ActionData, { mode: "plan" }> | null>(null);
  const resultsRef = useRef(new Map<string, ResultItem>());
  const excludeRef = useRef<string[]>([]);
  const handledRef = useRef<ActionData | null>(null);

  const submitWithFile = (intent: "validate" | "batch") => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("请选择要上传的 JSON 文件");
      setRunning(false);
      return;
    }
    const formData = new FormData();
    formData.set("intent", intent);
    formData.set("file", file);
    if (intent === "batch") {
      formData.set("exclude", JSON.stringify(excludeRef.current));
    }
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  useEffect(() => {
    const data = fetcher.data;
    if (!data || handledRef.current === data) return;
    handledRef.current = data;

    if (data.mode === "error") {
      setError(data.message);
      setRunning(false);
      return;
    }
    if (data.mode === "plan") {
      planRef.current = data;
      setPlanData(data);
      setReport(null);
      setError(null);
      setProgress(null);
      setRunning(false);
      return;
    }
    if (data.mode === "batch") {
      for (const r of data.results) {
        resultsRef.current.set(itemKey(r), r);
        if (r.action === "fail") excludeRef.current.push(itemKey(r));
      }
      setProgress({ processed: resultsRef.current.size, pending: data.pending });
      if (data.pending > 0) {
        submitWithFile("batch");
        return;
      }
      const planItems: PlanItem[] = planRef.current?.plan.items ?? [];
      const finalResults = planItems.map(
        (item) => resultsRef.current.get(itemKey(item)) ?? item,
      );
      const formData = new FormData();
      formData.set("intent", "report");
      formData.set("results", JSON.stringify(finalResults));
      if (planRef.current?.fileName) {
        formData.set("fileName", planRef.current.fileName);
      }
      fetcher.submit(formData, { method: "post" });
      return;
    }
    if (data.mode === "report") {
      setReport(data.report);
      setRunning(false);
      setProgress(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const startImport = () => {
    resultsRef.current = new Map();
    excludeRef.current = [];
    const plan = planRef.current?.plan;
    setRunning(true);
    setError(null);
    setProgress({
      processed: 0,
      pending: plan ? plan.summary.create + plan.summary.update : 0,
    });
    submitWithFile("batch");
  };

  const validating = fetcher.state !== "idle" && !running && !report;

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
              onClick={() => submitWithFile("validate")}
              {...(validating || running ? { loading: true } : {})}
            >
              预检
            </s-button>
            {planData && !running && !report && (
              <s-button onClick={startImport} variant="primary">
                确认执行导入
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {error && <s-banner tone="critical">{error}</s-banner>}

      {running && progress && (
        <s-banner tone="info">
          正在分批导入：已处理 {progress.processed} 项，剩余约 {progress.pending}
          项。请勿关闭页面。
        </s-banner>
      )}

      {planData && !report && (
        <>
          <s-section
            heading={`预检结果：创建 ${planData.plan.summary.create} / 更新 ${planData.plan.summary.update} / 跳过 ${planData.plan.summary.skip} / 失败 ${planData.plan.summary.fail}`}
          >
            {planData.plan.summary.fail > 0 && (
              <s-banner tone="warning">
                存在 {planData.plan.summary.fail} 项失败（定义冲突或依赖缺失）。这些项不会被写入；其余项可正常导入。
              </s-banner>
            )}
            <ItemsTable items={planData.plan.items} />
          </s-section>
          {planData.skipped.length > 0 && (
            <s-section heading={`导出时已跳过的定义（${planData.skipped.length}）`}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                    <th style={{ padding: "8px" }}>标识</th>
                    <th style={{ padding: "8px" }}>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {planData.skipped.map((item, index) => (
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

      {report && (
        <s-section
          heading={`导入完成：创建 ${report.summary.create} / 更新 ${report.summary.update} / 跳过 ${report.summary.skip} / 失败 ${report.summary.fail}`}
        >
          {report.summary.fail > 0 ? (
            <s-banner tone="critical">
              有 {report.summary.fail} 项导入失败，请查看下表原因。本次记录已保存到「迁移历史」。
            </s-banner>
          ) : (
            <s-banner tone="success">全部定义导入成功，记录已保存到「迁移历史」。</s-banner>
          )}
          <ItemsTable items={report.results} showDetail />
          <s-stack direction="inline" gap="base">
            <s-link href="/app/history">查看迁移历史</s-link>
            <s-button
              onClick={() => {
                setPlanData(null);
                planRef.current = null;
                setReport(null);
                setError(null);
                setProgress(null);
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
