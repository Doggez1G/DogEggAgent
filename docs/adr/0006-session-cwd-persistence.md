# 会话 Cwd 持久化 + 项目/会话树

会话文件存储 cwd 字段，resume 时恢复 `this.cwd`。session_list 返回 cwd，前端按 cwd 分组为项目树。new_session 可选传 cwd（WebUI 项目树添加会话用）。删除会话功能：deleteSession + delete_session 消息 + session_deleted 回传。方案为顺序切换（单 Agent），running 守卫保护运行中切换。TUI 零破坏（cwd 可选，旧 TUI 不传）。
