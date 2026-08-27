import type { ProviderAdapter } from './types'
import type { Config } from '@dogegg/bridge'
import { openAiAdapter } from './provider/openai'

// protocol → adapter 分派（R6）：agent 只调此函数，不直接引用 openAiAdapter。
// v1 只支持 openai 协议；将来新增协议在此加分支即可，agent 调用方一行不改。
// 收编了旧代码 Agent 与 compactNow 两处直接 openAiAdapter() 的硬编码。
export function adapterFor(protocol: Config['providers'][number]['protocol']): ProviderAdapter {
  switch (protocol) {
    case 'openai':
      return openAiAdapter()
  }
}
