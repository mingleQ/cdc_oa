# Docker 部署说明

## 1. 本地 Mac 体验

构建并启动：

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:3080
```

浏览器检测页：

```text
http://localhost:3080/browser-check.html
```

查看日志：

```bash
docker compose logs -f oa
```

停止：

```bash
docker compose down
```

## 2. 本地持久化目录

Docker 本地运行使用以下目录：

| 目录 | 容器内路径 | 用途 |
|---|---|---|
| `docker-data/` | `/app/data` | SQLite 数据库 |
| `docker-uploads/` | `/app/uploads` | 附件 |
| `docker-backups/` | `/app/backups` | 备份 |

删除容器不会删除这些目录，数据仍会保留。

## 3. 备份

```bash
docker compose exec oa npm run backup
```

备份文件会写入：

```text
docker-backups/
```

## 4. 腾讯云生产部署建议

服务器目录：

```text
/opt/ggcdc-oa/
  data/
  uploads/
  backups/
```

生产环境 compose 文件参考 `docker-compose.prod.yml`。

生产环境必须设置强密钥：

```bash
export OA_JWT_SECRET='替换为足够长的随机字符串'
docker compose -f docker-compose.prod.yml up -d
```

生产环境建议用 Nginx 或 Caddy 做 HTTPS 反向代理，不要直接暴露 Node 端口。

## 5. 数据安全

正式环境至少做三层保护：

1. Docker volume 绑定宿主机目录，避免容器删除导致数据丢失。
2. 腾讯云云硬盘定期快照。
3. 每日执行 `npm run backup`，并把 `backups/` 和 `uploads/` 同步到 COS 或其他备份存储。

## 6. 升级流程

1. 先执行备份。
2. 拉取或上传新代码/镜像。
3. 执行：

```bash
docker compose up -d --build
```

4. 检查：

```bash
curl http://127.0.0.1:3080/api/health
```

