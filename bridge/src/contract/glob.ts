// glob 模式匹配——契约层纯派生（与 classifyPermission/isConfigured 同类：无状态、跨包共用的判断逻辑）。
// 三个消费方：agent 的 glob 工具（按模式筛文件路径）、权限参数化规则（§4.2 的 tool/参数模式匹配）、
// UI 权限展示。住 bridge 保证一份实现三端永不漂移。
//
// 文法子集（刻意不实现 [] / {}——见设计 §7 非目标）：
//   **  跨任意路径段（含零段）     a/**/b 匹配 a/b 与 a/x/y/b
//   *   单段内任意字符（不含 /）   *.ts 只匹配根级；跨段需写 **/*.ts
//   ?   单个字符（不含 /）
//   其余字面量（正则元字符自动转义，点号等无需用户处理）
//
// 边界语义（对齐 gitignore/minimatch 直觉）：
//   src/**  匹配 src 下一切，但【不匹配 src 本身】——与目录名歧义消除一致；
//   **/x    匹配任意深度的 x，【含根级 x】——写「任意深度」时不必再补一条根级规则。

// 把 glob 模式编译为正则。路径分隔符统一按 posix（/）；Windows 反斜杠由调用方或本函数归一。
// 整段 ** 语义：`a/**/b` → `^a/(?:[^/]+/)*b$`（零段或多段皆可）；
// 尾段 **（`src/**`）→ `^src/.*$`（src 本身不命中）；首段 **/ → `(?:[^/]+/)*`（根级可选）。
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/')
  let re = ''
  let i = 0
  while (i < p.length) {
    const c = p[i]!
    if (c === '*') {
      let stars = 0
      while (p[i] === '*') { stars++; i++ }
      if (stars >= 2) {
        // 已吞掉连续的 *。此刻 re 以 / 结尾（或为空）且原串里 ** 后是 / 或串尾。
        const prevIsSegStart = re === '' || re.endsWith('/')
        if (prevIsSegStart && p[i] === '/') {
          re += '(?:[^/]+/)*' // **/ → 零或多段
          i++ // 吃掉这个 /
        } else {
          re += '.*' // 尾段 **（或 a**b 这类非整段用法）→ 任意剩余
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else {
      // 字面量：转义正则元字符（点号、括号、加号等），让用户写 "*.test.ts" 不用关心转义。
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

// 锚定 glob 匹配——【path 主参数的匹配函数】：标准路径 glob 语义，* 单段内任意（不跨 /）、
// ** 跨任意层（含零层）、? 单字符、其余字面量，整串锚定（^...$）。路径有层级，段的边界是
// 安全性质（`./docs/*` 刻意不覆盖 `./docs/sub/x`，要越层显式写 `**`）——作用域由锚点
// （./、~/、绝对前缀、* 从根）在归一化阶段写进模式，段语义只管形状。glob 工具（找文件）同用此函数。
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, '/'))
}

// 平文本通配——【command 主参数与工具名的匹配函数】：* = 任意字符序列（含 / 与空格，* 与 **
// 同义），? = 任意单字符，其余字面量，锚定匹配。命令是平文本，没有层级与段的概念——
// `git *` 通配到命令结尾即够，`*` 不会产生路径歧义。
export function matchWildcard(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 先转义正则元字符（不动 * ?）
    .replace(/\*+/g, '[\\s\\S]*') // * 与 ** 同义：任意字符序列
    .replace(/\?/g, '[\\s\\S]')
  return new RegExp(`^${escaped}$`).test(value)
}
