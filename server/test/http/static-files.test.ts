import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, it, expect } from 'vitest'
import { StaticFiles } from '../../src/http/static-files'
import { HttpServer } from '../../src/http/http-server'
import type { Router } from '../../src/http/router'

// ─────────────────────────────────────────────────────────────────────────────
// 静态文件服务测试（http-server.test 全程 staticDir:null，本文件补上静态分支）：
// 1. 正常文件 200 + Content-Type（html/js/css）；'/' 映射 index.html；
// 2. 未知路径 → SPA fallback（200 + index.html，读实现确认后按实际行为断言）；
// 3. 路径逃逸全被拒——核心不变量是「rootDir 之外的文件内容绝不出现在响应里」；
//    各变体的状态码按实现实际行为断言（说明见「路径逃逸」用例组）；
// 4. staticDir 不存在 → 统一 404（读 index 兜底也失败）。
// harness：沿用 http-server.test.ts 的「直接驱动 + mock req/res」模式——不建真 socket、确定性。
// ─────────────────────────────────────────────────────────────────────────────

// 可记录状态的最小 ServerResponse 桩（比 http-server.test 的多记 headers/body）。
function makeRes() {
  const state = { statusCode: 0, headers: {} as Record<string, unknown>, body: '' }
  return {
    state,
    writeHead: (code: number, headers?: Record<string, string>) => {
      state.statusCode = code
      if (headers) state.headers = { ...state.headers, ...headers }
    },
    setHeader: (name: string, value: string) => { state.headers[name] = value },
    end: (body?: string | Buffer) => { state.body = Buffer.isBuffer(body) ? body.toString('utf8') : (body ?? '') },
  }
}
type MockRes = ReturnType<typeof makeRes>

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// rootDir = <临时目录>/public；rootDir 之外（同级）放一个「机密」文件——所有逃逸用例的靶子。
function makeRoot(): { root: string; secret: string; indexBody: string } {
  const base = mkdtempSync(join(tmpdir(), 'dogegg-static-'))
  dirs.push(base)
  const root = join(base, 'public')
  mkdirSync(root)
  const indexBody = '<html><body>INDEX-PAGE</body></html>'
  writeFileSync(join(root, 'index.html'), indexBody)
  writeFileSync(join(root, 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'style.css'), 'body{}')
  const secret = join(base, 'secret.txt')
  writeFileSync(secret, 'TOP-SECRET-OUTSIDE-ROOT')
  return { root, secret, indexBody }
}

// 经 StaticFiles.serve 直测（真实 URL 对象——与生产 dispatch 的构造方式一致）。
async function serve(staticFiles: StaticFiles, pathname: string): Promise<MockRes> {
  const res = makeRes()
  await staticFiles.serve(res as unknown as ServerResponse, new URL(`http://localhost${pathname}`))
  return res
}

// 经 serve 直测未归一化 pathname：serve 只消费 url.pathname——用桩对象注入含字面 '..' 的
// 路径，直击守卫分支（真实 HTTP 层 WHATWG URL 会先把 '..' 归一化掉，见 dispatch 集成用例）。
async function serveRaw(staticFiles: StaticFiles, pathname: string): Promise<MockRes> {
  const res = makeRes()
  await staticFiles.serve(res as unknown as ServerResponse, { pathname } as unknown as URL)
  return res
}

// 经 HttpServer.dispatch 集成测（私有方法经类型断言调用——既有 harness 模式）。
async function dispatch(srv: HttpServer, url: string): Promise<MockRes> {
  const res = makeRes()
  const req = { url, method: 'GET', headers: {} } as unknown as IncomingMessage
  await (srv as unknown as { dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void> })
    .dispatch(req, res as unknown as ServerResponse)
  return res
}

function stubRouter(): Router {
  return { handle: async () => false } as unknown as Router
}

