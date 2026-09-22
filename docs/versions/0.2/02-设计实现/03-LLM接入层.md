# 03-LLM接入层

OpenAI 兼容协议的流式接入层（`agent/src/llm/`）：把「context + 工具集 + 参数」翻译为对 provider 端点的 SSE 请求，把响应翻译回统一的增量事件流。

## 设计要点

- **统一事件流**：`LlmStreamEvent`——文本增量 / 思考增量 / tool_calls 聚合 / done / error。上层（AgentLoop）只消费这几种事件，不感知厂商差异。
- **思考通道**：`reasoning_content` 增量映射为 thought_delta（非思考模型无此通道）。
- **工具声明**：请求体携带注册表 `schemas()` 现算的全部 function（OpenAI tools 参数格式）——工具注册/摘除即时反映到下一次请求。
- **参数调整**：`reasoning` 模型自动压低 maxOutput（思考占用输出预算）；每个 model 声明自己的 contextWindow（压缩阈值依据）与 maxOutput。
- **重试**：请求失败按 maxRetries 重试（瞬态错误）；重试耗尽向上抛，轮次层转 error。
- **协议预留**：`protocol` 字段当前仅 `openai`——新增协议 = 新增一个 client 实现并注册映射，上层不变。

## 校验放宽与完整性

- 配置 schema 对 provider 字段刻意放宽（允许暂空，支持「先建节点再补字段」的编辑流）；「能对话」由 `isConfigured()` 判定（baseURL/apiKey 完整 + 默认模型可解析）。
