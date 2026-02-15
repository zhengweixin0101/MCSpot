const express = require('express');
const tencentcloud = require("tencentcloud-sdk-nodejs");
const dotenv = require('dotenv');

dotenv.config();

// 初始化 Express
const app = express();
const PORT = process.env.PORT || 3000;

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
app.get('/api/run-instance', async (req, res) => {
  const { templateId, templateVersion } = req.query;

  if (!templateId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: templateId'
    });
  }

  console.log(`创建实例请求: TemplateID=${templateId}, Version=${templateVersion || 'DEFAULT'}`);

  const result = await runInstances(templateId, templateVersion || 'DEFAULT');

  if (result.success) {
    console.log(`实例创建成功: ${result.instanceId}`);
    res.json({
      success: true,
      message: '实例创建成功',
      instanceId: result.instanceId
    });
  } else {
    console.error(`创建实例失败: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '创建实例失败',
      error: result.error
    });
  }
});

// GET 请求接口 - 启动现有实例
app.get('/api/start-instance', async (req, res) => {
  const { instanceId } = req.query;

  if (!instanceId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: instanceId'
    });
  }

  console.log(`启动实例请求: ${instanceId}`);

  try {
    await client.StartInstances({ InstanceIds: [instanceId] });
    console.log(`实例 ${instanceId} 启动请求已发送`);

    res.json({
      success: true,
      message: '实例启动请求已发送',
      instanceId
    });
  } catch (error) {
    console.error(`启动实例失败: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '启动实例失败',
      error: error.message
    });
  }
});

// GET 请求接口 - 删除实例
app.get('/api/terminate-instance', async (req, res) => {
  const { instanceId } = req.query;

  if (!instanceId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: instanceId'
    });
  }

  console.log(`删除实例请求: ${instanceId}`);

  const result = await terminateInstances([instanceId]);

  if (result.success) {
    console.log(`实例 ${instanceId} 删除请求已发送`);
    res.json({
      success: true,
      message: '实例删除请求已发送',
      instanceId
    });
  } else {
    console.error(`删除实例失败: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '删除实例失败',
      error: result.error
    });
  }
});

// GET 请求接口 - 获取实例列表
app.get('/api/instances', async (req, res) => {
  console.log('获取实例列表请求');

  const result = await describeInstancesList();

  if (result.success) {
    console.log(`查询到 ${result.instances.length} 个实例`);

    const instancesList = result.instances.map(instance => ({
      instanceId: instance.InstanceId,
      instanceName: instance.InstanceName,
      instanceState: instance.InstanceState,
      instanceType: instance.InstanceType,
      zone: instance.Placement?.Zone,
      creationTime: instance.CreatedTime
    }));

    res.json({
      success: true,
      count: instancesList.length,
      instances: instancesList
    });
  } else {
    console.error(`获取实例列表失败: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '获取实例列表失败',
      error: result.error
    });
  }
});

// GET 请求接口 - 获取实例公网IP
app.get('/api/instance-ip', async (req, res) => {
  const { instanceId } = req.query;

  if (!instanceId) {
    return res.status(400).json({
      success: false,
      message: '缺少必需参数: instanceId'
    });
  }

  console.log(`获取实例IP请求: ${instanceId}`);

  const result = await describeInstance(instanceId);

  if (result.success) {
    const instance = result.instance;
    const publicIp = instance.PublicIpAddresses && instance.PublicIpAddresses.length > 0
      ? instance.PublicIpAddresses[0]
      : null;
    const privateIp = instance.PrivateIpAddresses && instance.PrivateIpAddresses.length > 0
      ? instance.PrivateIpAddresses[0]
      : null;

    console.log(`实例 ${instanceId} 公网IP: ${publicIp || '未分配'}, 内网IP: ${privateIp}`);

    res.json({
      success: true,
      instanceId,
      publicIp,
      privateIp,
      instanceState: instance.InstanceState
    });
  } else {
    console.error(`获取实例IP失败: ${result.error}`);
    res.status(500).json({
      success: false,
      message: '获取实例IP失败',
      error: result.error
    });
  }
});

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`通过启动模板创建实例: GET /api/run-instance?templateId=<模板ID>&templateVersion=<版本号(可选)>`);
  console.log(`启动现有实例: GET /api/start-instance?instanceId=<实例ID>`);
  console.log(`删除实例: GET /api/terminate-instance?instanceId=<实例ID>`);
  console.log(`获取实例列表: GET /api/instances`);
  console.log(`获取实例公网IP: GET /api/instance-ip?instanceId=<实例ID>`);
});
