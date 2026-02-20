# MCSpot

一个基于腾讯云 API 的 Minecraft 服务器按需启动、自动备份与释放的轻量级工具。提供创建、启动、删除实例以及查询实例信息等功能。

## 📖 目录

- [快速开始](#快速开始)
- [环境配置](#环境配置)
- [认证说明](#认证说明)
- [API 接口](#api-接口)
- [使用示例](#使用示例)
- [错误排查](#错误排查)
- [技术栈](#技术栈)

---

## 快速开始

### 前置要求

- Node.js >= 14.0
- Redis 数据库（用于存储操作日志和认证记录）
- 腾讯云账户及 API 密钥
- 提前创建启动模板和自定义镜像

### 安装和启动

```bash
# 1. 克隆项目
git clone https://github.com/yourusername/mcsg-tencent-cloud-api.git
cd mcsg-tencent-cloud-api

# 2. 安装依赖
npm install

# 3. 配置 .env 文件（参考下方的环境配置）
cp .env.example .env
# 编辑 .env，填入你的配置

# 4. 启动服务
npm start

# 或使用 nodemon 开发模式
npm run dev
```

### 验证服务

```bash
# 检查健康状态
curl http://localhost:3000/health

# 输出应为：
# {"status":"ok","timestamp":"2026-02-16T10:00:00.000Z"}
```

---

## 环境配置

### 创建 .env 文件

项目根目录创建 `.env` 文件，内容如下：

```env
# ========== 腾讯云配置 ==========
# 从腾讯云控制台获取 https://console.cloud.tencent.com/cam/capi
TENCENT_SECRET_ID=your_secret_id_here
TENCENT_SECRET_KEY=your_secret_key_here

# 云服务器所在地域，例如 ap-shanghai, ap-beijing 等
# 完整列表：https://cloud.tencent.com/document/api/213/15692#.E5.9C.B0.E5.9F.9F.E5.88.97.E8.A1.A8
TENCENT_REGION=ap-shanghai

# ========== 服务器配置 ==========
# Express 服务器监听端口
PORT=3000

# ========== Redis 配置 ==========
# Redis 连接地址（用于存储操作日志和认证记录）
REDIS_URL=redis://localhost:6379
# Redis 密码（如果 Redis 需要认证）
REDIS_PASSWORD=

# ========== 认证配置 ==========
# JSON 格式，用户名和密码配置
# 用户名唯一，密码用于认证，permissions 为权限数组
AUTH_PASSWORDS={
  "admin": {
    "password": "Admin@abc123456!",
    "permissions": ["admin"]
  },
  "operator": {
    "password": "Operator@123456",
    "permissions": ["run_instance", "start_instance", "terminate_instance", "read_instance"]
  },
  "viewer": {
    "password": "Viewer@123456",
    "permissions": ["read_instance"]
  }
}

# 密码错误尝试次数限制（超过此次数 IP 被锁定 15 分钟）
MAX_AUTH_ATTEMPTS=5

# ========== Minecraft 配置 ==========
# 启动模板 ID（从腾讯云控制台创建）
MC_LAUNCH_TEMPLATE_ID=lt-xxxxxxxxxxxxx

# Minecraft 服务器端口
MC_PORT=25565
```

### 配置说明

| 配置项 | 说明 | 获取方式 |
|--------|------|--------|
| `TENCENT_SECRET_ID` | 腾讯云 API 密钥 ID | [腾讯云控制台 - API 密钥](https://console.cloud.tencent.com/cam/capi) |
| `TENCENT_SECRET_KEY` | 腾讯云 API 密钥 | 同上 |
| `TENCENT_REGION` | 云服务器地域 | 根据实际位置选择，如上海为 `ap-shanghai` |
| `MC_LAUNCH_TEMPLATE_ID` | 启动模板 ID | [腾讯云控制台 - 启动模板](https://console.cloud.tencent.com/cvm/template) |

---

## 认证说明

### 认证格式

**所有受保护 API 接口都必须使用 `username:password` 格式进行认证**。

请求头格式：
```
Authorization: Bearer <username>:<password>
```

其中：
- `<username>` 是 `AUTH_PASSWORDS` 配置中定义的用户名
- `<password>` 是该用户对应的密码
- 用户名和密码必须都正确匹配

### 示例

假设配置中有以下用户：
```json
{
  "admin": {
    "password": "Admin@abc123456!",
    "permissions": ["admin"]
  }
}
```

则正确的认证请求为：
```bash
curl -H "Authorization: Bearer admin:Admin@abc123456!" http://localhost:3000/api/instances
```

### 权限等级

| 权限 | 说明 | 可用操作 |
|------|------|---------|
| `admin` | 管理员权限 | 所有操作，包括查看日志 |
| `run_instance` | 创建实例 | 创建新的 CVM 实例 |
| `start_instance` | 启动实例 | 启动已停止的实例 |
| `terminate_instance` | 删除实例 | 删除 CVM 实例 |
| `read_instance` | 读取实例信息 | 查询实例列表和 IP 地址 |

### 安全措施

- 密码连续错误 5 次（默认值）后，该 IP 将被锁定 15 分钟
- 所有操作都会被记录到 Redis，包括成功和失败的认证尝试
- 强烈建议使用强密码（至少 12 字符，包含大小写字母、数字和特殊符号）

---

## API 接口

### 1. 创建实例

通过启动模板创建新的云服务器实例。

**请求**
```
GET /api/run-instance?templateId=<模板ID>&templateVersion=<版本>
```

**权限**: `run_instance`

**参数**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `templateId` | string | 是 | 启动模板 ID |
| `templateVersion` | string | 否 | 模板版本，默认使用 `DEFAULT` |

**请求示例**
```bash
curl -H "Authorization: Bearer admin:password123" \
  "http://localhost:3000/api/run-instance?templateId=lt-abc123&templateVersion=1"
```

**响应示例**

✅ 成功：
```json
{
  "success": true,
  "message": "实例创建成功",
  "instanceId": "ins-abc123xyz"
}
```

❌ 失败：
```json
{
  "success": false,
  "message": "创建实例失败",
  "error": "LaunchTemplateNotFound"
}
```

---

### 2. 启动实例

启动已停止的云服务器实例。

**请求**
```
GET /api/start-instance?instanceId=<实例ID>
```

**权限**: `start_instance`

**参数**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `instanceId` | string | 是 | 实例 ID |

**请求示例**
```bash
curl -H "Authorization: Bearer operator:password123" \
  "http://localhost:3000/api/start-instance?instanceId=ins-abc123xyz"
```

**响应示例**

✅ 成功：
```json
{
  "success": true,
  "message": "实例启动请求已发送",
  "instanceId": "ins-abc123xyz"
}
```

---

### 3. 删除实例

删除指定的云服务器实例（**不可逆操作**）。

**请求**
```
GET /api/terminate-instance?instanceId=<实例ID>
```

**权限**: `terminate_instance`

**参数**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `instanceId` | string | 是 | 实例 ID |

**请求示例**
```bash
curl -H "Authorization: Bearer operator:password123" \
  "http://localhost:3000/api/terminate-instance?instanceId=ins-abc123xyz"
```

---

### 4. 获取实例列表

查询当前账户下的所有云服务器实例。

**请求**
```
GET /api/instances
```

**权限**: `read_instance`

**请求示例**
```bash
curl -H "Authorization: Bearer viewer:password123" \
  "http://localhost:3000/api/instances"
```

**响应示例**

✅ 成功：
```json
{
  "success": true,
  "count": 2,
  "instances": [
    {
      "instanceId": "ins-abc123xyz",
      "instanceName": "mc-server-1",
      "instanceState": "RUNNING",
      "instanceType": "S5.MEDIUM4",
      "zone": "ap-shanghai-2",
      "creationTime": "2026-02-14T10:00:00Z",
      "publicIp": "1.2.3.4",
      "privateIp": "10.0.0.1"
    }
  ]
}
```

**实例状态**

| 状态 | 说明 |
|------|------|
| `PENDING` | 创建中 |
| `LAUNCH_FAILED` | 创建失败 |
| `RUNNING` | 运行中 |
| `STOPPED` | 已关机 |
| `STARTING` | 开机中 |
| `STOPPING` | 关机中 |
| `REBOOTING` | 重启中 |
| `SHUTDOWN` | 停止待销毁 |
| `TERMINATING` | 销毁中 |

---

### 5. 获取操作日志

查询系统操作日志（需要 admin 权限）。

**请求**
```
GET /api/auth-logs?userId=<用户ID>&limit=<数量>
```

**权限**: `admin`

**参数**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `userId` | string | 否 | 筛选特定用户的日志 |
| `limit` | number | 否 | 返回日志条数，默认 50 |

**响应示例**

✅ 成功：
```json
{
  "success": true,
  "count": 50,
  "logs": [
    {
      "requestId": "550e8400-e29b-41d4-a716-446655440000",
      "operation": "CREATE_INSTANCE_SUCCESS",
      "clientIp": "192.168.1.100",
      "userId": "operator",
      "details": "实例创建成功: ins-abc123xyz",
      "timestamp": "2026-02-16T10:30:00.000Z"
    }
  ]
}
```

---

### 6. 获取用户信息

获取当前认证用户的基本信息。

**请求**
```
GET /api/user-info
```

**权限**: 任意（已认证即可）

**响应示例**

✅ 成功：
```json
{
  "success": true,
  "userId": "admin",
  "userName": "admin",
  "permissions": ["admin"]
}
```

---

### 7. 健康检查

检查服务状态（无需认证）。

**请求**
```
GET /health
```

**响应示例**

✅ 成功：
```json
{
  "status": "ok",
  "timestamp": "2026-02-16T12:00:00.000Z"
}
```

---

## 使用示例

### 完整工作流程

```bash
# 1. 获取用户信息
curl -H "Authorization: Bearer admin:Admin@abc123456!" \
  http://localhost:3000/api/user-info

# 2. 创建实例
curl -H "Authorization: Bearer operator:Operator@123456" \
  "http://localhost:3000/api/run-instance?templateId=lt-xxxxx&templateVersion=1"

# 3. 查看实例列表
curl -H "Authorization: Bearer viewer:Viewer@123456" \
  http://localhost:3000/api/instances

# 4. 查看操作日志
curl -H "Authorization: Bearer admin:Admin@abc123456!" \
  "http://localhost:3000/api/auth-logs?limit=20"

# 5. 删除实例
curl -H "Authorization: Bearer operator:Operator@123456" \
  "http://localhost:3000/api/terminate-instance?instanceId=ins-xxxxx"
```

---

## 错误排查

### 问题 1: "未提供认证信息"

**原因**: 请求缺少 `Authorization` 头

**解决方案**:
```bash
# ❌ 错误 - 缺少认证头
curl http://localhost:3000/api/instances

# ✅ 正确 - 包含认证头
curl -H "Authorization: Bearer username:password" http://localhost:3000/api/instances
```

---

### 问题 2: "认证格式错误"

**原因**: 没有使用 `username:password` 格式（缺少冒号）

**解决方案**:
```bash
# ❌ 错误 - 只提供密码
curl -H "Authorization: Bearer onlypassword" http://localhost:3000/api/instances

# ✅ 正确 - 提供 username:password
curl -H "Authorization: Bearer admin:password123" http://localhost:3000/api/instances
```

---

### 问题 3: "用户名或密码错误"

**原因**: 用户名或密码不匹配

**解决方案**:
1. 检查 `.env` 中的 `AUTH_PASSWORDS` 配置
2. 区分大小写
3. 确保密码完全正确

---

### 问题 4: "IP 已被锁定"

**原因**: 密码错误 5+ 次，IP 被锁定 15 分钟

**解决方案**:
1. 等待 15 分钟后重试
2. 检查密码是否正确
3. 若需要调整，修改 `MAX_AUTH_ATTEMPTS` 环境变量

---

### 问题 5: "缺少必需参数"

**原因**: 没有提供必需的查询参数

**解决方案**:
```bash
# 需要提供 instanceId 参数的接口示例：
curl -H "Authorization: Bearer admin:password" \
  "http://localhost:3000/api/start-instance?instanceId=ins-xxxxx"
```

---

### 问题 6: "缺少所需权限"

**原因**: 用户权限不足

**解决方案**:
1. 使用具有该权限的用户重试
2. 或修改 `.env` 中的 `AUTH_PASSWORDS` 为用户添加权限

---

### 问题 7: 实例未分配公网 IP

**症状**: `publicIp` 为 `null`

**可能原因**:
- 实例刚创建，还未分配
- 启动模板未配置分配公网 IP
- VPC 未关联公网 IP

**解决方案**:
1. 等待 1-2 分钟后重试
2. 在腾讯云控制台检查启动模板配置
3. 为实例手动分配公网 IP

---

## 技术栈

| 技术 | 用途 |
|------|------|
| **Node.js** | 运行环境 |
| **Express** | Web 框架 |
| **EJS** | 视图模板引擎 |
| **Redis** | 缓存和日志存储 |
| **tencentcloud-sdk-nodejs** | 腾讯云 API SDK |
| **dotenv** | 环境变量管理 |
| **cookie-parser** | Cookie 处理中间件 |

---

## 相关资源

- 🔗 [腾讯云 CVM 文档](https://cloud.tencent.com/document/product/213)
- 🔗 [腾讯云 API Explorer](https://console.cloud.tencent.com/api/explorer)
- 🔗 [腾讯云启动模板](https://cloud.tencent.com/document/product/213/45442)
- 🔗 [Node.js 腾讯云 SDK](https://github.com/TencentCloud/tencentcloud-sdk-nodejs)

---

## 注意事项 ⚠️

1. **安全性** 🔒:
   - ❌ 不要将 `.env` 提交到版本控制系统
   - ❌ 不要在代码中硬编码密钥信息
   - ✅ 定期更换认证密码
   - ✅ 使用强密码（至少 12 字符，包含大小写字母、数字和特殊符号）
   - ✅ 定期检查操作日志，监控异常活动

2. **操作风险** ⚠️:
   - 🔴 删除实例是不可逆操作，请先执行手动备份。
   - 🔴 创建实例前确保账户余额充足
   - ⏱️ 实例创建和销毁需要数秒到数分钟
   - 📝 关键操作前建议备份或记录实例配置

3. **资源管理** 💰:
   - 定期检查腾讯云账户实例配额
   - 及时删除不需要的实例以节省成本
   - 监控带宽和存储使用情况

---

## 许可证

MIT

## 技术支持

如有问题或建议，请提交 Issue 或 PR。
