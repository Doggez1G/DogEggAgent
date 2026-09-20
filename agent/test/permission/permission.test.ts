import { join } from 'node:path'
import { homedir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { PermissionManager } from '../../src/permission'
import type { PermissionConfig, PermissionRule } from '@dogegg/bridge'

// v3 测试辅助：数组简写减少用例噪音（[] = 整键 whole:true，非空 = 按模式 whole:false）；
// 需要精确控制（如空选态）时直接传 PermissionRule 对象。
type RuleInput = string[] | PermissionRule
const rules = (m: Record<string, RuleInput>): Record<string, PermissionRule> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [
    k,
    Array.isArray(v) ? (v.length === 0 ? { whole: true, patterns: [] } : { whole: false, patterns: v }) : v,
  ]))
const cfg = (allow: Record<string, RuleInput> = {}, reject: Record<string, RuleInput> = {}, ask: Record<string, RuleInput> = {}): PermissionConfig =>
  ({ allow: rules(allow), reject: rules(reject), ask: rules(ask) })

describe('PermissionManager', () => {
  it('classifies by bucket with safe default', () => {
    const pm = new PermissionManager(cfg({ read_file: [] }, { shell: [] }, { write_file: [] }))
    expect(pm.classify('read_file')).toBe('allow')
    expect(pm.classify('shell')).toBe('reject')
    expect(pm.classify('write_file')).toBe('ask')
    expect(pm.classify('edit_file')).toBe('ask') // 未列出 → 默认 ask
  })

  it('whole = 整工具（patterns 不参与）；whole:false + 空选 = 键存在但不命中（v3 立法）', () => {
    const pm = new PermissionManager(cfg({ grep: [] }))
    expect(pm.classify('grep', { pattern: 'anything' }, 'D:\\proj')).toBe('allow')
    // 显式空选：规则存在但不命中任何东西 → 落默认 ask
    const pm2 = new PermissionManager({ allow: { grep: { whole: false, patterns: [] } }, reject: {}, ask: {} })
    expect(pm2.classify('grep', { pattern: 'anything' }, 'D:\\proj')).toBe('ask')
  })

  it('allow_always promotes tool for the session', () => {
    const pm = new PermissionManager(cfg({}, {}, { write_file: [] }))
    pm.apply('write_file', 'allow_always')
    expect(pm.classify('write_file')).toBe('allow')
  })

  it('reject decision does not promote', () => {
    const pm = new PermissionManager(cfg({}, {}, { write_file: [] }))
    pm.apply('write_file', 'reject')
    expect(pm.classify('write_file')).toBe('ask')
  })
})

