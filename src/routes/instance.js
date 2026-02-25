const express = require('express');
const { authenticate, checkPermission, logOperation } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { runInstances, terminateInstances, describeInstancesList, getUniqueInstanceId, getInstanceDetails } = require('../services/cvmService');
const dotenv = require('dotenv');

dotenv.config();

const router = express.Router();

// 所有路由都需要认证
router.use(authenticate);

// GET 请求接口 - 通过启动模板创建实例
router.get('/run-instance', checkPermission('run_instance'), async (req, res) => {
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
router.get('/terminate-instance', checkPermission('terminate_instance'), async (req, res) => {
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

// GET 请求接口 - 获取实例列表
router.get('/instances', checkPermission('read_instance'), async (req, res) => {
  const result = await describeInstancesList();

  if (result.success) {
    const instancesList = result.instances.map(instance => getInstanceDetails(instance));

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

module.exports = router;