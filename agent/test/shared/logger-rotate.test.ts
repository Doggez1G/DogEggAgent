import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { Logger } from '../../src/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Logger 轮转与尾部读取：单会话日志可达 MB 级（tool_start 记录完整参数 JSON）——
// 内存计数超 5MB 轮转一次（当前文件 rename 为 <名>.old 覆盖旧 .old）；tail 只读文件末尾。
// ─────────────────────────────────────────────────────────────────────────────

let root: string | null = null
afterEach(() => {
  if (root) { rmSync(root, { recursive: true, force: true }); root = null }
})

describe('Logger 内存计数轮转', () => {
  it('写入超过 5MB：当前文件轮转为 .old，新写入落回主文件', () => {
    root = mkdtempSync(join(tmpdir(), 'dogegg-log-rotate-'))
    const logger = new Logger(root)
    const mb = 'x'.repeat(1024 * 1024 - 60) // 连时间戳/scope 后一行约 1MB
    for (let i = 0; i < 6; i++) logger.log('s', 'tool', mb)
    // 第 6 行写入时累计 > 5MB → 前 5 行（约 5MB）轮转为 .old，主文件只剩第 6 行。
    const main = join(root, 's.log')
    const old = join(root, 's.log.old')
    expect(existsSync(old)).toBe(true)
    expect(readFileSync(old, 'utf8')).toContain('[tool]')
    expect(statSync(main).size).toBeLessThan(2 * 1024 * 1024)
    expect(readFileSync(main, 'utf8')).toContain('[tool]')
  })
})

describe('Logger.tail 只读文件末尾', () => {
  it('大文件（>64KB 窗口）只取尾部 50 行，内容正确', () => {
    root = mkdtempSync(join(tmpdir(), 'dogegg-log-tail-'))
    const logger = new Logger(root)
    // 直写一个大文件（~2000 行 × ~100B ≈ 200KB，超过 64KB 读取窗口）。
    const lines: string[] = []
    for (let i = 0; i < 2000; i++) lines.push(`2026-01-01T00:00:00.000Z [state] line-${String(i).padStart(4, '0')}`)
    writeFileSync(join(root, 'big.log'), lines.join('\n') + '\n')
    const tail = logger.tail('big').split('\n')
    expect(tail).toHaveLength(50)
    expect(tail[0]).toContain('line-1950')
    expect(tail[49]).toContain('line-1999')
  })

  it('小文件（<64KB）行为不变：返回全部行的最后 N 行', () => {
    root = mkdtempSync(join(tmpdir(), 'dogegg-log-tail2-'))
    const logger = new Logger(root)
    for (let i = 1; i <= 5; i++) logger.log('s', 'state', `line ${i}`)
    const tail = logger.tail('s', 2).split('\n')
    expect(tail).toHaveLength(2)
    expect(tail[0]).toContain('line 4')
    expect(tail[1]).toContain('line 5')
  })
})