describe('PermissionManager 参数化模式', () => {
  it('模式命中即放行（./ 锚定 cwd：相对/绝对/反斜杠写法同一判定）', () => {
    const pm = new PermissionManager(cfg({ read_file: ['./docs/**'] }))
    const cwd = 'D:\\proj'
    // 三种写法同一文件，判定必须一致——归一化是参数化规则可用性的前提。
    expect(pm.classify('read_file', { path: 'docs/guide.md' }, cwd)).toBe('allow')
    expect(pm.classify('read_file', { path: 'docs\\guide.md' }, cwd)).toBe('allow')
    expect(pm.classify('read_file', { path: 'D:/proj/docs/guide.md' }, cwd)).toBe('allow')
    // cwd 之外 → 相对模式必然失配（fail-closed）
    expect(pm.classify('read_file', { path: 'src/index.ts' }, cwd)).toBe('ask')
  })

  it('主参数表决定约束哪个参数与匹配函数：path 分段 glob（* 单段 ** 跨段），command 平文本通配', () => {
    const pm = new PermissionManager(cfg({ shell: ['git *'] }))
    expect(pm.classify('shell', { command: 'git status' }, 'D:\proj')).toBe('allow')
    expect(pm.classify('shell', { command: 'git commit -m "a/b"' }, 'D:\proj')).toBe('allow') // command：* = 任意字符
    expect(pm.classify('shell', { command: 'npm test' }, 'D:\proj')).toBe('ask')
    // path 主参数：分段 glob——* 不跨段（安全性质），** 才跨
    const pm2 = new PermissionManager(cfg({ read_file: ['./docs/*'] }))
    expect(pm2.classify('read_file', { path: 'docs/guide.md' }, 'D:\proj')).toBe('allow')
    expect(pm2.classify('read_file', { path: 'docs/sub/guide.md' }, 'D:\proj')).toBe('ask')
    const pm3 = new PermissionManager(cfg({ read_file: ['./docs/**'] }))
    expect(pm3.classify('read_file', { path: 'docs/sub/guide.md' }, 'D:\proj')).toBe('allow')
    })

  it('会话内 allow_always 压过 ask 规则（用户最新显式意图，除 reject 外最高）', () => {
    const pm = new PermissionManager(cfg({}, {}, { shell: ['rm *'] }))
    expect(pm.classify('shell', { command: 'rm x.txt' }, 'D:\\proj')).toBe('ask')
    pm.apply('shell', 'allow_always')
    expect(pm.classify('shell', { command: 'rm x.txt' }, 'D:\\proj')).toBe('allow')
    // 但 reject 硬拒绝仍压过会话提升
    const pm2 = new PermissionManager(cfg({}, { shell: [] }))
    pm2.apply('shell', 'allow_always')
    expect(pm2.classify('shell')).toBe('reject')
  })

  it('未命中的键回落默认 ask（ask 桶为空时判定顺序不变）', () => {
    const pm = new PermissionManager(cfg({ read_file: [] }, { shell: [] }))
    expect(pm.classify('read_file')).toBe('allow')
    expect(pm.classify('shell')).toBe('reject')
    expect(pm.classify('anything')).toBe('ask')
  })

  it('路径规则锚定 cwd：./** 不能命中逃逸到 cwd 外的参数（fail-open 漏洞回归）', () => {
    const pm = new PermissionManager(cfg({ read_file: ['./**'] }))
    const cwd = 'D:\\proj'
    expect(pm.classify('read_file', { path: 'src/a.ts' }, cwd)).toBe('allow')
    // ** 编译为 .* 能匹配绝对路径——仅靠归一化约定挡不住，必须作用域立法拦截
    expect(pm.classify('read_file', { path: '../outside.txt' }, cwd)).toBe('ask')
    expect(pm.classify('read_file', { path: 'D:/other/x.md' }, cwd)).toBe('ask')
  })

  it('*/x 与 **/x 语义不同：* 单段、** 跨段（一套逻辑，算子有别）', () => {
    const single = new PermissionManager(cfg({ read_file: ['*/test'] }))
    const cross = new PermissionManager(cfg({ read_file: ['**/test'] }))
    // 盘根一层：两者都命中
    expect(single.classify('read_file', { path: 'D:/test' }, 'D:\proj')).toBe('allow')
    expect(cross.classify('read_file', { path: 'D:/test' }, 'D:\proj')).toBe('allow')
    // 深层：只有 ** 命中
    expect(single.classify('read_file', { path: 'test' }, 'D:\proj')).toBe('ask') // D:/proj/test——两段
    expect(cross.classify('read_file', { path: 'test' }, 'D:\proj')).toBe('allow')
    })

  it('锚点对比：./**/x 锚定 cwd，**/x 全盘', () => {
    const anchored = new PermissionManager(cfg({ read_file: ['./**/test'] }))
    const global = new PermissionManager(cfg({ read_file: ['**/test'] }))
    expect(anchored.classify('read_file', { path: 'src/test' }, 'D:\\proj')).toBe('allow')
    expect(anchored.classify('read_file', { path: '../sibling/test' }, 'D:\\proj')).toBe('ask')
    expect(global.classify('read_file', { path: '../sibling/test' }, 'D:\\proj')).toBe('allow')
  })


  it('显式绝对模式可授权 cwd 之外（两侧同为绝对形式可比）', () => {
    const pm = new PermissionManager(cfg({ read_file: ['D:/allowed/**'] }))
    expect(pm.classify('read_file', { path: 'D:/allowed/x.txt' }, 'D:\\proj')).toBe('allow')
    expect(pm.classify('read_file', { path: 'D:/forbidden/x.txt' }, 'D:\\proj')).toBe('ask')
    // cwd 内参数对绝对模式失配（授权范围就是那个绝对子树）
    expect(pm.classify('read_file', { path: 'src/a.ts' }, 'D:\\proj')).toBe('ask')
  })

  it('绝对模式中的 .. 由 resolve 折叠（规则按直觉生效，而非永远失配）', () => {
    const pm = new PermissionManager(cfg({ read_file: ['D:/proj/../shared/**'] }))
    // 折叠后授权的是 D:/shared/**——同一文件的两种写法判定一致
    expect(pm.classify('read_file', { path: 'D:/shared/x.txt' }, 'D:\\proj')).toBe('allow')
    expect(pm.classify('read_file', { path: '../shared/x.txt' }, 'D:\\proj')).toBe('allow')
    // D:/proj/shared 不在折叠后的子树里，必须问
    expect(pm.classify('read_file', { path: 'shared/x.txt' }, 'D:\\proj')).toBe('ask')
  })

  it('cwd 缺省（display-only）时不做归一化，模式照原文匹配', () => {
    const pm = new PermissionManager(cfg({ read_file: ['docs/**'] }))
    expect(pm.classify('read_file', { path: 'docs/guide.md' })).toBe('allow')
    expect(pm.classify('read_file', { path: 'D:/proj/docs/guide.md' })).toBe('ask') // 未归一 → 绝对参数失配
  })
})

