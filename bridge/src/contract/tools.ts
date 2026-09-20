// 工具身份契约——注册期记录的「这个工具从哪来」。统一注册关口（registry）为每个工具维护一份，
// 与工具同增同删；一切需要知道工具来源的语义（权限服务键匹配、UI 来源标注/分组）都走这里，
// 不从 LLM 可见名里解析。住 bridge 的原因：权限匹配引擎（contract/permission.ts）与
// tools_list 载荷（contract/agent-to-ui.ts）都消费它，属契约数据。

// 工具身份两态：
// - builtin：系统内建工具（read_file/shell/...）——注册表默认身份，无附加信息；
// - mcp：MCP 工具——server 是配置里的服务裸名（权限桶键与之精确匹配），name 是服务侧声明的
//   内部工具名（tools/list 原文，权限服务键数组条目的匹配对象；与 LLM 可见的命名空间标签无关）。
export type ToolIdentity =
  | { kind: 'builtin' }
  | { kind: 'mcp'; server: string; name: string }

// tools_list 的单条载荷：工具 + 身份。identity 每条必带——注册表不变量「凡注册必有身份」。
export interface ToolListItem {
  name: string
  description: string
  identity: ToolIdentity
}
