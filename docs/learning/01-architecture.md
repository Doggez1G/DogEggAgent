# 01 · 全局架构：四包地图与一次提交的旅程

> ⚠️ **存档**：本章为 v0.1 时代内容，部分已过时。当前版本学习指南见 [docs/versions/0.2/04-学习指南](../versions/0.2/04-学习指南/README.md)。

> 本章建立全局视野：系统由什么组成、谁依赖谁、以及「用户按下回车」之后发生的事的完整链路。
> 后续章节逐个深入每个文件夹。

## 一句话看懂系统

**DogEggAgent 是一个 code agent**：你提交一段任务，它调用大模型循环干活（读文件、写文件、执行命令），把过程实时讲给你听。它有两个前端——终端 TUI 和浏览器 WebUI——共用同一个后端。

## 四个包：谁依赖谁

```
┌─────────────┐   装配    ┌─────────────┐
│ bin/dogegg  │──────────▶│   根组合根   │  main-web.ts / bin/dogegg.ts
└─────────────┘           └──────┬──────┘        （全项目唯一同时 import
                                 │                 agent + ui/server 的地方）
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
      ┌─────────────┐   消息   ┌─────────────┐   消息   ┌─────────────┐
      │ @dogegg/ui  │◀───────▶│ @dogegg/bridge│◀───────▶│ @dogegg/agent│
      │ TUI + WebUI │  Port   │   契约+通道   │  Port   │  headless 核心│
      └─────────────┘         └──────┬──────┘         └─────────────┘
                                     │
                              ┌──────▼──────┐
                              │@dogegg/server│  HTTP + SSE（WebUI 的传输层）
                              └─────────────┘
```

三条铁律（由测试强制，违规即红，见 `bridge/test/architecture.test.ts`）：

1. **agent 与 ui 互不知晓对方存在**——都只认识 `@dogegg/bridge` 里的消息契约；
2. **bridge 不依赖任何兄弟包**——契约是边界的所有者，由它守门；
3. **server 永不 import ui**——前端是静态文件被 serve，不是代码被拼进去。

为什么要这么严格？因为**传输可替换**就是从这里来的：TUI 用进程内的 `InMemoryChannel`，WebUI 用 `SseChannel`（HTTP SSE），agent 对此零感知。将来写 IDE 插件、Discord bot，只是再加一个通道。

## agent/src 目录导览（后端全部家当）

```
agent/src/
├─ agent.ts            # 门面：port 订阅 + 命令路由 + 纯查询（~330 行）
├─ ctx.ts              # ★ 全部可变状态的唯一持有者（config/permission/assembler/machine/gate）
├─ turn/               # ★ 一轮对话的完整故事：编排、主循环、工具执行、状态机、闸门、挂起权限、压缩
├─ session/            # 会话特征：工作集 conversation、持久化 store、生命周期 manager
├─ config/             # 配置能力：store（读写）、editor（树形编辑+回滚）、resolve（当前模型解析）、controller
├─ tools/              # 工具能力：registry + 一工具一文件夹（read_file/ write_file/ edit_file/ shell/）
├─ llm/                # LLM 能力：LlmClient 契约 + 一协议一文件夹（openai/）
├─ context/            # 上下文能力：组装、token 预算、压缩纯策略（何时压/怎么切/硬上限）
├─ permission/         # 权限能力：manager（三桶 + 运行时提升）
└─ shared/             # 跨域支撑：gate（并发闸门）、logger、语言级工具
```

记忆规则只有一句话：**问「这是哪次提交/哪个会话的事」→ 纵切文件夹（turn/ session/ config/）；问「这是什么能力」→ 能力文件夹（tools/ llm/ context/ permission/）**。这条规则写进了架构测试（子域依赖矩阵），不是文档口号。

## 一次提交的完整旅程

跟着「用户输入：帮我读 package.json」走一遍——这条链路穿过几乎所有模块：

```
1. TUI 输入框回车
   └─ ui: port.post({ type: 'submit', text: '帮我读 package.json' })

2. agent.ts 门面收到消息（构造时自订阅 port）
   └─ send() 路由：submit 分支
      ├─ isConfigured(ctx.config) 检查（未配置 → notice 引导 /config）
      └─ resolveTurnParams()   ← 命令时刻解析 provider 连接参数（值传入）

3. turn/turn-runner.ts — TurnRunner.submit(text, params)
   ├─ ctx.gate 占闸门（运行中再提交会被「运行中，请稍候」挡下）
   ├─ conversation.pushUserMessage(text)      ← R1 双写：history + context
   └─ emit({ type: 'message', role: 'user' }) ← UI 立刻看到你的消息

4. turn/loop.ts — AgentLoop.run(turn)（核心循环，见 03 章）
   ├─ 状态机 fire(submit) → thinking/responding
   ├─ 估算 token，超窗口 80% → 压缩（04 章）
   ├─ ctx-machine 驱动下调 LLM：OpenAiClient.chat() → SSE 流 → text_delta 实时转发
   ├─ 模型返回 tool_calls → ToolExecutor.execute()
   │    ├─ 权限三分支：allow 自动跑 / ask 挂起等用户决议 / reject 直接拒
   │    └─ 执行 read_file → tool_start / tool_end 事件
   └─ 工具结果回填 context → 再问模型 → 直到没有 tool_calls → finished

5. 回到 turn-runner：conversation.applyTurnResult(result)（同步 history）
   └─ finally：状态复位 idle → SessionStore 落盘

6. UI 侧的 reducer 把收到的每条消息变成消息块渲染（TUI/WebUI 同一份 reducer）
```

**读懂这条链，就读懂了 code agent 的骨架**。后面每章就是把链上的一个节点放大。

## 测试是活的文档

- `agent/test/agent.turn.test.ts`：**表征测试**——5 个场景走 Port 黑盒锁住全部对外行为（完整轮次、权限流、取消、压缩、resume）。重构期间它就是「行为没变」的判据。
- `bridge/test/architecture.test.ts`：**架构测试**——依赖方向 + 子域矩阵 + barrel 单入口 + index 纯 re-export，全在机器强制之下。
- 每个域还有自己的单元测试（`agent/test/turn/`、`agent/test/session/`……），文件与源码镜像。

## 阅读路线建议

按本系列章节顺序读：02 门面与 ctx（所有权）→ 03 turn（心脏）→ 04 压缩 → 05 session → 06/07/08 三个能力域 → 09 契约与传输 → 10 规范与扩展。读 03 之前可以先跳到测试目录把表征测试当例子跑一遍（`npx vitest run agent/test/agent.turn.test.ts`），带着「输入什么、吐什么」的体感读源码会快很多。
