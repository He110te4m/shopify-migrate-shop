# 部署到 Netlify

本项目通过 [`@netlify/vite-plugin-react-router`](https://github.com/netlify/vite-plugins) 支持 Netlify 部署：构建时插件自动把 React Router server bundle 打包为 Netlify Function，静态资源由 Netlify CDN 直接服务，无需手写 serverless function。

## 存储说明

应用不使用数据库（见 `app/storage.server.ts`）：

- **Netlify 上**：session 与迁移历史存于 [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)（stores：`shopify-sessions`、`migration-runs`），随站点自动创建，无需额外配置。
- **本地开发**：内存存储，重启后 session 与历史记录丢失。如需本地验证 Blobs 行为，可用 `netlify dev` 启动（会注入 Blobs 环境）。

## 首次部署

1. 将仓库 push 到 GitHub，在 Netlify Dashboard「Add new site → Import an existing project」关联仓库。构建配置已在 `netlify.toml` 中，无需额外设置。
2. 在 Netlify Dashboard → Site configuration → Environment variables 配置：

   | 变量 | 说明 |
   | --- | --- |
   | `SHOPIFY_API_KEY` | Partners Dashboard 中的 Client ID |
   | `SHOPIFY_API_SECRET` | Partners Dashboard 中的 Client secret |
   | `SCOPES` | 如 `read_metaobject_definitions,write_metaobject_definitions,...`（与 `shopify.app.toml` 一致） |
   | `SHOPIFY_APP_URL` | `https://<your-site>.netlify.app` |

3. 在 [Shopify Partners Dashboard](https://partners.shopify.com/) 中更新应用配置：
   - App URL：`https://<your-site>.netlify.app`
   - Allowed redirection URL(s)：`https://<your-site>.netlify.app/auth`（或按 `shopify.app.toml` 中 `[auth] redirect_urls` 逐项对应）

   也可通过 `shopify app config link` + 修改 toml 后 `pnpm deploy` 推送配置。

## 日常发布

`git push` 到关联分支即触发 Netlify 自动构建与部署。

## 其他部署方式

- **Docker 自托管**：`Dockerfile` 仍可用（`react-router-serve` 常驻 Node 进程）。注意自托管环境下 `process.env.NETLIFY` 不存在，存储退化为内存实现 —— 重启会丢失 session 与迁移历史，仅建议临时使用。
