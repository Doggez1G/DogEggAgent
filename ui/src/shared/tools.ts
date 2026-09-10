// 工厂内置工具名清单——TUI 配置编辑器的权限桶选择器用（与 agent/src/tools/registry.ts
// withBuiltins 保持同步）。WebUI 设置面板改用运行时 tools_request → tools_list（registry 是活的，
// 运行期注册的工具自动出现），不依赖此静态清单。
export const KNOWN_TOOLS = ['read_file', 'write_file', 'edit_file', 'shell', 'ls', 'glob', 'grep'] as const
