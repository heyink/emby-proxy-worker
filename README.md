# emby-proxy-worker

> **警告：不要把这个项目用于禁止反代的服务器，否则后果自负。**

一个运行在 Cloudflare Workers 上的 Emby 反向代理，零服务器成本，全球边缘节点加速。

它把上游地址编码进路径里，通过固定格式代理 Emby 页面、API、媒体流和 WebSocket：

```text
/{scheme}/{domain}/{port}/{path}
```

这个项目是 **Emby 专用**，不是通用网站反代。Go 版本见 [emby-reverse-proxy-go](https://github.com/Gsy-allen/emby-reverse-proxy-go)。

## 适用场景

- 想把多个 Emby 入口统一收口到一个域名下
- 不想自己维护服务器，希望直接跑在 Cloudflare 边缘上
- 需要 WebSocket 实时通信支持
- 希望利用 Cloudflare 的全球网络加速访问

## 核心功能

- 代理 `/{scheme}/{domain}/{port}/{path}` 格式的 Emby 上游请求
- 支持 HTTP、HTTPS、媒体流、`Range` / `If-Range`
- 支持 WebSocket 双向代理（基于 Durable Objects）
- 改写响应头里的 `Location`、`Content-Location`
- 还原代理后的 `Referer`、`Origin`
- 清理代理请求头：`X-Real-Ip`、`X-Forwarded-*`、`Forwarded`、`Via`
- 移除响应头中的 `Server`、`X-Powered-By`
- 对 Emby `PlaybackInfo` 和 `Sessions/Playing/Progress` 接口做响应体绝对 URL 改写
- 支持前置反代的 `X-Forwarded-Prefix`
- 可选的上游域名白名单（支持 `*.domain` 通配符），防止被当开放代理滥用

## 与 Go 版本的区别

| 功能 | Go 版本 | Worker 版本 |
|---|---|---|
| 运行环境 | 自建服务器 / Docker | Cloudflare Workers（边缘计算） |
| 服务器成本 | 需要一台 VPS | Cloudflare Free 计划即可 |
| WebSocket | Hijack + 双向流 | Durable Objects |
| SSRF 防护 | DNS 解析后检查 IP | 域名白名单 |
| 出站代理 | HTTP_PROXY / SOCKS5 | 不支持 |
| 部署方式 | Docker Compose | `wrangler deploy` |

## 快速开始

### 1. 前置要求

- 一个 Cloudflare 账号
- Node.js 22+

### 2. 克隆并安装

```bash
git clone https://github.com/Gsy-allen/emby-proxy-worker.git
cd emby-proxy-worker
npm install
```

### 3. 本地开发

```bash
npm run dev
```

默认监听 `http://localhost:8788`。

测试：

```bash
# 健康检查
curl http://localhost:8788/health

# 根路径应返回 400
curl http://localhost:8788/

# 代理到外部站点
curl http://localhost:8788/https/httpbin.org/443/get
```

### 4. 部署到 Cloudflare

#### 方式一：GitHub Actions 自动部署（推荐）

Fork 或推送本仓库到 GitHub 后：

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) 创建 API Token，选择 **Edit Cloudflare Workers** 模板
2. 在 Cloudflare Dashboard 首页右侧复制你的 **Account ID**
3. 在 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** 中添加两个 Secret：
   - `CLOUDFLARE_API_TOKEN`：第 1 步创建的 Token
   - `CLOUDFLARE_ACCOUNT_ID`：第 2 步复制的 ID
4. 推送到 `main` 分支即可自动部署

#### 方式二：手动部署

```bash
npx wrangler login
npm run deploy
```

部署完成后，wrangler 会输出你的 Worker URL（格式如 `https://emby-proxy-worker.<your-subdomain>.workers.dev`）。

### 5. 绑定自定义域名（可选）

在 Cloudflare Dashboard 中：

1. 进入你的 Worker 设置
2. 点击 **Triggers** → **Custom Domains**
3. 添加你的域名（域名需要已托管在 Cloudflare）

### 6. 配置前置反代（如果需要）

如果你前面还有 Nginx 等反代，确保透传以下头：

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $http_host;

proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

如果你的公网端口不是 443，建议同时透传：

```nginx
proxy_set_header X-Forwarded-Port $server_port;
```

如果要套固定前缀：

