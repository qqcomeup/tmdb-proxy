# TMDB Proxy v2.6.1 公开发布设计

## 目标

将 `/home/dev/桌面/tmdb2026/tmdb22` 中验证通过的 v2.6.1 升级发布到现有公开仓库 `qqcomeup/tmdb-proxy`，继续由 GitHub Actions 构建并推送 `ghcr.io/qqcomeup/tmdb-proxy:latest`。

## 发布方式

保留现有仓库提交历史，以当前公开仓库为发布工作区。仅复制经过审查的源码、后台页面、测试和容器配置，不复制源目录中的 `.env`、缓存、日志或本地运行数据。

保留现有 GitHub Actions、中文 README、公开发布校验脚本和 `.gitignore`。Docker Compose 使用预构建的 GHCR 镜像，不要求部署者在服务器上构建源码。

## 源码与安全调整

- 核心服务和管理后台升级到 v2.6.1。
- 保留 HTTP/2、请求合并、重试、内存/磁盘缓存、签名管理会话、路径穿越防护和非 root 容器等改进。
- 访问日志记录请求路径前，删除 `api_key`、`key` 和 `admin_key` 参数值，防止运行期间泄露密钥。
- `.env` 永远不纳入版本控制；`.env.example` 只包含说明性占位值。
- Docker 运行用户保持 `65532:65532`，基础运行镜像使用 Node.js 22 Distroless Debian 13。
- `docker-compose.yml` 默认拉取 `ghcr.io/qqcomeup/tmdb-proxy:latest`，并继续要求设置 `TMDB_API_KEY` 和 `ADMIN_API_KEY`。

## 文档

README 以中文为主，提供两种互斥的简化配置方法：直接在 Compose 中填写密钥，或使用仓库 Compose 配合 `.env`。文档说明 `COOKIE_SECURE` 在 HTTPS 与纯 HTTP 部署下的取值，并列出主要可选缓存和重试参数。

## 验证

发布前必须完成：

1. Node.js 语法检查和 v2.6.1 自带测试。
2. 健康检查、管理登录会话、路径穿越阻止和上游 API 响应冒烟测试。
3. Docker Compose 配置展开验证。
4. 仓库公开发布校验脚本。
5. 对整个待提交目录执行敏感信息扫描，确认没有真实 TMDB 密钥、管理密码、SSH 私钥、GitHub Token 或历史备份文件。
6. 推送后等待 GitHub Actions 成功，并确认 GHCR `latest` 镜像已更新。

## 不在本次范围内

- 不修改原始目录 `/home/dev/桌面/tmdb2026/tmdb22`。
- 不新建仓库，不重写现有 Git 历史。
- 不发布源目录中的真实环境配置。
- 不新增 Redis、数据库、用户系统或其他依赖。
