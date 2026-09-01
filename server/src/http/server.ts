import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRoutes, dispatchRequest } from './routes'

// startServer：创建 HTTP server，注册路由，开始监听。
// 默认绑定 127.0.0.1（仅本地访问），可通过 HOST 环境变量覆盖（如部署到内网）。
// CORS 限制为 localhost——防止其他网站跨站 POST 驱动 shell 执行。
// staticDir 为 null 时（开发模式），非 API 路径返回 404——前端由 Vite dev server 代理。
// staticDir 非 null 时（生产模式），非 API 路径 serve 静态文件。
export function startServer(opts: {
  sseHandler: (req: IncomingMessage, res: ServerResponse) => void
  postHandler: (req: IncomingMessage, res: ServerResponse) => void
  staticDir: string | null
  port: number
}): void {
  const routes = createRoutes(opts)
  const server = createServer((req, res) => {
    dispatchRequest(req, res, routes, opts.staticDir).catch((e) => {
      console.error('Request handler error:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    })
  })
  const host = process.env.HOST ?? '127.0.0.1'
  server.listen(opts.port, host, () => {
    const mode = opts.staticDir ? 'production' : 'development'
    console.log(`🐶 DogEggAgent WebUI server (${mode}) listening on http://${host}:${opts.port}`)
  })
}
