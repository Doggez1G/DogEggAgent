import type { Message } from '@dogegg/bridge'
import type { LlmStreamEvent, LlmUsage, ChatRequest, LlmClientConn } from '../..'
import { createOpenAiStreamParser } from './parser'
import { buildRequest } from './request'
import { HttpError, NetworkError, StreamTimeoutError } from './errors'

// 超时模型（连接超时 + 两级空闲超时，均不含总时长上限——持续出字节的流是健康的，生成长度由 maxOutput 决定）：
// 1. 连接超时 CONNECT_TIMEOUT_MS：fetch 发起 → 响应头返回（含 DNS/TLS/服务端处理首响）。
// 2. 空闲超时（按流是否已建立分段）：相邻 chunk 的最大间隔。
//    - 首 chunk 前（响应头已回、body 尚无字节）IDLE_FIRST_CHUNK_TIMEOUT_MS：保持较紧——端点
//      已接受请求却迟迟不给任何字节，多半是网关/负载异常，快速失败进重试比干等划算。
//    - 首 chunk 后 IDLE_STREAMING_TIMEOUT_MS：放宽——见下方立法注释。
// 各级超时统一抛 StreamTimeoutError（retry 层可重试）；用户取消走 AbortError，互不混淆。
const CONNECT_TIMEOUT_MS = 60_000
const IDLE_FIRST_CHUNK_TIMEOUT_MS = 60_000
// 立法（流建立后的空闲阈值 = 180 秒）：推理模型的合法生成节奏包含整分钟级静默——思考段内部的
// 长停顿、思考流结束到首个正文 delta 之间，provider 可能完全不发任何字节（用户实测 P2：thought_delta
// 陆续到达后仍被 60s 阈值误杀）。这是「服务器仍在生成、只是暂时不吐字节」的等待上限，不是死连接
// 检测：死连接由 TCP 层（重传超时/连接复位）与连接超时兜底。旧值 60s 对推理模型过紧。
const IDLE_STREAMING_TIMEOUT_MS = 180_000

// 空闲阈值的可变副本——真实运行固定为上面的立法值；测试经 setIdleTimeoutForTest 调短毫秒级完成
//（真实分钟级静默无法在测试里等待，用缩比阈值验证两级分发逻辑本身）。
let idleFirstChunkMs = IDLE_FIRST_CHUNK_TIMEOUT_MS
let idleStreamingMs = IDLE_STREAMING_TIMEOUT_MS

// 测试专用：调短两级空闲阈值（对齐 setKillWatchdogForTest 先例），不落入用户配置。
// 首参管「首 chunk 前」、次参管「首 chunk 后」；调用方负责在 afterEach 还原立法值，防泄漏到其他用例。
export function setIdleTimeoutForTest(firstChunkMs: number, streamingMs: number): void {
  idleFirstChunkMs = firstChunkMs
  idleStreamingMs = streamingMs
}
// SSE 行缓冲上限：畸形端点（无换行地持续输出）会让 buf 无界增长，且每个 chunk 都有字节
// 到达使空闲超时永不触发——超过上限判为畸形流，直接失败（普通 Error，不可重试）。
// buf.length 是 UTF-16 码元数，ASCII 场景下与字节数一致，作为字节上限的近似足够。
const MAX_SSE_BUF = 8 * 1024 * 1024

