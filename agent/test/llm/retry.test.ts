import { describe, it, expect } from 'vitest'
import { HttpError, NetworkError, StreamTimeoutError, isRetryable } from '../../src/llm/provider/openai/errors'
import { withRetry } from '../../src/llm/provider/openai/retry'

describe('error classification', () => {
  it('HttpError: 429 and 5xx are retryable', () => {
    expect(new HttpError(429, 'rate limited').retryable).toBe(true)
    expect(new HttpError(500, 'server error').retryable).toBe(true)
    expect(new HttpError(503, 'service unavailable').retryable).toBe(true)
  })

  it('HttpError: 4xx (non-429) are not retryable', () => {
    expect(new HttpError(400, 'bad request').retryable).toBe(false)
    expect(new HttpError(401, 'unauthorized').retryable).toBe(false)
    expect(new HttpError(403, 'forbidden').retryable).toBe(false)
    expect(new HttpError(404, 'not found').retryable).toBe(false)
  })

  it('HttpError: retryAfterMs is parsed', () => {
    const e = new HttpError(429, 'rate limited', 5000)
    expect(e.retryAfterMs).toBe(5000)
  })

  it('NetworkError is retryable', () => {
    expect(new NetworkError(new Error('ECONNRESET')).retryable).toBe(true)
  })

  it('StreamTimeoutError is retryable', () => {
    expect(new StreamTimeoutError('idle').retryable).toBe(true)
    expect(new StreamTimeoutError('absolute').retryable).toBe(true)
  })

  it('isRetryable: AbortError is not retryable', () => {
    const abortError = new DOMException('Aborted', 'AbortError')
    expect(isRetryable(abortError as unknown as Error)).toBe(false)
  })

  it('isRetryable: unknown errors are not retryable', () => {
    expect(isRetryable(new Error('something unexpected'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns result on first success', async () => {
    let calls = 0
    const result = await withRetry(3, async () => { calls++; return 'ok' })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries on retryable errors (HttpError 429)', async () => {
    let calls = 0
    const result = await withRetry(3, async () => {
      calls++
      if (calls < 2) throw new HttpError(429, 'rate limited')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  it('does not retry on non-retryable errors (HttpError 400)', async () => {
    let calls = 0
    await expect(withRetry(3, async () => {
      calls++
      throw new HttpError(400, 'bad request')
    })).rejects.toThrow('bad request')
    expect(calls).toBe(1)
  })

  it('does not retry on AbortError', async () => {
    let calls = 0
    await expect(withRetry(3, async () => {
      calls++
      throw new DOMException('Aborted', 'AbortError')
    })).rejects.toThrow('Aborted')
    expect(calls).toBe(1)
  })

  it('exhausts retries then throws', async () => {
    let calls = 0
    await expect(withRetry(2, async () => {
      calls++
      throw new NetworkError(new Error('connection refused'))
    })).rejects.toThrow('网络错误')
    expect(calls).toBe(2)
  })
})
