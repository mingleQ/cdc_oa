# OA 接口文档

基础地址：`http://服务器IP:端口`

认证方式：登录后获取 JWT，后续接口在请求头加入：

```text
Authorization: Bearer <token>
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录 |
| GET | `/api/me` | 当前用户和菜单 |

## 基础平台

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/departments` | 部门列表 |
| POST | `/api/departments` | 新增部门 |
| PUT | `/api/departments/:id` | 编辑部门 |
| DELETE | `/api/departments/:id` | 删除空部门 |
| GET | `/api/users` | 用户列表 |
| POST | `/api/users` | 新增用户 |
| PUT | `/api/users/:id` | 编辑用户 |
| POST | `/api/users/:id/disable` | 禁用用户 |
| POST | `/api/users/:id/reset-password` | 重置密码 |
| GET | `/api/roles` | 角色和菜单权限 |
| PUT | `/api/roles/:id/modules` | 配置角色菜单 |

## 流程

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workflows` | 流程列表 |
| POST | `/api/workflows` | 新增流程版本并启用 |

## 申请审批

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/requests` | 申请列表，可用 `type=leave/trip/vehicle` 筛选 |
| POST | `/api/requests` | 提交申请 |
| GET | `/api/requests/:id` | 申请详情 |
| POST | `/api/requests/:id/approve` | 同意 |
| POST | `/api/requests/:id/reject` | 驳回 |
| POST | `/api/requests/:id/transfer` | 转办 |
| POST | `/api/requests/:id/add-sign` | 加签 |
| POST | `/api/requests/:id/withdraw` | 撤回 |

## 用车

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/vehicles` | 车辆列表 |
| POST | `/api/vehicles` | 新增车辆 |
| GET | `/api/vehicle-records` | 行车记录 |
| POST | `/api/vehicle-records` | 新增行车记录 |
| PUT | `/api/vehicle-records/:id` | 编辑行车记录 |
| DELETE | `/api/vehicle-records/:id` | 删除行车记录 |

## 公文

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/documents` | 公文列表 |
| POST | `/api/documents` | 收文登记/发文拟稿 |
| GET | `/api/documents/:id` | 公文详情 |
| POST | `/api/documents/:id/approve` | 公文审批/办结 |
| POST | `/api/documents/:id/distribute` | 分发 |
| POST | `/api/documents/:id/read` | 阅读 |
| POST | `/api/documents/:id/sign` | 签收 |
| POST | `/api/documents/:id/feedback` | 落实反馈 |

## 附件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/attachments/:businessType/:businessId` | 附件列表 |
| POST | `/api/attachments/:businessType/:businessId` | 上传附件 |
| GET | `/api/attachments/:id/preview` | 预览附件 |
| GET | `/api/attachments/:id/download` | 下载附件 |

## 日志和导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/logs/operations` | 操作日志 |
| GET | `/api/logs/login` | 登录日志 |
| GET | `/api/export/requests.xlsx` | 导出申请 |
| GET | `/api/export/documents.xlsx` | 导出公文 |
| GET | `/api/health` | 健康检查 |

