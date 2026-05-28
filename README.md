# 贵港市疾控中心 OA 协同办公系统

这是根据 `waibaoOA需求单.pdf` 开发的贵港市疾控中心 OA 协同办公系统，按真实部署和运维要求持续完善。

## 运行方式

安装依赖：

```bash
npm install
```

启动服务：

```bash
npm start
```

然后访问 `http://localhost:3000`。

如果端口被占用：

```bash
PORT=3001 npm start
```

## 初始账号

- 管理员：`admin / 123456`
- 部门负责人：`leader / 123456`
- 普通职工：`user / 123456`

正式上线前必须修改默认密码。

## 系统能力

- Express 后端服务
- 业务数据服务端保存
- 登录身份校验
- 服务端角色权限控制
- 登录日志和操作日志
- 请假、出差、用车申请与审批
- 公文登记和办结归档
- 前端真实 API 驱动

## 测试用例

完整功能测试用例见 `OA功能测试用例.md`，已按模块覆盖每个需求功能点。

角色冒烟测试报告见 `OA角色冒烟测试报告.md`。

正式版阶段验收记录见 `OA正式版阶段验收记录.md`。

## 项目交付定位

本项目按贵港市疾控中心正式上线目标推进。后续开发 TODO 和交付约束见 `.claude/TODO.md`。

## 部署与状态

- 部署手册：`docs/DEPLOYMENT.md`
- Docker 部署说明：`docs/DOCKER_DEPLOYMENT.md`
- 客户端兼容性与腾讯云部署建议：`docs/CLIENT_COMPATIBILITY.md`
- 甲方客户端部署落地方案：`docs/CLIENT_ROLLOUT.md`
- 当前开发状态：`docs/STATUS.md`
- 接口文档：`docs/API.md`
- 用户操作手册：`docs/USER_MANUAL.md`
- 管理员操作手册：`docs/ADMIN_MANUAL.md`

## 备份

```bash
npm run backup
```
