import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { runMutation } from "./graphql.server";
import {
  fetchAllPages,
  METAFIELDS_SET,
  PAGE_CREATE,
} from "./pages-graphql.server";
import type {
  ExportedPage,
  PagesMigrationFile,
  Plan,
  PlanAction,
  PlanItem,
  ResultItem,
} from "./types";

type Admin = AdminApiContext["graphql"];

export function parsePagesFile(raw: string): PagesMigrationFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("文件不是合法的 JSON");
  }
  const file = parsed as Partial<PagesMigrationFile>;
  if (
    !file ||
    file.version !== 1 ||
    file.kind !== "pages" ||
    !Array.isArray(file.pages)
  ) {
    throw new Error("文件格式不正确，请使用本应用导出的页面迁移文件");
  }
  return {
    ...file,
    skipped: Array.isArray(file.skipped) ? file.skipped : [],
  } as PagesMigrationFile;
}

export async function buildPagesPlan(
  graphql: Admin,
  file: PagesMigrationFile,
): Promise<Plan> {
  const targetPages = await fetchAllPages(graphql);
  return planPages(file, new Set(targetPages.map((p) => p.handle)));
}

function planPages(
  file: PagesMigrationFile,
  targetHandles: Set<string>,
): Plan {
  const items: PlanItem[] = file.pages.map((page) =>
    targetHandles.has(page.handle)
      ? {
          kind: "page",
          identifier: page.handle,
          action: "skip",
          reason: "目标店铺已存在相同 handle 的页面",
        }
      : { kind: "page", identifier: page.handle, action: "create" },
  );
  const summary: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    skip: 0,
    fail: 0,
  };
  for (const item of items) summary[item.action] += 1;
  return { items, summary };
}

function buildPageCreateInput(page: ExportedPage) {
  return {
    title: page.title,
    handle: page.handle,
    body: page.body,
    isPublished: page.isPublished,
    ...(page.templateSuffix ? { templateSuffix: page.templateSuffix } : {}),
  };
}

const METAFIELDS_PER_CALL = 25;

async function writePageMetafields(
  graphql: Admin,
  page: ExportedPage,
  ownerId: string,
): Promise<string | undefined> {
  if (!page.metafields.length) return undefined;
  const errors: string[] = [];
  for (let i = 0; i < page.metafields.length; i += METAFIELDS_PER_CALL) {
    const chunk = page.metafields.slice(i, i + METAFIELDS_PER_CALL);
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
  return errors.length
    ? `页面已创建，但部分 metafield 写入失败: ${errors.join("; ")}`
    : undefined;
}

const BATCH_SIZE = 10;

const itemKey = (kind: string, identifier: string) => `${kind}:${identifier}`;

// 与定义导入相同的分批模式:每批重新拉取目标页面并重算计划(天然幂等),
// 只执行前 batchSize 个 create 项;exclude 中的项(上一批已失败)直接跳过
export async function executePagesBatch(
  graphql: Admin,
  file: PagesMigrationFile,
  options: { exclude?: string[]; batchSize?: number } = {},
): Promise<{ results: ResultItem[]; pending: number }> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const exclude = new Set(options.exclude ?? []);

  const targetPages = await fetchAllPages(graphql);
  const plan = planPages(file, new Set(targetPages.map((p) => p.handle)));

  const sourcePageByHandle = new Map(file.pages.map((p) => [p.handle, p]));
  const targetHandles = new Set(targetPages.map((p) => p.handle));

  const results: ResultItem[] = [];
  let slots = batchSize;

  for (const item of plan.items) {
    if (slots <= 0) break;
    if (item.action !== "create") continue;
    if (exclude.has(itemKey(item.kind, item.identifier))) continue;
    const page = sourcePageByHandle.get(item.identifier);
    if (!page || targetHandles.has(page.handle)) continue;
    slots--;

    const { data, error } = await runMutation<{ id: string }>(
      graphql,
      PAGE_CREATE,
      { page: buildPageCreateInput(page) },
      "pageCreate",
    );
    if (error || !data) {
      results.push({
        ...item,
        action: "fail",
        reason: `创建失败: ${error ?? "无数据返回"}`,
      });
      continue;
    }
    const detail = await writePageMetafields(graphql, page, data.id);
    results.push({ ...item, detail });
  }

  const executed = new Set(results.map((r) => itemKey(r.kind, r.identifier)));
  const pending = plan.items.filter(
    (i) =>
      i.action === "create" &&
      !exclude.has(itemKey(i.kind, i.identifier)) &&
      !executed.has(itemKey(i.kind, i.identifier)),
  ).length;

  return { results, pending };
}
