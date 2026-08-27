import { build } from 'esbuild'

// workspace 插件：把 @dogegg/* 包名 import 解析到对应包的 src/index.ts 源码，打进产物。
// 其余 npm 依赖保持 external（packages: 'external'），运行期从根 node_modules 取，与单包时一致。
// 这是 workspaces 化唯一的新机关——内部包不经发布，需在打包时内联。
const workspacePlugin = {
  name: 'dogegg-workspace',
  setup(b) {
    b.onResolve({ filter: /^@dogegg\// }, (args) => {
      const name = args.path.slice('@dogegg/'.length)
      return { path: new URL(`./${name}/src/index.ts`, import.meta.url).pathname }
    })
  },
}

await build({
  entryPoints: ['main.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [workspacePlugin],
})
