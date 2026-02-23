const express = require('express');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const tencentcloud = require("tencentcloud-sdk-nodejs");
const dotenv = require('dotenv');
const redis = require('redis');
const mcPing = require('mc-ping-updated');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

dotenv.config();

// 初始化 Express
const app = express();
const PORT = process.env.PORT || 3000;

// 设置信任代理以获取真实客户端IP
app.set('trust proxy', true);

// 辅助函数：获取真实客户端IP
function getClientIp(req) {
  // 优先从 X-Forwarded-For 获取（适用于反向代理）
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For 可能包含多个IP，第一个是客户端真实IP
    return forwarded.split(',')[0].trim();
  }
  // 其次从 X-Real-IP 获取（某些代理使用）
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return realIp;
  }
  // 最后使用 req.ip
  return req.ip || req.connection.remoteAddress || 'unknown';
}

// 使用解析JSON中间件
app.use(express.json());

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
  let authHeader = req.headers.authorization;
  let authCredentials;

  // 支持 Basic Auth
  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.substring(6);
    authCredentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  }
  else {
    return res.status(401).json({
      success: false,
      message: '未提供认证信息或认证方式错误'
    });
  }

  const clientIp = getClientIp(req);
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
  // 先输出到控制台
  console.log(`[AUTH_LOG] ${operation} | User: ${userId} | IP: ${clientIp} | ${details}`);

  try {
    const logData = {
      requestId,
      operation,
      clientIp,
      userId,
      details,
      timestamp: new Date().toISOString()
    };

    // 存储到 Redis 列表（保留最近500条日志）
    await redisClient.lPush('auth:logs', JSON.stringify(logData));
    await redisClient.lTrim('auth:logs', 0, 499);
  } catch (err) {
    console.error('记录日志到 Redis 失败:', err);
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
  const requestId = crypto.randomUUID();
  req.auth = {
    userId,
    userName: userId,
    permissions: authConfig.permissions || [],
    requestId
  };

  next();
};

// 网页登录接口 - 仅在登录页面登录时调用并记录日志（避免重复记录）
app.post('/api/web-login', async (req, res) => {
  const { username, password } = req.body;
  const clientIp = getClientIp(req);
  const requestId = crypto.randomUUID();

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: '用户名和密码不能为空'
    });
  }

  // 查找匹配的用户名和密码
  const matchedAuth = Object.entries(AUTH_PASSWORDS).find(([userId, config]) =>
    userId === username && config.password === password
  );

  if (!matchedAuth) {
    // 记录登录失败日志
    await logOperation(requestId, 'WEB_LOGIN_FAILED', clientIp, username, '用户名或密码错误');
    return res.status(401).json({
      success: false,
      message: '用户名或密码错误'
    });
  }

  const [userId, authConfig] = matchedAuth;

  // 记录登录成功日志（仅网页登录时记录）
  await logOperation(requestId, 'WEB_LOGIN', clientIp, userId, '用户登录成功');

  res.json({
    success: true,
    userId,
    userName: authConfig.name || userId,
    permissions: authConfig.permissions || []
  });
});

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

// 获取账号下唯一实例 ID
async function getUniqueInstanceId() {
  const result = await describeInstancesList();

  if (!result.success) {
    throw new Error(`获取实例列表失败: ${result.error}`);
  }

  if (result.instances.length === 0) {
    throw new Error('当前账号下没有实例');
  }

  if (result.instances.length > 1) {
    throw new Error('存在多个实例，无法自动选择唯一实例');
  }

  return result.instances[0].InstanceId;
}

