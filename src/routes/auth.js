const express = require('express');
const { logOperation, redisClient, webAuth } = require('../middleware/auth');
const { getClientIp, generateUUID } = require('../utils/helpers');
const { AUTH_PASSWORDS } = require('../middleware/auth');
const router = express.Router();

// 网页登录接口 - 仅在登录页面登录时调用并记录日志（避免重复记录）
router.post('/web-login', async (req, res) => {
  const { username, password } = req.body;
  const clientIp = getClientIp(req);
  const requestId = generateUUID();

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

// 获取用户信息接口
router.get('/user-info', (req, res) => {
  const userConfig = AUTH_PASSWORDS[req.auth.userId];
  res.json({
    success: true,
    userId: req.auth.userId,
    userName: userConfig?.name || req.auth.userId,
    permissions: req.auth.permissions
  });
});

// 获取操作日志接口（需要 admin 权限）
router.get('/auth-logs', async (req, res) => {
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

module.exports = router;