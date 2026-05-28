# 开发与验收状态

更新时间：2026-05-22

## 架构（分层）

- 后端：Node.js + Express，按"路由 → 服务 → 仓储 → 数据"分层
  - `server/config.js` 配置与安全校验（生产强制 JWT 密钥）
  - `server/db.js` schema / 迁移 / 索引 / 初始化
  - `server/core/` 横切能力：`util` `auth` `security`(限流+登录锁定) `permissions`(数据可见性) `audit`(日志+通知)
  - `server/repository.js` 数据查询助手
  - `server/services/workflow.js` 流程引擎（按节点解析审批人 + 分支条件执行）
  - `server/routes/` 按域拆分：auth / org / request / vehicle / document / attachment / stats / system + `index.js` 汇总挂载
  - `server/server.js` 应用装配与启动
- 前端：原生 ES Module（`app.js` + `index.html` + `styles.css`），按角色权限驱动；列表分页
- 数据库：SQLite（WAL），一致性在线备份
- 测试：`npm test`（node:test，15 项接口/流程/安全/分页/导入用例全部通过）
- 部署：见 `docs/TENCENT_DEPLOY.md`、`deploy/nginx.conf`、`scripts/build-image.sh`（amd64）

## 需求覆盖（对照需求单）

| 模块 | 状态 |
|---|---|
| 部门管理（增/改/删/排序/层级树） | ✅ |
| 用户管理（增/改/禁用启用/重置密码） | ✅ |
| 流程可视化配置（按节点配审批人 + 分支条件） | ✅ |
| 审批通用（同意/驳回/加签/转办/撤回/意见/可改审批时间） | ✅ |
| 消息通知（待办/通过/驳回/分发 自动站内信） | ✅ |
| 角色与数据权限 | ✅ |
| 操作日志 / 登录日志（含 IP，可查询） | ✅ |
| 请假/出差/用车 申请·审批·状态跟踪 | ✅ |
| 出差工作事项、用车地点/乘车人/车辆需求 独立字段 | ✅ |
| 行车记录（里程/加油/归队） | ✅ |
| 收文（来文单位/文号/密级/紧急）·分发·阅读·签收·反馈 | ✅ |
| 发文（主送/抄送/用印盖章登记）·审批·分发·归档 | ✅ |
| 在线签字、阅读/打印留痕 | ✅ |
| 统计分析（按人/部门/时间/类型/月份 + 收发文）+ 导出 | ✅ |
| 各审批/公文 查询功能；管理员监控全部、可调流程节点 | ✅ |

## 安全加固

- 生产环境强制配置 `OA_JWT_SECRET`（缺失/弱密钥拒绝启动）
- 附件上传类型白名单（拒绝可执行脚本等）
- 登录失败锁定 + 接口限流
- 公文可见性按 `reader_ids` 精确匹配（修复姓名子串越权）
- helmet CSP、关闭 x-powered-by、CORS 收敛、登录页不再预填默认口令

## 上线前必做（运维）

1. 设置 `NODE_ENV=production` 与强随机 `OA_JWT_SECRET`
2. 首次登录后立即修改 admin/leader/user 初始密码（初始均为 123456）
3. 配置 `npm run backup` 定时任务（如每日 1 次）并演练一次恢复
4. 反向代理启用 HTTPS（内网证书）

## 自动化测试

```bash
npm test        # 13 项用例：登录/锁定/越权/多节点分支/通知/公文可见性/签名/统计/导出/附件白名单/部门层级
npm run backup  # 一致性备份到 backups/
```
