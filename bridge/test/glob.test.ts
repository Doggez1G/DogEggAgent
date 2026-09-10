import { describe, it, expect } from 'vitest'
import { globToRegExp, matchGlob, matchWildcard } from '../src/contract/glob'

// matchGlob = 权限匹配与 glob 工具共用的唯一匹配函数。
// 标准 glob 语义：* 单段内任意（不跨 /）、** 跨任意层（含零层）、? 单字符、其余字面量，整串锚定。

describe('matchGlob', () => {
  // ── 单段 * ──
  it('* matches within a single segment only', () => {
    expect(matchGlob('*.ts', 'a.ts')).toBe(true)
    expect(matchGlob('*.ts', 'src/a.ts')).toBe(false) // 跨段必须显式 **/*.ts
    expect(matchGlob('*.ts', 'a.tsx')).toBe(false)
  })

  // ── 跨段 ** ──
  it('** matches across segments including zero', () => {
    expect(matchGlob('**/*.ts', 'a.ts')).toBe(true) // 零段——「任意深度」含根级
    expect(matchGlob('**/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('**/*.ts', 'src/deep/a.ts')).toBe(true)
    expect(matchGlob('src/**/x.ts', 'src/x.ts')).toBe(true)
    expect(matchGlob('src/**/x.ts', 'src/a/b/x.ts')).toBe(true)
  })

  it('src/** matches everything below but not src itself', () => {
    expect(matchGlob('src/**', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**', 'src/a/b.ts')).toBe(true)
    expect(matchGlob('src/**', 'src')).toBe(false)
  })

  // ── 单字符 ? ──
  it('? matches exactly one character (not /)', () => {
    expect(matchGlob('a?c', 'abc')).toBe(true)
    expect(matchGlob('a?c', 'ac')).toBe(false)
    expect(matchGlob('a?c', 'abbc')).toBe(false)
    expect(matchGlob('a?c', 'a/c')).toBe(false) // ? 不跨段
  })

  // ── 字面量转义 ──
  it('escapes regex metacharacters in literals', () => {
    expect(matchGlob('a.b.ts', 'aXb.ts')).toBe(false) // 点号是字面量
    expect(matchGlob('a.b.ts', 'a.b.ts')).toBe(true)
    expect(matchGlob('a(b)', 'a(b)')).toBe(true)
    expect(matchGlob('a+b', 'aab')).toBe(false)
  })

  // ── Windows 分隔符归一 ──
  it('normalizes backslashes to forward slashes', () => {
    expect(matchGlob('src/**/*.ts', 'src\\a\\b.ts')).toBe(true)
    expect(matchGlob('src\\**\\*.ts', 'src/a/b.ts')).toBe(true)
  })

  // ── globToRegExp 复用（工具批量过滤场景编译一次）──
  it('compiled regex is reusable and anchored', () => {
    const re = globToRegExp('**/*.json')
    expect(re.test('package.json')).toBe(true)
    expect(re.test('a/b/package.json')).toBe(true)
    expect(re.test('x.json.bak')).toBe(false) // ^...$ 锚定，非子串匹配
  })
})

describe('matchWildcard（command 主参数与工具名的平文本通配）', () => {
  it('* = 任意字符（含 /），* 与 ** 同义', () => {
    expect(matchWildcard('git *', 'git status')).toBe(true)
    expect(matchWildcard('git *', 'git commit -m "a/b"')).toBe(true)
    expect(matchWildcard('git **', 'git commit -m "a/b"')).toBe(true)
    expect(matchWildcard('npm run *', 'npm run test')).toBe(true)
    expect(matchWildcard('npm run *', 'yarn run test')).toBe(false)
  })
})
