const express = require('express');
const { authenticate, checkPermission, logOperation } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getRemoteScripts, executeRemoteScript, testSshConnection } = require('../services/sshService');
const { describeInstancesList } = require('../services/cvmService');
const path = require('path');

const router = express.Router();

// 所有路由都需要认证和admin权限
router.use(authenticate);
router.use(checkPermission('admin'));

// 获取脚本列表
router.get('/scripts', async (req, res) => {
  const requestId = req.auth.requestId;
  const clientIp = getClientIp(req);

  try {
    const result = await getRemoteScripts();
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json({ success: false, message: '获取脚本列表失败' });
    }
  } catch (err) {
    await logOperation(requestId, 'GET_SCRIPTS_ERROR', clientIp, req.auth.userId, `获取脚本列表失败: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 执行脚本
router.post('/scripts/:scriptName/exec', async (req, res) => {
  const scriptName = req.params.scriptName;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;

  await logOperation(requestId, 'EXEC_SCRIPT', clientIp, req.auth.userId, `执行脚本请求: ${scriptName}`);

  try {
    const result = await executeRemoteScript(scriptName);

    await logOperation(requestId, result.success ? 'EXEC_SCRIPT_SUCCESS' : 'EXEC_SCRIPT_FAILED', clientIp, req.auth.userId, 
      `脚本 ${scriptName} 执行完成 (Code: ${result.code})`);

    res.json({
      success: result.success,
      message: result.success ? '脚本执行成功' : '脚本执行失败',
      output: result.output,
      error: result.error,
      code: result.code
    });
  } catch (err) {
    await logOperation(requestId, 'EXEC_SCRIPT_ERROR', clientIp, req.auth.userId, `脚本执行错误: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 测试 SSH 连接
router.post('/ssh/test', async (req, res) => {
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

  try {
    const result = await testSshConnection(publicIp);
    
    res.json({
      success: true,
      message: 'SSH 连接测试成功',
      output: result.output,
      ip: publicIp
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
  }
});

// 手动执行 SSH 命令
router.post('/ssh/command', async (req, res) => {
  const { command } = req.body;
  const clientIp = getClientIp(req);
  const requestId = req.auth.requestId;

  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return res.status(400).json({ success: false, message: '命令不能为空' });
  }

  await logOperation(requestId, 'EXEC_COMMAND', clientIp, req.auth.userId, `执行命令: ${command}`);

  try {
    const { executeRemoteCommand } = require('../services/sshService');
    const result = await executeRemoteCommand(command);
    
    await logOperation(requestId, result.success ? 'EXEC_COMMAND_SUCCESS' : 'EXEC_COMMAND_FAILED', clientIp, req.auth.userId, 
      `命令执行完成 (Code: ${result.code})`);

    res.json({
      success: result.success,
      message: result.success ? '执行成功' : '执行失败',
      output: result.output,
      error: result.error,
      code: result.code
    });
  } catch (err) {
    await logOperation(requestId, 'EXEC_COMMAND_ERROR', clientIp, req.auth.userId, `命令执行错误: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;