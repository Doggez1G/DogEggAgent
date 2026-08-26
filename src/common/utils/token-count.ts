// 粗略 token 估算（非精确）：CJK 字符按 1 token/字，其余按 4 字符 ≈ 1 token。
// 用于上下文窗口预算与 compaction 触发判断，精度需求不高。
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  const rest = text.replace(/[一-鿿]/g, '').length
  return cjk + Math.ceil(rest / 4)
}