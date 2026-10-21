import type { VariantReferenceLookup } from "./metafields";
import type { PortableVariantReference } from "./types";

export interface RawMetafieldValue {
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface FetchedProductVariant {
  id: string;
  sku: string | null;
  title: string;
  metafields: RawMetafieldValue[];
  metafieldsTruncated: boolean;
}

export interface FetchedProduct {
  id: string;
  handle: string;
  title: string;
  templateSuffix: string | null;
  metafields: RawMetafieldValue[];
  variants: FetchedProductVariant[];
}

export interface TargetVariant {
  id: string;
  sku: string | null;
  title: string;
}

export interface TargetProduct {
  id: string;
  handle: string;
  title: string;
  templateSuffix: string | null;
  variants: TargetVariant[];
}

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

function graphqlError(body: { errors?: { message: string }[] }, label: string) {
  return new Error(
    `${label}失败: ${body.errors?.map((e) => e.message).join("; ") ?? "无数据返回"}`,
  );
}

const PRODUCT_LIST_QUERY = `#graphql
  query MigrationProductList($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        handle
        title
        templateSuffix
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PRODUCTS_BY_IDS_QUERY = `#graphql
  query MigrationProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        templateSuffix
      }
    }
  }
`;

const PRODUCT_METAFIELDS_QUERY = `#graphql
  query MigrationProductMetafields($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      metafields(first: $first, after: $after) {
        nodes {
          id
          namespace
          key
          type
          value
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query MigrationProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        nodes {
          id
          sku
          title
          metafields(first: 250) {
            nodes {
              id
              namespace
              key
              type
              value
            }
            pageInfo {
              hasNextPage
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// 只读取引用变体的业务键,不把 GID 写入导出文件。
// `metafield(id:)` 自 2023-10 起已移除，改用 Node 接口按 ID 取 Metafield。
const METAFIELD_VARIANT_REFERENCES_QUERY = `#graphql
  query MigrationMetafieldVariantReferences($id: ID!, $first: Int!, $after: String) {
    node(id: $id) {
      __typename
      ... on Metafield {
        reference {
          __typename
          ... on ProductVariant {
            sku
            title
            product {
              handle
            }
          }
        }
        references(first: $first, after: $after) {
          nodes {
            __typename
            ... on ProductVariant {
              sku
              title
              product {
                handle
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const TARGET_PRODUCTS_QUERY = `#graphql
  query MigrationTargetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        handle
        title
        templateSuffix
        variants(first: 250) {
          nodes {
            id
            sku
            title
          }
          pageInfo {
            hasNextPage
            endCursor
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

const TARGET_PRODUCT_VARIANTS_QUERY = `#graphql
  query MigrationTargetProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        nodes {
          id
          sku
          title
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

async function fetchProductMetafields(
  graphql: AdminGraphql,
  productId: string,
): Promise<RawMetafieldValue[]> {
  const metafields: RawMetafieldValue[] = [];
  let after: string | null = null;
  do {
    const response = await graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: { id: productId, first: 250, after },
    });
    const body = (await response.json()) as {
      data?: {
        product: {
          metafields: {
            nodes: RawMetafieldValue[];
            pageInfo: PageInfo;
          };
        } | null;
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw graphqlError(body, "查询产品 metafield");
    const connection = body.data?.product?.metafields;
    if (!connection) break;
    metafields.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return metafields;
}

async function fetchProductVariants(
  graphql: AdminGraphql,
  productId: string,
): Promise<FetchedProductVariant[]> {
  const variants: FetchedProductVariant[] = [];
  let after: string | null = null;
  do {
    const response = await graphql(PRODUCT_VARIANTS_QUERY, {
      variables: { id: productId, first: 100, after },
    });
    const body = (await response.json()) as {
      data?: {
        product: {
          variants: {
            nodes: {
              id: string;
              sku: string | null;
              title: string;
              metafields: {
                nodes: RawMetafieldValue[];
                pageInfo: { hasNextPage: boolean };
              };
            }[];
            pageInfo: PageInfo;
          };
        } | null;
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw graphqlError(body, "查询产品变体");
    const connection = body.data?.product?.variants;
    if (!connection) break;
    for (const node of connection.nodes) {
      variants.push({
        id: node.id,
        sku: node.sku,
        title: node.title,
        metafields: node.metafields.nodes,
        metafieldsTruncated: node.metafields.pageInfo.hasNextPage,
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return variants;
}

interface ProductNode {
  id: string;
  handle: string;
  title: string;
  templateSuffix: string | null;
}

interface RawVariantReferenceNode {
  __typename: string;
  sku?: string | null;
  title?: string;
  product?: { handle: string } | null;
}

const REFERENCE_PAGE_SIZE = 250;
// references 理论上按 250 分页即可读完;保留上限避免异常数据拖住整个导出
const MAX_REFERENCE_PAGES = 10;

function toPortableVariantReference(
  node: RawVariantReferenceNode | null | undefined,
): PortableVariantReference | null {
  if (!node || node.__typename !== "ProductVariant") return null;
  const productHandle = node.product?.handle;
  if (!productHandle || typeof node.title !== "string") return null;
  return {
    kind: "product_variant",
    productHandle,
    sku: node.sku ?? null,
    variantTitle: node.title,
  };
}

// 按 metafield id 单独查询引用,避免给全部 metafield 列表增加重字段
export async function fetchVariantReferenceLookup(
  graphql: AdminGraphql,
  metafieldId: string,
): Promise<VariantReferenceLookup> {
  const references: PortableVariantReference[] = [];
  const seen = new Set<string>();
  let unresolved = 0;
  let truncated = false;
  let after: string | null = null;
  let pages = 0;

  const add = (node: RawVariantReferenceNode | null | undefined) => {
    if (!node) return;
    const reference = toPortableVariantReference(node);
    if (!reference) {
      unresolved += 1;
      return;
    }
    const key = `${reference.productHandle}\u0000${reference.sku ?? ""}\u0000${reference.variantTitle}`;
    // 单值引用的 reference 与 references 可能返回同一节点
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };

  do {
    const response = await graphql(METAFIELD_VARIANT_REFERENCES_QUERY, {
      variables: { id: metafieldId, first: REFERENCE_PAGE_SIZE, after },
    });
    const body = (await response.json()) as {
      data?: {
        node: {
          __typename: string;
          reference?: RawVariantReferenceNode | null;
          // 单值引用类型没有 references 连接,可能返回 null
          references?: {
            nodes: (RawVariantReferenceNode | null)[];
            pageInfo: PageInfo;
          } | null;
        } | null;
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw graphqlError(body, "查询 metafield 引用");
    const node = body.data?.node;
    // metafield 在列表查询与引用查询之间被删除,或 ID 不是 Metafield
    if (!node || node.__typename !== "Metafield") {
      if (pages === 0) unresolved += 1;
      break;
    }
    const metafield = node;
    if (pages === 0) add(metafield.reference);
    const connection = metafield.references;
    if (connection) {
      for (const node of connection.nodes) add(node);
    }
    pages += 1;
    after = connection?.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
    if (after && pages >= MAX_REFERENCE_PAGES) {
      truncated = true;
      break;
    }
  } while (after);

  return { references, unresolved, truncated };
}

const IDS_PER_QUERY = 250;

async function fetchProductsByIds(
  graphql: AdminGraphql,
  ids: string[],
): Promise<ProductNode[]> {
  const products: ProductNode[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const chunk = ids.slice(i, i + IDS_PER_QUERY);
    const response = await graphql(PRODUCTS_BY_IDS_QUERY, {
      variables: { ids: chunk },
    });
    const body = (await response.json()) as {
      data?: { nodes: (ProductNode | null)[] };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw graphqlError(body, "按 ID 查询产品");
    for (const node of body.data?.nodes ?? []) {
      // 选中后被删除的产品会返回 null
      if (node) products.push(node);
    }
  }
  return products;
}

async function fetchProductList(
  graphql: AdminGraphql,
): Promise<ProductNode[]> {
  const products: ProductNode[] = [];
  let after: string | null = null;
  do {
    const response = await graphql(PRODUCT_LIST_QUERY, {
      variables: { first: 50, after },
    });
    const body = (await response.json()) as {
      data?: {
        products: {
          nodes: ProductNode[];
          pageInfo: PageInfo;
        };
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw graphqlError(body, "查询产品列表");
    const connection = body.data?.products;
    if (!connection) throw new Error("查询产品列表失败: 无数据返回");
    products.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return products;
}

// 传入 productIds 时只读取选中的产品,避免全量扫描店铺目录;
// 模板配置导出不需要变体级 metafield,可用 includeVariants: false 跳过多余查询
export async function fetchAllProducts(
  graphql: AdminGraphql,
  productIds?: string[],
  options: { includeVariants?: boolean } = {},
): Promise<FetchedProduct[]> {
  const includeVariants = options.includeVariants ?? true;
  const targets = productIds?.length
    ? await fetchProductsByIds(graphql, productIds)
    : await fetchProductList(graphql);

  const products: FetchedProduct[] = [];
  for (const node of targets) {
    products.push({
      id: node.id,
      handle: node.handle,
      title: node.title,
      templateSuffix: node.templateSuffix,
      metafields: await fetchProductMetafields(graphql, node.id),
      variants: includeVariants
        ? await fetchProductVariants(graphql, node.id)
        : [],
    });
  }
  return products;
}

// 只取 ID 列表,供前端分批导出时排空队列
export async function fetchProductIds(graphql: AdminGraphql): Promise<string[]> {
  return (await fetchProductList(graphql)).map((product) => product.id);
}

// 目标店铺只读取匹配所需的 handle/SKU/变体标题,不读取 metafield 值
export async function fetchTargetProducts(
  graphql: AdminGraphql,
): Promise<TargetProduct[]> {
  const products: TargetProduct[] = [];
  let after: string | null = null;
  do {
    const response = await graphql(TARGET_PRODUCTS_QUERY, {
      variables: { first: 100, after },
    });
    const body = (await response.json()) as {
      data?: {
        products: {
          nodes: {
            id: string;
            handle: string;
            title: string;
            templateSuffix: string | null;
            variants: {
              nodes: TargetVariant[];
              pageInfo: PageInfo;
            };
          }[];
          pageInfo: PageInfo;
        };
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) throw graphqlError(body, "查询目标店铺产品");
    const connection = body.data?.products;
    if (!connection) throw new Error("查询目标店铺产品失败: 无数据返回");
    for (const node of connection.nodes) {
      const variants = [...node.variants.nodes];
      let variantCursor = node.variants.pageInfo.hasNextPage
        ? node.variants.pageInfo.endCursor
        : null;
      while (variantCursor) {
        const variantBody = (await (
          await graphql(TARGET_PRODUCT_VARIANTS_QUERY, {
            variables: { id: node.id, first: 250, after: variantCursor },
          })
        ).json()) as {
          data?: {
            product: {
              variants: { nodes: TargetVariant[]; pageInfo: PageInfo };
            } | null;
          };
          errors?: { message: string }[];
        };
        if (variantBody.errors?.length) {
          throw graphqlError(variantBody, "查询目标店铺产品变体");
        }
        const variantConnection = variantBody.data?.product?.variants;
        if (!variantConnection) break;
        variants.push(...variantConnection.nodes);
        variantCursor = variantConnection.pageInfo.hasNextPage
          ? variantConnection.pageInfo.endCursor
          : null;
      }
      products.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        templateSuffix: node.templateSuffix,
        variants,
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return products;
}
