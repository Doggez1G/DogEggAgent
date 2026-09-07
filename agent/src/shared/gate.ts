// 并发闸门：R2 语义的落地处——运行中（轮次/手动压缩）时动工作集的命令发 notice 阻塞，纯查询放行。
// 轮次与压缩共用一个闸门：同一时刻只允许一个「动 context」的操作在飞。
//
// 【取消双机制立法】本类同时承载两套取消语义，职能不同、不可互相替代：
// 1. 协作检查点——isCancelled() 由 loop 在每次迭代与工具之间轮询，保证「取消后逻辑一致」
//    （返回部分结果、补全未配对 tool_calls）；
// 2. 在飞中断——enter() 返回的 AbortSignal 让挂起的 fetch / 工具 / 压缩立即失败（AbortError），
//    保证「取消的及时性」。
// 两路都由 cancel() 一次触发；loop 同时消费二者（checkCancelled 回调 + signal）。
export class BusyGate {
  private running = false
  private cancelled = false
  private controller: AbortController | null = null

  get busy(): boolean {
    return this.running
  }

  // 进入忙区：清取消标志、注册新的 AbortController、置运行标志。调用方负责在 finally 中 leave()。
  enter(): AbortController {
    this.cancelled = false
    this.controller = new AbortController()
    this.running = true
    return this.controller
  }

  leave(): void {
    this.running = false
  }

  // 用户取消：置取消标志并 abort 在飞请求（fetch/工具/压缩都会被中断）。
  cancel(): void {
    this.cancelled = true
    this.controller?.abort()
  }

  isCancelled(): boolean {
    return this.cancelled
  }
}
