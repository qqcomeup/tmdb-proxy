# TMDB Proxy

一个简单的 TMDB 代理服务，支持：

- TMDB API 代理：`/3/...`
- TMDB 图片代理：`/t/p/...`
- 图片缓存和 API 缓存
- 管理面板：`/admin/dashboard`
- Docker / Docker Compose 部署

## 镜像和架构

镜像同时支持：

- `linux/amd64`：常见 Intel / AMD 服务器
- `linux/arm64`：ARM64 服务器、树莓派 64 位等

两种架构使用同一个镜像地址，Docker 会自动选择：

```bash
ghcr.io/qqcomeup/tmdb-proxy:latest
```

## 最简单部署

下面两种部署方式二选一：

- 直接把密钥写入 `docker-compose.yml` 时，不需要 `.env`。
- 使用仓库自带 `docker-compose.yml` 时，把密钥写入 `.env`。

### 方式一：直接写 docker-compose.yml

新建目录：

```bash
mkdir -p tmdb-proxy
cd tmdb-proxy
```

新建 `docker-compose.yml`：

```yaml
services:
  tmdb-proxy:
    image: ghcr.io/qqcomeup/tmdb-proxy:latest
    container_name: tmdb-proxy
    restart: unless-stopped
    ports:
      - "127.0.0.1:54321:54321"
    environment:
      - NODE_ENV=production
      - PORT=54321
      - TMDB_API_KEY=你的_TMDB_API_KEY
      - ADMIN_API_KEY=你的管理密码
      - COOKIE_SECURE=false
      - IMAGE_DISK_CACHE_ENABLED=true
      - IMAGE_DISK_CACHE_DIR=/tmp/tmdb-cache
      - IMAGE_DISK_CACHE_MAX_GB=1
      - IMAGE_MEM_CACHE_MAX_MB=100
      - API_CACHE_TTL=600
      - API_CACHE_MAX_ITEMS=2000
    volumes:
      - ./cache:/tmp/tmdb-cache
```

启动：

```bash
docker compose up -d
```

本机访问：

```text
http://127.0.0.1:54321/health
http://127.0.0.1:54321/admin/dashboard
```

如果只允许本机反代访问，保持：

```yaml
ports:
  - "127.0.0.1:54321:54321"
```

如果需要直接外网访问，改成：

```yaml
ports:
  - "54321:54321"
```

然后访问：

```text
http://服务器IP:54321/health
http://服务器IP:54321/admin/dashboard
```

### 方式二：使用仓库自带 Compose + .env

克隆仓库：

```bash
git clone https://github.com/qqcomeup/tmdb-proxy.git
cd tmdb-proxy
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
TMDB_API_KEY=你的_TMDB_API_KEY
ADMIN_API_KEY=你的管理密码
```

启动：

```bash
docker compose --env-file .env up -d
```

## HTTP / HTTPS Cookie 设置

- 通过 HTTPS 域名访问管理面板：使用 `COOKIE_SECURE=true`。
- 直接通过 `http://服务器IP:端口` 访问：使用 `COOKIE_SECURE=false`，否则浏览器不会保存管理登录 Cookie。

直接通过 HTTP IP 访问时，请在 `.env` 或 `docker-compose.yml` 中设置：

```env
COOKIE_SECURE=false
```

使用 HTTPS 反向代理时设置：

```env
COOKIE_SECURE=true
```

## 常用接口

健康检查：

```text
/health
/ping
```

TMDB API 代理：

```text
/3/movie/popular?api_key=你的_TMDB_API_KEY&language=zh-CN
```

图片代理：

```text
/t/p/w500/图片路径
```

管理面板：

```text
/admin/dashboard
```

## 环境变量

必填变量：

| 变量 | 说明 |
| --- | --- |
| `TMDB_API_KEY` | TMDB API Key |
| `ADMIN_API_KEY` | 管理面板密钥 |

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Compose 对外绑定地址 |
| `PORT` | `54321` | 容器内监听端口 |
| `COOKIE_SECURE` | `true` | 是否只通过 HTTPS 发送管理登录 Cookie |
| `FETCH_TIMEOUT_MS` | `15000` | TMDB 请求超时时间（毫秒） |
| `API_RETRY_COUNT` | `2` | TMDB API 请求重试次数 |
| `IMAGE_RETRY_COUNT` | `1` | 图片请求重试次数 |
| `RETRY_DELAY_MS` | `150` | 重试间隔（毫秒） |
| `API_CACHE_MAX_ITEMS` | `2000` | API 缓存最大条目数 |
| `API_CACHE_TTL` | `600` | API 缓存秒数 |
| `IMAGE_CACHE_TTL` | `604800` | 图片缓存秒数 |
| `IMAGE_DISK_CACHE_ENABLED` | `true` | 是否启用图片磁盘缓存 |
| `IMAGE_DISK_CACHE_DIR` | `/tmp/tmdb-cache` | 图片缓存目录 |
| `IMAGE_DISK_CACHE_MAX_GB` | `1` | 图片磁盘缓存最大容量（GB） |
| `IMAGE_MEM_CACHE_MAX_MB` | `100` | 图片内存缓存最大容量（MB） |

资源限制变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTAINER_MEM_LIMIT` | `512m` | 容器内存上限 |
| `CONTAINER_MEM_RESERVATION` | `256m` | 容器内存预留 |
| `pids_limit` | `256` | Compose 中的进程数上限 |

其他可选变量可参考 `.env.example`，例如 `DISK_CACHE_CLEANUP_INTERVAL_MS`。

## 更新

```bash
docker compose pull
docker compose up -d
```

## 本地源码运行和测试

启动开发服务：

```bash
npm start
```

默认监听：

```text
0.0.0.0:54321
```

源码检查和测试：

```bash
npm run check
npm test
npm run validate:release
```
