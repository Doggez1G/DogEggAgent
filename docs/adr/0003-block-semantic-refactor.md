# Block 语义化重构：kind + colorToken

Block 模型从携带具体视觉值（emoji icon + hex color）重构为纯语义模型（kind + colorToken）。reducer、block、commands 从 `ui/src/tui/` 移到 `ui/src/shared/`，TUI 和 WebUI 共用。每个 UI 的 theme 层负责语义→视觉映射（TUI: kind→emoji, token→hex；WebUI: kind→Lucide icon, token→CSS var）。这使 reducer 真正共享，且 WebUI 不继承终端色码。
