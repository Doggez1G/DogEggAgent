import type { Config, ProviderConfig, ModelConfig } from '@dogegg/bridge'

// 从 config 解析「当前 provider + model」：defaultProvider 未命中就回落首个 provider；model 同理。
// 收编了旧代码 ProviderRegistry + Agent.currentProvider/currentModel 三处重复逻辑。
// 调用方需先经 isConfigured 判定，保证返回非空（否则 !  断言会抛）。
export function resolveCurrent(config: Config): { provider: ProviderConfig; model: ModelConfig } {
  const provider = config.providers.find((p) => p.name === config.defaultProvider) ?? config.providers[0]!
  const model = provider.models.find((m) => m.name === config.defaultModel) ?? provider.models[0]!
  return { provider, model }
}
