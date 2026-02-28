const { sshPool } = require('./sshConnectionPool');
const fs = require('fs');
const path = require('path');
const { describeInstancesList } = require('./cvmService');
const dotenv = require('dotenv');

dotenv.config();

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

// 执行SSH命令的通用函数
async function executeSshCommand(config, command, options = {}) {
  try {
    return await sshPool.executeCommand(config, command, options);
  } catch (error) {
    // 如果连接池执行失败，尝试创建临时连接作为降级方案
    console.warn('[SSH] 连接池执行失败，尝试临时连接:', error.message);
    return executeTemporarySshCommand(config, command, options);
  }
}

// 临时SSH连接（降级方案）
function executeTemporarySshCommand(config, command, options = {}) {
  return new Promise((resolve, reject) => {
    const { Client } = require('ssh2');
    const conn = new Client();
    let output = '';
    let errorOutput = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        stream.on('close', (code, signal) => {
          conn.end();
          resolve({
            success: code === 0,
            code,
            output: output.trim(),
            error: errorOutput.trim()
          });
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect(config);
  });
}

// 测试 SSH 连接
async function testSshConnection(publicIp) {
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
      throw new Error('SSH 认证信息未配置');
    }
  } catch (err) {
    throw new Error('读取 SSH 私钥失败: ' + err.message);
  }

  try {
    return await executeSshCommand(config, 'echo "SSH Connection OK" && uptime');
  } catch (error) {
    // 测试连接失败，清理可能的损坏连接
    const key = `${config.host}:${config.port}:${config.username}`;
    if (sshPool.connections.has(key)) {
      const connInfo = sshPool.connections.get(key);
      try {
        connInfo.client.end();
      } catch (e) {
        // 忽略关闭错误
      }
      sshPool.connections.delete(key);
    }
    throw error;
  }
}

// 获取远程脚本列表
async function getRemoteScripts() {
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';
  const { config } = await getSshConfig('', '', '');

  try {
    // 尝试读取远程 scripts.json
    const scriptsJsonPath = path.posix.join(remotePath, 'scripts.json');
    const result = await executeSshCommand(config, `cat "${scriptsJsonPath}"`);
    
    if (result.success) {
      try {
        const scripts = JSON.parse(result.output);
        return { success: true, scripts };
      } catch (parseErr) {
        console.warn(`[WARN] 远程 scripts.json 解析失败: ${parseErr.message}`);
      }
    }

    // 读取失败或解析失败，降级为 ls 列出 .sh 文件
    const lsResult = await executeSshCommand(config, `ls -1 ${remotePath}/*.sh`);
    if (lsResult.success && lsResult.output.trim()) {
      const files = lsResult.output.trim().split('\n')
        .map(line => {
          const fileName = path.basename(line.trim());
          return { name: fileName, script: fileName };
        })
        .filter(item => item.script && item.script.endsWith('.sh'));
      return { success: true, scripts: files };
    } else {
      return { success: true, scripts: [] };
    }
  } catch (error) {
    throw error;
  }
}

// 执行远程脚本
async function executeRemoteScript(scriptName) {
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';
  const { config } = await getSshConfig('', '', '');
  
  // 安全检查：防止路径遍历
  if (scriptName.includes('..') || scriptName.includes('/') || scriptName.includes('\\')) {
    throw new Error('无效的脚本名称');
  }

  const remoteCommand = `bash ${remotePath}/${scriptName}`;
  return executeSshCommand(config, remoteCommand);
}

// 执行远程命令
async function executeRemoteCommand(command) {
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('命令不能为空');
  }

  const { config } = await getSshConfig('', '', '');
  return executeSshCommand(config, command);
}

module.exports = {
  getSshConfig,
  testSshConnection,
  getRemoteScripts,
  executeRemoteScript,
  executeRemoteCommand,
  executeSshCommand
};