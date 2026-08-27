import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Phase 2 后：agent/test 已就位；test/ 里的 markdown/config-tree 待 Phase 3 迁到 ui/test。
  test: { include: ['bridge/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'ui/test/**/*.test.ts'] },
})
