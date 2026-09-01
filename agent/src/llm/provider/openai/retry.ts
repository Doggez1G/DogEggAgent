import { isRetryable } from './errors'

// 请求失败重试。AbortError/CancelledError 不重试——取消是用户意图，应立即上抛。
// 可重试错误（429/5xx/网络错误/超时）按指数退避重试；不可重试错误（4xx）fail-fast。
// 429 的 Retry-After header 优先于指数退避——尊重 API 的限流指导。
// 退避期间若外部 signal abort，立即中断等待（不等 sleep 结束）。
export async function withRetry<T>(attempts: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await run()
    } catch (e) {
      lastError = e as Error
      // AbortError / CancelledError：用户取消，立即上抛。
      if (!isRetryable(lastError)) throw lastError
      // 不可重试的错误（4xx 等）：fail-fast，不浪费重试次数。
      // isRetryable 已经排除了 AbortError，这里处理的是可重试错误的退避。
      if (i < attempts - 1) {
        const delay = getBackoffDelay(lastError, i)
        await sleep(delay, signal)
      }
    }
  }
  throw lastError!
}

// 计算退避延迟：429 优先用 Retry-After，其余用指数退避（500ms, 1s, 2s...）。
function getBackoffDelay(error: Error, attempt: number): number {
  if ('retryAfterMs' in error && typeof (error as { retryAfterMs?: number }).retryAfterMs === 'number') {
    return (error as { retryAfterMs: number }).retryAfterMs
  }
  return 500 * 2 ** attempt
}

// 可被 abort 中断的 sleep：signal 已 abort 时立即 reject，不等计时结束。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms))
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
