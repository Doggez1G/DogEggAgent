# UI 纵切重构设计（TUI + WebUI）

> 状态：已实施（2026-09-07，批次 U1–U5 落地；202 测试 + 五路 typecheck + build 全绿）
> 日期：2026-09-07
> 前置：后端纵切重构已完成（2026-09-07-backend-restructure-design.md）；本设计与后端同哲学——**App 只做装配，逻辑下沉为纯函数，扩展位预置为特征文件夹**。
> 验收要求：结构清晰 / 功能零变化 / 可维护 / 可扩展。

## 1. 现状与病灶

- TUI `app/app.tsx`（686 行）七种职责混居：状态接线（11 useState + 8 useRef 镜像）、消息订阅分发（15 分支）、键盘路由（~180 行七路分支）、命令提交流程、Static/动态渲染、5 个弹层内联视图、浏览模式视图。
- WebUI `app/app.tsx`（411 行）：22 个 useState、110 行 onMessage 状态分发、5 个 modal 装配、toast/highlight 计时器。
- 主题是模块级单例（`tui/theme/palette.ts` 的 `let currentTheme` + Proxy + 全局订阅）。
- 已有稳定资产（不动）：reducer、Static 架构（ADR-0008）、tui/components 五组件、webui/components 17 文件夹、tui/overlays 逻辑文件夹、tui/input 命令表、markdown、sse-client。

## 2. 核心设计决策

1. **两端统一 features/ 纵切**：一块屏幕功能面（视图 + 键盘处理 + 消息处理 + 纯逻辑）= 一个特征文件夹。判据：理解/修改一个功能只开一个文件夹；加新功能 = 复制特征模板。
2. **TUI 与 WebUI 特征的内容物不同**（交互模型决定，非设计不一致）：
   - TUI 单焦点：视图状态是全局互斥状态机（`app/view-state.ts` 的 View union，类似后端的 State）→ 特征装 `view.tsx + keys.ts`；
   - WebUI 多区域并发：特征**各自订阅 port、持有私有状态** → 特征装 `hook + logic/ 纯函数`。
3. **键盘路由纯函数化**：每个特征一个 `keys.ts`，签名 `(view, key, inputChar, api) => void`（api 为该特征的窄接口，测试注入 spy）——app.tsx 的 180 行 useInput 分支逐字搬移，行为按构造保持。
4. **消息订阅分域**：TUI 拆 `use-chat`（reducer + 清屏重挂载）/`use-agent-events`（overlay 开合、回填、intent）；WebUI 每 hook 各自订阅 port 只关心自己的消息（多订阅合法）。
5. **ThemeRegistry**：类实例 + React Context 下发，替代模块级单例 + Proxy；「清屏 + Static 重挂载」的主题切换机制保留。
6. **纯逻辑下沉 logic/**：WebUI 的 toolCalls 归并、filesTouched 提取、knownProjects 累积抽为无 React 依赖的纯函数（可单测）。

## 3. 目标结构

```
ui/src/tui/
├─ app/          index.ts  entry.tsx  app.tsx(装配~150)  view-state.ts
│                use-chat.ts  use-agent-events.ts  use-key-routing.ts
├─ features/     config/{view,keys,index}  sessions/{view,keys,filter,index}
│                permission/{view,keys,decisions,index}  menu/{view,keys,index}
│                info/{view,keys,index}  browse/{view,keys,index}
│                input/{keys(联想+历史),index}（input/ 命令表归队）
├─ components/   （不动）      theme/  registry.ts  context.tsx  palette.ts
├─ markdown/     （不动）      chat/（删除空壳，reducer 直引 shared）
ui/src/webui/
├─ app/          app.tsx(装配~120)  view-state.ts
├─ features/     chat/{use-chat-state}  turn-tracking/{use-turn-tracking, logic/{tool-tracking,files-touched}}
│                info-panel/{use-panel-data}  sessions/{use-sessions, logic/session-groups}
│                approval/{use-approval}  chrome/{use-ui-chrome}
├─ channel/ components/ theme/   （不动）
```

## 4. 测试安全网

- key-routing 逐特征单测（cursor 边界 / esc 层级回退 / d 删除 clamp / 联想补全 / 窗口化）——api 注入 spy；
- WebUI logic/ 纯函数单测（tool_tracking 归并含孤儿 end 与 denied、files_touched、session_groups）；
- 渲染冒烟（ink-testing-library）列为二期可选（先验证与 Ink7/React19 兼容）。

## 5. 边界立法（进 architecture.test）

tui/ 与 webui/ 互不 import；shared 不依赖 tui/webui（已有）；components 与 features 视图不得 import app/；前端不得 import agent/server（已有）。

## 6. 迁移批次

| 批次 | 内容 | 效果 |
|---|---|---|
| U1 | features/ keys 抽取 + 单测 + app 接线 | app.tsx −180 行，键盘路由首次可测 |
| U2 | 消息订阅分域 + 弹层视图文件夹化 | app.tsx → ~200 行 |
| U3 | ThemeRegistry + useTheme 全组件替换 | 前端全局可变量清零 |
| U4 | WebUI features/ 化 | app.tsx → ~120 行，logic 可测 |
| U5 | 空壳清理 + 边界立法 + 文档 | — |

行为零变化：所有搬移逐字保真，唯一行为级改动点是 ThemeRegistry 的实现载体（外观与交互不变）。
