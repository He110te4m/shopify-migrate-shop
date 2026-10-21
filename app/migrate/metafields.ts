import type {
  ExportedMetafieldValue,
  MetafieldFilter,
  MetafieldFilterMode,
  MigrationItemKind,
  SkippedItem,
} from "./types";

const FILTER_MODES: MetafieldFilterMode[] = ["all", "include", "exclude"];

// reference 类 metafield 的值是店铺内 GID,跨店铺不可解析
export function isNonPortableMetafieldType(type: string): boolean {
  return type.replace(/^list\./, "").endsWith("_reference");
}

export function isAppOwnedNamespace(namespace: string): boolean {
  return namespace === "$app" || namespace.startsWith("$app:");
}

export function metafieldIdentifier(mf: {
  namespace: string;
  key: string;
}): string {
  return `${mf.namespace}.${mf.key}`;
}

export function parseMetafieldFilter(
  mode: unknown,
  patterns: unknown,
): MetafieldFilter {
  const parsedMode = FILTER_MODES.includes(mode as MetafieldFilterMode)
    ? (mode as MetafieldFilterMode)
    : "all";
  const raw = typeof patterns === "string" ? patterns : "";
  const list = raw
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    mode: parsedMode,
    // all 模式不需要模式串,避免导出文件里出现无意义配置
    patterns: parsedMode === "all" ? [] : list,
  };
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\.\*$/, "");
}

// 不含点的规则按 namespace 全名匹配,含点的规则按 namespace.key 前缀匹配
function matchesPattern(
  mf: ExportedMetafieldValue,
  pattern: string,
): boolean {
  const normalized = normalizePattern(pattern);
  if (!normalized) return false;
  if (!normalized.includes(".")) return mf.namespace === normalized;
  return metafieldIdentifier(mf).startsWith(normalized);
}

export function matchesMetafieldFilter(
  mf: ExportedMetafieldValue,
  filter: MetafieldFilter,
): boolean {
  if (filter.mode === "all" || filter.patterns.length === 0) return true;
  const hit = filter.patterns.some((pattern) => matchesPattern(mf, pattern));
  return filter.mode === "include" ? hit : !hit;
}

export interface CollectOptions {
  filter: MetafieldFilter;
  kind: MigrationItemKind;
  // 跳过项的标识前缀,如产品 handle 或 `handle / sku`
  identifierPrefix: string;
  skipped: SkippedItem[];
}

// 过滤模式下不匹配的 metafield 静默排除(用户主动选择);
// app-owned 与 reference 类型无法迁移,记入 skipped 以便导出报告展示
export function collectMetafieldValues(
  metafields: ExportedMetafieldValue[],
  options: CollectOptions,
): ExportedMetafieldValue[] {
  const out: ExportedMetafieldValue[] = [];
  for (const mf of metafields) {
    if (!matchesMetafieldFilter(mf, options.filter)) continue;
    const identifier = `${options.identifierPrefix} ${metafieldIdentifier(mf)}`;
    if (isAppOwnedNamespace(mf.namespace)) {
      options.skipped.push({
        kind: options.kind,
        identifier,
        reason: "app-owned metafield（$app 命名空间）无法跨应用迁移",
      });
      continue;
    }
    if (isNonPortableMetafieldType(mf.type)) {
      options.skipped.push({
        kind: options.kind,
        identifier,
        reason: `metafield 类型 ${mf.type} 的值为店铺内 GID，跨店铺不可解析`,
      });
      continue;
    }
    out.push(mf);
  }
  return out;
}
