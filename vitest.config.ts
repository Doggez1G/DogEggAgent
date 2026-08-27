import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['bridge/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'ui/test/**/*.test.ts'] },
})
