// 请求失败重试。AbortError 不重试——取消是用户意图，应立即上抛而非重试。
// 加指数退避（500ms, 1s, 2s...），避免 rate-limit (429) 时 hammer API 加剧限流。
export async function withRetry<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await run()
    } catch (e) {
      lastError = e as Error
      if (lastError.name === 'AbortError') throw lastError
      // 非最后一次重试时退避（最后一次不等）。
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i))
    }
  }
  throw lastError!
}
