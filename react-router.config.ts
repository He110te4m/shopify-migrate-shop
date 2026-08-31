import type { Config } from "@react-router/dev/config";

// react-router dev server 将隧道请求构造为 http:// URL,与浏览器 https Origin
// 不一致导致 CSRF 检查误报 400 (react-router#15454);按 host 白名单放行
const appHost = process.env.SHOPIFY_APP_URL
  ? new URL(process.env.SHOPIFY_APP_URL).host
  : undefined;

export default {
  allowedActionOrigins: ["*.trycloudflare.com", appHost].filter(
    (host): host is string => Boolean(host)
  ),
} satisfies Config;
