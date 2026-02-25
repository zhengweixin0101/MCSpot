const express = require('express');
const { authenticate, checkPermission, logOperation } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { sendMcCommand, getMcLogs, createLogStream, getMcServerStatus, setAfkMode, getAfkModeStatus } = require('../services/minecraftService');

const router = express.Router();

// 发送 MC 服务器命令
router.post('/mc/command', authenticate, checkPermission('admin'), async (req, res) => {
  const { command } = req.body;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;

  try {
    await logOperation(requestId, 'EXEC_MC_COMMAND', clientIp, req.auth.userId, `执行 MC 命令: ${command}`);
    
    const result = await sendMcCommand(command);
    
    res.json({ 
      success: result.success, 
      message: result.success ? '命令已发送' : '命令发送失败', 
      code: result.code 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取 MC 服务器日志 (支持流式输出)
router.get('/mc/logs', authenticate, checkPermission('admin'), async (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  const isStream = req.query.stream === 'true';

  if (isStream) {
    // 流式输出
    createLogStream(res, lines);
  } else {
    // 非流式，直接返回结果
    try {
      const result = await getMcLogs(lines, false);
      
      if (result.success) {
        res.json({ success: true, logs: result.logs });
      } else {
        res.status(500).json({ success: false, message: '读取日志失败', error: result.error });
      }
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
});

// 获取 Minecraft 服务器状态
router.get('/mc/status', authenticate, checkPermission('read_instance'), async (req, res) => {
  try {
    const result = await getMcServerStatus();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '查询服务器状态失败',
      error: error.message
    });
  }
});

// 设置/取消挂机模式
router.post('/mc/afk', authenticate, checkPermission('admin'), async (req, res) => {
  const { duration } = req.body;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;

  try {
    const result = await setAfkMode(duration);
    
    if (result.afkMode) {
      await logOperation(requestId, 'AFK_MODE_ON', clientIp, req.auth.userId, `挂机模式已开启，时长: ${duration}分钟`);
    } else {
      await logOperation(requestId, 'AFK_MODE_OFF', clientIp, req.auth.userId, '挂机模式已关闭');
    }
    
    res.json(result);
  } catch (err) {
    console.error('设置挂机模式失败:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 获取挂机模式状态
router.get('/mc/afk', authenticate, async (req, res) => {
  try {
    const result = await getAfkModeStatus();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;