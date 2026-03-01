const mcPing = require('mc-ping-updated');
const { describeInstancesList } = require('./cvmService');
const { executeRemoteCommand, getSshConfig } = require('./sshService');
const { redisClient } = require('../middleware/auth');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// 发送 MC 服务器命令
async function sendMcCommand(command) {
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('命令不能为空');
  }

  // 简单的命令清理，防止注入
  const safeCommand = command.replace(/"/g, '\\"');
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';

  // 从 .env 加载配置并发送命令到 screen 会话
  const cmd = `source ${remotePath}/.env && screen -S "$SCREEN_NAME" -p 0 -X stuff "${safeCommand}\\r"`;
  
  return executeRemoteCommand(cmd);
}

// 获取 MC 服务器日志 (支持流式输出)
async function getMcLogs(lines = 100, isStream = false) {
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';
  const { config } = await getSshConfig('', '', '');

  return new Promise((resolve, reject) => {
    const { Client } = require('ssh2');
    const conn = new Client();

    // 构造命令
    let cmd;
    if (isStream) {
      // 流式：先输出最后 N 行，然后持续跟踪
      // 使用 tail -f -n N
      cmd = `source ${remotePath}/.env && tail -f -n ${lines} "$MCS_DIR/logs/latest.log"`;
    } else {
      // 非流式：只输出最后 N 行
      cmd = `source ${remotePath}/.env && tail -n ${lines} "$MCS_DIR/logs/latest.log"`;
    }
    
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let output = '';
        let errorOutput = '';

        stream.on('close', (code, signal) => {
          conn.end();
          if (code === 0) {
            resolve({ success: true, logs: output });
          } else {
            reject(new Error(`读取日志失败: ${errorOutput}`));
          }
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

// 创建流式日志连接
function createLogStream(res, lines = 100) {
  const remotePath = process.env.REMOTE_SCRIPT_PATH || '/opt/sh';
  const { Client } = require('ssh2');
  const conn = new Client();

  // 设置 SSE 头部
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  getSshConfig('', '', '').then(({ config }) => {
    conn.on('ready', () => {
      // 构造命令：先输出最后 N 行，然后持续跟踪
      const cmd = `source ${remotePath}/.env && tail -f -n ${lines} "$MCS_DIR/logs/latest.log"`;
      
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'SSH 执行错误', error: err.message })}\n\n`);
          res.end();
          return;
        }

        stream.on('close', (code, signal) => {
          conn.end();
          res.end(); // 关闭 SSE 连接
        }).on('data', (data) => {
          // 将数据分行处理，逐行发送
          const lines = data.toString().split('\n');
          lines.forEach(line => {
            if (line) {
               res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
            }
          });
        }).stderr.on('data', (data) => {
          // 错误流也发送到前端显示
          res.write(`event: stderr\ndata: ${JSON.stringify({ log: data.toString() })}\n\n`);
        });

        // 客户端断开连接时，关闭 SSH 连接
        res.on('close', () => {
           console.log('Client closed SSE connection, closing SSH...');
           conn.end();
        });
      });
    }).on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'SSH 连接失败', error: err.message });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'SSH 连接中断', error: err.message })}\n\n`);
        res.end();
      }
    }).connect(config);
  }).catch(err => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

// 获取 Minecraft 服务器状态
async function getMcServerStatus() {
  try {
    // 获取当前实例
    const result = await describeInstancesList();

    if (!result.success) {
      throw new Error(`获取实例失败: ${result.error}`);
    }

    if (result.instances.length === 0) {
      return {
        success: true,
        running: false,
        message: '当前没有实例'
      };
    }

    const instance = result.instances[0];

    // 判断实例状态
    if (instance.InstanceState !== 'RUNNING') {
      // 检查挂机模式
      const afkMode = await redisClient.get('mc:afk_mode');
      const afkTTL = await redisClient.ttl('mc:afk_mode');
      
      return {
        success: true,
        running: false,
        instanceState: instance.InstanceState,
        mcOnline: false,
        afkMode: !!afkMode,
        afkTimeRemaining: afkTTL,
        playersOnline: 0,
        playerList: [],
        message: '实例未运行' + (afkMode ? '，但挂机模式已开启' : '')
      };
    }

    // 获取公网 IP
    let publicIp = null;

    if (instance.PublicIpAddresses && instance.PublicIpAddresses.length > 0) {
      publicIp = instance.PublicIpAddresses[0];
    } else if (instance.PublicIpAddress && instance.PublicIpAddress.length > 0) {
      publicIp = instance.PublicIpAddress[0];
    }

    // 检查挂机模式
    const afkMode = await redisClient.get('mc:afk_mode');
    const afkTTL = await redisClient.ttl('mc:afk_mode');

    if (!publicIp) {
      return {
        success: true,
        running: true,
        mcOnline: false,
        afkMode: !!afkMode,
        afkTimeRemaining: afkTTL,
        playersOnline: 0,
        playerList: [],
        message: '实例运行中，但未分配公网IP' + (afkMode ? '，挂机模式已开启' : '')
      };
    }

    const port = parseInt(process.env.MC_PORT || '25565');

    // Promise 包装 mc-ping-updated
    const mcPingAsync = (host, port) => {
      return new Promise((resolve, reject) => {
        mcPing(host, port, (err, data) => {
          if (err) return reject(err);
          resolve(data);
        });
      });
    };

    let data;
    try {
      data = await mcPingAsync(publicIp, port);
    } catch (err) {
      return {
        success: true,
        running: true,
        mcOnline: false,
        ip: publicIp,
        port,
        afkMode: !!afkMode,
        afkTimeRemaining: afkTTL,
        playersOnline: 0,
        playerList: [],
        message: '实例运行中，但Minecraft服务未响应' + (afkMode ? '，挂机模式已开启' : ''),
        error: err.message
      };
    }

    // 兼容各种 MOTD 结构
    let motd = '';
    if (typeof data.description === 'string') {
      motd = data.description;
    } else if (data.description?.text) {
      motd = data.description.text;
    } else if (Array.isArray(data.description?.extra)) {
      motd = data.description.extra.map(e => e.text || '').join('');
    }

    // 玩家列表
    const playerList = (data.players?.sample || []).map(p => ({
      name: p.name || '',
      uuid: p.id || ''
    }));

    const playersOnline = data.players?.online || 0;

    // 返回最终状态
    return {
      success: true,
      running: true,
      mcOnline: true,
      ip: publicIp,
      port,
      playersOnline,
      playersMax: data.players?.max || 0,
      playerList,
      version: data.version?.name || '',
      motd,
      afkMode: !!afkMode,
      afkTimeRemaining: afkTTL
    };

  } catch (error) {
    throw new Error(`查询服务器状态失败: ${error.message}`);
  }
}

// 设置/取消挂机模式
async function setAfkMode(duration) {
  try {
    // 如果 duration 为 0 或负数，表示取消挂机模式
    if (typeof duration === 'number' && duration <= 0) {
      await redisClient.del('mc:afk_mode');
      return { success: true, message: '挂机模式已关闭', afkMode: false };
    }

    if (!duration || typeof duration !== 'number') {
      throw new Error('无效的时长参数');
    }

    // 设置挂机模式，过期时间为 duration 分钟
    await redisClient.set('mc:afk_mode', 'true');
    await redisClient.expire('mc:afk_mode', duration * 60);
    
    return { 
      success: true, 
      message: `挂机模式已开启，持续 ${duration} 分钟`, 
      afkMode: true,
      duration 
    };
  } catch (err) {
    throw new Error(`设置挂机模式失败: ${err.message}`);
  }
}

// 获取挂机模式状态
async function getAfkModeStatus() {
  try {
    const ttl = await redisClient.ttl('mc:afk_mode');
    
    if (ttl > 0) {
      return { 
        success: true, 
        afkMode: true, 
        remainingSeconds: ttl 
      };
    } else {
      return { 
        success: true, 
        afkMode: false, 
        remainingSeconds: 0 
      };
    }
  } catch (err) {
    throw new Error(`获取挂机模式状态失败: ${err.message}`);
  }
}

module.exports = {
  sendMcCommand,
  getMcLogs,
  createLogStream,
  getMcServerStatus,
  setAfkMode,
  getAfkModeStatus
};