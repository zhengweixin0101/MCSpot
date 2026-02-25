const express = require('express');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

// 导入路由
const authRoutes = require('./routes/auth');
const instanceRoutes = require('./routes/instance');
const scriptRoutes = require('./routes/script');
const minecraftRoutes = require('./routes/minecraft');
const storageRoutes = require('./routes/storage');
const webRoutes = require('./routes/web');

// 导入中间件
const { authenticate } = require('./middleware/auth');

dotenv.config();

// 初始化 Express
const app = express();
const PORT = process.env.PORT || 3000;

// 设置信任代理以获取真实客户端IP
app.set('trust proxy', true);

// 使用解析JSON中间件
app.use(express.json());

// 使用cookie中间件
app.use(cookieParser());

// 设置视图引擎
app.set('view engine', 'ejs');
app.set('views', __dirname + '/../views');

// API 路由
app.use('/api', authRoutes);
app.use('/api', instanceRoutes);
app.use('/api', scriptRoutes);
app.use('/api', minecraftRoutes);
app.use('/api', storageRoutes);

// Web 页面路由
app.use('/', webRoutes);

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: '接口不存在'
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('应用错误:', err);
  res.status(500).json({
    success: false,
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

module.exports = app;