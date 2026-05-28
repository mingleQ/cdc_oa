# OA 正式环境部署手册

## 1. 部署定位

本系统面向贵港市疾控中心正式部署。当前实现为 Node.js + Express + SQLite，适合单机 Windows Server、Linux 服务器、腾讯云 CVM 或内网应用服务器部署。

如果甲方明确要求 MySQL/PostgreSQL，需要在上线前替换数据层并执行完整回归测试。

## 2. 服务器要求

- Windows Server 2016+ 或 Windows 10/11 专用内网主机
- Node.js 20 LTS 或 22 LTS
- 至少 2 核 CPU、4GB 内存
- 预留数据盘目录，用于数据库、附件和备份
- 浏览器要求 Chromium 内核浏览器；结合事业单位现场，可使用 360 浏览器极速模式。不建议 IE。详见 `docs/CLIENT_COMPATIBILITY.md` 和 `docs/CLIENT_ROLLOUT.md`

## 2.1 腾讯云部署建议

腾讯云可以部署，但要先和甲方确认系统是否允许上云、是否允许公网访问、是否有固定出口 IP、是否需要 VPN/专线、是否涉及备案或等保要求。

推荐架构：

```text
疾控中心电脑 -> Chromium 浏览器 -> HTTPS/VPN/IP白名单 -> 腾讯云 CVM -> OA 服务 -> SQLite/附件目录/备份目录
```

最低安全要求：

- 使用 HTTPS
- 安全组只开放业务端口
- 管理端口限制运维 IP
- 定期备份 `data/` 和 `uploads/`
- 修改默认密码和 `OA_JWT_SECRET`
- 开启云服务器快照或定期离线备份
- 不允许公网裸 HTTP 长期运行

## 2.2 客户端落地

如果甲方电脑仍以 Windows 7、IE、360 浏览器为主，实施时必须逐台确认浏览器：

```text
http://服务器IP:端口/browser-check.html
```

检测通过后再进入 OA。360 浏览器必须使用极速模式。

## 3. 安装步骤

进入项目目录：

```bash
cd OA
npm install
```

复制配置模板：

```bash
copy .env.example .env
```

生产环境必须修改：

```text
OA_JWT_SECRET=改成足够长的随机密钥
OA_DB_PATH=./data/oa.sqlite
PORT=3000
```

启动：

```bash
npm start
```

浏览器访问：

```text
http://服务器IP:3000
```

## 4. 默认账号

| 账号 | 密码 | 角色 |
|---|---|---|
| admin | 123456 | 管理员 |
| leader | 123456 | 部门负责人 |
| user | 123456 | 普通职工 |

正式交付前必须修改默认密码，并补齐真实部门和用户。

## 5. 数据目录

| 目录 | 用途 |
|---|---|
| `data/oa.sqlite` | SQLite 业务数据库 |
| `uploads/` | 附件目录，后续附件模块使用 |
| `backups/` | 数据库备份目录 |

## 6. 备份

手动备份：

```bash
npm run backup
```

建议 Windows 任务计划程序每天凌晨执行一次备份命令，并定期复制到其他内网存储。

## 7. 启停

启动：

```bash
npm start
```

停止：

在运行窗口按 `Ctrl + C`。

生产环境建议使用 NSSM 或 Windows 服务方式托管 Node 进程。

## 8. 上线前检查

- 修改 `OA_JWT_SECRET`
- 修改默认账号密码
- 初始化真实部门、角色、用户
- 确认服务器时间正确
- 确认防火墙开放端口
- 完成备份恢复演练
- 执行 `OA功能测试用例.md`
- 输出正式测试报告
