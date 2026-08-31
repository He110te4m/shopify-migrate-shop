import type { ExportedPage } from "./types";

export interface FetchedPage extends ExportedPage {
  id: string;
}

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface RawPageNode {
  id: string;
  title: string;
  handle: string;
  body: string;
  isPublished: boolean;
  templateSuffix: string | null;
  metafields: {
    nodes: {
      namespace: string;
      key: string;
      type: string;
      value: string;
    }[];
  };
}

const PAGES_QUERY = `#graphql
  query MigrationPages($first: Int!, $after: String) {
    pages(first: $first, after: $after) {
      nodes {
        id
        title
        handle
        body
        isPublished
        templateSuffix
        metafields(first: 250) {
          nodes {
            namespace
            key
            type
            value
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

export async function fetchAllPages(
  graphql: AdminGraphql,
): Promise<FetchedPage[]> {
  const pages: FetchedPage[] = [];
  let after: string | null = null;
  do {
    const response = await graphql(PAGES_QUERY, {
      variables: { first: 250, after },
    });
    const body = (await response.json()) as {
      data?: {
        pages: { nodes: RawPageNode[]; pageInfo: PageInfo };
      };
      errors?: { message: string }[];
    };
    if (body.errors?.length) {
      throw new Error(
        `查询页面失败: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const connection = body.data?.pages;
    if (!connection) throw new Error("查询页面失败: 无数据返回");
    for (const node of connection.nodes) {
      pages.push({
        id: node.id,
        title: node.title,
        handle: node.handle,
        body: node.body,
        isPublished: node.isPublished,
        templateSuffix: node.templateSuffix,
        metafields: node.metafields.nodes,
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return pages;
}

export const PAGE_CREATE = `#graphql
  mutation MigrationPageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        handle
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const METAFIELDS_SET = `#graphql
  mutation MigrationMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
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
