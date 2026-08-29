import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDirs, resolveFsPath } from '../fs'

// MIME 类型映射——静态文件 serve 时设置正确的 Content-Type。
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// 路由匹配：把 URL pathname 映射到对应的 handler。
// 返回 true 表示已处理（handler 已写响应），false 表示未匹配（交给静态文件 fallback）。
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

// fs handler：GET /api/fs?path=/some/dir → 返回子目录列表 JSON。
async function fsHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return true
  }
  const result = await listDirs(resolveFsPath(url.searchParams.get('path') ?? undefined))
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(result))
  return true
}

// 创建路由表——api 路径到 handler 的映射。
export function createRoutes(opts: {
  sseHandler: (req: IncomingMessage, res: ServerResponse) => void
  postHandler: (req: IncomingMessage, res: ServerResponse) => void
}): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  // SSE 下行：GET /api/events
  routes.set('/api/events', async (req, res) => {
    if (req.method === 'GET') { opts.sseHandler(req, res); return true }
    res.writeHead(405); res.end('Method Not Allowed'); return true
  })
  // 上行消息：POST /api/message
  routes.set('/api/message', async (req, res) => {
    if (req.method === 'POST') { opts.postHandler(req, res); return true }
    res.writeHead(405); res.end('Method Not Allowed'); return true
  })
  // 目录浏览：GET /api/fs
  routes.set('/api/fs', fsHandler)
  return routes
}

// 静态文件 serve：从 staticDir 读取文件，设置 MIME，404 时 fallback 到 index.html（SPA 路由）。
async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, staticDir: string): Promise<void> {
  // URL pathname → 文件路径；根路径 fallback 到 index.html。
  let pathname = url.pathname
  if (pathname === '/') pathname = '/index.html'
  const filePath = join(staticDir, pathname)
  // 防止路径穿越：确保解析后的路径在 staticDir 内。
  const resolved = fileURLToPath(new URL(`file://${filePath}`))
  if (!resolved.startsWith(staticDir)) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  try {
    const content = await readFile(filePath)
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    res.end(content)
  } catch {
    // SPA fallback：文件不存在时返回 index.html（前端路由接管）。
    try {
      const indexContent = await readFile(join(staticDir, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(indexContent)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  }
}

// 请求分发：先匹配 API 路由，未匹配则交给静态文件。
export async function dispatchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Map<string, RouteHandler>,
  staticDir: string | null,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  // CORS 预检：OPTIONS 直接放行。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }
  // API 路由匹配（精确 pathname 前缀）。
  const routeKey = url.pathname
  // 精确匹配 /api/events、/api/message、/api/fs
  if (routes.has(routeKey)) {
    const handler = routes.get(routeKey)!
    await handler(req, res, url)
    return
  }
  // 静态文件 serve（生产模式 staticDir 非空时）。
  if (staticDir) {
    await serveStatic(req, res, url, staticDir)
    return
  }
  // 开发模式（Vite dev server 代理 /api）：非 API 路径且无 staticDir → 404。
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
}
