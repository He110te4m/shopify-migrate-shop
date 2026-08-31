import type { Validation } from "./types";

export const METAOBJECT_REF_VALIDATION = "metaobject_definition_id";

const REF_KEY = "$mo";
const GID_PREFIX = "gid://shopify/MetaobjectDefinition/";

function isRawGid(value: string): boolean {
  return value.startsWith(GID_PREFIX);
}

function parseGidList(value: string): string[] | null {
  if (isRawGid(value)) return [value];
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((v) => typeof v === "string" && isRawGid(v))
    ) {
      return parsed as string[];
    }
  } catch {
    // not a gid list
  }
  return null;
}

function parseMarkerList(
  value: string,
): { types: string[]; isList: boolean } | null {
  const readMarker = (v: unknown): string | null =>
    v !== null &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>)[REF_KEY] === "string"
      ? ((v as Record<string, unknown>)[REF_KEY] as string)
      : null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const types = parsed.map(readMarker);
      if (types.every((t): t is string => t !== null))
        return { types, isList: true };
      return null;
    }
    const single = readMarker(parsed);
    if (single !== null) return { types: [single], isList: false };
  } catch {
    // not a marker
  }
  return null;
}

/**
 * Export: rewrite a raw metaobject_definition_id validation value (GID(s))
 * into portable marker form referencing the metaobject `type` string.
 * Returns null when any referenced GID is unknown.
 */
export function exportRefValue(
  value: string,
  gidToType: Map<string, string>,
): string | null {
  const gids = parseGidList(value);
  if (!gids) return value;
  const types: string[] = [];
  for (const gid of gids) {
    const type = gidToType.get(gid);
    if (!type) return null;
    types.push(type);
  }
  if (isRawGid(value)) return JSON.stringify({ [REF_KEY]: types[0] });
  return JSON.stringify(types.map((t) => ({ [REF_KEY]: t })));
}

/**
 * Import: resolve an exported marker value back to target-store GID(s).
 * Returns null when any referenced type has no target GID.
 */
export function resolveRefValue(
  value: string,
  typeToGid: Map<string, string>,
): string | null {
  const parsed = parseMarkerList(value);
  if (!parsed) return value;
  const gids: string[] = [];
  for (const type of parsed.types) {
    const gid = typeToGid.get(type);
    if (!gid) return null;
    gids.push(gid);
  }
  return parsed.isList ? JSON.stringify(gids) : gids[0];
}

/** Collect referenced metaobject types from an exported marker value. */
export function refTypesOf(value: string): string[] {
  return parseMarkerList(value)?.types ?? [];
}

/**
 * Convert a validation value to a comparable portable form:
 * raw GIDs and exported markers both become `type:<metaobjectType>` tokens.
 * Returns null when a raw GID cannot be mapped.
 */
export function portableRefValue(
  value: string,
  gidToType: Map<string, string>,
): string | null {
  const gids = parseGidList(value);
  if (gids) {
    const types: string[] = [];
    for (const gid of gids) {
      const type = gidToType.get(gid);
      if (!type) return null;
      types.push(`type:${type}`);
    }
    return isRawGid(value) ? types[0] : JSON.stringify(types);
  }
  const markers = parseMarkerList(value);
  if (markers) {
    const tokens = markers.types.map((t) => `type:${t}`);
    return markers.isList ? JSON.stringify(tokens) : tokens[0];
  }
  return value;
}

export function exportValidations(
  validations: Validation[],
  gidToType: Map<string, string>,
): { validations: Validation[]; unknownRef: boolean } {
  let unknownRef = false;
  const out = validations.map((v) => {
    if (v.name !== METAOBJECT_REF_VALIDATION) return { ...v };
    const rewritten = exportRefValue(v.value, gidToType);
    if (rewritten === null) {
      unknownRef = true;
      return { ...v };
    }
    return { name: v.name, value: rewritten };
  });
  return { validations: out, unknownRef };
}

export function resolveValidations(
  validations: Validation[],
  typeToGid: Map<string, string>,
): { validations: Validation[]; missingTypes: string[] } {
  const missing = new Set<string>();
  const out = validations.map((v) => {
    if (v.name !== METAOBJECT_REF_VALIDATION) return { ...v };
    for (const t of refTypesOf(v.value)) {
      if (!typeToGid.has(t)) missing.add(t);
    }
    const resolved = resolveRefValue(v.value, typeToGid);
    return resolved === null ? { ...v } : { name: v.name, value: resolved };
  });
  return { validations: out, missingTypes: [...missing] };
}

export function referencedMetaobjectTypes(validations: Validation[]): string[] {
  const types = new Set<string>();
  for (const v of validations) {
    if (v.name !== METAOBJECT_REF_VALIDATION) continue;
    for (const t of refTypesOf(v.value)) types.add(t);
  }
  return [...types];
}

/** Normalized, order-insensitive comparable form of validations. */
export function normalizeValidations(
  validations: Validation[],
  gidToType: Map<string, string>,
): string[] {
  return validations
    .map((v) => {
      const value =
        v.name === METAOBJECT_REF_VALIDATION
          ? (portableRefValue(v.value, gidToType) ?? v.value)
          : v.value;
      return `${v.name}=${value}`;
    })
    .sort();
}
