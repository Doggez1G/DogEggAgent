import { readFileSync } from 'node:fs'
import { BUILTIN_PROMPT } from './builtin'

// 加载 system prompt 文本。配置只存路径（不存正文），避免把大段 prompt 塞进 config；
// 用户改 prompt 只需改文件，无需动配置 schema。支持绝对路径、~ 展开由调用方处理。
//
// 失效路径回退（运行时可用性优先）：文件被移动/删除/权限收紧后，若读取失败直接抛错，
// 每一轮请求都会炸——模型对话这个主功能被一个装饰性配置拖死，不成比例。回退内置默认
// prompt 并正常返回，让对话继续可用；与 /system 面板的 notice 语义区分——system_request
// 拉取路径的异常提示面向「配置 showcase」（用户主动查看），这里是「运行时兜底」。
// 配置入口侧由 validate.ts 的 existsSync 校验拦截（写入时就拒绝不存在的路径）。
export function loadSystemPrompt(path: string | undefined): string {
  if (!path) return BUILTIN_PROMPT
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return BUILTIN_PROMPT
  }
}
