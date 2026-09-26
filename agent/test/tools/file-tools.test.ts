import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ReadFileTool, WriteFileTool, EditFileTool } from '../../src/tools'
import type { ToolContext } from '../../src/tools/types'
const dir = mkdtempSync(join(tmpdir(), 'dogegg-tools-'))
const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal }
const readFileTool = new ReadFileTool()
const writeFileTool = new WriteFileTool()
const editFileTool = new EditFileTool()

describe('file tools', () => {
  it('read_file returns content', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx)
    expect(r).toMatchObject({ content: 'hi' })
  })

  it('write_file creates and overwrites', async () => {
    await writeFileTool.execute({ path: 'b.txt', content: 'x' }, ctx)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('x')
  })

  it('edit_file replaces first occurrence with line anchor in receipt', async () => {
    writeFileSync(join(dir, 'c.txt'), 'foo foo')
    const r = await editFileTool.execute({ path: 'c.txt', old_string: 'foo', new_string: 'bar' }, ctx)
    // 回执锚点（原第 N 行起）供模型定位后续编辑 + UI diff 标真实行号。
    expect(r).toMatchObject({ content: '已替换 1 处（原第 1 行起）' })
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('bar foo')
  })

  it('edit_file anchor points at the old_string start line', async () => {
    writeFileSync(join(dir, 'd.txt'), 'l1\nl2\nl3')
    const r = await editFileTool.execute({ path: 'd.txt', old_string: 'l2', new_string: 'L2' }, ctx)
    expect(r).toMatchObject({ content: '已替换 1 处（原第 2 行起）' })
  })

  it('edit_file 空 old_string → error 回执且文件不变（防文件头静默插入）', async () => {
    // 回归点：空串 indexOf 恒为 0，replace 会把 new_string 静默插到文件头。
    writeFileSync(join(dir, 'e.txt'), 'keep me')
    const r = await editFileTool.execute({ path: 'e.txt', old_string: '', new_string: 'HACK' }, ctx)
    expect(r).toMatchObject({ error: 'old_string 不能为空' })
    expect(readFileSync(join(dir, 'e.txt'), 'utf8')).toBe('keep me')
    // schema 层第一道关口：min(1) 校验同样拦截空串
    expect(() => editFileTool.schema.parse({ path: 'e.txt', old_string: '', new_string: 'x' })).toThrow()
  })

  it('edit_file new_string 为空 = 删除语义（合法边界）', async () => {
    writeFileSync(join(dir, 'f.txt'), 'abcHEADdef')
    const r = await editFileTool.execute({ path: 'f.txt', old_string: 'HEAD', new_string: '' }, ctx)
    expect(r).toMatchObject({ content: '已替换 1 处（原第 1 行起）' })
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('abcdef')
  })

  it('edit_file old_string 未找到 → error 回执且文件不变', async () => {
    writeFileSync(join(dir, 'nf.txt'), 'unchanged')
    const r = await editFileTool.execute({ path: 'nf.txt', old_string: '不存在的片段', new_string: 'X' }, ctx)
    expect(r).toMatchObject({ error: 'old_string 未找到' })
    expect(readFileSync(join(dir, 'nf.txt'), 'utf8')).toBe('unchanged')
  })

  it('edit_file 多处匹配只替换首处（固化语义，不报错不扩散）', async () => {
    writeFileSync(join(dir, 'multi.txt'), 'aa aa')
    const r = await editFileTool.execute({ path: 'multi.txt', old_string: 'aa', new_string: 'b' }, ctx)
    expect(r).toMatchObject({ content: '已替换 1 处（原第 1 行起）' })
    expect(readFileSync(join(dir, 'multi.txt'), 'utf8')).toBe('b aa')
  })

  it('edit_file new_string 含 $& / $\' / $` / $$ 时按字面写入（函数形态替换，不做特殊序列重解释）', async () => {
    // 回归点（P1-2）：字符串形态的 replace 会把替换值里的 $&（整个匹配）、$'（匹配后文）、
    // $`（匹配前文）、$$（字面 $）重新解释改写，注入内容被篡改。函数形态（同 skills/manager.ts
    // forInvocation 先例）按字面插入。
    writeFileSync(join(dir, 'dollar.txt'), 'A-B')
    const magic = "[$&][$'][$`][$$]"
    const r = await editFileTool.execute({ path: 'dollar.txt', old_string: 'A', new_string: magic }, ctx)
    expect(r).toMatchObject({ content: '已替换 1 处（原第 1 行起）' })
    // 若被重解释，$&→A、$'→-B、$`→''、$$→$，结果会变成 [A][-B][][$]-B。
    expect(readFileSync(join(dir, 'dollar.txt'), 'utf8')).toBe("[$&][$'][$`][$$]-B")
  })

  it('write_file / edit_file 原子落盘：成功后目录无 .tmp 残留', async () => {
    // 原子写（tmp + rename）成功后临时文件必须被 rename 走——残留会污染目录、干扰 .endsWith('.json') 类过滤。
    await writeFileTool.execute({ path: 'atomic.txt', content: 'v1' }, ctx)
    await editFileTool.execute({ path: 'atomic.txt', old_string: 'v1', new_string: 'v2' }, ctx)
    expect(readFileSync(join(dir, 'atomic.txt'), 'utf8')).toBe('v2')
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('read_file 超过 1MB → error 回执并指引 grep；正常文件不受影响', async () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 1)) // 恰好越界
    const r = await readFileTool.execute({ path: 'big.txt' }, ctx)
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('文件超过 1MB')
    expect((r as { error: string }).error).toContain('grep')
    writeFileSync(join(dir, 'ok.txt'), 'normal')
    expect(await readFileTool.execute({ path: 'ok.txt' }, ctx)).toMatchObject({ content: 'normal' })
  })

  it('read_file 二进制文件（前 8KB 含 NUL）→ error 回执，不把乱码灌进上下文（P2-13）', async () => {
    // NUL 放在前 8KB 内即可触发探测；与 grep 的 isBinaryFile 同一口径——
    // grep 跳过的二进制，read_file 也必须拒绝，两侧对同一文件结论一致。
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x64, 0x00, 0x6f]))
    const r = await readFileTool.execute({ path: 'bin.dat' }, ctx)
    expect((r as { error: string }).error).toContain('二进制文件')
    expect((r as { error: string }).error).toContain('grep/glob')
  })

  it('read_file 剥离 UTF-8 BOM（P2-13）：BOM 不算内容', async () => {
    // EF BB BF 是 UTF-8 BOM 字节序列；旧实现 readFile(p,'utf8') 直出会把 \uFEFF 留在首字符。
    writeFileSync(join(dir, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]))
    const r = await readFileTool.execute({ path: 'bom.txt' }, ctx)
    expect(r).toMatchObject({ content: 'hello' })
  })

  it('read_file 绝对路径参数可用（P3 回归：win32 上 join 吞盘符冒号产生乱码路径报 ENOENT）', async () => {
    const abs = join(dir, 'abs.txt') // win32 上即 C:\...\Temp\dogegg-tools-xxx\abs.txt 形态
    writeFileSync(abs, 'abs ok')
    const r = await readFileTool.execute({ path: abs }, ctx)
    expect(r).toMatchObject({ content: 'abs ok' })
  })
})