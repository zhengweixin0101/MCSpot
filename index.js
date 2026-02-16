const express = require('express');
const tencentcloud = require("tencentcloud-sdk-nodejs");
const dotenv = require('dotenv');
const redis = require('redis');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

dotenv.config();

// 初始化 Express
const app = express();
const PORT = process.env.PORT || 3000;

// 使用cookie中间件
app.use(cookieParser());

// 设置视图引擎
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// 初始化 Redis 客户端
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  password: process.env.REDIS_PASSWORD || undefined
});

redisClient.on('error', (err) => {
  console.error('Redis 连接错误:', err);
});

// 连接 Redis
redisClient.connect().catch(err => {
  console.error('Redis 连接失败:', err);
});

// 腾讯云 CVM 客户端
const CvmClient = tencentcloud.cvm.v20170312.Client;

// 获取配置
const clientConfig = {
  credential: {
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY,
  },
  region: process.env.TENCENT_REGION || "ap-shanghai",
  profile: {
    httpProfile: {
      endpoint: "cvm.tencentcloudapi.com",
    },
  },
};

// 创建客户端实例
const client = new CvmClient(clientConfig);

// 密码配置 - 支持多密码和不同权限级别
const AUTH_PASSWORDS = JSON.parse(process.env.AUTH_PASSWORDS || '{}');

// 密码验证中间件
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: '未提供认证信息'
    });
  }

  const authCredentials = authHeader.substring(7);
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const requestId = crypto.randomUUID();

  // 检查 IP 是否被锁定
  const lockoutKey = `auth:lockout:${clientIp}`;
  const isLocked = await redisClient.get(lockoutKey);

  if (isLocked) {
    await logOperation(requestId, 'AUTH_LOCKED', clientIp, 'unknown', `IP已锁定，认证被拒绝`);
    return res.status(429).json({
      success: false,
      message: '认证尝试次数过多，请稍后再试'
    });
  }

  // 验证 username:password 格式并提取用户名和密码
  if (!authCredentials.includes(':')) {
    await logOperation(requestId, 'AUTH_FAILED', clientIp, 'unknown', `认证格式错误：缺少冒号分隔符`);
    return res.status(401).json({
      success: false,
      message: '认证格式错误，必须使用 username:password 格式'
    });
  }

  const colonIndex = authCredentials.indexOf(':');
  const username = authCredentials.substring(0, colonIndex);
  const password = authCredentials.substring(colonIndex + 1);

  // 查找匹配的用户名和密码
  const matchedAuth = Object.entries(AUTH_PASSWORDS).find(([userId, config]) =>
    userId === username && config.password === password
  );

  if (!matchedAuth) {
    // 增加失败计数
    const failKey = `auth:failed:${clientIp}`;
    const failedCount = await redisClient.incr(failKey);
    await redisClient.expire(failKey, 300); // 5分钟过期

    // 超过最大尝试次数则锁定 IP
    const maxAttempts = parseInt(process.env.MAX_AUTH_ATTEMPTS || '5');
    if (failedCount >= maxAttempts) {
      await redisClient.set(lockoutKey, 'locked');
      await redisClient.expire(lockoutKey, 900); // 锁定15分钟
      await logOperation(requestId, 'AUTH_LOCKED', clientIp, username, `IP被锁定（失败${failedCount}次）`);
      return res.status(429).json({
        success: false,
        message: `认证失败次数过多，IP已被锁定15分钟`
      });
    }

    const remainingAttempts = maxAttempts - failedCount;
    await logOperation(requestId, 'AUTH_FAILED', clientIp, username, `用户名或密码错误（剩余${remainingAttempts}次）`);

    return res.status(401).json({
      success: false,
      message: `用户名或密码错误，剩余尝试次数：${remainingAttempts}`
    });
  }

  const [userId, authConfig] = matchedAuth;

  // 清除失败计数
  const failKey = `auth:failed:${clientIp}`;
  await redisClient.del(failKey);

  // 将用户信息附加到请求对象
  req.auth = {
    userId,
    userName: userId,
    permissions: authConfig.permissions || [],
    requestId
  };

  next();
};

