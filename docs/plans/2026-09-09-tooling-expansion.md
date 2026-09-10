# 工具面扩展（M1）实施计划

> 日期：2026-09-09
> 规格：`docs/superpowers/specs/2026-09-08-tooling-expansion-design.md`（v2，下称「设计」）。
> 按批次推进，每批次末尾 `npm run typecheck && npm run test:run` 全绿才进入下一批次（本计划不代用户提交 commit，由用户按批次自行提交）。
> 收尾另有 dogfood 验收（设计 §9），需用户实跑 agent 完成。

## 基线

- 分支 `feat/v0.2.0`，250 测试 + 五路 typecheck + build 全绿。
- 工具域现状：4 工具（read_file/write_file/edit_file/shell），`classifyPermission(cfg, tool, sessionAllowed)` 三桶精确名匹配。
- UI formatter：`ui/src/shared/tool-display.ts` 每工具 case（shell/read_file/edit_file/write_file）。

## 批次总览

| 批次 | 内容 | 结束状态 |
|---|---|---|
| T1 | bridge glob matcher + traverse（walker/ignore）+ ls/glob/grep 三工具 + 单测 | 工具域 7 工具，权限/UI 未动 |
| T2 | permission 条目 union + 通用匹配引擎 + agent 归一化 + 出厂默认 + UI 展示同步 | 契约 v2 生效，行为向后兼容 |
| T3 | tool-display 三 formatter + 表征测试 + 文档同步 + 清 sync() 死代码 | M1 代码收口，待 dogfood |

---

## 批次 T1：matcher + traverse + 三工具

### T1.1 bridge：glob matcher（`bridge/src/contract/glob.ts`）

