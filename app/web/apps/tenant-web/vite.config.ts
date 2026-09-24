import process from 'node:process';

import { defineConfig } from '@vben/vite-config';

import { createBrowserLogPlugin } from './vite/browser-log.plugin';

export default defineConfig(async () => {
  const gatewayBaseUrl =
    process.env.OES_GATEWAY_HTTP_BASE_URL?.trim() ||
    'http://127.0.0.1:52101/api/v1';

  return {
    application: {},
    vite: {
      plugins: [createBrowserLogPlugin()],
      server: {
        proxy: {
          '/api': {
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ''),
            // 本地联调时直连 trusted-runtime 启动的 api-gateway。
            target: gatewayBaseUrl,
            ws: true,
          },
          '/public-entry/public': {
            changeOrigin: true,
            // 只代理匿名公开名片 API，避免接管 /public-entry 管理页面路由
            target: gatewayBaseUrl,
          },
        },
      },
    },
  };
});
