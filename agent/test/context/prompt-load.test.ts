import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { loadSystemPrompt, BUILTIN_PROMPT } from '../../src/context/prompt'

// ─────────────────────────────────────────────────────────────────────────────
// loadSystemPrompt 失效路径回退（运行时可用性优先）：文件被移动/删除/权限收紧后，
// 读取失败回退内置默认 prompt——失效路径不该炸掉每一轮请求。
// 配置入口侧的拦截在 config 编辑校验（validate.ts existsSync），两层语义互补。
// ─────────────────────────────────────────────────────────────────────────────

let root: string | null = null
afterEach(() => {
  if (root) { rmSync(root, { recursive: true, force: true }); root = null }
})

describe('loadSystemPrompt', () => {
  it('未配置路径 → 内置默认', () => {
    expect(loadSystemPrompt(undefined)).toBe(BUILTIN_PROMPT)
  })

  it('路径有效 → 返回文件正文', () => {
    root = mkdtempSync(join(tmpdir(), 'dogegg-prompt-'))
    const file = join(root, 'my-prompt.md')
    writeFileSync(file, '# 自定义提示词\n正文内容')
    expect(loadSystemPrompt(file)).toContain('自定义提示词')
  })

  it('路径失效（不存在）→ 回退内置默认，不抛错', () => {
    expect(loadSystemPrompt(join(tmpdir(), 'dogegg-prompt-nope', 'gone.md'))).toBe(BUILTIN_PROMPT)
  })
})
