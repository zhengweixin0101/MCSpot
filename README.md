# 腾讯云CVM管理API

## 简介

这是一个基于Express和腾讯云SDK的云服务器(CVM)管理API服务，提供创建、启动、删除实例以及查询实例信息和IP地址等功能。

## 基础信息

- **Base URL**: `http://localhost:3000`
- **数据格式**: JSON

## 环境配置

在 `.env` 文件中配置腾讯云密钥：

```env
TENCENT_SECRET_ID=你的SecretId
TENCENT_SECRET_KEY=你的SecretKey
TENCENT_REGION=你的地域
```

## API接口列表

### 1. 创建实例

通过启动模板创建新的云服务器实例。

**请求**
```
GET /api/run-instance
```

**查询参数**

| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| templateId | string | 是 | 启动模板ID |
| templateVersion | string | 否 | 模板版本号，默认使用DEFAULT版本 |

**请求示例**
```bash
curl "http://localhost:3000/api/run-instance?templateId=lt-d0zjvlpf&templateVersion=1"
```

**响应示例**

成功：
```json
{
  "success": true,
  "message": "实例创建成功",
  "instanceId": "ins-abc123xyz"
}
```

失败：
```json
{
  "success": false,
  "message": "创建实例失败",
  "error": "错误详情"
}
```

---

### 2. 启动实例

启动已停止的云服务器实例。

**请求**
```
GET /api/start-instance
```

**查询参数**

| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| instanceId | string | 是 | 实例ID |

**请求示例**
```bash
curl "http://localhost:3000/api/start-instance?instanceId=ins-abc123xyz"
```

**响应示例**

成功：
```json
{
  "success": true,
  "message": "实例启动请求已发送",
  "instanceId": "ins-abc123xyz"
}
```

失败：
```json
{
  "success": false,
  "message": "缺少必需参数: instanceId"
}
```

---

### 3. 删除实例

删除指定的云服务器实例。

**请求**
```
GET /api/terminate-instance
```

**查询参数**

| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| instanceId | string | 是 | 实例ID |

**请求示例**
```bash
curl "http://localhost:3000/api/terminate-instance?instanceId=ins-abc123xyz"
```

**响应示例**

成功：
```json
{
  "success": true,
  "message": "实例删除请求已发送",
  "instanceId": "ins-abc123xyz"
}
```

失败：
```json
{
  "success": false,
  "message": "删除实例失败",
  "error": "错误详情"
}
```

---

### 4. 获取实例列表

查询当前账户下的所有云服务器实例。

**请求**
```
GET /api/instances
```

**请求示例**
```bash
curl "http://localhost:3000/api/instances"
```

**响应示例**

成功：
```json
{
  "success": true,
  "count": 2,
  "instances": [
    {
      "instanceId": "ins-abc123xyz",
      "instanceName": "my-server",
      "instanceState": "RUNNING",
      "instanceType": "S5.MEDIUM4",
      "zone": "ap-shanghai-2",
      "creationTime": "2026-02-14T10:00:00Z"
    },
    {
      "instanceId": "ins-def456uvw",
      "instanceName": "test-server",
      "instanceState": "STOPPED",
      "instanceType": "S5.LARGE8",
      "zone": "ap-shanghai-2",
      "creationTime": "2026-02-13T15:30:00Z"
    }
  ]
}
```

失败：
```json
{
  "success": false,
  "message": "获取实例列表失败",
  "error": "错误详情"
}
```

**实例状态说明**

| 状态 | 说明 |
|------|------|
| PENDING | 创建中 |
| LAUNCH_FAILED | 创建失败 |
| RUNNING | 运行中 |
| STOPPED | 已关机 |
| STARTING | 开机中 |
| STOPPING | 关机中 |
| REBOOTING | 重启中 |
| SHUTDOWN | 停止待销毁 |
| TERMINATING | 销毁中 |

---

### 5. 获取实例公网IP

查询指定实例的公网IP和内网IP地址。

**请求**
```
GET /api/instance-ip
```

**查询参数**

| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| instanceId | string | 是 | 实例ID |

