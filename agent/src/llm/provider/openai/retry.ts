// 请求失败重试。AbortError 不重试——取消是用户意图，应立即上抛而非重试。
export async function withRetry<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await run()
    } catch (e) {
      lastError = e as Error
      if (lastError.name === 'AbortError') throw lastError
    }
  }
  throw lastError!
}
