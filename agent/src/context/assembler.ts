import type { Message } from '@dogegg/bridge'
import { loadSystemPrompt } from './prompt'
import { estimateContextTokens } from './token'
import type { ToolRegistry } from '../tools'

// 上下文组装器：system prompt 加载 + token 预算估算的唯一入口。
// Agent 侧所有估算都经此类——保证与实际请求一致的口径（同一 prompt + 同一工具 schema）。
// systemPromptPath 来自 config；config 编辑改变路径后由 Agent 重建实例。
export class ContextAssembler {
  constructor(private readonly systemPromptPath: string | undefined, private readonly registry: ToolRegistry) {}

  // system prompt 文本：配置存路径（不存正文），未配置用内置默认。
  systemPrompt(): string {
    return loadSystemPrompt(this.systemPromptPath)
  }

  // 估算整个 context 的 token 占用（system + 消息 + 工具 schema）。
  estimate(context: Message[]): number {
    return estimateContextTokens(this.systemPrompt(), context, this.registry.schemas())
  }
}
