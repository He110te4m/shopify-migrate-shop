import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="店铺定义迁移">
      <s-section heading="使用流程">
        <s-paragraph>
          本应用用于在店铺之间迁移 metaobject 与 metafield 的定义（仅定义结构，不包含具体值）。
        </s-paragraph>
        <s-ordered-list>
          <s-list-item>
            在源店铺打开「导出定义」，下载 JSON 文件
          </s-list-item>
          <s-list-item>
            在目标店铺打开「导入定义」，上传该 JSON 文件并执行预检
          </s-list-item>
          <s-list-item>
            确认预检报告（冲突与依赖缺失会标记为失败，不会覆盖目标店铺已有定义），然后执行导入
          </s-list-item>
          <s-list-item>
            在「迁移历史」中查看每次导入的完整记录
          </s-list-item>
        </s-ordered-list>
      </s-section>
      <s-section heading="迁移规则">
        <s-unordered-list>
          <s-list-item>
            依赖顺序：先创建 metaobject 定义，再创建引用它们的 metafield 定义；嵌套引用自动按依赖顺序处理
          </s-list-item>
          <s-list-item>
            目标店铺已存在且一致的定义会被跳过；缺少字段的 metaobject 定义会自动补充缺失字段
          </s-list-item>
          <s-list-item>
            同名定义但字段类型 / 必填属性冲突时会记为导入失败，不会删除或重建已有定义
          </s-list-item>
          <s-list-item>
            app-owned 定义（$app 前缀）无法跨应用迁移，会在报告中列出
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
