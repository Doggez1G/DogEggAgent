// 工具结果超长截断（尤其 shell 输出会撑爆窗口）。默认上限 8000 字符，超出则在末尾标注。
export const TOOL_RESULT_CAP = 8000

export function truncate(text: string, cap = TOOL_RESULT_CAP): string {
  if (text.length <= cap) return text
  return text.slice(0, cap) + '\n…（输出过长，已截断）'
}