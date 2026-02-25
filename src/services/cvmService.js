const tencentcloud = require("tencentcloud-sdk-nodejs");
const dotenv = require('dotenv');

dotenv.config();

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

// 获取实例详细信息
function getInstanceDetails(instance) {
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
}

module.exports = {
  runInstances,
  terminateInstances,
  describeInstancesList,
  getUniqueInstanceId,
  getInstanceDetails
};