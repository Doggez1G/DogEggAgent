# SSE Channel 实现归 server 包而非 bridge

SSE Port 实现放在 `server/src/channel/sse.ts`，而非 bridge 包。设计文档曾预言"在 bridge 新增 sse-channel.ts"，但 SSE 本质是 HTTP 传输细节（Response 对象、SSE 帧格式、POST 路由），归 server 包更内聚。bridge 保持纯净：只有 Port 接口 + in-memory 通道，零传输依赖。
