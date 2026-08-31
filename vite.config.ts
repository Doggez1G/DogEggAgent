import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Vite 配置：WebUI 前端构建 + 开发代理。
// 开发期：Vite dev server 跑前端（HMR），/api/* 代理到 Node server（main-web.ts，端口 3001）。
// 生产期：vite build → dist/web/（静态文件），被 server serve。
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('ui/src/webui', import.meta.url)),
  // 入口 HTML：ui/src/webui/index.html
  build: {
    // outDir 相对于 vite.config.ts 所在位置（项目根）解析。
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    // 不清空整个 dist/——只清空 dist/web/（避免删掉 TUI 的 dist/index.js 和 server 的 dist/server.js）。
    emptyOutDir: false,
  },
  // @dogegg/bridge 是纯 TS 源码包（exports → src/index.ts），Vite 需要预打包才能正确解析。
  // optimizeDeps.include 让 Vite 预构建 bridge 依赖。
  resolve: {
    alias: {
      '@dogegg/bridge': fileURLToPath(new URL('bridge/src/index.ts', import.meta.url)),
      '@dogegg/ui': fileURLToPath(new URL('ui/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 开发代理：/api/* → Node server（main-web.ts，VITE_DEV=1 PORT=3001）。
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // SSE 需要关闭代理缓冲，让 chunked 流式响应实时透传。
        ws: false,
        configure: (proxy) => {
          // SSE 长连接不设超时（默认代理超时会断开流式响应）。
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Connection', 'keep-alive')
          })
        },
      },
    },
  },
})