// GET 请求接口 - 通过启动模板创建实例
app.get('/api/run-instance', authenticate, checkPermission('run_instance'), async (req, res) => {
  const templateId = process.env.MC_LAUNCH_TEMPLATE_ID;
  const templateVersion = process.env.MC_LAUNCH_TEMPLATE_VERSION || 'DEFAULT';

  if (!templateId) {
    return res.status(500).json({
      success: false,
      message: '服务器配置错误：未设置环境变量 MC_LAUNCH_TEMPLATE_ID'
    });
  }

  await logOperation(req.auth.requestId, 'CREATE_INSTANCE', getClientIp(req), req.auth.userId,
    `创建实例请求: TemplateID=${templateId}, Version=${templateVersion}`);

  // 检查现有实例数量
  const existingResult = await describeInstancesList();
  if (existingResult.success && existingResult.instances.length > 0) {
    await logOperation(req.auth.requestId, 'CREATE_INSTANCE_FAILED', getClientIp(req), req.auth.userId,
      `创建实例失败: 已存在${existingResult.instances.length}个实例`);
    return res.status(400).json({
      success: false,
      message: '已存在实例，无法创建。最多只允许一个实例。'
    });
  }

  const result = await runInstances(templateId, templateVersion);

  if (result.success) {
    await logOperation(req.auth.requestId, 'CREATE_INSTANCE_SUCCESS', getClientIp(req), req.auth.userId,
      `实例创建成功: ${result.instanceId}`);
    res.json({
      success: true,
      message: '实例创建成功',
      instanceId: result.instanceId
    });
  } else {
    await logOperation(req.auth.requestId, 'CREATE_INSTANCE_ERROR', getClientIp(req), req.auth.userId,
      `创建实例错误: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '创建实例失败',
      error: result.error
    });
  }
});

// GET 请求接口 - 删除实例
app.get('/api/terminate-instance', authenticate, checkPermission('terminate_instance'), async (req, res) => {
  try {
    const instanceId = await getUniqueInstanceId();

    await logOperation(req.auth.requestId, 'TERMINATE_INSTANCE', getClientIp(req), req.auth.userId,
      `删除实例请求: ${instanceId}`);

    const result = await terminateInstances([instanceId]);

    if (result.success) {
      await logOperation(req.auth.requestId, 'TERMINATE_INSTANCE_SUCCESS', getClientIp(req), req.auth.userId,
        `实例 ${instanceId} 删除请求已发送`);
      res.json({
        success: true,
        message: '实例删除请求已发送',
        instanceId
      });
    } else {
      throw new Error(result.error);
    }
  } catch (err) {
    await logOperation(req.auth.requestId, 'TERMINATE_INSTANCE_ERROR', getClientIp(req), req.auth.userId,
      err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// 辅助函数：获取 SSH 连接配置
async function getSshConfig(requestId, clientIp, userId) {
  // 获取当前实例公网 IP
  const instanceResult = await describeInstancesList();
  if (!instanceResult.success) {
    throw new Error(`获取实例信息失败: ${instanceResult.error}`);
  }

  if (instanceResult.instances.length === 0) {
    throw new Error('当前没有运行的实例，无法执行脚本');
  }

  const instance = instanceResult.instances[0];
  let publicIp = null;

  if (instance.PublicIpAddresses && instance.PublicIpAddresses.length > 0) {
    publicIp = instance.PublicIpAddresses[0];
  } else if (instance.PublicIpAddress && instance.PublicIpAddress.length > 0) {
    publicIp = instance.PublicIpAddress[0];
  }

  if (!publicIp) {
    throw new Error('实例未分配公网 IP，无法连接');
  }

  const config = {
    host: publicIp,
    port: parseInt(process.env.SSH_PORT || '22'),
    username: process.env.SSH_USERNAME || 'root',
    readyTimeout: 10000 // 10秒超时
  };

  try {
    if (process.env.SSH_PRIVATE_KEY) {
      config.privateKey = process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n');
    } else if (process.env.SSH_PRIVATE_KEY_PATH) {
      config.privateKey = fs.readFileSync(process.env.SSH_PRIVATE_KEY_PATH);
    } else if (process.env.SSH_PASSWORD) {
      config.password = process.env.SSH_PASSWORD;
    } else {
      throw new Error('SSH 认证信息未配置');
    }
  } catch (err) {
    throw new Error('读取 SSH 私钥失败: ' + err.message);
  }

  return { config, publicIp };
}

// 获取脚本列表
app.get('/api/scripts', authenticate, checkPermission('run_ssh'), async (req, res) => {
  const requestId = req.auth.requestId;
  const clientIp = getClientIp(req);
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';
  const localScriptsPath = path.join(__dirname, 'sh', 'scripts.json');

  try {
    const { config } = await getSshConfig(requestId, clientIp, req.auth.userId);
    const conn = new Client();

    conn.on('ready', () => {
      // 尝试读取远程 scripts.json
      const scriptsJsonPath = path.posix.join(remotePath, 'scripts.json');
      conn.exec(`cat "${scriptsJsonPath}"`, (err, stream) => {
        if (err) {
          conn.end();
          return res.status(500).json({ success: false, message: 'SSH 执行错误', error: err.message });
        }

        let jsonOutput = '';
        stream.on('close', (code, signal) => {
          if (code === 0) {
            // 成功读取到 scripts.json
            try {
              const scripts = JSON.parse(jsonOutput);
              conn.end();
              return res.json({ success: true, scripts });
            } catch (parseErr) {
              console.warn(`[WARN] 远程 scripts.json 解析失败: ${parseErr.message}`);
              // 解析失败，继续执行 ls
            }
          } 
          
          // 读取失败或解析失败，降级为 ls 列出 .sh 文件
          conn.exec(`ls -1 ${remotePath}/*.sh`, (err, stream) => {
             if (err) {
               conn.end();
               return res.status(500).json({ success: false, message: '列出脚本失败', error: err.message });
             }

             let output = '';
             stream.on('close', (code, signal) => {
               conn.end();
               if (code !== 0) {
                  return res.json({ success: true, scripts: [] });
               }
               const files = output.trim().split('\n')
                 .map(line => {
                   const fileName = path.basename(line.trim());
                   return { name: fileName, script: fileName };
                 })
                 .filter(item => item.script && item.script.endsWith('.sh'));
               res.json({ success: true, scripts: files });
             }).on('data', (data) => {
               output += data.toString();
             });
          });

        }).on('data', (data) => {
          jsonOutput += data.toString();
        }).stderr.on('data', () => {});
      });
    }).on('error', (err) => {
      res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
    }).connect(config);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 执行脚本
app.post('/api/scripts/:scriptName/exec', authenticate, checkPermission('run_ssh'), async (req, res) => {
  const scriptName = req.params.scriptName;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';

  // 安全检查：防止路径遍历
  if (scriptName.includes('..') || scriptName.includes('/') || scriptName.includes('\\')) {
    await logOperation(requestId, 'EXEC_SCRIPT_FAILED', clientIp, req.auth.userId, `无效的脚本名称: ${scriptName}`);
    return res.status(400).json({ success: false, message: '无效的脚本名称' });
  }

  await logOperation(requestId, 'EXEC_SCRIPT', clientIp, req.auth.userId, `执行脚本请求: ${scriptName}`);

  try {
    const { config, publicIp } = await getSshConfig(requestId, clientIp, req.auth.userId);
    const conn = new Client();
    
    // 构建远程命令：直接执行远程脚本
    const remoteCommand = `bash ${remotePath}/${scriptName}`;

    conn.on('ready', () => {
      conn.exec(remoteCommand, (err, stream) => {
        if (err) {
          conn.end();
          logOperation(requestId, 'EXEC_SCRIPT_ERROR', clientIp, req.auth.userId, `SSH 执行错误: ${err.message}`);
          return res.status(500).json({ success: false, message: 'SSH 执行错误', error: err.message });
        }

        let output = '';
        let errorOutput = '';

        stream.on('close', (code, signal) => {
          conn.end();
          const success = code === 0;
          
          logOperation(requestId, success ? 'EXEC_SCRIPT_SUCCESS' : 'EXEC_SCRIPT_FAILED', clientIp, req.auth.userId, 
            `脚本 ${scriptName} 执行完成 (Code: ${code})`);

          res.json({
            success,
            message: success ? '脚本执行成功' : '脚本执行失败',
            output: output,
            error: errorOutput,
            code
          });
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    }).on('error', (err) => {
      logOperation(requestId, 'EXEC_SCRIPT_ERROR', clientIp, req.auth.userId, `SSH 连接错误: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
      }
    }).connect(config);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 测试 SSH 连接
app.post('/api/ssh/test', authenticate, checkPermission('run_ssh'), async (req, res) => {
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;

  // 获取当前实例公网 IP
  const instanceResult = await describeInstancesList();
  if (!instanceResult.success) {
    return res.status(500).json({ success: false, message: '获取实例信息失败', error: instanceResult.error });
  }

  if (instanceResult.instances.length === 0) {
    return res.status(404).json({ success: false, message: '当前没有运行的实例，无法测试连接' });
  }

  const instance = instanceResult.instances[0];
  let publicIp = null;

  if (instance.PublicIpAddresses && instance.PublicIpAddresses.length > 0) {
    publicIp = instance.PublicIpAddresses[0];
  } else if (instance.PublicIpAddress && instance.PublicIpAddress.length > 0) {
    publicIp = instance.PublicIpAddress[0];
  }

  if (!publicIp) {
    return res.status(500).json({ success: false, message: '实例未分配公网 IP，无法连接' });
  }

  const conn = new Client();
  const config = {
    host: publicIp,
    port: parseInt(process.env.SSH_PORT || '22'),
    username: process.env.SSH_USERNAME || 'root',
    readyTimeout: 10000 // 10秒超时
  };

  try {
    if (process.env.SSH_PRIVATE_KEY) {
      // 处理环境变量中的换行符
      config.privateKey = process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n');
    } else if (process.env.SSH_PRIVATE_KEY_PATH) {
      config.privateKey = fs.readFileSync(process.env.SSH_PRIVATE_KEY_PATH);
    } else if (process.env.SSH_PASSWORD) {
      config.password = process.env.SSH_PASSWORD;
    } else {
      return res.status(500).json({ success: false, message: 'SSH 认证信息未配置' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: '读取 SSH 私钥失败: ' + err.message });
  }

  conn.on('ready', () => {
    conn.exec('echo "SSH Connection OK" && uptime', (err, stream) => {
      if (err) {
        conn.end();
        return res.status(500).json({ success: false, message: 'SSH 连接成功但执行测试命令失败', error: err.message });
      }

      let output = '';
      stream.on('close', (code, signal) => {
        conn.end();
        res.json({
          success: true,
          message: 'SSH 连接测试成功',
          output: output.trim(),
          ip: publicIp
        });
      }).on('data', (data) => {
        output += data.toString();
      }).stderr.on('data', (data) => {
        // 忽略 stderr
      });
    });
  }).on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
    }
  }).connect(config);
});

// 手动执行 SSH 命令
app.post('/api/ssh/command', authenticate, checkPermission('run_ssh'), async (req, res) => {
  const { command } = req.body;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;

  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return res.status(400).json({ success: false, message: '命令不能为空' });
  }

  await logOperation(requestId, 'EXEC_COMMAND', clientIp, req.auth.userId, `执行命令: ${command}`);

  try {
    const { config } = await getSshConfig(requestId, clientIp, req.auth.userId);
    const conn = new Client();

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          logOperation(requestId, 'EXEC_COMMAND_ERROR', clientIp, req.auth.userId, `SSH 执行错误: ${err.message}`);
          return res.status(500).json({ success: false, message: 'SSH 执行错误', error: err.message });
        }

        let output = '';
        let errorOutput = '';

        stream.on('close', (code, signal) => {
          conn.end();
          const success = code === 0;
          
          logOperation(requestId, success ? 'EXEC_COMMAND_SUCCESS' : 'EXEC_COMMAND_FAILED', clientIp, req.auth.userId, 
            `命令执行完成 (Code: ${code})`);

          res.json({
            success,
            message: success ? '执行成功' : '执行失败',
            output: output,
            error: errorOutput,
            code
          });
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    }).on('error', (err) => {
      logOperation(requestId, 'EXEC_COMMAND_ERROR', clientIp, req.auth.userId, `SSH 连接错误: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
      }
    }).connect(config);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 发送 MC 服务器命令
app.post('/api/mc/command', authenticate, checkPermission('run_ssh'), async (req, res) => {
  const { command } = req.body;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';

  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return res.status(400).json({ success: false, message: '命令不能为空' });
  }

  // 简单的命令清理，防止注入
  const safeCommand = command.replace(/"/g, '\\"');

  await logOperation(requestId, 'EXEC_MC_COMMAND', clientIp, req.auth.userId, `执行 MC 命令: ${command}`);

  try {
    const { config } = await getSshConfig(requestId, clientIp, req.auth.userId);
    const conn = new Client();

    conn.on('ready', () => {
      // 从 .env 加载配置并发送命令到 screen 会话
      const cmd = `source ${remotePath}/.env && screen -S "$SCREEN_NAME" -p 0 -X stuff "${safeCommand}\\r"`;
      
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return res.status(500).json({ success: false, message: 'SSH 执行错误', error: err.message });
        }

        stream.on('close', (code, signal) => {
          conn.end();
          const success = code === 0;
          res.json({ success, message: success ? '命令已发送' : '命令发送失败', code });
        }).on('data', () => {}).stderr.on('data', () => {});
      });
    }).on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
      }
    }).connect(config);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取 MC 服务器日志 (支持流式输出)
app.get('/api/mc/logs', authenticate, checkPermission('run_ssh'), async (req, res) => {
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;
  const lines = parseInt(req.query.lines) || 100;
  const isStream = req.query.stream === 'true';
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';

  try {
    const { config } = await getSshConfig(requestId, clientIp, req.auth.userId);
    const conn = new Client();

    // 如果是流式请求，设置 SSE 头部
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }

    conn.on('ready', () => {
      // 构造命令
      let cmd;
      if (isStream) {
        // 流式：先输出最后 N 行，然后持续跟踪
        // 使用 tail -f -n N
        cmd = `source ${remotePath}/.env && tail -f -n ${lines} "$MCS_DIR/logs/latest.log"`;
      } else {
        // 非流式：只输出最后 N 行
        cmd = `source ${remotePath}/.env && tail -n ${lines} "$MCS_DIR/logs/latest.log"`;
      }
      
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          if (isStream) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: 'SSH 执行错误', error: err.message })}\n\n`);
            res.end();
          } else {
            return res.status(500).json({ success: false, message: 'SSH 执行错误', error: err.message });
          }
          return;
        }

        let output = '';
        let errorOutput = '';

        stream.on('close', (code, signal) => {
          conn.end();
          if (!isStream) {
            if (code === 0) {
              res.json({ success: true, logs: output });
            } else {
              res.status(500).json({ success: false, message: '读取日志失败', error: errorOutput });
            }
          } else {
            res.end(); // 关闭 SSE 连接
          }
        }).on('data', (data) => {
          if (isStream) {
            // 将数据分行处理，逐行发送
            const lines = data.toString().split('\n');
            lines.forEach(line => {
              if (line) {
                 res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
              }
            });
          } else {
            output += data.toString();
          }
        }).stderr.on('data', (data) => {
           if (isStream) {
             // 错误流也发送到前端显示
             res.write(`event: stderr\ndata: ${JSON.stringify({ log: data.toString() })}\n\n`);
           } else {
             errorOutput += data.toString();
           }
        });

        // 客户端断开连接时，关闭 SSH 连接
        if (isStream) {
          req.on('close', () => {
             console.log('Client closed SSE connection, closing SSH...');
             conn.end();
          });
        }
      });
    }).on('error', (err) => {
      if (!res.headersSent) {
         if (isStream) {
             // 还没发送头部，发送 JSON 错误
             res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
         } else {
             res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
         }
      } else if (isStream) {
          // 已经发送头部，发送 SSE 错误事件
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'SSH 连接中断', error: err.message })}\n\n`);
          res.end();
      }
    }).connect(config);

  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
});

// GET 请求接口 - 获取实例列表
app.get('/api/instances', authenticate, checkPermission('read_instance'), async (req, res) => {
  const result = await describeInstancesList();

  if (result.success) {
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
    await logOperation(req.auth.requestId, 'LIST_INSTANCES_ERROR', getClientIp(req), req.auth.userId,
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
  const { limit = 500 } = req.query;

  try {
    const logs = await redisClient.lRange('auth:logs', 0, parseInt(limit) - 1);
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

// 获取 Minecraft 服务器状态
app.get('/api/mc/status', authenticate, checkPermission('read_instance'), async (req, res) => {
  try {
    // 获取当前实例
    const result = await describeInstancesList();

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: '获取实例失败',
        error: result.error
      });
    }

    if (result.instances.length === 0) {
      return res.json({
        success: true,
        running: false,
        message: '当前没有实例'
      });
    }

    const instance = result.instances[0];

    // 判断实例状态
    if (instance.InstanceState !== 'RUNNING') {
      return res.json({
        success: true,
        running: false,
        instanceState: instance.InstanceState,
        message: '实例未运行'
      });
    }

    // 获取公网 IP
    let publicIp = null;

    if (instance.PublicIpAddresses && instance.PublicIpAddresses.length > 0) {
      publicIp = instance.PublicIpAddresses[0];
    } else if (instance.PublicIpAddress && instance.PublicIpAddress.length > 0) {
      publicIp = instance.PublicIpAddress[0];
    }

    if (!publicIp) {
      return res.json({
        success: true,
        running: true,
        mcOnline: false,
        message: '实例运行中，但未分配公网IP'
      });
    }

    const port = parseInt(process.env.MC_PORT || '25565');

    // Promise 包装 mc-ping-updated
    const mcPingAsync = (host, port) => {
      return new Promise((resolve, reject) => {
        mcPing(host, port, (err, data) => {
          if (err) return reject(err);
          resolve(data);
        });
      });
    };

    let data;
    try {
      data = await mcPingAsync(publicIp, port);
    } catch (err) {
      return res.json({
        success: true,
        running: true,
        mcOnline: false,
        ip: publicIp,
        port,
        message: '实例运行中，但Minecraft服务未响应',
        error: err.message
      });
    }

    // 兼容各种 MOTD 结构
    let motd = '';
    if (typeof data.description === 'string') {
      motd = data.description;
    } else if (data.description?.text) {
      motd = data.description.text;
    } else if (Array.isArray(data.description?.extra)) {
      motd = data.description.extra.map(e => e.text || '').join('');
    }

    // 玩家列表
    const playerList = (data.players?.sample || []).map(p => ({
      name: p.name || '',
      uuid: p.id || ''
    }));

    // 返回最终状态
    return res.json({
      success: true,
      running: true,
      mcOnline: true,
      ip: publicIp,
      port,
      playersOnline: data.players?.online || 0,
      playersMax: data.players?.max || 0,
      playerList,
      version: data.version?.name || '',
      motd
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: '查询服务器状态失败',
      error: error.message
    });
  }
});

// 首页 - 返回登录页面
app.get('/', (req, res) => {
  res.render('login');
});

// 服务器控制台页面
app.get('/dashboard', webAuth, (req, res) => {
  res.render('dashboard', {
    title: '控制台 - MCSpot',
    port: PORT,
    baseUrl: `http://localhost:${PORT}`,
    user: req.auth,
    mcConfig: {
      port: process.env.MC_PORT || 25565,
      version: process.env.MC_VERSION || '未设置'
    }
  });
});

// 终端页面
app.get('/terminal', webAuth, (req, res) => {
  // 简单权限检查，如果没有权限则重定向回 dashboard
  if (!req.auth.permissions.includes('run_ssh') && !req.auth.permissions.includes('admin')) {
     return res.redirect('/dashboard');
  }

  res.render('terminal', {
    title: '终端 - MCSpot',
    user: req.auth
  });
});


// API文档页面
app.get('/docs', webAuth, (req, res) => {
  res.render('docs', {
    title: 'API文档 - MCSpot',
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
  console.log(`MCSpot - Minecraft 服务器按需启动工具`);
  console.log(``);
  console.log(`服务运行在 http://localhost:${PORT}`);
  console.log(`========================================`);
});