describe('StaticFiles（正常服务）', () => {
  it('正常文件 200 + 正确 Content-Type（html/js/css 三类）', async () => {
    const { root } = makeRoot()
    const files = new StaticFiles(root)

    const html = await serve(files, '/index.html')
    expect(html.state.statusCode).toBe(200)
    expect(html.state.headers['Content-Type']).toBe('text/html; charset=utf-8')

    const js = await serve(files, '/app.js')
    expect(js.state.statusCode).toBe(200)
    expect(js.state.headers['Content-Type']).toBe('application/javascript; charset=utf-8')

    const css = await serve(files, '/style.css')
    expect(css.state.statusCode).toBe(200)
    expect(css.state.headers['Content-Type']).toBe('text/css; charset=utf-8')
  })

  it("'/' 映射到 index.html（200 + text/html）", async () => {
    const { root, indexBody } = makeRoot()
    const res = await serve(new StaticFiles(root), '/')
    expect(res.state.statusCode).toBe(200)
    expect(res.state.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(res.state.body).toBe(indexBody)
  })

  it('未知路径 → SPA fallback：200 + index.html 内容（前端路由接管，读实现确认的行为）', async () => {
    const { root, indexBody } = makeRoot()
    const res = await serve(new StaticFiles(root), '/some/spa/route')
    expect(res.state.statusCode).toBe(200)
    expect(res.state.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(res.state.body).toBe(indexBody)
  })
})

describe('StaticFiles（路径逃逸防护）', () => {
  it("字面 '..' 段（未归一化）→ 403 Forbidden（守卫分支直测）", async () => {
    const { root } = makeRoot()
    const files = new StaticFiles(root)
    const one = await serveRaw(files, '/../secret.txt')
    expect(one.state.statusCode).toBe(403)
    const deep = await serveRaw(files, '/a/../../../../../../../../secret.txt')
    expect(deep.state.statusCode).toBe(403)
  })

  it("盘符绝对路径 '/C:/...' → 403（relative 产出的绝对结果被守卫第二条件拦截）", async () => {
    // 实现行为（Windows 实测确定）：'./C:/Windows/win.ini' 经 pathResolve 后 'C:' 保留为字面目录段，
    // 但 path.relative 把含盘符的剩余段解析为绝对路径 → rel 不以 '..' 开头，落入守卫第二条件
    //（pathResolve(rootDir, rel) === rel）→ 403。这是盘符变体被拒的精确机制。
    const { root } = makeRoot()
    const res = await serve(new StaticFiles(root), '/C:/Windows/win.ini')
    expect(res.state.statusCode).toBe(403)
    expect(res.state.body).not.toContain('TOP-SECRET')
  })

  it('URL 归一化后的逃逸变体（../、%2e%2e、反斜杠、// 前缀）→ 不越出 rootDir，命中 SPA fallback', async () => {
    // 实现对齐说明：真实请求层的 pathname 先经 WHATWG URL 构造（dispatch 内 new URL）——
    // '..' 与反斜杠在 URL 解析期就被归一化/折叠，到达守卫时已不再是逃逸路径；%2e%2e 保持
    // 百分号编码（pathResolve 不解码 → 字面目录名）；'//' 前缀折叠后仍落在 rootDir 内。
    // 因此这些变体的实际行为是「读不到 → SPA fallback 200」，而非 403/404——
    // 关键不变量是：rootDir 之外文件的内容绝不出现在任何响应里。
    const { root, indexBody } = makeRoot()
    const files = new StaticFiles(root)
    const attempts = [
      '/../secret.txt', // URL 归一化后 → '/secret.txt'
      '/a/../../secret.txt', // 归一化后 → '/secret.txt'
      '/%2e%2e/%2e%2e/secret.txt', // 编码不解码 → 字面目录，root 内不存在
      '/\\..\\secret.txt', // 反斜杠 = 路径分隔符 → 归一化
      '//etc/passwd', // '//' 前缀 → 折叠为单斜杠
    ]
    for (const attempt of attempts) {
      const res = await serve(files, attempt)
      expect(res.state.statusCode, attempt).toBe(200)
      expect(res.state.body, attempt).toBe(indexBody) // fallback 的 index，绝非遗漏目标内容
      expect(res.state.body.includes('TOP-SECRET'), attempt).toBe(false)
    }
  })

  it('rootDir 内不存在的文件也走 SPA fallback（200 index）——与逃逸变体响应形态一致', async () => {
    const { root, indexBody } = makeRoot()
    const res = await serve(new StaticFiles(root), '/no/such/asset.png')
    expect(res.state.statusCode).toBe(200)
    expect(res.state.body).toBe(indexBody)
  })
})

describe('StaticFiles（staticDir 不存在）', () => {
  it('rootDir 不存在 → 读文件与 index 兜底双失败 → 404 Not Found（text/plain）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dogegg-static-missing-'))
    dirs.push(base)
    const res = await serve(new StaticFiles(join(base, 'does-not-exist')), '/index.html')
    expect(res.state.statusCode).toBe(404)
    expect(res.state.headers['Content-Type']).toBe('text/plain')
    expect(res.state.body).toBe('Not Found')
  })

  it('集成：HttpServer 配置不存在的 staticDir → 非 API 路径统一 404（目录字符串真值 → StaticFiles 生效）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dogegg-static-missing-'))
    dirs.push(base)
    const srv = new HttpServer({ router: stubRouter(), staticDir: join(base, 'nope'), port: 3000 })
    const res = await dispatch(srv, '/index.html')
    expect(res.state.statusCode).toBe(404)
  })
})

describe('HttpServer + StaticFiles（dispatch 集成）', () => {
  it('API 未命中 → 静态文件接管：资产文件 200 + 正确 Content-Type', async () => {
    const { root } = makeRoot()
    const srv = new HttpServer({ router: stubRouter(), staticDir: root, port: 3000 })
    const res = await dispatch(srv, '/app.js')
    expect(res.state.statusCode).toBe(200)
    expect(res.state.headers['Content-Type']).toBe('application/javascript; charset=utf-8')
  })

  it('集成：原始 req.url 含 ../ → dispatch 的 URL 构造先行归一化，逃逸不成立（fallback index）', async () => {
    const { root, indexBody } = makeRoot()
    const srv = new HttpServer({ router: stubRouter(), staticDir: root, port: 3000 })
    // req.url 原样携带 '../'——生产请求入口的真实形态（llhttp 不改写路径）。
    const res = await dispatch(srv, '/../../secret.txt')
    expect(res.state.statusCode).toBe(200)
    expect(res.state.body).toBe(indexBody)
    expect(res.state.body.includes('TOP-SECRET')).toBe(false)
  })
})
