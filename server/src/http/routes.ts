import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve as pathResolve, relative as pathRelative, sep as pathSep } from 'node:path'
import { listDirs, resolveFsPath } from '../fs'
import { detectShells } from '../shells'

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

// fs handler：GET /api/fs?path=/some/dir&files=true → 返回子目录列表（+ 文件列表）JSON。
async function fsHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return true
  }
  const includeFiles = url.searchParams.get('files') === 'true'
  const result = await listDirs(resolveFsPath(url.searchParams.get('path') ?? undefined), includeFiles)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(result))
  return true
}

// shells handler：GET /api/shells → 检测系统可用的 shell 程序列表（结果缓存）。
async function shellsHandler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method Not Allowed'); return true
  }
  const shells = detectShells()
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(shells))
  return true
}

// 创建路由表——api 路径到 handler 的映射。
export function createRoutes(opts: {
  sseHandler: (req: IncomingMessage, res: ServerResponse) => void
  postHandler: (req: IncomingMessage, res: ServerResponse) => void
}): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  routes.set('/api/events', async (req, res) => {
    if (req.method === 'GET') { opts.sseHandler(req, res); return true }
    res.writeHead(405); res.end('Method Not Allowed'); return true
  })
  routes.set('/api/message', async (req, res) => {
    if (req.method === 'POST') { opts.postHandler(req, res); return true }
    res.writeHead(405); res.end('Method Not Allowed'); return true
  })
  routes.set('/api/fs', fsHandler)
  routes.set('/api/shells', shellsHandler)
  return routes
}

// 静态文件 serve：从 staticDir 读取文件，设置 MIME，404 时 fallback 到 index.html（SPA 路由）。
// 路径穿越防护：用 path.resolve + path.relative 检查结果路径是否在 staticDir 内。
async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, staticDir: string): Promise<void> {
  let pathname = url.pathname
  if (pathname === '/') pathname = '/index.html'
  const resolved = pathResolve(staticDir, '.' + pathname)
  // 检查解析后的路径是否在 staticDir 内——relative 结果不以 .. 开头且非绝对路径。
  const rel = pathRelative(staticDir, resolved)
  if (rel.startsWith('..') || pathResolve(staticDir, rel) === rel) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  try {
    const content = await readFile(resolved)
    const mime = MIME[extname(resolved)] ?? 'application/octet-stream'
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

// 检查 Origin header 是否为允许的 localhost 来源。
function isLocalhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  } catch {
    return false
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
  const origin = req.headers.origin
  const allowedOrigin = isLocalhostOrigin(typeof origin === 'string' ? origin : undefined) ? origin : undefined

  // CORS 预检：仅允许 localhost 来源（防止跨站驱动 shell 执行）。
  if (req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    }
    if (allowedOrigin) {
      headers['Access-Control-Allow-Origin'] = allowedOrigin
    }
    res.writeHead(204, headers)
    res.end()
    return
  }

  // 为非 OPTIONS 请求设置 CORS header（仅允许 localhost 来源）。
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Vary', 'Origin')
  }

  // API 路由匹配。
  const routeKey = url.pathname
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
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not Found')
}