// 记录操作日志到 Redis
async function logOperation(requestId, operation, clientIp, userId, details) {
  try {
    const logData = {
      requestId,
      operation,
      clientIp,
      userId,
      details,
      timestamp: new Date().toISOString()
    };

    // 存储到 Redis 列表（保留最近1000条日志）
    await redisClient.lPush('auth:logs', JSON.stringify(logData));
    await redisClient.lTrim('auth:logs', 0, 999);

    // 为每个用户单独记录日志（保留最近100条）
    if (userId !== 'unknown') {
      await redisClient.lPush(`auth:user:${userId}:logs`, JSON.stringify(logData));
      await redisClient.lTrim(`auth:user:${userId}:logs`, 0, 99);
    }

    console.log(`[AUTH_LOG] ${operation} | User: ${userId} | IP: ${clientIp} | ${details}`);
  } catch (err) {
    console.error('记录日志失败:', err);
  }
}

// 权限验证中间件
const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({
        success: false,
        message: '未认证'
      });
    }

    if (req.auth.permissions.includes('admin')) {
      // admin 拥有所有权限
      next();
      return;
    }

    if (!req.auth.permissions.includes(requiredPermission)) {
      return res.status(403).json({
        success: false,
        message: `缺少所需权限: ${requiredPermission}`
      });
    }

    next();
  };
};

// 网页会话验证中间件（用于渲染EJS页面）
const webAuth = (req, res, next) => {
  // 从cookie中读取用户名和密码
  const cookieUsername = req.cookies.auth_username;
  const cookiePassword = req.cookies.auth_password;
  const authHeader = req.headers.authorization;
  let username = null;
  let password = null;

  if (cookieUsername && cookiePassword) {
    // 从cookie读取用户名和密码
    username = cookieUsername;
    password = cookiePassword;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    // 从authorization header读取 username:password 格式
    const authCredentials = authHeader.substring(7);
    if (!authCredentials.includes(':')) {
      // 认证格式错误
      return res.redirect('/');
    }
    const colonIndex = authCredentials.indexOf(':');
    username = authCredentials.substring(0, colonIndex);
    password = authCredentials.substring(colonIndex + 1);
  }

  if (!username || !password) {
    // 对于网页访问，如果没有认证信息，重定向到登录页
    return res.redirect('/');
  }

  // 查找匹配的用户名和密码
  const matchedAuth = Object.entries(AUTH_PASSWORDS).find(([userId, config]) =>
    userId === username && config.password === password
  );

  if (!matchedAuth) {
    // 用户名或密码错误，清除cookie并重定向到登录页
    res.clearCookie('auth_username');
    res.clearCookie('auth_password');
    return res.redirect('/');
  }

  const [userId, authConfig] = matchedAuth;

  // 将用户信息附加到请求对象
  req.auth = {
    userId,
    userName: userId,
    permissions: authConfig.permissions || [],
    requestId: crypto.randomUUID()
  };

  next();
};

