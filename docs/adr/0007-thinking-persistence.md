# 思考内容持久化（Thinking Persistence）

推理模型的思考内容（reasoning）持久化到会话文件，resume 后恢复思考块显示。方案 A：思考内容存在 session JSON 的 thinking 字段中（独立于 history/context），不进模型上下文。

parser.ts 累积 reasoning 文本并在 done 事件携带。streamOnce 返回 `{ message, reasoning? }`（ChatResult）。loop 收集 thinking 数组返回。agent 持久化到 session。session_ready 携带 thinking。reducer 的 rebuildBlocksFromHistory 按顺序在 assistant 块前插入 thinking 块（含 full 供展开）。

history/context 保持纯 OpenAI 线格式（resume 时喂模型不混入推理），thinking 只供 UI 显示。
