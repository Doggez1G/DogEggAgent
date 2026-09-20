import { useEffect, useState } from 'react'
import type { UiPort } from '@dogegg/bridge'

// skills 数据域：skills_list 广播的镜像（TUI app.tsx 同款职责的 WebUI 版）。
// 只保留可用条目（enabled 且非缺失）——斜杠联想/Cmd+K 不该出现停用与孤儿；设置页单独订阅
// skills_list 全量（含状态字段）做启停管理。
// 消费方：InputBar 斜杠联想/路由、Cmd+K 面板 Skills 组、设置页 Skills section。
export function useSkills(port: UiPort): { name: string; description: string }[] {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])

  useEffect(() => {
    port.post({ type: 'skills_request' }) // 挂载播种——与 config/status 请求同批
    const off = port.onMessage((msg) => {
      if (msg.type === 'skills_list') setSkills(msg.skills.filter((s) => s.enabled && !s.missing).map((s) => ({ name: s.name, description: s.description })))
    })
    return off
  }, [port])

  return skills
}
