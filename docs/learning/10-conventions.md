# 10 · 规范与扩展：判决表、扩展位与 SDK 接缝

> 前九章讲「现在是什么」。本章讲「规则是什么、将来往哪长」——规范、扩展位模板与已接受的债。

## 三层 taxonomy（结构的地基）

| 层级 | 定义 | 成立条件 |
|---|---|---|
| 域模块文件夹 | `agent/src` 直接子目录（turn/session/config/tools/llm/context/permission/shared） | 一个领域 = 一个文件夹 + index.ts barrel |
| 域内分类文件夹 | 模块内再分类（`tools/read_file/`、`llm/provider/openai/`） | **≥2 个文件，或代表一个扩展位** |
| 文件 | 一个知识单元（一个类 / 一组同职责纯函数 / 一份契约） | 无行数下限 |

单文件的分类文件夹是「伪分类」（降级为文件）；为省文件数合并知识单元是「反分类」（禁止）。

## 依赖矩阵（被架构测试强制）

```
agent(根: agent.ts/ctx.ts/index.ts)  → 全部
turn      → session, llm, tools, context, permission, shared, ROOT(ctx)
session   → shared, ROOT(ctx)
config    → ROOT(ctx)
tools / llm / permission / shared → （无内部依赖）
context   → tools（assembler 需要 registry 计算 schema）
```

三条铁律：**能力模块互不依赖**；**无回穿**（session 禁止 import turn——用 TurnDelta 结构类型解耦）；**跨域 import 只走域门面**（`../config` 合法，`../config/editor` 违规）。改矩阵 = 显式设计决策：同时改 `bridge/test/architecture.test.ts` 与 spec。

## 放置判决表（一句话定位任何代码）

> **问「这是哪次提交/哪个会话的事？」→ 纵切文件夹；问「这是什么能力？」→ 能力文件夹。**

| 代码 | 归属 |
|---|---|
| 提交/取消/压缩编排、循环、工具执行、状态机 | turn/ |
| 工作集、持久化、会话生命周期 | session/ |
| 当前模型解析、配置读写编辑 | config/ |
| LLM 协议实现 | llm/provider/ |
| 消息整形、token 预算、压缩纯策略 | context/ |
| 并发闸门、日志、语言级工具 | shared/ |
| 跨进程的数据形状与纯派生 | bridge/contract/ |

## 四个扩展位模板（加功能 = 复制模板文件夹）

| 扩展点 | 模板 | 触碰既有代码 |
|---|---|---|
| 新工具 | `tools/<name>/{index, schema, tool}.ts` | registry 加一行 |
| 新 LLM 协议 | `llm/provider/<protocol>/{index, client, request, stream, retry, errors, parser}.ts` | client-for 加一个 case |
| 新 TUI 弹层/特征 | `tui/features/<name>/{view, keys}.tsx`（view 渲染 + keys 纯键盘处理） | 路由注册（use-key-routing） |
| 新 WebUI 特征 | `webui/features/<name>/use-<x>.ts`（+ logic/ 纯函数可单测） | app.tsx 接线一行 |

**未来需求落位推演**：

| 需求 | 落位 |
|---|---|
| MCP 工具 | `tools/mcp/` 分类文件夹，运行期 `registry.register()`（registry 是活的） |
| Anthropic 协议 | 照 openai 模板复制，clientFor 加 case |
| 子代理 | turn/ 复用 AgentLoop（每轮新实例）；machine 届时从 ctx 下放为 per-turn 实例 |
| 会话存储升级 | `session/` 内第二实现；**第二个实现出现时才提取 store 接口**（接口只为真实接缝而建） |
| 权限升级（glob/命令解析） | bridge schema 扩展 + manager 策略生长 |

## SDK 接缝（已预留，未实施）

agent 包在结构上已经是 headless SDK：核心无 UI 依赖（架构测试强制）、46 消息契约即 API、双传输验证过、表征测试无头驱动过。未来 SDK 门面（`createAgent`）的分组依据就是纵切后的特征命令面：

```ts
const agent = createAgent({
  config, cwd,
  tools: [defineTool(...)],                    // → ToolRegistry.register
  permission: async (req) => 'allow_once',     // → requestPermission 策略注入点（turn/tool-executor 已标注）
})
for await (const event of agent.events()) {}   // → 46 消息契约
await agent.submit('...'); await agent.session.resume(id)
```

实施时点：纵切重构后随时可加（薄适配层），发布与 semver 等 API 稳定后再做。

## 已接受的债（立法注明，勿误判为遗漏）

1. **微型策略文件**（trigger 6 行、estimate 7 行等）——文件承载知识单元，不按行数合并；
2. **双命名惯例**——工具目录沿用工具名（snake_case），文件一律 kebab-case；全量改名成本 > 收益；
3. **入站日志在 send()**——入站/出站日志分属两处是方向使然（emit 只管出站）；
4. **submit 守卫顺序**——isConfigured 先于 busy（参数解析的前提），「运行中且未配置」不可达。

（原第 5 条「ui/src 侧债务」已随 UI 批次 U1-U5 清偿——ThemeRegistry、双端 features/ 纵切、架构边界立法均已落地，移出债清单。）

## 验证工具箱

```bash
npm run typecheck   # 五路 tsc
npm run test:run    # 250 测试（含 5 个表征测试 + 架构测试）
npm run build       # esbuild → dist/dogegg.js
npx vitest run agent/test/agent.turn.test.ts   # 单跑表征测试（行为基线）
```
