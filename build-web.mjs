import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Server 端打包：main-web.ts → dist/server.js。
// 与 build.mjs 同模式：workspacePlugin 把 @dogegg/* 包名解析到对应包的 src/index.ts 源码打进产物。
// npm 依赖保持 external（packages: 'external'），运行期从根 node_modules 取。
const workspacePlugin = {
  name: 'dogegg-workspace',
  setup(b) {
    b.onResolve({ filter: /^@dogegg\// }, (args) => {
      const name = args.path.slice('@dogegg/'.length)
      return { path: fileURLToPath(new URL(`./${name}/src/index.ts`, import.meta.url)) }
    })
  },
}

await build({
  entryPoints: ['main-web.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [workspacePlugin],
})
