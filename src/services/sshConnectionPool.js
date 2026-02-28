const { Client } = require('ssh2');
const EventEmitter = require('events');

class SSHConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.connections = new Map();
    this.maxIdleTime = options.maxIdleTime || 5 * 60 * 1000; // 5分钟
    this.maxConnections = options.maxConnections || 5;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // 每分钟清理一次
  }

  // 生成连接key
  generateKey(config) {
    return `${config.host}:${config.port}:${config.username}`;
  }

  // 获取连接
  async getConnection(config) {
    const key = this.generateKey(config);
    
    if (this.connections.has(key)) {
      const connInfo = this.connections.get(key);
      
      // 检查连接是否仍然有效
      if (connInfo.client && !connInfo.client._sock.destroyed) {
        connInfo.lastUsed = Date.now();
        return connInfo.client;
      } else {
        // 连接已断开，清理
        this.connections.delete(key);
      }
    }

    // 如果达到最大连接数，清理最旧的连接
    if (this.connections.size >= this.maxConnections) {
      this.cleanupOldest();
    }

    // 创建新连接
    const client = new Client();
    await this.createConnection(client, config);
    
    this.connections.set(key, {
      client,
      config,
      created: Date.now(),
      lastUsed: Date.now()
    });

    return client;
  }

  // 创建SSH连接
  createConnection(client, config) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('SSH连接超时'));
      }, config.readyTimeout || 10000);

      client.on('ready', () => {
        clearTimeout(timeout);
        resolve();
      }).on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      }).connect(config);
    });
  }

  // 执行命令
  async executeCommand(config, command, options = {}) {
    const client = await this.getConnection(config);
    
    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';

      client.exec(command, (err, stream) => {
        if (err) {
          return reject(err);
        }

        stream.on('close', (code, signal) => {
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
    });
  }

  // 清理空闲连接
  cleanup() {
    const now = Date.now();
    const toDelete = [];

    for (const [key, connInfo] of this.connections) {
      if (now - connInfo.lastUsed > this.maxIdleTime || 
          connInfo.client._sock.destroyed) {
        toDelete.push(key);
        try {
          connInfo.client.end();
        } catch (e) {
          // 忽略关闭错误
        }
      }
    }

    toDelete.forEach(key => this.connections.delete(key));
    
    if (toDelete.length > 0) {
      this.emit('cleanup', { cleaned: toDelete.length, remaining: this.connections.size });
    }
  }

  // 清理最旧的连接
  cleanupOldest() {
    let oldest = null;
    let oldestKey = null;

    for (const [key, connInfo] of this.connections) {
      if (!oldest || connInfo.lastUsed < oldest.lastUsed) {
        oldest = connInfo;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      try {
        oldest.client.end();
      } catch (e) {
        // 忽略关闭错误
      }
      this.connections.delete(oldestKey);
    }
  }

  // 关闭所有连接
  closeAll() {
    clearInterval(this.cleanupInterval);
    
    for (const [key, connInfo] of this.connections) {
      try {
        connInfo.client.end();
      } catch (e) {
        // 忽略关闭错误
      }
    }
    
    this.connections.clear();
  }

  // 获取连接池状态
  getStats() {
    return {
      totalConnections: this.connections.size,
      maxConnections: this.maxConnections,
      connections: Array.from(this.connections.entries()).map(([key, info]) => ({
        key,
        created: info.created,
        lastUsed: info.lastUsed,
        age: Date.now() - info.created,
        idleTime: Date.now() - info.lastUsed
      }))
    };
  }
}

// 创建全局连接池实例
const sshPool = new SSHConnectionPool({
  maxIdleTime: 5 * 60 * 1000, // 5分钟
  maxConnections: 5
});

// 关闭处理
process.on('SIGINT', () => {
  sshPool.closeAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sshPool.closeAll();
  process.exit(0);
});

module.exports = { SSHConnectionPool, sshPool };