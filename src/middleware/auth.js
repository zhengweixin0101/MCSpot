const redis = require('redis');
const dotenv = require('dotenv');
const { getClientIp, generateUUID } = require('../utils/helpers');

dotenv.config();

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

// 密码配置 - 支持多密码和不同权限级别
const AUTH_PASSWORDS = JSON.parse(process.env.AUTH_PASSWORDS || '{}');

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

// 密码验证中间件
const authenticate = async (req, res, next) => {
  let authHeader = req.headers.authorization;
  let authCredentials;

  // 支持 Basic Auth
  if (authHeader && authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.substring(6);
    authCredentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  }
  // 支持 Cookie (用于 Web 前端 AJAX 请求)
  else if (req.cookies.auth_username && req.cookies.auth_password) {
    authCredentials = `${req.cookies.auth_username}:${req.cookies.auth_password}`;
  }
  else {
    return res.status(401).json({
      success: false,
      message: '未提供认证信息或认证方式错误'
    });
  }

  const clientIp = getClientIp(req);
  const requestId = generateUUID();

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
  const requestId = generateUUID();
  req.auth = {
    userId,
    userName: userId,
    permissions: authConfig.permissions || [],
    requestId
  };

  next();
};

module.exports = {
  redisClient,
  AUTH_PASSWORDS,
  logOperation,
  authenticate,
  checkPermission,
  webAuth
};