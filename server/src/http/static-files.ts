import { readFile } from 'node:fs/promises'
import { join, extname, resolve as pathResolve, relative as pathRelative } from 'node:path'
import type { ServerResponse } from 'node:http'

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

// 静态文件服务：从 rootDir 读取文件，设置 MIME，404 时 fallback 到 index.html（SPA 路由）。
// 路径穿越防护：用 path.resolve + path.relative 检查结果路径是否在 rootDir 内。
export class StaticFiles {
  constructor(private readonly rootDir: string) {}

  async serve(res: ServerResponse, url: URL): Promise<void> {
    let pathname = url.pathname
    if (pathname === '/') pathname = '/index.html'
    const resolved = pathResolve(this.rootDir, '.' + pathname)
    // 检查解析后的路径是否在 rootDir 内——relative 结果不以 .. 开头且非绝对路径。
    const rel = pathRelative(this.rootDir, resolved)
    if (rel.startsWith('..') || pathResolve(this.rootDir, rel) === rel) {
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
        const indexContent = await readFile(join(this.rootDir, 'index.html'))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(indexContent)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      }
    }
  }
}
