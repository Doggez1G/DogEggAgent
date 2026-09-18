import type { Key } from 'ink'
import type { UiToAgentMessage } from '@dogegg/bridge'
import type { View } from '../../view-state'

export interface SkillsKeysApi {
  setView(view: View): void
  post(msg: UiToAgentMessage): void
  openMenu(title: string, items: { label: string; onSelect: () => void }[]): void
  /** 吞掉打开菜单/弹层当次的回车（port 同步回响应可能立即换 view，避免误触）。 */
  suppressEnter(): void
  /** 用系统编辑器（$EDITOR）打开文件——阻塞直至编辑器退出，返回后由调用方刷新清单。 */
  openEditor(path: string): void
}

// Skills 面板按键：↑↓ 选择、Enter 查看详情（get → skill_content → info 面板）、
// a 新建（选级别 → name → description 两步 prompt，esc 回本面板）、e 用 $EDITOR 打开、
// d 删除（确认菜单）、esc 返回。空列表时只有 a/esc 有意义。
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
    // 新建：先选级别（项目级随仓库共享 / 用户级个人所有），再两步输入。
    api.suppressEnter()
    api.openMenu('新建 skill 到哪一级？', [
      { label: '项目级（.dogegg/skills，随仓库共享）', onSelect: () => createFlow(api, v, 'project') },
      { label: '用户级（~/.dogegg/skills，个人所有项目）', onSelect: () => createFlow(api, v, 'user') },
    ])
  } else if (inputChar === 'e' && current) {
    api.openEditor(current.path)
  } else if (inputChar === 'd' && current) {
    api.suppressEnter()
    api.openMenu(`删除 skill ${current.name}（${current.scope}）？目录将整体删除，不可恢复。`, [
      { label: '确认删除', onSelect: () => { api.post({ type: 'skills_manage', action: 'delete', scope: current.scope, name: current.name }); api.setView({ kind: 'none' }) } },
      { label: '取消', onSelect: () => api.setView(v) },
    ])
  }
}

// 两步创建流：name → description（prompt 弹层 returnView 回本面板）→ post create（esc 任一步即放弃）。
function createFlow(api: SkillsKeysApi, panel: Extract<View, { kind: 'skills' }>, scope: 'project' | 'user'): void {
  api.setView({
    kind: 'prompt',
    title: 'skill 名称（小写字母/数字/连字符，即未来的 /命令名）',
    value: '',
    returnView: panel,
    onSubmit: (name) => {
      api.setView({
        kind: 'prompt',
        title: '一句话描述（模型与面板靠它判断何时使用）',
        value: '',
        returnView: panel,
        onSubmit: (description) => {
          api.post({ type: 'skills_manage', action: 'create', scope, name: name.trim(), description: description.trim() })
          api.setView({ kind: 'none' })
        },
      })
    },
  })
}
