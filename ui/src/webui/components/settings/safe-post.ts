import type { UiPort, UiToAgentMessage } from '@dogegg/bridge'

// 设置页统一的安全提交（与 app 层 safePost 同款语义）：port.post 可能同步抛错（通道未就绪）
// 或返回失败的 Promise（SSE fetch 网络断开 / HTTP 错误）——裸调会静默丢失，用户以为保存成功。
// 失败时 console.warn 留排查痕迹；调用方有 inline 反馈面（skills/mcp 的 inlineError）时通过
// onFail 显示。后端 zod 校验仍兜底非法值——本函数只负责「请求没送达」的即时反馈。
export function safeSettingsPost(
  port: UiPort,
  msg: UiToAgentMessage,
  onFail?: (e: Error) => void,
): void {
  const fail = (e: unknown): void => {
    console.warn('[settings] 配置提交失败:', msg.type, e)
    onFail?.(e instanceof Error ? e : new Error(String(e)))
  }
  try {
    const result = port.post(msg)
    if (result instanceof Promise) result.catch(fail)
  } catch (e) {
    fail(e)
  }
}