// 单次流式请求：fetch → 逐行读 SSE 流 → 喂 parser → 累积最终 message + reasoning。
// 不做重试（重试在 OpenAiClient 层）。HTTP 错误 / 流中断 / 超时 / 无最终消息均抛错。
// 错误类型分类（HttpError / NetworkError / StreamTimeoutError），供 retry 层判断可重试性。
export async function streamOnce(conn: LlmClientConn, req: ChatRequest, signal: AbortSignal, emit: (e: LlmStreamEvent) => void): Promise<{ message: Message; reasoning?: string; usage?: LlmUsage }> {
  const { url, init } = buildRequest(req, conn)

  // 连接超时：独立 controller 承载——超时 abort 与用户 abort 需区分归因。
  const connectCtrl = new AbortController()
  let connectTimedOut = false
  const onUserAbort = () => connectCtrl.abort()
  signal.addEventListener('abort', onUserAbort, { once: true })
  const connectTimer = setTimeout(() => { connectTimedOut = true; connectCtrl.abort() }, CONNECT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, { ...init, signal: connectCtrl.signal })
  } catch (e) {
    clearTimeout(connectTimer)
    signal.removeEventListener('abort', onUserAbort)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError') // 用户取消
    if (connectTimedOut) throw new StreamTimeoutError('connect')        // 连接超时（可重试）
    throw new NetworkError(e)                                           // 网络错误（可重试）
  }
  clearTimeout(connectTimer)
  // 注意：onUserAbort 监听保留——body 阶段用户 abort 仍需中断（fetch body 绑定 connectCtrl.signal）。

  if (!res.ok || !res.body) {
    // 401/404 是最高频的配置错误（key 无效 / 模型名不存在）——裸状态码让用户无从自查，
    // 尽力读取响应体里的服务端错误说明拼进 message（上限 2048 字节，防超大响应撑爆错误展示）。
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 2048)
      // OpenAI 形状的错误体是 {error:{message}}——提取纯 message；非 JSON / 其他形状用原文截断。
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } }
        if (parsed?.error?.message) detail = parsed.error.message
      } catch { /* 非 JSON 错误体：保留原文截断 */ }
    } catch { /* body 读取失败（如用户已 abort）：退回裸状态码 */ }
    // throw 前清理资源：移除 abort 监听 + cancel 未读完的响应体——keep-alive 连接上悬空的
    // 响应体会占住 socket，造成连接泄漏。
    signal.removeEventListener('abort', onUserAbort)
    try { await res.body?.cancel() } catch { /* cancel 失败不影响错误上抛 */ }
    const retryAfter = res.headers.get('retry-after')
    throw new HttpError(
      res.status,
      detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`,
      retryAfter ? parseRetryAfter(retryAfter) : undefined,
    )
  }

  // 超时归因：reader.cancel 会让后续 read 以 done「正常」结束——必须在循环外还原为超时错误
  // （可重试），否则长生成被掐断时会误报成「流未产生最终消息」。
  let timeout: StreamTimeoutError | null = null
  const parser = createOpenAiStreamParser()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalMessage: Message | null = null
  let finalReasoning: string | undefined
  let finalUsage: LlmUsage | undefined
  // 流是否已建立（至少一个 chunk 到达）——决定空闲超时用哪一级阈值。
  // 空 chunk 也算建立：字节真的到了，就证明服务器在活跃发送，值得放宽等待。
  let receivedChunk = false


  try {
    for (;;) {
      // 空闲超时：每次 read 最多等对应级别的空闲阈值，超时则中止。
      // 首 chunk 前用较紧阈值快速失败；流建立后放宽到立法值，容忍推理模型的思考静默。
      const idleTimer = setTimeout(() => {
        timeout = new StreamTimeoutError('idle')
        reader.cancel(timeout)
      }, receivedChunk ? idleStreamingMs : idleFirstChunkMs)

      let done: boolean
      let value: Uint8Array | undefined
      try {
        const result = await reader.read()
        done = result.done
        value = result.value
      } catch (e) {
        // reader.read reject：可能是 cancel 导致的（超时/外部 abort），区分类型。
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (e instanceof StreamTimeoutError) throw e
        throw new NetworkError(e)
      } finally {
        clearTimeout(idleTimer)
      }

      if (done) break
      receivedChunk = true // 非 done 即有字节到达——流已建立，后续空闲按放宽阈值计
      buf += decoder.decode(value, { stream: true })
      // SSE 以换行分隔，逐行喂 parser；行可能跨 chunk，用 buf 缓冲未完整的尾行。
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd()
        buf = buf.slice(nl + 1)
        for (const e of parser.feed(line)) {
          if (e.type === 'done') { finalMessage = e.message; finalReasoning = e.reasoning; finalUsage = e.usage }
          else emit(e)
        }
      }
      // 缓冲上限检查放在整行抽取之后——此时 buf 只剩未完整的尾行，正常流远够不到上限。
      if (buf.length > MAX_SSE_BUF) {
        throw new Error(`SSE 缓冲超过 ${MAX_SSE_BUF / 1024 / 1024}MB 上限——端点未按换行分隔输出，疑似非 SSE 流`)
      }
    }

    // 处理残余行：连接关闭时最后一批字节可能没有尾随换行。
    // 先 flush 解码器尾字节——多字节 UTF-8 字符可能被截在 chunk 边界，不 flush 会丢字/乱码。
    buf += decoder.decode()
    if (buf.trim()) {
      for (const e of parser.feed(buf.trim())) {
        if (e.type === 'done') { finalMessage = e.message; finalReasoning = e.reasoning; finalUsage = e.usage }
        else emit(e)
      }
    }
  } finally {
    signal.removeEventListener('abort', onUserAbort)
  }

  if (!finalMessage) {
    // 超时触发的 cancel 会优雅结束流——归因还原成 StreamTimeoutError（retry 层可重试）。
    if (timeout) throw timeout
    throw new Error('流未产生最终消息')
  }
  return { message: finalMessage, reasoning: finalReasoning, usage: finalUsage }
}

// 解析 Retry-After header：支持秒数（"120"）和 HTTP-date 两种格式。
function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = new Date(value)
  const diff = date.getTime() - Date.now()
  if (Number.isFinite(diff) && diff > 0) return diff
  return undefined
}