- `globToRegExp(pattern): RegExp`——posix 归一（`\`→`/`）后逐字符编译：`**` 跨段（整段时 `(?:[^/]+/)*` 语义，
  尾段 `.*`）、`*` 单段 `[^/]*`、`?` 单字符 `[^/]`、其余正则元字符转义；注释写清 `src/**` 不匹配 `src` 本身、
  `**/x` 含根级 `x` 等边界语义。
- `matchGlob(pattern, path): boolean`——便捷封装（每次编译；工具批量场景直接用 globToRegExp 复用）。
- `bridge/src/contract/index.ts` re-export。
- 测试 `bridge/test/glob.test.ts`：`*`/`**`/`?` 组合、`**/x` 与 `src/**/x`、根级命中、字面量点号转义、
  Windows 分隔符归一、`src/**` 不命中 `src`。

### T1.2 agent：traverse（`agent/src/tools/traverse/{walker,ignore,index}.ts`）

- `ignore.ts`：`IGNORED_DIRS`（node_modules/.git/dist/build/out/.next/coverage/.dogegg）+ `isBinaryFile(head)`（含 `\0`）。
- `walker.ts`：`walkFiles(rootDir, opts): AsyncGenerator<string>`——`fs.promises.readdir withFileTypes` 递归、
  黑名单目录剪枝、symlink 跳过（防环与逃逸 root）、产出 posix 相对路径；循环内 `signal.throwIfAborted()`。
- `index.ts` 纯 re-export。
- 测试并入 `agent/test/tools/traverse.test.ts`：剪枝、symlink 跳过、隐藏目录（.github）不被误剪、posix 相对产出。

### T1.3 agent：ls 工具（`agent/src/tools/ls/{index,schema,tool}.ts`）

- schema `{ path: string }`；execute：`readdir withFileTypes`，目录加 `/` 后缀置前、文件附人类可读大小；
  隐藏文件显示；封顶 500 附「（仅显示前 500 项，共 N 项）」；路径不存在/非目录 → `{ error }`。

### T1.4 agent：glob 工具（`agent/src/tools/glob/{index,schema,tool}.ts`）

- schema `{ pattern: string, path?: string }`；execute：walkFiles + globToRegExp 过滤，字母序，封顶 100
  附「（仅显示前 100 个，共 N 个命中，请收窄 pattern）」。

### T1.5 agent：grep 工具（`agent/src/tools/grep/{index,schema,tool}.ts`）

- schema `{ pattern, path?, glob?, case_insensitive?, output_mode?: 'content'|'files_with_matches'|'count' }`。
- execute：无效正则 → `{ error }`；walkFiles + glob 过滤（relPath 或 basename 任一命中）+ 二进制跳过 +
  超大文件（>1MB）跳过计数；逐行正则；回执 `相对路径:行号: 内容`。
- 治理四层：单行 500 字符 → 单文件命中 20（附「该文件还有 N 处」）→ 总命中 100 → 总字符 8000
  （附「输出已截断，请收窄」）；files_with_matches/count 模式同用文件级封顶。
- path 指向单文件时直接搜该文件。

### T1.6 注册表与验证

- `registry.ts` withBuiltins 加三行；`agent/test/tools/{ls,glob,grep}.test.ts`（临时目录实测：
  正常/空结果/超封顶标注/无效正则/二进制跳过/黑名单剪枝）。
- 验证：typecheck + test:run 全绿。

## 批次 T2：权限参数化 + 出厂默认

### T2.1 bridge：条目 union（`bridge/src/contract/config.ts`）

- `toolRuleSchema = z.object({ tool: z.string() }).catchall(z.string()).refine(≥2 键)`；
  `permissionEntrySchema = z.union([z.string(), toolRuleSchema])`；三桶改用 entry schema；
  导出 `PermissionEntry` 类型。旧配置（纯字符串数组）天然合法，零迁移。

### T2.2 bridge：通用匹配引擎（`bridge/src/contract/permission.ts`）

- `classifyPermission(cfg, tool, args?, sessionAllowed?)`：
  `entryMatches`（裸名 = 精确或 matchGlob；对象 = tool 匹配 + 全部限定键 fail-closed 命中）；
  顺序 reject > ask > allow（含 sessionAllowed.has(tool)）> 默认 ask；文件头加「shell 规则 = 便利非边界」立法注释。

### T2.3 agent：归一化 + 调用点（`agent/src/permission/manager.ts`、`agent/src/turn/tool-executor.ts`）

- PermissionManager.classify 增 `classify(tool, args?, cwd?)`——`path` 字段（参数与规则）posix + 相对 cwd
  归一后交给引擎；cwd 由调用方传入（跟随 set_cwd）。
- tool-executor：`classify(tool.name, parsedArgs, ctx.cwd)`（zod 解析后的 args）。

### T2.4 出厂默认 + UI 同步

- configSchema permission default 改为读类 allow / 写类 ask（设计 §4.1）。
- `ui/src/shared/permission.ts` 两个 classifyPermission 调用点适配新签名（args=undefined）。
- 测试：`agent/test/permission/permission.test.ts` 参数化用例（裸名兼容/tool 通配/参数命中/fail-closed/
  归一化/优先级/sessionAllowed）+ `agent/test/config/loader.test.ts` 出厂默认断言。
- 验证：typecheck + test:run 全绿。

## 批次 T3：UI formatter + 表征测试 + 文档

### T3.1 UI（`ui/src/shared/tool-display.ts`）

- formatToolArgs：ls → path；glob → pattern；grep → pattern（+ glob 过滤）。
- formatToolTitle：按回执数据行数提炼「N 项 / N 个文件 / N 处命中」。
- formatToolBody：三工具展开正文（grep 命中行 kind=plain，路径:行号 前缀保留原文）。
- 单测并入 `ui/test/shared/tool-display.test.ts`。

### T3.2 表征测试 + 死代码

- `agent/test/agent.turn.test.ts` 增「grep 工具调用」场景锁消息序列。
- 删 `agent/src/turn/state.ts` 的 `StateMachine.sync()`（双机镜像时代遗留，无调用点）。

### T3.3 文档同步（设计 §10 清单）

- 根设计文档 §8 工具清单 4→7、§5 权限模型补参数化规则与出厂默认。
- learning/06（三工具 + 治理四层 + matcher 落位）、learning/08（出厂默认 + 参数化规则）、README 特点区。
- 验证：typecheck + test:run + build 全绿。

## 收尾（用户）

- dogfood 验收（设计 §9）：用 dogegg 在本仓库完成一次真实小任务，读类零审批、上下文有界，踩坑记 `.scratch/`。
- 按批次 commit（T1/T2/T3 各一个，重命名与逻辑改动不混提交）。
