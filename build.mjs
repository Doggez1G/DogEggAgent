import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// workspace 插件：把 @dogegg/* 包名 import 解析到对应包的 src/index.ts 源码，打进产物。
// 其余 npm 依赖保持 external（packages: 'external'），运行期从根 node_modules 取，与单包时一致。
// 这是 workspaces 化唯一的新机关——内部包不经发布，需在打包时内联。
const workspacePlugin = {
  name: 'dogegg-workspace',
  setup(b) {
    b.onResolve({ filter: /^@dogegg\// }, (args) => {
      const name = args.path.slice('@dogegg/'.length)
      // 用 fileURLToPath 而非 URL.pathname——后者在 Windows 上返回 /D:/... 带前导斜杠，esbuild 不认。
      return { path: fileURLToPath(new URL(`./${name}/src/index.ts`, import.meta.url)) }
    })
  },
}

await build({
  entryPoints: ['bin/dogegg.ts'],
  outfile: 'dist/dogegg.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [workspacePlugin],
  // shebang：让 Linux/macOS 知道用 node 执行；Windows 上 npm 自动创建 .cmd 包装器。
  banner: { js: '#!/usr/bin/env node' },
})
