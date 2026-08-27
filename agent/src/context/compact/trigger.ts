// 是否触发压缩：Context 已用 token 超过窗口 80% 时压缩最旧消息。
// 阈值定 80% 而非 100%——留缓冲，避免在模型刚好要回答时触发压缩打断。
export function shouldCompact(used: number, windowTokens: number): boolean {
  return used > windowTokens * 0.8
}
