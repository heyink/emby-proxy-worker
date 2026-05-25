# emby-proxy-worker

> **警告：不要把这个项目用于禁止反代的服务器，否则后果自负。**

运行在 Cloudflare Workers 上的 Emby 反向代理。零服务器成本，全球边缘节点加速。

把上游地址编码进 URL 路径里代理访问：

```text
/{scheme}/{domain}/{port}/{path}
```

**Emby 专用**，非通用反代。Go 版本见 [emby-reverse-proxy-go](https://github.com/Gsy-allen/emby-reverse-proxy-go)。

## 快速开始

### 部署

**前置要求：** Cloudflare 账号 + Node.js 22+

```bash
git clone https://github.com/Gsy-allen/emby-proxy-worker.git
cd emby-proxy-worker
npm install
```

#### 方式一：GitHub Actions 自动部署（推荐）

1. Fork 或推送本仓库到 GitHub
2. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) 创建 API Token（选择 **Edit Cloudflare Workers** 模板）
3. 在 Dashboard 首页右侧复制 **Account ID**
4. 在 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** 中添加：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. 推送到 `main` 分支即可自动部署

#### 方式二：手动部署

```bash
npx wrangler login
npm run deploy
```

部署完成后会输出 Worker URL（如 `https://emby-proxy-worker.<subdomain>.workers.dev`）。

### 绑定自定义域名（可选）

Cloudflare Dashboard → Worker 设置 → **Triggers** → **Custom Domains**（域名需托管在 Cloudflare）。

### 本地开发

```bash
npm run dev          # 默认监听 http://localhost:8788
curl localhost:8788/health                    # → 200 ok
curl localhost:8788/https/httpbin.org/443/get  # → 代理请求
```

## 访问格式

```
https://<worker域名>/{scheme}/{domain}/{port}/{path}
```

| 部分 | 规则 |
|---|---|
| `scheme` | `http` 或 `https` |
| `domain` | 上游域名，必填 |
| `port` | 端口号 `1-65535`，**不可省略**（即使是 80/443） |
| `path` | 可为空，空时请求上游 `/`；查询参数原样透传 |

示例（假设 Worker 域名为 `proxy.example.com`）：

```text
https://proxy.example.com/https/emby.example.com/443/
https://proxy.example.com/http/emby.example.net/8096/emby/Items?api_key=xxxx
https://proxy.example.com/http/emby.example.net/8096/web/index.html
```

> 根路径 `/` 返回 `400`，健康检查固定为 `/health`。

## 环境变量

在 Cloudflare Dashboard → Workers → 你的 Worker → **Settings** → **Variables and Secrets** 中配置。所有变量均为可选。

| 变量 | 说明 | 示例 |
|---|---|---|
| `SECRET_PREFIX` | 给所有请求路径加前缀，防止未授权访问 | `mysecret` |
| `ALLOWED_DOMAINS` | 上游域名白名单，逗号分隔，支持 `*.domain` 通配符 | `emby.example.com,*.example.net` |
| `REWRITE_BASE_URL` | 覆盖响应改写的基准 URL（默认从请求自动推断） | `https://proxy.example.com` |

### SECRET_PREFIX — 访问控制

设置后，所有请求路径前必须加上该前缀，否则 `403 Forbidden`：

```text
# 无 SECRET_PREFIX
/https/emby.example.com/443/

# SECRET_PREFIX=mysecret
/mysecret/https/emby.example.com/443/
```

设置了 `SECRET_PREFIX` 但未配 `REWRITE_BASE_URL` 时，改写基准 URL 会自动包含前缀（如 `https://proxy.example.com/mysecret`）。

### ALLOWED_DOMAINS — 域名白名单

不设置 = 允许所有域名。设置后仅允许匹配的域名通过：

- **精确匹配**：`emby.example.com` 只匹配自身
- **通配符**：`*.example.net` 匹配所有子域名（含多级）
- 不支持 `foo*.com`、`example.*` 等形式
- 大小写不敏感

被拒绝的请求返回 `403`，日志记录 `[AUTH] domain not allowed: <domain>`。

### REWRITE_BASE_URL — 自定义改写 URL

响应体和响应头中的 URL 改写需要基准 URL 来生成代理格式链接。默认自动从请求的 `Host` + 协议推断。使用 CDN 或自定义域名映射时可能需要手动指定。

## 功能特性

- 支持 HTTP / HTTPS / 媒体流 / `Range` 分段请求
- WebSocket 双向代理（基于 Durable Objects）
- 自动改写响应头 `Location`、`Content-Location` 中的绝对 URL
- 还原 `Referer`、`Origin`
- 清理出站请求头：`X-Real-Ip`、`X-Forwarded-*`、`Forwarded`、`Via`
- 移除响应头中的 `Server`、`X-Powered-By`
- Emby `PlaybackInfo` 接口响应体绝对 URL 改写
- 支持前置反代的 `X-Forwarded-Prefix`

### 响应体改写说明

代理会改写 `PlaybackInfo` 接口返回的绝对 URL（流媒体/转码地址），防止客户端绕过代理直连上游。仅覆盖此接口，不是全局改写。

## 配置前置反代

如果前面有 Nginx 等反代，确保透传：

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $http_host;

proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

公网端口非 443 时加：

```nginx
proxy_set_header X-Forwarded-Port $server_port;
```

套固定前缀时加：

```nginx
proxy_set_header X-Forwarded-Prefix /custom;
```

## 与 Go 版本的区别

| | Go 版本 | Worker 版本 |
|---|---|---|
| 运行环境 | 自建服务器 / Docker | Cloudflare Workers |
| 服务器成本 | 需要一台 VPS | Free 计划即可 |
| WebSocket | Hijack + 双向流 | Durable Objects |
| SSRF 防护 | DNS 解析后检查 IP | 域名白名单 |
| 出站代理 | HTTP_PROXY / SOCKS5 | 不支持 |
| 部署 | Docker Compose | `wrangler deploy` |

## 快速排错

| 问题 | 排查 |
|---|---|
| Worker 是否正常 | `curl -i https://<worker域名>/health` → `200 ok` |
| 根路径报错 | `curl -i https://<worker域名>/` → `400`（正常，不是 bug） |
| 代理不可达 | 检查路径格式是否正确：`/{scheme}/{domain}/{port}/{path}` |
| WebSocket 不通 | 检查前置反代是否透传 `Upgrade` / `Connection` 头 |
| WebSocket 500 | 检查 Dashboard 中 Durable Objects 绑定是否存在 |
| 403 Forbidden | 检查 `SECRET_PREFIX` 是否正确，或 `ALLOWED_DOMAINS` 是否匹配 |

## 费用

Cloudflare Workers Free 计划：每天 100,000 次请求 / 10ms CPU / Durable Objects 含在内。个人 Emby 场景通常足够。

## 开发

```bash
npm test            # 运行测试
npm run test:watch  # 监听模式
npm run dev         # 本地开发服务器
npx tsc --noEmit    # 类型检查
```

## 项目结构

```text
src/
├── main.ts        # Worker 入口，路由分发
├── proxy.ts       # HTTP 反向代理核心
├── websocket.ts   # WebSocket Durable Object
├── target.ts      # URL 路径解析、目标构建
├── headers.ts     # 请求/响应头处理
├── rewriter.ts    # 响应体绝对 URL 改写
├── allowlist.ts   # 上游域名白名单
└── types.ts       # 类型定义
```

## 许可证

MIT
