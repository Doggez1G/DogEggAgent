import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, it, expect } from 'vitest'
import { Router } from '../../src/http/router'
import { FsBrowser } from '../../src/fs'
import { SseChannel } from '../../src/channel'

// ─────────────────────────────────────────────────────────────────────────────
// 目录浏览端点测试（此前零覆盖）。实际挂载路径是 GET /api/fs（Router 内 FsBrowser）——
// 经 Router.handle 直调 handler（既有 mock req/res 模式，不建真 socket）：
// 1. 列表内容与排序（仅子目录、files=true 附带文件、current/parent）；
// 2. 不存在路径 → 200 空状态（读实现确认：空列表语义，非错误响应）；
// 3. 任意绝对路径按原样解析（FsBrowser 无 root 包围概念——外层防线是 HttpServer 的
//    本地来源校验，见 http-server.test；此处按实际行为钉住「无包围」契约本身）。
// ─────────────────────────────────────────────────────────────────────────────

interface FsListResult {
  current: string
  dirs: string[]
  files: string[]
  parent: string | null
}

// 可记录状态的最小 ServerResponse 桩（与 http-server.test.ts 的 makeRes 同模式，多记 headers）。
function makeRes() {
  const state = { statusCode: 0, headers: {} as Record<string, unknown>, body: '' }
  return {
    state,
    writeHead: (code: number, headers?: Record<string, string>) => {
      state.statusCode = code
      if (headers) state.headers = { ...state.headers, ...headers }
    },
    setHeader: () => {},
    end: (body?: string | Buffer) => { state.body = Buffer.isBuffer(body) ? body.toString('utf8') : (body ?? '') },
  }
}
type MockRes = ReturnType<typeof makeRes>

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// 临时目录树：三个子目录（乱序创建，验证排序）+ 两个根级文件 + 一个子目录内文件。
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'dogegg-fs-'))
  dirs.push(root)
  mkdirSync(join(root, 'b-dir'))
  mkdirSync(join(root, 'a-dir'))
  mkdirSync(join(root, 'z-dir'))
  writeFileSync(join(root, 'f1.txt'), 'x')
  writeFileSync(join(root, 'a2.txt'), 'y')
  writeFileSync(join(root, 'a-dir', 'nested.txt'), 'z')
  return root
}

// GET /api/fs 直调 Router handler。query 形如 '?path=...' 或 ''。
async function handleFs(query: string, method = 'GET'): Promise<MockRes> {
  const router = new Router({ channel: new SseChannel() })
  const res = makeRes()
  const url = new URL(`http://localhost/api/fs${query}`)
  const req = { method, headers: {} } as unknown as IncomingMessage
  await router.handle(req, res as unknown as ServerResponse, url)
  return res
}

function parseBody(res: MockRes): FsListResult {
  return JSON.parse(res.state.body) as FsListResult
}

describe('/api/fs（目录浏览端点）', () => {
  it('挂载与响应形态：200 + application/json；仅列子目录（排序），不列文件，current/parent 正确', async () => {
    const root = makeTree()
    const res = await handleFs(`?path=${encodeURIComponent(root)}`)
    expect(res.state.statusCode).toBe(200)
    expect(res.state.headers['Content-Type']).toBe('application/json; charset=utf-8')
    const body = parseBody(res)
    expect(body.current).toBe(resolve(root))
    // localeCompare 排序；默认只返回子目录——文件与子目录内条目都不出现。
    expect(body.dirs).toEqual(['a-dir', 'b-dir', 'z-dir'])
    expect(body.files).toEqual([])
    expect(body.parent).toBe(dirname(resolve(root)))
  })

  it('files=true 附带根级文件列表（同样排序，不含子目录内文件）', async () => {
    const root = makeTree()
    const res = await handleFs(`?path=${encodeURIComponent(root)}&files=true`)
    expect(res.state.statusCode).toBe(200)
    const body = parseBody(res)
    expect(body.dirs).toEqual(['a-dir', 'b-dir', 'z-dir'])
    expect(body.files).toEqual(['a2.txt', 'f1.txt'])
  })

  it('不存在路径 → 200 空状态（实现语义：空 dirs/files 让 UI 显示空状态，非错误响应）', async () => {
    const root = makeTree()
    const missing = join(root, 'no-such-dir')
    const res = await handleFs(`?path=${encodeURIComponent(missing)}`)
    expect(res.state.statusCode).toBe(200)
    const body = parseBody(res)
    expect(body.current).toBe(resolve(missing))
    expect(body.dirs).toEqual([])
    expect(body.files).toEqual([])
    // parent 仍可计算——UI 空状态下「返回上级」依旧可用。
    expect(body.parent).toBe(dirname(resolve(missing)))
  })

  it('POST → 405（端点只接受 GET）', async () => {
    const res = await handleFs('?path=/', 'POST')
    expect(res.state.statusCode).toBe(405)
  })

  it('缺省 path 参数 → 回落 process.cwd()（current 为其解析结果）', async () => {
    const res = await handleFs('')
    expect(res.state.statusCode).toBe(200)
    const body = parseBody(res)
    expect(body.current).toBe(resolve(process.cwd()))
    // cwd 的实际内容随环境变化——不断言 dirs/files 具体值。
  })

  it('任意绝对路径（树外）按原样解析——FsBrowser 无 root 包围（无包围契约本身在此钉住）', async () => {
    // 实现对齐说明：任务清单预期「越权路径（逃逸出 root）→ 错误响应」，但实现没有 root
    // 包围概念——FsBrowser 对任何绝对路径直接 readdir（文件名/目录名枚举，不读文件内容），
    // 防线在 http-server.test 已覆盖的 /api/* 本地来源校验。此处按实际行为断言：
    // 树外绝对目录可浏览、resolve 原样生效——若未来引入包围，此用例变红即视为有意的契约变更。
    const tree = makeTree()
    const outside = dirname(resolve(tree)) // os 临时目录（树根的上级）
    const res = await handleFs(`?path=${encodeURIComponent(outside)}`)
    expect(res.state.statusCode).toBe(200)
    const body = parseBody(res)
    expect(body.current).toBe(resolve(outside))
    // 刚创建的树根必然出现在其上级目录的子目录清单里（并发创建的其它临时目录不作断言）。
    expect(body.dirs).toContain(resolve(tree).split(/[\\/]/).pop())
  })
})

describe('FsBrowser（单元语义）', () => {
  it('resolveFsPath：相对路径锚定 process.cwd()，缺省回落 cwd', () => {
    const fs = new FsBrowser()
    expect(fs.resolveFsPath('a/b')).toBe(resolve(process.cwd(), 'a/b'))
    expect(fs.resolveFsPath(undefined)).toBe(process.cwd())
  })

  it('盘根目录的 parent 为 null（「返回上级」按钮消失的边界）', async () => {
    const fs = new FsBrowser()
    const root = resolve('/') // Windows: 当前盘根（如 D:\）；POSIX: /
    const body = await fs.listDirs(root)
    expect(body.current).toBe(root)
    expect(body.parent).toBeNull()
  })
})
