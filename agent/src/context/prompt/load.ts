import { readFileSync } from 'node:fs'
import { BUILTIN_PROMPT } from './builtin'

// 加载 system prompt 文本。配置只存路径（不存正文），避免把大段 prompt 塞进 config；
// 用户改 prompt 只需改文件，无需动配置 schema。支持绝对路径、~ 展开由调用方处理。
export function loadSystemPrompt(path: string | undefined): string {
  if (!path) return BUILTIN_PROMPT
  return readFileSync(path, 'utf8')
}
