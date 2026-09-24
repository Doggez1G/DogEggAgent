import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 轮转阈值：单会话日志超过 5MB 时轮转一次（当前文件 rename 为 <名>.old，覆盖旧 .old）。
// 单会话日志可达 MB 级——tool_start 会记录完整参数 JSON（大文件读写/长命令输出都进参数），
// 不设上限的话日志目录会无限膨胀；保留一份 .old 够诊断「刚才那次出问题前发生了什么」。
const ROTATE_BYTES = 5 * 1024 * 1024
// tail 只读文件末尾的窗口大小——整读一个 MB 级日志只为取 50 行不可接受。
const TAIL_WINDOW_BYTES = 64 * 1024

// 日志实例：每个 session 一个日志文件（<dir>/<session-id>.log），按时间戳 + scope 追加写。
// dir 为 null 表示日志未启用——log/tail 全部静默（测试中不传目录也能跑）。
export class Logger {
  constructor(private readonly dir: string | null) {
    if (dir) mkdirSync(dir, { recursive: true })
  }

  // 给定 session 的日志文件路径；未启用时返回 null。
  path(sessionId: string): string | null {
    return this.dir ? join(this.dir, `${sessionId}.log`) : null
  }

  // 追加写一行日志：时间戳 + scope + 消息。未启用时静默跳过。
  // 内存计数轮转：按会话在内存里累计已写字节数（首次对该会话写入时 statSync 对齐现存文件大小，
  // 进程重启后计数不失真），超过 ROTATE_BYTES 时把当前文件 rename 为 <名>.old（覆盖旧 .old），
  // 计数归零重新开始——rename 是同目录原子操作，无半写风险。
  log(sessionId: string, scope: string, msg: string): void {
    if (!this.dir) return
    const path = join(this.dir, `${sessionId}.log`)
    const line = `${new Date().toISOString()} [${scope}] ${msg}\n`
    let written = this.written.get(sessionId)
    if (written === undefined) {
      written = existsSync(path) ? statSync(path).size : 0
    }
    written += Buffer.byteLength(line)
    if (written > ROTATE_BYTES) {
      try { renameSync(path, path + '.old') } catch { /* 首次写入前文件尚不存在等——轮转失败不阻断本次记录 */ }
      written = Buffer.byteLength(line)
    }
    this.written.set(sessionId, written)
    appendFileSync(path, line)
  }
  private readonly written = new Map<string, number>()

  // 读取日志尾部若干行，用于 /log 面板展示。文件不存在时返回空串（会话尚未产生日志）。
  // 只读文件末尾（open + 从 end 倒读最后 64KB 窗口再取 50 行）——单会话日志可达 MB 级
  //（tool_start 记录完整参数 JSON），readFileSync 整读只为取尾部不可接受。
  // 窗口首行可能是被截断的半行——展示容忍（日志是诊断视图，不是结构化数据）。
  tail(sessionId: string, lines = 50): string {
    const path = this.path(sessionId)
    if (!path || !existsSync(path)) return ''
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const window = Math.min(size, TAIL_WINDOW_BYTES)
      const buf = Buffer.alloc(window)
      readSync(fd, buf, 0, window, size - window)
      const all = buf.toString('utf8').split('\n').filter((l) => l.length > 0)
      return all.slice(-lines).join('\n')
    } finally {
      closeSync(fd)
    }
  }
}
