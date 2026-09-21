import type { Key } from 'ink'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'

export interface SkillsKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
  openMenu(title: string, items: { label: string; onSelect: () => void }[], returnView?: View): void
  /** 吞掉打开菜单/弹层当次的回车（port 同步回响应可能立即换 view，避免误触）。 */
  suppressEnter(): void
  /** 用系统编辑器（$EDITOR）打开文件——阻塞直至编辑器退出，返回后由调用方刷新清单。 */
  openEditor(path: string): void
  /** 报错提示（校验失败等）——转 info 面板可见。 */
  notice(text: string): void
}

// Skills 面板按键：↑↓ 选择、Enter 查看详情（get → skill_content → info 面板，esc 回本面板）、
// a 新建（表单视图：落点/名称/描述一屏列出）、e 用 $EDITOR 打开、d 删除（确认菜单 esc 回面板）、
// esc 返回。空列表时只有 a/esc 有意义。
export function handleSkillsKeys(v: Extract<View, { kind: 'skills' }>, key: Key, inputChar: string, api: SkillsKeysApi): void {
  const current = v.skills[v.cursor]
  if (key.upArrow) {
    api.setView({ ...v, cursor: (v.cursor + v.skills.length - 1) % Math.max(1, v.skills.length) })
  } else if (key.downArrow) {
    api.setView({ ...v, cursor: (v.cursor + 1) % Math.max(1, v.skills.length) })
  } else if (key.escape) {
    api.setView({ kind: 'none' })
  } else if (key.return && current) {
    // 详情：请求全文——skill_content 到达后由事件层开 info 面板展示。
    api.post({ type: 'skills_manage', action: 'get', scope: current.scope, name: current.name })
  } else if (inputChar === 'a') {
    // 新建：表单视图——落点是选项字段（Enter 在项目级/用户级间切换），无需前置菜单。
    api.suppressEnter()
    createForm(api, v)
  } else if (inputChar === 'e' && current && !current.missing) {
    // 缺失态无文件可编（WebUI 同款守卫）——清理走 t（启用）或 d（删除）。
    api.openEditor(current.path)
  } else if (inputChar === 't' && current) {
    // 启停：停用 = 退出系统提示/联想/调用（保留文件）；缺失态按 t = 清理孤儿记录（等价启用）。
    api.post({ type: 'skills_manage', action: 'toggle', scope: current.scope, name: current.name, enabled: !current.enabled })
  } else if (inputChar === 'd' && current) {
    api.suppressEnter()
    api.openMenu(`删除 skill ${current.name}（${current.scope}）？目录将整体删除，不可恢复。`, [
      { label: '确认删除', onSelect: () => { api.post({ type: 'skills_manage', action: 'delete', scope: current.scope, name: current.name }); api.setView(v) } },
      { label: '取消', onSelect: () => api.setView(v) },
    ], v)
  }
}

// 创建表单（重构自两步 prompt 链）：落点/名称/描述一屏列出，Enter 逐字段编辑/切换，
// s 或保存行提交；校验失败 notice 并留在表单；esc 回列表不保存。
function createForm(api: SkillsKeysApi, panel: Extract<View, { kind: 'skills' }>): void {
  api.setView({
    kind: 'form',
    title: '新建 skill',
    fields: [
      {
        label: '落点',
        value: 'project',
        options: [
          { label: '项目级（.dogegg/skills，随仓库共享）', value: 'project' },
          { label: '用户级（~/.dogegg/skills，个人所有项目）', value: 'user' },
        ],
      },
      { label: '名称（小写字母/数字/连字符）', value: '' },
      { label: '一句话描述（模型与面板靠它判断何时使用）', value: '' },
    ],
    cursor: 0,
    returnView: panel,
    submitLabel: '创建 skill',
    onSubmit: ([scope, name, description]) => {
      const n = name?.trim() ?? ''
      if (!n) { api.notice('名称不能为空——未创建'); return }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) { api.notice('名称只允许小写字母/数字/连字符（字母或数字开头）——未创建'); return }
      api.post({ type: 'skills_manage', action: 'create', scope: (scope ?? 'project') as 'project' | 'user', name: n, description: description?.trim() ?? '' })
      api.setView(panel) // 回列表——skills_list 广播驱动刷新
    },
  })
}
