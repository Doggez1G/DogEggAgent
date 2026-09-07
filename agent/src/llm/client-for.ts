import type { Config } from '@dogegg/bridge'
import type { LlmClient, LlmClientConn } from './types'
import { OpenAiClient } from './provider/openai'

// protocol → client 分派（R6）：agent 只调此函数，不直接引用 OpenAiClient。
// v1 只支持 openai 协议；将来新增协议在此加分支即可，agent 调用方一行不改。
export function clientFor(protocol: Config['providers'][number]['protocol'], conn: LlmClientConn): LlmClient {
  switch (protocol) {
    case 'openai':
      return new OpenAiClient(conn)
  }
}