**请求示例**
```bash
curl "http://localhost:3000/api/instance-ip?instanceId=ins-abc123xyz"
```

**响应示例**

成功：
```json
{
  "success": true,
  "instanceId": "ins-abc123xyz",
  "publicIp": "1.2.3.4",
  "privateIp": "10.0.0.1",
  "instanceState": "RUNNING"
}
```

**注意**：
- 如果实例未分配公网IP，`publicIp` 字段值为 `null`
- `privateIp` 为实例的内网IP地址

失败：
```json
{
  "success": false,
  "message": "获取实例IP失败",
  "error": "错误详情"
}
```

---

### 6. 获取当前实例公网IP

自动检查实例列表，如果只有一个实例且状态为运行中，返回该实例的公网IP。

**请求**
```
GET /api/get-instance-ip
```

**请求示例**
```bash
curl "http://localhost:3000/api/get-single-instance-ip"
```

**响应示例**

成功：
```json
{
  "success": true,
  "instanceId": "ins-abc123xyz",
  "instanceName": "my-server",
  "publicIp": "1.2.3.4",
  "instanceState": "RUNNING"
}
```

失败（没有实例）：
```json
{
  "success": false,
  "message": "没有实例"
}
```

失败（实例未启动）：
```json
{
  "success": false,
  "message": "实例未启动",
  "instanceId": "ins-abc123xyz",
  "instanceState": "STOPPED"
}
```

失败（多个实例）：
```json
{
  "success": false,
  "message": "错误，存在多个实例",
  "count": 2
}
```

### 7. 健康检查

检查服务是否正常运行。

**请求**
```
GET /health
```

**请求示例**
```bash
curl "http://localhost:3000/health"
```

**响应示例**
```json
{
  "status": "ok",
  "timestamp": "2026-02-14T12:00:00.000Z"
}
```

---

## 错误码说明

所有API返回的JSON包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| success | boolean | 请求是否成功 |
| message | string | 返回消息 |
| error | string | 错误详情（仅在失败时返回） |

常见的HTTP状态码：

| 状态码 | 说明 |
|--------|------|
| 200 | 请求成功 |
| 400 | 请求参数错误 |
| 500 | 服务器内部错误 |

---

## 使用示例

### 完整的工作流程示例

```bash
# 1. 通过启动模板创建实例
curl "http://localhost:3000/api/run-instance?templateId=lt-abc123&templateVersion=1"
# 响应: {"success": true, "instanceId": "ins-abc123"}

# 2. 查看实例列表，确认实例已创建
curl "http://localhost:3000/api/instances"

# 3. 等待实例启动后，获取实例的公网IP
curl "http://localhost:3000/api/instance-ip?instanceId=ins-abc123"
# 响应: {"success": true, "publicIp": "1.2.3.4", ...}

# 4. 直接获取当前实例公网IP（无需指定实例ID）
curl "http://localhost:3000/api/get-instance-ip"
# 响应: {"success": true, "publicIp": "1.2.3.4", ...}

# 5. 使用完服务器后，删除实例
curl "http://localhost:3000/api/terminate-instance?instanceId=ins-abc123"
```

---

## 注意事项

1. **API密钥安全**: 请妥善保管 `.env` 文件，不要将其提交到版本控制系统
2. **实例删除**: 删除实例是不可逆操作，请谨慎使用
3. **资源配额**: 确保您的腾讯云账户有足够的实例配额和余额
4. **启动模板**: 创建实例前需要先在腾讯云控制台创建启动模板
5. **IP分配**: 实例创建后可能需要一段时间才能分配公网IP，请耐心等待

---

## 技术栈

- **运行环境**: Node.js
- **Web框架**: Express
- **SDK**: 腾讯云 Node.js SDK (tencentcloud-sdk-nodejs)
- **配置管理**: dotenv

---

## 相关链接

- [腾讯云CVM官方文档](https://cloud.tencent.com/document/product/213)
- [腾讯云API Explorer](https://console.cloud.tencent.com/api/explorer)
- [腾讯云启动模板文档](https://cloud.tencent.com/document/product/213/45442)