// 通过启动模板创建实例函数
async function runInstances(launchTemplateId, launchTemplateVersion) {
  const params = {
    LaunchTemplate: {
      LaunchTemplateId: launchTemplateId,
    },
    InstanceCount: 1,
  };

  if (launchTemplateVersion && launchTemplateVersion !== 'DEFAULT') {
    params.LaunchTemplate.LaunchTemplateVersion = parseInt(launchTemplateVersion);
  }

  try {
    const response = await client.RunInstances(params);
    return {
      success: true,
      instanceId: response.InstanceIdSet[0]
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// 删除实例函数
async function terminateInstances(instanceIds) {
  const params = {
    InstanceIds: instanceIds,
  };

  try {
    await client.TerminateInstances(params);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// 获取实例列表函数
async function describeInstancesList() {
  try {
    const response = await client.DescribeInstances({});
    return {
      success: true,
      instances: response.InstanceSet || []
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// 获取实例详细信息函数
async function describeInstance(instanceId) {
  try {
    const response = await client.DescribeInstances({
      InstanceIds: [instanceId]
    });
    if (response.InstanceSet && response.InstanceSet.length > 0) {
      return {
        success: true,
        instance: response.InstanceSet[0]
      };
    }
    return {
      success: false,
      error: '实例不存在'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// GET 请求接口 - 通过启动模板创建实例
app.get('/api/run-instance', authenticate, checkPermission('run_instance'), async (req, res) => {
  const { templateId, templateVersion } = req.query;

  if (!templateId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: templateId'
    });
  }

  await logOperation(req.auth.requestId, 'CREATE_INSTANCE', req.ip, req.auth.userId,
    `创建实例请求: TemplateID=${templateId}, Version=${templateVersion || 'DEFAULT'}`);

  // 检查现有实例数量
  const existingResult = await describeInstancesList();
  if (existingResult.success && existingResult.instances.length > 0) {
    await logOperation(req.auth.requestId, 'CREATE_INSTANCE_FAILED', req.ip, req.auth.userId,
      `创建实例失败: 已存在${existingResult.instances.length}个实例`);
    return res.status(400).json({
      success: false,
      message: '已存在实例，无法创建。最多只允许一个实例。'
    });
  }

  const result = await runInstances(templateId, templateVersion || 'DEFAULT');

  if (result.success) {
    await logOperation(req.auth.requestId, 'CREATE_INSTANCE_SUCCESS', req.ip, req.auth.userId,
      `实例创建成功: ${result.instanceId}`);
    res.json({
      success: true,
      message: '实例创建成功',
      instanceId: result.instanceId
    });
  } else {
    await logOperation(req.auth.requestId, 'CREATE_INSTANCE_ERROR', req.ip, req.auth.userId,
      `创建实例错误: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '创建实例失败',
      error: result.error
    });
  }
});

// GET 请求接口 - 启动现有实例
app.get('/api/start-instance', authenticate, checkPermission('start_instance'), async (req, res) => {
  const { instanceId } = req.query;

  if (!instanceId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: instanceId'
    });
  }

  await logOperation(req.auth.requestId, 'START_INSTANCE', req.ip, req.auth.userId,
    `启动实例请求: ${instanceId}`);

  try {
    await client.StartInstances({ InstanceIds: [instanceId] });
    await logOperation(req.auth.requestId, 'START_INSTANCE_SUCCESS', req.ip, req.auth.userId,
      `实例 ${instanceId} 启动请求已发送`);

    res.json({
      success: true,
      message: '实例启动请求已发送',
      instanceId
    });
  } catch (error) {
    await logOperation(req.auth.requestId, 'START_INSTANCE_ERROR', req.ip, req.auth.userId,
      `启动实例错误: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '启动实例失败',
      error: error.message
    });
  }
});

// GET 请求接口 - 删除实例
app.get('/api/terminate-instance', authenticate, checkPermission('terminate_instance'), async (req, res) => {
  const { instanceId } = req.query;

  if (!instanceId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: instanceId'
    });
  }

  await logOperation(req.auth.requestId, 'TERMINATE_INSTANCE', req.ip, req.auth.userId,
    `删除实例请求: ${instanceId}`);

  const result = await terminateInstances([instanceId]);

  if (result.success) {
    await logOperation(req.auth.requestId, 'TERMINATE_INSTANCE_SUCCESS', req.ip, req.auth.userId,
      `实例 ${instanceId} 删除请求已发送`);
    res.json({
      success: true,
      message: '实例删除请求已发送',
      instanceId
    });
  } else {
    await logOperation(req.auth.requestId, 'TERMINATE_INSTANCE_ERROR', req.ip, req.auth.userId,
      `删除实例错误: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '删除实例失败',
      error: result.error
    });
  }
});

// GET 请求接口 - 获取实例列表
app.get('/api/instances', authenticate, checkPermission('read_instance'), async (req, res) => {
  await logOperation(req.auth.requestId, 'LIST_INSTANCES', req.ip, req.auth.userId,
    '获取实例列表请求');

  const result = await describeInstancesList();

  if (result.success) {
    await logOperation(req.auth.requestId, 'LIST_INSTANCES_SUCCESS', req.ip, req.auth.userId,
      `查询到 ${result.instances.length} 个实例`);

    const instancesList = result.instances.map(instance => {
      // 尝试多种路径获取公网IP
      let publicIp = null;
      let privateIp = null;

      if (instance.PublicIpAddresses && instance.PublicIpAddresses.length > 0) {
        publicIp = instance.PublicIpAddresses[0];
      } else if (instance.PublicIpAddress && instance.PublicIpAddress.length > 0) {
        publicIp = instance.PublicIpAddress[0];
      }

      if (instance.PrivateIpAddresses && instance.PrivateIpAddresses.length > 0) {
        privateIp = instance.PrivateIpAddresses[0];
      } else if (instance.PrivateIpAddress && instance.PrivateIpAddress.length > 0) {
        privateIp = instance.PrivateIpAddress[0];
      } else if (instance.VpcId && instance.VirtualPrivateCloud?.PrivateIpAddresses) {
        privateIp = instance.VirtualPrivateCloud.PrivateIpAddresses[0];
      }

      return {
        instanceId: instance.InstanceId,
        instanceName: instance.InstanceName,
        instanceState: instance.InstanceState,
        instanceType: instance.InstanceType,
        zone: instance.Placement?.Zone,
        creationTime: instance.CreatedTime,
        publicIp: publicIp,
        privateIp: privateIp
      };
    });

    res.json({
      success: true,
      count: instancesList.length,
      instances: instancesList
    });
  } else {
    await logOperation(req.auth.requestId, 'LIST_INSTANCES_ERROR', req.ip, req.auth.userId,
      `获取实例列表错误: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '获取实例列表失败',
      error: result.error
    });
  }
});

// 获取操作日志接口（需要 admin 权限）
app.get('/api/auth-logs', authenticate, checkPermission('admin'), async (req, res) => {
  const { userId, limit = 50 } = req.query;

  try {
    let logs;
    if (userId) {
      logs = await redisClient.lRange(`auth:user:${userId}:logs`, 0, parseInt(limit) - 1);
    } else {
      logs = await redisClient.lRange('auth:logs', 0, parseInt(limit) - 1);
    }

    const parsedLogs = logs.map(log => JSON.parse(log));

    res.json({
      success: true,
      count: parsedLogs.length,
      logs: parsedLogs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取日志失败',
      error: error.message
    });
  }
});

// 获取用户信息接口
app.get('/api/user-info', authenticate, async (req, res) => {
  const userConfig = AUTH_PASSWORDS[req.auth.userId];
  res.json({
    success: true,
    userId: req.auth.userId,
    userName: userConfig?.name || req.auth.userId,
    permissions: req.auth.permissions
  });
});

// 首页 - 返回登录页面
app.get('/', (req, res) => {
  res.render('login');
});

// 服务器控制台页面
app.get('/dashboard', webAuth, (req, res) => {
  res.render('index', {
    title: '控制台 - MCSG based on Tencent Cloud',
    port: PORT,
    baseUrl: `http://localhost:${PORT}`,
    user: req.auth,
    mcConfig: {
      launchTemplateId: process.env.MC_LAUNCH_TEMPLATE_ID,
      port: process.env.MC_PORT || 25565
    }
  });
});

// API文档页面
app.get('/docs', webAuth, (req, res) => {
  res.render('docs', {
    title: 'API文档 - MCSG based on Tencent Cloud',
    port: PORT,
    baseUrl: `http://localhost:${PORT}`,
    user: req.auth
  });
});

// 健康检查接口（无需认证）
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`MCSG - Minecraft服务器快速启动工具`);
  console.log(`========================================`);
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(``);
  console.log(`认证说明: 所有 API 接口需要在请求头中添加 Authorization: Bearer <username:password>`);
  console.log(``);
  console.log(`API 接口列表:`);
  console.log(`  通过启动模板创建实例: GET /api/run-instance?templateId=<模板ID>&templateVersion=<版本号(可选)> [权限: run_instance]`);
  console.log(`  启动现有实例: GET /api/start-instance?instanceId=<实例ID> [权限: start_instance]`);
  console.log(`  删除实例: GET /api/terminate-instance?instanceId=<实例ID> [权限: terminate_instance]`);
  console.log(`  获取实例列表: GET /api/instances [权限: read_instance]`);
  console.log(`  获取操作日志: GET /api/auth-logs?userId=<用户ID(可选)>&limit=<数量> [权限: admin]`);
  console.log(`  获取用户信息: GET /api/user-info [权限: 任意]`);
  console.log(`  健康检查: GET /health [无需认证]`);
  console.log(`========================================`);
});
