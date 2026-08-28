// 请求失败重试。AbortError 不重试——取消是用户意图，应立即上抛而非重试。
// 加指数退避（500ms, 1s, 2s...），避免 rate-limit (429) 时 hammer API 加剧限流。
// 退避期间若外部 signal abort，立即中断等待（不等 sleep 结束）。
export async function withRetry<T>(attempts: number, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: Error | null = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await run()
    } catch (e) {
      lastError = e as Error
      if (lastError.name === 'AbortError') throw lastError
      // 非最后一次重试时退避（最后一次不等）。
      if (i < attempts - 1) await sleep(500 * 2 ** i, signal)
    }
  }
  throw lastError!
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