```nginx
proxy_set_header X-Forwarded-Prefix /custom;
```

## 访问规则

唯一合法格式：

```text
/{scheme}/{domain}/{port}/{path}
```

规则：

- `scheme` 只能是 `http` 或 `https`
- `domain` 必填
- `port` 必填，范围 `1-65535`
- 即使是 `80` 或 `443` 也不能省略
- `path` 可为空；为空时实际请求上游 `/`
- 查询参数会原样透传
- 根路径 `/` 会返回 `400 Bad Request`
- 健康检查固定为 `/health`

示例：

```text
/https/emby.example.com/443/
/http/public-emby.example.net/8096/web/index.html
/http/public-emby.example.net/8096/emby/Items?api_key=xxxx
```

## 常见访问示例

假设你的 Worker 入口是 `https://proxy.example.com`：

- Emby HTTPS 首页：`https://proxy.example.com/https/emby.example.com/443/`
- Emby HTTP 首页：`https://proxy.example.com/http/public-emby.example.net/8096/`
- API 请求：`https://proxy.example.com/http/public-emby.example.net/8096/emby/Items?api_key=xxxx`
- Web 页面：`https://proxy.example.com/http/public-emby.example.net/8096/web/index.html`

## 上游域名白名单

默认不限制上游域名，任何人都可以通过你的 Worker 代理到任意服务器。为了防止被滥用，可以配置 `ALLOWED_DOMAINS` 环境变量来限制允许代理的上游域名。

### 配置方式

在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Variables and Secrets 中添加：

```
ALLOWED_DOMAINS = emby.example.com,*.example.net
```

### 匹配规则

- **精确匹配**：`emby.example.com` 只匹配自身
- **通配符匹配**：`*.example.net` 匹配所有子域名（`sub.example.net`、`a.b.example.net`）
- 通配符只支持 `*.` 前缀，不支持 `foo*.com`、`example.*` 等形式
- 大小写不敏感
- 不设置或留空 = 不限制（向后兼容）

### 示例

```
# 只允许一个域名
ALLOWED_DOMAINS = emby.example.com

# 允许多个域名和通配符
ALLOWED_DOMAINS = emby.example.com,*.example.net,emby2.example.org

# 不设置 = 允许所有域名（默认行为）
```

被拒绝的请求会返回 `403 Forbidden`，并在日志中记录 `[AUTH] domain not allowed: <domain>`。

## 健康检查

```bash
curl -i "https://proxy.example.com/health"
```

返回：`200 OK`，响应体 `ok`

## 响应体改写

代理会对 **部分 Emby 文本接口** 做响应体里的绝对 URL 改写，当前覆盖：

- `.../Items/.../PlaybackInfo`
- `.../Sessions/Playing/Progress`

这是因为某些 Emby 后端会在这些接口中返回硬编码的绝对 URL（如流媒体地址、转码地址），客户端拿到后会绕过代理直接请求上游。改写后，这些 URL 会被替换为代理格式，确保流量继续经过代理。

不要把它理解成"所有页面和 API 响应都会改写"。

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

## 开发

```bash
# 运行测试
npm test

# 监听模式
npm run test:watch

# 本地开发服务器
npm run dev

# 类型检查
npx tsc --noEmit
```

## 快速排错

### 1. 部署后 Worker 是否正常

```bash
curl -i "https://<你的worker域名>/health"
```

预期：`200 OK`，响应体 `ok`

### 2. 是否误访问了根路径

```bash
curl -i "https://<你的worker域名>/"
```

预期：`400 Bad Request`

### 3. 基础代理路径是否可达

```bash
curl -i "https://proxy.example.com/http/public-emby.example.net/8096/"
```

### 4. WebSocket 是否被前置层正确透传

如果实时页面打不开，检查前置反代是否正确传递了 `Upgrade` 和 `Connection` 头。

### 5. Durable Objects 绑定是否正确

如果 WebSocket 请求返回 500，检查 Cloudflare Dashboard 中 Worker 的 Durable Objects 绑定是否存在。

## 费用说明

Cloudflare Workers Free 计划：

- 每天 100,000 次请求
- 每次请求 10ms CPU 时间
- Durable Objects：每天 100,000 次请求包含在内

对于个人 Emby 使用场景，Free 计划通常足够。

## 许可证

MIT
