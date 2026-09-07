// 带分类的 HTTP 错误——保留状态码，供 retry 层做可重试性判断。
// 429（Rate Limit）/ 5xx（服务端错误）/ 网络错误可重试；4xx fail-fast。
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'HttpError'
  }

  // 429 + 5xx 可重试；4xx（除 429 外）不可重试——请求本身有问题，重试也不会成功。
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

// 网络层错误（ECONNRESET、ETIMEDOUT、fetch reject 等）——可重试。
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(`网络错误: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'NetworkError'
    if (cause instanceof Error) this.cause = cause
  }
  get retryable(): boolean { return true }
}

// 流式超时错误——provider 接受连接但长时间不返回数据。
export class StreamTimeoutError extends Error {
  constructor(public readonly kind: 'connect' | 'idle') {
    super(kind === 'connect' ? '流式连接超时（服务器未及时响应）' : '流式空闲超时（长时间无数据）')
    this.name = 'StreamTimeoutError'
  }
  get retryable(): boolean { return true }
}

// 判断错误是否可重试。
export function isRetryable(e: Error): boolean {
  if (e.name === 'AbortError') return false
  if (e.name === 'CancelledError') return false
  if ('retryable' in e && typeof (e as { retryable?: boolean }).retryable === 'boolean') {
    return (e as { retryable: boolean }).retryable
  }
  // 未知错误默认不重试——避免对未预期的错误反复重试。
  return false
}
