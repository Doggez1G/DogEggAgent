# 权限配置 v2（M1.1）实施计划

> 日期：2026-09-09
> 规格：`docs/superpowers/specs/2026-09-09-permission-config-design.md`（下称「设计」）。
> 每批次末尾 `npm run typecheck && npm run test:run` 全绿才进入下一批次；commit 由用户按批次自行提交。

## 基线

- M1 已实施（7 工具 + 参数化权限引擎 + 出厂默认扁平形态），302 测试全绿。
- 本计划把配置书写形态升级为「桶 → 工具 → 模式数组」，内存模型 = grouped，匹配模型 = 扁平
  （grouped→扁平纯函数桥接），引擎与判定优先级零改动。

## 批次总览

| 批次 | 内容 | 结束状态 |
|---|---|---|
| P1 | bridge schema 双格式 + grouped 归一化 + classify/manager 适配 + 出厂默认 v2 | 配置 v2 全链路生效，旧配置兼容 |
| P2 | TUI 配置编辑器三层化 | 两端可配参数化模式（TUI 半边） |
| P3 | WebUI 设置权限区重排 + 文档同步 | M1.1 收口 |

---

## 批次 P1：bridge + agent（契约形态变更）

### P1.1 bridge `contract/config.ts`

- `permissionBucketSchema = z.record(z.string(), z.array(z.string()))`（桶 → 工具 → 模式数组，空 = 整工具）；
- `permissionV2Schema`（三桶 record）+ `permissionLegacySchema`（M1 条目数组，保留解析）；
- `permissionSchema = z.union([v2, legacy]).transform(归一到 v2)`——legacy 条目：字符串 →
  `bucket[tool] = []`；规则对象 → `bucket[tool] = [主参数值]`（主参数表见 P1.2）；
- `Config['permission']` 类型变为 v2 grouped：`{ allow: Record<string, string[]>, reject: …, ask: … }`；
- 出厂默认改 v2 形态：allow = `{ read_file: [], ls: [], glob: [], grep: [] }`、ask = `{ write_file: [], edit_file: [], shell: [] }`。

### P1.2 bridge `contract/permission.ts`

- `PRIMARY_SPECIFIER: Record<string, 'path' | 'command'>`（shell → command，缺省 path）——立法注释；
- `toEntries(cfg: PermissionConfig): PermissionEntry[]` 纯函数（grouped → 扁平：空数组 → `{tool}`，
  有模式 → `{tool, [主参数]: 模式}`），classifyPermission 改为接收 grouped 并先 toEntries；
- `entryMatches` 及判定优先级、双匹配语义（path 路径 glob / 其余平文本通配）原样保留；
- `PermissionEntry` / `ToolRule` 类型保留（内部匹配模型），`PermissionConfig` 类型改为 v2 grouped。

### P1.3 agent `permission/manager.ts`

- 归一化适配 grouped：`normalizeRules(cwd)` 改为对「主参数为 path 的工具」逐模式
  `toMatchablePath`；args 侧归一化不变；
- classify 流程（cwd 由 ToolExecutor 传入、set_cwd 天然生效）不变。

### P1.4 测试更新

- `bridge/test/glob.test.ts` 不动；`agent/test/permission/permission.test.ts` 全量改写为 grouped
  构造（行为断言等价迁移：整工具 = 空数组、参数化 = 模式数组、优先级/归一化/fail-closed 不变）；
- `agent/test/config/loader.test.ts`：出厂默认断言改 v2、legacy 加载归一化断言、roundtrip 断言；
- `ui/test/webui/logic.test.ts` effectivePerm 用例适配 grouped（`cfg.allow.includes(name)` →
  `name in cfg.allow`）。

## 批次 P2：TUI 编辑器三层化（`ui/src/tui/features/config/`）

### P2.1 navigation + build

- ConfigPath：`permissionBucket` 语义改为「桶内工具列表」，新增 `permissionTool { bucket; tool }`；
- buildEntries：
  - `permission`：三桶行（摘要 = N 个工具）+ 只读说明行（未列出工具固定询问）；
  - `permissionBucket`：桶内工具列表（摘要「整工具 / N 条模式（另在 X 桶有 M 条）」）+ ＋添加工具
    （selectTool 选中 → `config_set` 整桶对象含新工具空数组）；
  - `permissionTool`：模式行列表（Enter 就地编辑）+ 空数组态提示行 + ＋添加模式（标量输入流，
    非空/去重校验，首条添加后 notice 两态转换提示）；
- 所有变更 = 重算整桶对象 → `ctx.set('permission.<bucket>', bucketObj)`（设计 §3 的统一变更原语）。

### P2.2 keys + 摘要文案

- `d`：工具行 = 从桶删键；模式行 = 删该条（删光回整工具，notice 提示）；
- 桶内工具摘要文案放 shared（`describeBucketTool`），TUI/WebUI 同源。

## 批次 P3：WebUI + 文档

### P3.1 WebUI `components/settings/view.tsx`

- 权限区重排：三桶区块 → 工具分组（组头摘要 + 移除按钮 / 模式 chips（点击就地编辑、× 删除）/
  添加输入框（非空 + 去重，红边提示）/ ＋添加工具下拉）；
- 顶部固定文案「未列出的工具默认询问（固定安全默认）」；空桶说明行；
- 变更原语同 P2（整桶 config_set）；编辑态用本地受控状态，blur/Enter 提交。

### P3.2 文档同步 + 全量验证

- M1 spec §4.2 加指向注（配置形态由 M1.1 v2 取代）；根设计文档 §5 样例更新；
  learning/08 配置形态小节重写；README 权限句微调；
- `npm run typecheck && npm run test:run && npm run build` 全绿。

## 收尾（用户）

- 按批次 commit（P1/P2/P3 各一）；
- dogfood：/config 里为 shell 配 `allow: ["git *", "npm test"]` 走一遍编辑流。