describe('PermissionManager 会话提升（范围化）', () => {
  const cwd = 'D:\proj'

  it('scoped 提升 path 工具：落库解析为绝对模式，同目录命中', () => {
    const pm = new PermissionManager(cfg())
    pm.apply('read_file', 'allow_always_scoped', './docs/**', cwd)
    // 库内为绝对形式：cwd 内同目录命中、其余询问
    expect(pm.classify('read_file', { path: 'docs/guide.md' }, cwd)).toBe('allow')
    expect(pm.classify('read_file', { path: 'src/x.ts' }, cwd)).toBe('ask')
  })

  it('scoped 提升 shell：command 通配（* 跨段）', () => {
    const pm = new PermissionManager(cfg())
    pm.apply('shell', 'allow_always_scoped', 'git *')
    expect(pm.classify('shell', { command: 'git status' })).toBe('allow')
    expect(pm.classify('shell', { command: 'npm test' })).toBe('ask')
  })

  it('scoped 追加去重；allow_always 整工具覆盖窄范围', () => {
    const pm = new PermissionManager(cfg())
    pm.apply('shell', 'allow_always_scoped', 'git *')
    pm.apply('shell', 'allow_always_scoped', 'git *') // 去重
    pm.apply('shell', 'allow_always_scoped', 'npm run *')
    expect(pm.classify('shell', { command: 'npm run test' })).toBe('allow')
    pm.apply('shell', 'allow_always') // 整工具覆盖
    expect(pm.classify('shell', { command: 'anything' })).toBe('allow')
  })

  it('snapshotPermissions / restore 往返（resume 场景）', () => {
    const pm = new PermissionManager(cfg())
    pm.apply('shell', 'allow_always_scoped', 'git *')
    pm.apply('read_file', 'allow_always', cwd)
    const snap = pm.snapshotPermissions()
    expect(snap).toEqual(expect.arrayContaining([
      { tool: 'shell', patterns: ['git *'] },
      { tool: 'read_file', patterns: [] },
    ]))
    const pm2 = new PermissionManager(cfg())
    pm2.restore(snap)
    expect(pm2.classify('shell', { command: 'git status' })).toBe('allow')
    expect(pm2.classify('read_file', { path: 'anywhere/x' })).toBe('allow')
  })

  it('撤销粒度：单条撤光即整条移除；整工具直接撤', () => {
    const pm = new PermissionManager(cfg())
    pm.apply('shell', 'allow_always_scoped', 'git *')
    pm.revoke('shell', 'git *')
    expect(pm.snapshotPermissions().find((e) => e.tool === 'shell')).toBeUndefined()
    pm.apply('shell', 'allow_always')
    pm.revoke('shell')
    expect(pm.snapshotPermissions()).toEqual([])
  })
})
