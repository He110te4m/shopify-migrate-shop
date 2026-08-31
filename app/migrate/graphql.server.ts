import type {
  MetaobjectCapabilities,
  MetaobjectDef,
  MetafieldDef,
  Validation,
} from "./types";

export interface FetchedMetaobjectDef extends MetaobjectDef {
  id: string;
}

export interface FetchedMetafieldDef extends MetafieldDef {
  id: string;
}

export const METAFIELD_OWNER_TYPES = [
  "PRODUCT",
  "PRODUCTVARIANT",
  "COLLECTION",
  "CUSTOMER",
  "ORDER",
  "DRAFTORDER",
  "SHOP",
  "PAGE",
  "BLOG",
  "ARTICLE",
  "MARKET",
  "LOCATION",
  "DISCOUNT",
  "COMPANY",
  "COMPANY_LOCATION",
] as const;

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface RawValidation {
  name: string;
  value: string;
}

interface RawMetaobjectDefinitionNode {
  id: string;
  type: string;
  name: string;
  description: string | null;
  access: { admin: string; storefront: string } | null;
  fieldDefinitions: {
    key: string;
    name: string;
    description: string | null;
    required: boolean;
    type: { name: string };
    validations: RawValidation[];
  }[];
  capabilities: {
    publishable: { enabled: boolean };
    translatable: { enabled: boolean };
    renderable: { enabled: boolean };
  } | null;
}

interface RawMetafieldDefinitionNode {
  id: string;
  ownerType: string;
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  pinnedPosition: number | null;
  type: { name: string };
  validations: RawValidation[];
  access: { admin: string | null; storefront: string | null } | null;
}

export interface FetchedDefinitions {
  metaobjects: FetchedMetaobjectDef[];
  metafields: FetchedMetafieldDef[];
  gidToMetaobjectType: Map<string, string>;
}

