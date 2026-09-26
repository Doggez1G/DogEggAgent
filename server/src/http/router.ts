import type { IncomingMessage, ServerResponse } from 'node:http'
import { SseChannel } from '../channel'
import { FsBrowser } from '../fs'
import { ShellDetector } from '../shells'

// 路由匹配：把 URL pathname 映射到对应的 handler。
// 返回 true 表示已处理（handler 已写响应），false 表示未匹配（交给静态文件 fallback）。
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

// API 路由表：构造时装配全部 API 端点（SSE 通道 + 目录浏览 + shell 检测）。
// fs/shells 可注入（测试用），缺省自建真实实现。
export class Router {
  private readonly routes = new Map<string, RouteHandler>()

  constructor(deps: {
    channel: SseChannel
    fs?: FsBrowser
    shells?: ShellDetector
  }) {
    const fs = deps.fs ?? new FsBrowser()
    const shells = deps.shells ?? new ShellDetector()

    this.routes.set('/api/events', async (req, res) => {
      if (req.method === 'GET') { deps.channel.sseHandler(req, res); return true }
      res.writeHead(405); res.end('Method Not Allowed'); return true
    })
    this.routes.set('/api/message', async (req, res) => {
      if (req.method === 'POST') { deps.channel.postHandler(req, res); return true }
      res.writeHead(405); res.end('Method Not Allowed'); return true
    })
    // fs handler：GET /api/fs?path=/some/dir&files=true → 返回子目录列表（+ 文件列表）JSON。
    this.routes.set('/api/fs', async (req, res, url) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return true }
      const includeFiles = url.searchParams.get('files') === 'true'
      const result = await fs.listDirs(fs.resolveFsPath(url.searchParams.get('path') ?? undefined), includeFiles)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
      return true
    })
    // shells handler：GET /api/shells → 检测系统可用的 shell 程序列表（结果缓存）。
    // detect 为异步（P2-20）：探测在子进程中并行进行，await 等待期间事件循环照常服务
    // 其它请求——不再有首次请求冻结整个 server 的问题。探测核心内部对每个候选全捕获，
    // 不会 reject；探测失败的候选被跳过，与旧同步实现的响应形态（200 + JSON 数组）一致。
    this.routes.set('/api/shells', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return true }
      const found = await shells.detect()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(found))
      return true
    })
  }

  // 匹配并执行 API 路由；未命中返回 false（调用方交给静态文件 fallback）。
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const handler = this.routes.get(url.pathname)
    if (!handler) return false
    await handler(req, res, url)
    return true
  }
}
