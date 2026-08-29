# WebUI 传输方式：SSE + POST

WebUI 与后端 Agent 通过 SSE 下行 + POST 上行通信，而非 WebSocket 或 Electron IPC。

设计文档已预言 SSE 方案（§2："将来 WebUI 加 SSE 传输层"）。Port 接口天然适配：`post` = 写一行 JSON 到 SSE 流（下行）/ 触发 HTTP handler（上行），`onMessage` = SSE 事件监听 / POST 路由回调。SSE 是浏览器原生 API（EventSource），无需额外库；POST 是最简单的 HTTP 请求。路线 A（先 Web 后 Electron）允许用浏览器 DevTools 高效迭代，后期套 Electron 时 server 代码原样跑在 main process。
