import type { PermissionDecision } from './shared'
import type { McpServerConfig } from './config'

// 前端 → 后端的消息契约。command 与 event 本质相同，只是方向相反，故统一为「消息」。
export type UiToAgentMessage =
  | { type: 'submit'; text: string }
  | { type: 'permission_decision'; id: string; decision: PermissionDecision }
  | { type: 'cancel' }
  | { type: 'new_session'; cwd?: string } // 新建会话，可选指定工作目录（WebUI 项目树添加会话用）
  | { type: 'list_sessions' }
  | { type: 'resume_session'; id: string }
  | { type: 'config_request' }
  | { type: 'config_set'; path: string; value: unknown }
  | { type: 'config_add'; path: string; value: unknown }
  | { type: 'config_remove'; path: string; index: number; providerIndex?: number }
  | { type: 'tools_request' }
  | { type: 'context_request' }
  | { type: 'system_request' }
  | { type: 'status_request' }
  | { type: 'log_request' }
  | { type: 'permissions_request' } // /permissions：查询当前会话的 allow_always 授权
  | { type: 'permission_revoke'; tool: string; pattern?: string } // 撤销会话提升：带 pattern 撤单条模式（撤光即移除整条提升），不带撤整工具
  | { type: 'rename_session'; title: string } // 重命名当前会话（/rename <名称>；手动命名优先于自动标题）
  | { type: 'skills_request' } // 拉取当前可用 skills 清单（挂载播种 + 管理操作后刷新）
  | { type: 'skills_manage'; action: 'create' | 'update' | 'delete' | 'get'; scope: 'project' | 'user'; name: string; description?: string; content?: string } // skills 面板 CRUD：create 用 name+description 生成骨架；update 写全文；get 回 skill_content
  | { type: 'invoke_skill'; name: string; args: string } // 调用 skill：正文 $ARGUMENTS 替换后作为用户消息进轮次
  | { type: 'mcp_request' } // 拉取 MCP server 配置 + 运行时状态
  | { type: 'mcp_manage'; action: 'save' | 'delete' | 'toggle'; scope: 'global' | 'project'; server?: McpServerConfig; name?: string; enabled?: boolean } // /mcp 面板 CRUD：save 写入/更新条目（保存即重启），toggle 只改 enabled
  | { type: 'set_cwd'; path: string } // 运行时切换工作目录（/cd 命令 / WebUI 目录选择器共用）
  | { type: 'delete_session'; id: string } // 删除会话文件（WebUI 项目树删除会话用）
  | { type: 'clear_history' }
  | { type: 'compact_request' }
  | { type: 'quit' }