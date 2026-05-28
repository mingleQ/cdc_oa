# 腾讯云部署手册（GitHub + Docker）

适用：贵港疾控 OA，腾讯云 CVM 单机部署 + 应用级一致备份 + 磁盘快照。
代码托管：`git@github.com:mingleQ/cdc_oa.git`

## 0. 关键提醒（先看）

- **JWT 密钥**：生产环境必须设置强随机 `OA_JWT_SECRET`，否则容器拒绝启动（这是设计行为，不是 bug）。
- **目录属主**：容器以 `node`(uid 1000) 运行，宿主机数据目录必须 `chown -R 1000:1000`，否则写入 EACCES。
- **架构对齐**：腾讯云 CVM 默认 amd64 实例，直接在服务器上 build 即可，无跨架构问题。如果买的是 ARM 实例，需在 build 时加 `--platform linux/amd64`（或选 amd64 实例）。
- **备份两层**：磁盘快照做整机灾备，`scripts/backup.js` 做应用级一致备份（SQLite 在线备份，含 WAL）。两者都要。

## 1. 腾讯云服务器准备（CVM）

推荐规格：
- 2 核 4G（S5.MEDIUM4），系统盘 50G + 数据盘 100G
- Ubuntu 22.04 LTS 或 TencentOS Server 3
- 地域：广州/上海（就近甲方）
- 公网带宽 3-5 Mbps 起步
- 安全组：80/443 对公网开放，22 限制源 IP

服务器初始化：

```bash
# 安装 docker（含 compose 插件）
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# 安装 git
apt-get update && apt-get install -y git

# 配置 GitHub SSH key（一次性）
ssh-keygen -t ed25519 -C "server-cdc-oa"
cat ~/.ssh/id_ed25519.pub
# 把上面输出的公钥添加到 GitHub Settings → SSH and GPG keys
ssh -T git@github.com   # 看到 "Hi mingleQ! You've successfully authenticated" 即可

# 数据目录（必须 uid 1000）
sudo mkdir -p /opt/ggcdc-oa/{data,uploads,backups}
sudo chown -R 1000:1000 /opt/ggcdc-oa
```

## 2. 拉代码 + 构建镜像

```bash
cd /opt
sudo git clone git@github.com:mingleQ/cdc_oa.git ggcdc-oa-src
cd ggcdc-oa-src

# 生成强密钥写入 .env（与 docker-compose.prod.yml 一致）
echo "OA_JWT_SECRET=$(openssl rand -hex 24)" > .env

# 本机 build（amd64 实例直接 build，约 2-3 分钟）
docker compose -f docker-compose.prod.yml --env-file .env build

# 启动
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

⚠️ 数据卷挂载点是 `/opt/ggcdc-oa/{data,uploads,backups}`（手册第 1 步建的目录），代码目录 `/opt/ggcdc-oa-src` 只放代码。这样升级时 `git pull && rebuild` 不会影响数据。

## 3. 验证启动

```bash
docker compose -f docker-compose.prod.yml logs -f      # 看到"服务已启动"即成功
curl -s http://127.0.0.1:3000/api/health               # {"ok":true,...}
```

## 4. （可选）灌入演示数据供甲方验收

```bash
docker exec ggcdc-oa node scripts/seed-mock-cdc.js
# 默认账号：admin / leader / user / zhangzhuren / liufuzhuren ...
# 默认密码：123456
```

## 5. Nginx + HTTPS

参考 `deploy/nginx.conf`：替换域名与证书路径，放到 `/etc/nginx/conf.d/`，`nginx -t && systemctl reload nginx`。
容器只绑 `127.0.0.1:3000`，外部流量统一经 Nginx（TLS 终止）进来。

```bash
sudo cp /opt/ggcdc-oa-src/deploy/nginx.conf /etc/nginx/conf.d/ggcdc-oa.conf
# 编辑文件，替换域名 oa.ggcdc.local 和证书路径
sudo nginx -t && sudo systemctl reload nginx
```

## 6. 备份策略

```bash
# 应用级一致备份（每天 1 点）
crontab -e
# 添加：
# 0 1 * * * docker exec ggcdc-oa node scripts/backup.js >> /opt/ggcdc-oa/backups/cron.log 2>&1
```

- 腾讯云控制台：对该云硬盘配置**定期快照策略**（如每天 1 次，保留 7 天）。
- 恢复演练（上线前务必做一次）：

```bash
docker compose -f docker-compose.prod.yml down
cp /opt/ggcdc-oa/backups/oa-<时间>.sqlite /opt/ggcdc-oa/data/oa.sqlite
rm -f /opt/ggcdc-oa/data/oa.sqlite-wal /opt/ggcdc-oa/data/oa.sqlite-shm
docker compose -f docker-compose.prod.yml up -d
```

## 7. 上线后第一件事

用 admin / leader / user（初始密码均 `123456`）登录后，**立即在右上角「修改密码」逐个改掉**；通过基础平台导入真实部门与人员（见管理员手册的"批量导入"）。

## 8. 升级（发布新版本）

```bash
cd /opt/ggcdc-oa-src
git pull
docker compose -f docker-compose.prod.yml --env-file .env build
docker compose -f docker-compose.prod.yml --env-file .env up -d    # 数据库结构自动迁移，数据不丢
```

## 9. 排错

| 现象 | 排查 |
|---|---|
| 容器反复重启 | `docker logs ggcdc-oa`；多为未设 `OA_JWT_SECRET` 或架构不匹配 |
| build 报 better-sqlite3 编译失败 | 检查 CVM 是否 amd64；ARM 实例需 `--platform linux/amd64` |
| 上传/写库报权限错误 | `chown -R 1000:1000 /opt/ggcdc-oa` |
| 附件 413 | 调大 Nginx `client_max_body_size` 与后端 `OA_UPLOAD_MAX_MB` |
| git pull 报 host key 验证失败 | `ssh-keyscan github.com >> ~/.ssh/known_hosts` |
