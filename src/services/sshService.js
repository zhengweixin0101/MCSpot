const { Client } = require('ssh2');
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
function executeSshCommand(config, command, options = {}) {
  return new Promise((resolve, reject) => {
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

  return executeSshCommand(config, 'echo "SSH Connection OK" && uptime');
}

// 获取远程脚本列表
async function getRemoteScripts() {
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';
  const { config } = await getSshConfig('', '', '');

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      // 尝试读取远程 scripts.json
      const scriptsJsonPath = path.posix.join(remotePath, 'scripts.json');
      conn.exec(`cat "${scriptsJsonPath}"`, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let jsonOutput = '';
        stream.on('close', (code, signal) => {
          if (code === 0) {
            // 成功读取到 scripts.json
            try {
              const scripts = JSON.parse(jsonOutput);
              conn.end();
              return resolve({ success: true, scripts });
            } catch (parseErr) {
              console.warn(`[WARN] 远程 scripts.json 解析失败: ${parseErr.message}`);
              // 解析失败，继续执行 ls
            }
          } 
          
          // 读取失败或解析失败，降级为 ls 列出 .sh 文件
          conn.exec(`ls -1 ${remotePath}/*.sh`, (err, stream) => {
             if (err) {
               conn.end();
               return reject(err);
             }

             let output = '';
             stream.on('close', (code, signal) => {
               conn.end();
               if (code !== 0) {
                  return resolve({ success: true, scripts: [] });
               }
               const files = output.trim().split('\n')
                 .map(line => {
                   const fileName = path.basename(line.trim());
                   return { name: fileName, script: fileName };
                 })
                 .filter(item => item.script && item.script.endsWith('.sh'));
               resolve({ success: true, scripts: files });
             }).on('data', (data) => {
               output += data.toString();
             });
          });

        }).on('data', (data) => {
          jsonOutput += data.toString();
        }).stderr.on('data', () => {});
      });
    }).on('error', (err) => {
      reject(err);
    }).connect(config);
  });
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