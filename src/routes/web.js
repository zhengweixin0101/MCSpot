const express = require('express');
const { webAuth } = require('../middleware/auth');
const dotenv = require('dotenv');

dotenv.config();

const router = express.Router();
const PORT = process.env.PORT || 3000;

// 首页 - 返回登录页面
router.get('/', (req, res) => {
  res.render('login');
});

// 服务器控制台页面
router.get('/dashboard', webAuth, (req, res) => {
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
router.get('/terminal', webAuth, (req, res) => {
  // 简单权限检查，如果没有权限则重定向回 dashboard
  if (!req.auth.permissions.includes('admin')) {
     return res.redirect('/dashboard');
  }

  res.render('terminal', {
    title: '终端 - MCSpot',
    user: req.auth
  });
});

// API文档页面
router.get('/docs', webAuth, (req, res) => {
  res.render('docs', {
    title: 'API文档 - MCSpot',
    port: PORT,
    baseUrl: `http://localhost:${PORT}`,
    user: req.auth
  });
});

// 健康检查接口（无需认证）
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;