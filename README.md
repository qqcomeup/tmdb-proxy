# TMDB Proxy

一个简单的 TMDB 代理服务，支持：

- TMDB API 代理：`/3/...`
- TMDB 图片代理：`/t/p/...`
- 图片缓存和 API 缓存
- 管理面板：`/admin/dashboard`
- Docker / Docker Compose 部署

镜像地址：

```bash
ghcr.io/qqcomeup/tmdb-proxy:latest
```

## 最简单部署

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
      - IMAGE_DISK_CACHE_ENABLED=true
      - IMAGE_DISK_CACHE_DIR=/tmp/tmdb-cache
      - IMAGE_DISK_CACHE_MAX_GB=2
      - IMAGE_DISK_CACHE_TRIGGER_GB=1.7
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

## 使用仓库自带 compose

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

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TMDB_API_KEY` | 是 | 无 | TMDB API Key |
| `ADMIN_API_KEY` | 是 | 无 | 管理面板密钥 |
| `PORT` | 否 | `54321` | 容器内监听端口 |
| `IMAGE_DISK_CACHE_ENABLED` | 否 | `true` | 是否启用图片磁盘缓存 |
| `IMAGE_DISK_CACHE_DIR` | 否 | `/tmp/tmdb-cache` | 图片缓存目录 |
| `IMAGE_DISK_CACHE_MAX_GB` | 否 | `1` | 图片缓存最大容量 |
| `IMAGE_MEM_CACHE_MAX_MB` | 否 | `100` | 图片内存缓存最大容量 |
| `API_CACHE_TTL` | 否 | `600` | API 缓存秒数 |
| `IMAGE_CACHE_TTL` | 否 | `604800` | 图片缓存秒数 |

## 更新

```bash
docker compose pull
docker compose up -d
```

## 本地源码运行

```bash
npm start
```

默认监听：

```text
0.0.0.0:54321
```