const METAOBJECT_DEFINITIONS_QUERY = `#graphql
  query MigrationMetaobjectDefinitions($first: Int!, $after: String) {
    metaobjectDefinitions(first: $first, after: $after) {
      nodes {
        id
        type
        name
        description
        access {
          admin
          storefront
        }
        fieldDefinitions {
          key
          name
          description
          required
          type {
            name
          }
          validations {
            name
            value
          }
        }
        capabilities {
          publishable {
            enabled
          }
          translatable {
            enabled
          }
          renderable {
            enabled
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query MigrationMetafieldDefinitions($ownerType: MetafieldOwnerType!, $first: Int!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: $first, after: $after) {
      nodes {
        id
        ownerType
        namespace
        key
        name
        description
        pinnedPosition
        type {
          name
        }
        validations {
          name
          value
        }
        access {
          admin
          storefront
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function mapCapabilities(
  raw: RawMetaobjectDefinitionNode["capabilities"],
): MetaobjectCapabilities | null {
  if (!raw) return null;
  return {
    publishable: raw.publishable?.enabled ?? false,
    translatable: raw.translatable?.enabled ?? false,
    renderable: raw.renderable?.enabled ?? false,
  };
}

export async function fetchMetaobjectDefinitions(
  graphql: AdminGraphql,
): Promise<FetchedMetaobjectDef[]> {
  const defs: FetchedMetaobjectDef[] = [];
  let after: string | null = null;
  do {
    const response = await graphql(METAOBJECT_DEFINITIONS_QUERY, {
      variables: { first: 250, after },
    });
    const body = (await response.json()) as {
      data?: {
        metaobjectDefinitions: {
          nodes: RawMetaobjectDefinitionNode[];
          pageInfo: PageInfo;
        };
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) {
      throw new Error(
        `查询 metaobject 定义失败: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const connection = body.data?.metaobjectDefinitions;
    if (!connection) throw new Error("查询 metaobject 定义失败: 无数据返回");
    for (const node of connection.nodes) {
      defs.push({
        id: node.id,
        type: node.type,
        name: node.name,
        description: node.description,
        access: node.access,
        capabilities: mapCapabilities(node.capabilities),
        fieldDefinitions: node.fieldDefinitions.map((f) => ({
          key: f.key,
          name: f.name,
          type: f.type.name,
          required: f.required,
          description: f.description,
          validations: f.validations as Validation[],
        })),
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return defs;
}

export async function fetchMetafieldDefinitions(
  graphql: AdminGraphql,
): Promise<FetchedMetafieldDef[]> {
  const defs: FetchedMetafieldDef[] = [];
  for (const ownerType of METAFIELD_OWNER_TYPES) {
    let after: string | null = null;
    do {
      const response = await graphql(METAFIELD_DEFINITIONS_QUERY, {
        variables: { ownerType, first: 250, after },
      });
      const body = (await response.json()) as {
        data?: {
          metafieldDefinitions: {
            nodes: RawMetafieldDefinitionNode[];
            pageInfo: PageInfo;
          };
        };
        errors?: { message: string }[];
      };
      if (body.errors?.length) {
        throw new Error(
          `查询 metafield 定义失败 (${ownerType}): ${body.errors
            .map((e) => e.message)
            .join("; ")}`,
        );
      }
      const connection = body.data?.metafieldDefinitions;
      if (!connection) break;
      for (const node of connection.nodes) {
        defs.push({
          id: node.id,
          ownerType: node.ownerType,
          namespace: node.namespace,
          key: node.key,
          name: node.name,
          type: node.type.name,
          description: node.description,
          validations: node.validations as Validation[],
          pinnedPosition: node.pinnedPosition,
          access: node.access,
        });
      }
      after = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
    } while (after);
  }
  return defs;
}

export async function fetchAllDefinitions(
  graphql: AdminGraphql,
): Promise<FetchedDefinitions> {
  const metaobjects = await fetchMetaobjectDefinitions(graphql);
  const metafields = await fetchMetafieldDefinitions(graphql);
  const gidToMetaobjectType = new Map(metaobjects.map((d) => [d.id, d.type]));
  return { metaobjects, metafields, gidToMetaobjectType };
}

export const METAOBJECT_DEFINITION_CREATE = `#graphql
  mutation MigrationMetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
        type
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const METAOBJECT_DEFINITION_UPDATE = `#graphql
  mutation MigrationMetaobjectDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition {
        id
        type
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation MigrationMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const METAFIELD_DEFINITION_UPDATE = `#graphql
  mutation MigrationMetafieldDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface UserError {
  field: string[] | null;
  message: string;
  code?: string | null;
}

export function formatUserErrors(errors: UserError[]): string {
  return errors
    .map((e) => `${e.code ? `[${e.code}] ` : ""}${e.message}`)
    .join("; ");
}

interface MutationPayload<T> {
  userErrors: UserError[];
  [key: string]: T | UserError[] | null;
}

function extractGraphQLError(error: unknown): string {
  const gqlErrors = (
    error as {
      body?: { errors?: { graphQLErrors?: { message: string }[] } };
    }
  )?.body?.errors?.graphQLErrors;
  if (gqlErrors?.length) {
    return gqlErrors.map((e) => e.message).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runMutation<T>(
  graphql: AdminGraphql,
  query: string,
  variables: Record<string, unknown>,
  payloadKey: string,
): Promise<{ data: T | null; error: string | null }> {
  let response: Response;
  try {
    response = await graphql(query, { variables });
  } catch (error) {
    return { data: null, error: extractGraphQLError(error) };
  }
  const body = (await response.json()) as {
    data?: Record<string, MutationPayload<T>>;
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    return {
      data: null,
      error: body.errors.map((e) => e.message).join("; "),
    };
  }
  const payload = body.data?.[payloadKey];
  if (!payload) return { data: null, error: "无数据返回" };
  if (payload.userErrors.length) {
    return { data: null, error: formatUserErrors(payload.userErrors) };
  }
  return { data: payload as unknown as T, error: null };
}
