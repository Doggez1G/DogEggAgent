import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRoutes, dispatchRequest } from './routes'

// startServer：创建 HTTP server，注册路由，开始监听。
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
  server.listen(opts.port, () => {
    const mode = opts.staticDir ? 'production' : 'development'
    console.log(`🐶 DogEggAgent WebUI server (${mode}) listening on http://localhost:${opts.port}`)
  })
}
