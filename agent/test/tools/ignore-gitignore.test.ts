import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { loadGitIgnore } from '../../src/tools/traverse'
import { walkFiles } from '../../src/tools/traverse'

let dir: string | null = null
function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), 'dogegg-gi-'))
  return dir
}
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
})

async function collect(root: string): Promise<string[]> {
  const gi = loadGitIgnore(root)
  const out: string[] = []
  for await (const rel of walkFiles(root, { gitignore: gi ?? undefined })) out.push(rel)
  return out
}

describe('loadGitIgnore（.gitignore 核心子集）', () => {
  it('无 .gitignore 返回 undefined（行为不变）', () => {
    const d = fresh()
    writeFileSync(join(d, 'a.txt'), 'x')
    expect(loadGitIgnore(d)).toBeUndefined()
  })

  it('目录模式（尾 /）剪枝整个子树；不含斜杠的模式匹配任意层级', async () => {
    const d = fresh()
    writeFileSync(join(d, '.gitignore'), 'build/\n*.log\nsecret\n')
    mkdirSync(join(d, 'build', 'sub'), { recursive: true })
    writeFileSync(join(d, 'build', 'x.js'), 'x')
    writeFileSync(join(d, 'build', 'sub', 'y.js'), 'x')
    mkdirSync(join(d, 'src'), { recursive: true })
    writeFileSync(join(d, 'src', 'a.log'), 'x')
    writeFileSync(join(d, 'secret.key'), 'x')
    writeFileSync(join(d, 'src', 'secret.pem'), 'x') // 无斜杠模式 → 任意层级命中
    writeFileSync(join(d, 'keep.txt'), 'x')
    const files = await collect(d)
    expect(files).toEqual(['.gitignore', 'keep.txt', 'secret.key', 'src/secret.pem'])
  })

  it('锚定与相对根：前导 / 只匹配根级；含斜杠相对根', async () => {
    const d = fresh()
    writeFileSync(join(d, '.gitignore'), '/README.md\ndocs/internal.md\n')
    mkdirSync(join(d, 'docs'), { recursive: true })
    writeFileSync(join(d, 'README.md'), 'x')
    writeFileSync(join(d, 'docs', 'README.md'), 'x')
    writeFileSync(join(d, 'docs', 'internal.md'), 'x')
    const files = await collect(d)
    expect(files.sort()).toEqual(['.gitignore', 'docs/README.md'])
  })

  it('walker cwd 参数：子根扫描时按 cwd 相对路径判定（坐标换算由 walker 负责）', async () => {
    // 子根扫描（root≠cwd）时，谓词必须收到相对 cwd 的路径——否则锚定规则双向失真：
    // `docs/internal.md` 变成 internal.md 匹配不上、`/README.md` 反而误杀子根同名文件。
    const d = fresh()
    writeFileSync(join(d, '.gitignore'), 'docs/internal.md\n/top.md\n')
    mkdirSync(join(d, 'docs'), { recursive: true })
    writeFileSync(join(d, 'docs', 'internal.md'), 'x')
    writeFileSync(join(d, 'docs', 'README.md'), 'x')
    const gi = loadGitIgnore(d)
    const out: string[] = []
    for await (const rel of walkFiles(join(d, 'docs'), { gitignore: gi, cwd: d })) out.push(rel)
    expect(out).toEqual(['README.md'])
  })

  it('! 取反：后匹配优先（被忽略目录内的例外文件）', async () => {
    const d = fresh()
    writeFileSync(join(d, '.gitignore'), 'logs/**\n!logs/keep.log\n')
    mkdirSync(join(d, 'logs'), { recursive: true })
    writeFileSync(join(d, 'logs', 'a.log'), 'x')
    writeFileSync(join(d, 'logs', 'keep.log'), 'x')
    const files = await collect(d)
    expect(files).toEqual(['.gitignore', 'logs/keep.log'])
  })

  it('注释与空行跳过；非法行不拖垮忽略表', async () => {
    const d = fresh()
    writeFileSync(join(d, '.gitignore'), '# 注释\n\n   \n*.tmp\n[非法\n')
    writeFileSync(join(d, 'a.tmp'), 'x')
    writeFileSync(join(d, 'b.txt'), 'x')
    const files = await collect(d)
    expect(files).toEqual(['.gitignore', 'b.txt'])
  })
})
