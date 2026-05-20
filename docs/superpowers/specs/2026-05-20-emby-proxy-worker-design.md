# Emby Reverse Proxy - Cloudflare Worker 版本设计

> 日期：2026-05-20
> 状态：已批准
> 源项目：~/Code/emby-reverse-proxy-go

## 概述

将 Go 版 Emby 反向代理移植为 Cloudflare Pages Functions + Durable Objects 方案，保持核心功能一致。

## 功能范围

### 保留的功能

- URL 路径解析 `/{scheme}/{domain}/{port}/{path}`
- HTTP/HTTPS 反向代理（fetch API）
- 响应头改写（Location、Content-Location）
- 响应体绝对 URL 改写（仅 PlaybackInfo 和 Sessions/Playing/Progress）
- 请求头清理（X-Real-Ip、X-Forwarded-*、Forwarded、Via）
- Referer/Origin 还原
- 媒体流透传（Range 请求支持）
- WebSocket 双向代理（通过 Durable Object）
- 健康检查 `/health`
- X-Forwarded-Prefix 支持

### 不保留的功能

- SSRF 防护（Worker 无法控制 DNS 解析，不做）
- 出站代理支持（Worker 环境不适用）
- gzip 手动编解码（Cloudflare 边缘自动处理）

## 架构

```
客户端请求 → functions/[[path]].ts（Pages Functions catch-all）
  ├─ /health → 200 "ok"
  ├─ WebSocket 升级 → Durable Object (WebSocketProxy)
  └─ 普通 HTTP → src/proxy.ts
       1. parseTarget → 解析目标
       2. fetch(targetURL) → 请求上游
       3. 条件性响应体改写
       4. 返回 Response
```

## 项目结构

```
emby-proxy-worker/
├── functions/
│   └── [[path]].ts          # Pages Functions 入口，捕获所有路径
├── src/
│   ├── proxy.ts             # HTTP 代理核心逻辑
│   ├── websocket.ts         # WebSocket Durable Object
│   ├── target.ts            # URL 解析、目标构建
│   ├── headers.ts           # 请求/响应头处理
│   ├── rewriter.ts          # 响应体绝对 URL 改写
│   └── types.ts             # 共享类型定义
├── wrangler.toml            # Cloudflare 配置
├── tsconfig.json
├── package.json
└── README.md
```

## 模块设计

### 1. 入口（functions/[[path]].ts）

- 处理 `/health` 路径返回 200 "ok"
- 检测 WebSocket 升级请求（Connection: upgrade + Upgrade: websocket）
- WebSocket 请求转发到 Durable Object
- 其他请求调用 proxy.ts 处理

### 2. HTTP 代理（src/proxy.ts）

处理流程：
1. `parseTarget(request)` 解析路径中的 scheme/domain/port/path
2. `buildTargetURL(target)` 构建上游完整 URL
3. 复制请求头，清理代理敏感头，还原 Referer/Origin
4. 对需要改写的路径设置 `Accept-Encoding: identity`
5. `fetch(targetURL, init)` 请求上游
6. 判断是否需要改写响应体（路径匹配 + Content-Type 是文本 + 响应有 body）
7. 需要改写：读 body → `rewriteBody()` → 返回新 Response
8. 不需要改写：直接流式透传 Response
9. 改写响应头 Location/Content-Location

### 3. WebSocket 代理（src/websocket.ts）

Durable Object 类 `WebSocketProxy`：

- `fetch(handler)` 接收请求：
  1. 创建 WebSocket pair（服务端模式 acceptWebSocket）
  2. `parseTarget()` 解析目标
  3. `fetch(targetURL, { headers: { Upgrade: 'websocket' } })` 以客户端模式连接上游
  4. 拿到上游 WebSocket pair
  5. 注册 message/close/error 事件处理
- 双向转发：
  - 客户端 message → 写入上游 WebSocket
  - 上游 message → 写入客户端 WebSocket
  - 任一端 close → 关闭另一端
- 请求头处理与 HTTP 代理一致（清理代理痕迹）
- 使用 crypto.randomUUID() 作为 DO 实例 ID，每个连接独立实例

### 4. URL 解析（src/target.ts）

类型定义：
```typescript
interface Target {
  scheme: string;   // "http" | "https"
  domain: string;
  port: number;     // 1-65535
  path: string;
  query: string;
}
```

函数：
- `parseTarget(pathname: string, query: string): Target | Error`
- `buildTargetURL(target: Target): string`
- `targetRequestPath(target: Target): string`
- `buildProxyURL(baseURL: string, target: Target, path: string): string`
- `inferBaseURL(request: Request): string`
- `unproxyURL(raw: string, forwardedPrefix: string): string`

解析规则与 Go 版完全一致：
- scheme 只允许 http/https
- domain 必填
- port 必填，1-65535
- path 可为空（映射到上游 `/`）
- 根路径 `/` 返回错误

### 5. 请求头处理（src/headers.ts）

清除列表：
- X-Real-Ip, X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host, X-Forwarded-Port, X-Forwarded-Prefix
- Forwarded, Via

还原处理：
- Referer：从代理格式 URL 反向解析出原始 URL
- Origin：同上

响应头移除：
- Server, X-Powered-By

响应头改写：
- Location：绝对 URL 改写为代理格式
- Content-Location：同上

### 6. 响应体改写（src/rewriter.ts）

触发条件（两个都要满足）：
- 路径匹配：`/emby/items/*/playbackinfo` 或 `/sessions/playing/progress`（大小写不敏感）
- Content-Type 是文本类型：application/json, text/html, text/xml, text/plain, application/xml, application/xhtml, text/javascript, application/javascript

改写逻辑：
- 扫描响应体中的 `http://` 和 `https://`
- 提取完整 URL（遇到终止符停止：`"`, `'`, `<`, `>`, 空格, 换行, 括号等）
- 解析 host:port 和 path
- 改写为 `{baseURL}/{scheme}/{domain}/{port}/{path}` 格式
- 不使用正则，手动字符串扫描（和 Go 版保持一致）
- 不限定 host——即使 URL 指向不同上游域名（CDN、转码节点），也会改写

## 配置

### wrangler.toml

```toml
name = "emby-proxy-worker"
compatibility_date = "2024-01-01"

[[durable_objects.bindings]]
name = "WEBSOCKET_PROXY"
class_name = "WebSocketProxy"

[[migrations]]
tag = "v1"
new_unique_class = "WebSocketProxy"
```

### 依赖

零运行时依赖。dev 依赖：
- wrangler
- typescript
- @cloudflare/workers-types

## 与 Go 版本的差异对照

| 功能 | Go 版本 | Worker 版本 |
|---|---|---|
| HTTP 客户端 | http.Client + 自定义 Transport | fetch() API |
| 流式传输 | io.CopyBuffer + 池化 buffer | Response.body ReadableStream |
| WebSocket | Hijack + 手动双向流 | Durable Object + fetch WebSocket 客户端 |
| gzip 处理 | 手动解码/重编码 + sync.Pool | 不处理，Cloudflare 边缘自动处理 |
| SSRF 防护 | DNS 解析后检查 IP | 不做 |
| 出站代理 | HTTP_PROXY/SOCKS5 | 不适用 |
| URL 改写性能 | bytes.Index 手动扫描 | 字符串手动扫描 |
| 健康检查 | /health 200 ok | /health 200 ok（一致） |
