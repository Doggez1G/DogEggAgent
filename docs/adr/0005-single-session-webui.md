# WebUI 单会话模式

同一时刻只有一个活跃会话。可 /new、/session、resume 切换，但切换前需等完或打断。与 TUI 行为完全一致，改动最小。多会话并行执行（多个 Agent 实例 + 消息带 sessionId）留待后续版本，那时需要改消息契约和管理多 Agent 生命周期。
