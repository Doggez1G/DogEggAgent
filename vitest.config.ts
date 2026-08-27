import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Phase 1 期间：bridge/test 已就位，旧 test/ 仍在根；两者都跑。
  // Phase 4 删除 src/test 后，旧 test/ 不复存在，自然只剩三包 test。
  test: { include: ['bridge/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'ui/test/**/*.test.ts', 'test/**/*.test.ts'] },
})
